using System.Numerics;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using SSXLibrary.JsonFiles.Tricky;

namespace Snowknife.Bundle;

/// <summary>
/// Bakes the terrain into bundle geometry: the procedural Bezier-patch tessellation, EXACT analytic
/// surface normals (signed outward, welded across seams within a smoothing angle), the per-pixel
/// lightmap atlas + UV1, and the welded vertex-colour luminance fallback. This logic lives here
/// rather than in the Unity importer's TerrainBuilder, so Blender/any engine gets the same
/// lit, smooth-normalled terrain the OBJ never could, and the Unity importer just loads the result.
///
/// Output is in SSX "mesh space" (raw units, X negated, Z up); GltfMeshWriter converts to glTF Y-up
/// metres. Render = one node "Terrain" with a primitive per texture, plus a render-only "TerrainHD"
/// node tessellated at TerrainResHd (the per-player high-detail swap; same surface, denser grid).
/// Collision = one node per SurfaceType ("TerrainCol_N"), carrying the same welded normals the board
/// rides - always at the base TerrainRes (contact is analytic, so finer colliders buy nothing).
/// See Unity docs/unity/002 (geometry) + Unity docs/unity/007 (lightmap).
/// </summary>
public static class TerrainBundle
{
    public sealed class Opts
    {
        public int LightmapUvMode = 6;
        public int TerrainRes = 4;
        public int TerrainResHd = 8;  // the "TerrainHD" render-only node (0 = don't emit); collision always uses TerrainRes
        public int NoCollisionSurfaceType = 17;
        public bool BuildColliders = true;
        public float Scale = 0.01f;   // recorded in the manifest; geometry is mesh-space
    }

    public static (List<GltfMeshWriter.Node> nodes, BundleManifest.LightmapInfo? lm) Build(
        string levelDir, string bundleDir, Opts opts)
    {
        string patchesPath = Path.Combine(levelDir, "Patches.json");
        if (!File.Exists(patchesPath))
            throw new FileNotFoundException($"Patches.json not found in '{levelDir}'. Run `snowknife import ...` first.");
        var patches = PatchesJsonHandler.Load(patchesPath).Patches ?? new();
        if (patches.Count == 0) throw new InvalidOperationException("Patches.json has no patches.");

        Rgba32[]?[] maps = LoadLightmaps(levelDir, out int lmFound);
        bool hasLightmap = lmFound > 0;
        float[]?[] lum = IntensityFromMaps(maps);   // A_S/255 per texel, for the vertex-colour fallback + SampleTile
        if (hasLightmap)
        {
            SaveLightmapAtlas(maps, Path.Combine(bundleDir, "LightmapAtlas.png"));      // exact (C_S rgb, A_S alpha) - the engine reconstructs (C_D-C_S)*A_S
            SaveMultiplyAtlas(maps, Path.Combine(bundleDir, "LightmapMultiply.png"));   // standard colored multiply lightmap (albedo x this) - for interchange
        }

        // Two tessellation passes over the same patches: the base pass (TerrainRes) carries the collision split
        // and the default render node; the HD pass (TerrainResHd) is a render-only densification of the identical
        // surface - "TerrainHD" in the glb - that the world can swap in per player for a smoother silhouette.
        // Collision NEVER densifies: the board's contact is analytic (Unity docs/021), the corner-code bake assumes
        // TerrainRes <= 4, and finer colliders would only spend the Quest collider budget for nothing.
        int seg = Math.Max(1, opts.TerrainRes);
        var baseT = Tessellate(patches, seg, opts, opts.BuildColliders, hasLightmap, lum);
        int hdSeg = opts.TerrainResHd;
        Tess? hdT = hdSeg > seg ? Tessellate(patches, hdSeg, opts, buildColliders: false, hasLightmap, lum) : null;

        // ---- assemble bundle nodes ----
        var nodes = new List<GltfMeshWriter.Node>();

        var render = new GltfMeshWriter.Node { Name = "Terrain" };
        foreach (var kv in baseT.TriByTex)
            render.Prims.Add(new GltfMeshWriter.Prim
            {
                Material = kv.Key,
                Positions = baseT.Verts, Normals = baseT.Norms,
                Uv0 = baseT.Uv0, Uv1 = hasLightmap ? baseT.Uv1 : null, Colors = baseT.Colors,
                Indices = kv.Value,
            });
        nodes.Add(render);

        if (hdT != null)
        {
            var hd = new GltfMeshWriter.Node { Name = "TerrainHD" };
            foreach (var kv in hdT.TriByTex)
                hd.Prims.Add(new GltfMeshWriter.Prim
                {
                    Material = kv.Key,
                    Positions = hdT.Verts, Normals = hdT.Norms,
                    Uv0 = hdT.Uv0, Uv1 = hasLightmap ? hdT.Uv1 : null, Colors = hdT.Colors,
                    Indices = kv.Value,
                });
            nodes.Add(hd);
        }

        if (opts.BuildColliders)
            foreach (var kv in baseT.TriBySurf)
                nodes.Add(new GltfMeshWriter.Node
                {
                    Name = "TerrainCol_" + kv.Key,
                    Prims = { new GltfMeshWriter.Prim
                    {
                        Material = "collision",
                        Positions = baseT.Verts, Normals = baseT.Norms,
                        Indices = kv.Value,
                    } }
                });

        Log.Info($"  Terrain: {patches.Count - baseT.Skipped} patches -> {baseT.Verts.Count:n0} verts, " +
                          $"{baseT.TriByTex.Count} submeshes, {baseT.TriBySurf.Count} collision surfaces" +
                          (hdT != null ? $"; HD render x{hdSeg} -> {hdT.Verts.Count:n0} verts" : "") +
                          (hasLightmap ? $", lightmap {lmFound}/16 (exact atlas + multiply)" : ", no lightmap") +
                          (baseT.Skipped > 0 ? $", {baseT.Skipped} skipped" : "") + ".");

        var lmInfo = hasLightmap
            ? new BundleManifest.LightmapInfo { Atlas = "LightmapAtlas.png", MultiplyAtlas = "LightmapMultiply.png", Size = 512, MapsFound = lmFound, UvMode = opts.LightmapUvMode }
            : null;
        return (nodes, lmInfo);
    }

