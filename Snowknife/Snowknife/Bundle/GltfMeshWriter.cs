using System.Numerics;
using SharpGLTF.Geometry;
using SharpGLTF.Geometry.VertexTypes;
using SharpGLTF.Materials;
using SharpGLTF.Scenes;

namespace Snowknife.Bundle;

/// <summary>
/// Writes a glTF binary (.glb) for the SSX bundle in STANDARD glTF space: right-handed,
/// Y-up, metres - so the file opens upright and correctly scaled in Blender (and any other
/// glTF tool) with no extra import transform.
///
/// Geometry is handed in as "SSX mesh space": raw SSX units (centimetres), with X already
/// negated and Z up - i.e. exactly the vertices the Unity importer's Mesh uses
/// (TerrainBuilder/PropBuilder negate X and rely on a -90 deg X / 0.01 root). This
/// writer applies the single canonical mesh-space -> glTF transform:
///
///     pos_gltf = (x, z, y) * scale          // Y/Z swap (Z-up -> Y-up, flips handedness), cm -> m
///     nrm_gltf = (x, z, y)                   // same swap, unit length preserved
///
/// and orients every emitted triangle CCW about its (averaged) normal, glTF's front-face
/// convention. The materials are marked double-sided, so a patch whose stored winding is
/// reversed still draws in a single-sided viewer (Blender, plain glTF tools). The material is a
/// name + white unlit base colour only - it carries no texture; the diffuse image is bound
/// downstream from manifest.json (the Unity importer), so a plain glTF consumer gets correct
/// geometry / normals / UVs / vertex-colour luminance but untextured surfaces.
///
/// The matching Unity loader (GlbMeshLoader) applies the inverse - (x, z, y) * (1/scale) -
/// to return to mesh space, so a bundle mesh dropped under the importer's Level(-90X, 0.01)
/// child lands in the same world position the importer's own Mesh construction would place it. See docs.
/// </summary>
public sealed class GltfMeshWriter
{
    public sealed class Prim
    {
        public string Material = "__untextured";
        public List<Vector3> Positions = new();   // mesh space
        public List<Vector3> Normals   = new();    // mesh space, unit
        public List<Vector2>? Uv0;                 // top-left origin (glTF native)
        public List<Vector2>? Uv1;                 // top-left origin (lightmap atlas)
        public List<Vector4>? Colors;              // RGBA 0..1 (vertex-colour lightmap)
        public List<int> Indices = new();          // into the lists above
    }

    public sealed class Node
    {
        public string Name = "Node";
        public List<Prim> Prims = new();
    }

    readonly float _scale;
    public GltfMeshWriter(float scale) { _scale = scale; }

    // mesh space (X-neg, Z-up, cm) -> glTF (Y-up, RH, m): swap Y/Z, apply scale to position.
    Vector3 P(Vector3 m) => new(m.X * _scale, m.Z * _scale, m.Y * _scale);
    static Vector3 N(Vector3 m) => new(m.X, m.Z, m.Y);

    public void Save(string path, IReadOnlyList<Node> nodes)
    {
        var scene = new SceneBuilder();
        foreach (var node in nodes)
        {
            bool rich = node.Prims.Exists(p => p.Uv0 != null || p.Colors != null);
            bool hasNorm = node.Prims.Exists(p => p.Normals.Count > 0);
            if (rich) AddRichMesh(scene, node);
            else if (hasNorm) AddPlainMesh(scene, node);
            else AddPosOnlyMesh(scene, node);   // collision meshes: no normals, keep winding as-is (double-sided)
        }
        var model = scene.ToGltf2();
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        model.SaveGLB(path);
    }

    // Position + Normal + Colour + 2 UVs (terrain/props render meshes).
    void AddRichMesh(SceneBuilder scene, Node node)
    {
        var mesh = new MeshBuilder<VertexPositionNormal, VertexColor1Texture2, VertexEmpty>(node.Name);
        foreach (var prim in node.Prims)
        {
            var mat = new MaterialBuilder(prim.Material).WithUnlitShader()
                .WithChannelParam(KnownChannel.BaseColor, KnownProperty.RGBA, new Vector4(1, 1, 1, 1));
            mat.DoubleSided = true;   // baked shell viewed from the ride side; draw both faces so any reversed-
                                      // winding patch stays visible in a single-sided viewer (Unity uses its own material)
            var pb = mesh.UsePrimitive(mat);
            for (int t = 0; t + 2 < prim.Indices.Count; t += 3)
            {
                int i0 = prim.Indices[t], i1 = prim.Indices[t + 1], i2 = prim.Indices[t + 2];
                OrientCcw(prim, i0, ref i1, ref i2);
                pb.AddTriangle(RichVert(prim, i0), RichVert(prim, i1), RichVert(prim, i2));
            }
        }
        scene.AddRigidMesh(mesh, Matrix4x4.Identity);
    }

