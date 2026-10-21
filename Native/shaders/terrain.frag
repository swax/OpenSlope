#version 460
#ifdef RAY_QUERY
#extension GL_EXT_ray_query : require
layout(set=2,binding=0) uniform accelerationStructureEXT shadowWorld;
#endif
layout(location=0) in vec3 vertexColour;
layout(location=1) in vec2 textureUV;
layout(location=2) in vec2 lightmapUV;
layout(location=3) flat in vec4 lightmapTile;
layout(location=4) in float effectAlpha;
layout(location=5) in vec3 worldPosition;
layout(location=6) in vec3 propNormal;
layout(location=7) flat in mat3 propDirections;
layout(location=10) flat in mat3 propColours;
layout(location=13) in vec3 worldNormal;
struct Lamp {vec4 positionRadius;vec4 colour;};
layout(std140,set=1,binding=1) uniform Lighting {
    vec4 sunDirection;vec4 sunColour;vec4 ambient;vec4 settings;Lamp lamps[16];
} light;
layout(set=0,binding=0) uniform sampler2D diffuseImage;
layout(set=0,binding=1) uniform sampler2D lightmapImage;
layout(push_constant) uniform Transform { mat4 mvp; ivec4 options; vec4 fogColourStart; vec4 eyeEnd; vec4 presentation; } transform;
layout(location=0) out vec4 colour;
vec3 linearColour(vec3 c) {
    return mix(c/12.92,pow((c+0.055)/1.055,vec3(2.4)),greaterThan(c,vec3(0.04045)));
}
vec3 displayColourOf(vec3 c) {
    return mix(c*12.92,1.055*pow(max(c,vec3(0)),vec3(1.0/2.4))-0.055,greaterThan(c,vec3(0.0031308)));
}
vec3 presentHdr() {
    vec3 base=texture(diffuseImage,textureUV).rgb;
    vec2 size=vec2(textureSize(diffuseImage,0));
    vec2 stepUV=max(1.0,size.y/240.0)/size;
    const float weights[3]=float[](1.0,0.60653066,0.13533528);
    vec3 bloom=vec3(0);
    float weightSum=0.0;
    for(int y=-2;y<=2;++y)for(int x=-2;x<=2;++x){
        float weight=weights[abs(x)]*weights[abs(y)];
        bloom+=max(texture(diffuseImage,textureUV+vec2(x,y)*stepUV).rgb-vec3(0.9),vec3(0))*weight;
        weightSum+=weight;
    }
    vec3 c=max(base+bloom*(0.16/weightSum),vec3(0));
    // Filmic shoulder retains bright-light detail in the display output.
    vec3 mapped=clamp((c*(2.51*c+0.03))/(c*(2.43*c+0.59)+0.14),0.0,1.0);
    return transform.options.y!=0?mapped:displayColourOf(mapped);
}
float lightVisibility(vec3 n,vec3 direction,float distance) {
#ifdef RAY_QUERY
    if(light.settings.w>0.5&&distance>0.03){
        rayQueryEXT query;
        rayQueryInitializeEXT(query,shadowWorld,gl_RayFlagsTerminateOnFirstHitEXT|gl_RayFlagsOpaqueEXT,
                              255,worldPosition+n*0.015,0.002,direction,max(0.003,distance-0.02));
        while(rayQueryProceedEXT(query)){}
        return rayQueryGetIntersectionTypeEXT(query,true)==gl_RayQueryCommittedIntersectionNoneEXT?1.0:0.0;
    }
#endif
    return 1.0;
}
vec3 litSurface(vec3 base) {
    vec3 n=worldNormal;
    if(dot(n,n)<0.00001)n=cross(dFdx(worldPosition),dFdy(worldPosition));
    if(dot(n,n)<0.00001)return base;
    n=normalize(n);
    vec3 v=transform.eyeEnd.xyz-worldPosition;
    v=dot(v,v)>0.00001?normalize(v):n;
    vec3 albedo=linearColour(base);
    vec3 energy=light.ambient.rgb*mix(0.8,1.0,n.y*0.5+0.5);
    float diffuse=max(0.0,dot(n,light.sunDirection.xyz));
    float sunlight=diffuse>0.0&&light.settings.y>0.0?lightVisibility(n,light.sunDirection.xyz,600.0):1.0;
    energy+=light.sunColour.rgb*diffuse*sunlight;
    vec3 h=v+light.sunDirection.xyz;
    float highlight=dot(h,h)>0.00001?pow(max(dot(n,normalize(h)),0.0),48.0):0.0;
    vec3 result=albedo*energy+light.sunColour.rgb*highlight*0.12*sunlight;
    for(int i=0;i<int(light.settings.z);++i){
        vec3 delta=light.lamps[i].positionRadius.xyz-worldPosition;
        float distance=length(delta);
        float attenuation=pow(max(0.0,1.0-distance/light.lamps[i].positionRadius.w),2.0);
        vec3 direction=delta/max(distance,0.001);
        float facing=max(dot(n,direction),0.0);
        float visible=attenuation*facing>0.0?lightVisibility(n,direction,distance):1.0;
        result+=albedo*light.lamps[i].colour.rgb*facing*attenuation*1.4*visible;
    }
    return displayColourOf(result);
}
void main() {
    if(transform.options.x==13){colour=vec4(presentHdr(),1);return;}
    vec3 displayColour=vertexColour;
    float alpha=1.0;
    if(transform.options.x==8||transform.options.x==9||transform.options.x==10)alpha=effectAlpha;
    if(transform.options.x==12){
        vec2 q=textureUV*2.0-1.0;
        float r=length(q);
        float halo=exp(-100.0*(r-0.88)*(r-0.88))*(1.0-smoothstep(0.95,1.0,r));
        float core=exp(-5.0*dot(q,q))*(1.0-smoothstep(0.75,1.0,r));
        float spike=pow(max(0.0,1.0-r),1.5)*exp(-90.0*min(q.x*q.x,q.y*q.y));
        alpha=effectAlpha*(lightmapTile.x>1.5?core:lightmapTile.x>0.5?spike:halo);
        if(transform.options.z!=0){
            // Owned lens art: ring upper-left, soft core upper-right, star lower-left.
            vec2 tile=lightmapTile.x>1.5?vec2(0.5,0):lightmapTile.x>0.5?vec2(0,0.5):vec2(0);
            vec2 inset=0.5/vec2(textureSize(diffuseImage,0));
            vec4 lens=texture(diffuseImage,tile+mix(inset,vec2(0.5)-inset,textureUV));
            displayColour*=lens.rgb;
            alpha=effectAlpha*lens.a;
        }
    }
    if(transform.options.x>0&&transform.options.x!=8&&transform.options.x!=9&&transform.options.x!=10&&transform.options.x!=12) {
        vec4 base=texture(diffuseImage,textureUV);
        if(transform.options.x==3) {
            if(transform.options.z==1&&base.a<0.5)discard;
            if(transform.options.z==2){if(base.a<=1.0/255.0)discard;alpha=base.a;}
        }else if(base.a<=1.0/255.0)discard;
        displayColour=base.rgb;
        if(transform.options.x==14) {
            if(lightmapTile.w<0.5)displayColour=transform.presentation.yzw;
            else {
                vec2 halfTexel=0.5/vec2(textureSize(diffuseImage,0));
                float panel=lightmapTile.x;
                vec2 inkUV=vec2(textureUV.x,(textureUV.y-0.5)*1.1+0.5);
                vec2 uv=clamp(inkUV,vec2(panel+halfTexel.x,halfTexel.y),vec2(panel+0.5-halfTexel.x,1.0-halfTexel.y));
                displayColour=texture(diffuseImage,uv).rgb;
            }
            if(transform.options.z!=0)displayColour*=vertexColour;
        }
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
    if(light.settings.x>0.5&&transform.options.x>=1&&transform.options.x<=3)
        displayColour=litSurface(displayColour);
    if(transform.options.x!=7&&(transform.options.x<10||transform.options.x==14)&&transform.eyeEnd.w>transform.fogColourStart.w){
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
