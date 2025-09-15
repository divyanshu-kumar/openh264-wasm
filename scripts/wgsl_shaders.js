const rgbaToYuvShaderCode = `
    struct Uniforms {
        width: u32,
        height: u32,
    };

    @group(0) @binding(0) var tex: texture_2d<f32>;
    @group(0) @binding(1) var<storage, read_write> y_out : array<f32>;
    @group(0) @binding(2) var<storage, read_write> u_out : array<f32>;
    @group(0) @binding(3) var<storage, read_write> v_out : array<f32>;
    @group(0) @binding(4) var<uniform> uniforms: Uniforms;

    @compute @workgroup_size(8, 8, 1)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        if (id.x >= uniforms.width || id.y >= uniforms.height) { 
            return; 
        }
        
        let rgba = textureLoad(tex, vec2<i32>(id.xy), 0);
        let r = rgba.r; 
        let g = rgba.g; 
        let b = rgba.b;

        // Using ITU-R BT.601 standard for conversion
        y_out[id.y * uniforms.width + id.x] = (0.299 * r + 0.587 * g + 0.114 * b);

        if ((id.x % 2u == 0u) && (id.y % 2u == 0u)) {
            let u = (-0.168736 * r - 0.331264 * g + 0.5 * b);
            let v = (0.5 * r - 0.418688 * g - 0.081312 * b);
            
            let uv_x = id.x / 2u; 
            let uv_y = id.y / 2u;
            let uv_width = uniforms.width / 2u;
            
            u_out[uv_y * uv_width + uv_x] = u;
            v_out[uv_y * uv_width + uv_x] = v;
        }
    }
`;

const packYuvShaderCode = `
    struct Uniforms {
        width: u32,
        height: u32,
    };

    @group(0) @binding(0) var<storage, read> y_in : array<f32>;
    @group(0) @binding(1) var<storage, read> u_in : array<f32>;
    @group(0) @binding(2) var<storage, read> v_in : array<f32>;
    @group(0) @binding(3) var<storage, read_write> yuv_out : array<u32>;
    @group(0) @binding(4) var<uniform> uniforms: Uniforms;

    // This shader takes the f32 YUV planes and packs them into a single buffer of u8 values.
    // To work around WGSL's lack of u8 storage buffers, we pack 4 u8s into a single u32.
    @compute @workgroup_size(64, 1, 1)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let y_size = uniforms.width * uniforms.height;
        let u_size = y_size / 4u;
        let total_size = y_size + u_size * 2u;
        
        let out_idx = id.x;
        if (out_idx * 4u >= total_size) {
            return;
        }

        var packed_val : u32 = 0u;

        // Process 4 bytes at a time
        for (var i : u32 = 0u; i < 4u; i = i + 1u) {
            let current_byte_idx = out_idx * 4u + i;
            var val8bit : u32 = 0u;

            if (current_byte_idx < y_size) {
                // Y plane
                let y_val = y_in[current_byte_idx];
                val8bit = u32(clamp(y_val * 255.0, 0.0, 255.0));

            } else if (current_byte_idx < y_size + u_size) {
                // U plane
                let u_idx = current_byte_idx - y_size;
                let u_val = u_in[u_idx];
                val8bit = u32(clamp(u_val * 255.0 + 128.0, 0.0, 255.0));

            } else {
                // V plane
                let v_idx = current_byte_idx - y_size - u_size;
                let v_val = v_in[v_idx];
                val8bit = u32(clamp(v_val * 255.0 + 128.0, 0.0, 255.0));
            }
            
            // Pack the 8-bit value into the correct byte of the 32-bit integer.
            packed_val = packed_val | (val8bit << (i * 8u));
        }
        
        yuv_out[out_idx] = packed_val;
    }
`;

