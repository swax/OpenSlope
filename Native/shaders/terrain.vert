#version 450
layout(location=0) in vec3 position;
layout(location=1) in vec3 colour;
layout(location=0) out vec3 vertexColour;
layout(push_constant) uniform Transform { mat4 mvp; } transform;
void main() {
    gl_Position=transform.mvp*vec4(position,1.0);
    vertexColour=colour;
}