    // One tessellation pass at 'seg' quads/edge: verts, welded analytic normals, UVs, welded vertex-colour
    // luminance, render tris per texture and (base pass only) collision tris per SurfaceType.
    sealed class Tess
    {
        public readonly List<Vector3> Verts = new();               // mesh space (X negated)
        public List<Vector3> Norms = new();                        // analytic Bezier normal, welded across seams
        public readonly List<Vector2> Uv0 = new();
        public readonly List<Vector2> Uv1 = new();                 // lightmap-atlas UV (top-left origin)
        public readonly List<Vector4> Colors = new();              // welded luminance fallback
        public readonly Dictionary<string, List<int>> TriByTex = new();
        public readonly Dictionary<int, List<int>> TriBySurf = new();
        public int Skipped;
    }

    static Tess Tessellate(List<PatchesJsonHandler.PatchJson> patches, int seg, Opts opts, bool buildColliders,
                           bool hasLightmap, float[]?[] lum)
    {
        int side = seg + 1;
        int cap = patches.Count * side * side;
        var t = new Tess();
        var verts = t.Verts; verts.Capacity = cap;
        var norms = new List<Vector3>(cap);      // analytic Bezier normal (mesh space, pre-weld)
        var gN    = new List<Vector3>(cap);      // geometric winding normal (sign authority)
        var uv0   = t.Uv0; uv0.Capacity = cap;
        var uv1   = t.Uv1; uv1.Capacity = cap;
        var lmv   = new List<float>(cap);        // per-vertex luminance (pre-weld)
        var keys  = new List<(int, int, int)>(cap);
        var triByTex  = t.TriByTex;
        var triBySurf = t.TriBySurf;

        var cp = new Vector3[16];

        foreach (var p in patches)
        {
            if (p.Points == null || p.Points.GetLength(0) < 16) { t.Skipped++; continue; }
            for (int k = 0; k < 16; k++)
                cp[k] = new Vector3(p.Points[k, 0], p.Points[k, 1], p.Points[k, 2]);

            Vector2 c0 = UvCorner(p.UVPoints, 0), c1 = UvCorner(p.UVPoints, 1),
                    c2 = UvCorner(p.UVPoints, 2), c3 = UvCorner(p.UVPoints, 3);
            // The 4 stored UV corners pair index-for-index with the patch's geometry corners: UVPoint_i
            // belongs to the control-point corner of the same parametric position. In the .pbd, Point1..4
            // are the corners in (u0,v0),(u1,v0),(u0,v1),(u1,v1) order, stored parallel to UVPoint1..4.
            // With bilerp corners uvA@(0,0) uvB@(0,1) uvC@(1,0) uvD@(1,1): uvA=c0(u0v0), uvB=c2(u0v1),
            // uvC=c1(u1v0), uvD=c3(u1v1) - a transpose of the same-index order.
            Vector2 uvA = c0, uvB = c2, uvC = c1, uvD = c3;
            InsetUnitTile(ref uvA, ref uvB, ref uvC, ref uvD);

            float[] lp = p.LightMapPoint;
            float lx = (lp != null && lp.Length >= 4) ? lp[0] : 0f;
            float ly = (lp != null && lp.Length >= 4) ? lp[1] : 0f;
            float lw = (lp != null && lp.Length >= 4) ? lp[2] : 0f;
            float lh = (lp != null && lp.Length >= 4) ? lp[3] : 0f;
            int mId = p.LightmapID;
            float[]? map = (hasLightmap && mId >= 0 && mId < lum.Length) ? lum[mId] : null;
            int aCol = mId % 4, aRow = mId / 4;
            int bx = RoundI(lx * 128f), by = RoundI(ly * 128f);
            int tw = Math.Max(1, RoundI(lw * 128f) - 1);
            int th = Math.Max(1, RoundI(lh * 128f) - 1);

            int vBase = verts.Count;
            for (int iu = 0; iu < side; iu++)
            {
                float u = iu / (float)seg;
                for (int iv = 0; iv < side; iv++)
                {
                    float v = iv / (float)seg;
                    Vector3 pt = Bezier.Patch(cp, u, v);
                    verts.Add(new Vector3(-pt.X, pt.Y, pt.Z));
                    keys.Add((RoundI(pt.X), RoundI(pt.Y), RoundI(pt.Z)));

                    Bezier.PatchTangents(cp, u, v, out Vector3 su, out Vector3 sv);
                    Vector3 nM = Vector3.Cross(new Vector3(-su.X, su.Y, su.Z), new Vector3(-sv.X, sv.Y, sv.Z));
                    norms.Add(nM.LengthSquared() > 1e-12f ? Vector3.Normalize(nM) : new Vector3(0, 1, 0));
                    gN.Add(Vector3.Zero);

                    Vector2 d = Bilerp(uvA, uvB, uvC, uvD, u, v);
                    uv0.Add(new Vector2(d.X, d.Y));   // top-left (glTF native); Unity loader flips V
                    RemapUv(u, v, opts.LightmapUvMode, out float ru, out float rv);
                    lmv.Add(map != null ? SampleTile(map, lx, ly, lw, lh, ru, rv) : 1f);
                    if (map != null)
                    {
                        float au = (aCol * 128 + bx + ru * tw + 0.5f) / 512f;
                        float av = (aRow * 128 + by + rv * th + 0.5f) / 512f;
                        uv1.Add(new Vector2(au, av));  // top-left; Unity loader flips V
                    }
                    else uv1.Add(Vector2.Zero);
                }
            }

            string tex = string.IsNullOrEmpty(p.TexturePath) ? "__untextured" : p.TexturePath;
            if (!triByTex.TryGetValue(tex, out var tris)) { tris = new List<int>(); triByTex[tex] = tris; }

            List<int>? surfTris = null;
            if (buildColliders && p.SurfaceType != opts.NoCollisionSurfaceType)
                if (!triBySurf.TryGetValue(p.SurfaceType, out surfTris)) { surfTris = new List<int>(); triBySurf[p.SurfaceType] = surfTris; }

            for (int iu = 0; iu < seg; iu++)
                for (int iv = 0; iv < seg; iv++)
                {
                    int a = vBase + iu * side + iv;
                    int b = vBase + iu * side + (iv + 1);
                    int c = vBase + (iu + 1) * side + iv;
                    int e = vBase + (iu + 1) * side + (iv + 1);
                    tris.Add(a); tris.Add(e); tris.Add(c);
                    tris.Add(a); tris.Add(b); tris.Add(e);
                    Vector3 f1 = Vector3.Cross(verts[e] - verts[a], verts[c] - verts[a]);
                    Vector3 f2 = Vector3.Cross(verts[b] - verts[a], verts[e] - verts[a]);
                    gN[a] += f1; gN[e] += f1; gN[c] += f1;
                    gN[a] += f2; gN[b] += f2; gN[e] += f2;
                    if (surfTris != null)
                    {
                        surfTris.Add(a); surfTris.Add(e); surfTris.Add(c);
                        surfTris.Add(a); surfTris.Add(b); surfTris.Add(e);
                    }
                }
        }

        // Sign each analytic normal outward vs the geometric one; fall back to geometric where the
        // analytic direction is ill-conditioned (collapsed patch corners).
        const float MaxDivergence = 30f;
        float divCos = MathF.Cos(MaxDivergence * MathF.PI / 180f);
        for (int i = 0; i < norms.Count; i++)
        {
            Vector3 g = gN[i];
            if (g.LengthSquared() < 1e-12f) continue;
            g = Vector3.Normalize(g);
            if (Vector3.Dot(norms[i], g) < 0f) norms[i] = -norms[i];
            if (Vector3.Dot(norms[i], g) < divCos) norms[i] = g;
        }

        // Weld luminance across shared positions (continuous lighting across patch seams).
        var sum = new Dictionary<(int, int, int), float>(verts.Count);
        var cnt = new Dictionary<(int, int, int), int>(verts.Count);
        for (int i = 0; i < verts.Count; i++)
        {
            var k = keys[i];
            sum.TryGetValue(k, out float s); sum[k] = s + lmv[i];
            cnt.TryGetValue(k, out int c); cnt[k] = c + 1;
        }
        t.Colors.Capacity = verts.Count;
        for (int i = 0; i < verts.Count; i++)
        {
            float a = sum[keys[i]] / cnt[keys[i]];
            t.Colors.Add(new Vector4(a, a, a, 1f));
        }

        // Weld normals across seams within a smoothing angle (gentle seams share, sharp edges stay crisp).
        const float SmoothAngle = 60f;
        float smoothCos = MathF.Cos(SmoothAngle * MathF.PI / 180f);
        var clusters = new Dictionary<(int, int, int), List<Vector3>>(verts.Count);
        var clusterIdx = new int[verts.Count];
        for (int i = 0; i < verts.Count; i++)
        {
            var k = keys[i];
            if (!clusters.TryGetValue(k, out var list)) { list = new List<Vector3>(2); clusters[k] = list; }
            int found = -1;
            for (int c = 0; c < list.Count; c++)
            {
                Vector3 dir = list[c];
                if (dir.LengthSquared() > 1e-12f && Vector3.Dot(Vector3.Normalize(dir), norms[i]) >= smoothCos) { found = c; break; }
            }
            if (found < 0) { list.Add(norms[i]); clusterIdx[i] = list.Count - 1; }
            else { list[found] = list[found] + norms[i]; clusterIdx[i] = found; }
        }
        var weldedNorms = new List<Vector3>(verts.Count);
        for (int i = 0; i < verts.Count; i++)
        {
            Vector3 cs = clusters[keys[i]][clusterIdx[i]];
            weldedNorms.Add(cs.LengthSquared() > 1e-12f ? Vector3.Normalize(cs) : norms[i]);
        }
        t.Norms = weldedNorms;
        return t;
    }

