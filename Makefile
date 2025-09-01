.PHONY: all clean

# Emscripten Compiler
EMCC = emcc

# Source files
WRAPPER_SRC = openh264_wrapper.cpp
OPENH264_LIB = openh264/libopenh264.a

# Output
OUTPUT_JS = scripts/h264.js
OUTPUT_WASM = scripts/h264.wasm

# Include paths
INCLUDES = -I openh264/codec/api/wels/

# Emscripten flags
EMCC_FLAGS = \
	-s USE_PTHREADS=1 \
	-s WASM=1 \
	-s EXPORTED_FUNCTIONS="['_malloc','_free']" \
	-s EXPORTED_RUNTIME_METHODS="['cwrap','getValue']" \
	-s ALLOW_MEMORY_GROWTH=1 \
	-O3 \
	-msimd128 \
    -ffast-math

all: $(OUTPUT_JS)

$(OUTPUT_JS): $(WRAPPER_SRC) $(OPENH264_LIB)
	$(EMCC) $(WRAPPER_SRC) $(OPENH264_LIB) $(INCLUDES) -o $@ $(EMCC_FLAGS)

clean:
	rm -f $(OUTPUT_JS) $(OUTPUT_WASM)
