using System.Globalization;
using System.Text.Json;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using Snowknife.Export;

namespace Snowknife.Bundle;

/// <summary>
/// Records each level texture's alpha MODE (opaque / cutout / blend / glow) in the manifest, so consumers
/// (the Unity importer, Blender) pick a render state without inspecting pixels. The opaque-vs-translucent
/// call comes from the per-material alpha-blend FLAG (170-materials.md; see <see cref="LoadMaterialAlphaModes"/>)
/// for extracted retail materials - the only reliable source there, since SSX stores opaque alpha at 0x80 so
/// an opaque skin and translucent glass are pixel-identical. Slopesmith-authored model_Custom_* materials have
/// no native appearance-flags word, so their conventional PNG pixels are authoritative. The pixel histogram
/// (<see cref="Classify"/>) otherwise only splits cutout vs blend - with <see cref="IsGlowSheet"/> rescuing
/// soft light-halo art from the cutout bucket - and handles textures with no material record (terrain patches
/// reference textures directly). Read-only on the pixels:
/// `import` already baked the premultiplied-alpha fix (TextureFinish) into Textures/ at decode time, the one
/// set every consumer reads (the bundle carries no texture copies; materials reference files by name).
/// </summary>
public static class TextureBundle
{
    public enum Alpha { Opaque, Cutout, Blend, Glow }

    public static List<BundleManifest.TextureInfo> Build(string levelDir)
    {
        string srcDir = Path.Combine(levelDir, "Textures");
        var outList = new List<BundleManifest.TextureInfo>();
        if (!Directory.Exists(srcDir)) { Log.Info("  (no Textures/ folder)"); return outList; }

        var overrides = LoadOverrides(levelDir);
        var authoredPixelAlpha = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var matModes = LoadMaterialAlphaModes(levelDir, authoredPixelAlpha);
        var sheets = LoadSheetTextures(levelDir, matModes);

        int cutout = 0, blend = 0, glow = 0, sheet = 0, n = 0;
        foreach (string src in Directory.GetFiles(srcDir, "*.png"))   // top-level bank (incl. crowd cd*.png)
        {
            using var img = Image.Load<Rgba32>(src);
            var px = new Rgba32[img.Width * img.Height];
            img.CopyPixelDataTo(px);
            string name = Path.GetFileName(src);

            // Precedence: an explicit TextureAlpha.overrides entry wins; authored custom-model PNGs and
            // textures with no material record classify from pixels; extracted retail materials use their
            // native alpha-blend flag, with the histogram only splitting cutout (hole-shaped) from blend.
            // A retail GLOW SHEET (light halo art; see IsGlowSheet) is pulled out of the cutout bucket because
            // clipping is exactly what destroys it.
            Alpha mode;
            if (overrides.TryGetValue(name, out var forced)) mode = forced;
            else if (authoredPixelAlpha.Contains(name)) mode = Classify(px);
            else if (matModes.TryGetValue(name, out var mm))
                mode = mm switch
                {
                    MatAlpha.Blend  => Classify(px) != Alpha.Cutout ? Alpha.Blend
                                     : IsGlowSheet(px, img.Width, img.Height) ? Alpha.Glow : Alpha.Cutout,
                    MatAlpha.Opaque => Alpha.Opaque,
                    _               => Classify(px),   // Special (bit 0x20000) is a draw-order bit; these mark binary-mask decals -> pixels classify cutout
                };
            else mode = Classify(px);

            bool isSheet = mode == Alpha.Blend && sheets.Contains(name);
            outList.Add(new BundleManifest.TextureInfo
            {
                File = name,
                Alpha = mode == Alpha.Cutout ? "cutout" : mode == Alpha.Blend ? "blend" : mode == Alpha.Glow ? "glow" : "opaque",
                Sheet = isSheet ? true : null,
            });
            if (mode == Alpha.Cutout) cutout++;
            if (mode == Alpha.Blend) blend++;
            if (mode == Alpha.Glow) glow++;
            if (isSheet) sheet++;
            n++;
        }

        Log.Info($"  Textures: {n} classified ({cutout} cutout, {blend} blend incl. {sheet} sheet, {glow} glow).");
        return outList;
    }

