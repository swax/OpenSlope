#if UNITY_EDITOR
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Terrain geometry + baked lightmap, loaded from the snowknife BUNDLE (gltf/terrain.glb +
    // LightmapAtlas.png). All the heavy, engine-agnostic work - Bezier tessellation, exact analytic normals,
    // seam welding, lightmap atlas + UV1, vertex-colour luminance, per-SurfaceType collision split - happens
    // once in snowknife and ships in the glb; this just turns that into a Unity Mesh + materials +
    // colliders. Materials come from MaterialFactory. The importer reads the pre-tessellated bundle rather than
    // tessellating Patches.json itself (the bundle is required - see LevelImporter). See docs/unity/002 (geometry), docs/unity/007 (lightmap), Snowknife docs/034
    // (the bundle pipeline + coordinate convention).
    public class TerrainBuilder
    {
        readonly ImportConfig _cfg;
        readonly MaterialFactory _materials;

        public TerrainBuilder(ImportConfig cfg, MaterialFactory materials)
        {
            _cfg = cfg; _materials = materials;
        }

        string Abs(string rel) => Path.Combine(Path.GetDirectoryName(Application.dataPath), rel);

        public void Build(Transform parent)
        {
            string glb = Abs(_cfg.LevelFolder + "/gltf/terrain.glb");
            if (!File.Exists(glb)) { Debug.LogError("OpenSlope: gltf/terrain.glb not found - run `snowknife gltf`."); return; }

            var nodes = GlbMeshLoader.Load(glb, _cfg.WorldScale);
            Texture2D atlas = LoadAtlas(out bool hasLightmap);

            var render = nodes.Find(n => n.Name == "Terrain");
            if (render == null) { Debug.LogError("OpenSlope: terrain.glb has no 'Terrain' mesh."); return; }

            // One texture-array cache across both render meshes: they tessellate the same patches with the same
            // materials, so the HD collapse reuses the base mesh's arrays instead of baking duplicate slices.
            var texArrShared = new TextureArrayPacker.SharedGroups();
            BuildRenderNode(parent, render, "Terrain", "OpenSlope_Terrain", _cfg.TerrainMeshPath, atlas, hasLightmap, texArrShared);

            // The render-only high-detail swap ("TerrainHD", denser tessellation of the identical surface). Imported
            // INACTIVE: the Performance Board owns the per-player swap at runtime (docs/vrchat/046); collision and the
            // analytic patch contact are untouched by which render mesh is showing.
            var hd = nodes.Find(n => n.Name == "TerrainHD");
            if (hd != null)
            {
                var hdGo = BuildRenderNode(parent, hd, "TerrainHD", "OpenSlope_TerrainHD", _cfg.TerrainHdMeshPath, atlas, hasLightmap, texArrShared);
                if (hdGo != null) hdGo.SetActive(false);
            }

            if (_cfg.TerrainColliders) BuildCollision(parent, nodes);
        }

        // One render node -> one child GameObject: combine the per-material primitives into one mesh with a submesh
        // each (shared vertex buffer), then optionally collapse the per-texture submeshes into Texture2DArray draws
        // (the terrain is a single static mesh with no flipbook/scroll, so it folds cleanly to ~1 submesh).
        GameObject BuildRenderNode(Transform parent, GlbMeshLoader.Node node, string goName, string meshName,
                                   string meshPath, Texture2D atlas, bool hasLightmap,
                                   TextureArrayPacker.SharedGroups texArrShared)
        {
            var verts = new List<Vector3>(); var norms = new List<Vector3>();
            var uv0 = new List<Vector2>(); var uv1 = new List<Vector2>(); var cols = new List<Color>();
            var subTris = new List<int[]>(); var mats = new Material[node.Prims.Count];
            for (int s = 0; s < node.Prims.Count; s++)
            {
                var prim = node.Prims[s];
                int b = verts.Count;
                verts.AddRange(prim.Positions);
                norms.AddRange(prim.Normals);
                if (prim.Uv0 != null) uv0.AddRange(prim.Uv0);
                if (prim.Uv1 != null) uv1.AddRange(prim.Uv1);
                if (prim.Colors != null) cols.AddRange(prim.Colors);
                var tris = new int[prim.Indices.Length];
                for (int i = 0; i < tris.Length; i++) tris[i] = prim.Indices[i] + b;
                subTris.Add(tris);
                string texFile = prim.Material == "__untextured" ? null : prim.Material;
                mats[s] = _materials.BuildTerrain(texFile, hasLightmap, atlas);
            }

            var mesh = new Mesh { name = meshName, indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
            mesh.SetVertices(verts);
            mesh.SetNormals(norms);
            if (uv0.Count == verts.Count) mesh.SetUVs(0, uv0);
            if (uv1.Count == verts.Count) mesh.SetUVs(1, uv1);
            if (cols.Count == verts.Count) mesh.colors = cols.ToArray();
            mesh.subMeshCount = subTris.Count;
            for (int s = 0; s < subTris.Count; s++) mesh.SetTriangles(subTris[s], s);
            mesh.RecalculateBounds();

            AssetDatabase.DeleteAsset(meshPath);
            AssetDatabase.CreateAsset(mesh, meshPath);

            var prevT = parent.Find(goName);
            if (prevT != null) Object.DestroyImmediate(prevT.gameObject);
            var go = new GameObject(goName);
            go.transform.SetParent(parent, false);
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            var rend = go.AddComponent<MeshRenderer>();
            rend.sharedMaterials = mats;

            string arrInfo = "";
            if (_cfg.BatchDrawCalls)
            {
                var res = TextureArrayPacker.Collapse(rend, _cfg.MatFolder + "/TexArrays", markBatchingStatic: false, texArrShared);
                arrInfo = $", batched {res.subBefore}->{res.subAfter} submeshes ({res.arraysBuilt} array(s)" +
                          (res.arraysReused > 0 ? $", {res.arraysReused} reused" : "") + ")";
            }

            Debug.Log($"OpenSlope: {goName} loaded from bundle - {verts.Count:n0} verts, {subTris.Count} submeshes" +
                      (hasLightmap ? " (per-pixel lightmap atlas)" : " (no lightmap)") + arrInfo + ".");
            return go;
        }

        // One MeshCollider per SurfaceType under parent/TerrainCollision/Surf_<type>, from the glb's
        // TerrainCol_<type> meshes (compact, welded normals carried for the board). the surface detector raycasts
        // down and reads which Surf_<type> it hit; the no-collision SurfaceType is excluded by snowknife.
        void BuildCollision(Transform parent, List<GlbMeshLoader.Node> nodes)
        {
            var prev = parent.Find("TerrainCollision");
            if (prev != null) Object.DestroyImmediate(prev.gameObject);
            var colRoot = new GameObject("TerrainCollision");
            colRoot.transform.SetParent(parent, false);

            int groups = 0, totalTris = 0;
            foreach (var node in nodes)
            {
                if (!node.Name.StartsWith("TerrainCol_") || node.Prims.Count == 0) continue;
                string typeStr = node.Name.Substring("TerrainCol_".Length);
                var prim = node.Prims[0];

                var m = new Mesh { name = node.Name };
                if (prim.Positions.Length > 65000) m.indexFormat = UnityEngine.Rendering.IndexFormat.UInt32;
                m.vertices = prim.Positions;
                if (prim.Normals != null && prim.Normals.Length == prim.Positions.Length) m.normals = prim.Normals;
                m.SetTriangles(prim.Indices, 0);
                m.RecalculateBounds();

                string path = _cfg.LevelFolder + "/TerrainCol_" + typeStr + ".mesh";
                AssetDatabase.DeleteAsset(path);
                AssetDatabase.CreateAsset(m, path);

                var go = new GameObject("Surf_" + typeStr);
                go.transform.SetParent(colRoot.transform, false);
                go.AddComponent<MeshCollider>().sharedMesh = m;
                groups++; totalTris += prim.Indices.Length / 3;
            }
            Debug.Log($"OpenSlope: terrain collision from bundle -> {groups} per-SurfaceType colliders, {totalTris} tris.");
        }

        Texture2D LoadAtlas(out bool hasLightmap)
        {
            hasLightmap = false;
            string png = Abs(_cfg.LevelFolder + "/gltf/LightmapAtlas.png");
            if (!File.Exists(png)) return null;
            var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false, linear: true)
                { name = "OpenSlope_LightmapAtlas", filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
            if (!tex.LoadImage(File.ReadAllBytes(png))) { Object.DestroyImmediate(tex); return null; }
            tex.Apply(false, false);
            AssetDatabase.DeleteAsset(_cfg.LightmapAtlasPath);
            AssetDatabase.CreateAsset(tex, _cfg.LightmapAtlasPath);
            hasLightmap = true;
            return tex;
        }
    }
}
#endif
