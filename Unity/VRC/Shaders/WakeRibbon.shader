// Snow-wake ribbon shader for the rideable board (docs/vrchat/017). The wake is a procedural mesh the board rebuilds
// each frame (a ring of cross-sections, like the engine's carved-wake ribbon of quads [Trailmap: 380-carve-effects]). It is NOT a
// painted-over colour - it MODULATES the snow it lies on, so the actual terrain texture/brightness shows through,
// just darkened/lightened in the carved channel:
//
//   Blend DstColor SrcColor  ==  result = 2 * src * dst   (a "soft 2x multiply" / overlay)
//     vertex colour 0.5 -> result = dst  (NO change: the transparent floor + faded tail leave the snow alone)
//     vertex colour <0.5 -> DARKEN the snow underneath   (the shadow wall of the cut)
//     vertex colour >0.5 -> LIGHTEN the snow underneath  (the sun-facing wall)
//
// Because it scales the snow pixel itself, the wake auto-matches SHADE (dark snow darkens proportionally, bright
// snow stays bright) - so the carved line never glows white in a shadowed area, no light-probe sampling needed.
// The runtime bakes the per-vertex value: a depth-driven carved-line THICKNESS, and a light/dark split that
// tracks the WORLD SUN (the groove wall facing away from the sun is the deep shadow, swinging as you carve) -
// RideableBoard.Wake.cs AgeAndRebuildWake. Double-sided + ZWrite off; ZTest LEqual + a polygon Offset so the
// flat ground decal isn't occluded by the snow it lies on yet the DECK still occludes it (the deck is opaque,
// well above the strip). No texture, no fog: the wake is always right under the local rider.
Shader "OpenSlope/WakeRibbon"
{
    Properties
    {
        // Unused placeholder so older materials that still reference a _MainTex deserialize without a warning;
        // the wake is pure vertex-colour.
        _MainTex ("Unused", 2D) = "white" {}
    }
    SubShader
    {
        Tags { "RenderType"="Transparent" "Queue"="Transparent" "IgnoreProjector"="True" }
        Cull Off
        Lighting Off
        ZWrite Off
        ZTest LEqual
        Offset -1, -1
        Blend DstColor SrcColor     // overlay / soft 2x-multiply: 0.5 = neutral, <0.5 darkens the snow, >0.5 lightens it
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            struct appdata { float4 vertex : POSITION; fixed4 color : COLOR; };
            struct v2f { fixed4 color : COLOR; float4 vertex : SV_POSITION; };

            v2f vert (appdata v)
            {
                v2f o;
                o.vertex = UnityObjectToClipPos(v.vertex);
                o.color = v.color;     // runtime-baked: 0.5 neutral, darker = darken snow, brighter = lighten snow
                return o;
            }

            fixed4 frag (v2f i) : SV_Target
            {
                return i.color;        // the overlay blend turns this into 2*color*snow (modulates the snow beneath)
            }
            ENDCG
        }
    }
}
