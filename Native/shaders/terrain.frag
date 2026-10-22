#version 460
#ifdef RAY_QUERY
#extension GL_EXT_ray_query : require
layout(set=2,binding=0) uniform accelerationStructureEXT shadowWorld;
#endif
layout(constant_id=0) const int lightingMode=0;
layout(constant_id=1) const int surfaceMode=-1;
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
struct Lamp {vec4 positionRadius;vec4 colour;vec4 directionCone;vec4 emitter;};
layout(std140,set=1,binding=1) uniform Lighting {
    vec4 sunDirection;vec4 sunColour;vec4 ambient;vec4 settings;vec4 localColour;vec4 presentation;
} light;
layout(std430,set=1,binding=2) readonly buffer LocalLights {uvec4 shape;vec4 originCell;Lamp lamps[];} local;
layout(std430,set=1,binding=3) readonly buffer LightCells {uvec2 cells[];} lightCells;
layout(std430,set=1,binding=4) readonly buffer LightIndices {uint indices[];} lightIndices;
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
vec3 toneMap(vec3 c) {
    return clamp((c*(2.51*c+0.03))/(c*(2.43*c+0.59)+0.14),0.0,1.0);
}
vec3 hdrOfOriginal(vec3 c) {
    // Invert the display shoulder so an already-lit Original colour survives
    // HDR presentation unchanged, before adding a small amount of new light.
    c=clamp(c,0.0,1.0);
    vec3 a=2.51-2.43*c, b=0.03-0.59*c;
    return (-b+sqrt(b*b+0.56*a*c))/(2.0*a);
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
    vec3 c=max(base+bloom*(light.presentation.y/weightSum),vec3(0));
    // Filmic shoulder retains bright-light detail in the display output.
    vec3 mapped=toneMap(c);
    return transform.options.y!=0?mapped:displayColourOf(mapped);
}
float shadowRay(vec3 n,vec3 direction,float distance,uint housing) {
#ifdef RAY_QUERY
    if(light.settings.w>0.5&&distance>0.03){
        rayQueryEXT query;
        // Only emitter housings need candidate filtering. Keep terrain, riders
        // and ordinary props on the hardware's opaque traversal path.
        uint flags=gl_RayFlagsTerminateOnFirstHitEXT|(housing!=0u?0u:gl_RayFlagsOpaqueEXT);
        rayQueryInitializeEXT(query,shadowWorld,flags,
                              255,worldPosition+n*0.015,0.002,direction,max(0.003,distance-0.02));
        while(rayQueryProceedEXT(query)){
            if(housing!=0u&&rayQueryGetIntersectionTypeEXT(query,false)==gl_RayQueryCandidateIntersectionTriangleEXT&&
               rayQueryGetIntersectionInstanceCustomIndexEXT(query,false)!=housing)
                rayQueryConfirmIntersectionEXT(query);
        }
        return rayQueryGetIntersectionTypeEXT(query,true)==gl_RayQueryCommittedIntersectionNoneEXT?1.0:0.0;
    }
#endif
    return 1.0;
}
float lightVisibility(vec3 n,vec3 direction,float distance,uint housing,float radius,float softness) {
#ifdef RAY_QUERY
    if(light.settings.w>0.5&&distance>0.03){
        if(softness<=0.0)return shadowRay(n,direction,distance,housing);
        vec3 axis=abs(direction.y)<0.95?vec3(0,1,0):vec3(1,0,0);
        vec3 x=normalize(cross(direction,axis)), y=cross(x,direction);
        const vec2 probes[5]=vec2[](vec2(0),vec2(.85,0),vec2(-.85,0),vec2(0,.85),vec2(0,-.85));
        float visible=0.0,center=0.0;
        for(int i=0;i<17;++i){
            vec2 disk;
            if(i<5)disk=probes[i];
            else{
                float k=float(i-5), r=sqrt((k+0.5)/12.0), angle=k*2.39996323+0.37;
                disk=vec2(cos(angle),sin(angle))*r;
            }
            vec3 delta=direction*distance+(x*disk.x+y*disk.y)*radius;
            float reach=length(delta);
            float probe=shadowRay(n,delta/reach,reach,housing);
            if(i==0)center=probe;
            visible+=probe;
            // Most pixels are fully lit or fully occluded. Refine only edges.
            if(i==4&&(visible==0.0||visible==5.0))return visible/5.0;
        }
        return mix(center,visible/17.0,softness);
    }
#endif
    return 1.0;
}
vec3 lampContribution(Lamp lamp,vec3 n,vec3 albedo,out vec3 direction,out float distance) {
    vec3 delta=lamp.positionRadius.xyz-worldPosition;
    float squaredDistance=dot(delta,delta);
    if(squaredDistance>=lamp.positionRadius.w*lamp.positionRadius.w)return vec3(0);
    distance=sqrt(squaredDistance);
    float attenuation=pow(max(0.0,1.0-distance/lamp.positionRadius.w),2.0);
    // At night, concentrate local pools instead of summing broad influence
    // boxes into a uniformly white slope. Preserve the daylight response.
    attenuation*=mix(1.0/(1.0+squaredDistance/(light.localColour.w*light.localColour.w)),1.0,light.settings.y);
    direction=delta/max(distance,0.001);
    float facing=max(dot(n,direction),0.0);
    if(lamp.directionCone.w>-1.0){
        float aim=dot(-direction,lamp.directionCone.xyz);
        if(aim<=lamp.directionCone.w)return vec3(0);
        float cone=(aim-lamp.directionCone.w)/max(1.0-lamp.directionCone.w,0.00001);
        attenuation*=cone*cone;
    }
    float peak=max(max(lamp.colour.r,lamp.colour.g),lamp.colour.b);
    vec3 strength=lamp.colour.rgb*mix(1.0,min(1.0,4.0/max(peak,0.001)),light.settings.y);
    return albedo*strength*light.localColour.rgb*facing*attenuation*1.4*lamp.emitter.y;
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
    // Subdued blue lunar fill retains occlusion with one ray, matching the
    // faint-lamp budget. Bright daytime and sunset sources retain area samples.
    float sunSoftness=light.presentation.z>0.5&&light.settings.y<0.001&&light.sunColour.b>light.sunColour.r?0.0:1.0;
    float sunlight=diffuse>0.0&&max(max(light.sunColour.r,light.sunColour.g),light.sunColour.b)>0.0?
                   lightVisibility(n,light.sunDirection.xyz,600.0,0u,2.79,sunSoftness):1.0;
    energy+=light.sunColour.rgb*diffuse*sunlight;
    vec3 h=v+light.sunDirection.xyz;
    float highlight=dot(h,h)>0.00001?pow(max(dot(n,normalize(h)),0.0),48.0):0.0;
    vec3 result=albedo*energy+light.sunColour.rgb*highlight*0.12*sunlight;
    if(light.presentation.z>0.5&&lightingMode==1)
        result=(light.settings.z>0.5?hdrOfOriginal(albedo):albedo)+
               albedo*light.sunColour.rgb*(diffuse+highlight*0.12)*sunlight;
    vec2 cell=floor((worldPosition.xz-local.originCell.xy)/local.originCell.z);
    uvec2 range=uvec2(0);
    if(all(greaterThanEqual(cell,vec2(0)))&&all(lessThan(cell,vec2(local.shape.xy))))
        range=lightCells.cells[uint(cell.y)*local.shape.x+uint(cell.x)];
    float localEnergy=0.0;
#ifdef RAY_QUERY
    if(light.settings.w>0.5){
        for(uint j=0;j<range.y;++j){
            vec3 direction;float distance;
            vec3 contribution=lampContribution(local.lamps[lightIndices.indices[range.x+j]],n,albedo,direction,distance);
            localEnergy+=max(max(contribution.r,contribution.g),contribution.b);
        }
    }
#endif
    // Bound the combined extra light from skipping imperceptible shadow tests.
    float untracedEnergy=0.0;
    for(uint j=0;j<range.y;++j){
        Lamp lamp=local.lamps[lightIndices.indices[range.x+j]];
        vec3 direction;float distance;
        vec3 contribution=lampContribution(lamp,n,albedo,direction,distance);
        float impact=max(max(contribution.r,contribution.g),contribution.b);
        float visible=1.0;
        if(impact>0.0){
            if(impact<0.0005&&untracedEnergy+impact<=0.001){
                untracedEnergy+=impact;
            }else{
                // A light must contribute a visible amount and a meaningful
                // share of the local illumination to receive extra area rays.
                // This admits at most seven soft local lights at any pixel.
                float softness=smoothstep(0.01,0.02,impact)*
                               smoothstep(0.125,0.5,impact/max(localEnergy,0.00001));
                visible=lightVisibility(n,direction,distance,uint(lamp.colour.w),lamp.emitter.x,
                                        softness);
            }
        }
        result+=contribution*visible;
    }
    if(light.presentation.z>0.5&&lightingMode==2&&light.settings.z<0.5)result=toneMap(result);
    return displayColourOf(result);
}
void main() {
    int mode=surfaceMode<0?transform.options.x:surfaceMode;
    if(lightingMode!=0&&mode==13){colour=vec4(presentHdr(),1);return;}
    bool runtime=lightingMode==2;
    vec3 displayColour=vertexColour;
    bool avatarTexture=(mode==0||mode==15)&&lightmapTile.w>0.5;
    vec3 avatarEmission=vec3(0);
    if(avatarTexture){
        displayColour*=texture(diffuseImage,textureUV).rgb;
        avatarEmission=texture(diffuseImage,lightmapUV).rgb*lightmapTile.xyz;
    }
    float alpha=1.0;
    if(mode==8||mode==9||mode==10)alpha=effectAlpha;
    if(mode==12){
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
    if(mode>0&&mode!=8&&mode!=9&&mode!=10&&mode!=12&&mode!=15) {
        vec4 base=texture(diffuseImage,textureUV);
        if(mode==3) {
            if(transform.options.z==1&&base.a<0.5)discard;
            if(transform.options.z==2){if(base.a<=1.0/255.0)discard;alpha=base.a;}
        }else if(base.a<=1.0/255.0)discard;
        displayColour=base.rgb;
        if(mode==14) {
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
        if(mode==4){displayColour=base.rgb*vertexColour;alpha=base.a*lightmapTile.x;}
        if(mode==5)alpha=base.a*effectAlpha;
        if(mode==6){displayColour=base.rgb*vertexColour;alpha=base.a*effectAlpha;}
        if(mode==11){displayColour=base.rgb*vertexColour;alpha=base.a;}
        if(mode==3&&!runtime){
            // [Trailmap: 160-instance-frame, 400-lighting] Model-local light records.
            // First-party preview profile: normalize interpolated normals and cap
            // modulation at texture-true white, as the rendered calibration shows.
            vec3 normal=length(propNormal)>0.00001?normalize(propNormal):vec3(0);
            vec3 light=vertexColour;
            for(int i=0;i<3;++i)light+=max(0.0,dot(normal,propDirections[i]))*propColours[i];
            displayColour=base.rgb*clamp(light,0.0,1.0);
        }
        if(mode==2&&!runtime) {
            // [Trailmap: 160-transpose, 160-luminance, 400-lighting]
            // Keep bilinear sampling inside this patch's gutterless tile.
            vec2 inset=min(0.5/vec2(textureSize(lightmapImage,0)),lightmapTile.zw*0.5);
            vec2 uv=clamp(lightmapUV,lightmapTile.xy+inset,lightmapTile.xy+lightmapTile.zw-inset);
            vec4 lighting=texture(lightmapImage,uv);
            displayColour=clamp((base.rgb-lighting.rgb)*lighting.a,0.0,1.0);
        }
    }
    if(lightingMode!=0&&((mode>=1&&mode<=3)||
       (runtime&&(mode==14||(mode==15&&dot(worldNormal,worldNormal)>0.00001)))))
        displayColour=litSurface(displayColour);
    if(lightingMode!=0&&light.presentation.z>0.5&&light.settings.z>0.5&&
       (mode==7||(lightingMode==1&&
       (mode==14||(mode==15&&dot(worldNormal,worldNormal)>0.00001)))))
        displayColour=displayColourOf(hdrOfOriginal(linearColour(displayColour)));
    if(mode!=7&&(mode<10||mode==14||mode==15)&&transform.eyeEnd.w>transform.fogColourStart.w){
        float fog=clamp((length(worldPosition-transform.eyeEnd.xyz)-transform.fogColourStart.w)/(transform.eyeEnd.w-transform.fogColourStart.w),0.0,1.0);
        if(mode==4&&transform.options.w!=0)alpha*=1.0-fog;
        else if(mode==4||mode==6||mode==9)displayColour*=1.0-fog;
        else if(mode==5)alpha*=1.0-fog;
        else displayColour=mix(displayColour,transform.fogColourStart.rgb,fog);
    }
    displayColour+=avatarEmission;
    displayColour*=transform.presentation.x;
    // Byte-domain terrain blend above; convert only for an sRGB attachment,
    // whose hardware write converts linear output back to display values.
    if(transform.options.y!=0)displayColour=mix(displayColour/12.92,pow((displayColour+0.055)/1.055,vec3(2.4)),greaterThan(displayColour,vec3(0.04045)));
    colour=vec4(displayColour,alpha);
}
