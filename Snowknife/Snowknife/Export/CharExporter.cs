using System.Globalization;
using System.Numerics;
using System.Text;
using SSXLibrary.FileHandlers.Models.Tricky;

namespace Snowknife.Export;

/// <summary>
/// Extracts a single SSX Tricky rider model (body + head .mpf) and measures its
/// real-world height, so we can derive the level WorldScale from a known human size
/// instead of eyeballing props. A rider is authored to a real body, so:
///
///     scale = humanHeight(m) / riderHeight(rawUnits)
///
/// Also writes the rider as an OBJ (triangle mesh, no skinning) so it can be dropped
/// next to the world in Blender/Unity to confirm the fit visually.
///
/// The .mpf stores mesh vertices in MODEL space (bind pose) - the combiner reads the
/// same vertices straight into faces with no bone transform - so the bounding box of
/// the render mesh is the true standing extent. Meshes come in 3 LODs (filenames
/// contain 3000/1500/750) plus a "shdw" shadow volume; we use the 3000 LOD and skip
/// shadow/morph groups (GroupType 17/256), keeping only the standard render group (1).
/// </summary>
internal static class CharExporter
{
    private const int StandardGroupType = 1; // 17 = shadow, 256 = morph

    public static int Export(string charFilesDir, string name, string outDir)
    {
        string dir = Path.Combine(charFilesDir, "data", "char");
        string bodyPath = Path.Combine(dir, name + "_body.mpf");
        string headPath = Path.Combine(dir, name + "_head.mpf");

        if (!File.Exists(bodyPath))
        {
            Log.Error($"No body model for '{name}' (expected {bodyPath}).");
            string[] bodies = Directory.Exists(dir)
                ? Directory.GetFiles(dir, "*_body.mpf").Select(p => Path.GetFileNameWithoutExtension(p).Replace("_body", "")).ToArray()
                : Array.Empty<string>();
            if (bodies.Length > 0)
                Log.Error("Available riders: " + string.Join(", ", bodies));
            return 1;
        }

        Directory.CreateDirectory(outDir);

        var body = new TrickyPS2MPF();
        body.load(bodyPath);
        var verts = new List<Vector3>();
        var faces = new List<(int a, int b, int c)>();
        CollectRenderMesh(body, verts, faces);
        int bodyVerts = verts.Count;

        bool hasHead = File.Exists(headPath);
        if (hasHead)
        {
            var head = new TrickyPS2MPF();
            head.load(headPath);
            CollectRenderMesh(head, verts, faces);
        }

        if (verts.Count == 0)
        {
            Log.Error("Parsed the model but found no render vertices.");
            return 1;
        }

        // Bounding box on every axis - we don't assume which axis is "up" yet.
        Vector3 min = verts[0], max = verts[0];
        foreach (var v in verts)
        {
            min = Vector3.Min(min, v);
            max = Vector3.Max(max, v);
        }
        Vector3 size = max - min;

        // The standing axis is the tallest extent: a human (even arms-out) is taller
        // than they are deep, and the rider models are posed upright, not in a wide T.
        int upAxis = 0;
        if (size.Y >= size.X && size.Y >= size.Z) upAxis = 1;
        else if (size.Z >= size.X && size.Z >= size.Y) upAxis = 2;
        float heightUnits = upAxis == 0 ? size.X : upAxis == 1 ? size.Y : size.Z;
        char upName = upAxis == 0 ? 'X' : upAxis == 1 ? 'Y' : 'Z';

        string objPath = Path.Combine(outDir, name + ".obj");
        WriteObj(objPath, verts, faces, name);

        Log.Info($"Rider: {name}   ({bodyVerts} body verts" + (hasHead ? $" + {verts.Count - bodyVerts} head verts" : ", no head model") + ")");
        Log.Info($"  Bounding box (raw SSX units):");
        Log.Info($"    X {min.X,10:F3} .. {max.X,10:F3}   extent {size.X,9:F3}");
        Log.Info($"    Y {min.Y,10:F3} .. {max.Y,10:F3}   extent {size.Y,9:F3}");
        Log.Info($"    Z {min.Z,10:F3} .. {max.Z,10:F3}   extent {size.Z,9:F3}");
        Log.Info($"  Standing height = {heightUnits:F3} units (tallest axis: {upName})");
        Log.Info();
        Log.Info($"  Derived WorldScale (scale = humanHeight / {heightUnits:F1} units):");
        foreach (float h in new[] { 1.65f, 1.70f, 1.75f, 1.80f })
            Log.Info($"    {h:F2} m human ->  {h / heightUnits:F6}   (1 m = {heightUnits / h:F1} units)");
        Log.Info();
        Log.Info($"  Wrote {objPath}");
        Log.Info($"  (Current importer WorldScale = 0.011667; library BezierUtil assumes 0.01.)");
        return 0;
    }