    // The per-material alpha flag, aggregated per texture. A material's compositing mode is the appearance-flags
    // word at record offset 0x40 (TrickyMaterial.UnknownInt18; 170-materials.md / 220-level-pbd.md). Object meshes
    // all draw with one shared GS state (alpha-over blend + a low alpha test, AREF=12, z-write on), so the flag
    // word plus the texture's own shape decide the mode:
    //   bit 0x40000 = the surface composites with the texture alpha -> BLEND (smooth partial-alpha band) or
    //                 CUTOUT (a hole-shaped binary mask)
    //   bit 0x20000 = an opaque DRAW-ORDER priority bit (feeds the EE opaque-draw sort via render-descriptor
    //                 +0x0e, a coplanar-decal z-fight tiebreaker). It marks binary-mask decal/overlay pages
    //                 (LCD scanline, firework, crowd placeholder); the AREF=12 alpha test cuts their holes, so
    //                 the pixel histogram classifies them cutout.
    //   neither bit = OPAQUE: the texture alpha is full (a building skin's window texels sit at 0x80, which the
    //                 half-bright store makes pixel-identical to translucent glass - so the flag is the reliable
    //                 opaque-vs-translucent signal).
    // A texture inherits the strongest mode among the extracted materials referencing it (Blend > Special >
    // Opaque). Slopesmith-authored model_Custom_* records use zero as a neutral placeholder, not an explicit
    // opaque decision; LoadMaterialAlphaModes routes those textures to pixel classification instead. Terrain
    // patches reference textures directly with no material record, so those also fall back to the pixels.
    enum MatAlpha { Opaque, Special, Blend }   // ordered low->high so the aggregation keeps the strongest

    static Dictionary<string, MatAlpha> LoadMaterialAlphaModes(string levelDir, HashSet<string> authoredPixelAlpha)
    {
        var outv = new Dictionary<string, MatAlpha>(StringComparer.OrdinalIgnoreCase);
        string path = Path.Combine(levelDir, "Materials.json");
        if (!File.Exists(path)) return outv;
        MatFile? doc;
        try { doc = JsonSerializer.Deserialize<MatFile>(File.ReadAllText(path), MatJson); }
        catch (Exception e)
        {
            Log.Warn($"  WARN: {path} is unreadable ({e.Message}) — every texture's alpha mode comes from its pixels.");
            return outv;
        }
        if (doc?.Materials == null) return outv;
        const int AlphaBlend = 0x40000;   // bit 18
        const int SpecialMode = 0x20000;  // bit 17
        foreach (var m in doc.Materials)
        {
            if (string.IsNullOrEmpty(m.TexturePath)) continue;
            if (AuthoredMaterialPolicy.UsesPixelAlpha(m.MaterialName))
            {
                authoredPixelAlpha.Add(m.TexturePath);
                continue;
            }
            MatAlpha mode = (m.UnknownInt18 & AlphaBlend) != 0 ? MatAlpha.Blend
                          : (m.UnknownInt18 & SpecialMode) != 0 ? MatAlpha.Special
                          : MatAlpha.Opaque;
            if (!outv.TryGetValue(m.TexturePath, out var prev) || mode > prev) outv[m.TexturePath] = mode;
        }
        return outv;
    }

    // Which BLEND textures draw nothing but single-facing SHEETS - river surfaces, banners - as opposed to a
    // closed shell like the GARI Radiotower. A sheet has no back side of its own to hide, so the consumer can
    // draw it without depth write; a shell needs the depth write to stop its far wall compositing through its
    // near one. Without that split, two stacked sheets (MESA's river is a fast layer over a slow one) only
    // show the layer that happens to draw first - the second is depth-rejected from one side.
    //
    // The test is per submesh, over the model-local normals of Meshes/<MeshPath>.obj: every normal within
    // SheetMinDot of their mean. The two classes are far apart in the retail data (water sheets measure +0.95
    // or better; the blend-flagged towers measure -0.5 or worse), so the threshold sits in a wide gap. A
    // texture inherits the flag only when EVERY submesh referencing it is a sheet - sharing one page between a
    // sheet and a shell falls back to depth write, which is the safe answer for both.
    const double SheetMinDot = 0.5;

