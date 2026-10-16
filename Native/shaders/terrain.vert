#version 450
layout(location=0) in vec3 position;
layout(location=1) in vec3 colour;
layout(location=2) in vec2 diffuseUV;
layout(location=3) in vec2 lightUV;
layout(location=4) in vec4 tile;
layout(location=5) in vec3 modelNormal;
struct Pose {mat4 matrix;vec4 ambient;vec4 direction[3];vec4 colour[3];vec4 uv;};
layout(std430,set=1,binding=0) readonly buffer Placements {Pose poses[];};
layout(location=0) out vec3 vertexColour;
layout(location=1) out vec2 textureUV;
layout(location=2) out vec2 lightmapUV;
layout(location=3) flat out vec4 lightmapTile;
layout(location=4) out float effectAlpha;
layout(location=5) out vec3 worldPosition;
layout(location=6) out vec3 propNormal;
layout(location=7) flat out mat3 propDirections;
layout(location=10) flat out mat3 propColours;
layout(push_constant) uniform Transform { mat4 mvp; ivec4 options; vec4 fogColourStart; vec4 eyeEnd; vec4 presentation; } transform;
void main() {
    worldPosition=position;
    vertexColour=colour;
    propNormal=vec3(0);
    propDirections=mat3(0);
    propColours=mat3(0);
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
        Pose pose=poses[gl_InstanceIndex];vec3 local=position;
        if(lightUV.y>.5&&pose.uv.z!=0){float k=pose.uv.w>=2?1-lightUV.x:lightUV.x;local.x+=pose.uv.z*k*sin(6.283185307179586*(k-fract(pose.uv.w)));}
        worldPosition=(pose.matrix*vec4(local,1.0)).xyz;
        vertexColour=pose.ambient.rgb;
        propNormal=modelNormal;
        for(int i=0;i<3;++i){propDirections[i]=pose.direction[i].xyz;propColours[i]=pose.colour[i].rgb;}
    }
    textureUV=diffuseUV;
    if(transform.options.x==3)textureUV+=poses[gl_InstanceIndex].uv.xy;
    if(transform.options.x==5&&transform.options.w==1)textureUV.x=1.0-diffuseUV.x;
    lightmapUV=lightUV;
    lightmapTile=tile;
    gl_Position=transform.mvp*vec4(worldPosition,1.0);
    if(transform.options.x==10||transform.options.x==11)gl_Position=vec4(position.xy,0.5*lightUV.y,lightUV.y);
    if(transform.options.x==7)gl_Position.z=0.0;
}
