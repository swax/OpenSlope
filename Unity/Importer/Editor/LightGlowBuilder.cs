#if UNITY_EDITOR
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Builds the light GLINTS - the game's runtime sparkle on every authored glow light: the halo ring +
    // twinkling streak cross you see on a level's street lamps AND its course flares. The engine draws these
    // each frame from the light table itself, gated on the glow-sprite resolution being a small class
    // (spriteRes & 0x70 - 16/32/64 glint, 256/512 never do), occluded per pixel by the depth buffer
    // at the light's own position ([Trailmap: 160-lighting-data], the runtime glint section). snowknife surfaces
    // the qualifying lights as manifest.LightGlows; this builder places one camera-facing OpenSlope/FlareHalo billboard
    // per record using the authored PARTICLE.SSH glint art. The shader carries the engine's distance model:
    // world-anchored size (a res-32 sparkle is ~1.5 m across, growing by perspective on approach) with a
    // fixed-pixel floor so far lamps keep a tiny constant glint, a screen-centre bloom, a spike star turned by
    // the glint's screen X, and the per-class camera-ward pull that sits the sparkle IN FRONT of nearby terrain.
    // Occlusion follows the game's model: a SOURCE-VISIBILITY fade (GlintFadeMarker on the root -> the
    // platform wiring realizes the fader) plus the depth test for gross occluders beyond the pull.
    // Data-derived: no name matching.
    public class LightGlowBuilder
    {
        readonly ImportConfig _cfg;

        public LightGlowBuilder(ImportConfig cfg) { _cfg = cfg; }

        public void Build(Transform root)
        {
            var old = root.Find("LightGlows");
            if (old != null) Object.DestroyImmediate(old.gameObject);
            if (!_cfg.LightGlows) return;

            var bundle = new BundleManifestReader(_cfg);
            if (!bundle.Exists || !bundle.HasLightGlows) return;

            var glowRoot = new GameObject("LightGlows");
            glowRoot.transform.SetParent(root, false);   // under the SSX-oriented Level node: mesh-space coords + SSX-unit sizes via hierarchy

            var matCache = new Dictionary<string, Material>(System.StringComparer.Ordinal);
            int built = 0;
            foreach (var g in bundle.LightGlows)
            {
                var go = GameObject.CreatePrimitive(PrimitiveType.Quad);
                go.name = $"Glint_{built}_{g.Name}";
                var col = go.GetComponent<Collider>(); if (col != null) Object.DestroyImmediate(col);
                go.transform.SetParent(glowRoot.transform, false);
                go.transform.localPosition = g.Pos;
                // The spriteRes class scales the sparkle (16/32/64; e.g. lamps are 32, some flares 16).
                // The quad also carries the AURA - the game's second, larger same-hue glow - so it spans
                // sparkle x LightGlowAura; the shader draws the sparkle elements at 1/aura of it.
                float sizeClass = (g.SpriteRes & 0x70) != 0 ? g.SpriteRes / 32f : 1f;
                float aura = Mathf.Max(1f, _cfg.LightGlowAura);
                go.transform.localScale = Vector3.one * (2f * _cfg.LightGlowSize * sizeClass * aura);   // unit quad -> diameter (SSX units -> world via hierarchy)

                var rend = go.GetComponent<MeshRenderer>();
                rend.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
                rend.receiveShadows = false;
                rend.lightProbeUsage = UnityEngine.Rendering.LightProbeUsage.Off;
                rend.reflectionProbeUsage = UnityEngine.Rendering.ReflectionProbeUsage.Off;
                // The shader billboards the quad, grows it (centre bloom / pixel floor) and pulls it up to 5 m
                // toward the camera - all outside the flat Quad mesh's own paper-thin AABB, so Unity's frustum
                // cull can blink a glint off at odd bearings up close (the drawn sprite is on screen, the static
                // sliver of bounds is not). Inflate the culling bounds to cover the worst-case draw.
                rend.localBounds = new Bounds(Vector3.zero, Vector3.one * 8f);
                rend.sharedMaterial = GetGlintMaterial(matCache, g.Hue, g.SpriteRes);
                built++;
            }

            if (built == 0) { Object.DestroyImmediate(glowRoot); return; }

            // Source-visibility fade (the game's occlusion model): the sprite draws PULLED toward the camera - in
            // front of nearby terrain, never cutting into it - and fades with its light's line-of-sight instead
            // ([Trailmap: 160-lighting-data], the runtime glint section). The marker is neutral; the platform
            // wiring realizes the runtime fader.
            if (_cfg.LightGlowFade)
            {
                var mk = glowRoot.AddComponent<GlintFadeMarker>();
                mk.fadePerSecond = _cfg.LightGlowFadeSpeed;
                mk.testsPerFrame = 3;
                mk.sampleRadius = 0.8f;
                mk.maxRange = Mathf.Max(60f, _cfg.LightGlowRange * 1.1f);
                // Occluders = the world; exclude UI(5), Player(9)/PlayerLocal(10), pickups(13), mirror(18),
                // walkthrough(14) and the Foliage swish layer (24) - same exclusions as the board's own sweeps.
                mk.occluderMask = ~((1 << 5) | (1 << 9) | (1 << 10) | (1 << 13) | (1 << 14) | (1 << 18) | (1 << 24));
            }
            Debug.Log($"OpenSlope: light glints built - {built} glint(s), {matCache.Count} material(s) under LightGlows " +
                      "(authored glow lights, engine gate spriteRes & 0x70; OpenSlope/FlareHalo billboards" +
                      (_cfg.LightGlowFade ? ", source-visibility fade marker on the root" : "") + ").");
        }

        // One glint material per (colour, size class). The engine draws a glint in the light record's RGB
        // EUCLIDEAN-normalized, scaled by a per-record glint-brightness scalar that is 1.0 in every light of every
        // shipped course ([Trailmap: 160-lighting-data], the runtime glint section). So the authored colour PEAK is
        // the light's LIGHTING intensity and never reaches the sparkle: a squad-car beacon (peak 1) glints as
        // brightly as a floodlight (peak 5700); only hue and size class differ. The manifest's Hue is the record's
        // RGB normalized to peak 1, so the peak divides out and re-normalizing by LENGTH recovers the engine's
        // colour exactly - a saturated hue keeps a full-strength channel, a white light sits at 0.577.
        // Occlusion is the depth test - the game's own mechanism - at the depth of a point pulled toward the camera
        // by the engine's per-class distance (3/5/8 m for res 16/32/64; LightGlowNudge is the res-32 value): that
        // pull is how a sparkle escapes the fixture that houses its own light.
        Material GetGlintMaterial(Dictionary<string, Material> cache, Color hue, int spriteRes)
        {
            var v = new Vector3(hue.r, hue.g, hue.b);
            var glint = v / Mathf.Max(1e-4f, v.magnitude);
            hue = new Color(glint.x, glint.y, glint.z);
            float a = Mathf.Clamp01(_cfg.LightGlowAlpha);
            int res = spriteRes & 0x70;
            float pull = _cfg.LightGlowNudge * (res == 16 ? 0.6f : res == 64 ? 1.6f : 1f);   // the engine's 300/500/800-unit pull, class-scaled
            string key = "lglint_" + ColorUtility.ToHtmlStringRGB(hue) + "_a" + a.ToString("F2") + "_r" + res;
            if (cache.TryGetValue(key, out var hit)) return hit;
            var sh = Shader.Find("OpenSlope/FlareHalo");
            Material mat;
            if (sh != null)
            {
                mat = new Material(sh) { name = key };
                // Every glint is the same quad mesh and this material is shared by its whole hue+size class, so the
                // class CAN instance; the per-glint fade rides OpenSlope/FlareHalo's instancing buffer (_Visibility) rather
                // than breaking the batch the way a plain per-renderer MPB property would. The saving is small while
                // the shader sits in the back-to-front Transparent queue (Unity merges only adjacent same-material
                // draws, and glints interleave by depth with the course's particles) - see the OpenSlope/FlareHalo header.
                mat.enableInstancing = true;
                var c = hue; c.a = a;
                mat.SetColor("_Color", c);
                // Occlusion: with the source-visibility fade on, the glint SKIPS the depth test - the fade alone
                // occludes (the game's observed behavior: graceful, and no binary blink when a mid-ground ridge
                // lands inside the camera-ward pull gap, where a z-tested quad pops off whole). Without the fade,
                // fall back to the depth-test model (LEqual + the pull).
                mat.SetFloat("_ZTest", (float)(_cfg.LightGlowFade
                    ? UnityEngine.Rendering.CompareFunction.Always
                    : UnityEngine.Rendering.CompareFunction.LessEqual));
                mat.SetFloat("_ViewNudge", pull);
                mat.SetFloat("_Streak", _cfg.LightGlowStreak);       // the always-on streak cross of the sparkle
                mat.SetFloat("_Twinkle", _cfg.LightGlowTwinkle);     // the game's rotation law: star angle = -90deg x screen X
                mat.SetFloat("_GlintRange", _cfg.LightGlowRange);    // draw range D: alpha 1 to D/2, then linear to 0 at D
                float aura = Mathf.Max(1f, _cfg.LightGlowAura);
                mat.SetFloat("_MinPixels", _cfg.LightGlowMinPx * aura);   // fixed-pixel floor on the SPARKLE (the quad is aura x bigger)
                mat.SetFloat("_CenterBoost", _cfg.LightGlowBoost);   // screen-centre bloom (centredness^4)
                mat.SetFloat("_AuraScale", aura);                    // the larger same-hue glow around the sparkle
                mat.SetFloat("_AuraAlpha", _cfg.LightGlowAuraAlpha);
                mat.SetFloat("_Hot", _cfg.LightGlowHot);             // white-hot star/core (overbright saturation)
                mat.SetFloat("_Ring", _cfg.LightGlowRing);           // soft-rimmed halo ring strength
                // The game's AUTHORED glint atlas (PARTICLE.SSH `lens`, 2x2 quadrants: halo ring / bright core /
                // spiked twinkle star / empty - the exact art seen on console); keyword set BEFORE CreateAsset
                // (a keyword enabled after the .mat is written silently reverts on the next domain reload).
                var lensTex = AssetDatabase.LoadAssetAtPath<Texture2D>(_cfg.LevelFolder + "/Textures/Particles/lens.png");
                if (lensTex != null)
                {
                    mat.EnableKeyword("_GLOWSPRITES");
                    mat.SetTexture("_GlintTex", lensTex);
                }
                else Debug.LogWarning("OpenSlope: lens.png not found under Textures/Particles - glints fall back to the procedural shapes.");
            }
            else
            {
                mat = new Material(Shader.Find("Legacy Shaders/Particles/Additive") ?? Shader.Find("Sprites/Default")) { name = key };
                mat.color = hue;
                Debug.LogWarning("OpenSlope: OpenSlope/FlareHalo shader not found - glint fell back to a flat additive quad.");
            }
            AssetDatabase.CreateAsset(mat, _cfg.MatFolder + "/" + key + ".mat");
            cache[key] = mat;
            return mat;
        }

        // Standalone re-runnable build (after tuning the LightGlow* config), mirroring the other OpenSlope/Refresh items.
        [MenuItem("OpenSlope/Refresh/Light Glows", false, 323)]
        public static void RefreshLightGlows()
        {
            var cfg = ImportConfig.Current();
            var root = GameObject.Find(cfg.RootName);
            if (root == null) { Debug.LogError("OpenSlope: import a map first (OpenSlope/Load)."); return; }
            var level = root.transform.Find(cfg.LevelName) ?? root.transform;
            new LightGlowBuilder(cfg).Build(level);
            AssetDatabase.SaveAssets();
            Debug.Log("OpenSlope: re-imported light glints.");
        }
        [MenuItem("OpenSlope/Refresh/Light Glows", true)]
        static bool RefreshLightGlowsEnabled() => GameObject.Find(ImportConfig.Current().RootName) != null;
    }
}
#endif