    static HashSet<string> LoadSheetTextures(string levelDir, Dictionary<string, MatAlpha> matModes)
    {
        var outv = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        string modelsPath = Path.Combine(levelDir, "Models.json");
        string meshDir = Path.Combine(levelDir, "Meshes");
        string matPath = Path.Combine(levelDir, "Materials.json");
        if (!File.Exists(modelsPath) || !File.Exists(matPath) || !Directory.Exists(meshDir)) return outv;
        List<MatRec>? materials;
        ModelFile? models;
        string reading = matPath;
        try
        {
            materials = JsonSerializer.Deserialize<MatFile>(File.ReadAllText(matPath), MatJson)?.Materials;
            reading = modelsPath;
            models = JsonSerializer.Deserialize<ModelFile>(File.ReadAllText(modelsPath), MatJson);
        }
        catch (Exception e)
        {
            Log.Warn($"  WARN: {reading} is unreadable ({e.Message}) — blend textures keep their depth write.");
            return outv;
        }
        if (materials == null || models?.Models == null) return outv;

        var verdict = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);   // texture -> all sheets so far
        foreach (var model in models.Models)
        foreach (var obj in model.ModelObjects ?? new())
        foreach (var mesh in obj.MeshData ?? new())
        {
            if (mesh.MaterialID < 0 || mesh.MaterialID >= materials.Count) continue;
            string? tex = materials[mesh.MaterialID].TexturePath;
            if (string.IsNullOrEmpty(tex)) continue;
            if (!matModes.TryGetValue(tex, out var mode) || mode != MatAlpha.Blend) continue;   // only blend pages matter
            if (verdict.TryGetValue(tex, out bool sofar) && !sofar) continue;                   // already disqualified
            verdict[tex] = IsSheetObj(Path.Combine(meshDir, mesh.MeshPath ?? ""));
        }
        foreach (var (tex, all) in verdict) if (all) outv.Add(tex);
        return outv;
    }

    // One submesh's verdict, read straight off the OBJ's `vn` lines (no full parse: the face table cannot
    // change which way the normals point). A mesh with no normals answers false.
    static bool IsSheetObj(string objPath)
    {
        if (!File.Exists(objPath)) return false;
        var normals = new List<(double X, double Y, double Z)>();
        foreach (string line in File.ReadLines(objPath))
        {
            if (!line.StartsWith("vn ", StringComparison.Ordinal)) continue;
            string[] p = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (p.Length < 4) continue;
            if (double.TryParse(p[1], NumberStyles.Float, CultureInfo.InvariantCulture, out double x)
                && double.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out double y)
                && double.TryParse(p[3], NumberStyles.Float, CultureInfo.InvariantCulture, out double z))
                normals.Add((x, y, z));
        }
        if (normals.Count == 0) return false;
        double mx = 0, my = 0, mz = 0;
        foreach (var (x, y, z) in normals) { mx += x; my += y; mz += z; }
        double len = Math.Sqrt(mx * mx + my * my + mz * mz);
        if (len < 1e-6) return false;
        mx /= len; my /= len; mz /= len;
        foreach (var (x, y, z) in normals) if (x * mx + y * my + z * mz < SheetMinDot) return false;
        return true;
    }

    static readonly JsonSerializerOptions MatJson = new() { PropertyNameCaseInsensitive = true };
    sealed class MatFile { public List<MatRec>? Materials { get; set; } }
    sealed class ModelFile { public List<ModelRec>? Models { get; set; } }
    sealed class ModelRec { public List<ModelObjRec>? ModelObjects { get; set; } }
    sealed class ModelObjRec { public List<MeshRec>? MeshData { get; set; } }
    sealed class MeshRec { public string? MeshPath { get; set; } public int MaterialID { get; set; } }
    sealed class MatRec
    {
        public string? MaterialName { get; set; }
        public string? TexturePath { get; set; }
        public int UnknownInt18 { get; set; }
    }

    // Per-level hand overrides: <levelDir>/TextureAlpha.overrides.json maps texture file name to
    // "opaque"/"cutout"/"blend" and wins over the histogram (e.g. force a mid-alpha glass texture onto the
    // alpha-to-coverage cutout path so the prop stays depth-written instead of sort-fighting as blend).
    static Dictionary<string, Alpha> LoadOverrides(string levelDir)
    {
        var result = new Dictionary<string, Alpha>(StringComparer.OrdinalIgnoreCase);
        string path = Path.Combine(levelDir, "TextureAlpha.overrides.json");
        if (!File.Exists(path)) return result;
        var map = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(path)) ?? new();
        foreach (var (file, mode) in map)
        {
            result[file] = mode.ToLowerInvariant() switch
            {
                "cutout" => Alpha.Cutout,
                "blend" => Alpha.Blend,
                "glow" => Alpha.Glow,
                _ => Alpha.Opaque,
            };
        }
        Log.Info($"  Textures: {result.Count} alpha override(s) from TextureAlpha.overrides.json.");
        return result;
    }

    // A GLOW SHEET is light art drawn as translucency: soft halo/starburst/light-wash sprites (e.g.
    // crowd-light starburst strings, lamp-ray fans and light spill). These carry holes (the sheet
    // background) so the histogram files them cutout - but the soft partial-alpha ramp IS the art, and the
    // cutout render path clips it to a hard-edged star. Pixel signature, calibrated over every extracted
    // level's blend-flag textures (each threshold sits in a wide gap between the glow art and its nearest
    // impostor):
    //   - partial alpha DOMINATES the visible pixels (>= 60%; glow art measures 0.78+, while mostly-solid
    //     foliage/decals with soft edges stay <= 0.41 unless high-frequency),
    //   - the alpha field is SMOOTH (mean |dA| between neighbours < 25; a light ramp measures <= 20, where
    //     leaves/people/perforated grates - coverage masks - measure 33+),
    //   - the art is BRIGHT (alpha-weighted max-channel >= 128: light is bright; dark mesh/grate art fails).
    static bool IsGlowSheet(Rgba32[] px, int w, int h)
    {
        long vis = 0, mid = 0, gradSum = 0, pairs = 0, wSum = 0, aSum = 0;
        for (int y = 0; y < h; y++)
        for (int x = 0; x < w; x++)
        {
            var p = px[y * w + x];
            if (p.A >= 8)
            {
                vis++;
                if (p.A < 250) mid++;
                int maxC = Math.Max(p.R, Math.Max(p.G, p.B));
                wSum += (long)maxC * p.A; aSum += p.A;
            }
            if (x + 1 < w) { byte a2 = px[y * w + x + 1].A; if (p.A >= 8 || a2 >= 8) { gradSum += Math.Abs(p.A - a2); pairs++; } }
            if (y + 1 < h) { byte a2 = px[(y + 1) * w + x].A; if (p.A >= 8 || a2 >= 8) { gradSum += Math.Abs(p.A - a2); pairs++; } }
        }
        if (vis == 0 || pairs == 0 || aSum == 0) return false;
        double partialOfVisible = (double)mid / vis;
        double smoothness = (double)gradSum / pairs;
        double brightness = (double)wSum / aSum;
        return partialOfVisible >= 0.60 && smoothness < 25.0 && brightness >= 128.0;
    }

    // Cutout = fully-transparent holes (a<8 over >=0.3% of pixels) AND solid content (bimodal); Blend =
    // a non-cutout texture with a substantial partial-alpha band (>=20%); else Opaque. (AlphaClassifier)
    static Alpha Classify(Rgba32[] px)
    {
        int total = px.Length, nClear = 0, nSolid = 0;
        for (int i = 0; i < total; i++)
        {
            byte a = px[i].A;
            if (a < 8) nClear++;
            else if (a >= 250) nSolid++;
        }
        long nMid = (long)total - nClear - nSolid;
        if (total > 0 && nClear * 1000L >= total * 3L && nSolid > 0) return Alpha.Cutout;
        if (total > 0 && nMid * 5L >= (long)total * 1L) return Alpha.Blend;
        return Alpha.Opaque;
    }
}
