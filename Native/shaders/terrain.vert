#version 450
layout(location=0) in vec3 position;
layout(location=1) in vec3 colour;
layout(location=2) in vec2 diffuseUV;
layout(location=3) in vec2 lightUV;
layout(location=4) in vec4 tile;
layout(location=0) out vec3 vertexColour;
layout(location=1) out vec2 textureUV;
layout(location=2) out vec2 lightmapUV;
layout(location=3) flat out vec4 lightmapTile;
layout(push_constant) uniform Transform { mat4 mvp; ivec4 options; } transform;
void main() {
    gl_Position=transform.mvp*vec4(position,1.0);
    vertexColour=colour;
    textureUV=diffuseUV;
    lightmapUV=lightUV;
    lightmapTile=tile;
}
