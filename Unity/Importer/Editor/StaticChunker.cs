#if UNITY_EDITOR
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Spatial CHUNKING for the combined static "Props" / "Terrain" meshes - the real FPS fix.
    //
    // The original SSX engine kept placed objects in a ~100 m spatial grid and each frame drew only
    // (cells within ~300 m camera range) INTERSECT (view frustum) - terrain patches were per-patch frustum-culled +
    // distance-LOD'd too (Trailmap specs/400-rendering). Our importer does the OPPOSITE: it merges the entire
    // course into ONE renderer (Props ~875k tris, Terrain ~123k) whose bounding box spans the whole map, so Unity's
    // frustum culling can never drop any of it - the GPU chews the whole course every frame, everywhere. That single
    // over-merge is what makes framerate tank in dense areas and recover in the air (view-dependent overdraw on a
    // fixed ~1M-tri baseline), and why the range-culler (which toggles per-OBJECT renderers) never touched it.
    //
    // This splits one combined renderer's STATIC triangles into a grid of per-cell child renderers (sharing the same
    // collapsed Texture2DArray materials - no texture duplication), each with a TIGHT bounds, so Unity frustum-culls
    // off-screen cells for free and ObjectCuller can ALSO range-cull distant ones - exactly the engine's
    // "(grid cells in range) INTERSECT frustum". FLIPBOOK submeshes (crowd/signs/LCD) are LEFT in the source renderer
    // (emptied of the static submeshes) so FlipbookAnimator's (renderer, slot) wiring stays valid - see IsAnimated for
    // why UV-scroll submeshes are NOT kept back and do get chunked.
    //
    // Pure spatial re-bucketing of EXISTING triangles - no re-tessellation, identical geometry - so it can't introduce
    // cracks/seams. The canonical full mesh asset is never overwritten, so the pass is re-runnable (e.g. to retune cell
    // size): it reads the canonical mesh, rebuilds the chunks + the animated-only source mesh each run.
    public static class StaticChunker
    {
        public struct Result
        {
            public int chunks;          // chunk renderers created
            public int culledStatic;    // static submeshes moved out of the source renderer
            public int keptAnimated;    // animated submeshes left in the source renderer
            public long staticTris;     // triangles relocated into chunks
            public int maxMatsPerChunk; // worst-case submesh (draw) count of a single chunk
            public string note;
        }

        // Chunk one combined-mesh renderer in place. 'cellSize' is the XZ grid cell in metres. Chunk meshes are written
        // under '<source-mesh-folder>/Chunks'. Returns the created chunk renderers via 'chunkRenderers' (for the caller to
        // hand to ObjectCuller) and a stats summary.
        public static Result Chunk(MeshRenderer mr, float cellSize, out List<MeshRenderer> chunkRenderers)
        {
            chunkRenderers = new List<MeshRenderer>();
            var res = new Result();
            var mf = mr != null ? mr.GetComponent<MeshFilter>() : null;
            if (mf == null || mf.sharedMesh == null) { res.note = "no mesh"; return res; }

            // Re-run safe: read from the CANONICAL full mesh (never the animated-only mesh a prior run may have left on
            // the renderer), and resolve it BEFORE dropping the old chunks - a failed resolve leaves the scene as it
            // found it rather than stripping the static geometry it can no longer rebuild.
            var go = mr.gameObject;
            Mesh src = ResolveCanonical(mf.sharedMesh);
            if (src == null) { res.note = "canonical mesh missing"; return res; }
            for (int c = go.transform.childCount - 1; c >= 0; c--)
            {
                var ch = go.transform.GetChild(c);
                if (ch.name.Contains("_chunk_")) Object.DestroyImmediate(ch.gameObject);
            }
            string srcDir = Path.GetDirectoryName(AssetDatabase.GetAssetPath(src)).Replace('\\', '/');
            string chunkDir = srcDir + "/Chunks";

            Material[] mats = mr.sharedMaterials;
            int subCount = Mathf.Min(src.subMeshCount, mats.Length);

            // ---- read every vertex stream once (UV2..7 are the exact three-key prop light record) ----
            var verts = new List<Vector3>(); src.GetVertices(verts);
            var norms = new List<Vector3>(); src.GetNormals(norms);
            var tans  = new List<Vector4>(); src.GetTangents(tans);
            var uv0 = new List<Vector3>(); src.GetUVs(0, uv0);
            var uv1 = new List<Vector2>(); src.GetUVs(1, uv1);
            var uv2 = new List<Vector3>(); src.GetUVs(2, uv2);
            var uv3 = new List<Vector3>(); src.GetUVs(3, uv3);
            var uv4 = new List<Vector3>(); src.GetUVs(4, uv4);
            var uv5 = new List<Vector3>(); src.GetUVs(5, uv5);
            var uv6 = new List<Vector3>(); src.GetUVs(6, uv6);
            var uv7 = new List<Vector3>(); src.GetUVs(7, uv7);
            var cols = new List<Color>(); src.GetColors(cols);
            int n = verts.Count;
            bool hasN = norms.Count == n, hasT = tans.Count == n, hasUv0 = uv0.Count == n;
            bool hasUv1 = uv1.Count == n, hasUv2 = uv2.Count == n, hasUv3 = uv3.Count == n, hasUv4 = uv4.Count == n;
            bool hasUv5 = uv5.Count == n, hasUv6 = uv6.Count == n, hasUv7 = uv7.Count == n, hasCol = cols.Count == n;

            // ---- classify submeshes: animated (flipbook / UV-scroll) stay; the rest are chunked ----
            var isAnimated = new bool[subCount];
            for (int s = 0; s < subCount; s++) isAnimated[s] = IsAnimated(mats[s]);

            // ---- bin every STATIC triangle into an XZ cell, grouped per submesh ----
            // cellKey -> (submesh -> triangle vertex-index list). Triangles are world-space already (Level at origin),
            // so the renderer's localToWorld maps mesh verts to world; bin by the triangle centroid's world XZ.
            Matrix4x4 l2w = mr.transform.localToWorldMatrix;
            float inv = 1f / cellSize;
            var cells = new Dictionary<long, Dictionary<int, List<int>>>();
            for (int s = 0; s < subCount; s++)
            {
                if (isAnimated[s]) continue;
                var st = src.GetTriangles(s);
                for (int i = 0; i < st.Length; i += 3)
                {
                    int a = st[i], b = st[i + 1], cc = st[i + 2];
                    Vector3 w = l2w.MultiplyPoint3x4((verts[a] + verts[b] + verts[cc]) * (1f / 3f));
                    int cx = Mathf.FloorToInt(w.x * inv), cz = Mathf.FloorToInt(w.z * inv);
                    long key = ((long)cx << 32) ^ (uint)cz;
                    if (!cells.TryGetValue(key, out var perSub)) { perSub = new Dictionary<int, List<int>>(); cells[key] = perSub; }
                    if (!perSub.TryGetValue(s, out var list)) { list = new List<int>(); perSub[s] = list; }
                    list.Add(a); list.Add(b); list.Add(cc);
                    res.staticTris++;
                }
                res.culledStatic++;
            }
            for (int s = 0; s < subCount; s++) if (isAnimated[s]) res.keptAnimated++;

            EnsureFolder(chunkDir);

            // ---- build one child renderer per non-empty cell ----
            int ci = 0;
            foreach (var cell in cells)
            {
                var perSub = cell.Value;
                // collect the verts this cell uses, remapped tight; build a submesh per static material present
                var remap = new Dictionary<int, int>();
                var cv = new List<Vector3>(); var cn = new List<Vector3>(); var ct = new List<Vector4>();
                var c0 = new List<Vector3>(); var c1 = new List<Vector2>();
                var c2 = new List<Vector3>(); var c3 = new List<Vector3>(); var c4 = new List<Vector3>();
                var c5 = new List<Vector3>(); var c6 = new List<Vector3>(); var c7 = new List<Vector3>();
                var cc2 = new List<Color>();
                var subTris = new List<int[]>(); var subMats = new List<Material>();
                System.Func<int, int> map = (ov) =>
                {
                    if (remap.TryGetValue(ov, out int nv)) return nv;
                    nv = cv.Count; remap[ov] = nv;
                    cv.Add(verts[ov]);
                    if (hasN) cn.Add(norms[ov]);
                    if (hasT) ct.Add(tans[ov]);
                    if (hasUv0) c0.Add(uv0[ov]);
                    if (hasUv1) c1.Add(uv1[ov]);
                    if (hasUv2) c2.Add(uv2[ov]);
                    if (hasUv3) c3.Add(uv3[ov]);
                    if (hasUv4) c4.Add(uv4[ov]);
                    if (hasUv5) c5.Add(uv5[ov]);
                    if (hasUv6) c6.Add(uv6[ov]);
                    if (hasUv7) c7.Add(uv7[ov]);
                    if (hasCol) cc2.Add(cols[ov]);
                    return nv;
                };
                foreach (var kv in perSub)
                {
                    var ids = kv.Value;
                    var tris = new int[ids.Count];
                    for (int i = 0; i < ids.Count; i++) tris[i] = map(ids[i]);
                    subTris.Add(tris); subMats.Add(mats[kv.Key]);
                }
                if (subMats.Count > res.maxMatsPerChunk) res.maxMatsPerChunk = subMats.Count;

                // tight bounds center -> localize the chunk (verts relative to center, transform AT center) so the
                // renderer.bounds + transform.position the range-culler reads are the chunk's real position.
                var bMin = cv[0]; var bMax = cv[0];
                for (int i = 1; i < cv.Count; i++) { bMin = Vector3.Min(bMin, cv[i]); bMax = Vector3.Max(bMax, cv[i]); }
                Vector3 center = (bMin + bMax) * 0.5f;
                for (int i = 0; i < cv.Count; i++) cv[i] -= center;

                var cmesh = new Mesh { name = src.name + "_chunk_" + ci, indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
                cmesh.SetVertices(cv);
                if (hasN) cmesh.SetNormals(cn);
                if (hasT) cmesh.SetTangents(ct);
                if (hasUv0) cmesh.SetUVs(0, c0);
                if (hasUv1) cmesh.SetUVs(1, c1);
                if (hasUv2) cmesh.SetUVs(2, c2);
                if (hasUv3) cmesh.SetUVs(3, c3);
                if (hasUv4) cmesh.SetUVs(4, c4);
                if (hasUv5) cmesh.SetUVs(5, c5);
                if (hasUv6) cmesh.SetUVs(6, c6);
                if (hasUv7) cmesh.SetUVs(7, c7);
                if (hasCol) cmesh.SetColors(cc2);
                cmesh.subMeshCount = subTris.Count;
                for (int s = 0; s < subTris.Count; s++) cmesh.SetTriangles(subTris[s], s, calculateBounds: false);
                cmesh.RecalculateBounds();
                AssetDatabase.CreateAsset(cmesh, AssetPath(chunkDir, cmesh.name + ".asset"));

                var cgo = new GameObject(cmesh.name);
                cgo.transform.SetParent(go.transform, false);
                cgo.transform.localPosition = mr.transform.InverseTransformPoint(l2w.MultiplyPoint3x4(center));
                cgo.AddComponent<MeshFilter>().sharedMesh = cmesh;
                var cr = cgo.AddComponent<MeshRenderer>();
                cr.sharedMaterials = subMats.ToArray();
                CopyRendererSettings(mr, cr);
                chunkRenderers.Add(cr);
                ci++;
            }
            res.chunks = ci;

            // ---- rebuild the source renderer's mesh: animated submeshes only (static emptied), verts pruned. Keeps
            //      subMeshCount + the material array so the flipbook's (renderer, slot) wiring stays valid. ----
            BuildAnimatedOnly(mr, src, subCount, isAnimated, verts, norms, tans, uv0, uv1,
                              uv2, uv3, uv4, uv5, uv6, uv7, cols,
                              hasN, hasT, hasUv0, hasUv1, hasUv2, hasUv3, hasUv4, hasUv5, hasUv6, hasUv7, hasCol, srcDir);

            AssetDatabase.SaveAssets();
            res.note = "ok";
            return res;
        }

        // The source mesh becomes "<name>_anim": every static submesh emptied, animated submeshes kept (remapped onto a
        // pruned vertex buffer). subMeshCount + the renderer's material array are unchanged. If there are NO animated
        // submeshes (e.g. Terrain), the source renderer is disabled instead (nothing left to draw).
        static void BuildAnimatedOnly(MeshRenderer mr, Mesh src, int subCount, bool[] isAnimated,
            List<Vector3> verts, List<Vector3> norms, List<Vector4> tans, List<Vector3> uv0, List<Vector2> uv1,
            List<Vector3> uv2, List<Vector3> uv3, List<Vector3> uv4, List<Vector3> uv5, List<Vector3> uv6, List<Vector3> uv7,
            List<Color> cols, bool hasN, bool hasT, bool hasUv0, bool hasUv1, bool hasUv2, bool hasUv3, bool hasUv4,
            bool hasUv5, bool hasUv6, bool hasUv7, bool hasCol, string srcDir)
        {
            bool anyAnim = false; for (int s = 0; s < subCount; s++) anyAnim |= isAnimated[s];
            var mf = mr.GetComponent<MeshFilter>();
            if (!anyAnim) { mf.sharedMesh = src; mr.enabled = false; return; } // all static -> chunks own it; hide the merged renderer

            var remap = new Dictionary<int, int>();
            var av = new List<Vector3>(); var an = new List<Vector3>(); var at = new List<Vector4>();
            var a0 = new List<Vector3>(); var a1 = new List<Vector2>();
            var a2 = new List<Vector3>(); var a3 = new List<Vector3>(); var a4 = new List<Vector3>();
            var a5 = new List<Vector3>(); var a6 = new List<Vector3>(); var a7 = new List<Vector3>();
            var acl = new List<Color>();
            System.Func<int, int> map = (ov) =>
            {
                if (remap.TryGetValue(ov, out int nv)) return nv;
                nv = av.Count; remap[ov] = nv;
                av.Add(verts[ov]);
                if (hasN) an.Add(norms[ov]);
                if (hasT) at.Add(tans[ov]);
                if (hasUv0) a0.Add(uv0[ov]);
                if (hasUv1) a1.Add(uv1[ov]);
                if (hasUv2) a2.Add(uv2[ov]);
                if (hasUv3) a3.Add(uv3[ov]);
                if (hasUv4) a4.Add(uv4[ov]);
                if (hasUv5) a5.Add(uv5[ov]);
                if (hasUv6) a6.Add(uv6[ov]);
                if (hasUv7) a7.Add(uv7[ov]);
                if (hasCol) acl.Add(cols[ov]);
                return nv;
            };
            var subTris = new List<int[]>();
            for (int s = 0; s < subCount; s++)
            {
                if (!isAnimated[s]) { subTris.Add(System.Array.Empty<int>()); continue; }
                var st = src.GetTriangles(s);
                var tris = new int[st.Length];
                for (int i = 0; i < st.Length; i++) tris[i] = map(st[i]);
                subTris.Add(tris);
            }

            var anim = new Mesh { name = src.name + "_anim", indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
            anim.SetVertices(av);
            if (hasN) anim.SetNormals(an);
            if (hasT) anim.SetTangents(at);
            if (hasUv0) anim.SetUVs(0, a0);
            if (hasUv1) anim.SetUVs(1, a1);
            if (hasUv2) anim.SetUVs(2, a2);
            if (hasUv3) anim.SetUVs(3, a3);
            if (hasUv4) anim.SetUVs(4, a4);
            if (hasUv5) anim.SetUVs(5, a5);
            if (hasUv6) anim.SetUVs(6, a6);
            if (hasUv7) anim.SetUVs(7, a7);
            if (hasCol) anim.SetColors(acl);
            anim.subMeshCount = subTris.Count;
            for (int s = 0; s < subTris.Count; s++) anim.SetTriangles(subTris[s], s, calculateBounds: false);
            anim.RecalculateBounds();
            AssetDatabase.CreateAsset(anim, AssetPath(srcDir, anim.name + ".asset"));
            mf.sharedMesh = anim;
            mr.enabled = true;
        }

        // If the renderer is already pointing at a prior run's "_anim" mesh, load the canonical full mesh (same folder,
        // name without the suffix) so re-runs read the intact source; else the mesh IS the canonical one. The extension
        // depends on who wrote the source: the draw-call packer emits "Props_TexArr.asset", while the importer's own
        // merged mesh (BatchDrawCalls off) is "Props.mesh".
        static Mesh ResolveCanonical(Mesh m)
        {
            if (m == null || !m.name.EndsWith("_anim")) return m;
            string path = AssetDatabase.GetAssetPath(m);
            string dir = Path.GetDirectoryName(path).Replace('\\', '/');
            string baseName = m.name.Substring(0, m.name.Length - "_anim".Length);
            foreach (var ext in new[] { ".asset", ".mesh" })
            {
                var hit = AssetDatabase.LoadAssetAtPath<Mesh>(dir + "/" + baseName + ext);
                if (hit != null) return hit;
            }
            return null;
        }

        // "Animated" here means ONLY "something outside this mesh holds a (renderer, submesh-slot) reference into it",
        // which is what forces a submesh to stay on the source renderer. That is true of flipbooks alone:
        // FlipbookAnimator stores Renderers[]/Slots[] pairs and BatchDrawCallsMenu.RemapFlipbook re-points them.
        //
        // UV scroll is NOT held back, because it has no CPU-side wiring at all - UvScroll.hlsl derives the offset from
        // _Time and the material's own _ScrollSpeed, so a scroll submesh behaves identically wherever its triangles
        // live, and TextureArrayPacker already refuses to fold scroll materials into a shared array (per-material
        // speed). Held back, they would strand on the map-spanning source renderer, which is never frustum-culled and
        // is not registered with ObjectCuller - on Aloha that is 12 submeshes (11 of them Queue=3000) submitted from
        // everywhere on the course. Chunking them keeps both culls; the material and its speed are untouched.
        static bool IsAnimated(Material m)
        {
            if (m == null) return false;
            return m.name != null && m.name.StartsWith("flip_");
        }

        static void CopyRendererSettings(MeshRenderer from, MeshRenderer to)
        {
            to.shadowCastingMode = from.shadowCastingMode;
            to.receiveShadows = from.receiveShadows;
            to.lightProbeUsage = from.lightProbeUsage;
            to.reflectionProbeUsage = from.reflectionProbeUsage;
            to.motionVectorGenerationMode = from.motionVectorGenerationMode;
            to.allowOcclusionWhenDynamic = from.allowOcclusionWhenDynamic;
            GameObjectUtility.SetStaticEditorFlags(to.gameObject, GameObjectUtility.GetStaticEditorFlags(from.gameObject));
        }

        static void EnsureFolder(string dir)
        {
            if (AssetDatabase.IsValidFolder(dir)) return;
            Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(Application.dataPath), dir));
            AssetDatabase.Refresh();
        }
        static string AssetPath(string dir, string file)
        {
            AssetDatabase.DeleteAsset(dir + "/" + file);
            return dir + "/" + file;
        }
    }
}
#endif
