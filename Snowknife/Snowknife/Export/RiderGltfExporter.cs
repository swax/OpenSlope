using System.Numerics;
using System.Text.RegularExpressions;
using SharpGLTF.Geometry;
using SharpGLTF.Geometry.VertexTypes;
using SharpGLTF.Materials;
using SharpGLTF.Memory;
using SharpGLTF.Scenes;
using SharpGLTF.Schema2;
using SSX_Library.EATextureLibrary; // OldShapeHandler (.SSH decode)
using SSXLibrary.FileHandlers.Models.Tricky;

namespace Snowknife.Export;

/// <summary>
/// Exports one SSX Tricky rider as a skinned, textured glTF binary for use as a modelling reference in
/// Blender: the full-detail (3000) body and head sub-models, the rider's own skeleton and skin weights, and
/// the four texture slots, so proportions, joint placement and texture density can be studied side by side
/// with a new model.
///
/// The library's own <c>glftHandler.SaveTrickyPS2glTF</c> writes the same mesh, but untextured, in raw units
/// and Z-up, so Blender opens it lying down at a hundred times human size. This writer reads the same
/// combiner output, rotates Z-up to glTF's Y-up the way Blender's own exporter does - (x, y, z) -> (x, z, -y),
/// a proper rotation, so winding is kept - and scales 1 unit = 1 cm. Blender's importer undoes that rotation,
/// so the rider lands in the engine's own model axes: Z up, facing -Y (Blender's Front view), left side on
/// +X. Mac then stands 1.76 m tall, and riders keep their heights relative to each other instead of each
/// being fitted to one size. (The course bundle's <see cref="Bundle.GltfMeshWriter"/> maps world space with a
/// further half turn about the vertical; a lone rider is oriented for the modeller instead.) The model
/// origin is the hips, so the whole rider is lifted to stand its lowest vertex on the ground plane.
///
/// The rest pose is the bind pose: the vertices are stored in model space and the inverse bind matrices are
/// computed from the same joint transforms, so the mesh is exact whatever the bone rotations mean. Morph
/// targets (facial shapes), the lower LODs and the shadow volume are left out.
///
/// Outfits change only texture. Each rider has one <c>&lt;name&gt;_head.ssh</c> and <c>&lt;name&gt;_helm.ssh</c>
/// and a numbered <c>&lt;name&gt;&lt;N&gt;_suit.ssh</c> / <c>_boot.ssh</c> pair per outfit, all in
/// DATA\CHAR\TEXPS2.BIG.
/// </summary>
internal static class RiderGltfExporter
{
    /// <summary>Raw SSX model units are centimetres for a rider: Mac measures 176 units.</summary>
    public const float MetresPerUnit = 0.01f;

    /// <summary>The combiner's material slots are <c>3 * part + finish</c>, in this part order.</summary>
    internal static readonly string[] Parts = ["helm", "boot", "head", "suit"];

    static readonly string[] Finishes = ["", " gloss", " envr"];

    /// <summary>
    /// The rotation <see cref="ToGltf"/> applies: -90 degrees about X. A root bone needs it as a quaternion,
    /// since its local rotation is what carries the whole skeleton into glTF space.
    /// </summary>
    internal static readonly Quaternion AxisSwap = new(-MathF.Sqrt(0.5f), 0f, 0f, MathF.Sqrt(0.5f));

    /// <summary>Engine model space (Z up, facing -Y) -> glTF (Y up, facing +Z). No scale.</summary>
    internal static Vector3 ToGltf(Vector3 v) => new(v.X, v.Z, -v.Y);

