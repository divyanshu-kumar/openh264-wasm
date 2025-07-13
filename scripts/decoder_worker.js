// This script runs in a separate thread for decoding.

let wasmReady = false;
let initDecoderPool;
let decodeFrame;
let freeBuffer;
let workerId = -1;

// Store canvases and their contexts, mapped by the original stream index.
const streamContexts = new Map();
let messageQueue = [];

function handleMessage(data) {
    const { type } = data;

    if (type === 'set_id') {
        // This message is now handled before the queue, but we keep this for safety.
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
        streamContexts.set(streamIndex, canvas.getContext('2d'));
        console.log(`Worker ${workerId} has taken control of canvas for stream ${streamIndex}`);
    } else if (type === 'decode') {
        const { streamIndex, encodedData } = data;
        const context = streamContexts.get(streamIndex);
        if (!context) {
            return;
        }

        const encodedDataArray = new Uint8Array(encodedData);
        const encodedBufferPtr = Module._malloc(encodedDataArray.length);
        HEAPU8.set(encodedDataArray, encodedBufferPtr);

        const decodedRgbaPtr_ptr = Module._malloc(4);
        const decodedWidth_ptr = Module._malloc(4);
        const decodedHeight_ptr = Module._malloc(4);

        const t0 = performance.now();
        decodeFrame(streamIndex, encodedBufferPtr, encodedDataArray.length, decodedRgbaPtr_ptr, decodedWidth_ptr, decodedHeight_ptr);
        const t1 = performance.now();

        Module._free(encodedBufferPtr);

        const decodedRgbaPtr = Module.getValue(decodedRgbaPtr_ptr, 'i32');
        const decodedWidth = Module.getValue(decodedWidth_ptr, 'i32');
        const decodedHeight = Module.getValue(decodedHeight_ptr, 'i32');

        Module._free(decodedRgbaPtr_ptr);
        Module._free(decodedWidth_ptr);
        Module._free(decodedHeight_ptr);

        if (decodedRgbaPtr && decodedWidth > 0 && decodedHeight > 0) {
            const dataSize = decodedWidth * decodedHeight * 4;
            const decodedDataCopy = new Uint8ClampedArray(HEAPU8.subarray(decodedRgbaPtr, decodedRgbaPtr + dataSize));
            const imageData = new ImageData(decodedDataCopy, decodedWidth, decodedHeight);
            
            context.putImageData(imageData, 0, 0);
            freeBuffer(decodedRgbaPtr);
            
            self.postMessage({
                type: 'decoded',
                streamIndex: streamIndex,
                decodeTime: t1 - t0
            });
        } else {
            if (decodedRgbaPtr) freeBuffer(decodedRgbaPtr);
        }
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
