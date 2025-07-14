document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements for Automation ---
    const configureTestsButton = document.getElementById('configureTestsButton');
    const testConfigModal = document.getElementById('testConfigModal');
    const runSelectedTestsButton = document.getElementById('runSelectedTestsButton');
    const cancelTestButton = document.getElementById('cancelTestButton');
    const statusEl = document.getElementById('status');
    const chartsArea = document.getElementById('chartsArea');

    // --- Checkbox Containers ---
    const implCheckboxes = document.getElementById('implCheckboxes');
    const resCheckboxes = document.getElementById('resCheckboxes');
    const streamCheckboxes = document.getElementById('streamCheckboxes');
    const threadCheckboxes = document.getElementById('threadCheckboxes');

    // --- Chart Management ---
    let charts = {};

    function createChartGroup(title, resolutions) {
        const groupId = title.replace(/[^a-zA-Z0-9]/g, '');
        const groupContainer = document.createElement('div');
        groupContainer.innerHTML = `
            <h2 class="text-2xl font-bold mb-4 text-center text-white">${title}</h2>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div class="chart-container">
                    <canvas id="fpsChart-${groupId}"></canvas>
                </div>
                <div class="chart-container">
                    <canvas id="decodeTimeChart-${groupId}"></canvas>
                </div>
            </div>
        `;
        chartsArea.appendChild(groupContainer);

        const commonOptions = {
            responsive: true,
            plugins: { legend: { labels: { color: 'white' } } },
            scales: {
                x: { title: { display: true, text: 'Resolution', color: 'white' }, ticks: { color: 'white' }, grid: { color: 'rgba(255,255,255,0.1)' } },
                y: { ticks: { color: 'white' }, grid: { color: 'rgba(255,255,255,0.1)' } }
            }
        };

        const fpsCtx = document.getElementById(`fpsChart-${groupId}`).getContext('2d');
        const fpsChart = new Chart(fpsCtx, {
            type: 'line',
            data: { labels: resolutions, datasets: [] },
            options: { ...commonOptions, plugins: { ...commonOptions.plugins, title: { display: true, text: 'Avg. Output FPS vs. Resolution', color: 'white' } }, scales: { ...commonOptions.scales, y: { ...commonOptions.scales.y, title: { display: true, text: 'Avg. Output FPS', color: 'white' } } } }
        });

        const decodeTimeCtx = document.getElementById(`decodeTimeChart-${groupId}`).getContext('2d');
        const decodeTimeChart = new Chart(decodeTimeCtx, {
            type: 'line',
            data: { labels: resolutions, datasets: [] },
            options: { ...commonOptions, plugins: { ...commonOptions.plugins, title: { display: true, text: 'Avg. Decode Time vs. Resolution', color: 'white' } }, scales: { ...commonOptions.scales, y: { ...commonOptions.scales.y, title: { display: true, text: 'Avg. Decode Time (ms)', color: 'white' } } } }
        });

        return { fpsChart, decodeTimeChart };
    }

    function addDataToCharts(chartInstance, label, data, color) {
        chartInstance.data.datasets.push({
            label: label, data: data, borderColor: color, backgroundColor: color,
            fill: false, tension: 0.1
        });
        chartInstance.update();
    }

    // --- Test Execution ---
    async function runTest(config) {
        const { implementation, threads, streams, resolution } = config;
        statusEl.textContent = `Testing: ${implementation}, ${resolution}, ${streams} streams, ${threads || 'N/A'} threads...`;
        
        window.app.setImplementation(implementation);
        window.app.setResolution(resolution);
        window.app.setStreams(streams);
        if (implementation === 'wasm') {
            window.app.setThreads(threads);
        }

        await window.app.start();
        await new Promise(resolve => setTimeout(resolve, 5000)); 
        const stats = window.app.getStats();
        console.log(`Result for ${JSON.stringify(config)}:`, stats);
        await window.app.stop();
        await new Promise(resolve => setTimeout(resolve, 1000)); 
        return stats;
    }

    // --- Event Listeners ---
    configureTestsButton.addEventListener('click', () => {
        testConfigModal.classList.remove('hidden');
    });

    cancelTestButton.addEventListener('click', () => {
        testConfigModal.classList.add('hidden');
    });

    runSelectedTestsButton.addEventListener('click', async () => {
        if (window.app.isProcessing()) {
            alert("Please stop the camera before starting automated tests.");
            return;
        }
        testConfigModal.classList.add('hidden');
        chartsArea.innerHTML = ''; 
        chartsArea.classList.remove('hidden');
        runSelectedTestsButton.disabled = true;
        runSelectedTestsButton.textContent = 'Testing...';

        // Build the test plan dynamically from checkboxes.
        const getCheckedValues = (container) => 
            [...container.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);

        const selectedImplementations = getCheckedValues(implCheckboxes);
        const selectedResolutions = getCheckedValues(resCheckboxes);
        const selectedStreams = getCheckedValues(streamCheckboxes).map(Number);
        const selectedThreads = getCheckedValues(threadCheckboxes).map(Number);

        // --- Run WebCodecs Tests ---
        if (selectedImplementations.includes('webcodecs')) {
            const charts = createChartGroup('Native - WebCodecs', selectedResolutions);
            for (const streamCount of selectedStreams) {
                let fpsResults = [];
                let decodeTimeResults = [];
                for (const resolution of selectedResolutions) {
                    const stats = await runTest({ implementation: 'webcodecs', streams: streamCount, resolution });
                    fpsResults.push(stats.avgOutputFps);
                    decodeTimeResults.push(stats.avgDecodeTime);
                }
                const color = `hsl(${streamCount * 20}, 70%, 60%)`;
                addDataToCharts(charts.fpsChart, `${streamCount} streams`, fpsResults, color);
                addDataToCharts(charts.decodeTimeChart, `${streamCount} streams`, decodeTimeResults, color);
            }
        }
        
        // --- Run Wasm Tests ---
        if (selectedImplementations.includes('wasm')) {
            for (const threadCount of selectedThreads) {
                const charts = createChartGroup(`Wasm - ${threadCount} Thread(s)`, selectedResolutions);
                for (const streamCount of selectedStreams) {
                    let fpsResults = [];
                    let decodeTimeResults = [];
                    for (const resolution of selectedResolutions) {
                        const stats = await runTest({ implementation: 'wasm', threads: threadCount, streams: streamCount, resolution });
                        fpsResults.push(stats.avgOutputFps);
                        decodeTimeResults.push(stats.avgDecodeTime);
                    }
                    const color = `hsl(${streamCount * 20}, 70%, 60%)`;
                    addDataToCharts(charts.fpsChart, `${streamCount} streams`, fpsResults, color);
                    addDataToCharts(charts.decodeTimeChart, `${streamCount} streams`, decodeTimeResults, color);
                }
            }
        }
        
        statusEl.textContent = 'Testing complete!';
        runSelectedTestsButton.disabled = false;
        runSelectedTestsButton.textContent = 'Start Selected Tests';
    });
});