    public static int Export(string modelDir, string textureDir, string name, string outDir, int? outfit)
    {
        string bodyPath = Path.Combine(modelDir, name + "_body.mpf");
        string headPath = Path.Combine(modelDir, name + "_head.mpf");
        if (!File.Exists(bodyPath) || !File.Exists(headPath))
        {
            Log.Error($"No body and head model for '{name}' (expected {bodyPath} and {headPath}).");
            string[] riders = RiderNames(modelDir);
            if (riders.Length > 0) Log.Error("Available riders: " + string.Join(", ", riders));
            return 1;
        }

        string texName = TextureName(name);
        int[] outfits = Outfits(textureDir, texName);
        int chosen = outfit ?? (outfits.Length > 0 ? outfits[0] : 0);
        if (outfit != null && !outfits.Contains(outfit.Value))
        {
            Log.Error($"'{name}' has no outfit {outfit}. Outfits: " + (outfits.Length > 0 ? string.Join(", ", outfits) : "none"));
            return 1;
        }

        var body = new TrickyPS2MPF();
        body.load(bodyPath);
        var head = new TrickyPS2MPF();
        head.load(headPath);
        var combiner = new TrickyPS2ModelCombiner { Body = body, Head = head, BodyBool = true };
        combiner.StartReassignMeshCharacter(0); // 0 = the 3000 LOD, every body and head sub-model at it

        string riderDir = Path.Combine(outDir, name);
        string texOut = Path.Combine(riderDir, "textures");
        Directory.CreateDirectory(texOut);
        var decoded = DecodeTextures(textureDir, texName, outfits, texOut);

        var embed = new Dictionary<string, string>();
        foreach (string part in Parts)
        {
            string file = part is "suit" or "boot" ? $"{part}{chosen}.png" : $"{part}.png";
            if (decoded.Contains(file)) embed[part] = Path.Combine(texOut, file);
        }

        ModelRoot model = BuildModel(combiner, embed);
        string glbPath = Path.Combine(riderDir, name + ".glb");
        model.SaveGLB(glbPath);

        Vector3 min = new(float.MaxValue), max = new(float.MinValue);
        int vertices = 0, triangles = 0;
        foreach (var prim in model.LogicalMeshes.SelectMany(m => m.Primitives))
        {
            var positions = prim.GetVertexAccessor("POSITION").AsVector3Array();
            vertices += positions.Count;
            triangles += prim.GetTriangleIndices().Count();
            foreach (var p in positions) { min = Vector3.Min(min, p); max = Vector3.Max(max, p); }
        }

        string missing = string.Join(", ", Parts.Where(p => !embed.ContainsKey(p)));
        Log.Info($"  {name}.glb: {model.LogicalMeshes.Count} meshes, {vertices} verts, {triangles} tris, " +
                 $"{combiner.bones.Count} bones, outfit {(chosen > 0 ? chosen.ToString() : "none")}" +
                 (missing.Length > 0 ? $" (no texture for {missing})" : ""));
        Log.Info($"    standing height {max.Y - min.Y:F2} m; {decoded.Count} texture(s) in textures/; outfits " +
                 (outfits.Length > 0 ? string.Join(", ", outfits) : "none"));
        return 0;
    }

    /// <summary>Every rider with both a body and a head model, sorted.</summary>
    public static string[] RiderNames(string modelDir) =>
        Directory.Exists(modelDir)
            ? Directory.GetFiles(modelDir, "*_body.mpf")
                .Select(p => Path.GetFileName(p)[..^"_body.mpf".Length])
                .Where(n => File.Exists(Path.Combine(modelDir, n + "_head.mpf")))
                .OrderBy(n => n, StringComparer.Ordinal)
                .ToArray()
            : [];

    /// <summary>
    /// The texture banks' name for a rider. The unlockable rider's models are <c>zz_mmm_*.mpf</c>, but its
    /// textures drop the prefix: <c>mmm_head.ssh</c>, <c>mmm1_suit.ssh</c>.
    /// </summary>
    internal static string TextureName(string name) =>
        name.StartsWith("zz_", StringComparison.OrdinalIgnoreCase) ? name[3..] : name;

    /// <summary>The outfit numbers that have a suit texture for <paramref name="name"/>, ascending.</summary>
    internal static int[] Outfits(string textureDir, string name)
    {
        if (!Directory.Exists(textureDir)) return [];
        var suit = new Regex("^" + Regex.Escape(name) + @"(\d+)_suit\.ssh$", RegexOptions.IgnoreCase);
        return Directory.GetFiles(textureDir, "*_suit.ssh")
            .Select(p => suit.Match(Path.GetFileName(p)))
            .Where(m => m.Success)
            .Select(m => int.Parse(m.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture))
            .Order()
            .ToArray();
    }

