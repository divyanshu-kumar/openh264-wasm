const rgbaToYuvShaderCode = `
    @group(0) @binding(0) var tex: texture_2d<f32>;
    @group(0) @binding(1) var<storage, read_write> y_out : array<f32>;
    @group(0) @binding(2) var<storage, read_write> u_out : array<f32>;
    @group(0) @binding(3) var<storage, read_write> v_out : array<f32>;

    @compute @workgroup_size(8, 8, 1)
    fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let dims = textureDimensions(tex);
        if (id.x >= dims.x || id.y >= dims.y) { return; }
        
        let rgba = textureLoad(tex, vec2<i32>(id.xy), 0);
        let r = rgba.r; let g = rgba.g; let b = rgba.b;

        // Using ITU-R BT.601 standard for conversion
        y_out[id.y * dims.x + id.x] = (0.299 * r + 0.587 * g + 0.114 * b) * 255.0;

        if ((id.x % 2u == 0u) && (id.y % 2u == 0u)) {
            let u = (-0.168736 * r - 0.331264 * g + 0.5 * b) * 255.0 + 128.0;
            let v = (0.5 * r - 0.418688 * g - 0.081312 * b) * 255.0 + 128.0;
            
            let uv_x = id.x / 2u; let uv_y = id.y / 2u;
            let uv_width = dims.x / 2u;
            
            u_out[uv_y * uv_width + uv_x] = u;
            v_out[uv_y * uv_width + uv_x] = v;
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
