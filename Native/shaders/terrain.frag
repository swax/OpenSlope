#version 450
layout(location=0) in vec3 vertexColour;
layout(location=0) out vec4 colour;
void main() { colour=vec4(vertexColour,1.0); }
