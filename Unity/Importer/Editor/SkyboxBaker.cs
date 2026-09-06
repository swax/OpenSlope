#if UNITY_EDITOR
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.Experimental.Rendering;

namespace OpenSlope.Importer
{

    // Bakes the exported Skybox.obj backdrop into a cubemap from its centre (infinite, parallax-free) and
    // sets it as RenderSettings.skybox - the way SSX draws its sky. The geometry is only used transiently
    // for the bake (on an isolated layer) and removed afterwards. See docs/unity/006-skybox.md.
    public class SkyboxBaker
    {
        const int SkyboxLayer = 31; // transient layer used only while baking the cubemap

        readonly ImportConfig _cfg;
        readonly Shader _shader;

        public SkyboxBaker(ImportConfig cfg, Shader shader) { _cfg = cfg; _shader = shader; }

        public void Bake()
        {
            AssetDatabase.Refresh();
            var model = AssetDatabase.LoadAssetAtPath<GameObject>(_cfg.SkyboxObjPath);
            if (model == null) { Debug.LogWarning("OpenSlope: no Skybox.obj at " + _cfg.SkyboxObjPath + " (skipping skybox)."); return; }

            var go = (GameObject)Object.Instantiate(model);
            go.name = "OpenSlope_SkyboxGeo";
            go.transform.eulerAngles = _cfg.RootEuler;  // upright, same convention as the level
            SetLayerRecursive(go, SkyboxLayer);

            // Skybox sub-meshes are named mat_N and map 1:1 to Skybox/Textures/{N:D4}.png.
            var cache = new Dictionary<string, Material>();
            foreach (var r in go.GetComponentsInChildren<MeshRenderer>())
            {
                var src = r.sharedMaterials;
                var dst = new Material[src.Length];
                for (int i = 0; i < src.Length; i++)
                {
                    string slot = src[i] != null ? src[i].name : "";
                    string s = slot.StartsWith("mat_") ? slot.Substring(4) : slot;
                    string tex = int.TryParse(s, out int id) ? id.ToString("D4") + ".png" : null;
                    string key = tex ?? "__none";
                    if (!cache.TryGetValue(key, out var m))
                    {
                        m = new Material(_shader) { name = "sky_" + (tex != null ? id.ToString("D4") : "none") };
                        if (tex != null)
                        {
                            var t = AssetDatabase.LoadAssetAtPath<Texture2D>(_cfg.SkyboxTexDir + "/" + tex);
                            if (t != null)
                            {
                                // Clamp BOTH axes so bilinear filtering at a quad's edge samples only itself,
                                // never wrapping to the opposite row/column of the texture. See docs/unity/006.
                                //  - V (top edge): the painted sky's top row would otherwise wrap to the
                                //    bottom row and bleed a bright horizontal seam where it meets the fill cap.
                                //  - U (side edges): the ring is DISCRETE panels - each mat_N is its own
                                //    texture spanning U 0..1, not one texture tiling around - so a Repeat wrap
                                //    bleeds a panel's far edge across the corner into its neighbour, leaving a
                                //    vertical seam at every join. Clamp keeps the touching edges matching.
                                t.wrapMode = TextureWrapMode.Clamp;
                                m.mainTexture = t;
                            }
                        }
                        cache[key] = m;
                    }
                    dst[i] = m;
                }
                r.sharedMaterials = dst;
            }

            var rends = go.GetComponentsInChildren<MeshRenderer>();
            Bounds b = rends[0].bounds;
            foreach (var r in rends) b.Encapsulate(r.bounds);

            // Render the cylinder with a magenta SENTINEL clear colour (MSAA off so silhouette edges stay
            // hard, not blended toward the sentinel). The open top/bottom bake as pure sentinel, which we
            // recolour below - that's how we tell "sky" from "hole" without any per-level tuning.
            var cubemap = new Cubemap(1024, TextureFormat.RGBA32, false);
            var camGO = new GameObject("OpenSlope_CubeCam");
            var cam = camGO.AddComponent<Camera>();
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = Sentinel;
            cam.allowMSAA = false;
            cam.cullingMask = 1 << SkyboxLayer;                       // bake ONLY the skybox geo
            cam.nearClipPlane = Mathf.Max(b.size.magnitude * 0.0005f, 0.01f);
            cam.farClipPlane = b.size.magnitude * 4f;
            camGO.transform.position = b.center;

            // Our level shader applies distance fog (below), and RenderToCubemap renders that same skybox
            // geometry - so if scene fog is on it would fog the SKY into the cubemap and wash it out. Bake the
            // sky with fog OFF; we turn fog back on (for the terrain) only after the cubemap is captured.
            bool prevFog = RenderSettings.fog;
            RenderSettings.fog = false;
            cam.RenderToCubemap(cubemap);
            RenderSettings.fog = prevFog;

            // Derive both sky colours from the sentinel'd bake BEFORE filling the holes: the cap fill from the
            // TOP edge of the band (zenith) and the fog colour from the BOTTOM edge (horizon haze). Once
            // FillSentinel runs the holes are recoloured, so the horizon sample must be taken here first.
            Color fill = _cfg.AutoSkyFill ? DeriveSkyFill(cubemap, _cfg.SkyFillColor) : _cfg.SkyFillColor;
            Color fog  = (_cfg.Fog && _cfg.FogColorAuto) ? DeriveHorizonColor(cubemap, _cfg.FogColor) : _cfg.FogColor;

            // Recolour the open top/bottom to match the sky at the cylinder's top edge so the cap blends in.
            FillSentinel(cubemap, fill);
            Debug.Log("OpenSlope: skybox cap fill = " + fill + (_cfg.AutoSkyFill ? " (auto)" : " (override)"));

            // The Skybox/Cubemap shader samples this script-created cubemap without an sRGB->linear decode, and
            // RenderToCubemap fills it with display-space (gamma) colour. In a Linear project, store the sky as
            // LINEAR values in a UNorm cubemap so the linear sample reproduces the panel colours. A Gamma
            // project samples the sRGB colour directly, so it keeps the cubemap as baked.
            Cubemap skyCube = cubemap;
            if (QualitySettings.activeColorSpace == ColorSpace.Linear)
            {
                skyCube = new Cubemap(cubemap.width, GraphicsFormat.R8G8B8A8_UNorm, TextureCreationFlags.None);
                foreach (CubemapFace cf in System.Enum.GetValues(typeof(CubemapFace)))
                {
                    if ((int)cf < 0 || (int)cf > 5) continue;
                    var px = cubemap.GetPixels(cf);
                    for (int i = 0; i < px.Length; i++) px[i] = px[i].linear;
                    skyCube.SetPixels(px, cf);
                }
                skyCube.Apply(false);
            }

            AssetDatabase.DeleteAsset(_cfg.LevelFolder + "/SkyboxCubemap.cubemap");
            AssetDatabase.CreateAsset(skyCube, _cfg.LevelFolder + "/SkyboxCubemap.cubemap");
            var skyboxMat = new Material(Shader.Find("Skybox/Cubemap"));
            skyboxMat.SetTexture("_Tex", skyCube);
            AssetDatabase.DeleteAsset(_cfg.LevelFolder + "/SkyboxMat.mat");
            AssetDatabase.CreateAsset(skyboxMat, _cfg.LevelFolder + "/SkyboxMat.mat");
            RenderSettings.skybox = skyboxMat;
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Skybox;
            // Pin the environment Intensity Multiplier (set BEFORE UpdateEnvironment so the recomputed ambient
            // probe reflects it). It's a runtime multiplier on the sky-derived ambient that the unlit world
            // ignores but the probe-lit dynamic objects (avatar + board) ride on; left unpinned it had drifted
            // to the slider's max of 8 and washed out their shade darkening (see SkyAmbientIntensity / docs/unity/010).
            RenderSettings.ambientIntensity = _cfg.SkyAmbientIntensity;
            DynamicGI.UpdateEnvironment();

            // Kill the sun's realtime shadow pass. The unlit level art neither casts nor receives shadows, so a
            // realtime directional shadow only shadows the dynamic objects (avatar + board) - a per-frame
            // shadow-map render (doubled in VR) for almost no payoff. Pinning it here makes a re-import reset any
            // manual drift back to Soft. The light itself stays (it's the avatar/board sun + probe L1 seed).
            if (_cfg.SunShadowsOff)
            {
                int off = 0;
                foreach (var l in Object.FindObjectsOfType<Light>(true))
                    if (l.type == LightType.Directional && l.shadows != LightShadows.None)
                    {
                        l.shadows = LightShadows.None;
                        EditorUtility.SetDirty(l);
                        off++;
                    }
                if (off > 0) Debug.Log($"OpenSlope: disabled realtime shadows on {off} directional light(s) (SunShadowsOff).");
            }

            // Fog: SSX fades distant terrain into the horizon haze (it cuts off a few hundred m). Linear fog toward the
            // horizon colour so terrain dissolves into the same colour the sky shows there; Unity doesn't fog
            // the skybox itself, so only the terrain/props fade and the painted sky stays crisp. (docs/unity/006)
            if (_cfg.Fog)
            {
                RenderSettings.fog = true;
                RenderSettings.fogMode = FogMode.Linear;
                RenderSettings.fogColor = fog;
                RenderSettings.fogStartDistance = _cfg.FogStartDistance;
                RenderSettings.fogEndDistance = _cfg.FogEndDistance;
                Debug.Log("OpenSlope: fog " + _cfg.FogStartDistance + "-" + _cfg.FogEndDistance + "m, colour = " + fog
                          + (_cfg.FogColorAuto ? " (auto)" : " (override)"));
            }
            AssetDatabase.SaveAssets();

            Object.DestroyImmediate(camGO);
            Object.DestroyImmediate(go);
            foreach (var m in cache.Values) Object.DestroyImmediate(m);
            Debug.Log("OpenSlope: skybox baked to cubemap and set as RenderSettings.skybox.");
        }

