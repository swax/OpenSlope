// URP port of OpenSlope/FlareHalo (the Built-in-RP original lives in ../../VRC/Shaders/FlareHalo.shader).
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
// Alpha holds to half of _GlintRange then fades linearly to zero at the range. The importer builds these via
// Shader.Find("OpenSlope/FlareHalo"), so this URP copy must answer to the SAME name + Properties or the glints
// render magenta in Basis. Sized by the GameObject's world X/Y scale; tinted by _Color (the light record's
// hue, baked by snowknife).
Shader "OpenSlope/FlareHalo"
{
    Properties
    {
        _Color ("Halo Color (a=intensity)", Color) = (1,1,1,1)
        _Power ("Edge softness", Range(0.3, 4)) = 1.5
        // Depth test. LEqual (4) is the game's own occlusion for the glints: the sprite draws at the light's
        // depth and the depth buffer clips it per pixel.
        [Enum(UnityEngine.Rendering.CompareFunction)] _ZTest ("ZTest", Float) = 4
        // Metres to pull the billboard toward the camera - the engine's own per-class depth pull (3/5/8 m
        // for res 16/32/64): the sparkle sits IN FRONT of nearby terrain and the fixture that houses its
        // light, never cutting into them. Occlusion is the SOURCE-VISIBILITY fade (a fader script drives
        // _Visibility); the depth test only handles gross occluders beyond the pull.
        _ViewNudge ("Pull toward camera (m)", Range(0,10)) = 5
        // Master fade (hand-tuning; occlusion needs no driver - the depth test does it).
        _Visibility ("Master fade", Range(0,1)) = 1
        // Streak-cross strength (0 = plain halo). The glints draw the cross ALWAYS, turned by the screen-x law.
        _Streak ("Streak strength", Range(0,4)) = 0
        // The game's rotation law: spike-star angle = -90deg x the glint's screen X (NDC). 1 = the game's law,
        // 0 = static star. There is no time-based spin in the engine.
        _Twinkle ("Screen-x rotation scale", Range(0,4)) = 1
        // Draw range D (m): the game's fade law - alpha 1 out to D/2, then linear to 0 at D. 0 = no fade.
        _GlintRange ("Glint range (m, 0 = off)", Float) = 0
        // The engine's fixed-pixel core: the sparkle never shrinks below this many screen pixels.
        _MinPixels ("Min screen size (px)", Range(0,64)) = 14
        // Screen-centre bloom: size x (1 + _CenterBoost x centredness^4).
        _CenterBoost ("Centre bloom", Range(0,3)) = 1
        // The AURA - the game's second, larger glow element in the same hue: a soft radial gradient filling
        // the whole quad while the sparkle elements occupy 1/scale of it. Its smooth gradient is also what
        // makes the depth-test occlusion fade gracefully. _AuraScale 1 (or _AuraAlpha 0) = no aura.
        _AuraScale ("Aura: quad = this x the sparkle", Range(1,6)) = 2.5
        _AuraAlpha ("Aura glow strength", Range(0,1)) = 0.3
        // WHITE-HOT core: the star + core elements additionally add WHITE (the console's overbright additive
        // saturation - a red flare's centre burns white while the halo/aura stay pure hue).
        _Hot ("White-hot star/core", Range(0,2)) = 0.3
        // Halo ring strength: the ring also samples a blurrier mip, so its rim reads soft rather than crisp.
        _Ring ("Halo ring strength", Range(0,2)) = 0.7
        // The authored glint atlas (PARTICLE.SSH `lens`, 2x2 quadrants): TL = halo ring, TR = bright core,
        // BL = many-spiked twinkle star, BR = empty. Three layered elements from one texture.
        _GlintTex ("Glint atlas (lens: ring/core/spikes)", 2D) = "black" {}
    }
    SubShader
    {
        Tags { "Queue"="Transparent" "RenderType"="Transparent" "IgnoreProjector"="True" "PreviewType"="Plane" "RenderPipeline"="UniversalPipeline" }
        Blend One One          // additive
        ZWrite Off
        ZTest [_ZTest]
        Cull Off
        Pass
        {
            Tags { "LightMode"="UniversalForward" }
            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma shader_feature_local _GLOWSPRITES
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

            struct Attributes { float4 positionOS : POSITION; float2 uv : TEXCOORD0; };
            struct Varyings
            {
                float4 positionCS : SV_POSITION; float2 uv : TEXCOORD0;
                float2 fade : TEXCOORD1;   // x = range fade, y = spike-star angle (screen-x law)
            };

            CBUFFER_START(UnityPerMaterial)
                half4 _Color;
                float _Power;
                float _Visibility;
                float _Streak;
                float _Twinkle;
                float _GlintRange;
                float _ViewNudge;
                float _MinPixels;
                float _CenterBoost;
                float _AuraScale;
                float _AuraAlpha;
                float _Hot;
                float _Ring;
            CBUFFER_END
            TEXTURE2D(_GlintTex); SAMPLER(sampler_GlintTex);

            // Sample one atlas element: d = quad-local coords (-0.5..0.5), scale = the element's size
            // relative to the quad, qOff = its quadrant origin in UV space. Outside the element -> 0.
            float glintElem (float2 d, float scale, float2 qOff)
            {
                float2 q = d / scale;
                float2 inside = step(abs(q), float2(0.5, 0.5));
                return SAMPLE_TEXTURE2D(_GlintTex, sampler_GlintTex, (q + 0.5) * 0.5 + qOff).a * inside.x * inside.y;
            }

            // Same, but sampling a blurrier mip (bias) - a SOFT-rimmed element (the halo ring).
            float glintElemSoft (float2 d, float scale, float2 qOff, float bias)
            {
                float2 q = d / scale;
                float2 inside = step(abs(q), float2(0.5, 0.5));
                return SAMPLE_TEXTURE2D_BIAS(_GlintTex, sampler_GlintTex, (q + 0.5) * 0.5 + qOff, bias).a * inside.x * inside.y;
            }

            Varyings vert (Attributes v)
            {
                Varyings o;
                // Billboard: place the quad's origin in view space, then offset by the quad's local XY scaled by the
                // object's world X/Y size - so it always faces the camera regardless of the object's rotation.
                float3 centerVS = TransformWorldToView(TransformObjectToWorld(float3(0,0,0)));
                float depth = max(0.001, -centerVS.z);
                float sx = length(float3(unity_ObjectToWorld._m00, unity_ObjectToWorld._m10, unity_ObjectToWorld._m20));
                float sy = length(float3(unity_ObjectToWorld._m01, unity_ObjectToWorld._m11, unity_ObjectToWorld._m21));
                // The glint's own screen position (before the corner offset) drives the game's two screen laws.
                float4 centerClip = TransformWViewToHClip(centerVS);
                float2 ndc = centerClip.xy / max(1e-4, centerClip.w);
                // Centre bloom: centredness = 1 at the middle of the view, 0 at a corner; 4th power = the
                // engine's tight centre-weighted lobe.
                float cent = saturate((1.41421 - length(ndc)) * 0.70711);
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
                // projected size by depth/(depth-pull) and blows up/near-clips as you approach.)
                float pullK = 1.0 - min(_ViewNudge, depth * 0.5) / depth;
                float3 posVS = (centerVS + float3(v.positionOS.x * sx * grow, v.positionOS.y * sy * grow, 0.0)) * pullK;
                o.positionCS = TransformWViewToHClip(posVS);
                o.uv = v.uv;
                // Range fade: alpha 1 out to D/2, linear to 0 at D (the engine's law).
                o.fade.x = _GlintRange > 0.0 ? saturate((_GlintRange - depth) / (0.5 * _GlintRange)) : 1.0;
                // Rotation law: -90deg x screen X - the star turns as the glint crosses the view.
                o.fade.y = -1.5707963 * ndc.x * _Twinkle;
                return o;
            }

            half4 frag (Varyings i) : SV_Target
            {
                float2 d = i.uv - 0.5;
                float a; float hot = 0.0;
                #ifdef _GLOWSPRITES
                // The authored `lens` atlas, three layered elements (shapes in the ALPHA, white RGB):
                // halo RING (TL) full-size, bright CORE (TR) at about half, many-spiked TWINKLE star (BL)
                // slightly oversized, turned by the screen-x law. The quad is _AuraScale x the sparkle:
                // elements sample at d x scale, and the AURA - the game's second, larger same-hue glow -
                // is a soft gradient over the whole quad. The core + star also feed the WHITE-HOT term:
                // they burn toward white (the console's additive saturation) while ring + aura stay hue.
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
                float r = saturate(1.0 - length(d) * 2.0);          // 1 at centre, 0 at the rim
                a = pow(r, _Power);                                  // smooth radial falloff
                #endif
                float vis = saturate(_Visibility) * i.fade.x;
                float3 col = _Color.rgb * (_Color.a * a * vis) + (_Color.a * hot * vis).xxx;
                return half4(col, 1.0);      // premultiplied; Blend One One ignores alpha
            }
            ENDHLSL
        }
    }
}
