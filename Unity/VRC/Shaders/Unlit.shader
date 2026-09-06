// Double-sided unlit textured shader for exported SSX levels: unlit so textures read at the PS2's
// full brightness, Cull Off so import winding doesn't matter. Optional per-material paths (off by
// default, enabled by the importer):
//   _CUTOUT       - alpha clip for trees/billboards/fences; the importer pairs it with AlphaToMask On so the
//                   holes clip (the no-MSAA fallback) while MSAA coverage anti-aliases the soft edges in a
//                   VRChat upload - no opaque-pass alpha blend, which composited wrong (see docs/unity/005-materials-and-alpha.md)
//   _LIGHTMAP     - modulate by baked VERTEX COLOUR: terrain luminance (fallback) or per-instance
//                   prop light colour (see docs/unity/010-object-lighting.md)
//   _PROPLIGHT     - interpret prop light factors in the PS2's byte/sRGB domain (records use 256 = 1.0)
//   _LIGHTMAP_GS  - terrain lighting: reconstruct the game's PS2 GS blend (C_D - C_S) x A_S per-pixel
//                   from the RGBA lightmap atlas via UV1 (rgb = C_S, alpha = A_S), giving the real
//                   coloured light - cool shadow / warm sun (the terrain path; see docs/unity/007)
//   _ScrollSpeed/_ScrollCycle - native fixed-tick UV motion for water/LCD/jumbotrons (see docs/008-texture-animation.md)
//   _CROWD        - CrowdBox spectators: per-cell cheer schedule computed from _Time over the 16-slice
//                   cd frame array, cell identity in UV1 (see docs/008-texture-animation.md)
Shader "OpenSlope/UnlitDoubleSided"
{
    Properties
    {
        _MainTex ("Texture", 2D) = "white" {}
        // Texture-ARRAY batching (_TEXARRAY): the importer collapses a combined mesh's many per-texture
        // submeshes into ONE draw by stacking their (tiling) textures as slices of a Texture2DArray and
        // baking the slice index per-vertex into UV0.z. Each slice is a full wrapping texture, so the tiled
        // terrain/prop UVs still repeat correctly - unlike a packed atlas. Off by default (single _MainTex).
        [Toggle(_TEXARRAY)] _UseTexArray ("Use Texture Array (batched)", Float) = 0
        _MainTexArray ("Texture Array", 2DArray) = "" {}
        // CrowdBox spectators (_CROWD, docs/008): _MainTexArray holds the 16 shared cd00..cd15 cheer frames
        // and each grid cell of a grandstand picks its OWN current slice per-vertex from _Time - random start
        // phase, one of the four retail motion patterns (rerolled each 16-step cycle), and randomized rests
        // on frame 0 - so neighbouring cells move unevenly like the game, with no script and one draw.
        // UV1 carries (cell id 0..15, stand ordinal), baked by snowknife's PropsBundle.
        [Toggle(_CROWD)] _UseCrowd ("Crowd Cells (CrowdBox)", Float) = 0
        _CrowdStepHz ("Crowd Step Rate (updates/sec)", Float) = 12
        // Chance a cell sits out ONE 16-step cycle on frame 0 (the rest pose). Retail rests 0-63 steps at
        // cycle end with activity-coded thresholds {0,50,100,200,100,50,0}/256; riders nearby push the low
        // tiers, and a VRChat world always has riders around, so 50/256 (the low tier) is the default.
        // Back-to-back rest cycles are suppressed - a rest is always a single ~1.3 s beat-skip, never a
        // multi-second freeze (dead-looking cells read worse than retail's occasional long rest).
        _CrowdRestProb ("Crowd Rest Probability (per cycle)", Range(0,1)) = 0.1953125
        [Toggle(_CUTOUT)] _UseCutout ("Alpha Cutout", Float) = 0
        _Cutoff ("Alpha Cutoff", Range(0,1)) = 0.5
        // Vertex-COLOUR modulate. Two users: (a) terrain's edge-welded grayscale lightmap luminance
        // (fallback; the per-pixel _LIGHTMAP_GS path below is preferred); (b) props, which bake their
        // per-instance SSX light COLOUR (warm sun + cool shadow) here so each darkens in shadow.
        [Toggle(_LIGHTMAP)] _UseLightmap ("Use Lightmap (vertex colour)", Float) = 0
        [Toggle(_PROPLIGHT)] _UsePropLight ("PS2 Prop Light (sRGB / 256)", Float) = 0
        _LightmapGain ("Lightmap Gain", Range(0,8)) = 2
        _LightmapStrength ("Lightmap Strength", Range(0,1)) = 1
        // Gamma curve on the baked luminance BEFORE the multiply: under a Linear project the multiply
        // is in linear space, so a raw factor looks far too soft. pow(lum, _LightmapContrast) makes it
        // act perceptually, matching the PS2's gamma-space modulate. >2.2 = deeper. See docs/unity/007.
        _LightmapContrast ("Lightmap Contrast (gamma)", Range(1,4)) = 2.2
        // Real-time DIRECTIONAL light for props that rotate. Native normals meet all three per-instance
        // light vectors; COLOR carries ambient and TEXCOORD2..7 carry the three key/direction pairs.
        [Toggle(_DIRLIGHT)] _UseDirLight ("Directional Light (spinning props)", Float) = 0
        // Exact per-instance records for shared/instanced meshes. These must be ShaderLab properties or Unity drops
        // MaterialPropertyBlock values before they reach the instancing buffer. Ambient defaults white, keys black.
        _InstAmbient ("Instanced Ambient (per-instance)", Vector) = (1,1,1,1)
        _InstKey1 ("Instanced Key 1", Vector) = (0,0,0,1)
        _InstKey2 ("Instanced Key 2", Vector) = (0,0,0,1)
        _InstKey3 ("Instanced Key 3", Vector) = (0,0,0,1)
        _InstDir1 ("Instanced Direction 1", Vector) = (0,1,0,0)
        _InstDir2 ("Instanced Direction 2", Vector) = (0,1,0,0)
        _InstDir3 ("Instanced Direction 3", Vector) = (0,1,0,0)
        // Per-pixel lightmap ATLAS (rgb = C_S, alpha = A_S), sampled via UV1 - full per-patch resolution,
        // tessellation-independent, the way the game applied terrain lighting. Consumed by _LIGHTMAP_GS
        // (the terrain path). See docs/unity/007.
        _LightmapTex ("Lightmap Atlas", 2D) = "white" {}
        // Authentic GS lightmap blend (_LIGHTMAP_GS): reconstruct the game's (C_D - C_S) x A_S from the
        // RGBA atlas (rgb = C_S source residual, alpha = A_S intensity). Scales are physically derived:
        // base x0.5 undoes the export's x2 half-bright brighten; A_S x (255/128) is the GS >>7 alpha
        // factor (so sunlit snow can exceed 1.0). Tune to a reference capture (docs/unity/007).
        _LmBaseScale ("Lightmap GS: base scale (C_D)", Range(0,2)) = 0.5
        _LmSrcScale  ("Lightmap GS: source scale (C_S)", Range(0,4)) = 1.0
        _LmAsScale   ("Lightmap GS: alpha scale (A_S*255/128)", Range(0,4)) = 1.9921875
        // UV scroll (river water, LCD scanlines, jumbotrons, boost-pad arrows). Speed xy = units/sec;
        // cycle = native mode, active seconds, pause seconds, lifetime seconds. Driven statelessly from
        // _Time at the native 60 Hz tick rate, so it animates in a build / VRChat with NO runtime script.
        _ScrollSpeed ("UV Scroll Speed (xy/sec)", Vector) = (0,0,0,0)
        _ScrollCycle ("UV Scroll Mode/Active/Pause/Lifetime", Vector) = (0,1,0,0)
        // Wind vertex sway (_WIND, docs/053): the soft-prop pipeline combines flags/fences into one mesh and
        // displaces each vertex horizontally by a world-phased sine x a per-vertex FLAP WEIGHT baked into UV0.w
        // (0 at the anchored base, 1 at the free top), so flags ripple + fences shimmer while their bases stay put.
        // Off by default; the importer enables it on the SoftBodies meshes only, and it composes with _CUTOUT (holes).
        [Toggle(_WIND)] _UseWind ("Wind Sway", Float) = 0
        _WindStrength ("Wind Strength (world m)", Range(0,3)) = 0.2
        _WindSpeed ("Wind Speed", Range(0,10)) = 2
        _WindFreq ("Wind Spatial Freq", Range(0,1)) = 0.15
        // Alpha-BLEND state (translucent glass/water/LCD signs - see docs/unity/005-materials-and-alpha.md).
        // Defaults are opaque (One/Zero + ZWrite on), identical to having no Blend statement, so opaque
        // and alpha-CUTOUT materials are unchanged; the importer flips these to SrcAlpha/OneMinusSrcAlpha
        // + ZWrite off (and Queue=Transparent) only for materials whose texture is uniformly translucent.
        [Enum(UnityEngine.Rendering.BlendMode)] _SrcBlend ("Src Blend", Float) = 1
        [Enum(UnityEngine.Rendering.BlendMode)] _DstBlend ("Dst Blend", Float) = 0
        [Enum(Off,0,On,1)] _ZWrite ("ZWrite", Float) = 1
        // Alpha-to-coverage for the cutout path: MSAA samples soften the clipped edge (foliage/crowd) in a
        // VRChat upload without an opaque-pass blend. Off by default (opaque/blend materials unaffected).
        [Enum(Off,0,On,1)] _AlphaToMask ("Alpha To Coverage", Float) = 0
    }
    SubShader
    {
        Tags { "RenderType"="Opaque" "Queue"="Geometry" }
        Cull Off
        Blend [_SrcBlend] [_DstBlend]
        ZWrite [_ZWrite]
        AlphaToMask [_AlphaToMask]
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma shader_feature _CUTOUT
            #pragma shader_feature _LIGHTMAP
            #pragma shader_feature _PROPLIGHT
            #pragma shader_feature _LIGHTMAP_GS
            #pragma shader_feature _DIRLIGHT
            // Instanced variant of _DIRLIGHT: ambient + three key/direction pairs come from the instancing buffer
            // instead of vertex COLOR/TEXCOORD2..7, so a whole row of
            // identical props (e.g. parking meters, course pylons) shares ONE mesh and GPU-instances into a
            // single draw while each keeps its own SSX light colour. Enabled with _DIRLIGHT by the importer (docs/012).
            #pragma shader_feature _DIRLIGHT_INST
            #pragma shader_feature _WIND
            // Texture-array batching: sample a Texture2DArray slice (uv.z) instead of _MainTex, so one
            // combined-mesh draw covers N per-texture submeshes with a single SetPass call. See the
            // _MainTexArray property note + TextureArrayPacker. Needs GLES3/Vulkan (VRChat Quest has both).
            #pragma shader_feature _TEXARRAY
            // CrowdBox spectators: like _TEXARRAY but the slice is COMPUTED per-vertex from _Time + the cell
            // identity in UV1, playing the retail per-cell schedule statelessly (see the property note).
            #pragma shader_feature _CROWD
            #pragma target 3.5
            // GPU instancing: lets renderers that share this material + mesh (the 79 spinning gem pickups,
            // and any repeated prop) batch into one instanced draw call even though each spins on its own
            // transform (dynamic batching can't - the gem mesh is over the vertex-attribute limit). The
            // material's "Enable GPU Instancing" flag (set by MaterialFactory) arms it; this compiles the
            // variant. No per-instance material props, so we only need the instance-id transform path below.
            #pragma multi_compile_instancing
            // Distance fog so far terrain/props fade into the horizon haze the way SSX did (docs/unity/006). Unlit
            // shaders get no fog for free - we have to carry the fog coord and apply it ourselves. Unity
            // never fogs the skybox, so the painted sky behind stays crisp; only this geometry fades.
            #pragma multi_compile_fog
            #include "UnityCG.cginc"
            #include "../../Importer/Shaders/UvScroll.hlsl"

            struct appdata
            {
                float4 vertex : POSITION; float4 uv : TEXCOORD0; float2 uv1 : TEXCOORD1; fixed4 color : COLOR;
                #ifdef _DIRLIGHT
                float3 normal : NORMAL;
                #ifndef _DIRLIGHT_INST
                float3 key1 : TEXCOORD2; float3 key2 : TEXCOORD3; float3 key3 : TEXCOORD4;
                float3 dir1 : TEXCOORD5; float3 dir2 : TEXCOORD6; float3 dir3 : TEXCOORD7;
                #endif
                #endif
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };
            struct v2f
            {
                float2 uv : TEXCOORD0; float2 uv2 : TEXCOORD1; fixed4 color : COLOR; UNITY_FOG_COORDS(2)
                #ifdef _DIRLIGHT
                float3 worldNormal : TEXCOORD3;
                #ifndef _DIRLIGHT_INST
                float3 key1 : TEXCOORD4; float3 key2 : TEXCOORD5; float3 key3 : TEXCOORD6;
                float3 dir1 : TEXCOORD7; float3 dir2 : TEXCOORD8; float3 dir3 : TEXCOORD9;
                #endif
                #endif
                #if defined(_TEXARRAY) || defined(_CROWD)
                #if defined(_DIRLIGHT) && !defined(_DIRLIGHT_INST)
                float slice : TEXCOORD10;
                #elif defined(_DIRLIGHT)
                float slice : TEXCOORD4;
                #else
                float slice : TEXCOORD3;
                #endif
                #endif
                float4 vertex : SV_POSITION;
                UNITY_VERTEX_INPUT_INSTANCE_ID   // carry the id so frag can read this instance's exact light record
            };

            sampler2D _MainTex;
            float4 _MainTex_ST;
            UNITY_DECLARE_TEX2DARRAY(_MainTexArray);   // _TEXARRAY path: one array replaces N per-texture submeshes
            sampler2D _LightmapTex;
            float _Cutoff;
            float _LightmapGain;
            float _LightmapStrength;
            float _LightmapContrast;
            float _LmBaseScale;
            float _LmSrcScale;
            float _LmAsScale;
            float4 _ScrollSpeed;
            float4 _ScrollCycle;
            float _WindStrength;
            float _WindSpeed;
            float _WindFreq;
            float _CrowdStepHz;
            float _CrowdRestProb;

            #ifdef _CROWD
            // The four specified crowd playback patterns [Trailmap: 410-crowd], 16 source-frame
            // entries each, packed 4 bits per entry: x = entries 0..7 (nibble k = entry k), y = entries 8..15.
            //   0: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
            //   1: 0 1 2 3 2 1 0 7 8 9 10 11 12 13 14 15
            //   2: 0 1 2 3 4 5 6 7 6 5 4 3 2 1 0 0
            //   3: 0 0 0 0 0 1 2 3 4 5 6 5 4 3 2 1
            // Every pattern starts at frame 0, so a rest cycle (held frame 0) hands off seamlessly.
            static const uint2 CROWD_PAT[4] = {
                uint2(0x76543210u, 0xFEDCBA98u),
                uint2(0x70123210u, 0xFEDCBA98u),
                uint2(0x76543210u, 0x00123456u),
                uint2(0x32100000u, 0x12345654u)
            };

            // Small integer hash (lowbias-style mix) - stable across platforms, unlike frac(sin()).
            uint CrowdHash(uint s)
            {
                s ^= 2747636419u; s *= 2654435769u;
                s ^= s >> 16;     s *= 2654435769u;
                s ^= s >> 16;     s *= 2654435769u;
                return s;
            }
            #endif

            // Exact per-instance record for shared meshes; pushed as raw vectors by a MaterialPropertyBlock.
            UNITY_INSTANCING_BUFFER_START(Props)
                UNITY_DEFINE_INSTANCED_PROP(float4, _InstAmbient)
                UNITY_DEFINE_INSTANCED_PROP(float4, _InstKey1)
                UNITY_DEFINE_INSTANCED_PROP(float4, _InstKey2)
                UNITY_DEFINE_INSTANCED_PROP(float4, _InstKey3)
                UNITY_DEFINE_INSTANCED_PROP(float4, _InstDir1)
                UNITY_DEFINE_INSTANCED_PROP(float4, _InstDir2)
                UNITY_DEFINE_INSTANCED_PROP(float4, _InstDir3)
            UNITY_INSTANCING_BUFFER_END(Props)

            float3 PropModulate(float3 textureLinear, float3 factor)
            {
                factor = saturate(factor);
                #ifdef UNITY_COLORSPACE_GAMMA
                return saturate(textureLinear * factor);
                #else
                return GammaToLinearSpace(saturate(LinearToGammaSpace(textureLinear) * factor));
                #endif
            }

            v2f vert (appdata v)
            {
                v2f o;
                UNITY_SETUP_INSTANCE_ID(v);                  // pick this instance's transform (GPU instancing)
                UNITY_TRANSFER_INSTANCE_ID(v, o);            // forward the id for the exact instanced light record
                #ifdef _WIND
                // Sway the vertex HORIZONTALLY in world space by a per-location sine, scaled by the flap weight in
                // UV0.w (0 = anchored base, 1 = free tip). World-phase so neighbouring flags/fences ripple out of
                // sync; converted back to object space so the amount is world-consistent under the level's scale.
                float _wgt = v.uv.w;
                float _wt = _Time.y * _WindSpeed;
                float3 _wwp = mul(unity_ObjectToWorld, v.vertex).xyz;
                float _ws = (_wwp.x + _wwp.z) * _WindFreq + _wt;
                float3 _woff = float3(sin(_ws) + sin(_ws * 2.3) * 0.35, 0.0, cos(_ws * 1.7) * 0.5) * (_WindStrength * _wgt);
                v.vertex.xyz += mul((float3x3)unity_WorldToObject, _woff);
                #endif
                o.vertex = UnityObjectToClipPos(v.vertex);
                // The shared evaluator preserves native modes, active/pause intervals and finite lifetime.
                o.uv = TRANSFORM_TEX(v.uv.xy, _MainTex)
                     + UvScrollElapsed(_Time.y, _ScrollCycle) * _ScrollSpeed.xy;
                o.uv2 = v.uv1;                               // lightmap atlas UV (per-patch tile)
                o.color = v.color;
                #if defined(_CROWD)
                // CrowdBox: pick this cell's CURRENT cheer frame. Retail advances every 5th 60 Hz tick
                // (12 updates/s), giving each of the 16 cells a random start phase and one of four motion
                // patterns, rerolling the pattern each 16-step cycle and sometimes resting on frame 0
                // (crowd-box.md). Same observable here, but STATELESS: the cell's stream is a pure function
                // of time + its (cell id, stand ordinal) seed in UV1, so it runs with no script anywhere
                // the shader runs - Scene view, a build, a VRChat upload. All verts of a cell compute the
                // same frame, so interpolation is constant across the billboard.
                {
                    uint _cseed = ((uint)(v.uv1.y + 0.5)) * 16u + ((uint)(v.uv1.x + 0.5));   // stand ordinal * 16 + cell
                    uint _ct = (uint)(_Time.y * _CrowdStepHz) + (CrowdHash(_cseed) & 255u); // steps + random start phase
                    uint _cw = _ct >> 4;                                                        // 16-step cycle ordinal
                    uint _ccyc = CrowdHash(_cseed ^ (_cw * 0x9E3779B9u));                    // fresh roll per cycle
                    uint _cthr = (uint)(_CrowdRestProb * 256.0);
                    // Rest = this cycle rolled a rest AND the previous one didn't: rests stay a single
                    // ~1.3 s beat-skip on frame 0 (see the _CrowdRestProb property note).
                    bool _crest = ((_ccyc >> 2) & 255u) < _cthr
                               && ((CrowdHash(_cseed ^ ((_cw - 1u) * 0x9E3779B9u)) >> 2) & 255u) >= _cthr;
                    uint _cframe = 0u;                                                          // rest -> hold frame 0
                    if (!_crest)
                    {
                        uint2 _cpat = CROWD_PAT[_ccyc & 3u];                                // rerolled pattern
                        uint _cidx = _ct & 15u;
                        _cframe = ((_cidx < 8u ? _cpat.x : _cpat.y) >> ((_cidx & 7u) * 4u)) & 15u;
                    }
                    o.slice = (float)_cframe;
                }
                #elif defined(_TEXARRAY)
                o.slice = v.uv.z;                            // per-vertex array layer (importer baked it into UV0.z)
                #endif
                #ifdef _DIRLIGHT
                o.worldNormal = UnityObjectToWorldNormal(v.normal);  // rotates with the prop -> sweeps vs the fixed sun
                #ifndef _DIRLIGHT_INST
                o.key1 = v.key1; o.key2 = v.key2; o.key3 = v.key3;
                o.dir1 = v.dir1; o.dir2 = v.dir2; o.dir3 = v.dir3;
                #endif
                #endif
                UNITY_TRANSFER_FOG(o, o.vertex);             // fog factor from clip-space depth
                return o;
            }

            fixed4 frag (v2f i) : SV_Target
            {
                UNITY_SETUP_INSTANCE_ID(i);   // required before UNITY_ACCESS_INSTANCED_PROP in frag (_DIRLIGHT_INST)
                #if defined(_TEXARRAY) || defined(_CROWD)
                fixed4 c = UNITY_SAMPLE_TEX2DARRAY(_MainTexArray, float3(i.uv, i.slice));
                #else
                fixed4 c = tex2D(_MainTex, i.uv);
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
                c.rgb *= lerp(float3(1.0,1.0,1.0), saturate(vcol * _LightmapGain), _LightmapStrength);
                #endif
                #endif
                #ifdef _LIGHTMAP_GS
                // Authentic GS terrain lighting: the game computed (C_D - C_S) x A_S/128 in display
                // (gamma) space, where C_D = the half-bright base texel, C_S = atlas RGB, A_S = atlas alpha
                // (2002 GDC "Light maps on the PS2"). We undo the x2 export brighten (_LmBaseScale 0.5) and
                // apply the GS alpha factor (_LmAsScale 255/128, so sunlit snow exceeds 1.0). _LmSrcScale
                // trims C_S if needed. The blend runs in gamma space (where the GS worked) then back.
                float4 lm = tex2D(_LightmapTex, i.uv2);    // rgb = C_S, a = A_S (raw, linear-imported atlas)
                #ifdef UNITY_COLORSPACE_GAMMA
                float3 cdG = c.rgb;
                #else
                float3 cdG = LinearToGammaSpace(c.rgb);    // base sample is linear; the GS worked in gamma
                #endif
                float3 litG = saturate((cdG * _LmBaseScale - lm.rgb * _LmSrcScale) * (lm.a * _LmAsScale));
                #ifdef UNITY_COLORSPACE_GAMMA
                float3 lit = litG;
                #else
                float3 lit = GammaToLinearSpace(litG);
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
                UNITY_APPLY_FOG(i.fogCoord, c);              // blend toward the horizon fog colour by depth
                return c;
            }
            ENDCG
        }
    }
}
