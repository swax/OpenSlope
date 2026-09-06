// SSX's celestial glare: one white corona billboard plus one depth-blind screen-space ray fan
// ([Trailmap: 400-rendering], [Unity: 046-sun-god-rays]). The two primitives use different authored
// colours/intensities and different GS transfer gains. There is no submitted fixed core, star, or ring.
//
// The importer combines both primitives in one mesh. position.z tags them (0 = fan, 1 = corona), while
// the corona quad's UVs address only the top-right 128x128 tile of PARTICLE.SSH `lens`. Desktop keeps the
// retail screen-filling fan. Stereo forces only the FAN to the fixed-angle billboard compromise; the corona
// is always the authored-radius camera-facing billboard used by retail.
Shader "OpenSlope/SunGodRays"
{
    Properties
    {
        // Vector, not Color: these are normalized GS display bytes. A Color property is converted to linear
        // before the shader in a linear project, even when the builder writes it with Material.SetVector.
        _CoreColor       ("Fan colour (raw World.json CoreColour)", Vector) = (1, 0.49, 0.09, 1)
        _RimColor        ("Corona tint (raw World.json RimColour)", Vector) = (0.6, 0.43, 0.04, 1)
        _FanIntensity    ("Fan intensity (World.json)", Range(0, 4)) = 0.7
        _SpriteIntensity ("Corona intensity (World.json)", Range(0, 4)) = 0.7
        _Intensity       ("Master intensity", Range(0, 4)) = 1
        _Visibility      ("Source visibility", Range(0, 1)) = 1

        // Exact normalized equivalents of the paused-Mesa GS paths. Hidden because these are renderer
        // transfer constants, not course-authored tuning; the builder writes them explicitly as well.
        [HideInInspector] _FanDisplayGain    ("Fan GS display gain", Float) = 0.5019608
        [HideInInspector] _CoronaDisplayGain ("Corona GS display gain", Float) = 1.9921875

        _CoronaTex    ("Corona atlas (lens, top-right tile)", 2D) = "black" {}
        _Distance     ("Sun distance (m)", Float) = 320
        _CoronaRadius ("Corona radius (m)", Float) = 90

        // Billboard-only fan reach. Retail desktop instead runs every spoke to the current screen border.
        _AngularRadius ("VR fan reach (deg)", Range(2, 89)) = 40
        _EdgeStart     ("VR fan edge fade start", Range(0.2, 1)) = 0.72
        _ScreenFill    ("Screen-fill fan (1 = retail desktop)", Range(0, 1)) = 1
        _FalloffClamp  ("Fan falloff clamp (retail = 3)", Range(0.25, 8)) = 3
    }

    SubShader
    {
        Tags { "Queue"="Transparent+100" "RenderType"="Transparent" "IgnoreProjector"="True" "PreviewType"="Plane" "RenderPipeline"="UniversalPipeline" }
        Blend One One
        ZWrite Off
        ZTest Always
        Cull Off

        Pass
        {
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma shader_feature_local _CORONATEX
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            struct appdata
            {
                float4 vertex : POSITION; // xy = local direction/corner; z = 0 fan, 1 corona
                half4 color   : COLOR;    // fan spoke amplitude in alpha
                float2 uv     : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct v2f
            {
                float4 pos    : SV_POSITION;
                // x = fan radius, y = spoke amplitude, z = corona tag, w = screen-fill fan tag
                float4 effect : TEXCOORD0;
                float2 uv     : TEXCOORD1;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            CBUFFER_START(UnityPerMaterial)
                half4 _CoreColor, _RimColor;
                float _FanIntensity, _SpriteIntensity, _Intensity, _Visibility;
                float _FanDisplayGain, _CoronaDisplayGain;
                float _Distance, _CoronaRadius, _AngularRadius, _EdgeStart;
                float _ScreenFill, _FalloffClamp;
            CBUFFER_END
            TEXTURE2D(_CoronaTex); SAMPLER(sampler_CoronaTex);

            v2f vert(appdata v)
            {
                v2f o;
                UNITY_SETUP_INSTANCE_ID(v);
                ZERO_INITIALIZE(v2f, o);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(o);

                float3 sunDir = -normalize(float3(unity_ObjectToWorld._m02,
                                                  unity_ObjectToWorld._m12,
                                                  unity_ObjectToWorld._m22));
                float authoredDistance = max(0.0001, _Distance);
                float dist = min(authoredDistance, _ProjectionParams.z * 0.9);
                float3 centreWS = _WorldSpaceCameraPos + sunDir * dist;
                float4 centreClip = TransformWorldToHClip(centreWS);

                float3 right = normalize(float3(UNITY_MATRIX_V._m00, UNITY_MATRIX_V._m01, UNITY_MATRIX_V._m02));
                float3 up    = normalize(float3(UNITY_MATRIX_V._m10, UNITY_MATRIX_V._m11, UNITY_MATRIX_V._m12));
                float isCorona = step(0.5, v.vertex.z);
                float rimT = saturate(length(v.vertex.xy));

                #if defined(USING_STEREO_MATRICES)
                    bool fill = false;
                #else
                    bool fill = _ScreenFill > 0.5;
                #endif

                // VR-safe fan billboard. Its radius is angular, so pulling the placement under a short far
                // plane leaves its apparent reach unchanged.
                float fanRadius = dist * tan(radians(_AngularRadius));
                float3 planeOffset = right * v.vertex.x + up * v.vertex.y;
                float4 clipBillboard = TransformWorldToHClip(centreWS + planeOffset * fanRadius);

                // Faithful desktop fan: project the source and walk each ray to the nearest NDC border.
                float2 centreNdc = centreClip.xy / max(1e-4, abs(centreClip.w));
                float2 dirNdc = v.vertex.xy;
                float2 safeDir = dirNdc + step(abs(dirNdc), 1e-5) * (step(0.0, dirNdc) * 2.0 - 1.0) * 1e-5;
                float2 tAxis = (sign(safeDir) - centreNdc) / safeDir;
                float t = max(0.0, min(tAxis.x, tAxis.y)) * rimT;
                float2 vertNdc = centreNdc + dirNdc * t;
                float d2 = dot(vertNdc - centreNdc, vertNdc - centreNdc);
                float screenFade = saturate((_FalloffClamp - min(d2, _FalloffClamp)) / _FalloffClamp);
                float w = max(1e-3, abs(centreClip.w));
                float4 clipScreen = float4(vertNdc * w, centreClip.z, w);
                bool sourceInFront = centreClip.w > 1e-4;
                float4 fanClip = (fill && sourceInFront) ? clipScreen : clipBillboard;

                // Retail SizeUnits is a radius/half-extent. If the far plane pulls the sun nearer, shrink the
                // radius by the same ratio to preserve its authored angular size.
                float coronaRadius = _CoronaRadius * (dist / authoredDistance);
                float4 coronaClip = TransformWorldToHClip(centreWS + planeOffset * coronaRadius);

                o.pos = lerp(fanClip, coronaClip, isCorona);
                o.effect = float4(rimT, v.color.a * (fill ? screenFade : 1.0), isCorona, fill ? 1.0 : 0.0);
                o.uv = v.uv;
                return o;
            }

            half4 frag(v2f i) : SV_Target
            {
                float3 rgb;
                if (i.effect.z > 0.5)
                {
                    #ifdef _CORONATEX
                        float corona = SAMPLE_TEXTURE2D(_CoronaTex, sampler_CoronaTex, i.uv).a;
                    #else
                        // The retail top-right tile is almost exactly this inverse-smoothstep disc.
                        float2 disc = (i.uv - 0.75) * 4.0;
                        float corona = 1.0 - smoothstep(0.0, 1.0, length(disc));
                    #endif
                    rgb = _RimColor.rgb * (_SpriteIntensity * _CoronaDisplayGain * corona);
                }
                else
                {
                    float edge = i.effect.w > 0.5 ? 1.0 : 1.0 - smoothstep(_EdgeStart, 1.0, i.effect.x);
                    rgb = _CoreColor.rgb * (_FanIntensity * _FanDisplayGain * i.effect.y * edge);
                }
                return half4(rgb * (_Intensity * _Visibility), 1.0);
            }
            ENDHLSL
        }
    }
    Fallback Off
}