    // Decodes head/helm and every outfit's suit/boot into texOut as head.png, helm.png, suit<N>.png and
    // boot<N>.png, brightened (*2) like the board skins to undo the PS2 half-bright store. Decoding goes
    // through a fresh scratch folder so TextureFinish runs exactly once per file even when texOut already
    // holds a previous run's finished set. Returns the file names written.
    static HashSet<string> DecodeTextures(string textureDir, string name, int[] outfits, string texOut)
    {
        var sources = new List<(string Ssh, string Png)>
        {
            ($"{name}_head.ssh", "head.png"),
            ($"{name}_helm.ssh", "helm.png"),
        };
        foreach (int n in outfits)
        {
            sources.Add(($"{name}{n}_suit.ssh", $"suit{n}.png"));
            sources.Add(($"{name}{n}_boot.ssh", $"boot{n}.png"));
        }

        string scratch = Path.Combine(Path.GetTempPath(), "snowknife_ridertex_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(scratch);
        var written = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach (var (ssh, png) in sources)
            {
                string src = Path.Combine(textureDir, ssh);
                if (!File.Exists(src)) continue;
                try
                {
                    var shape = new OldShapeHandler();
                    shape.LoadShape(src);
                    if (shape.ShapeImages.Count == 0) continue;
                    shape.BrightenImage(0);
                    shape.ExtractSingleImage(Path.Combine(scratch, png), 0);
                    written.Add(png);
                }
                catch (Exception ex) { Log.Error($"    skip {ssh}: {ex.Message}"); }
            }
            TextureFinish.FinishDir(scratch);
            foreach (string png in written)
                File.Copy(Path.Combine(scratch, png), Path.Combine(texOut, png), overwrite: true);
        }
        finally { try { Directory.Delete(scratch, true); } catch { } }
        return written;
    }

    /// <summary>
    /// Builds the skinned scene from a combiner that has run <c>StartReassignMeshCharacter</c>. Each
    /// non-shadow sub-model becomes its own mesh (body, head, face, eyes, goggles) bound to one shared
    /// skeleton. <paramref name="textures"/> maps a part (<see cref="Parts"/>) to the PNG its three finishes
    /// use; a part without one stays plain grey.
    /// </summary>
    internal static ModelRoot BuildModel(TrickyPS2ModelCombiner combiner, IReadOnlyDictionary<string, string> textures)
    {
        var materials = new List<MaterialBuilder>();
        foreach (string part in Parts)
        {
            ImageBuilder? image = textures.TryGetValue(part, out string? png)
                ? ImageBuilder.From(new MemoryImage(File.ReadAllBytes(png)), part)
                : null;
            foreach (string finish in Finishes)
            {
                // Base is matte; the gloss and environment-mapped passes the PS2 drew on top read as shinier.
                var (metallic, roughness) = finish switch { " gloss" => (0f, 0.4f), " envr" => (0.6f, 0.3f), _ => (0f, 0.9f) };
                var material = new MaterialBuilder(part + finish)
                    .WithDoubleSide(true)
                    .WithMetallicRoughnessShader()
                    .WithMetallicRoughness(metallic, roughness);
                material = image != null ? material.WithBaseColor(image) : material.WithBaseColor(new Vector4(0.6f, 0.6f, 0.6f, 1f));
                materials.Add(material);
            }
        }

        var visible = combiner.reassignedMesh.Where(m => !m.ShadowModel && m.faces is { Count: > 0 }).ToList();
        float floor = visible.SelectMany(m => m.faces).Select(f => MathF.Min(f.V1.Z, MathF.Min(f.V2.Z, f.V3.Z)))
            .DefaultIfEmpty(0f).Min();
        var lift = new Vector3(0f, 0f, -floor);

        NodeBuilder[] joints = BuildSkeleton(combiner.bones, lift);

        var scene = new SceneBuilder();
        foreach (var sub in visible)
        {
            var mesh = new MeshBuilder<VertexPositionNormal, VertexTexture1, VertexJoints4>(sub.MeshName.Trim());
            foreach (var face in sub.faces)
            {
                var material = materials[face.MaterialID >= 0 && face.MaterialID < materials.Count ? face.MaterialID : 0];
                mesh.UsePrimitive(material).AddTriangle(
                    Vertex(face.V1 + lift, face.Normal1, face.UV1, face.Weight1),
                    Vertex(face.V2 + lift, face.Normal2, face.UV2, face.Weight2),
                    Vertex(face.V3 + lift, face.Normal3, face.UV3, face.Weight3));
            }
            scene.AddSkinnedMesh(mesh, Matrix4x4.Identity, joints);
        }
        return scene.ToGltf2();
    }

