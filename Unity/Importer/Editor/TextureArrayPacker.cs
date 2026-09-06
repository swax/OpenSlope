#if UNITY_EDITOR
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Draw-call reduction for the combined "Props" / "Terrain" meshes (the FPS investigation found those two
    // single renderers carry 50-80 submeshes EACH - one per source texture - and every visible submesh is a
    // SetPass + draw, which pins the Quest CPU while the GPU idles).
    //
    // The SSX textures TILE (their UVs run past [0,1]), so a packed rect-atlas can't hold them - a tiled tile
    // would bleed into its neighbours. Instead we stack each group's textures as the slices of a Texture2DArray
    // (every slice is a full, independently-wrapping texture, so the tiling UVs still repeat correctly) and bake
    // the per-vertex slice index into UV0.z. The OpenSlope unlit shader's _TEXARRAY path samples UNITY_SAMPLE_TEX2DARRAY by that
    // slice, so ONE material + ONE submesh replaces N per-texture submeshes (N SetPass calls -> 1).
    //
    // Submeshes are grouped by RENDER-CONFIG (cutout/blend/opaque + _LIGHTMAP/_PROPLIGHT/_DIRLIGHT/_LIGHTMAP_GS)
    // and by TEXTURE size+format (a Texture2DArray needs uniform slices); each group collapses to one draw. Slices
    // are built with Graphics.CopyTexture, which is GPU-side and works on COMPRESSED, NON-READABLE textures and
    // in whatever format the active build target imported them (DXT on PC, ASTC on Android) - so the array tracks
    // the platform automatically. Submeshes we can't safely merge are LEFT ALONE: flipbook materials (they swap
    // _MainTex per frame), UV-scroll materials (per-material speed), and any group whose CopyTexture fails.
    public static class TextureArrayPacker
    {
        public struct Result
        {
            public int subBefore, subAfter, arraysBuilt, arraysReused, mergedNoArray, kept;
            public string note;
            public int[] oldToNew;   // original submesh index -> new submesh index (for flip/collider slot remap)
        }

        // Cross-Collapse array/material reuse: two renderers whose submesh groups resolve to the same render config
        // AND the same ordered texture set (e.g. the "Terrain" and "TerrainHD" meshes, tessellations of the same
        // patches) share ONE Texture2DArray + material instead of baking duplicate slices. Keyed by the full group
        // key + the ordered slice texture paths, so a partial overlap safely falls back to building its own array.
        public sealed class SharedGroups
        {
            internal readonly Dictionary<string, Material> Mats = new Dictionary<string, Material>();
        }

        // Collapse one combined-mesh renderer in place. Builds new mesh + array/material assets under 'outDir' and
        // assigns them to 'mr' (the source mesh asset is left untouched). Returns a before/after summary. Pass the
        // same 'shared' cache across calls to reuse identical arrays/materials between renderers.
        public static Result Collapse(MeshRenderer mr, string outDir, bool markBatchingStatic, SharedGroups shared = null)
        {
            var res = new Result();
            var mf = mr != null ? mr.GetComponent<MeshFilter>() : null;
            if (mf == null || mf.sharedMesh == null) { res.note = "no mesh"; return res; }
            Mesh src = mf.sharedMesh;
            Material[] mats = mr.sharedMaterials;
            int subCount = Mathf.Min(src.subMeshCount, mats.Length);
            res.subBefore = subCount;
            res.oldToNew = new int[subCount];
            for (int i = 0; i < subCount; i++) res.oldToNew[i] = -1;
            EnsureFolder(outDir);
            // Namespace the array/material asset names by the source mesh so collapsing Terrain AND Props into the
            // same folder can't clobber each other (without this prefix both would emit "arr_0" and the second run would delete the first's).
            string prefix = src.name;

            // Read the source vertex streams once.
            var verts = new List<Vector3>(); src.GetVertices(verts);
            var norms = new List<Vector3>(); src.GetNormals(norms);
            var uv0 = new List<Vector2>(); src.GetUVs(0, uv0);
            var uv1 = new List<Vector2>(); src.GetUVs(1, uv1);
            // Exact moving-prop record: keys in UV2..4, fixed world directions in UV5..7. Preserve the complete
            // payload when texture-array batching duplicates/remaps vertices; dropping any tail stream darkens or
            // reorients only the batched material variant, which is especially hard to diagnose.
            var uv2 = new List<Vector3>(); src.GetUVs(2, uv2);
            var uv3 = new List<Vector3>(); src.GetUVs(3, uv3);
            var uv4 = new List<Vector3>(); src.GetUVs(4, uv4);
            var uv5 = new List<Vector3>(); src.GetUVs(5, uv5);
            var uv6 = new List<Vector3>(); src.GetUVs(6, uv6);
            var uv7 = new List<Vector3>(); src.GetUVs(7, uv7);
            var cols = new List<Color>(); src.GetColors(cols);
            bool hasN = norms.Count == verts.Count, hasUv0 = uv0.Count == verts.Count;
            bool hasUv1 = uv1.Count == verts.Count, hasUv2 = uv2.Count == verts.Count;
            bool hasUv3 = uv3.Count == verts.Count, hasUv4 = uv4.Count == verts.Count;
            bool hasUv5 = uv5.Count == verts.Count, hasUv6 = uv6.Count == verts.Count, hasUv7 = uv7.Count == verts.Count;
            bool hasCol = cols.Count == verts.Count;

            // --- classify submeshes into merge groups ----------------------------------------------------------
            // groupKey -> submesh indices. A null key = "keep as its own submesh" (flip / scroll / no texture).
            var groups = new Dictionary<string, List<int>>();
            var keep = new List<int>();
            for (int s = 0; s < subCount; s++)
            {
                Material m = mats[s];
                var tex = m != null ? m.mainTexture as Texture2D : null;
                bool isFlip = m != null && m.name != null && m.name.StartsWith("flip_");
                // The crowd material already IS a texture-array draw (the shader computes its slice per-vertex
                // from _Time - _CROWD); its _MainTex is only an inspector preview, so never re-pack it.
                bool isCrowd = m != null && m.IsKeywordEnabled("_CROWD");
                Vector4 scroll = (m != null && m.HasProperty("_ScrollSpeed")) ? m.GetVector("_ScrollSpeed") : Vector4.zero;
                bool isScroll = scroll.sqrMagnitude > 1e-9f;
                if (m == null || tex == null || isFlip || isScroll || isCrowd) { keep.Add(s); continue; }
                string key = ConfigKey(m) + "|" + tex.width + "x" + tex.height + "|" + tex.format + "|m" + (tex.mipmapCount > 1 ? 1 : 0);
                if (!groups.TryGetValue(key, out var list)) { list = new List<int>(); groups[key] = list; }
                list.Add(s);
            }

            // --- build the new mesh: one submesh per (collapsed group) + each kept submesh ---------------------
            var newTris = new List<List<int>>();
            var newMats = new List<Material>();
            // remap (origVertex, slice) -> new vertex, so a vertex shared across slices duplicates (rare; the
            // combine appends per-prim verts so this almost never fires, but it keeps us correct if it does).
            var remap = new Dictionary<long, int>();
            var nVerts = new List<Vector3>(); var nNorm = new List<Vector3>(); var nUv0 = new List<Vector3>();
            var nUv1 = new List<Vector2>();
            var nUv2 = new List<Vector3>(); var nUv3 = new List<Vector3>(); var nUv4 = new List<Vector3>();
            var nUv5 = new List<Vector3>(); var nUv6 = new List<Vector3>(); var nUv7 = new List<Vector3>();
            var nCol = new List<Color>();

            System.Func<int, float, int> mapVert = (ov, slice) =>
            {
                long k = ((long)ov << 12) ^ (long)(slice + 0.5f);
                if (remap.TryGetValue(k, out int nv)) return nv;
                nv = nVerts.Count;
                nVerts.Add(verts[ov]);
                if (hasN) nNorm.Add(norms[ov]);
                Vector2 t = hasUv0 ? uv0[ov] : Vector2.zero;
                nUv0.Add(new Vector3(t.x, t.y, slice));
                if (hasUv1) nUv1.Add(uv1[ov]);
                if (hasUv2) nUv2.Add(uv2[ov]);
                if (hasUv3) nUv3.Add(uv3[ov]);
                if (hasUv4) nUv4.Add(uv4[ov]);
                if (hasUv5) nUv5.Add(uv5[ov]);
                if (hasUv6) nUv6.Add(uv6[ov]);
                if (hasUv7) nUv7.Add(uv7[ov]);
                if (hasCol) nCol.Add(cols[ov]);
                remap[k] = nv;
                return nv;
            };

            int groupOrdinal = 0;
            foreach (var kv in groups)
            {
                var members = kv.Value;
                // distinct textures in this group -> array slices (dedup shared textures)
                var sliceOf = new Dictionary<Texture2D, int>();   // texture -> slice (keyed by reference; portable across Unity versions)
                var slices = new List<Texture2D>();
                foreach (int s in members)
                {
                    var tex = (Texture2D)mats[s].mainTexture;
                    if (!sliceOf.ContainsKey(tex)) { sliceOf[tex] = slices.Count; slices.Add(tex); }
                }

                // A single shared texture across N submeshes: merge to one submesh with the ORIGINAL material (no
                // array needed). Two+ textures: build the array + an _TEXARRAY material - or reuse another
                // renderer's identical group from 'shared' (same slice order by construction, since the key
                // carries the ordered texture list, so the baked UV0.z slice indices line up).
                Material groupMat;
                string shareKey = null;
                if (slices.Count == 1) { groupMat = mats[members[0]]; res.mergedNoArray++; }
                else
                {
                    if (shared != null)
                    {
                        var sb = new System.Text.StringBuilder(kv.Key);
                        foreach (var t in slices) sb.Append('|').Append(AssetDatabase.GetAssetPath(t));
                        shareKey = sb.ToString();
                    }
                    if (shareKey != null && shared.Mats.TryGetValue(shareKey, out groupMat)) res.arraysReused++;
                    else
                    {
                        bool needsAlpha = mats[members[0]].IsKeywordEnabled("_CUTOUT") || mats[members[0]].renderQueue >= 3000;
                        var arr = BuildDualArrays(slices, outDir, prefix, groupOrdinal, needsAlpha);
                        if (arr == null) { foreach (int s in members) keep.Add(s); continue; } // build failed -> leave unmerged
                        groupMat = BuildArrayMaterial(mats[members[0]], arr, outDir, prefix, groupOrdinal);
                        res.arraysBuilt++;
                        if (shareKey != null) shared.Mats[shareKey] = groupMat;
                    }
                }

                var tris = new List<int>();
                foreach (int s in members)
                {
                    float slice = sliceOf[(Texture2D)mats[s].mainTexture];
                    var st = src.GetTriangles(s);
                    for (int i = 0; i < st.Length; i++) tris.Add(mapVert(st[i], slice));
                    res.oldToNew[s] = groupOrdinal;
                }
                newTris.Add(tris); newMats.Add(groupMat);
                groupOrdinal++;
            }

            // Kept submeshes (flip / scroll / no-texture / failed): copy verbatim, slice 0.
            keep.Sort();
            foreach (int s in keep)
            {
                var st = src.GetTriangles(s);
                var tris = new List<int>(st.Length);
                for (int i = 0; i < st.Length; i++) tris.Add(mapVert(st[i], 0f));
                res.oldToNew[s] = newTris.Count;
                newTris.Add(tris); newMats.Add(mats[s]);
            }
            res.kept = keep.Count;

            var mesh = new Mesh { name = src.name + "_TexArr", indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
            mesh.SetVertices(nVerts);
            if (hasN) mesh.SetNormals(nNorm);
            mesh.SetUVs(0, nUv0);                       // float3: xy = tex uv, z = array slice
            if (hasUv1) mesh.SetUVs(1, nUv1);
            if (hasUv2) mesh.SetUVs(2, nUv2);
            if (hasUv3) mesh.SetUVs(3, nUv3);
            if (hasUv4) mesh.SetUVs(4, nUv4);
            if (hasUv5) mesh.SetUVs(5, nUv5);
            if (hasUv6) mesh.SetUVs(6, nUv6);
            if (hasUv7) mesh.SetUVs(7, nUv7);
            if (hasCol) mesh.SetColors(nCol);
            mesh.subMeshCount = newTris.Count;
            for (int s = 0; s < newTris.Count; s++) mesh.SetTriangles(newTris[s], s, calculateBounds: false);
            mesh.RecalculateBounds();
            AssetDatabase.CreateAsset(mesh, AssetPath(outDir, src.name + "_TexArr.asset"));

            mf.sharedMesh = mesh;
            mr.sharedMaterials = newMats.ToArray();
            if (markBatchingStatic)
                GameObjectUtility.SetStaticEditorFlags(mr.gameObject,
                    GameObjectUtility.GetStaticEditorFlags(mr.gameObject) | StaticEditorFlags.BatchingStatic);

            res.subAfter = newTris.Count;
            res.note = "ok";
            return res;
        }

        // The render-config signature that must match for submeshes to share one material/array (queue + blend +
        // the lighting keywords). Texture size/format are appended by the caller.
        static string ConfigKey(Material m)
        {
            return "q" + m.renderQueue
                + (m.IsKeywordEnabled("_CUTOUT") ? "C" : "")
                + (m.IsKeywordEnabled("_LIGHTMAP") ? "L" : "")
                + (m.IsKeywordEnabled("_LIGHTMAP_GS") ? "G" : "")
                + (m.IsKeywordEnabled("_PROPLIGHT") ? "P" : "")
                + (m.IsKeywordEnabled("_DIRLIGHT") ? "D" : "")
                + "b" + (m.HasProperty("_SrcBlend") ? (int)m.GetFloat("_SrcBlend") : 1)
                + "_" + (m.HasProperty("_DstBlend") ? (int)m.GetFloat("_DstBlend") : 0);
        }

        // Build BOTH a BC/DXT array (desktop) under baseDir/PC and an ASTC array (Quest + iOS) under baseDir/Mobile,
        // from each slice's ORIGINAL pixels (decode the source PNG, then EditorUtility.CompressTexture to each format
        // so both come out clean regardless of the active build target). The material points at the array matching the
        // active target; TexArrayPlatformSwap re-points it per build target. Returns the active-target array (or null
        // -> caller leaves the group unmerged). No single compressed format works on both desktop (BC) and mobile (ASTC).
        // Public: MaterialFactory.BuildCrowd bakes the cd frame array through the same path.
        public static Texture2DArray BuildDualArrays(List<Texture2D> slices, string baseDir, string prefix, int ord, bool needsAlpha)
        {
            var t0 = slices[0];
            int w = t0.width, h = t0.height; bool mip = t0.mipmapCount > 1;
            bool linear = !IsSrgb(t0);
            var bcFmt = needsAlpha ? TextureFormat.DXT5 : TextureFormat.DXT1;   // desktop BC1/BC3
            var astcFmt = TextureFormat.ASTC_6x6;                              // mobile (Quest + iOS) ASTC
            var pc = NewArray(w, h, slices.Count, bcFmt, mip, linear, prefix, ord, t0);
            var mob = NewArray(w, h, slices.Count, astcFmt, mip, linear, prefix, ord, t0);

            for (int i = 0; i < slices.Count; i++)
            {
                if (slices[i].width != w || slices[i].height != h) return Fail(pc, mob);   // non-uniform group
                var raw = LoadOriginalRGBA(slices[i], linear, w, h);
                if (raw == null) return Fail(pc, mob);
                var bcTex = CompressedCopy(raw, bcFmt, linear);
                var asTex = CompressedCopy(raw, astcFmt, linear);
                bool ok = bcTex != null && asTex != null;
                if (ok) { try { Graphics.CopyTexture(bcTex, 0, pc, i); Graphics.CopyTexture(asTex, 0, mob, i); } catch { ok = false; } }
                Object.DestroyImmediate(raw);
                if (bcTex != null) Object.DestroyImmediate(bcTex);
                if (asTex != null) Object.DestroyImmediate(asTex);
                if (!ok) return Fail(pc, mob);
            }
            pc.Apply(false, false); mob.Apply(false, false);
            EnsureFolder(baseDir + "/PC"); EnsureFolder(baseDir + "/Mobile");
            AssetDatabase.CreateAsset(pc, AssetPath(baseDir + "/PC", prefix + "_arr_" + ord + ".asset"));
            AssetDatabase.CreateAsset(mob, AssetPath(baseDir + "/Mobile", prefix + "_arr_" + ord + ".asset"));
            var t = EditorUserBuildSettings.activeBuildTarget;
            return (t == BuildTarget.Android || t == BuildTarget.iOS) ? mob : pc;
        }

        static Texture2DArray Fail(Texture2DArray a, Texture2DArray b)
        { if (a != null) Object.DestroyImmediate(a); if (b != null) Object.DestroyImmediate(b); return null; }

        static Texture2DArray NewArray(int w, int h, int n, TextureFormat fmt, bool mip, bool linear, string prefix, int ord, Texture2D t0)
        {
            return new Texture2DArray(w, h, n, fmt, mip, linear)
            { name = prefix + "_arr_" + ord, wrapMode = TextureWrapMode.Repeat, filterMode = t0.filterMode, anisoLevel = t0.anisoLevel };
        }

        // Original slice pixels as a readable RGBA32 (with mips): decode the source PNG when available (cleanest -
        // no gamma/format roundtrip), else GPU-readback the imported texture (handles compressed / non-readable).
        static Texture2D LoadOriginalRGBA(Texture2D tex, bool linear, int w, int h)
        {
            var path = AssetDatabase.GetAssetPath(tex);
            if (!string.IsNullOrEmpty(path) && path.EndsWith(".png"))
            {
                string abs = Path.Combine(Path.GetDirectoryName(Application.dataPath), path);
                if (File.Exists(abs))
                {
                    var raw = new Texture2D(2, 2, TextureFormat.RGBA32, true, linear);
                    if (raw.LoadImage(File.ReadAllBytes(abs)) && raw.width == w && raw.height == h) { raw.Apply(true); return raw; }
                    Object.DestroyImmediate(raw);
                }
            }
            var rt = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32, linear ? RenderTextureReadWrite.Linear : RenderTextureReadWrite.sRGB);
            var prev = RenderTexture.active;
            Graphics.Blit(tex, rt);
            RenderTexture.active = rt;
            var rb = new Texture2D(w, h, TextureFormat.RGBA32, true, linear);
            rb.ReadPixels(new Rect(0, 0, w, h), 0, 0);
            rb.Apply(true);
            RenderTexture.active = prev;
            RenderTexture.ReleaseTemporary(rt);
            return rb;
        }

        // A fresh RGBA32 copy compressed to 'fmt' (with mips). Returns null if the encoder rejects the format.
        static Texture2D CompressedCopy(Texture2D raw, TextureFormat fmt, bool linear)
        {
            var c = new Texture2D(raw.width, raw.height, TextureFormat.RGBA32, true, linear);
            c.SetPixels32(raw.GetPixels32());
            c.Apply(true);
            try { EditorUtility.CompressTexture(c, fmt, TextureCompressionQuality.Normal); c.Apply(false); }
            catch { Object.DestroyImmediate(c); return null; }
            return c;
        }

        // Clone a group member's material (inherits its keywords/blend/queue/lighting params) and switch it to the
        // _TEXARRAY path with the built array.
        static Material BuildArrayMaterial(Material proto, Texture2DArray arr, string outDir, string prefix, int ord)
        {
            var m = new Material(proto) { name = prefix + "_arr_" + ord, enableInstancing = true };
            m.EnableKeyword("_TEXARRAY");
            if (m.HasProperty("_UseTexArray")) m.SetFloat("_UseTexArray", 1f);
            m.SetTexture("_MainTexArray", arr);
            AssetDatabase.CreateAsset(m, AssetPath(outDir, prefix + "_arr_" + ord + ".mat"));
            return m;
        }

        static bool IsSrgb(Texture2D t)
        {
            var path = AssetDatabase.GetAssetPath(t);
            if (!string.IsNullOrEmpty(path) && AssetImporter.GetAtPath(path) is TextureImporter ti) return ti.sRGBTexture;
            return true;   // base-colour default
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
