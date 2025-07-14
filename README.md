# Real-Time Video Codec Performance Analyzer

<p align="center">
  <img src="https://path-to-your-project-screenshot.png" alt="Screenshot of the performance analyzer UI" width="800"/>
</p>

For engineers building real-time communication (RTC) and media streaming applications, the choice of video codec implementation is a critical architectural decision. This project provides a powerful, in-browser laboratory likr setup for analyzing the performance trade-offs between two key approaches: a **software-based H.264 codec (OpenH264) compiled to WebAssembly**, and the browser's **native, hardware-accelerated WebCodecs API**.

The application implements a full real-time media pipeline—capturing from a live camera, encoding, and decoding for multiple output streams—allowing to measure performance under various simulated loads. It serves as a practical tool for understanding the complex interplay between CPU load, thread management, and rendering performance in modern web-based media systems.

This project ports [CISCO's openh264](https://github.com/cisco/openh264) codec to WebAssembly using Emscripten. It does not contain the original codec source code.

The demo can be accessed at this [webpage](https://divyanshu-kumar.github.io/openh264-wasm/) or can be opened locally by cloning the project. 

---

## Features

* **Dual Implementation Modes:** Directly compare a Wasm-based software codec against the native `WebCodecs` API.
* **Multi-Threaded Wasm Decoding:** Leverages Web Workers and `pthreads` to offload CPU-intensive decoding from the main UI thread — a common requirement for preventing UI stutters and maintaining responsive call controls during live video sessions.
* **Configurable Workload:** Dynamically adjust key variables to simulate various client device capabilities and network scenarios:
    * **Resolution:** Test from 360p up to 1080p.
    * **Number of Decode Streams:** Simulate a multi-party video call or SFU delivering multiple streams to a single client.
    * **Wasm Thread Count:** Analyze the scalability and overhead of the software decoding pool.
* **Real-Time Performance Metrics:** A detailed stats panel provides live data on critical pipeline stages, including input/output FPS, frame capture latency, and encode/decode latency.
* **Automated Testing & Graphing:** A configurable test runner automates benchmarking, plotting results on dynamically generated charts for clear visualization.
* **Results Capture:** Manually capture the performance metrics of any configuration.

## Architecture Overview

The application is designed to model a real-world client-side media pipeline and highlight modern web performance patterns.

* **Main Thread:** The main thread's responsibilities are handling camera capture and H.264 **encoding**, as this is typically a single, upstream task.
* **Web Workers (for Wasm):** The H.264 **decoding** for multiple downstream streams is offloaded to a configurable pool of Web Workers. This is critical for preventing the main thread from blocking, which is essential for a smooth experience in any RTC application.
* **OffscreenCanvas:** To further optimize performance and isolate the main thread, the Wasm workers render decoded video frames directly to `OffscreenCanvas` objects instead of passing back to main thread.
* **WebCodecs Path:** For comparison, a separate pipeline uses the native `VideoEncoder` and `VideoDecoder` APIs. This path demonstrates the performance ceiling of a modern, GPU-accelerated pipeline and includes intelligent backpressure management to prevent visual stuttering under heavy load.

## Interpreting the Results: An RTC Perspective

* **Input FPS vs. Avg. Output FPS:** This is the most critical comparison.
    * A drop in **Input FPS** indicates that the *main thread* is saturated. In the Wasm implementation, this is often due to the overhead of encoding and copying data for many streams.
    * A drop in **Avg. Output FPS** while the Input FPS remains high suggests that the *decoding or rendering pipeline* is the bottleneck. This is more common in the WebCodecs path when the rendering engine can't keep up.
* **Avg. Decode Time:**
    * For **Wasm**, this is a direct measure of the CPU time spent by a worker thread on decoding.
    * For **WebCodecs**, this number can be deceptively low as it represents highly optimized, often GPU-based, decoding. The true bottleneck appears later in the rendering stage.
* **The Role of Threads (Wasm):** Increasing the thread count should primarily improve the **Input FPS** by reducing the workload on the main thread (as decode tasks are distributed). It does not appear to significantly change the *per-stream* decode time, but it improves the overall system throughput.

## Getting Started

### Prerequisites

* [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html): Required to compile the C++ wrapper to WebAssembly.
* [Python 3](https://www.python.org/downloads/): Required to run the local web server with the necessary security headers.

### Build Instructions

1.  **Clone this project:**
    ```bash
    git clone [https://github.com/divyanshu-kumar/openh264-wasm.git](https://github.com/divyanshu-kumar/openh264-wasm.git)
    cd openh264-wasm
    ```

2.  **Clone the OpenH264 library:**
    ```bash
    git clone [https://github.com/cisco/openh264.git](https://github.com/cisco/openh264.git)
    ```

3.  **Build the OpenH264 static library:**
    * Navigate into the `openh264` directory.
    * Run the make command with Emscripten's compiler.
    ```bash
    cd openh264
    make libopenh264.a CC=emcc CXX=em++ ARCH=wasm
    cd ..
    ```

4.  **Build the Wasm Wrapper:**
    * This project's `Makefile` is configured to build the multi-threaded (pthreads) version by default, which is required for the Web Worker implementation.
    ```bash
    make
    ```
    *This will execute an `emcc` command to build the openh264_wrapper.cpp with the libopenh264.a library.*

5.  **Start the Server:**
    * The multi-threaded version requires specific `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers to enable `SharedArrayBuffer`. A simple Python server is included for this purpose.
    ```bash
    python3 server.py
    ```

6.  **Open the Application:**
    * Navigate to `http://localhost:8000` - chrome, safari and firefox are tested and work well.

## How to Use

1.  **Start/Stop Camera:** Toggles the camera feed and begins processing.
2.  **Reset:** Stops the camera and resets all controls and captured results to their default state.
3.  **Capture Results:** Adds the current performance metrics to the "Captured Results" table.
4.  **Configure & Run Tests:** Opens a modal to select specific scenarios for automated testing. The results will be plotted in dynamically generated graphs.
5.  **Controls:** Use the dropdowns to select the `Implementation`, `Resolution`, `Streams`, and `Threads` (for Wasm only) to test. Changes are applied automatically when the camera is running.

## License

This project is licensed under the GNU General Public License v3.0. See the [LICENSE](LICENSE) file for details.
