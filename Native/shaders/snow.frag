#version 450
layout(location=0) in vec2 uv;
layout(location=0) out vec4 colour;
layout(push_constant) uniform Snow {
    mat4 clip;vec4 eyeTime;vec4 boxLift;vec4 motion;vec4 fades;
} snow;
void main(){
    float dome=max(0.0,1.0-dot(uv,uv)/0.55);
    float light=dome*dome*snow.motion.w;
    if(snow.fades.w!=0)light=light<=0.04045?light/12.92:pow((light+0.055)/1.055,2.4);
    colour=vec4(vec3(light),1);
}