    // ---- lightmaps ----
    // Load the raw RGBA lightmaps written by LightmapExporter: RGB = C_S (GS source-colour residual),
    // alpha = A_S (light intensity). Both ride into the atlas so the shader can reconstruct the game's
    // (C_D - C_S) x A_S blend; the intensity-only paths derive A_S via IntensityFromMaps.
    static Rgba32[]?[] LoadLightmaps(string levelDir, out int found)
    {
        found = 0;
        var maps = new Rgba32[16][];
        string dir = Path.Combine(levelDir, "Lightmaps");
        if (!Directory.Exists(dir)) return maps!;
        const int W = 128;
        for (int id = 0; id < 16; id++)
        {
            string f = Path.Combine(dir, id.ToString("D4") + ".png");
            if (!File.Exists(f)) continue;
            using var img = Image.Load<Rgba32>(f);
            if (img.Width != W || img.Height != W) continue;
            var a = new Rgba32[W * W];
            img.ProcessPixelRows(acc =>
            {
                for (int y = 0; y < W; y++)
                {
                    var row = acc.GetRowSpan(y);
                    for (int x = 0; x < W; x++) a[y * W + x] = row[x];
                }
            });
            maps[id] = a;
            found++;
        }
        return maps!;
    }

    // Per-texel light INTENSITY A_S (alpha), 0..1 - drives the welded vertex-colour luminance fallback
    // (the authentic colour C_S rides in the atlas RGB for the per-pixel shader paths).
    static float[]?[] IntensityFromMaps(Rgba32[]?[] maps)
    {
        var lum = new float[maps.Length][];
        for (int id = 0; id < maps.Length; id++)
        {
            var m = maps[id];
            if (m == null) continue;
            var a = new float[m.Length];
            for (int i = 0; i < m.Length; i++) a[i] = m[i].A / 255f;
            lum[id] = a;
        }
        return lum!;
    }

