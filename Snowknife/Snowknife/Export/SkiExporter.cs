using System.Globalization;
using System.Numerics;
using System.Text;
using SSXLibrary.FileHandlers.Models.OnTour;

namespace Snowknife.Export;

/// <summary>
/// Exports SSX On Tour ski "vehicle" decks (data/char vehicles_Skis*_H.mpf) as
/// ski_&lt;name&gt;.obj, keeping UVs and normals - the skiing analogue of the Tricky
/// snowboard deck (<see cref="CharExporter.ExportBoard"/>). The per-skier look is
/// texture (the 'skis' skins in TEXPS2.BIG, decoded by <see cref="Program"/>'s
/// ExportSkiTextures), not geometry.
///
/// On Tour stores each piece of equipment as its own .mpf member inside the vehicle
/// archive (V_MDLPS2.BIG) at several LODs (H/M/L) plus a "_Shdw" shadow volume. We take
/// the highest-detail render decks (vehicles_Skis*_H.mpf) and skip the shadow files.
///
/// Unlike Tricky's TrickyPS2MPF, On Tour models are read by SSXOnTourMPF and rebuilt by
/// SSXOnTourPS2ModelCombiner, which hands back a flat triangle list (positions, UVs,
/// normals per face). We pull those straight into an OBJ - no skinning - because the
/// skis are a rigid prop. Geometry is left in raw SSX model units / unflipped handedness,
/// exactly like the board export; scale and orientation are applied where it is placed.
/// </summary>
internal static class SkiExporter
{
    /// <summary>
    /// Writes every render ski deck found under <paramref name="vehFilesDir"/>
    /// (the unpacked V_MDLPS2.BIG) to its own ski_&lt;ModelName&gt;.obj in
    /// <paramref name="outDir"/>.
    /// </summary>
    public static int ExportSkis(string vehFilesDir, string outDir)
    {
        // The combiner reassembles vehicles_SkisA_H.mpf etc.; the "_Shdw" files are
        // shadow volumes, not skis, so they are excluded.
        var mpfs = Directory.GetFiles(vehFilesDir, "vehicles_Skis*_H.mpf", SearchOption.AllDirectories)
                            .Where(p => !Path.GetFileName(p).Contains("Shdw", StringComparison.OrdinalIgnoreCase))
                            .OrderBy(p => p, StringComparer.OrdinalIgnoreCase)
                            .ToList();
        if (mpfs.Count == 0)
        {
            Log.Error($"No ski decks (expected vehicles_Skis*_H.mpf under {vehFilesDir}).");
            return 1;
        }

        Directory.CreateDirectory(outDir);

        // On Tour vehicle units are ~1 cm; a ski reads ~170 raw units long => ~1.7 m at 0.01.
        const float worldScale = 0.01f;
        string? firstObj = null;
        int written = 0;

        foreach (string mpfPath in mpfs)
        {
            var mpf = new SSXOnTourMPF();
            mpf.Load(mpfPath);

            BuildSkiMesh(mpf, out var verts, out var uvs, out var normals, out var faces, out var textures);
            if (verts.Count == 0)
            {
                Log.Error($"  {Path.GetFileName(mpfPath)}: no render geometry; skipped.");
                continue;
            }

            // Name after the model itself (e.g. "SkisA_H"), stripping the vehicles_ prefix.
            string id = Path.GetFileNameWithoutExtension(mpfPath);
            if (id.StartsWith("vehicles_", StringComparison.OrdinalIgnoreCase)) id = id["vehicles_".Length..];

            string objPath = Path.Combine(outDir, $"ski_{id}.obj");
            WriteSkiObj(objPath, verts, uvs, normals, faces, textures);
            firstObj ??= objPath;
            written++;

            Vector3 size = BoundsSize(verts);
            string texList = textures.Count > 0 ? string.Join(",", textures) : "none";
            Log.Info($"  ski_{id}.obj: {verts.Count} verts, {faces.Count} tris, tex [{texList}], " +
                              $"raw {size.X:F2} x {size.Y:F2} x {size.Z:F2} (~{size.X * worldScale:F2} m long)");
        }

        if (written == 0 || firstObj == null) { Log.Error("No ski decks exported."); return 1; }

        Log.Info();
        Log.Info($"Wrote {written} ski deck(s) to {outDir}");
        return 0;
    }

