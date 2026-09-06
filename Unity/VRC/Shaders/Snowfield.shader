// Fully shader-driven falling-snow field (SnowfallU / OpenSlope/Setup/Snowfall) - the whole ambient-snowfall behaviour
// (fall, drift, camera-centred toroidal wrap, camera-position billboarding) evaluated in the VERTEX shader from
// _Time + the camera position, over one static baked mesh of flake quads. There is no ParticleSystem and no
// per-frame CPU/Udon work: each flake's position is a pure function of time, and the wrap (frac() around the
// camera) is the engine's cell recycle - flakes are world-fixed (ride-through parallax) yet the box is always full
// around the viewer. See docs/044-snowfall.md.
//
// Mesh contract (baked by SnowfallSetup):
//   vertex.xyz = the flake's random base position in the UNIT box [0,1)^3 (identical on all 4 corners of a quad)
//   uv0        = quad corner offset in {-0.5,+0.5}^2 (doubles as the fragment falloff UV)
//   uv1        = per-flake randoms in [0,1): x=fall speed, y=size, z/w=horizontal drift velocity
// The object transform is IGNORED - vertex positions are flake data, not geometry - hence DisableBatching (static
// batching would pre-transform the verts) and the mesh's huge baked bounds (it must never be frustum-culled).
//
// SSX draws the weather snow as bank sprite `str2` (a soft star) additively; at the tiny render size + PS2 bilinear
// it reads as a soft, faint, translucent BLURRY DOT. The fragment generates that dot procedurally - a smooth
// polynomial dome in half precision (mobile-friendly: no exp, no highp, and it reaches exactly 0 inside the quad so
// the border adds nothing). A night snow course wants additive flakes (Blend SrcAlpha One) - a low
// boost + low alpha keeps them a faint glow you see through, not stark white.
Shader "OpenSlope/Snowfield"
{
    Properties
    {
        _TintColor ("Tint", Color) = (1,1,1,1)
        _Alpha ("Flake alpha", Range(0,1)) = 0.5
        _Boost ("Brightness", Range(0,4)) = 0.6
        _Intensity ("Snowfall amount", Range(0,2)) = 1
        _Softness ("Softness (blur)", Range(0.05,1)) = 0.55
        _BoxSize ("Wrap box size (m)", Vector) = (40,34,40,0)
        _BoxLift ("Box centre above camera (m)", Float) = 5
        _FallSpeed ("Fall speed min/max (m/s)", Vector) = (2.2,4.0,0,0)
        _Drift ("Horizontal drift max (m/s)", Float) = 0.7
        _FlakeSize ("Flake size min/max (m)", Vector) = (0.10,0.30,0,0)
        _NearFade ("Near fade start/end (m)", Vector) = (0.25,0.6,0,0)
        _EdgeFade ("Edge fade band (fraction of half-box)", Range(0.02,0.5)) = 0.2
    }
    SubShader
    {
        Tags { "Queue"="Transparent" "RenderType"="Transparent" "IgnoreProjector"="True" "DisableBatching"="True" "PreviewType"="Plane" }
        Blend SrcAlpha One          // additive (alpha-weighted): out.rgb = src.rgb*src.a + dst.rgb
        Cull Off
        Lighting Off
        ZWrite Off

        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            fixed4 _TintColor;
            half _Alpha;
            half _Boost;
            float _Intensity;
            half _Softness;
            float4 _BoxSize;
            float _BoxLift;
            float4 _FallSpeed;
            float _Drift;
            float4 _FlakeSize;
            float4 _NearFade;
            float _EdgeFade;

            struct appdata
            {
                float4 vertex : POSITION;    // flake base position in the unit box (data, not geometry)
                float2 corner : TEXCOORD0;   // quad corner in {-0.5,+0.5}^2
                float4 rnd    : TEXCOORD1;   // per-flake randoms [0,1)
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };
            struct v2f
            {
                float4 pos : SV_POSITION;
                float2 uv  : TEXCOORD0;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            v2f vert (appdata v)
            {
                v2f o;
                UNITY_SETUP_INSTANCE_ID(v);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(o);

                float3 box = _BoxSize.xyz;
                float t = _Time.y;

                // Per-flake parameters from the baked randoms.
                float fall   = lerp(_FallSpeed.x, _FallSpeed.y, v.rnd.x);
                float size   = lerp(_FlakeSize.x, _FlakeSize.y, v.rnd.y);
                float2 drift = (v.rnd.zw * 2.0 - 1.0) * _Drift;

                // _Intensity (the game's front-end "Snow fall:" 0.5..2.0 amount, docs/044): below 1, THIN the field
                // by culling flakes (a per-flake hash vs the density) for a lighter fall; above 1, keep them all and
                // GROW the flakes for a heavier fall. 1.0 = the full baked field, unchanged. A culled flake gets size
                // 0, so its quad collapses to a point and isn't drawn (same graceful path as the edge/near fades).
                // The hash is on the baked base position (identical on all 4 corners), so a quad culls as a whole.
                float density = saturate(_Intensity);
                float keep = frac(sin(dot(v.vertex.xyz, float3(12.9898, 78.233, 37.719))) * 43758.5453);
                size *= step(keep, density) * (1.0 + 0.35 * max(_Intensity - 1.0, 0.0));

                // World-fixed flake path: a pure function of time, no simulation state anywhere.
                float3 p = v.vertex.xyz * box;
                p.y  -= fall * t;
                p.xz += drift * t;

                // Wrap centre = centre-eye camera + lift. Both eyes must agree on the wrap cell (an edge flake must
                // not land in different cells per eye); under stereo _WorldSpaceCameraPos is per-eye, so average.
                #if defined(USING_STEREO_MATRICES)
                float3 cam = (unity_StereoWorldSpaceCameraPos[0].xyz + unity_StereoWorldSpaceCameraPos[1].xyz) * 0.5;
                #else
                float3 cam = _WorldSpaceCameraPos.xyz;
                #endif
                float3 c = cam + float3(0.0, _BoxLift, 0.0);

                // Toroidal wrap into the box centred on c - the game's cell recycle. frac() re-centres the
                // offset into [-box/2,+box/2): a mid-box flake is untouched (ride-through parallax), an off-edge
                // flake reappears on the opposite face. Wraps the flake CENTRE only (all four corners share
                // v.vertex; the corner offset is added after), so a quad never straddles a wrap.
                float3 off = (frac((p - c) / box + 0.5) - 0.5) * box;
                float3 world = c + off;

                // Edge fade: shrink flakes to nothing over the outer _EdgeFade band of the box, so the wrap
                // teleport always happens while the flake is invisible (riding fast otherwise pops flakes in at
                // the leading face). Shrinking - not alpha - needs no extra interpolator, and an additive soft
                // dot's light scales with its area, so the linear shrink reads as a smooth fade-in/out.
                float3 edge = abs(off) / (box * 0.5);                 // 0 at box centre -> 1 at a face, per axis
                float e = max(edge.x, max(edge.y, edge.z));           // distance to the NEAREST face
                float fade = saturate((1.0 - e) / _EdgeFade);
                size *= fade * fade * (3.0 - 2.0 * fade);             // smoothstep: no kink entering the band

                // Collapse flakes about to pass through the camera: an arm's-length flake is an unfocusable
                // full-screen flash and the worst fill-rate case, so it shrinks to nothing just before it hits.
                float dist = length(world - cam);
                size *= saturate((dist - _NearFade.x) / max(_NearFade.y - _NearFade.x, 0.01));

                // Billboard facing the camera POSITION with world up (Facing, not View: flakes don't roll when you
                // tilt your head in VR). Looking straight up/down degrades the cross toward zero length, which just
                // shrinks the flake - graceful. No spin: the dot is radially symmetric, so spin would be invisible
                // (swap in a textured star and it needs a per-flake UV rotation here).
                float3 fwd   = (cam - world) / max(dist, 0.001);
                float3 axis  = cross(float3(0.0, 1.0, 0.0), fwd);
                float3 right = axis / max(length(axis), 0.001);
                float3 up    = cross(fwd, right);
                world += (right * v.corner.x + up * v.corner.y) * size;

                o.pos = UnityWorldToClipPos(world);
                o.uv = v.corner + 0.5;
                return o;
            }

            fixed4 frag (v2f i) : SV_Target
            {
                // Soft round dot: a smooth polynomial dome from the quad centre (no hard edges at any size).
                // _Softness widens the dome; alpha reaches exactly 0 at r2 = _Softness, inside the quad.
                half2 d = (half2)i.uv - (half)0.5;
                half r2 = dot(d, d) * (half)4.0;                  // 0 at centre, 1 at edge midpoints
                half f = saturate((half)1.0 - r2 / _Softness);
                half4 c = (half4)_TintColor;
                c.a *= _Alpha * f * f;
                c.rgb *= _Boost;          // Blend SrcAlpha One multiplies rgb by c.a, so faint texels add little
                return c;
            }
            ENDCG
        }
    }
}
