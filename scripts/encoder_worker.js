let wasmReady = false;
let initEncoder;
let encodeFrame;

let rgbaBufferPtr = 0;
let rgbaBufferSize = 0;
let encodedDataPtr_ptr = 0;
let encodedSize_ptr = 0;

let isEncoding = false;

// The Wasm module needs to be loaded in the worker
importScripts('h264.js');

Module.onRuntimeInitialized = () => {
    console.log('Encoder Worker: Wasm module ready.');
    initEncoder = Module.cwrap('init_encoder', 'number', ['number', 'number', 'number']);
    encodeFrame = Module.cwrap('encode_frame', null, ['number', 'number', 'number', 'number', 'number']);
    wasmReady = true;
    self.postMessage({ type: 'ready' });
};

self.onmessage = async (e) => {
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
        encodedDataPtr_ptr = Module._malloc(4);
        encodedSize_ptr = Module._malloc(4);
        console.log('Encoder Worker: Initialized buffer allocated of size :', requiredSize);
        self.postMessage({ type: 'init_done' });

    } else if (type === 'encode') {
        if (isEncoding) {
            console.warn("Wasm encoder busy when new frame arrived. Dropping frame to manage backpressure.");
            if (frameBitmap && frameBitmap.close) frameBitmap.close();
            return;
        }
        isEncoding = true;

        try {
            const startTime = performance.now();
            // Convert ImageBitmap into VideoFrame
            // (required because copyTo works on VideoFrame, not ImageBitmap)
            const vf = new VideoFrame(frameBitmap, { timestamp: startTime * 1000 });
            frameBitmap.close(); // release GPU resource immediately
            // Copy pixel data directly into WASM memory
            await vf.copyTo(HEAPU8.subarray(rgbaBufferPtr, rgbaBufferPtr + rgbaBufferSize));
            vf.close();
            const frameCopyToWasmEndTime = performance.now();

            // Encode the frame
            encodeFrame(rgbaBufferPtr, width, height, encodedDataPtr_ptr, encodedSize_ptr);

            const encodedDataPtr = Module.getValue(encodedDataPtr_ptr, 'i32');
            const encodedSize = Module.getValue(encodedSize_ptr, 'i32');
            const encodeEndTime = performance.now();

            if (encodedSize > 0) {
                // Copy the encoded data out of the heap
                const encodedData = HEAPU8.slice(encodedDataPtr, encodedDataPtr + encodedSize);
                // Send the encoded data back to the main thread
                self.postMessage({
                    type: 'encoded',
                    encodedData: encodedData.buffer,
                    frameCopyToWasmTime: (frameCopyToWasmEndTime - startTime),
                    encodeTime: (encodeEndTime - frameCopyToWasmEndTime)
                }, [encodedData.buffer]); // Transfer the buffer to avoid copying
            }

        } catch (err) {
            console.error("Error during encoding:", err);
        } finally {
            isEncoding = false;
        }
    } else if (type === 'cleanup') {
        console.log('Encoder Worker: Cleaning up Wasm memory...');
        if (rgbaBufferPtr) {
            Module._free(rgbaBufferPtr);
            rgbaBufferPtr = 0;
        }
        if (encodedDataPtr_ptr) {
            Module._free(encodedDataPtr_ptr);
            encodedDataPtr_ptr = 0;
        }
        if (encodedSize_ptr) {
            Module._free(encodedSize_ptr);
            encodedSize_ptr = 0;
        }
        self.postMessage({ type: 'cleanup_done' });
    }
};