    // Position + Normal only (collision meshes).
    void AddPlainMesh(SceneBuilder scene, Node node)
    {
        var mesh = new MeshBuilder<VertexPositionNormal, VertexEmpty, VertexEmpty>(node.Name);
        foreach (var prim in node.Prims)
        {
            var mat = new MaterialBuilder(prim.Material).WithUnlitShader();
            mat.DoubleSided = true;   // double-sided, matching these meshes' winding-agnostic intent
            var pb = mesh.UsePrimitive(mat);
            for (int t = 0; t + 2 < prim.Indices.Count; t += 3)
            {
                int i0 = prim.Indices[t], i1 = prim.Indices[t + 1], i2 = prim.Indices[t + 2];
                OrientCcw(prim, i0, ref i1, ref i2);
                pb.AddTriangle(
                    new VertexBuilder<VertexPositionNormal, VertexEmpty, VertexEmpty>(new VertexPositionNormal(P(prim.Positions[i0]), N(prim.Normals[i0]))),
                    new VertexBuilder<VertexPositionNormal, VertexEmpty, VertexEmpty>(new VertexPositionNormal(P(prim.Positions[i1]), N(prim.Normals[i1]))),
                    new VertexBuilder<VertexPositionNormal, VertexEmpty, VertexEmpty>(new VertexPositionNormal(P(prim.Positions[i2]), N(prim.Normals[i2]))));
            }
        }
        scene.AddRigidMesh(mesh, Matrix4x4.Identity);
    }

    // Position only (collision proxy meshes): no normals/uv, triangles emitted exactly as given so the
    // double-sided winding the caller baked in is preserved (a MeshCollider needs no normals).
    void AddPosOnlyMesh(SceneBuilder scene, Node node)
    {
        var mesh = new MeshBuilder<VertexPosition, VertexEmpty, VertexEmpty>(node.Name);
        foreach (var prim in node.Prims)
        {
            var mat = new MaterialBuilder(prim.Material).WithUnlitShader();
            mat.DoubleSided = true;   // double-sided, matching the winding kept as-is for the collision proxy
            var pb = mesh.UsePrimitive(mat);
            for (int t = 0; t + 2 < prim.Indices.Count; t += 3)
                pb.AddTriangle(
                    new VertexBuilder<VertexPosition, VertexEmpty, VertexEmpty>(new VertexPosition(P(prim.Positions[prim.Indices[t]]))),
                    new VertexBuilder<VertexPosition, VertexEmpty, VertexEmpty>(new VertexPosition(P(prim.Positions[prim.Indices[t + 1]]))),
                    new VertexBuilder<VertexPosition, VertexEmpty, VertexEmpty>(new VertexPosition(P(prim.Positions[prim.Indices[t + 2]]))));
        }
        scene.AddRigidMesh(mesh, Matrix4x4.Identity);
    }

    VertexBuilder<VertexPositionNormal, VertexColor1Texture2, VertexEmpty> RichVert(Prim prim, int i)
    {
        var geo = new VertexPositionNormal(P(prim.Positions[i]), N(prim.Normals[i]));
        var col = prim.Colors != null ? prim.Colors[i] : new Vector4(1, 1, 1, 1);
        var uv0 = prim.Uv0 != null ? prim.Uv0[i] : Vector2.Zero;
        var uv1 = prim.Uv1 != null ? prim.Uv1[i] : Vector2.Zero;
        return new VertexBuilder<VertexPositionNormal, VertexColor1Texture2, VertexEmpty>(geo, new VertexColor1Texture2(col, uv0, uv1));
    }

    // Make triangle (i0,i1,i2) wind CCW about its averaged normal in glTF space (glTF front-face),
    // by swapping i1/i2 when the geometric face normal opposes the shading normal.
    void OrientCcw(Prim prim, int i0, ref int i1, ref int i2)
    {
        Vector3 p0 = P(prim.Positions[i0]), p1 = P(prim.Positions[i1]), p2 = P(prim.Positions[i2]);
        Vector3 face = Vector3.Cross(p1 - p0, p2 - p0);
        Vector3 shade = N(prim.Normals[i0]) + N(prim.Normals[i1]) + N(prim.Normals[i2]);
        if (Vector3.Dot(face, shade) < 0f) (i1, i2) = (i2, i1);
    }
}