    /// <summary>
    /// Exports the snowboard decks (data/char/board.mpf) as board_&lt;name&gt;.obj, keeping
    /// UVs and normals (unlike the rider export, which only needs positions for the
    /// height measurement). The geometry is shared across riders - the per-character look is
    /// texture (the 'bord' skins, <see cref="ExportBoardTextures"/>), not geometry.
    ///
    /// board.mpf holds SIX render decks - Al / Bx / Fr, each in a regular and a "Goofy"
    /// (mirrored-stance) copy - plus shadow volumes, all stacked at the origin. We write each
    /// of the three REGULAR decks to its own board_Al.obj / board_Bx.obj / board_Fr.obj (they
    /// are genuinely different board shapes, not LODs), skipping the Goofy mirrors and the
    /// shadow volumes.
    ///
    /// Geometry is left in raw SSX model units / unflipped handedness, exactly like the
    /// rider export; scale (WorldScale) and orientation are applied where it's placed.
    /// </summary>
    public static int ExportBoard(string charFilesDir, string outDir)
    {
        string dir = Path.Combine(charFilesDir, "data", "char");
        string boardPath = Path.Combine(dir, "board.mpf");

        if (!File.Exists(boardPath))
        {
            Log.Error($"No board model (expected {boardPath}).");
            return 1;
        }

        Directory.CreateDirectory(outDir);

        var board = new TrickyPS2MPF();
        board.load(boardPath);

        // Report what's inside, and collect the REGULAR-stance render decks (Al/Bx/Fr). Every deck
        // sits at the origin, so we write each to its own board_<name>.obj rather than one merged pile.
        // Skip the "Goofy" mirrors (a left/right flip of the same three) and the shadow volumes (type 17).
        Log.Info($"board.mpf: {board.ModelList.Count} sub-model(s)");
        var decks = new List<int>(); // indices of regular-stance standard-render decks
        for (int i = 0; i < board.ModelList.Count; i++)
        {
            var m = board.ModelList[i];
            bool isRender = m.MeshGroups.Any(g => g.GroupType == StandardGroupType);
            bool goofy = m.FileName.Trim().EndsWith("Goofy", StringComparison.OrdinalIgnoreCase);
            if (isRender && !goofy) decks.Add(i);
            string types = string.Join(",", m.MeshGroups.Select(g => g.GroupType).Distinct());
            string tag = !isRender ? "shadow" : goofy ? "deck (goofy, skipped)" : "deck";
            Log.Info($"    '{m.FileName.Trim()}'   groups [{types}]   {tag}");
        }

        if (decks.Count == 0)
        {
            Log.Error("board.mpf has no standard-render deck.");
            return 1;
        }

        Log.Info();
        const float worldScale = 0.011667f;
        string? firstObj = null;
        int written = 0;
        foreach (int idx in decks)
        {
            var deck = board.ModelList[idx];
            string deckName = deck.FileName.Trim();

            BuildDeckMesh(deck, out var verts, out var uvs, out var normals, out var faces, out var textures);
            if (verts.Count == 0)
            {
                Log.Error($"  Deck '{deckName}' has no render geometry; skipped.");
                continue;
            }

            string objPath = Path.Combine(outDir, $"board_{deckName}.obj");
            WriteBoardObj(objPath, verts, uvs, normals, faces, textures);
            firstObj ??= objPath;
            written++;

            Vector3 size = BoundsSize(verts);
            string texList = textures.Count > 0 ? string.Join(",", textures) : "none";
            Log.Info($"  board_{deckName}.obj: {verts.Count} verts, {faces.Count} tris, tex [{texList}], " +
                              $"raw {size.X:F2} x {size.Y:F2} x {size.Z:F2} (~{size.X * worldScale:F2} m long)");
        }

        if (written == 0 || firstObj == null) { Log.Error("No board decks exported."); return 1; }

        Log.Info();
        Log.Info($"Wrote {written} deck(s) to {outDir}");
        return 0;
    }

