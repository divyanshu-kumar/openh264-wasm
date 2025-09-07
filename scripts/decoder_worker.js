// This script runs in a separate thread for decoding.

let wasmReady = false;
let initDecoder;
let decodeFrame;
let deinitDecoderWasm;
let workerId = -1;
let encodedBufferPtr = 0;
let encodedBufferSize = 0;
let decodedRgbaBufferPtr = 0;
let decodedRgbaBufferSize = 0;
let decodedWidth_ptr = 0;
let decodedHeight_ptr = 0;
let isSafari = null;
let format = 'BGRA';
let decoderStreamsIdx = [];

const streamContexts = new Map(); // streamIndex → bitmaprenderer context
let messageQueue = [];
let isDecoding = false;

function handleMessage(data) {
    const { type } = data;

    if (type === 'set_id') {
        workerId = data.id;
        decoderStreamsIdx = [];
    } else if (type === 'set_canvas') {
        const { canvas, streamIndex } = data;
        decoderStreamsIdx.push(streamIndex);
        // Initialize the specific decoder for this stream index.
        if (initDecoder(streamIndex) !== 0) {
            console.error(`Worker ${workerId} failed to init decoder for stream ${streamIndex}`);
            return;
        }

        // Use bitmaprenderer context for efficient GPU updates
        const ctx = canvas.getContext('bitmaprenderer');
        streamContexts.set(streamIndex, ctx);
        console.log(`Worker ${workerId} has taken control of canvas for stream ${streamIndex}`);

        // Let the main thread know this specific stream is ready.
        self.postMessage({ type: 'stream_ready', streamIndex });

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

        const t0 = performance.now();
        decodeFrame(streamIndex, encodedBufferPtr, encodedDataArray.length, decodedRgbaBufferPtr, decodedWidth_ptr, decodedHeight_ptr);
        const t1 = performance.now();

        const decodedWidth = Module.getValue(decodedWidth_ptr, 'i32');
        const decodedHeight = Module.getValue(decodedHeight_ptr, 'i32');

        if (decodedRgbaBufferPtr && decodedWidth > 0 && decodedHeight > 0) {
            // Wrap decoded RGBA directly into a VideoFrame
            const dataSize = decodedWidth * decodedHeight * 4;
            const rgbaView = HEAPU8.subarray(decodedRgbaBufferPtr, decodedRgbaBufferPtr + dataSize);

            const vf = new VideoFrame(rgbaView, {
                format: format,
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
    } else if (type === 'cleanup') {
        console.log(`Worker ${workerId} cleaning up...`);
        if (encodedBufferPtr) {
            Module._free(encodedBufferPtr);
        }
        if (decodedRgbaBufferPtr) {
            Module._free(decodedRgbaBufferPtr);
        }
        if (decodedWidth_ptr) {
            Module._free(decodedWidth_ptr);
        }
        if (decodedHeight_ptr) {
            Module._free(decodedHeight_ptr);
        }
        while (decoderStreamsIdx.length > 0) {
            deinitDecoderWasm(decoderStreamsIdx.shift());    
        }
        // You could also add a C-side function to clean up the decoder pool
        self.postMessage({ type: 'cleanup_done' });
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
    
    initDecoder = Module.cwrap('init_decoder', 'number', ['number']);
    decodeFrame = Module.cwrap('decode_frame_optimized', null, ['number', 'number', 'number', 'number', 'number', 'number']);
    deinitDecoderWasm = Module.cwrap('deinit_decoder', 'number', ['number']);
    
    wasmReady = true;

    // Safari-specific color format handling
    isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    if (isSafari) {
        format = 'RGBA';
    }
    
    decodedWidth_ptr = Module._malloc(4);
    decodedHeight_ptr = Module._malloc(4);

    while (messageQueue.length > 0) {
        handleMessage(messageQueue.shift());
    }

    self.postMessage({ type: 'ready' });
};
