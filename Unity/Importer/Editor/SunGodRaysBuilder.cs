#if UNITY_EDITOR
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Builds the SUN GOD-RAYS - the corona and radial beams seen when looking toward the sun
    // ([Trailmap: 400-rendering], the celestial glare section). The final retail submission is exactly two
    // primitives: one white textured corona billboard tinted by RimColour, and one screen-space TRIANGLE FAN
    // tinted uniformly by CoreColour. Both are additive and depth-blind; the calculated 16-pixel core rect and
    // the neighbouring lens-atlas star/ring tiles are not submitted.
    //
    // OpenSlope uses an original deterministic formula for its angle/intensity pattern rather than embedding
    // the engine's arbitrary spoke table. It bakes the fan and corona quad into one mesh; their colours,
    // intensities, corona radius, direction and placement distance come directly from World.json.
    // OpenSlope/SunGodRays does the placement (see that shader for the two modes and why VR gets the
    // billboard one).
    //
    // Imported per-course parameters come from World.json. Any other level - including an authored one -
    // falls back to its own manifest sun hue, so the effect is not retail-only.
    public class SunGodRaysBuilder
    {
        public const string RaysObjectName = "SunGodRays";
        public const float FanDisplayGain = 128f / 255f;
        public const float CoronaDisplayGain = 255f / 128f;

        readonly ImportConfig _cfg;
        public SunGodRaysBuilder(ImportConfig cfg) { _cfg = cfg; }

        // Project-authored procedural pattern, matching Slopesmith's formula. The golden-angle phase drives
        // a bounded position offset and two brightness waves; it is deterministic and remains ordered.
        const int RayCount = 32;
        const float GoldenPhase = 2.39996323f;

        static float RayDegree(int index)
        {
            return index * (360f / RayCount) + Mathf.Sin(index * GoldenPhase) * 3.2f;
        }

        static float RayAmplitude(int index)
        {
            return 0.18f
                + 0.24f * (1f + Mathf.Sin(index * GoldenPhase + 0.9f))
                + 0.12f * (1f + Mathf.Sin(index * 1.173f + 2.1f));
        }

        // The glare's settings are MAP DATA, not constants in this file: snowknife reads the course's
        // world-configuration record off the disc at import and writes it to the map folder as World.json
        // ([Trailmap: 400-rendering], the celestial-glare section), so an authored mountain can carry its own
        // and a retail one carries what it shipped with. A map with no World.json simply has no glare.
        public struct CourseGlare
        {
            public Color Core, Rim;
            /// <summary>
            /// Per-course multiplier applied to the untextured fan ([Trailmap: 400-celestial-params]).
            /// </summary>
            public float FanIntensity;
            /// <summary>
            /// Per-course multiplier applied to the textured corona ([Trailmap: 400-celestial-params]).
            /// </summary>
            public float SpriteIntensity;
            /// <summary>The authored placement distance, in metres (map units x WorldScale).</summary>
            public float DistanceM;
            /// <summary>The corona radius/half-extent, in metres (map units x WorldScale).</summary>
            public float RadiusM;
            /// <summary>
            /// The celestial sun's own azimuth/elevation in degrees, or NaN when the map authored none.
            /// This is a SEPARATE field from the course's lighting sun and need not agree with it -
            /// Mesablanca lights from high up but puts its glare 2.5 deg off the horizon, which is the
            /// whole point of a sun you ride toward. Every shipped glare sits within 13 deg of the horizon.
            /// </summary>
            public float Az, El;
        }

        /// <summary>
        /// The authored azimuth/elevation as a Unity-world TO-SUN vector. In the game's own frame the
        /// direction is (cos az * cos el, sin az * cos el, sin el) with the third component up, and it
        /// already points toward the sun (the engine places the sprite along it). Raw -> Unity world for a
        /// direction is (-rawX, rawZ, -rawY) - the mapping snowknife's own sun conversion documents and
        /// that geometry uses - so Unity's Y receives sin(el) and elevation stays elevation.
        /// </summary>
        public static Vector3 ToSunFromAzEl(float azDeg, float elDeg)
        {
            float a = azDeg * Mathf.Deg2Rad, e = elDeg * Mathf.Deg2Rad;
            float x = Mathf.Cos(a) * Mathf.Cos(e), y = Mathf.Sin(a) * Mathf.Cos(e), z = Mathf.Sin(e);
            return new Vector3(-x, z, -y).normalized;
        }

        // How far the beams reach, as a half-angle. This is NOT the sun's authored size (that is its SPRITE,
        // 7-24 deg across the four courses): on console the rays run to the screen corners on every course,
        // so reach is a property of the view, not of the level. 40 deg reads like the PS2 at a normal
        // desktop FOV; the material exposes it for retuning.
        const float RayReachDegrees = 40f;

        // force = build even on a course the retail game leaves dark. The automatic import path passes
        // false, because the glare is NOT a universal effect: nine of the thirteen shipped slots switch it
        // off, and lighting Garibaldi with sun beams would be a fabrication rather than a port. The menu
        // passes true so an authored mountain can opt in.
        public void Build(Transform root, bool force = false)
        {
            var old = root.Find(RaysObjectName);
            if (old != null) Object.DestroyImmediate(old.gameObject);

            var authoredGlare = ReadMapGlare();
            if (!force && authoredGlare == null)
                return;   // this map authors no glare; say nothing on the common path

            var sh = Shader.Find("OpenSlope/SunGodRays");
            if (sh == null) { Debug.LogWarning("OpenSlope: sun god-rays - OpenSlope/SunGodRays shader not found; skipped."); return; }

            var go = new GameObject(RaysObjectName);
            go.transform.SetParent(root, false);
            // World metres, not SSX units: the shader places the fan itself from _Distance and the camera
            // position, so the object must not inherit the Level node's centimetre scale.
            go.transform.localScale = Vector3.one;
            var glare = ResolveGlare(authoredGlare, out string source);
            // The shader reads the object's -forward as the direction TO the sun. A retail course authors the
            // glare's OWN angles, which do NOT have to match the lighting sun (Mesablanca lights from high up
            // and glares 2.5 deg off the horizon), so those win; anything else follows the level's sun the way
            // SunBuilder points the scene Directional Light.
            bool authored = !float.IsNaN(glare.Az) && !float.IsNaN(glare.El) && (glare.Az != 0f || glare.El != 0f);
            Vector3 toSun = authored ? ToSunFromAzEl(glare.Az, glare.El)
                          : _cfg.PropDirLightDir.sqrMagnitude > 1e-6f ? _cfg.PropDirLightDir.normalized
                          : Vector3.up;
            go.transform.rotation = Quaternion.LookRotation(-toSun, Vector3.up);

            var mf = go.AddComponent<MeshFilter>();
            mf.sharedMesh = BuildGlareMesh();

            var rend = go.AddComponent<MeshRenderer>();
            rend.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            rend.receiveShadows = false;
            rend.lightProbeUsage = UnityEngine.Rendering.LightProbeUsage.Off;
            rend.reflectionProbeUsage = UnityEngine.Rendering.ReflectionProbeUsage.Off;
            // The vertex shader relocates every vertex to cameraPos + sunDir * _Distance, so the mesh's own
            // AABB says nothing about where it draws. Without huge bounds Unity frustum-culls the whole fan
            // the moment the (stationary) object leaves the view.
            rend.localBounds = new Bounds(Vector3.zero, Vector3.one * 1e6f);

            var mat = new Material(sh) { name = "SunGodRays" };
            // SetVector is deliberate: Unity's SetColor path can colour-space-convert authored display RGB
            // in a linear project. The GS capture is display-byte-domain math, so preserve r/255, g/255, b/255
            // verbatim just as the Slopesmith shader does.
            mat.SetVector("_CoreColor", new Vector4(glare.Core.r, glare.Core.g, glare.Core.b, 1f));
            mat.SetVector("_RimColor", new Vector4(glare.Rim.r, glare.Rim.g, glare.Rim.b, 1f));
            mat.SetFloat("_FanIntensity", glare.FanIntensity);
            mat.SetFloat("_SpriteIntensity", glare.SpriteIntensity);
            mat.SetFloat("_FanDisplayGain", FanDisplayGain);
            mat.SetFloat("_CoronaDisplayGain", CoronaDisplayGain);
            mat.SetFloat("_Distance", glare.DistanceM);
            mat.SetFloat("_CoronaRadius", glare.RadiusM);
            mat.SetFloat("_AngularRadius", RayReachDegrees);
            mat.SetFloat("_Intensity", 1.0f);
            mat.SetFloat("_EdgeStart", 0.72f);
            // Retail uses only the top-right 128x128 corona tile of PARTICLE.SSH `lens`. The procedural
            // inverse-smoothstep fallback in the shader has the same broad profile for authored maps whose
            // texture payload is missing, but an extracted course normally takes this exact atlas path.
            var lensTex = AssetDatabase.LoadAssetAtPath<Texture2D>(_cfg.LevelFolder + "/Textures/Particles/lens.png");
            if (lensTex != null)
            {
                mat.EnableKeyword("_CORONATEX");
                mat.SetTexture("_CoronaTex", lensTex);
            }
            else Debug.LogWarning("OpenSlope: lens.png not found under Textures/Particles - sun corona uses the procedural fallback.");
            rend.sharedMaterial = mat;

            // Source-visibility fade: both glare primitives are depth-blind (the engine's own model, and what
            // makes the beams lie ACROSS the mountain), but the effect still answers to whether the sun is in
            // view - washing over a ridge as it clears, dropping away once it is behind. The marker is
            // neutral; the platform wiring realizes the runtime fader.
            var fade = go.AddComponent<SunGlareFadeMarker>();
            fade.fadePerSecond = 2f;
            fade.range = Mathf.Max(200f, glare.DistanceM * 2f);   // past the far terrain; the sun is effectively at infinity
            fade.spreadDegrees = Mathf.Atan2(glare.RadiusM, Mathf.Max(0.01f, glare.DistanceM)) * Mathf.Rad2Deg;
            fade.minVisibility = 0f;
            // Occluders = the world; exclude UI(5), Player(9)/PlayerLocal(10), pickups(13), mirror(18),
            // walkthrough(14) and the Foliage swish layer (24) - the same exclusions the glint fade uses.
            fade.occluderMask = ~((1 << 5) | (1 << 9) | (1 << 10) | (1 << 13) | (1 << 14) | (1 << 18) | (1 << 24));

            Debug.Log($"OpenSlope: sun god-rays built - {RayCount} generated spokes + 4 corner spokes, to-sun {toSun}, " +
                      $"{glare.DistanceM:0.#} m out, {glare.RadiusM:0.#} m corona radius, reach {RayReachDegrees:0.#} deg, " +
                      $"fan {glare.FanIntensity:0.###}, corona {glare.SpriteIntensity:0.###}, colours from {source}" +
                      (authored ? $" (authored az {glare.Az:0.##} / el {glare.El:0.##}). " : ". ") +
                      "Screen-fill (the console's law) on flat; VR is forced to the billboard in-shader.");
        }

        // The map's own glare when it authored one; otherwise - only reachable from the menu, which forces a
        // build - the level's sun hue, with the rim a dimmed, desaturated version of the core the way the
        // shipped pairs are, so a mountain with no World.json can still be looked at.
        CourseGlare ResolveGlare(CourseGlare? authored, out string source)
        {
            if (authored is CourseGlare g) { source = WorldFileName; return g; }

            Color hue = _cfg.HasManifestSun ? _cfg.PropDirLightColor : Color.white;
            source = _cfg.HasManifestSun ? "the level's manifest sun hue (no " + WorldFileName + ")" : "default";
            return new CourseGlare
            {
                Core = hue,
                Rim = Color.Lerp(hue, new Color(0.5f, 0.45f, 0.4f, 1f), 0.5f),
                FanIntensity = 0.37f,
                SpriteIntensity = 0.45f,
                DistanceM = 240f,   // project-authored fallback; the shader clamps it under the far plane anyway
                RadiusM = 72f,
                Az = float.NaN, El = float.NaN,   // no authored celestial angles -> follow the level's own sun
            };
        }

        public const string WorldFileName = "World.json";

        /// <summary>
        /// The map's authored glare, or null when it has no World.json or its glare is switched off. Written by
        /// `snowknife import` (or `snowknife world` on an existing map) from the course's world-configuration
        /// record; an authored mountain writes its own. Units are the map's, so distance and radius convert by WorldScale.
        /// </summary>
        CourseGlare? ReadMapGlare()
        {
            string path = Path.Combine(Path.GetDirectoryName(Application.dataPath)!, _cfg.LevelFolder + "/" + WorldFileName);
            if (!File.Exists(path)) return null;
            try
            {
                var glare = JObject.Parse(File.ReadAllText(path))["Glare"] as JObject;
                if (glare == null || (bool?)glare["Enabled"] != true) return null;
                return new CourseGlare
                {
                    Core = ReadColour(glare["CoreColour"] as JArray, new Color(1f, 184f / 255f, 92f / 255f, 1f)),
                    Rim = ReadColour(glare["RimColour"] as JArray, new Color(112f / 255f, 72f / 255f, 38f / 255f, 1f)),
                    FanIntensity = Mathf.Max(0f, (float?)glare["FanIntensity"] ?? 0.37f),
                    SpriteIntensity = Mathf.Max(0f, (float?)glare["SpriteIntensity"] ?? 0.45f),
                    DistanceM = ((float?)glare["DistanceUnits"] ?? 24000f) * _cfg.WorldScale,
                    RadiusM = Mathf.Max(0f, ((float?)glare["SizeUnits"] ?? 7200f) * _cfg.WorldScale),
                    Az = (float?)glare["AzimuthDegrees"] ?? float.NaN,
                    El = (float?)glare["ElevationDegrees"] ?? float.NaN,
                };
            }
            catch (System.Exception e)
            {
                Debug.LogWarning($"OpenSlope: sun god-rays - could not read {path}: {e.Message}");
                return null;
            }
        }

        static Color ReadColour(JArray a, Color fallback) =>
            a != null && a.Count >= 3 ? new Color((float)a[0] / 255f, (float)a[1] / 255f, (float)a[2] / 255f, 1f) : fallback;

        // One fan wedge per spoke followed by one corona quad. Fan vertices have z=0 and corona vertices z=1;
        // the shader uses that tag to select screen-fill/billboard placement and the correct retail transfer.
        // The corona's UVs select only the atlas's top-right quadrant. Fan rim vertices sit on the UNIT circle -
        // the shader decides whether that means a fixed angular radius (billboard) or a walk to the screen border.
        //
        // The four extra spokes on the diagonals are the static stand-in for something the engine does per
        // frame: it computes the angles from the sun to the four screen CORNERS and splices them into the
        // fan in angular order, so the polygon stays convex right into the corners. A baked mesh cannot
        // track a moving sun, so the diagonals are seeded instead (exact when the sun is centred, and it
        // only ever costs a slightly clipped corner otherwise). Their intensity is interpolated from the
        // generated neighbours so they add no brightness of their own.
        public static Mesh BuildGlareMesh()
        {
            var angles = new List<float>(RayCount + 4);
            var amps = new List<float>(RayCount + 4);
            for (int i = 0; i < RayCount; i++) { angles.Add(RayDegree(i)); amps.Add(RayAmplitude(i)); }
            foreach (float corner in new[] { 45f, 135f, 225f, 315f })
            {
                int at = angles.BinarySearch(corner);
                if (at >= 0) continue;                       // already a generated spoke
                at = ~at;
                angles.Insert(at, corner);
                amps.Insert(at, InterpolatedAmp(corner));
            }

            // FLAT-SHADED WEDGES, not a smooth star. Each generated entry owns the wedge running from its
            // own angle to the next one's, so brightness STEPS at every boundary and the rays come out as
            // hard-edged bands - which is what the game shows. Share the rim vertices between neighbours
            // instead and Gouraud blends each ray into the next over ~10 degrees, which reads as a smooth
            // radial glow with no beams in it at all. So every wedge gets its own three vertices.
            //
            // All three carry the SAME brightness, centre included. The final retail packer applies the
            // fan colour/intensity uniformly to each submitted vertex; the separate corona supplies the
            // broad centre energy that washes out the wedge convergence.
            int n = angles.Count;
            int fanVerts = n * 3;
            var verts = new Vector3[fanVerts + 4];
            var cols = new Color[fanVerts + 4];
            var uvs = new Vector2[fanVerts + 4];
            var tris = new int[fanVerts + 6];
            for (int i = 0; i < n; i++)
            {
                float a0 = angles[i] * Mathf.Deg2Rad;
                float a1 = (i + 1 < n ? angles[i + 1] : angles[0] + 360f) * Mathf.Deg2Rad;
                var col = new Color(1f, 1f, 1f, amps[i]);
                int b = i * 3;
                verts[b + 0] = Vector3.zero;
                verts[b + 1] = new Vector3(Mathf.Cos(a0), Mathf.Sin(a0), 0f);
                verts[b + 2] = new Vector3(Mathf.Cos(a1), Mathf.Sin(a1), 0f);
                cols[b + 0] = cols[b + 1] = cols[b + 2] = col;
                tris[b + 0] = b + 0; tris[b + 1] = b + 1; tris[b + 2] = b + 2;
            }

            int q = fanVerts;
            verts[q + 0] = new Vector3(-1f, -1f, 1f);
            verts[q + 1] = new Vector3( 1f, -1f, 1f);
            verts[q + 2] = new Vector3( 1f,  1f, 1f);
            verts[q + 3] = new Vector3(-1f,  1f, 1f);
            cols[q + 0] = cols[q + 1] = cols[q + 2] = cols[q + 3] = Color.white;
            uvs[q + 0] = new Vector2(0.5f, 0.5f);
            uvs[q + 1] = new Vector2(1.0f, 0.5f);
            uvs[q + 2] = new Vector2(1.0f, 1.0f);
            uvs[q + 3] = new Vector2(0.5f, 1.0f);
            tris[fanVerts + 0] = q + 0; tris[fanVerts + 1] = q + 1; tris[fanVerts + 2] = q + 2;
            tris[fanVerts + 3] = q + 0; tris[fanVerts + 4] = q + 2; tris[fanVerts + 5] = q + 3;

            var mesh = new Mesh { name = "SunGodRaysGlare" };
            mesh.vertices = verts;
            mesh.colors = cols;
            mesh.uv = uvs;
            mesh.triangles = tris;
            mesh.bounds = new Bounds(Vector3.zero, Vector3.one * 1e6f);
            return mesh;
        }

        // Linear interpolation of the generated intensity between two spokes, wrapping at 360.
        static float InterpolatedAmp(float deg)
        {
            int last = RayCount - 1;
            for (int i = 0; i <= last; i++)
            {
                float a0 = RayDegree(i);
                float a1 = i == last ? RayDegree(0) + 360f : RayDegree(i + 1);
                if (deg < a0 || deg > a1) continue;
                float t = Mathf.InverseLerp(a0, a1, deg);
                float v0 = RayAmplitude(i);
                float v1 = i == last ? RayAmplitude(0) : RayAmplitude(i + 1);
                return Mathf.Lerp(v0, v1, t);
            }
            return RayAmplitude(0);
        }

        [MenuItem("OpenSlope/Refresh/Sun God Rays", false, 322)]
        public static void Menu()
        {
            var cfg = ImportConfig.Current();
            var root = GameObject.Find(cfg.RootName);
            if (root == null) { Debug.LogWarning("OpenSlope: sun god-rays - no map root in the scene."); return; }
            new SunGodRaysBuilder(cfg).Build(root.transform, force: true);
        }
        [MenuItem("OpenSlope/Refresh/Sun God Rays", true)]
        static bool MenuEnabled() => GameObject.Find(ImportConfig.Current().RootName) != null;
    }
}
#endif
