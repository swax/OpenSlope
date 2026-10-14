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
layout(location=4) out float effectAlpha;
layout(location=5) out vec3 worldPosition;
layout(push_constant) uniform Transform { mat4 mvp; ivec4 options; vec4 fogColourStart; vec4 eyeEnd; } transform;
void main() {
    worldPosition=position;
    vertexColour=colour;
    effectAlpha=lightUV.x;
    if(transform.options.x==5)worldPosition=position+modelNormal*(0.008+0.004*transform.options.w);
    if(transform.options.x==4){
        vec3 forward=vec3(transform.mvp[0][3],transform.mvp[1][3],transform.mvp[2][3]);
        forward=length(forward)>0.00001?normalize(forward):vec3(0,0,-1);
        vec3 rowX=vec3(transform.mvp[0][0],transform.mvp[1][0],transform.mvp[2][0]);
        vec3 rowY=-vec3(transform.mvp[0][1],transform.mvp[1][1],transform.mvp[2][1]);
        vec3 right=normalize(rowX-forward*dot(rowX,forward));vec3 up=normalize(rowY-forward*dot(rowY,forward));
        vec2 offset=vec2(diffuseUV.x*2-1,1-diffuseUV.y*2)*lightUV.x;
        float c=cos(lightUV.y),s=sin(lightUV.y);offset=mat2(c,s,-s,c)*offset;
        worldPosition=position+right*offset.x+up*offset.y;
    }
    if(transform.options.x==3) {
        Pose pose=poses[gl_InstanceIndex];worldPosition=(pose.matrix*vec4(position,1.0)).xyz;
        vec3 light=pose.ambient.rgb;
        // [Trailmap: 160-instance-frame, 400-lighting] Both operands model-local.
        for(int i=0;i<3;++i)light+=max(0.0,dot(modelNormal,pose.direction[i].xyz))*pose.colour[i].rgb;
        vertexColour=clamp(light,0.0,255.0/128.0);
    }
    textureUV=diffuseUV;
    if(transform.options.x==5&&transform.options.w==1)textureUV.x=1.0-diffuseUV.x;
    lightmapUV=lightUV;
    lightmapTile=tile;
    gl_Position=transform.mvp*vec4(worldPosition,1.0);
    if(transform.options.x==7)gl_Position.z=gl_Position.w;
}