    /// <summary>
    /// Reassembles every (non-shadow) model in the .mpf via the combiner and flattens the
    /// resulting triangle faces into parallel positions/UV/normal arrays + 0-based indices.
    /// Each face emits three fresh vertices (the combiner gives explicit per-corner data,
    /// not shared indices), so faces just count up in threes.
    /// </summary>
    private static void BuildSkiMesh(SSXOnTourMPF mpf, out List<Vector3> verts, out List<Vector2> uvs,
                                     out List<Vector3> normals, out List<(int a, int b, int c)> faces,
                                     out List<string> textures)
    {
        verts = new List<Vector3>();
        uvs = new List<Vector2>();
        normals = new List<Vector3>();
        faces = new List<(int a, int b, int c)>();
        textures = new List<string>();

        for (int i = 0; i < mpf.ModelList.Count; i++)
        {
            foreach (var mat in mpf.ModelList[i].MaterialList ?? new List<SSXOnTourMPF.MaterialData>())
            {
                string tex = (mat.MainTexture ?? "").Trim();
                if (tex.Length > 0 && !textures.Contains(tex)) textures.Add(tex);
            }

            // A fresh combiner per model index keeps the reassembly state isolated.
            var combiner = new SSXOnTourPS2ModelCombiner();
            combiner.AddFile(mpf);
            combiner.MeshReassigned(i);

            foreach (var rm in combiner.reassignedMesh)
            {
                if (rm.ShadowModel || rm.faces == null) continue;
                foreach (var f in rm.faces)
                {
                    int baseIdx = verts.Count;
                    AddCorner(verts, uvs, normals, f.V1, f.UV1, f.Normal1);
                    AddCorner(verts, uvs, normals, f.V2, f.UV2, f.Normal2);
                    AddCorner(verts, uvs, normals, f.V3, f.UV3, f.Normal3);
                    faces.Add((baseIdx, baseIdx + 1, baseIdx + 2));
                }
            }
        }
    }

    private static void AddCorner(List<Vector3> verts, List<Vector2> uvs, List<Vector3> normals,
                                  Vector3 pos, Vector4 uv, Vector3 normal)
    {
        verts.Add(pos);
        // SSX UVs are top-left origin; OBJ/Unity want bottom-left, so flip V (matches the
        // board/level UV convention applied at export).
        uvs.Add(new Vector2(uv.X, 1f - uv.Y));
        normals.Add(normal);
    }

    private static Vector3 BoundsSize(List<Vector3> verts)
    {
        Vector3 min = verts[0], max = verts[0];
        foreach (var v in verts) { min = Vector3.Min(min, v); max = Vector3.Max(max, v); }
        return max - min;
    }

    /// <summary>
    /// Writes a ski deck OBJ with positions, UVs and normals (v / vt / vn, faces v/vt/vn).
    /// The three index lists are parallel, so every face corner uses the same index across
    /// all three. The 'skis' texture id is recorded as a comment; the matching skins are
    /// decoded separately by <see cref="Program"/>'s ExportSkiTextures (TEXPS2.BIG -&gt;
    /// SkiTextures/&lt;id&gt;.png), so no .mtl is emitted - the UVs already map onto that atlas.
    /// </summary>
    private static void WriteSkiObj(string path, List<Vector3> verts, List<Vector2> uvs,
                                    List<Vector3> normals, List<(int a, int b, int c)> faces,
                                    List<string> textures)
    {
        var ci = CultureInfo.InvariantCulture;
        var sb = new StringBuilder();
        sb.Append("# SSX On Tour ski deck (vehicles_Skis*.mpf) - raw SSX model units (bind pose).\n");
        sb.Append("# Exported by snowknife; positions + UVs + normals, no skinning.\n");
        sb.Append("# Texture IDs (char bank): ").Append(textures.Count > 0 ? string.Join(", ", textures) : "(none)").Append('\n');
        sb.Append("o ski\n");

        foreach (var v in verts)
            sb.Append("v ").Append(v.X.ToString(ci)).Append(' ').Append(v.Y.ToString(ci)).Append(' ').Append(v.Z.ToString(ci)).Append('\n');
        foreach (var t in uvs)
            sb.Append("vt ").Append(t.X.ToString(ci)).Append(' ').Append(t.Y.ToString(ci)).Append('\n');
        foreach (var n in normals)
            sb.Append("vn ").Append(n.X.ToString(ci)).Append(' ').Append(n.Y.ToString(ci)).Append(' ').Append(n.Z.ToString(ci)).Append('\n');

        foreach (var (a, b, c) in faces)
        {
            int ia = a + 1, ib = b + 1, ic = c + 1;
            sb.Append("f ")
              .Append(ia).Append('/').Append(ia).Append('/').Append(ia).Append(' ')
              .Append(ib).Append('/').Append(ib).Append('/').Append(ib).Append(' ')
              .Append(ic).Append('/').Append(ic).Append('/').Append(ic).Append('\n');
        }
        File.WriteAllText(path, sb.ToString());
    }
}
