// URP port of OpenSlope/UnlitDoubleSided (the Built-in-RP original lives in ../../VRC/Shaders/Unlit.shader).
// Basis is Unity 6 + URP, so the level importer's materials - which are authored against the property/keyword
// surface of the Built-in shader by MaterialFactory - need a URP shader that answers to the SAME name and the
// SAME properties/keywords, or they render magenta. This is that shader: identical Shader name, identical
// Properties block, identical shader_feature keywords, so a material built by the importer (SetTexture/SetFloat/
// EnableKeyword) lights up unchanged whether the project is VRChat/Built-in or Basis/URP.
//
// Unlit (textures read at the PS2's full brightness), Cull Off (import winding doesn't matter). Optional
// per-material paths, off by default, enabled by MaterialFactory:
//   _CUTOUT       - alpha clip for trees/billboards/fences (paired with AlphaToMask for MSAA-coverage edges)
//   _LIGHTMAP     - modulate by baked VERTEX COLOUR (terrain luminance fallback / per-instance prop light)
//   _PROPLIGHT     - exact PS2 prop modulation in byte/sRGB space (record value 256 = 1.0)
//   _LIGHTMAP_GS  - terrain lighting: reconstruct the PS2 GS blend (C_D - C_S) x A_S per-pixel from the RGBA
//                   lightmap atlas via UV1 (rgb = C_S, alpha = A_S) - the real coloured light (cool/warm)
//   _DIRLIGHT     - real-time N.L sun for the props that rotate (trick gems, crash bags)
//   _WIND         - per-vertex horizontal sway for the soft-body flags/fences
//   _TEXARRAY     - sample a Texture2DArray slice (UV0.z) so one combined-mesh draw replaces N submeshes
//   _ScrollSpeed/_ScrollCycle - native fixed-tick UV motion for water/LCD/jumbotrons
Shader "OpenSlope/UnlitDoubleSided"
{
    Properties
    {
        _MainTex ("Texture", 2D) = "white" {}
        [Toggle(_TEXARRAY)] _UseTexArray ("Use Texture Array (batched)", Float) = 0
        _MainTexArray ("Texture Array", 2DArray) = "" {}
        [Toggle(_CUTOUT)] _UseCutout ("Alpha Cutout", Float) = 0
        _Cutoff ("Alpha Cutoff", Range(0,1)) = 0.5
        [Toggle(_LIGHTMAP)] _UseLightmap ("Use Lightmap (vertex colour)", Float) = 0
        [Toggle(_PROPLIGHT)] _UsePropLight ("PS2 Prop Light (sRGB / 256)", Float) = 0
        _LightmapGain ("Lightmap Gain", Range(0,8)) = 2
        _LightmapStrength ("Lightmap Strength", Range(0,1)) = 1
        _LightmapContrast ("Lightmap Contrast (gamma)", Range(1,4)) = 2.2
        [Toggle(_DIRLIGHT)] _UseDirLight ("Directional Light (spinning props)", Float) = 0
        // Exact per-instance record for shared meshes. Values are raw VECTORS: SetColor would convert the /256 factors.
        _InstAmbient ("Instanced Ambient (per-instance)", Vector) = (1,1,1,1)
        _InstKey1 ("Instanced Key 1", Vector) = (0,0,0,1)
        _InstKey2 ("Instanced Key 2", Vector) = (0,0,0,1)
        _InstKey3 ("Instanced Key 3", Vector) = (0,0,0,1)
        _InstDir1 ("Instanced Direction 1", Vector) = (0,1,0,0)
        _InstDir2 ("Instanced Direction 2", Vector) = (0,1,0,0)
        _InstDir3 ("Instanced Direction 3", Vector) = (0,1,0,0)
        _LightmapTex ("Lightmap Atlas", 2D) = "white" {}
        _LmBaseScale ("Lightmap GS: base scale (C_D)", Range(0,2)) = 0.5
        _LmSrcScale  ("Lightmap GS: source scale (C_S)", Range(0,4)) = 1.0
        _LmAsScale   ("Lightmap GS: alpha scale (A_S*255/128)", Range(0,4)) = 1.9921875
        _ScrollSpeed ("UV Scroll Speed (xy/sec)", Vector) = (0,0,0,0)
        _ScrollCycle ("UV Scroll Mode/Active/Pause/Lifetime", Vector) = (0,1,0,0)
        [Toggle(_WIND)] _UseWind ("Wind Sway", Float) = 0
        _WindStrength ("Wind Strength (world m)", Range(0,3)) = 0.2
        _WindSpeed ("Wind Speed", Range(0,10)) = 2
        _WindFreq ("Wind Spatial Freq", Range(0,1)) = 0.15
        [Enum(UnityEngine.Rendering.BlendMode)] _SrcBlend ("Src Blend", Float) = 1
        [Enum(UnityEngine.Rendering.BlendMode)] _DstBlend ("Dst Blend", Float) = 0
        [Enum(Off,0,On,1)] _ZWrite ("ZWrite", Float) = 1
        [Enum(Off,0,On,1)] _AlphaToMask ("Alpha To Coverage", Float) = 0
    }
    SubShader
    {
        // "RenderPipeline"="UniversalPipeline" makes URP pick this SubShader; the LightMode below puts the
        // pass in URP's forward opaque/transparent loop. RenderType/Queue mirror the Built-in original so the
        // importer's renderQueue writes (AlphaTest 2450 / Transparent 3000) still sort correctly.
        Tags { "RenderType"="Opaque" "Queue"="Geometry" "RenderPipeline"="UniversalPipeline" }
        Cull Off
        Blend [_SrcBlend] [_DstBlend]
        ZWrite [_ZWrite]
        AlphaToMask [_AlphaToMask]
        Pass
        {
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma shader_feature_local _CUTOUT
            #pragma shader_feature_local _LIGHTMAP
            #pragma shader_feature_local _PROPLIGHT
            #pragma shader_feature_local _LIGHTMAP_GS
            #pragma shader_feature_local _DIRLIGHT
            // Instanced variant: ambient + all three key/direction pairs come from a MaterialPropertyBlock
            // instead of vertex COLOR/TEXCOORD2..7, so a whole row of
            // identical props (parking meters, pylons, trick gems) shares ONE mesh and GPU-instances into a single
            // draw while each keeps its own SSX light colour. Enabled with _DIRLIGHT by the importer (docs/012).
            #pragma shader_feature_local _DIRLIGHT_INST
            #pragma shader_feature_local _WIND
            #pragma shader_feature_local _TEXARRAY
            #pragma target 3.5
            #pragma multi_compile_instancing
            #pragma multi_compile_fog

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "../../Importer/Shaders/UvScroll.hlsl"

            struct Attributes
            {
                float4 positionOS : POSITION;
                float4 uv         : TEXCOORD0;   // xy = tex uv, z = array slice (_TEXARRAY), w = wind flap weight (_WIND)
                float2 uv1        : TEXCOORD1;   // lightmap atlas uv
                half4  color      : COLOR;
                #ifdef _DIRLIGHT
                float3 normalOS   : NORMAL;
                #ifndef _DIRLIGHT_INST
                float3 key1 : TEXCOORD2; float3 key2 : TEXCOORD3; float3 key3 : TEXCOORD4;
                float3 dir1 : TEXCOORD5; float3 dir2 : TEXCOORD6; float3 dir3 : TEXCOORD7;
                #endif
                #endif
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };
            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv         : TEXCOORD0;
                float2 uv2        : TEXCOORD1;   // lightmap uv
                half4  color      : COLOR;
                float  fogCoord   : TEXCOORD2;
                #ifdef _DIRLIGHT
                float3 worldNormal : TEXCOORD3;
                #ifndef _DIRLIGHT_INST
                float3 key1 : TEXCOORD4; float3 key2 : TEXCOORD5; float3 key3 : TEXCOORD6;
                float3 dir1 : TEXCOORD7; float3 dir2 : TEXCOORD8; float3 dir3 : TEXCOORD9;
                #endif
                #endif
                #ifdef _TEXARRAY
                #if defined(_DIRLIGHT) && !defined(_DIRLIGHT_INST)
                float slice : TEXCOORD10;
                #elif defined(_DIRLIGHT)
                float slice : TEXCOORD4;
                #else
                float slice : TEXCOORD3;
                #endif
                #endif
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            TEXTURE2D(_MainTex);            SAMPLER(sampler_MainTex);
            TEXTURE2D_ARRAY(_MainTexArray); SAMPLER(sampler_MainTexArray);
            TEXTURE2D(_LightmapTex);        SAMPLER(sampler_LightmapTex);

            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                float  _Cutoff;
                float  _LightmapGain, _LightmapStrength, _LightmapContrast;
                float  _LmBaseScale, _LmSrcScale, _LmAsScale;
                float4 _ScrollSpeed;
                float4 _ScrollCycle;
                float  _WindStrength, _WindSpeed, _WindFreq;
                // Declared so the material is SRP-batcher compatible even though these drive shaderlab state /
                // keyword toggles rather than being read in HLSL.
                float  _UseTexArray, _UseCutout, _UseLightmap, _UsePropLight, _UseDirLight, _UseWind;
                float  _SrcBlend, _DstBlend, _ZWrite, _AlphaToMask;
            CBUFFER_END

            // Exact per-instance lighting for shared meshes, pushed as raw vectors by a MaterialPropertyBlock.
            // SCOPED to the _DIRLIGHT_INST variant (that variant is always drawn instanced): declaring a non-
            // UnityPerMaterial cbuffer unconditionally would drop SRP-batcher compatibility on the terrain / plain-prop
            // variants too, so the terrain loses batching for a buffer it never reads. (The Built-in twin declares it
            // unconditionally - Built-in has no SRP batcher, so it needs no guard; this is a URP-only divergence.)
            #ifdef _DIRLIGHT_INST
            UNITY_INSTANCING_BUFFER_START(Props)
                UNITY_DEFINE_INSTANCED_PROP(float4, _InstAmbient)
                UNITY_DEFINE_INSTANCED_PROP(float4, _InstKey1)
                UNITY_DEFINE_INSTANCED_PROP(float4, _InstKey2)
                UNITY_DEFINE_INSTANCED_PROP(float4, _InstKey3)
                UNITY_DEFINE_INSTANCED_PROP(float4, _InstDir1)
                UNITY_DEFINE_INSTANCED_PROP(float4, _InstDir2)
                UNITY_DEFINE_INSTANCED_PROP(float4, _InstDir3)
            UNITY_INSTANCING_BUFFER_END(Props)
            #endif

            // sRGB<->linear for the GS blend. The PS2 GS worked in display (gamma) space; under a Linear
            // project we convert in/out so the blend matches. These are Unity's own LinearToGammaSpace /
            // GammaToLinearSpace polynomial approximations, inlined so there's no ShaderLibrary header
            // dependency (the URP Color.hlsl symbol names vary by version).
            float3 ToGamma(float3 c)  { return max(1.055 * pow(max(c, 0.0), 0.416666667) - 0.055, 0.0); }
            float3 ToLinear(float3 c) { return c * (c * (c * 0.305306011 + 0.682171111) + 0.012522878); }
            float3 PropModulate(float3 textureLinear, float3 factor)
            {
                factor = saturate(factor);
                #ifdef UNITY_COLORSPACE_GAMMA
                return saturate(textureLinear * factor);
                #else
                return ToLinear(saturate(ToGamma(textureLinear) * factor));
                #endif
            }

            Varyings vert (Attributes v)
            {
                Varyings o = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(v);
                UNITY_TRANSFER_INSTANCE_ID(v, o);

                float3 posOS = v.positionOS.xyz;
                #ifdef _WIND
                // Sway the vertex HORIZONTALLY in world space by a per-location sine, scaled by the flap weight
                // in UV0.w (0 = anchored base, 1 = free tip). World-phased so neighbours ripple out of sync;
                // converted back to object space so the amount stays world-consistent under the level scale.
                float _wgt = v.uv.w;
                float _wt = _Time.y * _WindSpeed;
                float3 _wwp = mul(GetObjectToWorldMatrix(), float4(posOS, 1.0)).xyz;
                float _ws = (_wwp.x + _wwp.z) * _WindFreq + _wt;
                float3 _woff = float3(sin(_ws) + sin(_ws * 2.3) * 0.35, 0.0, cos(_ws * 1.7) * 0.5) * (_WindStrength * _wgt);
                posOS += mul((float3x3)GetWorldToObjectMatrix(), _woff);
                #endif

                o.positionCS = TransformObjectToHClip(posOS);
                o.uv = TRANSFORM_TEX(v.uv.xy, _MainTex)
                     + UvScrollElapsed(_Time.y, _ScrollCycle) * _ScrollSpeed.xy;
                o.uv2 = v.uv1;
                o.color = v.color;
                o.fogCoord = ComputeFogFactor(o.positionCS.z);
                #ifdef _TEXARRAY
                o.slice = v.uv.z;
                #endif
                #ifdef _DIRLIGHT
                o.worldNormal = TransformObjectToWorldNormal(v.normalOS);
                #ifndef _DIRLIGHT_INST
                o.key1 = v.key1; o.key2 = v.key2; o.key3 = v.key3;
                o.dir1 = v.dir1; o.dir2 = v.dir2; o.dir3 = v.dir3;
                #endif
                #endif
                return o;
            }

            half4 frag (Varyings i) : SV_Target
            {
                UNITY_SETUP_INSTANCE_ID(i);
                #ifdef _TEXARRAY
                half4 c = SAMPLE_TEXTURE2D_ARRAY(_MainTexArray, sampler_MainTexArray, i.uv, i.slice);
                #else
                half4 c = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv);
                #endif
                #ifdef _CUTOUT
                clip(c.a - _Cutoff);
                #endif
                #ifdef _LIGHTMAP
                #ifdef _PROPLIGHT
                float3 staticPropLit = PropModulate(c.rgb, i.color.rgb * _LightmapGain);
                c.rgb = lerp(c.rgb, staticPropLit, _LightmapStrength);
                #else
                float3 vcol = pow(saturate(i.color.rgb), _LightmapContrast);
                c.rgb *= lerp(float3(1,1,1), saturate(vcol * _LightmapGain), _LightmapStrength);
                #endif
                #endif
                #ifdef _LIGHTMAP_GS
                // Authentic GS terrain lighting: the game computed (C_D - C_S) x A_S/128 in gamma space, where
                // C_D = the half-bright base texel, C_S = atlas RGB, A_S = atlas alpha. Undo the x2 export
                // brighten (_LmBaseScale 0.5) and apply the GS alpha factor (_LmAsScale 255/128). Blend in
                // gamma space then back to linear.
                float4 lm = SAMPLE_TEXTURE2D(_LightmapTex, sampler_LightmapTex, i.uv2);
                #ifdef UNITY_COLORSPACE_GAMMA
                float3 cdG = c.rgb;
                #else
                float3 cdG = ToGamma(c.rgb);
                #endif
                float3 litG = saturate((cdG * _LmBaseScale - lm.rgb * _LmSrcScale) * (lm.a * _LmAsScale));
                #ifdef UNITY_COLORSPACE_GAMMA
                float3 lit = litG;
                #else
                float3 lit = ToLinear(litG);
                #endif
                c.rgb = lerp(c.rgb, lit, _LightmapStrength);
                #endif
                #ifdef _DIRLIGHT
                #ifdef _DIRLIGHT_INST
                float3 _ambCol = UNITY_ACCESS_INSTANCED_PROP(Props, _InstAmbient).rgb;
                float3 _key1 = UNITY_ACCESS_INSTANCED_PROP(Props, _InstKey1).rgb;
                float3 _key2 = UNITY_ACCESS_INSTANCED_PROP(Props, _InstKey2).rgb;
                float3 _key3 = UNITY_ACCESS_INSTANCED_PROP(Props, _InstKey3).rgb;
                float3 _dir1 = UNITY_ACCESS_INSTANCED_PROP(Props, _InstDir1).xyz;
                float3 _dir2 = UNITY_ACCESS_INSTANCED_PROP(Props, _InstDir2).xyz;
                float3 _dir3 = UNITY_ACCESS_INSTANCED_PROP(Props, _InstDir3).xyz;
                #else
                float3 _ambCol = i.color.rgb;
                float3 _key1 = i.key1; float3 _key2 = i.key2; float3 _key3 = i.key3;
                float3 _dir1 = i.dir1; float3 _dir2 = i.dir2; float3 _dir3 = i.dir3;
                #endif
                float3 _n = normalize(i.worldNormal);
                float3 litcol = _ambCol
                    + _key1 * max(0.0, dot(_n, normalize(_dir1)))
                    + _key2 * max(0.0, dot(_n, normalize(_dir2)))
                    + _key3 * max(0.0, dot(_n, normalize(_dir3)));
                float3 dynamicPropLit = PropModulate(c.rgb, litcol * _LightmapGain);
                c.rgb = lerp(c.rgb, dynamicPropLit, _LightmapStrength);
                #endif
                c.rgb = MixFog(c.rgb, i.fogCoord);
                return c;
            }
            ENDHLSL
        }
    }
}
