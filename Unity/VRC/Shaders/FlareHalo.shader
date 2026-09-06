// The light GLINT billboard - the game's runtime sparkle on every authored glow light (lamps AND flares;
// [Trailmap: 160-lighting-data], the runtime glint section). One camera-facing quad per light: the authored
// halo RING + bright CORE + spike star from the PARTICLE.SSH `lens` atlas (_GLOWSPRITES), or a smooth
// procedural radial bloom when the sprites are absent. Additive, unlit, ZWrite off, DEPTH-TESTED - the
// depth buffer is the game's occlusion: terrain clips the sparkle per pixel, a hidden lamp draws nothing.
// The game's distance law, reproduced: the sparkle is WORLD-anchored (grows by plain perspective as you
// approach) but never shrinks below a fixed pixel size (_MinPixels - the engine's constant 16x8-px core), so
// a far street lamp still shows a tiny constant glint. It BLOOMS toward the screen centre (centredness^4,
// _CenterBoost) and its spike star's rotation is driven by the glint's SCREEN X position (-90deg x NDC.x,
// _Twinkle scales the law) - the sparkle visibly turns as you ride past; there is no time-based spin.
// Alpha holds to half of _GlintRange then fades linearly to zero at the range. Sized by the GameObject's
// world X/Y scale; tinted by _Color (the light record's hue, baked by snowknife). Built-in RP, no Udon ->
// VRChat-safe. GPU-INSTANCING is enabled (all glints share one quad mesh and a material per hue+size class;
// only the per-glint _Visibility fade is per-instance). It buys little at this Queue: transparents are sorted
// back-to-front, and instancing merges only ADJACENT same-material draws, so glints interleaved by depth with
// the course's particles stay separate. Measured on a 70-glint view: 49 batches at Queue 3000 vs 14 at 2450
// (state-sorted). Moving below 2500 would collect them - at the cost of compositing before every alpha-blended
// transparent instead of interleaving by depth. Left at 3000; instancing is here so that choice stays open.
Shader "OpenSlope/FlareHalo"
{
    Properties
    {
        _Color ("Halo Color (a=intensity)", Color) = (1,1,1,1)
        _Power ("Edge softness", Range(0.3, 4)) = 1.5
        // Depth test. LEqual (4) is the game's own occlusion for the light GLINTS: the sprite draws at the
        // light's depth and the depth buffer clips it per pixel - a lamp behind a ridge shows only the
        // sliver of halo that clears the edge, a fully hidden lamp draws nothing, and the halo never reads
        // through terrain ([Trailmap: 160-lighting-data], the runtime glint section).
        [Enum(UnityEngine.Rendering.CompareFunction)] _ZTest ("ZTest", Float) = 4
        // Metres to pull the billboard toward the camera - the engine's own per-class depth pull (3/5/8 m
        // for res 16/32/64): the sparkle sits IN FRONT of nearby terrain and the fixture that houses its
        // light, never cutting into them. Occlusion is the SOURCE-VISIBILITY fade (GlintFade drives
        // _Visibility), as on console; the depth test only handles gross occluders beyond the pull.
        _ViewNudge ("Pull toward camera (m)", Range(0,10)) = 5
        // Master fade, PER-INSTANCE (GlintFade pushes it per renderer via a MaterialPropertyBlock). It lives
        // in the instancing buffer so a per-glint fade does not break the GPU-instanced batch; it must stay
        // declared here too - an MPB write to a name absent from Properties{} is silently dropped. The default
        // is 1 so a lost block (MPBs are never serialized) degrades to fully visible, not invisible.
        _Visibility ("Master fade (per-instance)", Range(0,1)) = 1
        // Streak-cross strength. 0 = plain halo (the flares' procedural blob). The glints draw the streak
        // cross ALWAYS - in the game it is part of the sparkle, turned by the screen-position rotation below.
        _Streak ("Streak strength", Range(0,4)) = 0
        // The game's rotation law: spike-star angle = -90deg x the glint's screen X (NDC), so the star turns
        // as the light crosses the view - the sparkle's slight "movement" while riding. 1 = the game's law,
        // 0 = static star. There is no time-based spin in the engine.
        _Twinkle ("Screen-x rotation scale", Range(0,4)) = 1
        // Draw range D (m): the game's fade law - alpha 1 out to D/2, then linear to 0 at D. 0 = no fade.
        _GlintRange ("Glint range (m, 0 = off)", Float) = 0
        // The engine's fixed-pixel core: the sparkle never shrinks below this many screen pixels (the game
        // draws a constant 16x8-px core at any distance), so far lamps keep a tiny constant glint.
        _MinPixels ("Min screen size (px)", Range(0,64)) = 14
        // Screen-centre bloom: size x (1 + _CenterBoost x centredness^4) - the game's glints grow toward the
        // middle of the view (up to ~2x when looked at dead-on).
        _CenterBoost ("Centre bloom", Range(0,3)) = 1
        // The AURA - the game's second, larger glow element in the same hue (the glint draws two size
        // scales): a soft radial gradient filling the whole quad while the sparkle elements occupy 1/scale
        // of it. Being a smooth gradient, the depth test clips it gradually - the graceful occlusion fade
        // seen on console. _AuraScale 1 (or _AuraAlpha 0) = no aura, sparkle fills the quad.
        _AuraScale ("Aura: quad = this x the sparkle", Range(1,6)) = 2.5
        _AuraAlpha ("Aura glow strength", Range(0,1)) = 0.3
        // WHITE-HOT core: the star + core elements additionally add WHITE (the console's overbright additive
        // saturation - a red flare's centre burns white while the halo/aura stay pure hue). Scaling the hue
        // alone can't whiten (a red hue clamps to neon red/magenta); the hot elements need white energy.
        _Hot ("White-hot star/core", Range(0,2)) = 0.3
        // Halo ring strength: the ring also samples a blurrier mip, so its rim reads soft rather than crisp.
        _Ring ("Halo ring strength", Range(0,2)) = 0.7
        // The game's AUTHORED glint atlas (PARTICLE.SSH `lens`, 2x2 quadrants): TL = the halo ring,
        // TR = the bright core, BL = the many-spiked twinkle star, BR = empty. When _GLOWSPRITES is on
        // (the light glints), the three elements composite from this one texture - ring + core static,
        // spikes turning with screen X; the flares' procedural soft blob is the fallback.
        _GlintTex ("Glint atlas (lens: ring/core/spikes)", 2D) = "black" {}
    }
    SubShader
    {
        Tags { "Queue"="Transparent" "RenderType"="Transparent" "IgnoreProjector"="True" "PreviewType"="Plane" }
        Blend One One          // additive
        ZWrite Off
        ZTest [_ZTest]
        Cull Off
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma shader_feature _GLOWSPRITES
            // A course draws one glint per authored glow light off ONE shared quad mesh, and every glint of a
            // given hue+size class shares a material - so the whole class collapses to a single instanced draw.
            // The per-glint fade rides in the instancing buffer below rather than breaking the batch.
            #pragma multi_compile_instancing
            #include "UnityCG.cginc"

            // The instance id also carries the EYE under single-pass-instanced stereo, so UNITY_SETUP_INSTANCE_ID
            // in vert is what makes UNITY_MATRIX_P (and the ndcEye screen laws below) genuinely per-eye.
            struct appdata
            {
                float4 vertex : POSITION; float2 uv : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };
            struct v2f
            {
                float4 pos : SV_POSITION; float2 uv : TEXCOORD0;
                float2 fade : TEXCOORD1;   // x = range fade x per-instance master fade, y = spike-star angle (screen-x law)
                UNITY_VERTEX_INPUT_INSTANCE_ID
                UNITY_VERTEX_OUTPUT_STEREO
            };

            fixed4 _Color; float _Power; float _Streak;
            float _Twinkle; float _GlintRange; float _ViewNudge; float _MinPixels; float _CenterBoost;
            float _AuraScale; float _AuraAlpha; float _Hot; float _Ring;
            sampler2D _GlintTex;

            // Per-glint, so glints sharing a material still batch. Falls back to the plain uniform when the
            // INSTANCING_ON variant isn't compiled, so an MPB write lands either way.
            UNITY_INSTANCING_BUFFER_START(Props)
                UNITY_DEFINE_INSTANCED_PROP(float, _Visibility)
            UNITY_INSTANCING_BUFFER_END(Props)

            // Sample one atlas element: d = quad-local coords (-0.5..0.5), scale = the element's size
            // relative to the quad, qOff = its quadrant origin in UV space. Outside the element -> 0.
            float glintElem (float2 d, float scale, float2 qOff)
            {
                float2 q = d / scale;
                float2 inside = step(abs(q), 0.5);
                return tex2D(_GlintTex, (q + 0.5) * 0.5 + qOff).a * inside.x * inside.y;
            }

            // Same, but sampling a blurrier mip (bias) - a SOFT-rimmed element (the halo ring).
            float glintElemSoft (float2 d, float scale, float2 qOff, float bias)
            {
                float2 q = d / scale;
                float2 inside = step(abs(q), 0.5);
                return tex2Dbias(_GlintTex, float4((q + 0.5) * 0.5 + qOff, 0, bias)).a * inside.x * inside.y;
            }

            v2f vert (appdata v)
            {
                v2f o;
                UNITY_SETUP_INSTANCE_ID(v);
                UNITY_INITIALIZE_OUTPUT(v2f, o);
                UNITY_TRANSFER_INSTANCE_ID(v, o);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(o);
                // Billboard: place the quad's origin in view space, then offset by the quad's local XY scaled by the
                // object's world size - so it always faces the camera regardless of the object's rotation.
                float3 centerView = UnityObjectToViewPos(float3(0,0,0));
                float depth = max(0.001, -centerView.z);
                float sx = length(float3(unity_ObjectToWorld._m00, unity_ObjectToWorld._m10, unity_ObjectToWorld._m20));
                float sy = length(float3(unity_ObjectToWorld._m01, unity_ObjectToWorld._m11, unity_ObjectToWorld._m21));
                // The glint's own screen position (before the corner offset) drives the game's two screen laws:
                // the centre bloom (from |ndc|) and the spike-star rotation (from ndc.x). Both are computed
                // per-eye by default. In VR the two eyes sit at horizontally offset viewpoints, so a per-eye
                // screen position gives each eye a slightly different centredness - the bloom SIZE differs
                // L-vs-R and the two images fight to fuse. Drive the bloom from ONE cyclopean screen position
                // (the average of the two eyes' view-projections) so both eyes size it identically. The star
                // ROTATION stays per-eye: a real glint's spikes do turn a touch differently for each eye, and
                // that parallax reads as depth rather than swim. Mono/desktop has no stereo matrices, so the
                // cyclopean value collapses to the plain per-eye one.
                float4 centerClipEye = mul(UNITY_MATRIX_P, float4(centerView, 1.0));
                float2 ndcEye = centerClipEye.xy / max(1e-4, centerClipEye.w);
                #if defined(USING_STEREO_MATRICES)
                    float3 worldPos = float3(unity_ObjectToWorld._m03, unity_ObjectToWorld._m13, unity_ObjectToWorld._m23);
                    float4 centerClipC = mul((unity_StereoMatrixVP[0] + unity_StereoMatrixVP[1]) * 0.5, float4(worldPos, 1.0));
                    float2 ndcBloom = centerClipC.xy / max(1e-4, centerClipC.w);
                #else
                    float2 ndcBloom = ndcEye;
                #endif
                // Centre bloom: centredness = 1 at the middle of the view, 0 at a corner; the 4th power makes
                // it a tight centre-weighted lobe (the engine's exact curve).
                float cent = saturate((1.41421 - length(ndcBloom)) * 0.70711);
                cent *= cent; cent *= cent;
                float grow = 1.0 + _CenterBoost * cent;
                // Fixed-pixel floor (the engine's constant 16x8-px core): world size a pixel covers at this
                // depth, via the projection's Y scale - the sparkle never drops below _MinPixels of it.
                // abs(): on D3D the projection is y-flipped for render-texture targets (Game view, VR,
                // mirrors), making _m11 NEGATIVE - unguarded, the floor explodes and every glint fills the sky.
                float worldPerPx = depth * 2.0 / max(1e-4, _ScreenParams.y * abs(UNITY_MATRIX_P._m11));
                grow = max(grow, _MinPixels * worldPerPx / max(1e-4, max(sx, sy)));
                // Escape the fixture that houses the light: pull the quad toward the camera ALONG THE VIEW
                // RAY, scaling the WHOLE quad (centre + corners) by the pull factor - the projected position
                // AND size stay exactly those of the unpulled quad, only the depth changes. (Pulling along
                // view-Z slides an off-centre glint's position; pulling only the centre inflates the
                // projected size by depth/(depth-pull) and blows up/near-clips as you approach. The game
                // projects the true position and takes only the DEPTH from the pulled point; this is
                // equivalent.)
                float pullK = 1.0 - min(_ViewNudge, depth * 0.5) / depth;
                float3 viewPos = (centerView + float3(v.vertex.x * sx * grow, v.vertex.y * sy * grow, 0.0)) * pullK;
                o.pos = mul(UNITY_MATRIX_P, float4(viewPos, 1.0));
                o.uv = v.uv;
                // Range fade: alpha 1 out to D/2, linear to 0 at D (the engine's law), folded with the
                // per-instance master fade (GlintFade's _Visibility). Both are constant across the quad,
                // so they ride one interpolator and the fragment never touches the instancing buffer - an
                // indexed cbuffer read per pixel on a heavy-overdraw additive sprite.
                o.fade.x = (_GlintRange > 0.0 ? saturate((_GlintRange - depth) / (0.5 * _GlintRange)) : 1.0)
                         * saturate(UNITY_ACCESS_INSTANCED_PROP(Props, _Visibility));
                // Rotation law: -90deg x screen X - the star turns as the glint crosses the view. Per-eye in
                // VR, so each eye's spikes turn with its own parallax.
                o.fade.y = -1.5707963 * ndcEye.x * _Twinkle;
                return o;
            }

            fixed4 frag (v2f i) : SV_Target
            {
                UNITY_SETUP_INSTANCE_ID(i);
                UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(i);
                float2 d = i.uv - 0.5;
                float a; float hot = 0.0;
                #ifdef _GLOWSPRITES
                // The authored `lens` atlas, three layered elements (shapes in the ALPHA, white RGB):
                // the halo RING (TL quadrant) full-size, the bright CORE (TR) at about half, and the
                // many-spiked TWINKLE star (BL) slightly oversized, turned by the screen-x law. The quad is
                // _AuraScale x the sparkle: elements sample at d x scale, and the AURA - the game's second,
                // larger same-hue glow - is a soft gradient over the whole quad. The core + star also feed
                // the WHITE-HOT term: they burn toward white (the console's additive saturation) while the
                // ring and aura stay pure hue.
                float2 ds = d * _AuraScale;
                float core = glintElem(ds, 0.55, float2(0.5, 0.5));
                float star = 0.0;
                if (_Streak > 0.0)
                {
                    float cs = cos(i.fade.y), sn = sin(i.fade.y);
                    float2 rd = float2(ds.x * cs - ds.y * sn, ds.x * sn + ds.y * cs);
                    star = glintElem(rd, 1.25, float2(0.0, 0.0)) * _Streak;   // spikes
                }
                a  = glintElemSoft(ds, 1.0, float2(0.0, 0.5), 1.5) * _Ring;       // ring, soft-rimmed
                a += pow(saturate(1.0 - length(d) * 2.0), _Power) * _AuraAlpha;   // the aura
                a += core + star;
                hot = (core + star) * _Hot;
                #else
                float r = saturate(1.0 - length(d) * 2.0);    // 1 at centre, 0 at the rim
                a = pow(r, _Power);                           // smooth radial falloff
                #endif
                float vis = i.fade.x;   // range fade x master fade, folded in vert
                float3 col = _Color.rgb * (_Color.a * a * vis) + (_Color.a * hot * vis).xxx;
                return fixed4(col, 1.0);   // premultiplied; Blend One One ignores alpha
            }
            ENDCG
        }
    }
}
