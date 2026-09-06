// Probe-lit textured shader for the rideable board's deck. Looks identical to OpenSlope/UnlitDoubleSided in full
// light, but it MODULATES the skin by the scene's light probes so the deck darkens in shade in lock-step
// with the rider's avatar (which VRChat also lights from probes). Without this the deck stays full-bright
// while the avatar darkens, so the board reads as "glowing" in shadow. See docs/unity/010-object-lighting.md.
//
// Our probes are ISOTROPIC - authored via SphericalHarmonicsL2.AddAmbientLight, i.e. one flat colour per
// position with no direction (ProbeBuilder/InstanceLighting) - so the L0/DC term ShadeSH9(0,0,0,1) gives the
// board's LOCATION brightness (it darkens moving into shade, in lock-step with the avatar). On top of that we
// add a DIRECTIONAL sun (_DirLightDir, the same world sun the props/gems use, docs/unity/010): N·L against the deck's
// normals modulates that ambient so the top reads lit and the underside shadowed, swinging as the board banks.
// The deck MeshRenderer's lightProbeUsage is BlendProbes (Unity's default for a moving renderer), so Unity
// fills unity_SHA* from the interpolated baked probe at the board's world position - the exact same 2505-probe
// field the avatar samples. (No _CUTOUT/_LIGHTMAP/_ScrollSpeed/instancing paths: the deck is one opaque,
// per-spawn-unique mesh, so it needs none of Unlit's per-material variants.)
Shader "OpenSlope/BoardProbeLit"
{
    Properties
    {
        _MainTex   ("Texture", 2D) = "white" {}
        _LightGain ("Light Gain", Range(0,4)) = 1   // scale on the probe ambient (1 = match the avatar/props; raise to lift the shade floor if the deck reads too dark)
        // Directional sun, same world-space direction the props/gems use (docs/unity/010). Modulates the flat probe
        // ambient by N·L so the deck's top reads lit and its underside shadowed. Default matches PropDirLightDir.
        _DirLightDir ("Dir Light (world)", Vector) = (-0.48, 0.88, 0, 0)
        _DirShade    ("Dir Shade", Range(0,1)) = 0.35   // how much the away-from-sun side darkens (0 = flat)
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" "Queue"="Geometry" }
        Cull Off                                     // double-sided, same as the unlit level shader (import winding-agnostic)
        Pass
        {
            // ForwardBase is REQUIRED: in the Built-in pipeline Unity only binds the per-object light-probe
            // SH (unity_SHAr..C, what ShadeSH9 reads) to a pass that participates in forward lighting. A
            // tag-less pass is the legacy/unlit path and gets ZERO SH - which would render the deck pure black
            // even though the probe at its position is fine. We add NO ForwardAdd pass (we only want the
            // probe ambient, not realtime pixel lights), so the deck still draws exactly once.
            Tags { "LightMode"="ForwardBase" }
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            // Distance fog, same as Unlit - the deck is normally right under the camera (fog ~0), but a
            // far-spawned board should fade with everything else rather than pop.
            #pragma multi_compile_fog
            #include "UnityCG.cginc"

            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; float3 normal : NORMAL; };
            struct v2f { float2 uv : TEXCOORD0; half3 sh : TEXCOORD1; UNITY_FOG_COORDS(2) float4 vertex : SV_POSITION; };

            sampler2D _MainTex;
            float4 _MainTex_ST;
            half _LightGain;
            float4 _DirLightDir;
            half _DirShade;

            v2f vert (appdata v)
            {
                v2f o;
                o.vertex = UnityObjectToClipPos(v.vertex);
                o.uv = TRANSFORM_TEX(v.uv, _MainTex);
                // Flat probe ambient. It's constant across the whole mesh (one interpolated probe per
                // renderer), so resolving it per-vertex is exact and cheap. max() guards the tiny negative
                // lobe SH can produce. In a Linear project ShadeSH9 stays linear; _MainTex samples to linear
                // too, so the multiply below is correct linear-space modulation.
                half3 amb = max(half3(0,0,0), ShadeSH9(half4(0,0,0,1))) * _LightGain;
                // Directional sun: the same world sun the props/gems use (docs/unity/010), MODULATING the probe
                // ambient by N·L. So the deck still tracks location brightness (stays in sync with the avatar)
                // but gains a lit top / shadowed underside that swings as the board banks & pitches. Per-vertex
                // (the deck is low-poly) - Gouraud, like the PS2. The ride-frame remap is a pure rotation (no
                // X-negation/mirror like the props), and Unity's OBJ import gave the deck outward normals, so
                // worldNormal is correct with no flip. _DirShade = how far the away side dims (0 = flat).
                half3 wn  = UnityObjectToWorldNormal(v.normal);
                half  ndl = saturate(dot(normalize(wn), normalize(_DirLightDir.xyz)));
                o.sh = amb * lerp(1.0 - _DirShade, 1.0, ndl);
                UNITY_TRANSFER_FOG(o, o.vertex);
                return o;
            }

            fixed4 frag (v2f i) : SV_Target
            {
                fixed4 c = tex2D(_MainTex, i.uv);
                c.rgb *= i.sh;                        // darken the skin by the probe brightness at this spot
                UNITY_APPLY_FOG(i.fogCoord, c);
                return c;
            }
            ENDCG
        }
    }
}