    // One bone per node, parents before children (the combiner's order). A root bone's local transform also
    // carries the axis swap and the floor lift, so every descendant lands in glTF space without being touched;
    // every bone's translation is scaled to metres. Rotations follow the library's own reading of the stored
    // radians (negated, then roll-pitch-yaw).
    static NodeBuilder[] BuildSkeleton(List<TrickyPS2MPF.BoneData> bones, Vector3 lift)
    {
        var joints = new NodeBuilder[bones.Count];
        for (int i = 0; i < bones.Count; i++)
        {
            var bone = bones[i];
            string boneName = (bone.BoneName ?? "").Trim();
            if (boneName.Length == 0) boneName = "bone" + i;
            Quaternion rotation = EulerToQuaternion(-bone.Radians);
            Vector3 translation = bone.Position;

            NodeBuilder node;
            if (bone.ParentBone >= 0 && bone.ParentBone < i)
                node = joints[bone.ParentBone].CreateNode(boneName);
            else
            {
                if (bone.ParentBone >= i) Log.Info($"    bone '{boneName}' names a later parent; kept as a root.");
                node = new NodeBuilder(boneName);
                rotation = AxisSwap * rotation;
                translation = ToGltf(translation + lift);
            }
            joints[i] = node.WithLocalTranslation(translation * MetresPerUnit).WithLocalRotation(Quaternion.Normalize(rotation));
        }
        return joints;
    }

    static (VertexPositionNormal, VertexTexture1, VertexJoints4) Vertex(Vector3 position, Vector3 normal, Vector4 uv,
                                                                      TrickyPS2MPF.BoneWeightHeader weights)
    {
        Vector3 n = ToGltf(normal);
        n = n.LengthSquared() > 1e-12f ? Vector3.Normalize(n) : Vector3.UnitY;
        var joints = new VertexJoints4();
        joints.SetBindings(NormalizeWeights(
            (weights.boneWeights ?? []).Select(w => (w.BoneID, (float)w.Weight))));
        return (new VertexPositionNormal(ToGltf(position) * MetresPerUnit, n), new VertexTexture1(new Vector2(uv.X, uv.Y)), joints);
    }

    /// <summary>
    /// The four strongest influences, duplicates merged, summing to 1. The file stores integer weights; a
    /// vertex with none at all is bound rigidly to joint 0 rather than collapsing to the origin.
    /// </summary>
    internal static (int Joint, float Weight)[] NormalizeWeights(IEnumerable<(int Joint, float Weight)> raw)
    {
        var strongest = raw
            .Where(w => w.Joint >= 0 && w.Weight > 0f)
            .GroupBy(w => w.Joint)
            .Select(g => (Joint: g.Key, Weight: g.Sum(w => w.Weight)))
            .OrderByDescending(w => w.Weight)
            .ThenBy(w => w.Joint)
            .Take(4)
            .ToArray();
        float total = strongest.Sum(w => w.Weight);
        return total > 0f ? strongest.Select(w => (w.Joint, w.Weight / total)).ToArray() : [(0, 1f)];
    }

    /// <summary>The library's Euler convention (roll about X, then pitch about Y, then yaw about Z).</summary>
    internal static Quaternion EulerToQuaternion(Vector3 euler)
    {
        float cy = MathF.Cos(euler.Z * 0.5f), sy = MathF.Sin(euler.Z * 0.5f);
        float cp = MathF.Cos(euler.Y * 0.5f), sp = MathF.Sin(euler.Y * 0.5f);
        float cr = MathF.Cos(euler.X * 0.5f), sr = MathF.Sin(euler.X * 0.5f);
        return new Quaternion(
            sr * cp * cy - cr * sp * sy,
            cr * sp * cy + sr * cp * sy,
            cr * cp * sy - sr * sp * cy,
            cr * cp * cy + sr * sp * sy);
    }
}
