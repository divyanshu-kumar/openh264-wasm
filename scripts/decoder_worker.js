// This script runs in a separate thread for decoding.

let wasmReady = false;
let initDecoder;
let decodeFrame;
let decodeFrameYuv;
let deinitDecoderWasm;
let workerId = -1;
let encodedBufferPtr = 0;
let encodedBufferSize = 0;
let decodedRgbaBufferPtr = 0;
let decodedRgbaBufferSize = 0;
let decodedYuvBufferPtr = 0;
let decodedYuvBufferSize = 0;
let decodedWidth_ptr = 0;
let decodedHeight_ptr = 0;
let decoderStreamsIdx = [];

let messageQueue = [];
let isDecoding = false;

// SharedArrayBuffer state
let encodedFrameSAB, controlSAB, controlView;
let frameDataViews = [];
let FRAME_BUFFER_POOL_SIZE, MAX_FRAME_SIZE;

const streamContexts = new Map(); // For standard rendering
const streamGpuContexts = new Map(); // For WebGPU rendering

// WebGPU State
let gpuDevice = null;
let yuvToRgbaPipeline = null; // Shared pipeline
let gpuInitPromise = null; // Promise to ensure single initialization

async function handleMessage(data) {
    const { type } = data;

    if (type === 'set_canvas') {
        await handleSetCanvasBitmap(data);
    } else if (type === 'set_canvas_webgpu') {
        await handleSetCanvasWebGPU(data);
    } else if (type === 'decode') {
        await handleDecode(data);
    } else if (type === 'cleanup') {
        handleCleanup();
    }
}

async function handleSetCanvasBitmap({ canvas, streamIndex }) {
    decoderStreamsIdx.push(streamIndex);
    if (initDecoder(streamIndex) !== 0) {
        console.error(`Worker ${workerId} failed to init decoder for stream ${streamIndex}`);
        return;
    }
    const ctx = canvas.getContext('bitmaprenderer');
    streamContexts.set(streamIndex, ctx);
    console.log(`Worker ${workerId} has taken control of canvas for stream ${streamIndex} (Bitmap)`);
    self.postMessage({ type: 'stream_ready', streamIndex });
}

