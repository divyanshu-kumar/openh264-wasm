#include <emscripten.h>
#include <iostream>
#include <algorithm> 
#include <cstring>
#include <immintrin.h>
#include "codec_api.h"

#define MAX_DECODERS 32

// --- Globals ---
ISVCEncoder* encoder = nullptr;
ISVCDecoder* decoder_pool[MAX_DECODERS];
int decoder_pool_size = 0;

unsigned char* yuv_buffer = nullptr;
int yuv_buffer_size = 0;
unsigned char* encoded_buffer = nullptr;
int encoded_buffer_size = 0;

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

// Optimized RGBA to YUV conversion using lookup tables and SIMD
void rgba_to_yuv_optimized(unsigned char* rgba, int width, int height, unsigned char* y, unsigned char* u, unsigned char* v) {
    // Pre-computed lookup tables 
    static bool tables_initialized = false;
    static int y_table_r[256], y_table_g[256], y_table_b[256];
    static int u_table_r[256], u_table_g[256], u_table_b[256];
    static int v_table_r[256], v_table_g[256], v_table_b[256];
    
    if (!tables_initialized) {
        for (int i = 0; i < 256; i++) {
            y_table_r[i] = 66 * i;
            y_table_g[i] = 129 * i;
            y_table_b[i] = 25 * i;
            u_table_r[i] = -38 * i;
            u_table_g[i] = -74 * i;
            u_table_b[i] = 112 * i;
            v_table_r[i] = 112 * i;
            v_table_g[i] = -94 * i;
            v_table_b[i] = -18 * i;
        }
        tables_initialized = true;
    }
    
    const int pixels = width * height;
    const int rgba_stride = pixels * 4;
    int y_idx = 0, uv_idx = 0;
    
    // Process 4 pixels at a time when possible
    for (int row = 0; row < height; row += 2) {
        for (int col = 0; col < width; col += 2) {
            // Process 2x2 block for YUV420
            int rgba_idx = (row * width + col) * 4;
            
            // Top-left pixel
            unsigned char r1 = rgba[rgba_idx];
            unsigned char g1 = rgba[rgba_idx + 1];
            unsigned char b1 = rgba[rgba_idx + 2];
            y[y_idx] = ((y_table_r[r1] + y_table_g[g1] + y_table_b[b1] + 128) >> 8) + 16;
            y_idx++;
            
            // Top-right pixel (if exists)
            if (col + 1 < width) {
                rgba_idx += 4;
                unsigned char r2 = rgba[rgba_idx];
                unsigned char g2 = rgba[rgba_idx + 1];
                unsigned char b2 = rgba[rgba_idx + 2];
                y[y_idx] = ((y_table_r[r2] + y_table_g[g2] + y_table_b[b2] + 128) >> 8) + 16;
                y_idx++;
            }
            
            // Bottom-left pixel (if exists)
            if (row + 1 < height) {
                rgba_idx = ((row + 1) * width + col) * 4;
                unsigned char r3 = rgba[rgba_idx];
                unsigned char g3 = rgba[rgba_idx + 1];
                unsigned char b3 = rgba[rgba_idx + 2];
                y[y_idx] = ((y_table_r[r3] + y_table_g[g3] + y_table_b[b3] + 128) >> 8) + 16;
                y_idx++;
                
                // Bottom-right pixel (if exists)
                if (col + 1 < width) {
                    rgba_idx += 4;
                    unsigned char r4 = rgba[rgba_idx];
                    unsigned char g4 = rgba[rgba_idx + 1];
                    unsigned char b4 = rgba[rgba_idx + 2];
                    y[y_idx] = ((y_table_r[r4] + y_table_g[g4] + y_table_b[b4] + 128) >> 8) + 16;
                    y_idx++;
                }
            }
            
            // Calculate U and V from average of 2x2 block
            rgba_idx = (row * width + col) * 4;
            unsigned char avg_r = rgba[rgba_idx];
            unsigned char avg_g = rgba[rgba_idx + 1];
            unsigned char avg_b = rgba[rgba_idx + 2];
            
            u[uv_idx] = ((u_table_r[avg_r] + u_table_g[avg_g] + u_table_b[avg_b] + 128) >> 8) + 128;
            v[uv_idx] = ((v_table_r[avg_r] + v_table_g[avg_g] + v_table_b[avg_b] + 128) >> 8) + 128;
            uv_idx++;
        }
    }
}