    // Bake the per-pixel lightmap atlas as RGBA, carrying the GS encoding verbatim: RGB = C_S, alpha =
    // A_S. The terrain shader reconstructs (C_D - C_S) x A_S from this (_LIGHTMAP_GS); the intensity-only
    // fallback samples alpha (_LIGHTMAP_TEX). Empty map slots fill neutral (C_S=0, A_S=255 = full).
    static void SaveLightmapAtlas(Rgba32[]?[] maps, string path)
    {
        const int M = 128, A = 512;
        using var atlas = new Image<Rgba32>(A, A, new Rgba32(0, 0, 0, 255));
        atlas.ProcessPixelRows(acc =>
        {
            for (int m = 0; m < 16; m++)
            {
                var map = maps[m];
                if (map == null) continue;
                int ox = (m % 4) * M, oy = (m / 4) * M;
                for (int y = 0; y < M; y++)
                {
                    var row = acc.GetRowSpan(oy + y);
                    for (int x = 0; x < M; x++)
                        row[ox + x] = map[y * M + x];   // C_S in rgb, A_S in alpha, verbatim
                }
            }
        });
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        atlas.SaveAsPng(path);
    }

    // Bake a STANDARD colored multiply lightmap atlas for interchange (Blender / other engines / modders):
    // lit ~= exported_terrain_albedo x L, with L = (0.5 - C_S) x (A_S x 255/128) per channel - the recovered
    // coloured light C_L under a white-base assumption. Exact where the base is white/bright (snow); the small
    // error A_S*C_S*(1-C_D) only shows on dark, strongly-tinted rock. Unlike LightmapAtlas.png (the exact
    // C_S/A_S the engine reconstructs), this is directly usable: just multiply the albedo by it. Empty map
    // slots fill white (a multiply no-op).
    static void SaveMultiplyAtlas(Rgba32[]?[] maps, string path)
    {
        const int M = 128, A = 512;
        using var atlas = new Image<Rgba32>(A, A, new Rgba32(255, 255, 255, 255));
        atlas.ProcessPixelRows(acc =>
        {
            for (int m = 0; m < 16; m++)
            {
                var map = maps[m];
                if (map == null) continue;
                int ox = (m % 4) * M, oy = (m / 4) * M;
                for (int y = 0; y < M; y++)
                {
                    var row = acc.GetRowSpan(oy + y);
                    for (int x = 0; x < M; x++)
                        row[ox + x] = BakeMultiplyPixel(map[y * M + x]);
                }
            }
        });
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        atlas.SaveAsPng(path);
    }