    /// <summary>
    /// Collects one deck's render geometry (positions, UVs, normals, triangles) plus its 'bord'
    /// texture id(s). vertices / uv / uvNormals are parallel per-vertex arrays; faces index into
    /// them, so one shared base offset per chunk keeps them aligned. Skips the shadow (17) group.
    /// </summary>
    private static void BuildDeckMesh(TrickyPS2MPF.MPFModelHeader deck, out List<Vector3> verts, out List<Vector2> uvs,
                                      out List<Vector3> normals, out List<(int a, int b, int c)> faces,
                                      out List<string> textures)
    {
        verts = new List<Vector3>();
        uvs = new List<Vector2>();
        normals = new List<Vector3>();
        faces = new List<(int a, int b, int c)>();
        textures = new List<string>();

        foreach (var mat in deck.materialDatas)
        {
            string tex = (mat.MainTexture ?? "").Trim();
            if (tex.Length > 0 && !textures.Contains(tex)) textures.Add(tex);
        }

        foreach (var group in deck.MeshGroups)
        {
            if (group.GroupType != StandardGroupType) continue; // skip the shadow (17) group
            foreach (var sub in group.meshGroupSubs)
                foreach (var hdr in sub.MeshGroupHeaders)
                    foreach (var chunk in hdr.staticMesh)
                    {
                        int baseIdx = verts.Count;
                        for (int i = 0; i < chunk.vertices.Count; i++)
                        {
                            verts.Add(chunk.vertices[i]);
                            Vector4 uv = i < chunk.uv.Count ? chunk.uv[i] : default;
                            uvs.Add(new Vector2(uv.X, uv.Y));
                            normals.Add(i < chunk.uvNormals.Count ? chunk.uvNormals[i] : Vector3.UnitY);
                        }
                        if (chunk.faces != null)
                            foreach (var f in chunk.faces)
                                faces.Add((baseIdx + f.V1Pos, baseIdx + f.V2Pos, baseIdx + f.V3Pos));
                    }
        }
    }

    private static Vector3 BoundsSize(List<Vector3> verts)
    {
        Vector3 min = verts[0], max = verts[0];
        foreach (var v in verts) { min = Vector3.Min(min, v); max = Vector3.Max(max, v); }
        return max - min;
    }

    /// <summary>
    /// Pulls every standard-render triangle out of the highest-LOD (3000) sub-models,
    /// appending vertices and 0-based triangle indices to the running lists.
    /// </summary>
    private static void CollectRenderMesh(TrickyPS2MPF mpf, List<Vector3> verts, List<(int, int, int)> faces)
    {
        foreach (var model in mpf.ModelList)
        {
            // Highest LOD only, so the 1500/750 copies don't overlap the mesh.
            if (!model.FileName.Contains("3000")) continue;

            foreach (var group in model.MeshGroups)
            {
                if (group.GroupType != StandardGroupType) continue;
                foreach (var sub in group.meshGroupSubs)
                    foreach (var hdr in sub.MeshGroupHeaders)
                        foreach (var chunk in hdr.staticMesh)
                        {
                            int baseIdx = verts.Count;
                            verts.AddRange(chunk.vertices);
                            if (chunk.faces != null)
                                foreach (var f in chunk.faces)
                                    faces.Add((baseIdx + f.V1Pos, baseIdx + f.V2Pos, baseIdx + f.V3Pos));
                        }
            }
        }
    }

    private static void WriteObj(string path, List<Vector3> verts, List<(int a, int b, int c)> faces, string name)
    {
        var sb = new StringBuilder();
        sb.Append("# SSX Tricky rider '").Append(name).Append("' - raw SSX model units (bind pose).\n");
        sb.Append("# Exported by snowknife for scale reference; no skinning/materials.\n");
        var ci = CultureInfo.InvariantCulture;
        foreach (var v in verts)
            sb.Append("v ").Append(v.X.ToString(ci)).Append(' ').Append(v.Y.ToString(ci)).Append(' ').Append(v.Z.ToString(ci)).Append('\n');
        foreach (var (a, b, c) in faces)
            sb.Append("f ").Append(a + 1).Append(' ').Append(b + 1).Append(' ').Append(c + 1).Append('\n');
        File.WriteAllText(path, sb.ToString());
    }

    /// <summary>
    /// Writes a board deck OBJ with positions, UVs and normals (v / vt / vn, faces as v/vt/vn).
    /// The three index lists are parallel (one vt and vn per v), so every face vertex uses the
    /// same index across all three. The 'bord' texture id is recorded as a comment; the matching
    /// skins are decoded separately by <see cref="Program"/>'s ExportBoardTextures (TEXPS2.BIG ->
    /// BoardTextures/&lt;id&gt;.png), so no .mtl is emitted - the UVs already map onto that atlas.
    /// </summary>
    private static void WriteBoardObj(string path, List<Vector3> verts, List<Vector2> uvs,
                                      List<Vector3> normals, List<(int a, int b, int c)> faces,
                                      List<string> textures)
    {
        var ci = CultureInfo.InvariantCulture;
        var sb = new StringBuilder();
        sb.Append("# SSX Tricky shared snowboard 'board.mpf' - raw SSX model units (bind pose).\n");
        sb.Append("# Exported by snowknife; positions + UVs + normals, no skinning.\n");
        sb.Append("# Texture IDs (char bank): ").Append(textures.Count > 0 ? string.Join(", ", textures) : "(none)").Append('\n');
        sb.Append("o board\n");

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
