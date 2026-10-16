#version 450
layout(location=0) in vec3 vertexColour;
layout(location=1) in vec2 textureUV;
layout(location=2) in vec2 lightmapUV;
layout(location=3) flat in vec4 lightmapTile;
layout(location=4) in float effectAlpha;
layout(location=5) in vec3 worldPosition;
layout(location=6) in vec3 propNormal;
layout(location=7) flat in mat3 propDirections;
layout(location=10) flat in mat3 propColours;
layout(set=0,binding=0) uniform sampler2D diffuseImage;
layout(set=0,binding=1) uniform sampler2D lightmapImage;
layout(push_constant) uniform Transform { mat4 mvp; ivec4 options; vec4 fogColourStart; vec4 eyeEnd; vec4 presentation; } transform;
layout(location=0) out vec4 colour;
void main() {
    vec3 displayColour=vertexColour;
    float alpha=1.0;
    if(transform.options.x==8||transform.options.x==9||transform.options.x==10)alpha=effectAlpha;
    if(transform.options.x==12){
        vec2 q=textureUV*2.0-1.0;
        float halo=exp(-5.0*dot(q,q))*(1.0-smoothstep(0.75,1.0,length(q)));
        float spike=pow(max(0.0,1.0-abs(q.x)),1.5)*exp(-6.0*q.y*q.y)*(1.0-smoothstep(0.8,1.0,abs(q.y)));
        alpha=effectAlpha*(lightmapTile.x>0.5?spike:halo);
    }
    if(transform.options.x>0&&transform.options.x!=8&&transform.options.x!=9&&transform.options.x!=10&&transform.options.x!=12) {
        vec4 base=texture(diffuseImage,textureUV);
        if(transform.options.x==3) {
            if(transform.options.z==1&&base.a<0.5)discard;
            if(transform.options.z==2){if(base.a<=1.0/255.0)discard;alpha=base.a;}
        }else if(base.a<=1.0/255.0)discard;
        displayColour=base.rgb;
        if(transform.options.x==4){displayColour=base.rgb*vertexColour;alpha=base.a*lightmapTile.x;}
        if(transform.options.x==5)alpha=base.a*effectAlpha;
        if(transform.options.x==6){displayColour=base.rgb*vertexColour;alpha=base.a*effectAlpha;}
        if(transform.options.x==11){displayColour=base.rgb*vertexColour;alpha=base.a;}
        if(transform.options.x==3){
            // [Trailmap: 160-instance-frame, 400-lighting] Model-local light records.
            // First-party preview profile: normalize interpolated normals and cap
            // modulation at texture-true white, as the rendered calibration shows.
            vec3 normal=length(propNormal)>0.00001?normalize(propNormal):vec3(0);
            vec3 light=vertexColour;
            for(int i=0;i<3;++i)light+=max(0.0,dot(normal,propDirections[i]))*propColours[i];
            displayColour=base.rgb*clamp(light,0.0,1.0);
        }
        if(transform.options.x==2) {
            // [Trailmap: 160-transpose, 160-luminance, 400-lighting]
            // Keep bilinear sampling inside this patch's gutterless tile.
            vec2 inset=min(0.5/vec2(textureSize(lightmapImage,0)),lightmapTile.zw*0.5);
            vec2 uv=clamp(lightmapUV,lightmapTile.xy+inset,lightmapTile.xy+lightmapTile.zw-inset);
            vec4 lighting=texture(lightmapImage,uv);
            displayColour=clamp((base.rgb-lighting.rgb)*lighting.a,0.0,1.0);
        }
    }
    if(transform.options.x!=7&&transform.options.x<10&&transform.eyeEnd.w>transform.fogColourStart.w){
        float fog=clamp((length(worldPosition-transform.eyeEnd.xyz)-transform.fogColourStart.w)/(transform.eyeEnd.w-transform.fogColourStart.w),0.0,1.0);
        if(transform.options.x==4&&transform.options.w!=0)alpha*=1.0-fog;
        else if(transform.options.x==4||transform.options.x==6||transform.options.x==9)displayColour*=1.0-fog;
        else if(transform.options.x==5)alpha*=1.0-fog;
        else displayColour=mix(displayColour,transform.fogColourStart.rgb,fog);
    }
    displayColour*=transform.presentation.x;
    // Byte-domain terrain blend above; convert only for an sRGB attachment,
    // whose hardware write converts linear output back to display values.
    if(transform.options.y!=0)displayColour=mix(displayColour/12.92,pow((displayColour+0.055)/1.055,vec3(2.4)),greaterThan(displayColour,vec3(0.04045)));
    colour=vec4(displayColour,alpha);
}
