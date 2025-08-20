let wasmReady = false;
let initEncoder;
let encodeFrame;

let rgbaBufferPtr = 0;
let rgbaBufferSize = 0;


// The Wasm module needs to be loaded in the worker
importScripts('h264.js');

Module.onRuntimeInitialized = () => {
    console.log('Encoder Worker: Wasm module ready.');
    initEncoder = Module.cwrap('init_encoder', 'number', ['number', 'number', 'number']);
    encodeFrame = Module.cwrap('encode_frame', null, ['number', 'number', 'number', 'number', 'number']);
    wasmReady = true;
    self.postMessage({ type: 'ready' });
};

self.onmessage = (e) => {
    if (!wasmReady) return;

    const { type, frameBitmap, width, height } = e.data;

    if (type === 'init') {
        if (initEncoder(width, height, 1000000) !== 0) {
            throw new Error('Wasm Encoder init failed in worker.');
        }
        // Pre-allocate the RGBA buffer inside the worker's Wasm heap
        const requiredSize = width * height * 4;
        if (requiredSize > rgbaBufferSize) {
            if (rgbaBufferPtr) {
                Module._free(rgbaBufferPtr);
            }
            rgbaBufferPtr = Module._malloc(requiredSize);
            rgbaBufferSize = requiredSize;
        }
        console.log('Encoder Worker: Initialized');
        self.postMessage({ type: 'init_done' });

    } else if (type === 'encode') {
        const startTime = performance.now();
        // Create a temporary 2D canvas to get image data from the ImageBitmap
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(frameBitmap, 0, 0);
        const imageData = ctx.getImageData(0, 0, width, height);
        const captureEndTime = performance.now();

        // Copy the image data into the Wasm heap
        HEAPU8.set(imageData.data, rgbaBufferPtr);

        // Allocate memory for the output pointers
        const encodedDataPtr_ptr = Module._malloc(4);
        const encodedSize_ptr = Module._malloc(4);

        // Encode the frame
        encodeFrame(rgbaBufferPtr, width, height, encodedDataPtr_ptr, encodedSize_ptr);

        const encodedDataPtr = Module.getValue(encodedDataPtr_ptr, 'i32');
        const encodedSize = Module.getValue(encodedSize_ptr, 'i32');

        Module._free(encodedDataPtr_ptr);
        Module._free(encodedSize_ptr);

        const encodeEndTime = performance.now();

        if (encodedSize > 0) {
            // Copy the encoded data out of the heap
            const encodedData = HEAPU8.slice(encodedDataPtr, encodedDataPtr + encodedSize);
            // Free the buffer that was allocated in C++
            Module.cwrap('free_buffer', null, ['number'])(encodedDataPtr);
            
            // Send the encoded data back to the main thread
            self.postMessage({
                type: 'encoded',
                encodedData: encodedData.buffer,
                captureTime: (captureEndTime - startTime),
                encodeTime: (encodeEndTime - captureEndTime)
            }, [encodedData.buffer]); // Transfer the buffer to avoid copying
        }
        
        // Close the ImageBitmap to free its resources
        frameBitmap.close();
    }
};