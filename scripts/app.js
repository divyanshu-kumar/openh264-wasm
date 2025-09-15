// Wait for the Emscripten module to be ready.
Module.onRuntimeInitialized = () => {
    console.log('Wasm module and heap are ready.');
    main();
};

async function main() {
    // --- DOM Elements ---
    const startButton = document.getElementById('startButton');
    const resetButton = document.getElementById('resetButton');
    const captureButton = document.getElementById('captureButton');
    const statusEl = document.getElementById('status');
    const inputVideo = document.getElementById('inputVideo');
    const outputContainer = document.getElementById('outputContainer');
    const streamCountSelect = document.getElementById('streamCountSelect');
    const resolutionSelect = document.getElementById('resolutionSelect');
    const threadCountSelect = document.getElementById('threadCountSelect');
    const implementationSelect = document.getElementById('implementationSelect');
    
    // Performance Stat Elements
    const perfEls = {
        frameCopyToWasmTime: document.getElementById('frameCopyToWasmTime'),
        encodeTime: document.getElementById('encodeTime'),
        decodeTime: document.getElementById('decodeTime'),
        avgDecodeTime: document.getElementById('avgDecodeTime'),
        inputFps: document.getElementById('inputFps'),
        outputFps: document.getElementById('outputFps'),
    };

    // Results Table and Machine Info Elements
    const resultsContainer = document.getElementById('resultsContainer');
    const resultsBody = document.getElementById('resultsBody');
    const downloadResultsButton = document.getElementById('downloadResultsButton');
    const machineInfoDisplay = document.getElementById('machineInfoDisplay');
    const cpuInfoEl = document.getElementById('cpuInfo');
    const ramInfoEl = document.getElementById('ramInfo');


    // --- State ---
    let processing = false;
    let cameraActive = false;
    let videoWidth, videoHeight;
    let tempCanvas, tempCtx;
    let mediaStream = null;
    let capturedResults = [];
    let decoderWorkers = [];
    let encoderWorker = null;
    let machineInfo = null;

    // WebCodecs State
    let videoEncoder, decoders = [];
    
    // WebGPU State
    let gpuDevice = null;
    let rgbaToYuvPackPipeline = null;
    let rgbaTexture = null;
    let packedYuvBuffer, uniformBuffer;
    
    // State for pipelined readbacks.
    const READBACK_BUFFER_COUNT = 3;
    let readbackBuffers = [];
    let frameIndex = 0;
    let lastFramePromise = null;


    // --- Stats calculation state ---
    let statsUpdateInterval = null;
    let inputFrameCount = 0;
    let outputFrameCount = 0;
    let totalEncodeTime = 0;
    let totalFrameCopyToWasmTime = 0;
    let totalDecodeTime = 0;
    
    // --- URL Parameter Handling ---
    const urlParams = new URLSearchParams(window.location.search);
    const defaultImplementation = urlParams.get('impl') || 'wasm';
    const defaultResolution = urlParams.get('res') || "854x480";
    const defaultStreams = urlParams.get('streams') || "1";
    const defaultThreads = urlParams.get('threads') || "default";

    // --- Machine Info ---
    async function getMachineInfo() {
        if (machineInfo) {
            return machineInfo;
        }
        machineInfo = {
            cpuCores: navigator.hardwareConcurrency || 'N/A',
            memory: navigator.deviceMemory || 'N/A',
        };
        return machineInfo;
    }

    // --- Populate Dropdowns ---
    const resolutions = {
        "360p": { width: 640, height: 360 }, "480p": { width: 854, height: 480 },
        "720p": { width: 1280, height: 720 }, "1080p": { width: 1920, height: 1080 },
    };
    for (const [label, res] of Object.entries(resolutions)) {
        resolutionSelect.appendChild(new Option(`${label} (${res.width}x${res.height})`, `${res.width}x${res.height}`));
    }
    for (let i = 1; i <= 32; i++) {
        streamCountSelect.appendChild(new Option(i, i));
    }
    
    threadCountSelect.appendChild(new Option('Default (Auto)', 'default'));
    for (let i = 1; i <= (navigator.hardwareConcurrency || 8); i++) {
        threadCountSelect.appendChild(new Option(i, i));
    }

    implementationSelect.value = defaultImplementation;
    resolutionSelect.value = defaultResolution;
    streamCountSelect.value = defaultStreams;
    threadCountSelect.value = defaultThreads;
    
    // --- C++ Function Wrappers ---
    const forceKeyFrameWasm = Module.cwrap('force_key_frame', null, []);

    // --- WebGPU Initialization ---
    async function initWebGPU() {
        if (!navigator.gpu) {
            console.warn("WebGPU not supported. Disabling WASM+WebGPU mode.");
            const wasmGpuOption = implementationSelect.querySelector('option[value="wasm_webgpu"]');
            if (wasmGpuOption) {
                wasmGpuOption.disabled = true;
            }
            const wasmGpuCheckbox = document.querySelector('#implCheckboxes input[value="wasm_webgpu"]');
            if(wasmGpuCheckbox) {
                wasmGpuCheckbox.disabled = true;
                wasmGpuCheckbox.parentElement.style.opacity = 0.5;
            }
            return false;
        }
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) {
                throw new Error('No GPU adapter found.');
            }
            gpuDevice = await adapter.requestDevice();
            console.log("WebGPU device initialized successfully.");
            return true;
        } catch (e) {
            console.error("Failed to initialize WebGPU:", e);
             const wasmGpuOption = implementationSelect.querySelector('option[value="wasm_webgpu"]');
            if (wasmGpuOption) {
                wasmGpuOption.disabled = true;
            }
            return false;
        }
    }
    
    await initWebGPU();

    async function shutdownEncoderWorker() {
        if (encoderWorker) {
            await new Promise(resolve => {
                const messageHandler = (event) => {
                    if (event.data.type === 'cleanup_done') {
                        encoderWorker.terminate();
                        encoderWorker = null;
                        self.removeEventListener('message', messageHandler);
                        resolve();
                    }
                };
                encoderWorker.addEventListener('message', messageHandler);
                encoderWorker.postMessage({ type: 'cleanup' });
            });
            console.log("Encoder worker has been shut down gracefully.");
        }
    }

    async function stopDecoderWorkers() {
        const shutdownPromises = decoderWorkers.map(worker => {
            return new Promise(resolve => {
                const messageHandler = (event) => {
                    if (event.data.type === 'cleanup_done') {
                        worker.terminate();
                        worker.removeEventListener('message', messageHandler);
						self.removeEventListener('error', messageHandler);
                        resolve();
                    }
                };
                worker.addEventListener('message', messageHandler);
				worker.addEventListener('error', messageHandler);
                worker.postMessage({ type: 'cleanup' });
            });
        });
        await Promise.all(shutdownPromises);
        console.log("All decoderWorkers have been shut down gracefully.");
        decoderWorkers = [];
    }

    // --- Main Control Logic ---
    async function stop() {
        if (!cameraActive) {
            return;
        }
        console.log("Stopping current stream...");
        processing = false;
        cameraActive = false;

        // Give a moment for any in-flight requestVideoFrameCallback to complete
        await new Promise(r => setTimeout(r, 50)); 

        if (statsUpdateInterval) {
            clearInterval(statsUpdateInterval);
            statsUpdateInterval = null;
        }

        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }
        await shutdownEncoderWorker();
        await stopDecoderWorkers();
        if (videoEncoder && videoEncoder.state !== 'closed') {
            videoEncoder.close();
        }
        decoders.forEach(d => { if (d.state !== 'closed') { d.close(); }});
        decoders = [];
        inputVideo.srcObject = null;
        outputContainer.innerHTML = '';

        // Reset performance text
        Object.values(perfEls).forEach(el => el.textContent = '--');
        perfEls.decodeTime.textContent = '-- ms';
        perfEls.avgDecodeTime.textContent = '-- ms';
        perfEls.encodeTime.textContent = '-- ms';
        perfEls.frameCopyToWasmTime.textContent = '-- ms';

        statusEl.textContent = 'Status: Idle';
        startButton.textContent = 'Start Camera';
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    async function start() {
        await stop();
        try {
            statusEl.textContent = 'Status: Starting...';
            const [w, h] = resolutionSelect.value.split('x').map(Number);
            const constraints = { video: { width: { ideal: w }, height: { ideal: h }, framerate: { min: 15, max: 30 } } };
            
            mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
            cameraActive = true;
            inputVideo.srcObject = mediaStream;
            console.log("Camera stream acquired.");

            await new Promise(r => { inputVideo.onloadedmetadata = () => {
                videoWidth = inputVideo.videoWidth;
                videoHeight = inputVideo.videoHeight;
                r();
            }});

            await inputVideo.play();
            console.log("Video is playing.");

            statusEl.textContent = 'Status: Initializing...';
            
            // Reset stats counters and start the periodic updater
            inputFrameCount = 0;
            outputFrameCount = 0;
            totalEncodeTime = 0;
            totalFrameCopyToWasmTime = 0;
            totalDecodeTime = 0;
            statsUpdateInterval = setInterval(updateStatsDisplay, 1000);

            const selectedImpl = implementationSelect.value;
            if (selectedImpl === 'wasm') {
                await startWasm();
            } else if (selectedImpl === 'wasm_webgpu') {
                await startWasmWebGPU();
            } else {
                await startWebCodecs();
            }

            processing = true;
            inputVideo.requestVideoFrameCallback(processVideoFrame);

            startButton.textContent = 'Stop Camera';

        } catch (error) {
            console.error('Error during setup:', error);
            statusEl.textContent = `Error: ${error.message}`;
            await stop();
        }
    }
    
    async function setupEncoderWorker(onInitDone) {
        if (encoderWorker) {
            await shutdownEncoderWorker();
        }

        return new Promise((resolve, reject) => {
            encoderWorker = new Worker('scripts/encoder_worker.js');
            encoderWorker.onerror = (err) => reject(err);
            encoderWorker.onmessage = async (e) => {
                const { type, encodedData, frameCopyToWasmTime, encodeTime } = e.data;
                if (type === 'ready') {
                    // Once the worker's Wasm module is ready, initialize the encoder
                    encoderWorker.postMessage({ type: 'init', width: videoWidth, height: videoHeight });
                } else if (type === 'init_done') {
                    await onInitDone();
                    resolve();
                } else if (type === 'encoded') {
                    if (frameCopyToWasmTime) {
                        totalFrameCopyToWasmTime += frameCopyToWasmTime;
                    }
                    if (encodeTime) {
                        totalEncodeTime += encodeTime;
                    }
                    // When an encoded frame comes back, distribute it to the decoders
                    const numStreams = parseInt(streamCountSelect.value, 10);
                    for (let i = 0; i < numStreams; i++) {
                        decoderWorkers[i % decoderWorkers.length].postMessage({
                            type: 'decode',
                            streamIndex: i,
                            encodedData: encodedData,
                            width: videoWidth,
                            height: videoHeight
                        });
                    }
                }
            };
        });
    }

    // --- Wasm Implementation ---
    async function startWasm() {
        tempCanvas = document.createElement('canvas');
        tempCanvas.width = videoWidth;
        tempCanvas.height = videoHeight;
        tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        
        await setupEncoderWorker(reconfigureWorkersAndCanvases);
    }
    
    // --- Wasm with WebGPU Implementation ---
    async function startWasmWebGPU() {
        if (!gpuDevice) {
            throw new Error("WebGPU is not initialized. Cannot start in WebGPU mode.");
        }
        
        tempCanvas = document.createElement('canvas');
        tempCanvas.width = videoWidth;
        tempCanvas.height = videoHeight;
        tempCtx = tempCanvas.getContext('2d');
        
        // --- Create WebGPU resources for RGBA -> YUV conversion ---
        const packedYuvBufferSize = videoWidth * videoHeight * 1.5;

        rgbaTexture = gpuDevice.createTexture({
            size: [videoWidth, videoHeight],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });

        // The packedYuvBuffer needs storage for the compute shader,
        // and COPY_DST so we can clear it before each run.
        packedYuvBuffer = gpuDevice.createBuffer({ size: packedYuvBufferSize, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
        
        // Create a pool of readback buffers for pipelining.
        readbackBuffers = [];
        for (let i = 0; i < READBACK_BUFFER_COUNT; i++) {
            readbackBuffers.push(gpuDevice.createBuffer({
                size: packedYuvBufferSize,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            }));
        }
        // Initialize state for the pipeline.
        frameIndex = 0;
        lastFramePromise = Promise.resolve();
        
        // Uniform buffer for dimensions
        uniformBuffer = gpuDevice.createBuffer({
            size: 8, // 2 x u32 (width, height)
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        // Create a single pipeline with the optimized shader.
        const rgbaToYuvPackShader = gpuDevice.createShaderModule({ code: optimizedRgbaToYuvPackShaderCode });
        rgbaToYuvPackPipeline = await gpuDevice.createComputePipelineAsync({
            layout: 'auto',
            compute: { module: rgbaToYuvPackShader, entryPoint: 'main' }
        });
        
        await setupEncoderWorker(reconfigureWorkersAndCanvases);
    }


    async function reconfigureWorkersAndCanvases() {
        processing = false;
        await new Promise(r => setTimeout(r, 50));
        await stopDecoderWorkers();
        
        const isWebGpuMode = implementationSelect.value === 'wasm_webgpu';

        return new Promise((resolve, reject) => {
            // --- Determine thread count based on selection ---
            let numThreads;
            const selectedThreads = threadCountSelect.value;
            if (selectedThreads === 'default') {
                // Probe hardware concurrency and leave 2 for the main and encoder thread.
                const hardwareConcurrency = navigator.hardwareConcurrency || 2; // Use 2 as a fallback.
                numThreads = Math.max(1, hardwareConcurrency - 2);
                console.log(`"Default" threads selected. Using ${numThreads} based on hardware concurrency of ${hardwareConcurrency}.`);
            } else {
                numThreads = parseInt(selectedThreads, 10);
            }
            
            if (numThreads === 0) {
                return resolve();
            }
            const numStreams = parseInt(streamCountSelect.value, 10);
            if (selectedThreads === 'default' && numThreads > numStreams ) {
                numThreads = Math.max(1, numStreams);
                console.log(`"Default" threads selected. NumStreams lesser than available threads, now using ${numThreads}.`);
            }
            let readyCount = 0;
            let streamReadyCount = 0;

            for (let i = 0; i < numThreads; i++) {
                const worker = new Worker('scripts/decoder_worker.js');
                worker.postMessage({ type: 'set_id', id: i });
                worker.onerror = (err) => reject(new Error(`Worker error: ${err.message}`));

                worker.onmessage = (e) => {
                    if (e.data.type === 'ready') {
                        if (++readyCount === numThreads) {
                            setupCanvases(isWebGpuMode);
                        }
                    } else if (e.data.type === 'stream_ready') {
                        streamReadyCount++;
                        // When all assigned streams have successfully initialized their decoders...
                        if (streamReadyCount === numStreams) {
                            processing = true; // It's now safe to start processing frames
                            resolve();
                        }
                    } else if (e.data.type === 'decoded') {
                        outputFrameCount++;
                        totalDecodeTime += e.data.decodeTime;
                    } else if (e.data.type === 'request_keyframe') {
                        console.log(`Decoder worker requested a keyframe. Forcing one now.`);
                        forceKeyFrameWasm();
                    }
                };
                decoderWorkers.push(worker);
            }
        });
    }

    function setupCanvases(isWebGpuMode) {
        const numStreams = parseInt(streamCountSelect.value, 10);
        const numThreads = decoderWorkers.length;
        if (numThreads === 0) {
            return;
        }
        outputContainer.innerHTML = '';
        let canvases = [];
        for (let j = 0; j < numStreams; j++) {
            const canvas = document.createElement('canvas');
            outputContainer.appendChild(canvas);
            canvas.width = videoWidth;
            canvas.height = videoHeight;
            canvases.push(canvas.transferControlToOffscreen());
        }
        
        const messageType = isWebGpuMode ? 'set_canvas_webgpu' : 'set_canvas';
        for (let j = 0; j < numStreams; j++) {
            decoderWorkers[j % numThreads].postMessage({
                type: messageType, canvas: canvases[j], streamIndex: j,
            }, [canvases[j]]);
        }
        forceKeyFrameWasm();
    }
    
    async function processVideoFrameWasmWebGPU() {
        // --- Pipelining Step 1: Wait for the PREVIOUS frame's data to be ready ---
        await lastFramePromise;
        const currentReadbackBuffer = readbackBuffers[frameIndex % READBACK_BUFFER_COUNT];

        // --- Pipelining Step 2: Process the PREVIOUS frame's data ---
        // This buffer was mapped at the end of the last frame call. Now it's ready.
        if (currentReadbackBuffer.mapState === 'mapped') {
            const yuvGpuArray = currentReadbackBuffer.getMappedRange();
            const yuvData = new Uint8Array(yuvGpuArray.slice(0)); // Create a copy for the worker
            currentReadbackBuffer.unmap();
            
            encoderWorker.postMessage({
                type: 'encode_yuv',
                yuvData: yuvData.buffer,
                width: videoWidth,
                height: videoHeight,
            }, [yuvData.buffer]);
        }

        // --- Pipelining Step 3: Start processing the CURRENT frame on the GPU ---
        gpuDevice.queue.copyExternalImageToTexture(
            { source: inputVideo }, 
            { texture: rgbaTexture }, 
            [videoWidth, videoHeight]
        );
        
        gpuDevice.queue.writeBuffer(uniformBuffer, 0, new Uint32Array([videoWidth, videoHeight]));

        // Create bind group for the single compute pass
        const rgbaToYuvPackBindGroup = gpuDevice.createBindGroup({
            layout: rgbaToYuvPackPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: rgbaTexture.createView() },
                { binding: 1, resource: { buffer: packedYuvBuffer } },
                { binding: 2, resource: { buffer: uniformBuffer } },
            ],
        });

        const commandEncoder = gpuDevice.createCommandEncoder();
        
        // The shader uses atomicOr, so we must clear the buffer to 0 before each pass.
        commandEncoder.clearBuffer(packedYuvBuffer);
        
        const passEncoder = commandEncoder.beginComputePass();
        passEncoder.setPipeline(rgbaToYuvPackPipeline);
        passEncoder.setBindGroup(0, rgbaToYuvPackBindGroup);
        passEncoder.dispatchWorkgroups(Math.ceil(videoWidth / 8), Math.ceil(videoHeight / 8));
        passEncoder.end();
        
        // --- Pipelining Step 4: Copy the result to the NEXT readback buffer ---
        const nextReadbackBuffer = readbackBuffers[(frameIndex + 1) % READBACK_BUFFER_COUNT];
        commandEncoder.copyBufferToBuffer(packedYuvBuffer, 0, nextReadbackBuffer, 0, videoWidth * videoHeight * 1.5);
        gpuDevice.queue.submit([commandEncoder.finish()]);
        
        // --- Pipelining Step 5: Request the map for the CURRENT frame's data but DO NOT await it ---
        // Store the promise so the next frame can await it.
        lastFramePromise = nextReadbackBuffer.mapAsync(GPUMapMode.READ);
        
        frameIndex++;
    }

    async function processVideoFrame(now, metadata) {
        if (!processing) {
            return;
        }
        inputFrameCount++;
        
        const selectedImpl = implementationSelect.value;
        if (selectedImpl === 'wasm') {
           createImageBitmap(inputVideo).then(bitmap => {
                encoderWorker.postMessage({
                    type: 'encode',
                    frameBitmap: bitmap,
                    width: videoWidth,
                    height: videoHeight,
                }, [bitmap]);
            });
        } else if (selectedImpl === 'wasm_webgpu') {
            await processVideoFrameWasmWebGPU();
        } else {
            const frame = new VideoFrame(inputVideo, { timestamp: metadata.mediaTime * 1000000 });
            handleWebCodecsFrame(frame);
            frame.close();
        }
        inputVideo.requestVideoFrameCallback(processVideoFrame);
    }

    // --- WebCodecs Implementation ---
    function getWebCodecString(width, height) {
        // Baseline Profile, Level 3.0 for SD resolutions
        if (width * height <= 640 * 480) { return 'avc1.42E01E'; }
        // Main Profile, Level 3.1 for 720p
        if (width * height <= 1280 * 720) { return 'avc1.4D401F'; }
        // High Profile, Level 4.1 for 1080p
        if (width * height <= 1920 * 1080) { return 'avc1.640028'; }
        // Default to a high level for resolutions beyond 1080p
        return 'avc1.640033'; // Level 5.1
    }

    async function startWebCodecs() {
        const numStreams = parseInt(streamCountSelect.value, 10);
        outputContainer.innerHTML = '';
        const outputCanvases = Array.from({ length: numStreams }, () => {
            const canvas = document.createElement('canvas');
            outputContainer.appendChild(canvas);
            canvas.width = videoWidth;
            canvas.height = videoHeight;
            return canvas;
        });

        decoders = [];
        for (let i = 0; i < numStreams; i++) {
            const canvas = outputCanvases[i];
            const decoder = new VideoDecoder({
                output: (frame) => {
                    outputFrameCount++;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
                    frame.close();
                },
                error: (e) => console.error(`WebCodecs decoder error on stream ${i}:`, e.message),
            });
            decoders.push(decoder);
        }
        
        const codecString = getWebCodecString(videoWidth, videoHeight);
        console.log(`Using WebCodecs codec string: ${codecString}`);

        videoEncoder = new VideoEncoder({
            output: (chunk, metadata) => {
                const t0 = performance.now();
                decoders.forEach(decoder => {
                    if (metadata.decoderConfig) {
                        if (decoder.state === 'unconfigured') {
                           decoder.configure(metadata.decoderConfig);
                        }
                    }
                    if (decoder.state === 'configured') {
                        decoder.decode(chunk);
                    }
                });
                const t1 = performance.now();
                totalDecodeTime += (t1 - t0);
            },
            error: (e) => console.error('WebCodecs encoder error:', e.message),
        });
        
        await videoEncoder.configure({
            codec: codecString,
            width: videoWidth,
            height: videoHeight,
            bitrate: 1_000_000,
            framerate: 30,
        });
    }

    function handleWebCodecsFrame(frame) {
        totalFrameCopyToWasmTime = 0; // N/A for WebCodecs
        const t2 = performance.now();
        if (videoEncoder.state === 'configured') {
            videoEncoder.encode(frame);
        }
        totalEncodeTime += performance.now() - t2;
    }
    
    // --- Stats Update Function ---
    function updateStatsDisplay() {
        if (!processing) {
            return;
        }
        const numStreams = parseInt(streamCountSelect.value, 10) || 1;

        // Calculate averages over the last second
        const avgOutputFps = outputFrameCount / numStreams;
        const avgEncodeTimeMs = totalEncodeTime / inputFrameCount || 0;
        const avgDecodeTimeMs = totalDecodeTime / outputFrameCount || 0;
        const avgFrameCopyToWasmTimeMs = totalFrameCopyToWasmTime / inputFrameCount || 0;

        // Update DOM elements
        perfEls.inputFps.textContent = inputFrameCount.toFixed(0);
        perfEls.outputFps.textContent = avgOutputFps.toFixed(0);
        perfEls.encodeTime.textContent = avgEncodeTimeMs.toFixed(1);
        perfEls.decodeTime.textContent = totalDecodeTime.toFixed(0);
        perfEls.avgDecodeTime.textContent = avgDecodeTimeMs.toFixed(1);
        perfEls.frameCopyToWasmTime.textContent = avgFrameCopyToWasmTimeMs.toFixed(1);
        
        // Reset counters for the next interval
        inputFrameCount = 0;
        outputFrameCount = 0;
        totalEncodeTime = 0;
        totalFrameCopyToWasmTime = 0;
        totalDecodeTime = 0;
    }


    // --- Event Listeners ---
    startButton.addEventListener('click', () => { (cameraActive) ? stop() : start(); });
    
    resetButton.addEventListener('click', async () => { 
        await stop(); 
        capturedResults = []; 
        machineInfo = null; // Clear cached machine info
        // Clear display text
        cpuInfoEl.textContent = '--';
        ramInfoEl.textContent = '--';
        renderResultsTable(); 
    });

    captureButton.addEventListener('click', async () => {
        if (!processing) {
            return;
        }

        // Fetch and display machine info ONCE on the first capture
        if (!machineInfo) {
            const info = await getMachineInfo();
            cpuInfoEl.textContent = info.cpuCores;
            ramInfoEl.textContent = info.memory;
        }
        
        const threadsDisplay = implementationSelect.value.startsWith('wasm')
            ? decoderWorkers.length 
            : 'N/A';

        capturedResults.push({
            // Test Config
            implementation: implementationSelect.value, 
            resolution: `${videoWidth}x${videoHeight}`, 
            streams: streamCountSelect.value, 
            threads: threadsDisplay,
            // Performance Metrics
            inputFps: perfEls.inputFps.textContent, 
            avgOutputFps: perfEls.outputFps.textContent,
            encodeTime: perfEls.encodeTime.textContent, 
            avgDecodeTime: perfEls.avgDecodeTime.textContent,
            frameCopyToWasmTime: perfEls.frameCopyToWasmTime.textContent,
        });
        renderResultsTable();
    });
    
    downloadResultsButton.addEventListener('click', () => {
        // Now capture the whole results container including the machine info
        if (!resultsContainer) {
            return;
        }

        html2canvas(resultsContainer, {
            backgroundColor: '#1f2937', // A neutral dark background
            scale: 2 // Use a higher scale for better image quality
        }).then(canvas => {
            const link = document.createElement('a');
            link.href = canvas.toDataURL('image/jpeg', 0.9); // Set format and quality
            link.download = 'Wasm-vs-WebCodecs-Results.jpg';
            
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }).catch(err => {
            console.error('Error generating image from table:', err);
        });
    });

    implementationSelect.addEventListener('change', () => {
        threadCountSelect.disabled = !implementationSelect.value.startsWith('wasm');
        if (cameraActive) {
            start();
        }
    });
    resolutionSelect.addEventListener('change', () => { if (cameraActive) { start(); }});
    streamCountSelect.addEventListener('change', () => { if (cameraActive) { start(); }});
    threadCountSelect.addEventListener('change', () => { if (cameraActive) { start(); }});

    function renderResultsTable() {
        const hasResults = capturedResults.length > 0;
        resultsContainer.classList.toggle('hidden', !hasResults);
        downloadResultsButton.classList.toggle('hidden', !hasResults);
        machineInfoDisplay.classList.toggle('hidden', !hasResults);

        resultsBody.innerHTML = '';
        capturedResults.forEach(res => {
            const row = document.createElement('tr');
            row.className = 'bg-gray-900 border-b border-gray-700';
            row.innerHTML = `
                <td class="px-6 py-4">${res.implementation}</td>
                <td class="px-6 py-4">${res.resolution}</td>
                <td class="px-6 py-4">${res.streams}</td>
                <td class="px-6 py-4">${res.threads}</td>
                <td class="px-6 py-4">${res.inputFps}</td>
                <td class="px-6 py-4">${res.avgOutputFps}</td>
                <td class="px-6 py-4">${res.frameCopyToWasmTime}</td>
                <td class="px-6 py-4">${res.encodeTime}</td>
                <td class="px-6 py-4">${res.avgDecodeTime}</td>
            `;
            resultsBody.appendChild(row);
        });
    }

    // --- Global App Object for Automation ---
    window.app = {
        start, stop,
        getStats: () => ({
            inputFps: parseFloat(perfEls.inputFps.textContent),
            avgOutputFps: parseFloat(perfEls.outputFps.textContent),
            avgDecodeTime: parseFloat(perfEls.avgDecodeTime.textContent)
        }),
        setImplementation: (impl) => { implementationSelect.value = impl; threadCountSelect.disabled = !impl.startsWith('wasm'); },
        setResolution: (res) => { resolutionSelect.value = res; },
        setStreams: (streams) => { streamCountSelect.value = streams; },
        setThreads: (threads) => { threadCountSelect.value = threads; },
        isProcessing: () => processing
    };

    // Initial setup
    threadCountSelect.disabled = !implementationSelect.value.startsWith('wasm');
}
