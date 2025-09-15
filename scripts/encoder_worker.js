let wasmReady = false;
let initEncoder;
let encodeFrame;
let encodeFrameYuv;

let rgbaBufferPtr = 0;
let rgbaBufferSize = 0;
let yuvBufferPtr = 0;
let yuvBufferSize = 0;
let encodedDataPtr_ptr = 0;
let encodedSize_ptr = 0;

let isEncoding = false;
let isCleanedUp = false;

// The Wasm module needs to be loaded in the worker
importScripts('h264.js');

Module.onRuntimeInitialized = () => {
    console.log('Encoder Worker: Wasm module ready.');
    initEncoder = Module.cwrap('init_encoder', 'number', ['number', 'number', 'number']);
    encodeFrame = Module.cwrap('encode_frame', null, ['number', 'number', 'number', 'number', 'number']);
    encodeFrameYuv = Module.cwrap('encode_frame_yuv_i420', null, ['number', 'number', 'number', 'number', 'number']);
    wasmReady = true;
    self.postMessage({ type: 'ready' });
};

self.onmessage = async (e) => {
    if (!wasmReady) return;

    if (e.data.type === 'cleanup') {
        isCleanedUp = true; 
        console.log('Encoder Worker: Cleaning up Wasm memory...');
        if (rgbaBufferPtr) {
            Module._free(rgbaBufferPtr);
        }
        if (yuvBufferPtr) {
            Module._free(yuvBufferPtr);
        }
        if (encodedDataPtr_ptr) {
            Module._free(encodedDataPtr_ptr);
        }
        if (encodedSize_ptr) {
            Module._free(encodedSize_ptr);
        }
        rgbaBufferPtr = yuvBufferPtr = encodedDataPtr_ptr = encodedSize_ptr = 0;
        self.postMessage({ type: 'cleanup_done' });
        return;
    }

    if (isCleanedUp || isEncoding) {
        if (isEncoding) {
            console.warn("Encoder busy, dropping frame.");
        }
        if (e.data.frameBitmap && e.data.frameBitmap.close) {
            e.data.frameBitmap.close();
        }
        return;
    }

    isEncoding = true;
    try {
        const { type, width, height } = e.data;

        if (type === 'init') {
            isCleanedUp = false;
            if (initEncoder(width, height, 1000000) !== 0) {
                throw new Error('Wasm Encoder init failed in worker.');
            }
            encodedDataPtr_ptr = Module._malloc(4);
            encodedSize_ptr = Module._malloc(4);
            self.postMessage({ type: 'init_done' });

        } else if (type === 'encode') {
            const { frameBitmap } = e.data;
            const requiredSize = width * height * 4;
            if (requiredSize > rgbaBufferSize) {
                if (rgbaBufferPtr) Module._free(rgbaBufferPtr);
                rgbaBufferPtr = Module._malloc(requiredSize);
                rgbaBufferSize = requiredSize;
            }

            const startTime = performance.now();
            // Convert ImageBitmap into VideoFrame
            // (required because copyTo works on VideoFrame, not ImageBitmap)
            const vf = new VideoFrame(frameBitmap, { timestamp: startTime * 1000 });
            frameBitmap.close(); // release GPU resource immediately
            // Copy pixel data directly into WASM memory
            await vf.copyTo(HEAPU8.subarray(rgbaBufferPtr, rgbaBufferPtr + rgbaBufferSize));
            vf.close();
            const copyEndTime = performance.now();

            // Encode the frame
            encodeFrame(rgbaBufferPtr, width, height, encodedDataPtr_ptr, encodedSize_ptr);
            const encodeEndTime = performance.now();

            postEncodedData({
                frameCopyToWasmTime: copyEndTime - startTime,
                encodeTime: encodeEndTime - copyEndTime
            });

        } else if (type === 'encode_yuv') {
            const { yuvData, convertTime } = e.data;
            const yuvArray = new Uint8Array(yuvData);

            if (yuvArray.length > yuvBufferSize) {
                if(yuvBufferPtr) {
                    Module._free(yuvBufferPtr);
                }
                yuvBufferPtr = Module._malloc(yuvArray.length);
                yuvBufferSize = yuvArray.length;
            }
            HEAPU8.set(yuvArray, yuvBufferPtr);

            const startTime = performance.now();
            encodeFrameYuv(yuvBufferPtr, width, height, encodedDataPtr_ptr, encodedSize_ptr);
            const encodeEndTime = performance.now();
            
            postEncodedData({
                frameCopyToWasmTime: convertTime,
                encodeTime: encodeEndTime - startTime
            });
        }
    } catch (err) {
        console.error("Error during encoding:", err);
    } finally {
        isEncoding = false;
    }
};

function postEncodedData(timingInfo) {
    const encodedDataPtr = Module.getValue(encodedDataPtr_ptr, 'i32');
    const encodedSize = Module.getValue(encodedSize_ptr, 'i32');

    if (encodedSize > 0) {
        const encodedData = HEAPU8.slice(encodedDataPtr, encodedDataPtr + encodedSize);
        self.postMessage({
            type: 'encoded',
            encodedData: encodedData.buffer,
            ...timingInfo
        }, [encodedData.buffer]);
    }
}