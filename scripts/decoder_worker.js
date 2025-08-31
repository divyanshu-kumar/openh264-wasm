// This script runs in a separate thread for decoding.

let wasmReady = false;
let initDecoderPool;
let decodeFrame;
let freeBuffer;
let workerId = -1;
let encodedBufferPtr = 0;
let encodedBufferSize = 0;
let decodedRgbaBufferPtr = 0;
let decodedRgbaBufferSize = 0;

const streamContexts = new Map(); // streamIndex → bitmaprenderer context
let messageQueue = [];
let isDecoding = false;

function handleMessage(data) {
    const { type } = data;

    if (type === 'set_id') {
        workerId = data.id;
    } else if (type === 'init') {
        console.log(`Worker ${workerId} initializing decoder pool...`);
        if (initDecoderPool(32) !== 0) { 
            console.error(`Worker ${workerId} failed to initialize decoder pool.`);
        } else {
            self.postMessage({ type: 'init_done' });
        }
    } else if (type === 'set_canvas') {
        const { canvas, streamIndex } = data;
        // Use bitmaprenderer context for efficient GPU updates
        const ctx = canvas.getContext('bitmaprenderer');
        streamContexts.set(streamIndex, ctx);
        console.log(`Worker ${workerId} has taken control of canvas for stream ${streamIndex}`);
    } else if (type === 'decode') {
        if (isDecoding) {
            console.warn(`Decoder ${workerId} busy. Dropping a frame.`);
            self.postMessage({ type: 'request_keyframe' });
            return;
        }
        isDecoding = true;
        const { streamIndex, encodedData, width, height } = data;
        const context = streamContexts.get(streamIndex);
        if (!context) {
            isDecoding = false;
            return;
        }

        const encodedDataArray = new Uint8Array(encodedData);
        if (encodedDataArray.length > encodedBufferSize) {
            if (encodedBufferPtr) {
                Module._free(encodedBufferPtr);
            }
            encodedBufferPtr = Module._malloc(encodedDataArray.length);
            encodedBufferSize = encodedDataArray.length;
        }
        HEAPU8.set(encodedDataArray, encodedBufferPtr);

        const requiredRgbaSize = width * height * 4;
        if (requiredRgbaSize > decodedRgbaBufferSize) {
            if (decodedRgbaBufferPtr) {
                Module._free(decodedRgbaBufferPtr);
            }
            decodedRgbaBufferPtr = Module._malloc(requiredRgbaSize);
            decodedRgbaBufferSize = requiredRgbaSize;
        }

        const decodedWidth_ptr = Module._malloc(4);
        const decodedHeight_ptr = Module._malloc(4);

        const t0 = performance.now();
        decodeFrame(streamIndex, encodedBufferPtr, encodedDataArray.length, decodedRgbaBufferPtr, decodedWidth_ptr, decodedHeight_ptr);
        const t1 = performance.now();

        const decodedWidth = Module.getValue(decodedWidth_ptr, 'i32');
        const decodedHeight = Module.getValue(decodedHeight_ptr, 'i32');

        Module._free(decodedWidth_ptr);
        Module._free(decodedHeight_ptr);

        if (decodedRgbaBufferPtr && decodedWidth > 0 && decodedHeight > 0) {
            // Wrap decoded RGBA directly into a VideoFrame
            const dataSize = decodedWidth * decodedHeight * 4;
            const rgbaView = HEAPU8.subarray(decodedRgbaBufferPtr, decodedRgbaBufferPtr + dataSize);

            const vf = new VideoFrame(rgbaView, {
                format: "RGBA",
                codedWidth: decodedWidth,
                codedHeight: decodedHeight,
                timestamp: performance.now() * 1000, // µs timestamp
            });

            // Convert VideoFrame → ImageBitmap (GPU-friendly)
            createImageBitmap(vf).then((bitmap) => {
                context.transferFromImageBitmap(bitmap);
                vf.close();
            });

            self.postMessage({
                type: 'decoded',
                streamIndex,
                decodeTime: (t1 - t0)
            });
        }
        isDecoding = false;
    }
}

self.onmessage = (e) => {
    if (e.data.type === 'set_id') {
        workerId = e.data.id;
        return;
    }
    if (!wasmReady) {
        messageQueue.push(e.data);
        return;
    }
    handleMessage(e.data);
};

// This is the entry point for the worker.
self.importScripts('h264.js');
Module.onRuntimeInitialized = () => {
    console.log(`Worker ${workerId}: Wasm module ready.`);
    initDecoderPool = Module.cwrap('init_decoder_pool', 'number', ['number']);
    decodeFrame = Module.cwrap('decode_frame', null, ['number', 'number', 'number', 'number', 'number', 'number']);
    freeBuffer = Module.cwrap('free_buffer', null, ['number']);
    wasmReady = true;

    while (messageQueue.length > 0) {
        handleMessage(messageQueue.shift());
    }

    self.postMessage({ type: 'ready' });
};
