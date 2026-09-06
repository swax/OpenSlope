// URP port of OpenSlope/Particle (the Built-in-RP original lives in ../../VRC/Shaders/Particle.shader). Basis is
// Unity 6 + URP, so the importer's ParticleBuilder - which bakes each fog puff as a billboard quad and builds a
// material via Shader.Find("OpenSlope/Particle") (ImportConfig.ParticleShaderName) - needs a URP shader answering to
// the SAME name + Properties (_MainTex/_Tint/_Alpha) or the fog renders magenta. Same name-collision trick as
// Unlit: only one RP's copy is ever in a given project, so Shader.Find resolves to whichever is present.
//
// Camera-facing with NO per-frame script: each puff is a 4-vertex quad whose corners SHARE one centre position (the
// puff's spot in the level) and carry their corner OFFSET - already in world units - in TEXCOORD1. The vertex program
// places the centre in view space then pushes the corners apart on the view plane, so every quad faces the camera in
// the game view, in mirrors, in any reflection probe. Because the offset is added in view space (unscaled world
// units) the billboard size is independent of the root's -90deg/x0.01 transform. Unlit + alpha-blended (ZWrite off,
// Transparent queue) to match how SSX drew its soft fog. FOG-AWARE (mirrors the Built-in original): the puff blends
// toward the scene fog colour with distance, so far banks dissolve into the same haze as the fogged terrain instead
// of staying crisp over it. See docs/unity/014-particles.md.
Shader "OpenSlope/Particle"
{
    Properties
    {
        _MainTex ("Sprite", 2D) = "white" {}
        _Tint ("Tint", Color) = (1,1,1,1)
        _Alpha ("Alpha", Range(0,4)) = 1
    }
    SubShader
    {
        Tags { "Queue"="Transparent" "RenderType"="Transparent" "IgnoreProjector"="True" "PreviewType"="Plane" "RenderPipeline"="UniversalPipeline" }
        Cull Off
        ZWrite Off
        Blend SrcAlpha OneMinusSrcAlpha
        Pass
        {
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; float2 off : TEXCOORD1; };
            struct Varyings  { float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0; half fogFactor : TEXCOORD1; };

            TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);
            CBUFFER_START(UnityPerMaterial)
                float4 _MainTex_ST;
                half4  _Tint;
                float  _Alpha;
            CBUFFER_END

            Varyings vert (Attributes v)
            {
                Varyings o;
                // Shared centre -> world -> view, then spread the four corners on the view plane so the quad faces the
                // camera. `off` is pre-scaled to world units by the importer and view space is unscaled, so the root's
                // -90/x0.01 doesn't skew the billboard size (the Built-in original did the same with UNITY_MATRIX_MV/P).
                float3 posVS = TransformWorldToView(TransformObjectToWorld(v.positionOS.xyz));
                posVS.xy += v.off;
                o.positionCS = TransformWViewToHClip(posVS);
                o.uv = TRANSFORM_TEX(v.uv, _MainTex);
                // Fog on the spread corner's true depth, so the puff dissolves into the haze like the terrain does.
                o.fogFactor = ComputeFogFactor(o.positionCS.z);
                return o;
            }

            half4 frag (Varyings i) : SV_Target
            {
                half4 c = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv) * _Tint;
                c.a *= _Alpha;
                // Blend toward the scene fog colour with distance (alpha kept): far banks fade into the haze. Near
                // puffs (fog factor ~1) are unchanged - their dimming comes from _Tint. No-op when fog is off.
                c.rgb = MixFog(c.rgb, i.fogFactor);
                return c;
            }
            ENDHLSL
        }
    }
}
