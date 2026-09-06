// Unlit emissive screen shader for the video billboards (docs/vrchat/041-video-billboards.md). A VRCAVProVideoScreen
// writes the decoded video frame into this material's _MainTex every frame; every billboard quad that shares this
// one material then displays the same stream (one AVPro player -> one shared material -> many screens).
//
// Unlit (no scene lighting) so the screen reads at full brightness like a real display - it doesn't darken in the
// mountain's shade the way a Standard/surface shader would. Cull Off because the catalog quads are double-sided.
// Defaults match VRChat's own Video/RealtimeEmissiveGamma path: NO vertical flip and NO gamma (the AVPro player
// already normalises orientation, and _ApplyGamma is 0 on the SDK's screen material) - both are exposed as toggles
// in case a particular source/platform needs them. _MainTex defaults to black so a screen reads dark before the
// stream loads instead of glaring white.
Shader "OpenSlope/VideoScreen"
{
    Properties
    {
        _MainTex ("Video (RGB)", 2D) = "black" {}
        _Emission ("Brightness", Float) = 1
        [Toggle(_FLIP_V)] _FlipV ("Flip Vertically", Float) = 0
        [Toggle(_APPLY_GAMMA)] _ApplyGamma ("Apply Gamma (linearise)", Float) = 0
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" "Queue"="Geometry" }
        Cull Off
        // Keep the video decisively in front of the billboard face at kilometre-scale view distances, where
        // both surfaces can otherwise quantize to the same depth value despite their physical 0.1 m gap.
        Offset -1, -1
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma shader_feature_local _FLIP_V
            #pragma shader_feature_local _APPLY_GAMMA
            // Distance fog so a far screen fades into the same horizon haze as the rest of the world (the OpenSlope
            // unlit terrain/props carry fog too - see Unlit). Unlit shaders get no fog for free.
            #pragma multi_compile_fog
            #include "UnityCG.cginc"

            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f { float2 uv : TEXCOORD0; UNITY_FOG_COORDS(1) float4 vertex : SV_POSITION; };

            sampler2D _MainTex;
            float4 _MainTex_ST;
            float _Emission;

            v2f vert (appdata v)
            {
                v2f o;
                o.vertex = UnityObjectToClipPos(v.vertex);
                o.uv = TRANSFORM_TEX(v.uv, _MainTex);
                #ifdef _FLIP_V
                o.uv.y = 1.0 - o.uv.y;
                #endif
                UNITY_TRANSFER_FOG(o, o.vertex);
                return o;
            }

            fixed4 frag (v2f i) : SV_Target
            {
                fixed4 c = tex2D(_MainTex, i.uv);
                #ifdef _APPLY_GAMMA
                c.rgb = pow(c.rgb, 2.2);
                #endif
                c.rgb *= _Emission;
                UNITY_APPLY_FOG(i.fogCoord, c);
                return c;
            }
            ENDCG
        }
    }
}
