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
    
    // Performance Stat Elements
    const captureTimeEl = document.getElementById('captureTime');
    const encodeTimeEl = document.getElementById('encodeTime');
    const decodeTimeEl = document.getElementById('decodeTime');
    const avgDecodeTimeEl = document.getElementById('avgDecodeTime');
    const inputFpsEl = document.getElementById('inputFps');
    const outputFpsEl = document.getElementById('outputFps');

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

    // FPS calculation state
    let lastFpsTime = 0;
    let inputFrameCount = 0;
    let outputFrameCount = 0;
    let totalDecodeTimeForFps = 0;
    
    // --- URL Parameter Handling ---
    const urlParams = new URLSearchParams(window.location.search);
    const defaultResolution = urlParams.get('res') || "854x480";
    const defaultStreams = urlParams.get('streams') || "1";
    const defaultThreads = urlParams.get('threads') || "1";

    // --- Populate Dropdowns ---
    const resolutions = {
        "360p": { width: 640, height: 360 }, "480p": { width: 854, height: 480 },
        "720p": { width: 1280, height: 720 }, "1080p": { width: 1920, height: 1080 },
    };
    for (const [label, res] of Object.entries(resolutions)) {
        const option = document.createElement('option');
        option.value = `${res.width}x${res.height}`;
        option.textContent = `${label} (${res.width}x${res.height})`;
        resolutionSelect.appendChild(option);
    }
    for (let i = 1; i <= 32; i++) {
        streamCountSelect.appendChild(new Option(i, i));
    }
    for (let i = 1; i <= (navigator.hardwareConcurrency || 8); i++) {
        threadCountSelect.appendChild(new Option(i, i));
    }
    resolutionSelect.value = defaultResolution;
    streamCountSelect.value = defaultStreams;
    threadCountSelect.value = defaultThreads;

    // --- C++ Function Wrappers (Main Thread Only) ---
    const initEncoder = Module.cwrap('init_encoder', 'number', ['number', 'number', 'number']);
    const forceKeyFrame = Module.cwrap('force_key_frame', null, []);
    const encodeFrame = Module.cwrap('encode_frame', null, ['number', 'number', 'number', 'number', 'number']);
    const freeBuffer = Module.cwrap('free_buffer', null, ['number']);

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
        inputVideo.srcObject = null;
        outputContainer.innerHTML = '';
        statusEl.textContent = 'Status: Idle';
        startButton.textContent = 'Start Camera';
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    async function start() {
        if (cameraActive) await stop();
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
                tempCanvas = document.createElement('canvas');
                tempCanvas.width = videoWidth;
                tempCanvas.height = videoHeight;
                tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
                console.log(`Video dimensions set: ${videoWidth}x${videoHeight}`);
                r();
            }});

            await inputVideo.play();
            console.log("Video is playing.");

            statusEl.textContent = 'Status: Initializing Codecs & Workers...';
            if (initEncoder(videoWidth, videoHeight, 1000000) !== 0) throw new Error('Encoder init failed.');
            
            await reconfigureWorkersAndCanvases();

            startButton.textContent = 'Stop Camera';

        } catch (error) {
            console.error('Error during setup:', error);
            statusEl.textContent = `Error: ${error.message}`;
            await stop();
        }
    }
    
    async function reconfigureWorkersAndCanvases() {
        processing = false; // Pause the loop
        await new Promise(r => setTimeout(r, 50)); // Give loop time to pause

        return new Promise((resolve, reject) => {
            const numThreads = parseInt(threadCountSelect.value, 10);
            workers.forEach(w => w.terminate());
            workers = [];
            
            let readyCount = 0;
            let initDoneCount = 0;
            console.log(`Setting up ${numThreads} worker threads...`);

            if (numThreads === 0) {
                console.warn("No worker threads selected.");
                return resolve();
            }

            for (let i = 0; i < numThreads; i++) {
                const worker = new Worker('scripts/decoder_worker.js');
                worker.postMessage({ type: 'set_id', id: i });
                
                worker.onerror = (err) => reject(new Error(`Worker error: ${err.message}`));
                worker.onmessage = (e) => {
                    const { type } = e.data;
                    if (type === 'ready') {
                        readyCount++;
                        if (readyCount === numThreads) {
                            console.log("All workers ready. Broadcasting init command...");
                            workers.forEach(w => w.postMessage({ type: 'init' }));
                        }
                    } else if (type === 'init_done') {
                        initDoneCount++;
                        if (initDoneCount === numThreads) {
                            console.log("All workers have initialized the decoder pool.");
                            setupCanvases();
                            processing = true;
                            requestAnimationFrame(processLoop);
                            resolve();
                        }
                    } else if (type === 'decoded') {
                        outputFrameCount++;
                        totalDecodeTimeForFps += e.data.decodeTime;
                    }
                };
                workers.push(worker);
            }
        });
    }

    function setupCanvases() {
        const numStreams = parseInt(streamCountSelect.value, 10);
        const numThreads = workers.length;
        if (numThreads === 0) return;

        outputContainer.innerHTML = '';
        console.log(`Creating ${numStreams} canvases and distributing to ${numThreads} threads...`);

        let canvases = [];
        for (let j = 0; j < numStreams; j++) {
            const canvas = document.createElement('canvas');
            outputContainer.appendChild(canvas);
            canvas.width = videoWidth;
            canvas.height = videoHeight;
            const offscreen = canvas.transferControlToOffscreen();
            canvases.push(offscreen);
        }

        for (let j = 0; j < numStreams; j++) {
            const workerIndex = j % numThreads;
            workers[workerIndex].postMessage({
                type: 'set_canvas',
                canvas: canvases[j],
                streamIndex: j,
            }, [canvases[j]]);
        }
        forceKeyFrame();
    }
    
    function processLoop() {
        if (!processing || workers.length === 0) return;

        const now = performance.now();
        const delta = now - lastFpsTime;
        if (delta >= 1000) {
            const numStreams = parseInt(streamCountSelect.value, 10) || 1;
            inputFpsEl.textContent = (inputFrameCount / (delta / 1000)).toFixed(1);
            const avgOutputFramesPerSecond = (outputFrameCount / numStreams) / (delta / 1000);
            outputFpsEl.textContent = avgOutputFramesPerSecond.toFixed(1);
            decodeTimeEl.textContent = totalDecodeTimeForFps.toFixed(2);
            avgDecodeTimeEl.textContent = (totalDecodeTimeForFps / outputFrameCount || 0).toFixed(2);
            lastFpsTime = now;
            inputFrameCount = 0;
            outputFrameCount = 0;
            totalDecodeTimeForFps = 0;
        }
        inputFrameCount++;

        const t0 = performance.now();
        tempCtx.drawImage(inputVideo, 0, 0, videoWidth, videoHeight);
        const imageData = tempCtx.getImageData(0, 0, videoWidth, videoHeight);
        const rgbaData = imageData.data;
        const t1 = performance.now();
        captureTimeEl.textContent = `${(t1 - t0).toFixed(2)}`;

        const rgbaBufferPtr = Module._malloc(rgbaData.length);
        HEAPU8.set(rgbaData, rgbaBufferPtr);
        const encodedDataPtr_ptr = Module._malloc(4);
        const encodedSize_ptr = Module._malloc(4);
        const t2 = performance.now();
        encodeFrame(rgbaBufferPtr, videoWidth, videoHeight, encodedDataPtr_ptr, encodedSize_ptr);
        const t3 = performance.now();
        encodeTimeEl.textContent = `${(t3 - t2).toFixed(2)}`;
        Module._free(rgbaBufferPtr);
        
        const encodedDataPtr = Module.getValue(encodedDataPtr_ptr, 'i32');
        const encodedSize = Module.getValue(encodedSize_ptr, 'i32');
        Module._free(encodedDataPtr_ptr);
        Module._free(encodedSize_ptr);
        
        if (encodedSize > 0) {
            const encodedDataCopy = HEAPU8.slice(encodedDataPtr, encodedDataPtr + encodedSize);
            freeBuffer(encodedDataPtr);
            
            const numStreams = parseInt(streamCountSelect.value, 10);
            for (let i = 0; i < numStreams; i++) {
                const workerIndex = i % workers.length;
                const worker = workers[workerIndex];
                worker.postMessage({
                    type: 'decode',
                    streamIndex: i,
                    encodedData: encodedDataCopy.buffer.slice(0)
                });
            }
        } else {
            if (encodedDataPtr) freeBuffer(encodedDataPtr);
        }

        requestAnimationFrame(processLoop);
    }
    
    // --- Event Listeners ---
    startButton.addEventListener('click', () => { (cameraActive) ? stop() : start(); });
    resetButton.addEventListener('click', async () => { await stop(); capturedResults = []; renderResultsTable(); });
    captureButton.addEventListener('click', () => {
        if (!processing) return;
        capturedResults.push({
            resolution: `${videoWidth}x${videoHeight}`, streams: streamCountSelect.value,
            threads: threadCountSelect.value, inputFps: inputFpsEl.textContent,
            avgOutputFps: outputFpsEl.textContent, encodeTime: encodeTimeEl.textContent,
            avgDecodeTime: avgDecodeTimeEl.textContent,
        });
        renderResultsTable();
    });
    
    streamCountSelect.addEventListener('change', () => {
        if (processing) {
            setupCanvases();
        }
    });
    threadCountSelect.addEventListener('change', () => {
        if (processing) {
            reconfigureWorkersAndCanvases();
        }
    });
    resolutionSelect.addEventListener('change', () => {
        if (cameraActive) {
            start();
        }
    });

    function renderResultsTable() {
        resultsContainer.classList.toggle('hidden', capturedResults.length === 0);
        resultsBody.innerHTML = '';
        capturedResults.forEach(res => {
            const row = document.createElement('tr');
            row.className = 'bg-gray-900 border-b border-gray-700';
            row.innerHTML = `
                <td class="px-6 py-4">${res.resolution}</td>
                <td class="px-6 py-4">${res.streams}</td>
                <td class="px-6 py-4">${res.threads}</td>
                <td class="px-6 py-4">${res.inputFps}</td>
                <td class="px-6 py-4">${res.avgOutputFps}</td>
                <td class="px-6 py-4">${res.encodeTime}</td>
                <td class="px-6 py-4">${res.avgDecodeTime}</td>
            `;
            resultsBody.appendChild(row);
        });
    }

    // --- Global App Object for Automation ---
    // Expose key functions and state to the automation script.
    window.app = {
        start,
        stop,
        getStats: () => ({
            inputFps: parseFloat(inputFpsEl.textContent),
            avgOutputFps: parseFloat(outputFpsEl.textContent),
            avgDecodeTime: parseFloat(avgDecodeTimeEl.textContent)
        }),
        setResolution: (res) => { resolutionSelect.value = res; },
        setStreams: (streams) => { streamCountSelect.value = streams; },
        setThreads: (threads) => { threadCountSelect.value = threads; },
        isProcessing: () => processing
    };
}
