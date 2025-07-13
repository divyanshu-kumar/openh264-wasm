#include <emscripten.h>
#include <iostream>
#include <algorithm> 
#include <cstring>
#include "codec_api.h"

#define MAX_DECODERS 32

// --- Globals ---
ISVCEncoder* encoder = nullptr;
ISVCDecoder* decoder_pool[MAX_DECODERS];
int decoder_pool_size = 0;


extern "C" {

void rgba_to_yuv(unsigned char* rgba, int width, int height, unsigned char* y, unsigned char* u, unsigned char* v) {
    int i = 0;
    int y_idx = 0;
    int u_idx = 0;
    int v_idx = 0;
    for (int row = 0; row < height; ++row) {
        for (int col = 0; col < width; ++col) {
            unsigned char r = rgba[i++];
            unsigned char g = rgba[i++];
            unsigned char b = rgba[i++];
            i++;
            y[y_idx++] = (unsigned char)( (66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
            if (row % 2 == 0 && col % 2 == 0) {
                u[u_idx++] = (unsigned char)( (-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
                v[v_idx++] = (unsigned char)( (112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
            }
        }
    }
}

void yuv_to_rgba(
    unsigned char* y_plane, unsigned char* u_plane, unsigned char* v_plane, 
    int width, int height, 
    int y_stride, int uv_stride, 
    unsigned char* rgba
) {
    int rgba_idx = 0;
    for (int row = 0; row < height; ++row) {
        for (int col = 0; col < width; ++col) {
            int y_idx = row * y_stride + col;
            int u_idx = (row / 2) * uv_stride + (col / 2);
            int v_idx = (row / 2) * uv_stride + (col / 2);
            int c = y_plane[y_idx] - 16;
            int d = u_plane[u_idx] - 128;
            int e = v_plane[v_idx] - 128;
            auto clamp = [](int val) { return std::max(0, std::min(255, val)); };
            rgba[rgba_idx++] = clamp((298 * c + 409 * e + 128) >> 8);
            rgba[rgba_idx++] = clamp((298 * c - 100 * d - 208 * e + 128) >> 8);
            rgba[rgba_idx++] = clamp((298 * c + 516 * d + 128) >> 8);
            rgba[rgba_idx++] = 255;
        }
    }
}

// --- Encoder ---
EMSCRIPTEN_KEEPALIVE
int init_encoder(int width, int height, int bitrate) {
    if (encoder) {
        encoder->Uninitialize();
        WelsDestroySVCEncoder(encoder);
        encoder = nullptr;
    }
    int rv = WelsCreateSVCEncoder(&encoder);
    if (rv != 0) return -1;
    SEncParamExt param;
    encoder->GetDefaultParams(&param);
    param.iUsageType = CAMERA_VIDEO_REAL_TIME;
    param.iPicWidth = width;
    param.iPicHeight = height;
    param.iTargetBitrate = bitrate;
    param.iRCMode = RC_BITRATE_MODE;
    if (encoder->InitializeExt(&param) != 0) {
        WelsDestroySVCEncoder(encoder);
        encoder = nullptr;
        return -1;
    }
    return 0;
}

EMSCRIPTEN_KEEPALIVE
void force_key_frame() {
    if (encoder) {
        encoder->ForceIntraFrame(true);
        std::cout << "Key frame forced." << std::endl;
    }
}


// --- Decoder Management ---
EMSCRIPTEN_KEEPALIVE
int init_decoder_pool(int count) {
    for (int i = 0; i < decoder_pool_size; ++i) {
        if (decoder_pool[i]) {
            decoder_pool[i]->Uninitialize();
            WelsDestroyDecoder(decoder_pool[i]);
            decoder_pool[i] = nullptr;
        }
    }
    decoder_pool_size = 0;

    if (count > MAX_DECODERS) {
        count = MAX_DECODERS;
    }

    for (int i = 0; i < count; ++i) {
        ISVCDecoder* dec = nullptr;
        if (WelsCreateDecoder(&dec) != 0) {
            std::cerr << "Failed to create decoder #" << i << std::endl;
            return -1;
        }
        SDecodingParam param = {0};
        param.eEcActiveIdc = ERROR_CON_FRAME_COPY;
        param.sVideoProperty.eVideoBsType = VIDEO_BITSTREAM_DEFAULT;
        if (dec->Initialize(&param) != 0) {
            std::cerr << "Failed to initialize decoder #" << i << std::endl;
            WelsDestroyDecoder(dec);
            return -1;
        }
        decoder_pool[i] = dec;
    }
    decoder_pool_size = count;
    std::cout << "Successfully created " << decoder_pool_size << " decoders." << std::endl;
    return 0;
}

// --- Frame Processing ---
EMSCRIPTEN_KEEPALIVE
void encode_frame(unsigned char* rgba_data, int width, int height, unsigned char** out_data, int* out_size) {
    *out_data = nullptr;
    *out_size = 0;
    if (!encoder) return;
    SFrameBSInfo info;
    memset(&info, 0, sizeof(SFrameBSInfo));
    SSourcePicture pic;
    memset(&pic, 0, sizeof(SSourcePicture));
    pic.iPicWidth = width;
    pic.iPicHeight = height;
    pic.iColorFormat = videoFormatI420;
    int y_size = width * height;
    int uv_size = y_size / 4;
    unsigned char* yuv_data = (unsigned char*)malloc(y_size + 2 * uv_size);
    pic.pData[0] = yuv_data;
    pic.pData[1] = pic.pData[0] + y_size;
    pic.pData[2] = pic.pData[1] + uv_size;
    pic.iStride[0] = width;
    pic.iStride[1] = width / 2;
    pic.iStride[2] = width / 2;
    rgba_to_yuv(rgba_data, width, height, pic.pData[0], pic.pData[1], pic.pData[2]);
    if (encoder->EncodeFrame(&pic, &info) != cmResultSuccess) {
        free(yuv_data);
        return;
    }
    free(yuv_data);
    int total_size = 0;
    for (int i = 0; i < info.iLayerNum; ++i) {
        for (int j = 0; j < info.sLayerInfo[i].iNalCount; ++j) {
            total_size += info.sLayerInfo[i].pNalLengthInByte[j];
        }
    }
    if (total_size == 0) return;
    unsigned char* encoded_buffer = (unsigned char*)malloc(total_size);
    int current_pos = 0;
    for (int i = 0; i < info.iLayerNum; ++i) {
        const SLayerBSInfo& layerInfo = info.sLayerInfo[i];
        int layer_size = 0;
        for (int j = 0; j < layerInfo.iNalCount; j++) {
            layer_size += layerInfo.pNalLengthInByte[j];
        }
        if (layer_size > 0) {
            memcpy(encoded_buffer + current_pos, layerInfo.pBsBuf, layer_size);
            current_pos += layer_size;
        }
    }
    *out_data = encoded_buffer;
    *out_size = total_size;
}

EMSCRIPTEN_KEEPALIVE
void decode_frame(int decoder_index, unsigned char* encoded_data, int size, unsigned char** out_rgba_data, int* out_width, int* out_height) {
    *out_rgba_data = nullptr;
    *out_width = 0;
    *out_height = 0;
    if (decoder_index < 0 || decoder_index >= decoder_pool_size) {
        return;
    }
    ISVCDecoder* decoder = decoder_pool[decoder_index];
    if (!decoder) return;
    SBufferInfo decoded_pict_info = {0};
    unsigned char* decoded_image_yuv[3] = {nullptr, nullptr, nullptr};
    if (decoder->DecodeFrameNoDelay(encoded_data, size, decoded_image_yuv, &decoded_pict_info) != 0 || decoded_pict_info.iBufferStatus != 1) {
        return;
    }
    int decoded_width = decoded_pict_info.UsrData.sSystemBuffer.iWidth;
    int decoded_height = decoded_pict_info.UsrData.sSystemBuffer.iHeight;
    int y_stride = decoded_pict_info.UsrData.sSystemBuffer.iStride[0];
    int uv_stride = decoded_pict_info.UsrData.sSystemBuffer.iStride[1];
    int rgba_size = decoded_width * decoded_height * 4;
    unsigned char* rgba_buffer = (unsigned char*)malloc(rgba_size);
    yuv_to_rgba(decoded_image_yuv[0], decoded_image_yuv[1], decoded_image_yuv[2], decoded_width, decoded_height, y_stride, uv_stride, rgba_buffer);
    *out_rgba_data = rgba_buffer;
    *out_width = decoded_width;
    *out_height = decoded_height;
}

EMSCRIPTEN_KEEPALIVE
void free_buffer(void* ptr) {
    free(ptr);
}

} // extern "C"
