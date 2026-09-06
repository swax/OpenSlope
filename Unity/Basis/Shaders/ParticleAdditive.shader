// URP additive shader for the importer's stock-ParticleSystem effects (fireworks, snow-cannon plumes, ambient
// dust/spark/fire bursts). On Built-in RP those emitters render with "Legacy Shaders/Particles/Additive"; that
// shader does not exist in URP, so a ParticleSystem material built with it renders magenta in Basis. The neutral
// EmitterBuilder / AmbientEmitterBuilder / TriggerBuilder now try "OpenSlope/ParticleAdditive" FIRST and fall back to the
// Legacy names, so whichever RP the project uses resolves (the OpenSlope name is absent in a VRChat/Built-in project, so
// that build keeps using Legacy - zero change there).
//
// A ParticleSystemRenderer feeds camera-facing quads already in object space plus each particle's current COLOUR as
// the vertex colour (startColor x colorOverLifetime), so this is a plain unlit texture x vertex-colour shader. Blend
// SrcAlpha One = additive weighted by the particle's alpha, so a spark still fades to nothing as its alpha ramps to 0
// (matches the Legacy additive look the emitters were tuned against). No fog - these are meant to read bright over
// the dark sky / bright snow, and additive fog would just dim them toward black.
Shader "OpenSlope/ParticleAdditive"
{
    Properties
    {
        _MainTex ("Particle Texture", 2D) = "white" {}
    }
    SubShader
    {
        Tags { "Queue"="Transparent" "RenderType"="Transparent" "IgnoreProjector"="True" "PreviewType"="Plane" "RenderPipeline"="UniversalPipeline" }
        Blend SrcAlpha One
        ZWrite Off
        Cull Off
        Pass
        {
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            struct Attributes { float4 positionOS : POSITION; half4 color : COLOR; float2 uv : TEXCOORD0; };
            struct Varyings  { float4 positionCS : SV_POSITION; half4 color : COLOR; float2 uv : TEXCOORD0; };

            TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);
            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
            CBUFFER_END

            Varyings vert (Attributes v)
            {
                Varyings o;
                o.positionCS = TransformObjectToHClip(v.positionOS.xyz);
                o.color = v.color;
                o.uv = TRANSFORM_TEX(v.uv, _MainTex);
                return o;
            }

            half4 frag (Varyings i) : SV_Target
            {
                return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv) * i.color;
            }
            ENDHLSL
        }
    }
}
