#version 450
layout(location=0) in vec3 vertexColour;
layout(location=1) in vec2 textureUV;
layout(location=2) in vec2 lightmapUV;
layout(location=3) flat in vec4 lightmapTile;
layout(set=0,binding=0) uniform sampler2D diffuseImage;
layout(set=0,binding=1) uniform sampler2D lightmapImage;
layout(push_constant) uniform Transform { mat4 mvp; ivec4 options; } transform;
layout(location=0) out vec4 colour;
void main() {
    vec3 displayColour=vertexColour;
    if(transform.options.x>0) {
        vec4 base=texture(diffuseImage,textureUV);
        if(base.a<=1.0/255.0)discard;
        displayColour=base.rgb;
        if(transform.options.x==2) {
            // [Trailmap: 160-transpose, 160-luminance, 400-lighting]
            // Keep bilinear sampling inside this patch's gutterless tile.
            vec2 inset=min(0.5/vec2(textureSize(lightmapImage,0)),lightmapTile.zw*0.5);
            vec2 uv=clamp(lightmapUV,lightmapTile.xy+inset,lightmapTile.xy+lightmapTile.zw-inset);
            vec4 lighting=texture(lightmapImage,uv);
            displayColour=clamp((base.rgb-lighting.rgb)*lighting.a,0.0,1.0);
        }
    }
    // Byte-domain terrain blend above; convert only for an sRGB attachment,
    // whose hardware write converts linear output back to display values.
    if(transform.options.y!=0)displayColour=mix(displayColour/12.92,pow((displayColour+0.055)/1.055,vec3(2.4)),greaterThan(displayColour,vec3(0.04045)));
    colour=vec4(displayColour,1.0);
}