// A single-pass shader that converts RGBA to YUV and packs it directly
// into the final buffer format. 
const optimizedRgbaToYuvPackShaderCode = `
    struct Uniforms {
        width: u32,
        height: u32,
    };

    @group(0) @binding(0) var tex: texture_2d<f32>;
    @group(0) @binding(1) var<storage, read_write> yuv_out: array<atomic<u32>>;
    @group(0) @binding(2) var<uniform> uniforms: Uniforms;

    // These are the same coefficients as openh264_wrapper.cpp, used for integer math.
    // Y = ((66*R + 129*G + 25*B + 128) >> 8) + 16
    // U = ((-38*R - 74*G + 112*B + 128) >> 8) + 128
    // V = ((112*R - 94*G - 18*B + 128) >> 8) + 128

    @compute @workgroup_size(8, 8, 1)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        if (id.x >= uniforms.width || id.y >= uniforms.height) {
            return;
        }

        // Load RGBA and convert to u32 0-255 range
        let rgba = textureLoad(tex, vec2<i32>(id.xy), 0).rgba * 255.0;
        let r = u32(rgba.r);
        let g = u32(rgba.g);
        let b = u32(rgba.b);

        // --- Y Plane Calculation ---
        let y_val = ((66u * r + 129u * g + 25u * b + 128u) >> 8u) + 16u;
        
        let y_idx = id.y * uniforms.width + id.x;
        let y_word_idx = y_idx / 4u;
        let y_byte_shift = (y_idx % 4u) * 8u;
        
        // Atomically OR the Y value into the correct byte of the output u32.
        atomicOr(&yuv_out[y_word_idx], y_val << y_byte_shift);

        // --- U and V Plane Calculation (for each 2x2 block) ---
        // We only need to calculate U and V for the top-left pixel of each 2x2 block.
        if ((id.x % 2u == 0u) && (id.y % 2u == 0u)) {
            // We use the top-left pixel's color for the whole 2x2 block's chroma, matching the C++ behavior.
            // Cast to i32 for intermediate calculations which can be negative.
            let u_val = ((-38 * i32(r) - 74 * i32(g) + 112 * i32(b) + 128) >> 8) + 128;
            let v_val = ((112 * i32(r) - 94 * i32(g) - 18 * i32(b) + 128) >> 8) + 128;
            
            let y_size = uniforms.width * uniforms.height;
            let uv_width = uniforms.width / 2u;

            // U plane position
            let u_idx = (id.y / 2u) * uv_width + (id.x / 2u);
            let u_byte_pos = y_size + u_idx;
            let u_word_idx = u_byte_pos / 4u;
            let u_byte_shift = (u_byte_pos % 4u) * 8u;
            atomicOr(&yuv_out[u_word_idx], u32(u_val) << u_byte_shift);

            // V plane position
            let v_idx = u_idx; // V has same index as U in its own plane
            let u_size = (uniforms.width * uniforms.height) / 4u;
            let v_byte_pos = y_size + u_size + v_idx;
            let v_word_idx = v_byte_pos / 4u;
            let v_byte_shift = (v_byte_pos % 4u) * 8u;
            atomicOr(&yuv_out[v_word_idx], u32(v_val) << v_byte_shift);
        }
    }
`;


const yuvToRgbaShaderModule = `
    struct VertexOutput {
        @builtin(position) position: vec4<f32>,
        @location(0) uv: vec2<f32>,
    };

    @group(0) @binding(0) var samp: sampler;
    @group(0) @binding(1) var y_tex: texture_2d<f32>;
    @group(0) @binding(2) var u_tex: texture_2d<f32>;
    @group(0) @binding(3) var v_tex: texture_2d<f32>;

    @vertex
    fn vs_main(@builtin(vertex_index) in_vertex_index: u32) -> VertexOutput {
        // Generates a fullscreen triangle strip
        let x = f32(in_vertex_index % 2u);
        let y = f32(in_vertex_index / 2u);
        
        var output: VertexOutput;
        // Position coordinates in clip space (-1 to 1)
        output.position = vec4<f32>(x * 2.0 - 1.0, (1.0 - y) * 2.0 - 1.0, 0.0, 1.0);
        // Texture coordinates (0 to 1), Y is flipped
        output.uv = vec2<f32>(x, y); 
        return output;
    }

    @fragment
    fn fs_main(frag_in: VertexOutput) -> @location(0) vec4<f32> {
        let y = textureSample(y_tex, samp, frag_in.uv).r;
        let u = textureSample(u_tex, samp, frag_in.uv).r - 0.5;
        let v = textureSample(v_tex, samp, frag_in.uv).r - 0.5;

        // Using ITU-R BT.601 standard for conversion
        let r = y + 1.402 * v;
        let g = y - 0.344136 * u - 0.714136 * v;
        let b = y + 1.772 * u;

        return vec4<f32>(r, g, b, 1.0);
    }
`;
