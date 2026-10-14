#version 450
layout(location=0) in vec3 position;
layout(location=1) in vec3 colour;
layout(location=2) in vec2 diffuseUV;
layout(location=3) in vec2 lightUV;
layout(location=4) in vec4 tile;
layout(location=5) in vec3 modelNormal;
struct Pose {mat4 matrix;vec4 ambient;vec4 direction[3];vec4 colour[3];};
layout(std430,set=0,binding=2) readonly buffer Placements {Pose poses[];};
layout(location=0) out vec3 vertexColour;
layout(location=1) out vec2 textureUV;
layout(location=2) out vec2 lightmapUV;
layout(location=3) flat out vec4 lightmapTile;
layout(push_constant) uniform Transform { mat4 mvp; ivec4 options; } transform;
void main() {
    gl_Position=transform.mvp*vec4(position,1.0);
    vertexColour=colour;
    if(transform.options.x==3) {
        Pose pose=poses[gl_InstanceIndex];gl_Position=transform.mvp*pose.matrix*vec4(position,1.0);
        vec3 light=pose.ambient.rgb;
        // [Trailmap: 160-instance-frame, 400-lighting] Both operands model-local.
        for(int i=0;i<3;++i)light+=max(0.0,dot(modelNormal,pose.direction[i].xyz))*pose.colour[i].rgb;
        vertexColour=clamp(light,0.0,255.0/128.0);
    }
    textureUV=diffuseUV;
    lightmapUV=lightUV;
    lightmapTile=tile;
}
