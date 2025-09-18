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

let encodedFrameSAB, controlSAB, controlView;
let frameDataViews = [];
let FRAME_BUFFER_POOL_SIZE, MAX_FRAME_SIZE;
let currentBufferIndex = 0;
let numStreams = 1; // Default number of consuming streams

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
    if (e.data.type === 'init_sab') {
        encodedFrameSAB = e.data.encodedFrameSAB;
        controlSAB = e.data.controlSAB;
        FRAME_BUFFER_POOL_SIZE = e.data.FRAME_BUFFER_POOL_SIZE;
        MAX_FRAME_SIZE = e.data.MAX_FRAME_SIZE;
        numStreams = e.data.numStreams;
        controlView = new Int32Array(controlSAB);
        for (let i = 0; i < FRAME_BUFFER_POOL_SIZE; i++) {
            frameDataViews[i] = new Uint8Array(encodedFrameSAB, i * MAX_FRAME_SIZE, MAX_FRAME_SIZE);
        }
        console.log('Encoder Worker: Shared buffers initialized.');
        currentBufferIndex = 0;
        return;
    }

    if (e.data.type === 'update_streams') {
        numStreams = e.data.numStreams;
        console.log(`Encoder Worker: Updated numStreams to ${numStreams}`);
        return;
    }

    if (!wasmReady || !controlSAB) {
        return;
    }

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

            writeToSharedBufferAndPost({
                frameCopyToWasmTime: copyEndTime - startTime,
                encodeTime: encodeEndTime - copyEndTime
            });

        } else if (type === 'encode_yuv') {
            const { yuvData } = e.data;
            const yuvArray = new Uint8Array(yuvData);

            if (yuvArray.length > yuvBufferSize) {
                if(yuvBufferPtr) {
                    Module._free(yuvBufferPtr);
                }
                yuvBufferPtr = Module._malloc(yuvArray.length);
                yuvBufferSize = yuvArray.length;
            }
            
            const copyStartTime = performance.now();
            HEAPU8.set(yuvArray, yuvBufferPtr);
            const copyEndTime = performance.now();

            const startTime = performance.now();
            encodeFrameYuv(yuvBufferPtr, width, height, encodedDataPtr_ptr, encodedSize_ptr);
            const encodeEndTime = performance.now();
            
            writeToSharedBufferAndPost({
                frameCopyToWasmTime: copyEndTime - copyStartTime,
                encodeTime: encodeEndTime - startTime
            });
        }
    } catch (err) {
        console.error("Error during encoding:", err);
    } finally {
        isEncoding = false;
    }
};

function writeToSharedBufferAndPost(timingInfo) {
    const encodedDataPtr = Module.getValue(encodedDataPtr_ptr, 'i32');
    const encodedSize = Module.getValue(encodedSize_ptr, 'i32');

    if (encodedSize <= 0) {
        return;
    }
    if (encodedSize > MAX_FRAME_SIZE) {
        console.error(`Encoder: Encoded frame size (${encodedSize}) exceeds max buffer size (${MAX_FRAME_SIZE}). Dropping frame.`);
        return;
    }

    // Find a free buffer
    // A simple round-robin approach.
    const refCountIndex = (currentBufferIndex * 2) + 1;
    if (Atomics.load(controlView, refCountIndex) > 0) {
        // Buffer is still in use by decoders, we have to drop the frame.
        // This indicates the decoders can't keep up.
        console.warn(`Encoder: Buffer ${currentBufferIndex} is still in use (ref count > 0). Dropping frame.`);
        return;
    }

    // --- Copy data from Wasm heap to the shared buffer ---
    const wasmEncodedData = HEAPU8.subarray(encodedDataPtr, encodedDataPtr + encodedSize);
    frameDataViews[currentBufferIndex].set(wasmEncodedData);

    const sizeIndex = currentBufferIndex * 2;
    controlView[sizeIndex] = encodedSize;
    controlView[refCountIndex] = numStreams;
    
    // --- Post message with index ---
    self.postMessage({
        type: 'encoded',
        bufferIndex: currentBufferIndex,
        encodedSize: encodedSize,
        ...timingInfo
    });

    currentBufferIndex = (currentBufferIndex + 1) % FRAME_BUFFER_POOL_SIZE;
}