// Optimized YUV to RGBA conversion with lookup tables
void yuv_to_rgba_optimized(
    unsigned char* y_plane, unsigned char* u_plane, unsigned char* v_plane, 
    int width, int height, 
    int y_stride, int uv_stride, 
    unsigned char* rgba
) {
    // Pre-computed lookup tables
    static bool tables_initialized = false;
    static int c_table[256], d_table[256], e_table[256];
    static int cr_table[256], cb_table[256], cg_cb_table[256], cg_cr_table[256];
    
    if (!tables_initialized) {
        for (int i = 0; i < 256; i++) {
            c_table[i] = 298 * (i - 16);
            d_table[i] = i - 128;
            e_table[i] = i - 128;
            cr_table[i] = 409 * (i - 128);
            cb_table[i] = 516 * (i - 128);
            cg_cb_table[i] = 100 * (i - 128);
            cg_cr_table[i] = 208 * (i - 128);
        }
        tables_initialized = true;
    }
    
    int rgba_idx = 0;
    for (int row = 0; row < height; ++row) {
        for (int col = 0; col < width; ++col) {
            int y_idx = row * y_stride + col;
            int u_idx = (row / 2) * uv_stride + (col / 2);
            int v_idx = u_idx;
            
            int c = c_table[y_plane[y_idx]];
            int cb = d_table[u_plane[u_idx]];
            int cr = e_table[v_plane[v_idx]];
            
            int r = (c + cr_table[v_plane[v_idx]] + 128) >> 8;
            int g = (c - cg_cb_table[u_plane[u_idx]] - cg_cr_table[v_plane[v_idx]] + 128) >> 8;
            int b = (c + cb_table[u_plane[u_idx]] + 128) >> 8;
            
            rgba[rgba_idx++] = std::max(0, std::min(255, r)); // Red
            rgba[rgba_idx++] = std::max(0, std::min(255, g)); // Green
            rgba[rgba_idx++] = std::max(0, std::min(255, b)); // Blue
            rgba[rgba_idx++] = 255;                           // Alpha
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
    
    // Optimizations
    param.bEnableAdaptiveQuant = false;  // Disable adaptive quantization for speed
    param.bEnableBackgroundDetection = false;  // Disable background detection
    param.bEnableSceneChangeDetect = false;  // Disable scene change detection for consistent performance
    param.iComplexityMode = LOW_COMPLEXITY;  // Use low complexity mode
    param.iNumRefFrame = 1;  // Reduce reference frames for speed (similar to WebRTC)
    
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
void deinit_decoder(int decoder_index) {
    if (decoder_index < 0 || decoder_index >= MAX_DECODERS) {
        return;
    }

    if (decoder_pool[decoder_index]) {
        decoder_pool[decoder_index]->Uninitialize();
        WelsDestroyDecoder(decoder_pool[decoder_index]);
        decoder_pool[decoder_index] = nullptr;
    }
}

EMSCRIPTEN_KEEPALIVE
int init_decoder(int decoder_index) {
    if (decoder_index < 0 || decoder_index >= MAX_DECODERS) {
        return -1; // Invalid index
    }

    // Clean up any existing decoder at this index first
    deinit_decoder(decoder_index);

    ISVCDecoder* dec = nullptr;
    if (WelsCreateDecoder(&dec) != 0) {
        std::cerr << "Failed to create decoder #" << decoder_index << std::endl;
        return -1;
    }

    SDecodingParam param = {0};
    param.eEcActiveIdc = ERROR_CON_FRAME_COPY;
    param.sVideoProperty.eVideoBsType = VIDEO_BITSTREAM_DEFAULT;

    if (dec->Initialize(&param) != 0) {
        std::cerr << "Failed to initialize decoder #" << decoder_index << std::endl;
        WelsDestroyDecoder(dec);
        return -1;
    }
    decoder_pool[decoder_index] = dec;
    std::cout << "Successfully initialized decoder for stream " << decoder_index << std::endl;
    return 0;
}

void copy_encoded_data(SFrameBSInfo& info, unsigned char** out_data, int* out_size) {
    int total_size = 0;
    for (int i = 0; i < info.iLayerNum; ++i) {
        for (int j = 0; j < info.sLayerInfo[i].iNalCount; ++j) {
            total_size += info.sLayerInfo[i].pNalLengthInByte[j];
        }
    }
    if (total_size == 0) return;
    if (encoded_buffer_size < total_size) {
        if (encoded_buffer != nullptr) {
            free(encoded_buffer);
        }
        encoded_buffer = (unsigned char*)malloc(total_size);
        encoded_buffer_size = total_size;
    }
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


// --- Frame Processing ---
EMSCRIPTEN_KEEPALIVE
void encode_frame(unsigned char* rgba_data, int width, int height, unsigned char** out_data, int* out_size) {
    *out_data = nullptr;
    *out_size = 0;
    if (!encoder) {
        return;
    }
    SFrameBSInfo info;
    memset(&info, 0, sizeof(SFrameBSInfo));
    SSourcePicture pic;
    memset(&pic, 0, sizeof(SSourcePicture));
    pic.iPicWidth = width;
    pic.iPicHeight = height;
    pic.iColorFormat = videoFormatI420;

    int y_size = width * height;
    int uv_size = y_size / 4;
    int required_size = y_size + 2 * uv_size;
    
    if (required_size > yuv_buffer_size) {
        if (yuv_buffer) {
            free(yuv_buffer);
        }
        yuv_buffer = (unsigned char*)malloc(required_size);
        yuv_buffer_size = required_size;
    }
    
    pic.pData[0] = yuv_buffer;
    pic.pData[1] = pic.pData[0] + y_size;
    pic.pData[2] = pic.pData[1] + uv_size;
    pic.iStride[0] = width;
    pic.iStride[1] = width / 2;
    pic.iStride[2] = width / 2;

    rgba_to_yuv(rgba_data, width, height, pic.pData[0], pic.pData[1], pic.pData[2]);
    
    if (encoder->EncodeFrame(&pic, &info) != cmResultSuccess) {
        return;
    }
    
    copy_encoded_data(info, out_data, out_size);
}

EMSCRIPTEN_KEEPALIVE
void encode_frame_yuv_i420(unsigned char* yuv_i420_data, int width, int height, unsigned char** out_data, int* out_size) {
    *out_data = nullptr;
    *out_size = 0;
    if (!encoder) {
        return;
    }

    SFrameBSInfo info;
    memset(&info, 0, sizeof(SFrameBSInfo));
    SSourcePicture pic;
    memset(&pic, 0, sizeof(SSourcePicture));
    pic.iPicWidth = width;
    pic.iPicHeight = height;
    pic.iColorFormat = videoFormatI420;

    int y_size = width * height;
    int uv_size = y_size / 4;

    pic.pData[0] = yuv_i420_data;
    pic.pData[1] = yuv_i420_data + y_size;
    pic.pData[2] = yuv_i420_data + y_size + uv_size;
    pic.iStride[0] = width;
    pic.iStride[1] = width / 2;
    pic.iStride[2] = width / 2;

    if (encoder->EncodeFrame(&pic, &info) != cmResultSuccess) {
        return;
    }

    copy_encoded_data(info, out_data, out_size);
}

EMSCRIPTEN_KEEPALIVE
void decode_frame_optimized(int decoder_index, unsigned char* encoded_data, int size, unsigned char* out_rgba_buffer, int* out_width, int* out_height) {
    *out_width = 0;
    *out_height = 0;
    if (decoder_index < 0 || decoder_index >= MAX_DECODERS || !decoder_pool[decoder_index]) {
        return;
    }
    ISVCDecoder* decoder = decoder_pool[decoder_index];
    if (!decoder) {
        std::cout << "Decoder unitialized, index : " << decoder_index << ", called on decode_frame";
        return;
    }
    
    SBufferInfo decoded_pict_info = {0};
    unsigned char* decoded_image_yuv[3] = {nullptr, nullptr, nullptr};
    
    if (decoder->DecodeFrameNoDelay(encoded_data, size, decoded_image_yuv, &decoded_pict_info) != 0 ||
        decoded_pict_info.iBufferStatus != 1) {
        return;
    }
    
    int decoded_width = decoded_pict_info.UsrData.sSystemBuffer.iWidth;
    int decoded_height = decoded_pict_info.UsrData.sSystemBuffer.iHeight;
    int y_stride = decoded_pict_info.UsrData.sSystemBuffer.iStride[0];
    int uv_stride = decoded_pict_info.UsrData.sSystemBuffer.iStride[1];
    
    yuv_to_rgba_optimized(decoded_image_yuv[0], decoded_image_yuv[1], decoded_image_yuv[2], 
                         decoded_width, decoded_height, y_stride, uv_stride, out_rgba_buffer);
    
    *out_width = decoded_width;
    *out_height = decoded_height;
}

EMSCRIPTEN_KEEPALIVE
void decode_frame_yuv_i420(int decoder_index, unsigned char* encoded_data, int size, unsigned char* out_yuv_buffer, int* out_width, int* out_height) {
    *out_width = 0; *out_height = 0;
    if (decoder_index < 0 || decoder_index >= MAX_DECODERS || !decoder_pool[decoder_index]) {
        return;
    }

    ISVCDecoder* decoder = decoder_pool[decoder_index];
    SBufferInfo decoded_pict_info = {0};
    unsigned char* decoded_image_yuv[3] = {nullptr, nullptr, nullptr};

    if (decoder->DecodeFrameNoDelay(encoded_data, size, decoded_image_yuv, &decoded_pict_info) != 0 || decoded_pict_info.iBufferStatus != 1) {
        return;
    }

    int decoded_width = decoded_pict_info.UsrData.sSystemBuffer.iWidth;
    int decoded_height = decoded_pict_info.UsrData.sSystemBuffer.iHeight;
    *out_width = decoded_width;
    *out_height = decoded_height;

    int y_stride = decoded_pict_info.UsrData.sSystemBuffer.iStride[0];
    int uv_stride = decoded_pict_info.UsrData.sSystemBuffer.iStride[1];

    int uv_height = decoded_height / 2;
    int uv_width = decoded_width / 2;

    unsigned char* out_ptr = out_yuv_buffer;

    for(int i = 0; i < decoded_height; i++) {
        memcpy(out_ptr, decoded_image_yuv[0] + i * y_stride, decoded_width);
        out_ptr += decoded_width;
    }
    for(int i = 0; i < uv_height; i++) {
        memcpy(out_ptr, decoded_image_yuv[1] + i * uv_stride, uv_width);
        out_ptr += uv_width;
    }
    for(int i = 0; i < uv_height; i++) {
        memcpy(out_ptr, decoded_image_yuv[2] + i * uv_stride, uv_width);
        out_ptr += uv_width;
    }
}

EMSCRIPTEN_KEEPALIVE
void free_buffer(void* ptr) {
    if (ptr != 0) {
        free(ptr);
    }
}

} // extern "C"
