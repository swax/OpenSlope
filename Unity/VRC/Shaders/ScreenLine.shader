// OpenSlope/ScreenLine - a line of constant SCREEN width (docs/053).
//
// The engine draws a spline mover's cable as a GS line primitive: 1 pixel wide, whatever the distance. A world-space
// tube can't do that - it fattens into a pipe up close and aliases away over the kilometre a gondola wire spans. So
// the importer lays a zero-width ribbon along the curve (two vertices per sample, UV0.x = which side) and this shader
// gives it its width in CLIP space: it projects a point one unit down the wire, takes the perpendicular of that
// screen-space direction, and pushes each side half a pixel width along it.
//
// Untextured, flat vertex colour x _Color, fogged like the rest of the level.
Shader "OpenSlope/ScreenLine"
{
    Properties
    {
        _Color   ("Tint", Color) = (1,1,1,1)
        _WidthPx ("Width (pixels)", Range(0.5, 16)) = 2
    }

    SubShader
    {
        Tags { "RenderType"="Opaque" "Queue"="Geometry" }
        Cull Off

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_instancing
            #pragma multi_compile_fog
            #include "UnityCG.cginc"

            struct appdata
            {
                float4 vertex : POSITION;
                float3 normal : NORMAL;      // the wire's own direction here, object space
                float2 uv     : TEXCOORD0;   // x: 0 = one side of the line, 1 = the other
                fixed4 color  : COLOR;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct v2f
            {
                float4 pos   : SV_POSITION;
                fixed4 color : COLOR;
                UNITY_FOG_COORDS(0)
                UNITY_VERTEX_OUTPUT_STEREO
            };

            fixed4 _Color;
            float  _WidthPx;

            v2f vert(appdata v)
            {
                v2f o;
                UNITY_SETUP_INSTANCE_ID(v);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(o);

                float4 clip  = UnityObjectToClipPos(v.vertex);
                float4 ahead = UnityObjectToClipPos(v.vertex + float4(v.normal, 0));

                // Where the wire runs on screen, in pixels (the aspect matters, so scale by the viewport).
                float2 a   = clip.xy  / max(abs(clip.w),  1e-5) * _ScreenParams.xy;
                float2 b   = ahead.xy / max(abs(ahead.w), 1e-5) * _ScreenParams.xy;
                float2 dir = b - a;
                dir = (dot(dir, dir) < 1e-8) ? float2(1, 0) : normalize(dir);   // dead-on end view: any perpendicular
                float2 perp = float2(-dir.y, dir.x);

                // Half a width to each side, pixels -> NDC (which spans 2) -> clip (x w).
                float side = v.uv.x * 2.0 - 1.0;
                clip.xy += perp * (side * _WidthPx) / _ScreenParams.xy * clip.w;

                // The vertex colour is the line's FINAL colour, straight off the GS - a gamma-space value. Unlike a
                // vertex colour used as a lighting multiplier, it has to be converted, or a linear project renders the
                // levels' near-black cable as a mid grey. (_Color is a material property, so Unity converts it for us.)
                fixed4 col = v.color;
                #ifndef UNITY_COLORSPACE_GAMMA
                col.rgb = GammaToLinearSpace(col.rgb);
                #endif

                o.pos = clip;
                o.color = col * _Color;
                UNITY_TRANSFER_FOG(o, o.pos);
                return o;
            }

            fixed4 frag(v2f i) : SV_Target
            {
                fixed4 c = i.color;
                UNITY_APPLY_FOG(i.fogCoord, c);
                return c;
            }
            ENDCG
        }
    }

    Fallback "Unlit/Color"
}