        static void SetLayerRecursive(GameObject g, int layer)
        {
            g.layer = layer;
            foreach (Transform c in g.transform) SetLayerRecursive(c.gameObject, layer);
        }

        // Magenta clear colour for the bake: a hue that can't occur in an SSX sky, so the open top/bottom of
        // the cylinder are trivially identifiable as "not sky" afterwards.
        static readonly Color Sentinel = new Color(1f, 0f, 1f, 1f);
        static bool IsSentinel(Color p) => p.r > 0.9f && p.g < 0.1f && p.b > 0.9f;

        // Average the sky's colour at the TOP edge of the cylinder ("where the texture meets the sky"): on
        // each side face, walk down each column from the +Y end to the first non-sentinel pixel. With MSAA
        // off that first pixel is clean sky, so no boundary blending leaks in. Falls back if nothing painted.
        static Color DeriveSkyFill(Cubemap cube, Color fallback)
        {
            int s = cube.width; double r = 0, g = 0, b = 0; int n = 0;
            foreach (var f in new[] { CubemapFace.PositiveX, CubemapFace.NegativeX, CubemapFace.PositiveZ, CubemapFace.NegativeZ })
            {
                var px = cube.GetPixels(f);
                for (int x = 0; x < s; x++)
                    for (int y = 0; y < s; y++)   // row 0 is the +Y (up) edge of a side face
                    {
                        var p = px[y * s + x];
                        if (!IsSentinel(p)) { r += p.r; g += p.g; b += p.b; n++; break; }
                    }
            }
            return n > 0 ? new Color((float)(r / n), (float)(g / n), (float)(b / n), 1f) : fallback;
        }

