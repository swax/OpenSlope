#version 450
layout(location=0) in vec3 base;
layout(location=1) in vec4 variation;
layout(push_constant) uniform Snow {
    mat4 clip;
    vec4 eyeTime;
    vec4 boxLift;
    vec4 motion; // fall min/max, drift, intensity
    vec4 fades; // near start/end, edge fraction, display target
} snow;
layout(location=0) out vec2 uv;
const vec2 corners[6]=vec2[6](vec2(-0.5,-0.5),vec2(0.5,-0.5),vec2(0.5,0.5),
                              vec2(-0.5,-0.5),vec2(0.5,0.5),vec2(-0.5,0.5));
void main(){
    vec3 centre=snow.eyeTime.xyz+vec3(0,snow.boxLift.w,0);
    vec3 velocity=vec3((variation.x*2-1)*snow.motion.z,
                       -mix(snow.motion.x,snow.motion.y,variation.z),
                       (variation.y*2-1)*snow.motion.z);
    vec3 path=base*snow.boxLift.xyz+velocity*snow.eyeTime.w;
    vec3 offset=mod(path-centre+snow.boxLift.xyz*0.5,snow.boxLift.xyz)-snow.boxLift.xyz*0.5;
    vec3 position=centre+offset;
    float edge=max(max(abs(offset.x)*2/snow.boxLift.x,abs(offset.y)*2/snow.boxLift.y),abs(offset.z)*2/snow.boxLift.z);
    float edgeScale=smoothstep(0,1,(1-edge)/snow.fades.z);
    float nearScale=smoothstep(snow.fades.x,snow.fades.y,length(position-snow.eyeTime.xyz));
    vec3 forward=normalize(vec3(snow.clip[0][3],snow.clip[1][3],snow.clip[2][3]));
    vec3 right=cross(forward,vec3(0,1,0));
    right=length(right)>0.00001?normalize(right):vec3(1,0,0);
    vec2 corner=corners[gl_VertexIndex];
    // Flake diameter is fixed across the dial, as required by the public play profile.
    float size=mix(0.1,0.3,variation.w)*edgeScale*nearScale;
    gl_Position=snow.clip*vec4(position+(right*corner.x+vec3(0,1,0)*corner.y)*size,1);
    uv=corner*2;
}
