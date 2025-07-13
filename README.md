# openh264-wasm
openh264-wasm : A WebAssembly port of openh264; a WASM wrapper around the openh264 codec which supports H.264 encoding and decoding.

This project port [CISCO's openh264](https://github.com/cisco/openh264) codec to WebAssembly using Emscripten. It does not contain the original codec source code. 

To compile the project locally : 
1. Clone this project: 
```
git clone https://github.com/divyanshu-kumar/openh264-wasm.git
```

2. Clone the openh264 project in this project's directory:
```
cd openh264-wasm && git clone https://github.com/cisco/openh264.git
```

3. Build openh264 with em: 
```
cd openh264 && make libopenh264.a CC=emcc CXX=em++ ARCH=wasm
```

4. Build the wasm wrapper around openh264:
```
cd ../ && make 
```

5. Start the server :
```
python3 server.py
```

6. Go to the address pointed by the server script in any browser. 