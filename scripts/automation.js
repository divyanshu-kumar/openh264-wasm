document.addEventListener('DOMContentLoaded', () => {
    const startAutoTestButton = document.getElementById('startAutoTestButton');
    const statusEl = document.getElementById('status');
    const chartsArea = document.getElementById('chartsArea');

    const testScenarios = {
        streams: [1, 4, 8, 32],
        threads: [1, 2, 4, 8],
        resolutions: ["640x360", "854x480", "1280x720"]
    };

    function createChartGroup(threadCount) {
        const groupContainer = document.createElement('div');
        groupContainer.innerHTML = `
            <h2 class="text-2xl font-bold mb-4 text-center text-white">Results for ${threadCount} Thread(s)</h2>
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
                <div class="chart-container">
                    <canvas id="fpsChart-${threadCount}"></canvas>
                </div>
                <div class="chart-container">
                    <canvas id="decodeTimeChart-${threadCount}"></canvas>
                </div>
            </div>
        `;
        chartsArea.appendChild(groupContainer);

        const fpsCtx = document.getElementById(`fpsChart-${threadCount}`).getContext('2d');
        const fpsChart = new Chart(fpsCtx, {
            type: 'line',
            data: { labels: testScenarios.resolutions, datasets: [] },
            options: {
                responsive: true,
                plugins: {
                    title: { display: true, text: 'Avg. Output FPS vs. Resolution', color: 'white' },
                    legend: { labels: { color: 'white' } }
                },
                scales: {
                    x: { ticks: { color: 'white' }, grid: { color: 'rgba(255,255,255,0.1)' } },
                    y: { ticks: { color: 'white' }, grid: { color: 'rgba(255,255,255,0.1)' }, title: { display: true, text: 'Avg. Output FPS', color: 'white' } }
                }
            }
        });

        const decodeTimeCtx = document.getElementById(`decodeTimeChart-${threadCount}`).getContext('2d');
        const decodeTimeChart = new Chart(decodeTimeCtx, {
            type: 'line',
            data: { labels: testScenarios.resolutions, datasets: [] },
            options: {
                responsive: true,
                plugins: {
                    title: { display: true, text: 'Avg. Decode Time vs. Resolution', color: 'white' },
                    legend: { labels: { color: 'white' } }
                },
                scales: {
                    x: { ticks: { color: 'white' }, grid: { color: 'rgba(255,255,255,0.1)' } },
                    y: { ticks: { color: 'white' }, grid: { color: 'rgba(255,255,255,0.1)' }, title: { display: true, text: 'Avg. Decode Time (ms)', color: 'white' } }
                }
            }
        });

        return { fpsChart, decodeTimeChart };
    }

    function addDataToCharts(charts, label, fpsData, decodeTimeData) {
        const color = `hsl(${charts.fpsChart.data.datasets.length * 60}, 70%, 60%)`;
        charts.fpsChart.data.datasets.push({
            label: label,
            data: fpsData,
            borderColor: color,
            backgroundColor: color,
            fill: false,
            tension: 0.1
        });
        charts.decodeTimeChart.data.datasets.push({
            label: label,
            data: decodeTimeData,
            borderColor: color,
            backgroundColor: color,
            fill: false,
            tension: 0.1
        });
        charts.fpsChart.update();
        charts.decodeTimeChart.update();
    }

    async function runTest(config) {
        const { threads, streams, resolution } = config;
        statusEl.textContent = `Testing: ${resolution}, ${streams} streams, ${threads} threads...`;
        
        window.app.setResolution(resolution);
        window.app.setStreams(streams);
        window.app.setThreads(threads);

        await window.app.start();

        // Wait for stats to stabilize
        await new Promise(resolve => setTimeout(resolve, 5000)); 

        const stats = window.app.getStats();
        console.log(`Result for ${JSON.stringify(config)}:`, stats);
        
        // No need to stop between tests of the same thread count
        return stats;
    }

    startAutoTestButton.addEventListener('click', async () => {
        if (window.app.isProcessing()) {
            alert("Please stop the camera before starting automated tests.");
            return;
        }

        chartsArea.innerHTML = ''; // Clear previous charts
        chartsArea.classList.remove('hidden');
        startAutoTestButton.disabled = true;
        startAutoTestButton.textContent = 'Testing...';

        for (const threadCount of testScenarios.threads) {
            const charts = createChartGroup(threadCount);
            
            for (const streamCount of testScenarios.streams) {
                let fpsResults = [];
                let decodeTimeResults = [];
                const label = `${streamCount} streams`;

                for (const resolution of testScenarios.resolutions) {
                    const stats = await runTest({ threads: threadCount, streams: streamCount, resolution });
                    fpsResults.push(stats.avgOutputFps);
                    decodeTimeResults.push(stats.avgDecodeTime);
                }
                addDataToCharts(charts, label, fpsResults, decodeTimeResults);
            }
        }
        
        await window.app.stop();
        statusEl.textContent = 'Testing complete!';
        startAutoTestButton.disabled = false;
        startAutoTestButton.textContent = 'Run Performance Tests';
    });
});