    // (C_S in rgb, A_S in alpha) -> a standard multiply-lightmap pixel L = (0.5 - C_S) x (A_S x 255/128),
    // clamped to [0,1]. The 0.5 is the half-bright white base the engine assumes; see SaveMultiplyAtlas.
    static Rgba32 BakeMultiplyPixel(Rgba32 p)
    {
        float a = (p.A / 255f) * (255f / 128f);            // A_S x 255/128 (the GS >>7; sunlit > 1.0 clips here)
        byte Ch(byte cs) => (byte)Math.Clamp(RoundI((0.5f - cs / 255f) * a * 255f), 0, 255);
        return new Rgba32(Ch(p.R), Ch(p.G), Ch(p.B), 255);
    }

    static float SampleTile(float[] map, float lx, float ly, float lw, float lh, float u, float v)
    {
        const int W = 128;
        int bx = RoundI(lx * W), by = RoundI(ly * W);
        int tw = Math.Max(1, RoundI(lw * W) - 1);
        int th = Math.Max(1, RoundI(lh * W) - 1);
        float fx = u * tw, fy = v * th;
        int ix = Math.Clamp((int)fx, 0, tw - 1), iy = Math.Clamp((int)fy, 0, th - 1);
        float dx = fx - ix, dy = fy - iy;
        float a = map[(by + iy) * W + (bx + ix)];
        float b = map[(by + iy) * W + (bx + ix + 1)];
        float c = map[(by + iy + 1) * W + (bx + ix)];
        float e = map[(by + iy + 1) * W + (bx + ix + 1)];
        return Lerp(Lerp(a, b, dx), Lerp(c, e, dx), dy);
    }