        // Derive the fog colour from the HAZE at the horizon: on each side face, walk UP each column from the
        // -Y end to the first non-sentinel pixel - the lowest painted texel, where distant terrain meets sky.
        // But the band's bottom edge also holds dark mountain silhouettes, and a flat average of those reads
        // as a dull grey that *darkens* bright snow (i.e. looks like nothing). So average only the brightest
        // ~40% of those horizon samples - the actual haze - giving a light, slightly-cool colour that distant
        // snow washes toward. Falls back if no sky was painted.
        static Color DeriveHorizonColor(Cubemap cube, Color fallback)
        {
            int s = cube.width;
            var band = new List<Color>();
            foreach (var f in new[] { CubemapFace.PositiveX, CubemapFace.NegativeX, CubemapFace.PositiveZ, CubemapFace.NegativeZ })
            {
                var px = cube.GetPixels(f);
                for (int x = 0; x < s; x++)
                    for (int y = s - 1; y >= 0; y--)   // walk up from the -Y (down) edge to the lowest painted sky
                    {
                        var p = px[y * s + x];
                        if (!IsSentinel(p)) { band.Add(p); break; }
                    }
            }
            if (band.Count == 0) return fallback;
            band.Sort((a, c) => Lum(c).CompareTo(Lum(a)));   // brightest first
            int take = Mathf.Max(1, band.Count * 2 / 5);     // brightest ~40% = the haze, not the mountains
            double r = 0, g = 0, b = 0;
            for (int i = 0; i < take; i++) { r += band[i].r; g += band[i].g; b += band[i].b; }
            return new Color((float)(r / take), (float)(g / take), (float)(b / take), 1f);
        }

        static float Lum(Color c) => 0.299f * c.r + 0.587f * c.g + 0.114f * c.b;

        // Recolour every sentinel pixel (the open top/bottom of the cylinder) to the fill colour. The painted
        // sky is left untouched, so only the holes change - the hard silhouette edge vanishes into the cap.
        static void FillSentinel(Cubemap cube, Color fill)
        {
            foreach (CubemapFace f in System.Enum.GetValues(typeof(CubemapFace)))
            {
                if ((int)f < 0) continue;   // skip CubemapFace.Unknown (-1)
                var px = cube.GetPixels(f); bool any = false;
                for (int i = 0; i < px.Length; i++) if (IsSentinel(px[i])) { px[i] = fill; any = true; }
                if (any) cube.SetPixels(px, f);
            }
            cube.Apply();
        }
    }
}
#endif