async function handleSetCanvasWebGPU({ canvas, streamIndex }) {
    decoderStreamsIdx.push(streamIndex);
        // Initialize the specific decoder for this stream index.
    if (initDecoder(streamIndex) !== 0) {
        console.error(`Worker ${workerId} failed to init decoder for stream ${streamIndex}`);
        return;
    }
    
    // Use a promise to ensure WebGPU is initialized only once.
    if (!gpuInitPromise) {
        gpuInitPromise = (async () => {
            try {
                const adapter = await navigator.gpu.requestAdapter();
                if (!adapter) {
                    throw new Error("No adapter found");
                }
                gpuDevice = await adapter.requestDevice();
                
                const shaderModule = gpuDevice.createShaderModule({ code: yuvToRgbaShaderModule });
                yuvToRgbaPipeline = await gpuDevice.createRenderPipelineAsync({
                    layout: 'auto',
                    vertex: { module: shaderModule, entryPoint: 'vs_main' },
                    fragment: {
                        module: shaderModule,
                        entryPoint: 'fs_main',
                        targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
                    },
                    primitive: { topology: 'triangle-strip' },
                });
            } catch (e) {
                console.error(`Worker ${workerId}: Failed to initialize WebGPU.`, e);
                self.postMessage({ type: 'error', message: 'WebGPU init failed in worker.'});
                // Reset promise on failure to allow retry
                gpuInitPromise = null; 
                throw e; // re-throw to be caught by the caller
            }
        })();
    }
    
    try {
        await gpuInitPromise;
    } catch(e) {
        console.error(`Initialization failed, can't proceed with this canvas.`);
        return;
    }
    
    const context = canvas.getContext('webgpu');
    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
        device: gpuDevice,
        format: presentationFormat,
        alphaMode: 'premultiplied',
    });
    
    // Create dedicated resources for this specific stream
    const yTexture = gpuDevice.createTexture({ size: [1, 1], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const uTexture = gpuDevice.createTexture({ size: [1, 1], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const vTexture = gpuDevice.createTexture({ size: [1, 1], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const sampler = gpuDevice.createSampler({ filter: 'linear' });

    const bindGroup = gpuDevice.createBindGroup({
        layout: yuvToRgbaPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: sampler },
            { binding: 1, resource: yTexture.createView() },
            { binding: 2, resource: uTexture.createView() },
            { binding: 3, resource: vTexture.createView() },
        ],
    });

    streamGpuContexts.set(streamIndex, { context, yTexture, uTexture, vTexture, bindGroup });
    console.log(`Worker ${workerId} has taken control of canvas for stream ${streamIndex} (WebGPU)`);
    self.postMessage({ type: 'stream_ready', streamIndex });
}


async function handleDecode(data) {
    const { bufferIndex } = data;
    const refCountIndex = bufferIndex * 2 + 1;

    if (isDecoding) {
        // If busy, we must still decrement the counter for this frame,
        // otherwise the buffer will be locked and never reused.
        Atomics.sub(controlView, refCountIndex, 1);
        return;
    }
    isDecoding = true;

    let bufferReleased = false;

    try {
        // Get data from SharedArrayBuffer using index instead of from message payload
        const { streamIndex, encodedSize, width, height } = data;
        const encodedDataArray = frameDataViews[bufferIndex].subarray(0, encodedSize);
        
        if (encodedDataArray.length > encodedBufferSize) {
            if (encodedBufferPtr) {
                Module._free(encodedBufferPtr);
            }
            encodedBufferPtr = Module._malloc(encodedDataArray.length);
            encodedBufferSize = encodedDataArray.length;
        }
        HEAPU8.set(encodedDataArray, encodedBufferPtr);
        Atomics.sub(controlView, refCountIndex, 1);
        bufferReleased = true;
        
        const t0 = performance.now();
        
        const isWebGpuPath = streamGpuContexts.has(streamIndex);
        if (isWebGpuPath) {
            const requiredYuvSize = width * height * 1.5;
            if (requiredYuvSize > decodedYuvBufferSize) {
                if(decodedYuvBufferPtr) {
                    Module._free(decodedYuvBufferPtr);
                }
                decodedYuvBufferPtr = Module._malloc(requiredYuvSize);
                decodedYuvBufferSize = requiredYuvSize;
            }
            decodeFrameYuv(streamIndex, encodedBufferPtr, encodedDataArray.length, decodedYuvBufferPtr, decodedWidth_ptr, decodedHeight_ptr);
        } else if (streamContexts.has(streamIndex)) { // Standard Bitmap Path
            const requiredRgbaSize = width * height * 4;
            if (requiredRgbaSize > decodedRgbaBufferSize) {
                if (decodedRgbaBufferPtr) {
                    Module._free(decodedRgbaBufferPtr);
                }
                decodedRgbaBufferPtr = Module._malloc(requiredRgbaSize);
                decodedRgbaBufferSize = requiredRgbaSize;
            }
            decodeFrame(streamIndex, encodedBufferPtr, encodedDataArray.length, decodedRgbaBufferPtr, decodedWidth_ptr, decodedHeight_ptr);
        } else {
             isDecoding = false;
             return;
        }
        
        const t1 = performance.now();

        const decodedWidth = Module.getValue(decodedWidth_ptr, 'i32');
        const decodedHeight = Module.getValue(decodedHeight_ptr, 'i32');

        if (decodedWidth > 0 && decodedHeight > 0) {
            if (isWebGpuPath) {
                const ySize = decodedWidth * decodedHeight;
                const uvSize = ySize / 4;
                const yuvData = HEAPU8.subarray(decodedYuvBufferPtr, decodedYuvBufferPtr + ySize + 2 * uvSize);
                await renderYuvToCanvas(streamIndex, yuvData, decodedWidth, decodedHeight);
            } else { // Bitmap Render
                const dataSize = decodedWidth * decodedHeight * 4;
                const rgbaView = HEAPU8.subarray(decodedRgbaBufferPtr, decodedRgbaBufferPtr + dataSize);
                const vf = new VideoFrame(rgbaView, { format: 'RGBA', codedWidth: decodedWidth, codedHeight: decodedHeight, timestamp: performance.now() * 1000 });
                const bitmap = await createImageBitmap(vf);
                streamContexts.get(streamIndex).transferFromImageBitmap(bitmap);
                vf.close();
            }
        }
        
        self.postMessage({
            type: 'decoded',
            streamIndex,
            decodeTime: (t1 - t0)
        });
    } finally {
        isDecoding = false;
        if (!bufferReleased) {
            Atomics.sub(controlView, refCountIndex, 1);
        }
    }
}


async function renderYuvToCanvas(streamIndex, yuvData, width, height) {
    const streamRes = streamGpuContexts.get(streamIndex);
    if (!streamRes) {
        return;
    }
    let { context, yTexture, uTexture, vTexture, bindGroup } = streamRes;

    // Resize textures if needed
    if (yTexture.width !== width || yTexture.height !== height) {
        yTexture.destroy();
        uTexture.destroy();
        vTexture.destroy();
        yTexture = gpuDevice.createTexture({ size: [width, height], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        uTexture = gpuDevice.createTexture({ size: [width/2, height/2], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        vTexture = gpuDevice.createTexture({ size: [width/2, height/2], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
        
        bindGroup = gpuDevice.createBindGroup({
            layout: yuvToRgbaPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: gpuDevice.createSampler({ filter: 'linear' }) },
                { binding: 1, resource: yTexture.createView() },
                { binding: 2, resource: uTexture.createView() },
                { binding: 3, resource: vTexture.createView() },
            ],
        });
        // Update the stored resources
        streamGpuContexts.set(streamIndex, {...streamRes, yTexture, uTexture, vTexture, bindGroup });
    }

    const ySize = width * height;
    const uvWidth = width / 2;
    const uvHeight = height / 2;
    const uvSize = uvWidth * uvHeight;

    gpuDevice.queue.writeTexture({ texture: yTexture }, yuvData.subarray(0, ySize), { bytesPerRow: width }, { width, height });
    gpuDevice.queue.writeTexture({ texture: uTexture }, yuvData.subarray(ySize, ySize + uvSize), { bytesPerRow: uvWidth }, { width: uvWidth, height: uvHeight });
    gpuDevice.queue.writeTexture({ texture: vTexture }, yuvData.subarray(ySize + uvSize), { bytesPerRow: uvWidth }, { width: uvWidth, height: uvHeight });
    
    const commandEncoder = gpuDevice.createCommandEncoder();
    const textureView = context.getCurrentTexture().createView();
    const renderPass = commandEncoder.beginRenderPass({
        colorAttachments: [{ view: textureView, loadOp: 'clear', storeOp: 'store', clearValue: [0,0,0,1] }],
    });
    renderPass.setPipeline(yuvToRgbaPipeline);
    renderPass.setBindGroup(0, bindGroup);
    renderPass.draw(4);
    renderPass.end();
    gpuDevice.queue.submit([commandEncoder.finish()]);
}

function handleCleanup() {
    console.log(`Worker ${workerId} cleaning up...`);
    // Destroy GPU resources
    for (const [key, value] of streamGpuContexts) {
        value.yTexture?.destroy();
        value.uTexture?.destroy();
        value.vTexture?.destroy();
    }
    streamGpuContexts.clear();
    streamContexts.clear();
    // Reset the GPU initialization state for the next run
    gpuDevice = null;
    yuvToRgbaPipeline = null;
    gpuInitPromise = null;

    if (encodedBufferPtr) {
        Module._free(encodedBufferPtr);
    }
    if (decodedRgbaBufferPtr) {
        Module._free(decodedRgbaBufferPtr);
    }
    if (decodedYuvBufferPtr) {
        Module._free(decodedYuvBufferPtr);
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
    self.postMessage({ type: 'cleanup_done' });
}

self.onmessage = (e) => {
    if (e.data.type === 'set_id') {
        workerId = e.data.id;
        return;
    }
    if (e.data.type === 'init_sab') {
        encodedFrameSAB = e.data.encodedFrameSAB;
        controlSAB = e.data.controlSAB;
        FRAME_BUFFER_POOL_SIZE = e.data.FRAME_BUFFER_POOL_SIZE;
        MAX_FRAME_SIZE = e.data.MAX_FRAME_SIZE;
        controlView = new Int32Array(controlSAB);
        for (let i = 0; i < FRAME_BUFFER_POOL_SIZE; i++) {
            frameDataViews[i] = new Uint8Array(encodedFrameSAB, i * MAX_FRAME_SIZE, MAX_FRAME_SIZE);
        }
        console.log(`Worker ${workerId}: Shared buffers initialized.`);
        return;
    }

    if (!wasmReady || !controlSAB) {
        messageQueue.push(e.data);
        return;
    }
    handleMessage(e.data);
};

// This is the entry point for the worker.
self.importScripts('wgsl_shaders.js', 'h264.js');
Module.onRuntimeInitialized = () => {
    console.log(`Worker ${workerId}: Wasm module ready.`);
    
    initDecoder = Module.cwrap('init_decoder', 'number', ['number']);
    decodeFrame = Module.cwrap('decode_frame_optimized', null, ['number', 'number', 'number', 'number', 'number', 'number']);
    decodeFrameYuv = Module.cwrap('decode_frame_yuv_i420', null, ['number', 'number', 'number', 'number', 'number', 'number']);
    deinitDecoderWasm = Module.cwrap('deinit_decoder', 'number', ['number']);
    
    decodedWidth_ptr = Module._malloc(4);
    decodedHeight_ptr = Module._malloc(4);
    
    wasmReady = true;

    while (messageQueue.length > 0) {
        handleMessage(messageQueue.shift());
    }

    self.postMessage({ type: 'ready' });
};