    // The dominant shipped tile convention pulls a full single tile's UV corners in by 0.008 per side
    // (span 0.984) so bilinear + wrap sampling can't bleed the tile's opposite edge across the patch
    // seam (research/extracted-data.md census; Slopesmith exports the same UV_INSET). Some shipped
    // patches carry exact-unit corners instead and show that bleed, so the bake normalizes them: a
    // patch whose UVs span exactly one tile on BOTH axes gets the same inset. Already-inset tiles
    // (span 0.984), multi-tile repeats (span 2+, which must wrap) and sub-tile crops pass through
    // unchanged. D4 rotations/mirrors and the negative-V convention survive: the inset is applied
    // per-axis toward the span's own min/max, whatever corner order or sign the values sit in.
    const float UvInset = 0.008f;

    static void InsetUnitTile(ref Vector2 a, ref Vector2 b, ref Vector2 c, ref Vector2 d)
    {
        if (!IsUnitSpan(a.X, b.X, c.X, d.X) || !IsUnitSpan(a.Y, b.Y, c.Y, d.Y)) return;
        InsetAxis(ref a.X, ref b.X, ref c.X, ref d.X);
        InsetAxis(ref a.Y, ref b.Y, ref c.Y, ref d.Y);
    }

    static bool IsUnitSpan(float a, float b, float c, float d)
        => MathF.Abs(MathF.Max(MathF.Max(a, b), MathF.Max(c, d))
                   - MathF.Min(MathF.Min(a, b), MathF.Min(c, d)) - 1f) < 1e-4f;

    static void InsetAxis(ref float a, ref float b, ref float c, ref float d)
    {
        float min = MathF.Min(MathF.Min(a, b), MathF.Min(c, d));
        float Remap(float x) => min + UvInset + (x - min) * (1f - 2f * UvInset);
        a = Remap(a); b = Remap(b); c = Remap(c); d = Remap(d);
    }

    static void RemapUv(float u, float v, int mode, out float ou, out float ov)
    {
        switch (((mode % 8) + 8) % 8)
        {
            case 1: ou = v;      ov = 1f - u; break;
            case 2: ou = 1f - u; ov = 1f - v; break;
            case 3: ou = 1f - v; ov = u;      break;
            case 4: ou = 1f - u; ov = v;      break;
            case 5: ou = u;      ov = 1f - v; break;
            case 6: ou = v;      ov = u;      break;
            case 7: ou = 1f - v; ov = 1f - u; break;
            default: ou = u;     ov = v;      break;
        }
    }

    static Vector2 UvCorner(float[,]? uv, int i)
        => (uv == null || uv.GetLength(0) <= i) ? Vector2.Zero : new Vector2(uv[i, 0], uv[i, 1]);
    static Vector2 Bilerp(Vector2 c00, Vector2 c01, Vector2 c10, Vector2 c11, float u, float v)
        => Vector2.Lerp(Vector2.Lerp(c00, c01, v), Vector2.Lerp(c10, c11, v), u);
    static int RoundI(float x) => (int)MathF.Round(x);
    static float Lerp(float a, float b, float t) => a + (b - a) * t;
}
