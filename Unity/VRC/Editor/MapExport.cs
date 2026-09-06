#if UNITY_EDITOR
using System.IO;
using System.Text;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    // Editor tool: export the loaded OpenSlope_Map course as a set of CO-REGISTERED top-down bitmaps + a manifest, so
    // another tool/AI can read them as GUIDES and re-create a similar map (elevation, terrain types, ramps, walls,
    // rails, point features). Generic across maps - it reads whatever's loaded under OpenSlope_Map.
    //
    // HOW IT WORKS. A single top-down Physics.Raycast grid is cast down against the OpenSlope_Map/Collision/Surf_*
    // MeshColliders (every map has these). Each ray's hit gives BOTH the elevation (hit.point.y) and the surface
    // type (the Surf_N collider it hit -> real SSX SurfaceType id; see the SSX SurfaceType legend [Trailmap: 110-terrain]). From that one
    // height/surface buffer we derive height, hillshade, slope and a colour-keyed surface map. Rails come from the
    // baked RailNetwork (LocalPoints/RailStart/RailCount, transformed to world). Point features come from scene
    // object positions (gems / fireworks / crash bags / path markers / spawns), each optional. Everything reads LIVE
    // world transforms, so the export is correct whatever frame the level is in (recentre-agnostic, docs/vrchat/027).
    //
    // All layers share one pixel grid + projection (north-up, +X east, +Z up, MetersPerPixel), so they stack
    // directly. Output is written OUTSIDE Assets/ (a folder you pick, remembered per project) so the PNGs are never
    // imported as project assets. Re-run any time; bump MetersPerPixel down for more detail.
    public static class MapExport
    {
        const string RootName = Map.RootName;   // "OpenSlope_Map" (visual geometry under its Level child; Collision/Rails at the top)
        const string PrefKey  = "OpenSlope_MapExport_Dir";

        // --- Tunables ---------------------------------------------------------------------------------------
        const float MetersPerPixel = 2f;    // 1 = finer (4x the rays/pixels), 2 = good guide resolution
        const float ContourIntervalM = 100f; // iso-elevation spacing drawn on composite_elevation.png

        [MenuItem("OpenSlope/Tools/Export Terrain Bitmaps", false, 720)]
        public static void Export()
        {
            var root = GameObject.Find(RootName);
            if (root == null) { Debug.LogError($"OpenSlope: '{RootName}' not found - run OpenSlope/Load first."); return; }

            string def = EditorPrefs.GetString(PrefKey, Directory.GetParent(Application.dataPath).FullName);
            string dir = EditorUtility.SaveFolderPanel("Export terrain bitmaps to a folder", def, "map-bitmaps");
            if (string.IsNullOrEmpty(dir)) return; // cancelled
            EditorPrefs.SetString(PrefKey, dir);

            try { ExportTo(dir); }
            finally { EditorUtility.ClearProgressBar(); }
            EditorUtility.RevealInFinder(Path.Combine(dir, "composite_elevation.png"));
        }

        [MenuItem("OpenSlope/Tools/Export Terrain Bitmaps", true)]
        static bool ExportEnabled() => GameObject.Find(RootName) != null;

        // Grid params (set per run; this tool isn't reentrant).
        static float _minX, _minZ, _mppx; static int _W, _H;

        // Public so it can be invoked headlessly (e.g. from a batch/regen command) without the folder panel.
        public static string ExportTo(string dir)
        {
            Directory.CreateDirectory(dir);
            _mppx = MetersPerPixel;

            var rootGo = GameObject.Find(RootName);
            var level = rootGo.transform.Find("Level") ?? rootGo.transform;   // an imported level's geometry sits under Level; alpha/mammoth build flat under the root

            // Surf collider -> SSX surface-type id. Every map has these under OpenSlope_Map/Collision;
            // they're both the raycast targets AND the source of the project extent below, so the tool is map-agnostic.
            var surfMap = new Dictionary<Collider, int>();
            var tc = rootGo.transform.Find(Map.CollisionName);
            if (tc == null) { Debug.LogError($"OpenSlope: no {RootName}/{Map.CollisionName} in the scene - nothing to export."); return null; }
            foreach (Transform s in tc)
            {
                var mc = s.GetComponent<MeshCollider>();
                if (mc != null && s.name.StartsWith("Surf_") && int.TryParse(s.name.Substring(5), out int id))
                    surfMap[mc] = id;
            }
            if (surfMap.Count == 0) { Debug.LogError($"OpenSlope: no Surf_* colliders under {RootName}/{Map.CollisionName}."); return null; }

            // Project extent = world AABB of those surface colliders (works for any loaded map; matches the raycast coverage).
            Bounds b = default; bool hasB = false;
            foreach (var mc in surfMap.Keys) { if (!hasB) { b = mc.bounds; hasB = true; } else b.Encapsulate(mc.bounds); }
            float minX = b.min.x, maxX = b.max.x, minZ = b.min.z, maxZ = b.max.z, minYb = b.min.y, maxYb = b.max.y;
            _minX = minX; _minZ = minZ;
            _W = Mathf.CeilToInt((maxX - minX) / _mppx);
            _H = Mathf.CeilToInt((maxZ - minZ) / _mppx);
            int W = _W, H = _H, N = W * H;

            // ---- Raycast pass: height + surface in one sweep --------------------------------------------------
            float[] height = new float[N];
            int[] surfId = new int[N];
            var counts = new Dictionary<int, int>();
            float minHy = float.MaxValue, maxHy = float.MinValue;
            int hits = 0;
            var buf = new RaycastHit[48];
            float originY = maxYb + 50f, dist = (maxYb - minYb) + 200f;

            for (int y = 0; y < H; y++)
            {
                if ((y & 31) == 0)
                    EditorUtility.DisplayProgressBar("SSX map export", "Raycasting terrain…", (float)y / H * 0.6f);
                float wz = minZ + (y + 0.5f) * _mppx;
                for (int x = 0; x < W; x++)
                {
                    int i = y * W + x;
                    float wx = minX + (x + 0.5f) * _mppx;
                    int n = Physics.RaycastNonAlloc(new Vector3(wx, originY, wz), Vector3.down, buf, dist, ~0, QueryTriggerInteraction.Ignore);
                    float bestD = float.MaxValue, topY = 0; int topSurf = -1;
                    float bestMatD = float.MaxValue; int matSurf = -1;
                    for (int k = 0; k < n; k++)
                    {
                        if (!surfMap.TryGetValue(buf[k].collider, out int sid)) continue;
                        float d = buf[k].distance;
                        if (d < bestD) { bestD = d; topSurf = sid; topY = buf[k].point.y; }
                        if (sid != 0 && d < bestMatD) { bestMatD = d; matSurf = sid; }
                    }
                    if (topSurf < 0) { height[i] = float.NaN; surfId[i] = -1; continue; }
                    hits++;
                    height[i] = topY;
                    if (topY < minHy) minHy = topY;
                    if (topY > maxHy) maxHy = topY;
                    int cls = (topSurf == 0 && matSurf >= 0) ? matSurf : topSurf;
                    surfId[i] = cls;
                    counts[cls] = counts.TryGetValue(cls, out int cc) ? cc + 1 : 1;
                }
            }
            if (maxHy < minHy) { minHy = minYb; maxHy = maxYb; } // empty guard
            float range = Mathf.Max(0.001f, maxHy - minHy);

            // ---- surface.png ----
            var surfPx = new Color32[N];
            for (int i = 0; i < N; i++) surfPx[i] = surfId[i] < 0 ? new Color32(0, 0, 0, 0) : Pal(surfId[i]);
            SaveRGBA(dir, "surface.png", surfPx);

            // ---- height16 / height8 ----
            var h16 = new ushort[N]; var h8 = new byte[N];
            for (int i = 0; i < N; i++)
            {
                if (float.IsNaN(height[i])) { h16[i] = 0; h8[i] = 0; continue; }
                float t = (height[i] - minHy) / range;
                h16[i] = (ushort)Mathf.Clamp(Mathf.RoundToInt(t * 65535f), 0, 65535);
                h8[i] = (byte)Mathf.Clamp(Mathf.RoundToInt(t * 255f), 0, 255);
            }
            var t16 = new Texture2D(W, H, TextureFormat.R16, false); t16.SetPixelData(h16, 0); t16.Apply();
            File.WriteAllBytes(Path.Combine(dir, "height16.png"), t16.EncodeToPNG()); Object.DestroyImmediate(t16);
            var t8 = new Texture2D(W, H, TextureFormat.R8, false); t8.SetPixelData(h8, 0); t8.Apply();
            File.WriteAllBytes(Path.Combine(dir, "height8.png"), t8.EncodeToPNG()); Object.DestroyImmediate(t8);

            // ---- hillshade + slope (from height gradient, _mppx spacing) ----
            EditorUtility.DisplayProgressBar("SSX map export", "Shading…", 0.65f);
            var hsPx = new Color32[N]; var slPx = new Color32[N];
            Vector3 light = new Vector3(-1f, 1.4f, -1f).normalized;
            for (int y = 0; y < H; y++)
                for (int x = 0; x < W; x++)
                {
                    int i = y * W + x;
                    if (float.IsNaN(height[i])) { hsPx[i] = new Color32(0, 0, 0, 0); slPx[i] = new Color32(0, 0, 0, 0); continue; }
                    int xl = Mathf.Max(0, x - 1), xr = Mathf.Min(W - 1, x + 1);
                    int yd = Mathf.Max(0, y - 1), yu = Mathf.Min(H - 1, y + 1);
                    float hxl = N1(height, y * W + xl, height[i]), hxr = N1(height, y * W + xr, height[i]);
                    float hyd = N1(height, yd * W + x, height[i]), hyu = N1(height, yu * W + x, height[i]);
                    float dzdx = (hxr - hxl) / ((xr - xl) * _mppx);
                    float dzdy = (hyu - hyd) / ((yu - yd) * _mppx);
                    Vector3 nrm = new Vector3(-dzdx, 1f, -dzdy).normalized;
                    float sh = Mathf.Clamp01(Vector3.Dot(nrm, light)) * 0.85f + 0.15f;
                    byte sb = (byte)(sh * 255f);
                    hsPx[i] = new Color32(sb, sb, sb, 255);
                    float slopeDeg = Mathf.Atan(Mathf.Sqrt(dzdx * dzdx + dzdy * dzdy)) * Mathf.Rad2Deg;
                    byte sv = (byte)Mathf.Clamp(Mathf.RoundToInt(slopeDeg / 90f * 255f), 0, 255);
                    slPx[i] = new Color32(sv, sv, sv, 255);
                }
            SaveRGBA(dir, "hillshade.png", hsPx);
            SaveRGBA(dir, "slope.png", slPx);

            // ---- rails ----
            EditorUtility.DisplayProgressBar("SSX map export", "Rails & features…", 0.8f);
            var railPx = new Color32[N];
            int railCount = 0, railSegs = 0;
            var net = FindNet(rootGo);
            if (net != null && net.LocalPoints != null && net.RailStart != null && net.RailCount != null)
            {
                var lp = net.LocalPoints; var rs = net.RailStart; var rc = net.RailCount; var xf = net.transform;
                railCount = rs.Length;
                for (int r = 0; r < rs.Length; r++)
                {
                    int st = rs[r], cnt = rc[r];
                    if (cnt < 2 || st < 0 || st + cnt > lp.Length) continue;
                    for (int k = 0; k < cnt - 1; k++)
                    {
                        Line(railPx, xf.TransformPoint(lp[st + k]), xf.TransformPoint(lp[st + k + 1]), 1, new Color32(60, 255, 90, 255));
                        railSegs++;
                    }
                }
            }
            SaveRGBA(dir, "rails.png", railPx);

            // ---- pois ----
            var poiPx = new Color32[N];
            int gx2 = 0, gx3 = 0, gx5 = 0, fw = 0, cb = 0, pm = 0, bs = 0, bt = 0;
            var spin = level.Find("Spinners");
            if (spin != null)
                foreach (Transform g in spin)
                {
                    if (g.name.Contains("X5")) { Marker(poiPx, g.position, 2, new Color32(255, 40, 60, 255)); gx5++; }
                    else if (g.name.Contains("X3")) { Marker(poiPx, g.position, 2, new Color32(255, 140, 20, 255)); gx3++; }
                    else { Marker(poiPx, g.position, 2, new Color32(255, 225, 40, 255)); gx2++; }
                }
            var fwg = level.Find("Fireworks");
            if (fwg != null) foreach (Transform f in fwg) { Marker(poiPx, f.position, 3, new Color32(255, 90, 200, 255)); fw++; }
            var phg = level.Find("Physics");
            if (phg != null)
                foreach (Transform p in phg)
                {
                    if (p.name.Contains("CrashBag")) { Marker(poiPx, p.position, 3, new Color32(0, 210, 255, 255)); cb++; }
                    else { Marker(poiPx, p.position, 1, new Color32(150, 150, 160, 255)); pm++; }
                }
            foreach (var tr in Object.FindObjectsOfType<Transform>())
            {
                if (tr.name.Contains("SpeedBoost")) { Marker(poiPx, tr.position, 4, new Color32(255, 215, 0, 255)); bs++; }
                else if (tr.name.Contains("TrickBoost")) { Marker(poiPx, tr.position, 4, new Color32(40, 230, 120, 255)); bt++; }
            }
            var mt = GameObject.Find("Spawns/MapTop"); var ds = GameObject.Find("Spawns/AlphaStart");
            if (mt != null) Marker(poiPx, mt.transform.position, 7, new Color32(50, 255, 80, 255));
            if (ds != null) Marker(poiPx, ds.transform.position, 7, new Color32(255, 0, 160, 255));
            SaveRGBA(dir, "pois.png", poiPx);

            // ---- composite (surface-type shaded) + composite_elevation (hypsometric) ----
            EditorUtility.DisplayProgressBar("SSX map export", "Composites…", 0.9f);
            var comp = new Color32[N];
            var tint = new Color32[N];
            var elev = new Color32[N];
            int[] band = new int[N];
            for (int i = 0; i < N; i++) band[i] = float.IsNaN(height[i]) ? int.MinValue : Mathf.FloorToInt((minHy + (h8[i] / 255f) * range) / ContourIntervalM);
            for (int y = 0; y < H; y++)
                for (int x = 0; x < W; x++)
                {
                    int i = y * W + x;
                    if (surfId[i] < 0) { comp[i] = new Color32(22, 26, 32, 255); tint[i] = new Color32(0, 0, 0, 0); elev[i] = new Color32(22, 26, 32, 255); continue; }
                    float sh = hsPx[i].r / 255f;
                    // surface composite
                    float cs = sh * 0.75f + 0.35f;
                    comp[i] = new Color32(B(surfPx[i].r * cs), B(surfPx[i].g * cs), B(surfPx[i].b * cs), 255);
                    // elevation tint + shaded elevation composite + contour
                    float t = h8[i] / 255f; Color32 ec = Turbo(t); tint[i] = ec;
                    float es = sh * 0.7f + 0.4f;
                    float er = ec.r * es, eg = ec.g * es, eb = ec.b * es;
                    bool edge = (x + 1 < W && band[i + 1] != int.MinValue && band[i + 1] != band[i]) ||
                                (y + 1 < H && band[i + W] != int.MinValue && band[i + W] != band[i]);
                    if (edge) { er *= 0.4f; eg *= 0.4f; eb *= 0.4f; }
                    elev[i] = new Color32(B(er), B(eg), B(eb), 255);
                }
            for (int i = 0; i < N; i++) { if (railPx[i].a > 0) { comp[i] = railPx[i]; elev[i] = railPx[i]; } }
            for (int i = 0; i < N; i++) { if (poiPx[i].a > 0) { comp[i] = poiPx[i]; elev[i] = poiPx[i]; } }
            DrawColorBar(elev, minHy, range);
            SaveRGBA(dir, "composite.png", comp);
            SaveRGBA(dir, "elevation_tint.png", tint);
            SaveRGBA(dir, "composite_elevation.png", elev);

            // ---- manifest.json + README.md ----
            WriteManifest(dir, minX, maxX, minZ, maxZ, minHy, maxHy, hits, counts, railCount, railSegs, gx2, gx3, gx5, fw, cb, pm, mt, ds);
            WriteReadme(dir, minX, maxX, minZ, maxZ, minHy, maxHy, range, counts, railCount, gx2, gx3, gx5, fw, cb, pm);
            EditorUtility.ClearProgressBar();

            string msg = $"OpenSlope: exported terrain bitmaps to {dir}\n  {W}x{H} @ {_mppx} m/px, terrain hits {hits}/{N} ({100f * hits / N:F1}%), " +
                         $"Y [{minHy:F1},{maxHy:F1}] m; {railCount} rails; gems {gx2 + gx3 + gx5}, fireworks {fw}, crashbags {cb}.";
            Debug.Log(msg);
            return msg;
        }

        // ---- helpers --------------------------------------------------------------------------------------------
        static float N1(float[] a, int i, float fallback) { float v = a[i]; return float.IsNaN(v) ? fallback : v; }
        static byte B(float v) => (byte)Mathf.Clamp(Mathf.RoundToInt(v), 0, 255);

        static RailNetwork FindNet(GameObject root)
        {
            var t = root.transform.Find(Map.Rails);   // re-exposed at the OpenSlope_Map top
            if (t != null) { var n = t.GetComponent<RailNetwork>(); if (n != null) return n; }
            return Object.FindObjectOfType<RailNetwork>();
        }

        static void PtToPix(Vector3 w, out int px, out int py)
        {
            px = Mathf.RoundToInt((w.x - _minX) / _mppx);
            py = Mathf.RoundToInt((w.z - _minZ) / _mppx);
        }
        static void Stamp(Color32[] buf, int cx, int cy, int r, Color32 col)
        {
            for (int dy = -r; dy <= r; dy++)
                for (int dx = -r; dx <= r; dx++)
                {
                    if (dx * dx + dy * dy > r * r) continue;
                    int x = cx + dx, y = cy + dy;
                    if (x < 0 || y < 0 || x >= _W || y >= _H) continue;
                    buf[y * _W + x] = col;
                }
        }
        static void Marker(Color32[] buf, Vector3 world, int r, Color32 col)
        {
            PtToPix(world, out int cx, out int cy);
            Stamp(buf, cx, cy, r + 1, new Color32(15, 15, 18, 255)); // dark halo for contrast on any layer
            Stamp(buf, cx, cy, r, col);
        }
        static void Line(Color32[] buf, Vector3 a, Vector3 bb, int th, Color32 col)
        {
            PtToPix(a, out int ax, out int ay); PtToPix(bb, out int bx, out int by);
            int steps = Mathf.Max(1, Mathf.CeilToInt(Mathf.Sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay))));
            for (int i = 0; i <= steps; i++)
            {
                float t = (float)i / steps;
                Stamp(buf, Mathf.RoundToInt(Mathf.Lerp(ax, bx, t)), Mathf.RoundToInt(Mathf.Lerp(ay, by, t)), th, col);
            }
        }
        static void DrawColorBar(Color32[] buf, float minHy, float range)
        {
            int bx0 = 14, bx1 = 34, by0 = 44, bh = 256;
            for (int yy = 0; yy < bh; yy++)
            {
                Color32 c = Turbo((float)yy / (bh - 1));
                for (int xx = bx0; xx <= bx1; xx++) { int i = (by0 + yy) * _W + xx; if (i >= 0 && i < buf.Length) buf[i] = c; }
            }
            for (int yy = -1; yy <= bh; yy++)
            {
                int yA = by0 + yy; if (yA < 0 || yA >= _H) continue;
                int iL = yA * _W + (bx0 - 1), iR = yA * _W + (bx1 + 1);
                if (iL >= 0 && iL < buf.Length) buf[iL] = new Color32(0, 0, 0, 255);
                if (iR >= 0 && iR < buf.Length) buf[iR] = new Color32(0, 0, 0, 255);
            }
            int kmin = Mathf.CeilToInt(minHy / ContourIntervalM), kmax = Mathf.FloorToInt((minHy + range) / ContourIntervalM);
            for (int k = kmin; k <= kmax; k++)
            {
                float t = (k * ContourIntervalM - minHy) / range; int yA = by0 + Mathf.RoundToInt(t * (bh - 1));
                int len = (k % 5 == 0) ? 8 : 5;
                for (int xx = bx1 + 2; xx <= bx1 + len; xx++) { int i = yA * _W + xx; if (i >= 0 && i < buf.Length) buf[i] = new Color32(255, 255, 255, 255); }
            }
        }

        static void SaveRGBA(string dir, string name, Color32[] px)
        {
            var tex = new Texture2D(_W, _H, TextureFormat.RGBA32, false);
            tex.SetPixels32(px); tex.Apply();
            File.WriteAllBytes(Path.Combine(dir, name), tex.EncodeToPNG());
            Object.DestroyImmediate(tex);
        }

        static Color32 Turbo(float t)
        {
            t = Mathf.Clamp01(t);
            float[] pos = { 0f, 0.15f, 0.30f, 0.45f, 0.60f, 0.75f, 0.90f, 1f };
            Color[] col = {
                new Color(0,0,0.31f), new Color(0,0.47f,1f), new Color(0,0.86f,0.86f), new Color(0,0.78f,0.24f),
                new Color(0.90f,0.90f,0f), new Color(1f,0.55f,0f), new Color(0.90f,0.12f,0.12f), new Color(1f,1f,1f)
            };
            int i = 0; while (i < pos.Length - 2 && t > pos[i + 1]) i++;
            float f = (t - pos[i]) / Mathf.Max(0.0001f, pos[i + 1] - pos[i]);
            Color c = Color.Lerp(col[i], col[i + 1], f);
            return new Color32((byte)(c.r * 255), (byte)(c.g * 255), (byte)(c.b * 255), 255);
        }

        // SSX SurfaceType -> colour (SSX SurfaceType legend). Example ids: 0,1,3,4,5,9,10,18.
        static Color32 Pal(int id)
        {
            switch (id)
            {
                case 0: return new Color32(220, 40, 40, 255);   case 1: return new Color32(240, 240, 248, 255);
                case 2: return new Color32(210, 205, 200, 255); case 3: return new Color32(188, 210, 236, 255);
                case 4: return new Color32(150, 190, 205, 255); case 5: return new Color32(85, 200, 238, 255);
                case 6: return new Color32(200, 80, 200, 255);  case 7: return new Color32(120, 180, 230, 255);
                case 8: return new Color32(220, 230, 245, 255); case 9: return new Color32(120, 95, 78, 255);
                case 10: return new Color32(70, 70, 80, 255);   case 11: return new Color32(140, 210, 235, 255);
                case 12: return new Color32(175, 200, 210, 255);case 13: return new Color32(150, 140, 120, 255);
                case 14: return new Color32(255, 220, 60, 255); case 16: return new Color32(225, 205, 150, 255);
                case 18: return new Color32(248, 150, 28, 255);
                default: return new Color32(255, 0, 255, 255);
            }
        }
        static string SurfName(int id)
        {
            switch (id)
            {
                case 0: return "reset / out of bounds"; case 1: return "standard snow"; case 2: return "standard off track";
                case 3: return "powdered snow"; case 4: return "slow powdered snow"; case 5: return "ice";
                case 6: return "bounce / unskiable"; case 7: return "ice / water no trail"; case 8: return "glidy snow particles";
                case 9: return "rock / off-track"; case 10: return "wall"; case 11: return "ice crunch no trail";
                case 12: return "no sound small wake"; case 13: return "off-track metal"; case 14: return "speed / grinding";
                case 16: return "sand"; case 17: return "no collision"; case 18: return "show-off ramp / metal";
                default: return "unknown";
            }
        }
        static string Hex(Color32 c) => $"#{c.r:X2}{c.g:X2}{c.b:X2}";

        static void WriteManifest(string dir, float minX, float maxX, float minZ, float maxZ, float minY, float maxY,
            int hits, Dictionary<int, int> counts, int railCount, int railSegs,
            int gx2, int gx3, int gx5, int fw, int cb, int pm, GameObject mt, GameObject ds)
        {
            var sb = new StringBuilder();
            sb.Append("{\n");
            sb.Append("  \"name\": \"OpenSlope_Map terrain bitmap export\",\n");
            sb.Append("  \"generated_for\": \"An AI that reads these layers as GUIDES to re-create a similar course (not a deterministic round-trip).\",\n");
            sb.Append("  \"image_size\": { \"width\": " + _W + ", \"height\": " + _H + " },\n");
            sb.Append("  \"meters_per_pixel\": " + _mppx.ToString("0.###") + ",\n");
            sb.Append("  \"units\": \"meters (Unity world units); original SSX data is centimeters (x100)\",\n");
            sb.Append("  \"orientation\": \"North-up. Image +X (right)=world +X (east); image up (row 0=top)=world +Z (north).\",\n");
            sb.Append("  \"world_bounds\": { \"minX\": " + F(minX) + ", \"maxX\": " + F(maxX) + ", \"minZ\": " + F(minZ) + ", \"maxZ\": " + F(maxZ) + ", \"minY\": " + F(minY) + ", \"maxY\": " + F(maxY) + " },\n");
            sb.Append("  \"pixel_to_world\": { \"worldX\": \"minX + (col+0.5)*mpp\", \"worldZ\": \"maxZ - (row+0.5)*mpp\", \"worldY\": \"minY + (height/heightMax)*(maxY-minY)\" },\n");
            sb.Append("  \"world_to_pixel\": { \"col\": \"floor((worldX-minX)/mpp)\", \"row\": \"floor((maxZ-worldZ)/mpp)\" },\n");
            sb.Append("  \"validity_mask\": \"surface.png alpha; alpha==0 = no collidable terrain (height there is meaningless).\",\n");
            sb.Append("  \"layers\": {\n");
            sb.Append("    \"height16.png\": \"16-bit grayscale elevation; 0=minY, 65535=maxY (linear).\",\n");
            sb.Append("    \"height8.png\": \"8-bit elevation, same mapping /255.\",\n");
            sb.Append("    \"hillshade.png\": \"NW relief shading; reads shape (ramps, walls, valleys).\",\n");
            sb.Append("    \"slope.png\": \"steepness 0deg(black)->90deg(white); ramps/walls bright.\",\n");
            sb.Append("    \"surface.png\": \"terrain type, colour-keyed (see surface_legend); transparent=no terrain.\",\n");
            sb.Append("    \"rails.png\": \"grind rails (green polylines), transparent elsewhere.\",\n");
            sb.Append("    \"pois.png\": \"point features (see poi_legend), transparent elsewhere.\",\n");
            sb.Append("    \"elevation_tint.png\": \"absolute height as colour (hypsometric ramp), transparent=no terrain.\",\n");
            sb.Append("    \"composite.png\": \"surface-type colour x hillshade + rails + pois (overview).\",\n");
            sb.Append("    \"composite_elevation.png\": \"hypsometric tint x hillshade + " + ContourIntervalM.ToString("0") + "m contours + rails + pois + colour bar (TOTAL elevation overview).\"\n");
            sb.Append("  },\n");
            sb.Append("  \"surface_legend\": [\n");
            var keys = new List<int>(counts.Keys); keys.Sort();
            for (int j = 0; j < keys.Count; j++)
            {
                int id = keys[j];
                sb.Append("    { \"surf_id\": " + id + ", \"name\": \"" + SurfName(id) + "\", \"hex\": \"" + Hex(Pal(id)) + "\", \"pixels\": " + counts[id] + " }" + (j < keys.Count - 1 ? "," : "") + "\n");
            }
            sb.Append("  ],\n");
            sb.Append("  \"poi_legend\": [\n");
            sb.Append("    { \"feature\": \"gem x2\", \"hex\": \"#FFE128\", \"count\": " + gx2 + " },\n");
            sb.Append("    { \"feature\": \"gem x3\", \"hex\": \"#FF8C14\", \"count\": " + gx3 + " },\n");
            sb.Append("    { \"feature\": \"gem x5\", \"hex\": \"#FF283C\", \"count\": " + gx5 + " },\n");
            sb.Append("    { \"feature\": \"firework launcher\", \"hex\": \"#FF5AC8\", \"count\": " + fw + " },\n");
            sb.Append("    { \"feature\": \"crash-bag obstacle\", \"hex\": \"#00D2FF\", \"count\": " + cb + " },\n");
            sb.Append("    { \"feature\": \"path marker\", \"hex\": \"#9696A0\", \"count\": " + pm + " },\n");
            sb.Append("    { \"feature\": \"spawn (big green=MapTop, big pink=AlphaStart)\", \"count\": " + ((mt != null ? 1 : 0) + (ds != null ? 1 : 0)) + " }\n");
            sb.Append("  ],\n");
            sb.Append("  \"rails\": { \"spline_count\": " + railCount + ", \"segment_count\": " + railSegs + " },\n");
            sb.Append("  \"notes\": [\n");
            sb.Append("    \"Boost pads are baked into the Props mesh (not separate objects), so they are NOT in pois.png.\",\n");
            sb.Append("    \"Ramps = surface type 18 (orange) and bright in slope.png; walls = type 10 (dark grey).\",\n");
            sb.Append("    \"Red = reset/OOB; where it sits over rideable terrain the material below is shown, so red marks only true OOB.\"\n");
            sb.Append("  ]\n");
            sb.Append("}\n");
            File.WriteAllText(Path.Combine(dir, "manifest.json"), sb.ToString());
        }

        static void WriteReadme(string dir, float minX, float maxX, float minZ, float maxZ, float minY, float maxY, float range,
            Dictionary<int, int> counts, int railCount, int gx2, int gx3, int gx5, int fw, int cb, int pm)
        {
            var sb = new StringBuilder();
            sb.Append("# OpenSlope_Map - terrain bitmap export\n\n");
            sb.Append("Co-registered top-down bitmaps describing the loaded OpenSlope_Map course (elevation, terrain types, ramps, walls, rails, point features). Meant as GUIDES for an AI to re-create a similar course, not a deterministic round-trip. See `manifest.json` for the machine-readable spec.\n\n");
            sb.Append("## Coordinate system\n\n");
            sb.Append("- Image " + _W + " x " + _H + " px, **" + _mppx.ToString("0.###") + " m/pixel**, **north-up** (image right=+X east, image up=+Z north). Summit/start at top; run descends to bottom-left.\n");
            sb.Append("- World extent: X [" + F(minX) + ", " + F(maxX) + "], Z [" + F(minZ) + ", " + F(maxZ) + "], Y [" + F(minY) + ", " + F(maxY) + "] (meters).\n\n");
            sb.Append("```\nworldX = " + F(minX) + " + (col + 0.5) * " + _mppx.ToString("0.###") + "\n");
            sb.Append("worldZ = " + F(maxZ) + " - (row + 0.5) * " + _mppx.ToString("0.###") + "\n");
            sb.Append("worldY = " + F(minY) + " + (heightSample / heightMax) * " + F(range) + "\n```\n\n");
            sb.Append("Validity: use `surface.png` alpha (0 = no terrain) to mask the height layers.\n\n");
            sb.Append("## Layers\n\n");
            sb.Append("| File | What |\n|---|---|\n");
            sb.Append("| `height16.png` / `height8.png` | elevation (16-bit precise / 8-bit readable) |\n");
            sb.Append("| `hillshade.png` | relief shading (shape: ramps, walls, valleys) |\n");
            sb.Append("| `slope.png` | steepness 0->90deg (ramps/walls bright) |\n");
            sb.Append("| `surface.png` | terrain type, colour-keyed (table below) |\n");
            sb.Append("| `rails.png` | " + railCount + " grind splines (green) |\n");
            sb.Append("| `pois.png` | gems/fireworks/crash-bags/path-markers/spawn |\n");
            sb.Append("| `elevation_tint.png` | absolute height as colour (hypsometric) |\n");
            sb.Append("| `composite.png` | surface-type colour + relief + overlays |\n");
            sb.Append("| `composite_elevation.png` | **elevation** colour + relief + " + ContourIntervalM.ToString("0") + "m contours + colour bar |\n\n");
            sb.Append("## Surface-type legend (`surface.png`)\n\n");
            sb.Append("Real SSX `SurfaceType` ids (SSX SurfaceType legend). Pixel coverage in this export:\n\n");
            sb.Append("| Hex | Surf id | Meaning | Pixels |\n|---|---:|---|---:|\n");
            var keys = new List<int>(counts.Keys); keys.Sort();
            foreach (int id in keys)
                sb.Append("| `" + Hex(Pal(id)) + "` | " + id + " | " + SurfName(id) + " | " + counts[id] + " |\n");
            sb.Append("\n## POI legend (`pois.png`)\n\n");
            sb.Append("| Colour | Feature | Count |\n|---|---|---:|\n");
            sb.Append("| yellow | gem x2 | " + gx2 + " |\n| orange | gem x3 | " + gx3 + " |\n| red | gem x5 | " + gx5 + " |\n");
            sb.Append("| pink | firework launcher | " + fw + " |\n| cyan | crash-bag obstacle | " + cb + " |\n| grey | path marker | " + pm + " |\n");
            sb.Append("| big green | spawn (MapTop summit) | - |\n\n");
            sb.Append("## Notes\n\n");
            sb.Append("- Boost pads are baked into the `Props` mesh (not separate objects) and are absent from `pois.png`.\n");
            sb.Append("- Ramps = surface type 18 (orange); walls = type 10 (dark grey). Red = reset/OOB aprons.\n");
            sb.Append("- Generated by `OpenSlope/Tools/Export Terrain Bitmaps` (MapExport.cs) - re-runnable from the live scene.\n");
            File.WriteAllText(Path.Combine(dir, "README.md"), sb.ToString());
        }

        static string F(float v) => v.ToString("0.###");
    }
}
#endif
