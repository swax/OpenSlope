using System.Globalization;
using System.Text;
using SSXLibrary.JsonFiles.Tricky;
using Snowknife.Services;

namespace Snowknife.Export;

/// <summary>
/// Bakes the level's skybox (the backdrop sky/mountain geometry) into a single
/// <c>Skybox.obj</c> (+ <c>Skybox.mtl</c>). SSX stores the skybox as one small,
/// model-local model (e.g. 1 object / 25 textured sub-meshes) meant to be drawn
/// centered on the camera. We merge its sub-meshes as-is (no transform) and point the
/// materials at the PNGs in <c>Skybox/Textures/</c>, so it can be imported and, e.g.,
/// baked into a cubemap skybox in Unity.
/// </summary>
internal static class SkyboxExporter
{
    public static int Export(string levelDir, ContractValidationService contracts, bool allowNonRing = false)
    {
        string skyDir = Path.Combine(levelDir, "Skybox");
        string modelsPath = Path.Combine(skyDir, "Models.json");
        string matsPath = Path.Combine(skyDir, "Materials.json");
        string meshDir = Path.Combine(skyDir, "Meshes");

        if (!Directory.Exists(skyDir) || !File.Exists(modelsPath))
        {
            Log.Warn("No Skybox/Models.json found; skipping skybox.");
            return 0;
        }

        var models = ModelJsonHandler.Load(modelsPath).Models ?? new();
        var materials = File.Exists(matsPath)
            ? (MaterialJsonHandler.Load(matsPath).Materials ?? new())
            : new List<MaterialJsonHandler.MaterialsJson>();
        if (models.Count == 0) { Log.Warn("Skybox has no models; skipping."); return 0; }

        try
        {
            SkyRingExporter.Write(skyDir, contracts);
        }
        catch (InvalidDataException error) when (allowNonRing)
        {
            File.Delete(Path.Combine(skyDir, SkyRingDocument.FileName));
            Log.Warn($"  WARNING: custom skybox has no editable retail ring metadata: {error.Message}");
            Log.Info("           The original sky geometry and textures will still be merged into Skybox.obj.");
        }

        var usedMats = new SortedDictionary<int, string?>();
        bool usedUntextured = false;

        string objPath = Path.Combine(levelDir, "Skybox.obj");
        long gV = 0, gVt = 0, tris = 0;
        int meshes = 0, missing = 0;

        using (var w = new StreamWriter(objPath, false))
        {
            w.Write("# SSX skybox baked from Skybox/Models.json by snowknife\n");
            w.Write("mtllib Skybox.mtl\n");
            w.Write("o Skybox\n");

            string? lastMat = null;
            foreach (var model in models)
            {
                if (model.ModelObjects == null) continue;
                foreach (var obj in model.ModelObjects)
                {
                    if (obj.MeshData == null) continue;
                    foreach (var mh in obj.MeshData)
                    {
                        string full = Path.Combine(meshDir, mh.MeshPath ?? "");
                        if (string.IsNullOrEmpty(mh.MeshPath) || !File.Exists(full)) { missing++; continue; }

                        string matName = ResolveMat(mh.MaterialID, materials, usedMats, levelDir, ref usedUntextured);
                        if (matName != lastMat) { w.Write("usemtl "); w.Write(matName); w.Write('\n'); lastMat = matName; }

                        long vBase = gV, vtBase = gVt;   // sub-mesh OBJ indices are 1-based, local
                        foreach (var raw in File.ReadLines(full))
                        {
                            if (raw.Length < 2) continue;
                            char c0 = raw[0], c1 = raw[1];
                            if (c0 == 'v' && c1 == ' ') { w.Write(raw); w.Write('\n'); gV++; }
                            else if (c0 == 'v' && c1 == 't') { w.Write(raw); w.Write('\n'); gVt++; }
                            else if (c0 == 'f' && c1 == ' ')
                            {
                                var p = raw.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                                w.Write('f');
                                for (int k = 1; k < p.Length; k++)
                                {
                                    var bits = p[k].Split('/');
                                    long vi = long.Parse(bits[0], CultureInfo.InvariantCulture) + vBase;
                                    w.Write(' '); w.Write(vi.ToString(CultureInfo.InvariantCulture));
                                    if (bits.Length > 1 && bits[1].Length > 0)
                                    {
                                        long ti = long.Parse(bits[1], CultureInfo.InvariantCulture) + vtBase;
                                        w.Write('/'); w.Write(ti.ToString(CultureInfo.InvariantCulture));
                                    }
                                }
                                w.Write('\n');
                                if (p.Length >= 4) tris += p.Length - 3; // triangles in this face fan
                            }
                        }
                        meshes++;
                    }
                }
            }
        }

        WriteMtl(Path.Combine(levelDir, "Skybox.mtl"), usedMats, usedUntextured);
        Log.Info($"Skybox: merged {meshes} sub-meshes -> {gV:n0} verts, ~{tris:n0} triangles, {usedMats.Count} materials.");
        if (missing > 0) Log.Warn($"  ({missing} skybox sub-meshes missing.)");
        Log.Info($"  -> {objPath}");
        Log.Info($"  -> {Path.Combine(levelDir, "Skybox.mtl")}");
        return 0;
    }

    private static string ResolveMat(int matId, List<MaterialJsonHandler.MaterialsJson> mats,
                                     SortedDictionary<int, string?> used, string levelDir, ref bool usedUntextured)
    {
        if (matId >= 0 && matId < mats.Count)
        {
            if (!used.ContainsKey(matId))
            {
                string? tp = mats[matId].TexturePath;
                bool ok = !string.IsNullOrEmpty(tp)
                          && File.Exists(Path.Combine(levelDir, "Skybox", "Textures", tp));
                used[matId] = ok ? tp : null;
            }
            return "mat_" + matId.ToString(CultureInfo.InvariantCulture);
        }
        usedUntextured = true;
        return "mat_untextured";
    }

    private static void WriteMtl(string path, SortedDictionary<int, string?> used, bool usedUntextured)
    {
        var sb = new StringBuilder();
        sb.Append("# SSX skybox materials (textures in ./Skybox/Textures/) by snowknife\n\n");
        foreach (var kv in used)
        {
            sb.Append("newmtl mat_").Append(kv.Key.ToString(CultureInfo.InvariantCulture)).Append('\n');
            sb.Append("Ka 1.000 1.000 1.000\nKd 1.000 1.000 1.000\n");
            if (kv.Value != null)
                sb.Append("map_Kd Skybox/Textures/").Append(kv.Value).Append('\n');
            sb.Append('\n');
        }
        if (usedUntextured)
            sb.Append("newmtl mat_untextured\nKa 0.500 0.500 0.500\nKd 0.500 0.500 0.500\n\n");
        File.WriteAllText(path, sb.ToString());
    }
}
