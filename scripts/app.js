// Wait for the Emscripten module to be ready.
Module.onRuntimeInitialized = () => {
    console.log('Wasm module and heap are ready.');
    main();
};

function main() {
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
        captureTime: document.getElementById('captureTime'),
        encodeTime: document.getElementById('encodeTime'),
        decodeTime: document.getElementById('decodeTime'),
        avgDecodeTime: document.getElementById('avgDecodeTime'),
        inputFps: document.getElementById('inputFps'),
        outputFps: document.getElementById('outputFps'),
    };

    // Results Table Elements
    const resultsContainer = document.getElementById('resultsContainer');
    const resultsBody = document.getElementById('resultsBody');

    // --- State ---
    let processing = false;
    let cameraActive = false;
    let videoWidth, videoHeight;
    let tempCanvas, tempCtx;
    let mediaStream = null;
    let capturedResults = [];
    let workers = [];
    let lastWorkerIndex = 0;
    
    // WebCodecs State
    let videoEncoder, decoders = [];

    // FPS calculation state
    let lastFpsTime = 0;
    let inputFrameCount = 0;
    let outputFrameCount = 0;
    let totalDecodeTimeForFps = 0;
    
    // --- URL Parameter Handling ---
    const urlParams = new URLSearchParams(window.location.search);
    const defaultImplementation = urlParams.get('impl') || 'wasm';
    const defaultResolution = urlParams.get('res') || "854x480";
    const defaultStreams = urlParams.get('streams') || "1";
    const defaultThreads = urlParams.get('threads') || "1";

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
    for (let i = 1; i <= (navigator.hardwareConcurrency || 8); i++) {
        threadCountSelect.appendChild(new Option(i, i));
    }
    implementationSelect.value = defaultImplementation;
    resolutionSelect.value = defaultResolution;
    streamCountSelect.value = defaultStreams;
    threadCountSelect.value = defaultThreads;
    
    // --- C++ Function Wrappers ---
    const initEncoderWasm = Module.cwrap('init_encoder', 'number', ['number', 'number', 'number']);
    const forceKeyFrameWasm = Module.cwrap('force_key_frame', null, []);
    const encodeFrameWasm = Module.cwrap('encode_frame', null, ['number', 'number', 'number', 'number', 'number']);
    const freeBufferWasm = Module.cwrap('free_buffer', null, ['number']);

    // --- Main Control Logic ---
    async function stop() {
        if (!cameraActive) return;
        console.log("Stopping current stream...");
        processing = false;
        cameraActive = false;
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }
        workers.forEach(w => w.terminate());
        workers = [];
        if (videoEncoder && videoEncoder.state !== 'closed') videoEncoder.close();
        decoders.forEach(d => { if (d.state !== 'closed') d.close(); });
        decoders = [];
        inputVideo.srcObject = null;
        outputContainer.innerHTML = '';
        statusEl.textContent = 'Status: Idle';
        startButton.textContent = 'Start Camera';
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    async function start() {
        await stop();
        try {
            statusEl.textContent = 'Status: Starting...';
            const [w, h] = resolutionSelect.value.split('x').map(Number);
            const constraints = { video: { width: { ideal: w }, height: { ideal: h } } };
            
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
            
            lastFpsTime = performance.now();
            inputFrameCount = 0;
            outputFrameCount = 0;
            totalDecodeTimeForFps = 0;

            if (implementationSelect.value === 'wasm') {
                await startWasm();
            } else {
                await startWebCodecs();
            }

            startButton.textContent = 'Stop Camera';

        } catch (error) {
            console.error('Error during setup:', error);
            statusEl.textContent = `Error: ${error.message}`;
            await stop();
        }
    }

    // --- Wasm Implementation ---
    async function startWasm() {
        tempCanvas = document.createElement('canvas');
        tempCanvas.width = videoWidth;
        tempCanvas.height = videoHeight;
        tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
        if (initEncoderWasm(videoWidth, videoHeight, 1000000) !== 0) throw new Error('Wasm Encoder init failed.');
        await reconfigureWorkersAndCanvases();
    }

    async function reconfigureWorkersAndCanvases() {
        processing = false;
        await new Promise(r => setTimeout(r, 50));
        return new Promise((resolve, reject) => {
            const numThreads = parseInt(threadCountSelect.value, 10);
            workers.forEach(w => w.terminate());
            workers = [];
            let readyCount = 0, initDoneCount = 0;
            if (numThreads === 0) return resolve();
            for (let i = 0; i < numThreads; i++) {
                const worker = new Worker('scripts/decoder_worker.js');
                worker.postMessage({ type: 'set_id', id: i });
                worker.onerror = (err) => reject(new Error(`Worker error: ${err.message}`));
                worker.onmessage = (e) => {
                    if (e.data.type === 'ready') {
                        if (++readyCount === numThreads) workers.forEach(w => w.postMessage({ type: 'init' }));
                    } else if (e.data.type === 'init_done') {
                        if (++initDoneCount === numThreads) {
                            setupCanvasesWasm();
                            processing = true;
                            requestAnimationFrame(processLoopWasm);
                            resolve();
                        }
                    } else if (e.data.type === 'decoded') {
                        outputFrameCount++;
                        totalDecodeTimeForFps += e.data.decodeTime;
                    }
                };
                workers.push(worker);
            }
        });
    }

    function setupCanvasesWasm() {
        const numStreams = parseInt(streamCountSelect.value, 10);
        const numThreads = workers.length;
        if (numThreads === 0) return;
        outputContainer.innerHTML = '';
        let canvases = [];
        for (let j = 0; j < numStreams; j++) {
            const canvas = document.createElement('canvas');
            outputContainer.appendChild(canvas);
            canvas.width = videoWidth;
            canvas.height = videoHeight;
            canvases.push(canvas.transferControlToOffscreen());
        }
        for (let j = 0; j < numStreams; j++) {
            workers[j % numThreads].postMessage({
                type: 'set_canvas', canvas: canvases[j], streamIndex: j,
            }, [canvases[j]]);
        }
        forceKeyFrameWasm();
    }

    function processLoopWasm() {
        if (!processing) return;
        updateFps();
        const t0 = performance.now();
        tempCtx.drawImage(inputVideo, 0, 0, videoWidth, videoHeight);
        const imageData = tempCtx.getImageData(0, 0, videoWidth, videoHeight);
        const rgbaData = imageData.data;
        perfEls.captureTime.textContent = (performance.now() - t0).toFixed(2);
        const rgbaBufferPtr = Module._malloc(rgbaData.length);
        HEAPU8.set(rgbaData, rgbaBufferPtr);
        const encodedDataPtr_ptr = Module._malloc(4);
        const encodedSize_ptr = Module._malloc(4);
        const t2 = performance.now();
        encodeFrameWasm(rgbaBufferPtr, videoWidth, videoHeight, encodedDataPtr_ptr, encodedSize_ptr);
        perfEls.encodeTime.textContent = (performance.now() - t2).toFixed(2);
        Module._free(rgbaBufferPtr);
        const encodedDataPtr = Module.getValue(encodedDataPtr_ptr, 'i32');
        const encodedSize = Module.getValue(encodedSize_ptr, 'i32');
        Module._free(encodedDataPtr_ptr);
        Module._free(encodedSize_ptr);
        if (encodedSize > 0) {
            const encodedDataCopy = HEAPU8.slice(encodedDataPtr, encodedDataPtr + encodedSize);
            freeBufferWasm(encodedDataPtr);
            const numStreams = parseInt(streamCountSelect.value, 10);
            for (let i = 0; i < numStreams; i++) {
                workers[i % workers.length].postMessage({
                    type: 'decode', streamIndex: i, encodedData: encodedDataCopy.buffer.slice(0)
                });
            }
        } else if (encodedDataPtr) freeBufferWasm(encodedDataPtr);
        requestAnimationFrame(processLoopWasm);
    }

    // --- WebCodecs Implementation ---
    function getWebCodecString(width, height) {
        // Baseline Profile, Level 3.0 for SD resolutions
        if (width * height <= 640 * 480) return 'avc1.42E01E';
        // Main Profile, Level 3.1 for 720p
        if (width * height <= 1280 * 720) return 'avc1.4D401F';
        // High Profile, Level 4.1 for 1080p
        if (width * height <= 1920 * 1080) return 'avc1.640028';
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
                    decoder.decode(chunk);
                });
                const t1 = performance.now();
                totalDecodeTimeForFps += (t1 - t0);
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
        
        processing = true;
        inputVideo.requestVideoFrameCallback(processFrameWebCodecs);
    }

    function processFrameWebCodecs(now, metadata) {
        if (!processing) return;
        updateFps(metadata.mediaTime);
        const frame = new VideoFrame(inputVideo, { timestamp: metadata.mediaTime * 1000000 });
        perfEls.captureTime.textContent = (performance.now() - now).toFixed(2);
        const t2 = performance.now();
        videoEncoder.encode(frame);
        perfEls.encodeTime.textContent = (performance.now() - t2).toFixed(2);
        frame.close();
        inputVideo.requestVideoFrameCallback(processFrameWebCodecs);
    }
    
    // --- Shared Functions ---
    function updateFps(mediaTime) {
        const now = performance.now();
        const delta = now - lastFpsTime;
        if (delta >= 1000) {
            const numStreams = parseInt(streamCountSelect.value, 10) || 1;
            perfEls.inputFps.textContent = (inputFrameCount / (delta / 1000)).toFixed(1);
            const avgOutputFramesPerSecond = (outputFrameCount / numStreams) / (delta / 1000);
            perfEls.outputFps.textContent = avgOutputFramesPerSecond.toFixed(1);
            perfEls.decodeTime.textContent = totalDecodeTimeForFps.toFixed(2);
            perfEls.avgDecodeTime.textContent = (totalDecodeTimeForFps / outputFrameCount || 0).toFixed(2);
            lastFpsTime = now;
            inputFrameCount = 0;
            outputFrameCount = 0;
            totalDecodeTimeForFps = 0;
        }
        inputFrameCount++;
    }

    // --- Event Listeners ---
    startButton.addEventListener('click', () => { (cameraActive) ? stop() : start(); });
    resetButton.addEventListener('click', async () => { await stop(); capturedResults = []; renderResultsTable(); });
    captureButton.addEventListener('click', () => {
        if (!processing) return;
        capturedResults.push({
            implementation: implementationSelect.value, resolution: `${videoWidth}x${videoHeight}`, 
            streams: streamCountSelect.value, threads: threadCountSelect.value,
            inputFps: perfEls.inputFps.textContent, avgOutputFps: perfEls.outputFps.textContent,
            encodeTime: perfEls.encodeTime.textContent, avgDecodeTime: perfEls.avgDecodeTime.textContent,
        });
        renderResultsTable();
    });
    
    implementationSelect.addEventListener('change', () => {
        threadCountSelect.disabled = implementationSelect.value === 'webcodecs';
        if (cameraActive) start();
    });
    resolutionSelect.addEventListener('change', () => { if (cameraActive) start(); });
    streamCountSelect.addEventListener('change', () => { if (cameraActive) start(); });
    threadCountSelect.addEventListener('change', () => { if (cameraActive) start(); });

    function renderResultsTable() {
        resultsContainer.classList.toggle('hidden', capturedResults.length === 0);
        resultsBody.innerHTML = '';
        capturedResults.forEach(res => {
            const row = document.createElement('tr');
            row.className = 'bg-gray-900 border-b border-gray-700';
            row.innerHTML = `
                <td class="px-6 py-4">${res.implementation}</td>
                <td class="px-6 py-4">${res.resolution}</td>
                <td class="px-6 py-4">${res.streams}</td>
                <td class="px-6 py-4">${res.implementation === 'wasm' ? res.threads : 'N/A'}</td>
                <td class="px-6 py-4">${res.inputFps}</td>
                <td class="px-6 py-4">${res.avgOutputFps}</td>
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
        setImplementation: (impl) => { implementationSelect.value = impl; threadCountSelect.disabled = impl === 'webcodecs'; },
        setResolution: (res) => { resolutionSelect.value = res; },
        setStreams: (streams) => { streamCountSelect.value = streams; },
        setThreads: (threads) => { threadCountSelect.value = threads; },
        isProcessing: () => processing
    };

    // Initial setup
    threadCountSelect.disabled = implementationSelect.value === 'webcodecs';
}
