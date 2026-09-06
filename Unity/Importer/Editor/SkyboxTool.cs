#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{
    using UnityEngine.Experimental.Rendering;   // GraphicsFormatUtility - detect a linear vs sRGB source cube on export

    // Skybox Tool - the full round-trip for custom skies, kept OUT of the imported level folder (which stays pure
    // importer output). Two steps in one window:
    //
    //   1. EXPORT existing  : a cubemap skybox (e.g. the imported gari day sky, or the current one) -> a single
    //                         equirectangular (360x180, 2:1) PNG you can edit in any image app.
    //   (2. convert that PNG externally - e.g. an image-gen app turning the day sky into a night sky.)
    //   3. BUILD            : an equirect PNG + a name -> a COMPRESSED, mipmapped cubemap skybox in DataDir:
    //                           <Name>.png       (source-of-truth AND the cube asset - imported as a lat-long
    //                                             cubemap, so Unity applies per-platform GPU compression
    //                                             [DXT/BC on PC, ASTC on Quest] + a mip chain; ~3-8 MB in a build
    //                                             vs ~24 MB for a raw code-baked .cubemap, and no uncompressed
    //                                             RGBA cube sitting in VRAM at runtime)
    //                           <Name>.mat       (Skybox/Cubemap material)
    //                         To use it: drag the .mat into Lighting > Environment > Skybox Material. (Build also
    //                         logs a suggested fog colour from the horizon.)
    //
    // EXPORT writes a standard equirect (top = zenith, longitude across). BUILD imports it through Unity's
    // Cylindrical (lat-long) cube generation, so a freshly authored sky lands upright; round-tripping the game's
    // own baked sky may yaw it (Unity's longitude origin differs from the exporter's). Face size caps at FaceSize
    // (1024) to match the game's bake (SkyboxBaker.cs). See docs/unity/006-skybox.md.
    public class SkyboxTool : EditorWindow
    {
        // Authored skyboxes are part of the OpenSlope install, not level data, so they sit beside the library
        // under the same root rather than in a top-level Assets/ folder of their own.
        const string DataDir = MapLayout.AssetsRoot + "/Skyboxes";
        const int FaceSize = 1024;

        // Export
        Cubemap _exportCube;
        int _exportWidth = 4096;     // equirect width (height = width/2); 4096x2048 matches a 1024/face cube
        string _exportResult = "";

        // Build
        string _pngPath = "";
        string _name = "";
        string _buildResult = "";

        [MenuItem("OpenSlope/Tools/Skybox Tool...", false, 700)]
        public static void Open()
        {
            var w = GetWindow<SkyboxTool>(true, "Skybox Tool");
            w.minSize = new Vector2(460, 360);
        }

        void OnEnable() => PopulateExportFromCurrent();

        void OnGUI()
        {
            // ---- 1. Export ----------------------------------------------------------------------------------
            EditorGUILayout.LabelField("1. Export existing skybox → equirect PNG", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox("Pick a cubemap (defaults to the scene's current skybox) and save it as a "
                + "360x180 PNG to edit externally.", MessageType.None);
            using (new EditorGUILayout.HorizontalScope())
            {
                _exportCube = (Cubemap)EditorGUILayout.ObjectField("Source cubemap", _exportCube, typeof(Cubemap), false);
                if (GUILayout.Button("Use current", GUILayout.Width(90))) PopulateExportFromCurrent();
            }
            _exportWidth = EditorGUILayout.IntPopup("Equirect width", _exportWidth,
                new[] { "2048", "4096", "8192" }, new[] { 2048, 4096, 8192 });
            using (new EditorGUI.DisabledScope(_exportCube == null))
                if (GUILayout.Button("Export Equirect PNG...", GUILayout.Height(24)))
                {
                    string def = (_exportCube != null ? _exportCube.name : "skybox") + "_equirect.png";
                    string outPath = EditorUtility.SaveFilePanel("Export equirect PNG", DefaultExportDir(), def, "png");
                    if (!string.IsNullOrEmpty(outPath))
                    {
                        _exportResult = ExportEquirect(_exportCube, _exportWidth, outPath);
                        // Offer it straight to the Build step.
                        if (_exportResult.StartsWith("Exported")) { _pngPath = outPath; }
                    }
                }
            if (!string.IsNullOrEmpty(_exportResult))
                EditorGUILayout.HelpBox(_exportResult, MessageType.Info);

            EditorGUILayout.Space();
            DrawSeparator();
            EditorGUILayout.Space();

            // ---- 3. Build -----------------------------------------------------------------------------------
            EditorGUILayout.LabelField("3. Build skybox from equirect PNG", EditorStyles.boldLabel);
            EditorGUILayout.HelpBox("Pick a 360x180 equirectangular image (2:1 is ideal; other ratios are mapped "
                + "across the full sphere and stretch a little). Builds into " + DataDir + ".\n"
                + "To use it: drag the generated .mat into Lighting > Environment > Skybox Material.", MessageType.None);
            using (new EditorGUILayout.HorizontalScope())
            {
                _pngPath = EditorGUILayout.TextField("Equirect PNG", _pngPath);
                if (GUILayout.Button("Browse", GUILayout.Width(70)))
                {
                    string p = EditorUtility.OpenFilePanel("Select equirectangular PNG", DefaultExportDir(), "png");
                    if (!string.IsNullOrEmpty(p))
                    {
                        _pngPath = p;
                        if (string.IsNullOrEmpty(_name)) _name = SanitizeName(Path.GetFileNameWithoutExtension(p));
                    }
                }
            }
            _name = EditorGUILayout.TextField("Name", _name);
            bool canBuild = !string.IsNullOrEmpty(_pngPath) && File.Exists(_pngPath) && !string.IsNullOrEmpty(_name);
            using (new EditorGUI.DisabledScope(!canBuild))
                if (GUILayout.Button("Build & Add to OpenSlope Skyboxes", GUILayout.Height(28)))
                    _buildResult = Build(_pngPath, _name);
            if (!string.IsNullOrEmpty(_buildResult))
                EditorGUILayout.HelpBox(_buildResult, MessageType.Info);
        }

        // ---- Export -----------------------------------------------------------------------------------------

        void PopulateExportFromCurrent()
        {
            var m = RenderSettings.skybox;
            if (m != null && m.HasProperty("_Tex"))
            {
                var t = m.GetTexture("_Tex") as Cubemap;
                if (t != null) _exportCube = t;
            }
        }

        // Render a cubemap to an equirectangular PNG. For each output pixel: (lon,lat) -> direction -> sample the
        // cube. Inverse of Build's mapping, so a sky round-trips upright. Returns a human-readable result.
        public static string ExportEquirect(Cubemap cube, int width, string outPath)
        {
            if (cube == null) return "ERROR: no source cubemap.";
            width = Mathf.Clamp(width, 256, 8192);
            int W = width, H = width / 2, fs = cube.width;

            Color[][] faces;
            try { faces = ReadFaces(cube); }
            catch (Exception e) { return "ERROR: couldn't read cubemap pixels (" + e.Message + ")."; }

            // The output PNG is sRGB. A LINEAR source cube (e.g. the game's RenderToCubemap day sky, which is
            // R8G8B8A8_UNorm) stores linear-light bytes, so gamma-encode them into the sRGB PNG; an sRGB source
            // cube already holds sRGB bytes and is copied verbatim. This keeps Export a true inverse of Build
            // (which bakes sRGB cubes) for either source color space.
            bool srcLinear = !GraphicsFormatUtility.IsSRGBFormat(cube.graphicsFormat);
            var outTex = new Texture2D(W, H, TextureFormat.RGBA32, false);
            var pix = new Color[W * H];
            for (int y = 0; y < H; y++)
            {
                float lat = Mathf.PI * 0.5f - ((y + 0.5f) / H) * Mathf.PI;   // y=0 (top) -> +90 up
                float cl = Mathf.Cos(lat), sl = Mathf.Sin(lat);
                for (int x = 0; x < W; x++)
                {
                    float lon = ((x + 0.5f) / W) * 2f * Mathf.PI - Mathf.PI;
                    var dir = new Vector3(cl * Mathf.Sin(lon), sl, cl * Mathf.Cos(lon));
                    var c = SampleCube(faces, fs, dir);
                    pix[(H - 1 - y) * W + x] = srcLinear ? c.gamma : c;     // PNG top row = zenith
                }
            }
            outTex.SetPixels(pix); outTex.Apply();
            try { File.WriteAllBytes(outPath, outTex.EncodeToPNG()); }
            catch (Exception e) { UnityEngine.Object.DestroyImmediate(outTex); return "ERROR: couldn't write PNG (" + e.Message + ")."; }
            UnityEngine.Object.DestroyImmediate(outTex);

            Debug.Log("Skybox Tool: exported " + cube.name + " -> " + outPath + " (" + W + "x" + H + ").");
            return "Exported " + W + "x" + H + " to:\n" + outPath;
        }

        static Color[][] ReadFaces(Cubemap cube)
        {
            var order = new[] { CubemapFace.PositiveX, CubemapFace.NegativeX, CubemapFace.PositiveY,
                                CubemapFace.NegativeY, CubemapFace.PositiveZ, CubemapFace.NegativeZ };
            try
            {
                var f = new Color[6][];
                for (int i = 0; i < 6; i++) f[i] = cube.GetPixels(order[i]);
                return f;
            }
            catch
            {
                // Texture-based cubemaps may import non-readable; flip Read/Write and retry once.
                var imp = AssetImporter.GetAtPath(AssetDatabase.GetAssetPath(cube)) as TextureImporter;
                if (imp != null && !imp.isReadable)
                {
                    imp.isReadable = true;
                    imp.SaveAndReimport();
                    var f = new Color[6][];
                    for (int i = 0; i < 6; i++) f[i] = cube.GetPixels(order[i]);
                    return f;
                }
                throw;
            }
        }

        static Color SampleCube(Color[][] faces, int fs, Vector3 dir)
        {
            dir = dir.normalized;
            float ax = Mathf.Abs(dir.x), ay = Mathf.Abs(dir.y), az = Mathf.Abs(dir.z);
            int face; float u, v, ma;
            if (ax >= ay && ax >= az) { if (dir.x >= 0) { face = 0; ma = ax; u = -dir.z; v = -dir.y; } else { face = 1; ma = ax; u = dir.z; v = -dir.y; } }
            else if (ay >= ax && ay >= az) { if (dir.y >= 0) { face = 2; ma = ay; u = dir.x; v = dir.z; } else { face = 3; ma = ay; u = dir.x; v = -dir.z; } }
            else { if (dir.z >= 0) { face = 4; ma = az; u = dir.x; v = -dir.y; } else { face = 5; ma = az; u = -dir.x; v = -dir.y; } }
            float s = 0.5f * (u / ma + 1f), t = 0.5f * (v / ma + 1f);
            int px = Mathf.Clamp((int)(s * fs), 0, fs - 1);
            int py = Mathf.Clamp((int)(t * fs), 0, fs - 1);
            return faces[face][py * fs + px];
        }

        // ---- Build ------------------------------------------------------------------------------------------

        // Builds <name> into DataDir as a COMPRESSED, mipmapped cubemap driven by Unity's texture importer (not a
        // raw code-baked Cubemap). The 2:1 equirect PNG is BOTH the source-of-truth and the cube asset: imported
        // as a lat-long (Cylindrical) cubemap, so Unity picks per-platform GPU compression (DXT/BC on PC, ASTC on
        // Quest) and builds a mip chain - ~3-8 MB in a build vs ~24 MB for an uncompressed code-baked cube. Static
        // so it can be scripted too.
        public static string Build(string pngPath, string name)
        {
            name = SanitizeName(name);
            if (string.IsNullOrEmpty(name)) return "ERROR: empty name.";
            if (!File.Exists(pngPath)) return "ERROR: PNG not found: " + pngPath;
            EnsureDataDir();

            var src = new Texture2D(2, 2, TextureFormat.RGBA32, false);
            if (!src.LoadImage(File.ReadAllBytes(pngPath))) return "ERROR: could not decode " + pngPath;

            // Equirect needs a 2:1 image. A WIDER-than-2:1 panorama (e.g. a 21:9 render - many gen models can't
            // output 2:1) is padded top/bottom to a true 2:1 by extending its edge rows (sky up, ground down) so
            // the scene maps undistorted instead of stretching vertically. Already-2:1 (or taller) is left as-is.
            var eq = PadTo2to1(src);
            Color fog = DeriveFog(eq);

            // Write the 2:1 equirect into DataDir - this PNG IS the asset. Then drive the importer to turn it into
            // a compressed, mipmapped cubemap (no separate ~24 MB code-baked .cubemap).
            string pngAsset = DataDir + "/" + name + ".png";
            string matPath  = DataDir + "/" + name + ".mat";
            File.WriteAllBytes(ProjectPathToAbs(pngAsset), eq.EncodeToPNG());
            AssetDatabase.ImportAsset(pngAsset, ImportAssetOptions.ForceSynchronousImport);

            var imp = (TextureImporter)AssetImporter.GetAtPath(pngAsset);
            imp.textureShape       = TextureImporterShape.TextureCube;
            imp.generateCubemap    = TextureImporterGenerateCubemap.Cylindrical;  // lat-long equirect -> cube faces
            imp.sRGBTexture        = true;
            imp.mipmapEnabled      = true;
            imp.wrapMode           = TextureWrapMode.Repeat;                       // longitude wraps seamlessly
            imp.maxTextureSize     = FaceSize;                                     // cap face size (1024, the bake size)
            imp.textureCompression = TextureImporterCompression.Compressed;        // per-platform DXT/BC/ASTC
            imp.SaveAndReimport();

            var cube = AssetDatabase.LoadAssetAtPath<Cubemap>(pngAsset);
            if (cube == null) return "ERROR: import did not produce a cubemap: " + pngAsset;

            var mat = new Material(Shader.Find("Skybox/Cubemap"));
            mat.SetTexture("_Tex", cube);
            AssetDatabase.DeleteAsset(matPath);
            AssetDatabase.CreateAsset(mat, matPath);

            AssetDatabase.SaveAssets();
            if (!ReferenceEquals(eq, src)) UnityEngine.Object.DestroyImmediate(eq);
            UnityEngine.Object.DestroyImmediate(src);

            string fogHex = string.Format("{0:0.###}, {1:0.###}, {2:0.###}", fog.r, fog.g, fog.b);
            string msg = "Built '" + name + "' in " + DataDir + " (compressed, mipmapped cubemap).\n"
                       + "Drag " + name + ".mat into Lighting > Environment > Skybox Material.\n"
                       + "Suggested fog colour (horizon haze): " + fogHex;
            Debug.Log("Skybox Tool: " + msg.Replace("\n", " "));
            return msg;
        }

        // Pad a wider-than-2:1 image to a true 2:1 equirect by centring it vertically and replicating its top
        // and bottom edge rows into the new space (sky extends up to the zenith, ground down to the nadir). For
        // a space scene that's a black starfield up top and dark ground below - both extend cleanly. Images that
        // are already 2:1 or taller are returned unchanged (the full-sphere mapping handles those).
        static Texture2D PadTo2to1(Texture2D src)
        {
            int W = src.width, H = src.height, targetH = W / 2;
            if (H >= targetH) return src;
            int pad = targetH - H, padBottom = pad / 2, padTop = pad - padBottom;
            var s = src.GetPixels();                         // row 0 = bottom
            var d = new Color[W * targetH];
            for (int y = 0; y < targetH; y++)
            {
                int srcY = Mathf.Clamp(y - padBottom, 0, H - 1);   // clamp = replicate top/bottom edge rows
                System.Array.Copy(s, srcY * W, d, y * W, W);
            }
            var dst = new Texture2D(W, targetH, TextureFormat.RGBA32, false);
            dst.SetPixels(d); dst.Apply();
            return dst;
        }

        // Suggested distance-fog colour = the moonlit/hazy horizon: average the brightest ~40% of the horizon
        // band so dark mountain silhouettes don't drag it to a dull grey (same heuristic as the daytime bake).
        static Color DeriveFog(Texture2D eq)
        {
            var band = new List<Color>();
            for (float vrow = 0.40f; vrow <= 0.52f; vrow += 0.01f)
                for (int i = 0; i < 256; i++) band.Add(eq.GetPixelBilinear(i / 256f, vrow));
            if (band.Count == 0) return new Color(0.5f, 0.5f, 0.5f, 1f);
            band.Sort((a, b) => Lum(b).CompareTo(Lum(a)));
            int take = Mathf.Max(1, band.Count * 2 / 5);
            double r = 0, g = 0, b2 = 0;
            for (int i = 0; i < take; i++) { r += band[i].r; g += band[i].g; b2 += band[i].b; }
            return new Color((float)(r / take), (float)(g / take), (float)(b2 / take), 1f);
        }

        static float Lum(Color c) => 0.299f * c.r + 0.587f * c.g + 0.114f * c.b;

        // ---- Helpers ----------------------------------------------------------------------------------------

        static void DrawSeparator()
        {
            var r = EditorGUILayout.GetControlRect(false, 1);
            EditorGUI.DrawRect(r, new Color(0f, 0f, 0f, 0.25f));
        }

        static string DefaultExportDir()
        {
            // One level above Assets, so big intermediate PNGs don't get auto-imported by Unity.
            string root = Directory.GetParent(Application.dataPath)?.FullName ?? Application.dataPath;
            string sky = Path.Combine(root, "skybox_export");
            return Directory.Exists(sky) ? sky : root;
        }

        static void EnsureDataDir()
        {
            if (AssetDatabase.IsValidFolder(DataDir)) return;
            var parts = DataDir.Split('/');                 // e.g. ["Assets","OpenSlope","Skyboxes"]
            string cur = parts[0];
            for (int i = 1; i < parts.Length; i++)
            {
                string next = cur + "/" + parts[i];
                if (!AssetDatabase.IsValidFolder(next)) AssetDatabase.CreateFolder(cur, parts[i]);
                cur = next;
            }
        }

        static string SanitizeName(string n)
        {
            if (string.IsNullOrEmpty(n)) return n;
            foreach (var c in Path.GetInvalidFileNameChars()) n = n.Replace(c, '_');
            return n.Trim();
        }

        // "Assets/OpenSlope/Skyboxes/x.png" -> absolute path (Application.dataPath is "<project>/Assets").
        static string ProjectPathToAbs(string assetPath)
            => Path.Combine(Application.dataPath, assetPath.Substring("Assets/".Length));
    }
}
#endif
