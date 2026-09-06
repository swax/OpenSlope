// Camera-facing billboard sprite shader for SSX particle effects (the fog clouds, and later snow/spray).
// The importer's ParticleBuilder bakes each puff as a 4-vertex quad whose four corners SHARE one centre
// position (the puff's spot in the level) and carry their corner OFFSET - already in world units - in
// TEXCOORD1. The vertex program places that centre in view space, then pushes the corners apart on the
// view plane, so every quad always faces the camera: in the game view, in mirrors, in any reflection
// probe, with NO per-frame script (it just works in a VRChat build). Because the offset is added in view
// space (unscaled world units) the billboard size is independent of the root's -90deg/x0.01 transform.
// Unlit + alpha-blended (ZWrite off, drawn in the Transparent queue) to match how SSX drew its soft fog.
// FOG-AWARE: the puff blends toward the scene fog colour with distance (like the fogged terrain), so the far
// Fog_*/DrawInPatch banks dissolve into the same haze instead of staying crisp over it. See docs/unity/014-particles.md.
Shader "OpenSlope/Particle"
{
    Properties
    {
        _MainTex ("Sprite", 2D) = "white" {}
        _Tint ("Tint", Color) = (1,1,1,1)
        _Alpha ("Alpha", Range(0,4)) = 1
        // NEAR FADE (docs/unity/014-particles.md): distance at which a puff reaches full opacity, expressed in
        // multiples of that puff's OWN radius, so one constant serves every bank (Aloha's tunnel puffs are 17.6 m,
        // the shortcut banks 9.6-12.4 m). 0 disables. See the vertex program for why this is a fill-rate fix and
        // not just a cosmetic fade.
        //
        // DEFAULTED OFF. Hardware does fade a bank on approach - measured on the PHOTOMETER fixture at
        // 0.578 opacity 39.5 m out against 0.047 at 17.3 m - so this effect is faithful. It is off because the
        // SHAPE of that falloff is not pinned (one frame at 19.1 m read 0.514), and because it currently
        // compensates for two unrelated errors: our fog reads half strength (the stored alpha caps at 128 =
        // fully opaque on GS, and neither port applies the x2) and carries a blue tint hardware does not have.
        // Tuning a fade against a fog that is wrong twice over would bake both in.
        _NearFade ("Near fade (x puff radius)", Range(0,4)) = 0
        // Inner edge of the fade band, as a fraction of _NearFade. Inside it the puff is fully transparent AND its
        // quad is collapsed to zero area, so it costs no fill at all - that cutoff is the point of the whole thing.
        _NearFadeInner ("Near fade inner cutoff (x _NearFade)", Range(0,0.95)) = 0.5
    }
    SubShader
    {
        Tags { "Queue"="Transparent" "RenderType"="Transparent" "IgnoreProjector"="True" "PreviewType"="Plane" }
        Cull Off
        Lighting Off
        ZWrite Off
        Blend SrcAlpha OneMinusSrcAlpha
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma multi_compile_fog
            #include "UnityCG.cginc"

            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; float2 off : TEXCOORD1; };
            struct v2f { float4 vertex : SV_POSITION; float2 uv : TEXCOORD0; float fade : TEXCOORD2; UNITY_FOG_COORDS(1) };

            sampler2D _MainTex;
            float4 _MainTex_ST;
            fixed4 _Tint;
            float _Alpha;
            float _NearFade;
            float _NearFadeInner;

            v2f vert (appdata v)
            {
                v2f o;
                // Shared centre -> view space (the model matrix puts it at the right world spot), then spread
                // the four corners on the view plane so the quad faces the camera. off is pre-scaled to world
                // units by the importer, and view space is unscaled, so the root's scale/rotation don't skew it.
                float4 viewPos = mul(UNITY_MATRIX_MV, float4(v.vertex.xyz, 1.0));

                // NEAR FADE. A puff is a camera-facing sprite, so once the camera is INSIDE it the quad covers the
                // whole viewport - and these banks overlap (Aloha's tunnel: 61 puffs within 250 m summing to ~20x
                // viewport). ZWrite is off, so every one of those layers shades every pixel it covers: on Quest
                // that is the whole cost of riding the tunnel. Fade a puff out as its CENTRE approaches the eye
                // (measured before the corner spread), scaled by the puff's own radius so one constant fits banks
                // of different sizes.
                // The band runs from `inner` (alpha exactly 0) out to `outer` (alpha 1), both measured in multiples
                // of the puff's own radius. A soft ramp that merely THINS the near puffs is not a fill fix - an
                // alpha of 0.1 still shades and blends every pixel the sprite covers - so the band is shaped to
                // reach exactly zero at a distance that is still large (half the fade distance: ~17 m for a tunnel
                // puff), and the quad is collapsed there. Alpha is already 0 at the collapse point, so nothing pops.
                float radius = max(1e-4, length(v.off));
                float outer  = radius * _NearFade;
                float inner  = outer * _NearFadeInner;
                float fade   = (_NearFade > 0.0)
                             ? saturate((-viewPos.z - inner) / max(1e-4, outer - inner))
                             : 1.0;
                // Zero-area quad -> the rasteriser emits no fragments at all. This is the actual saving.
                viewPos.xy += v.off * step(1e-4, fade);

                o.vertex = mul(UNITY_MATRIX_P, viewPos);
                o.uv = TRANSFORM_TEX(v.uv, _MainTex);
                o.fade = fade;
                // Fog on the SPREAD corner (o.vertex carries its true depth), not the shared centre, so the puff
                // dissolves into the scene haze at the same distance the terrain does.
                UNITY_TRANSFER_FOG(o, o.vertex);
                return o;
            }

            fixed4 frag (v2f i) : SV_Target
            {
                fixed4 c = tex2D(_MainTex, i.uv) * _Tint;
                c.a *= _Alpha * i.fade;
                // Lerp the puff colour toward the scene fog colour with distance (alpha kept), so far banks fade
                // into the same haze as the fogged terrain. Near puffs (fog factor ~1) are unchanged - their
                // dimming comes from _Tint. No-op when RenderSettings fog is off (FOG_OFF variant).
                UNITY_APPLY_FOG_COLOR(i.fogCoord, c, unity_FogColor);
                return c;
            }
            ENDCG
        }
    }
}
