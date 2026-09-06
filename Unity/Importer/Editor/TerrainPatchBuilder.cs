#if UNITY_EDITOR
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Analytic terrain CONTACT (approach A, docs/021) - CHEAP-EVAL bake. The board rides the level's ORIGINAL bicubic
    // patches instead of the faceted collider, but a per-frame Newton solve was far too heavy for Udon. Instead we do
    // the matching ONCE here at import: every collision triangle's 3 corners sit at known (u,v) grid coords on a known
    // patch (the collision mesh IS the patch tessellation), so we store, per triangle, one packed int = patch + its 3
    // corners' grid codes (in the LOADED triangle's vertex order). At runtime the holder blends those by the hit's
    // barycentric and does ONE bicubic eval - no search, no Newton.
    //
    // Source is the same Patches.json snowknife tessellates. We re-tessellate each patch here (identical row-major eval,
    // mesh-local -x,y,z) to recover each generated triangle's patch + grid corners, then match the LOADED Surf_ collision
    // triangles to them by GEOMETRY (centroid -> patch; nearest grid point -> corner) so it's robust to the glb's vertex
    // dedup/reorder. TriKey/TriStart are flattened with per-collider offsets in the SAME order the board caches its
    // colliders (collisionRoot children that have a Collider). Patches.json is the level SOURCE (shipped to the project
    // by `snowknife unity`); read once, editor-only.
    public static class TerrainPatchBuilder
    {
        // Bicubic Bezier (row-major, matches snowknife Bezier.Patch + the holder).
        static Vector3 Pt4(Vector3 a, Vector3 b, Vector3 c, Vector3 d, float t)
        { float s = 1f - t; return s * s * s * a + 3f * s * s * t * b + 3f * s * t * t * c + t * t * t * d; }
        static Vector3 PatchEval(Vector3[] cp, float u, float v)
        {
            Vector3 r0 = Pt4(cp[0], cp[1], cp[2], cp[3], v);
            Vector3 r1 = Pt4(cp[4], cp[5], cp[6], cp[7], v);
            Vector3 r2 = Pt4(cp[8], cp[9], cp[10], cp[11], v);
            Vector3 r3 = Pt4(cp[12], cp[13], cp[14], cp[15], v);
            return Pt4(r0, r1, r2, r3, u);
        }

        public static string Bake(string rootName, string patchesPath, int noCollisionType, int seg)
        {
            if (seg < 1) seg = 4;
            if (seg > 4) return $"ERROR: TerrainRes {seg} > 4 unsupported by the packed corner codes (needs <=4).";
            string full = Path.IsPathRooted(patchesPath) ? patchesPath
                : Path.Combine(Path.GetDirectoryName(Application.dataPath), patchesPath);
            if (!File.Exists(full)) return "ERROR: Patches.json not found at " + full;

            var rootGo = GameObject.Find(rootName);
            if (rootGo == null) return "ERROR: no " + rootName + " in the scene - import a map first.";
            var collisionT = rootGo.transform.Find("Collision") ?? rootGo.transform.Find("TerrainCollision");
            if (collisionT == null) return "ERROR: no Collision child under " + rootName + ".";

            int s1 = seg + 1, gridN = s1 * s1;

            // ---- parse Patches.json: 16 mesh-local CPs per collidable patch + re-tessellate ----
            var cpsFlat = new List<Vector3>();          // patch p -> [p*16 .. +16) mesh-local CPs
            var patchGrids = new List<Vector3[]>();      // patch p -> (seg+1)^2 mesh-local grid points (cornerCode = index)
            var centroidToPatch = new Dictionary<(int, int, int), int>();
            int total = 0, skippedNoCol = 0, skippedBad = 0;
            {
                var rootJ = JObject.Parse(File.ReadAllText(full));
                var patches = rootJ["Patches"] as JArray;
                if (patches == null) return "ERROR: Patches.json has no 'Patches' array.";
                var cp = new Vector3[16];
                foreach (var pj in patches)
                {
                    total++;
                    int st = pj["SurfaceType"] != null ? (int)pj["SurfaceType"] : -1;
                    if (st == noCollisionType) { skippedNoCol++; continue; }
                    var pts = pj["Points"] as JArray;
                    if (pts == null || pts.Count < 16) { skippedBad++; continue; }
                    bool ok = true;
                    for (int k = 0; k < 16; k++)
                    {
                        var c = pts[k] as JArray;
                        if (c == null || c.Count < 3) { ok = false; break; }
                        cp[k] = new Vector3(-(float)c[0], (float)c[1], (float)c[2]); // mesh-local (X negated)
                    }
                    if (!ok) { skippedBad++; continue; }
                    int pi = patchGrids.Count;
                    for (int k = 0; k < 16; k++) cpsFlat.Add(cp[k]);
                    // grid points + corner codes
                    var grid = new Vector3[gridN];
                    for (int iu = 0; iu <= seg; iu++)
                        for (int iv = 0; iv <= seg; iv++)
                            grid[iu * s1 + iv] = PatchEval(cp, iu / (float)seg, iv / (float)seg);
                    patchGrids.Add(grid);
                    // triangle centroids -> this patch (2 per cell, matching snowknife winding a,e,c / a,b,e)
                    for (int iu = 0; iu < seg; iu++)
                        for (int iv = 0; iv < seg; iv++)
                        {
                            Vector3 A = grid[iu * s1 + iv], B = grid[iu * s1 + (iv + 1)],
                                    C = grid[(iu + 1) * s1 + iv], E = grid[(iu + 1) * s1 + (iv + 1)];
                            AddCentroid(centroidToPatch, (A + E + C) / 3f, pi);
                            AddCentroid(centroidToPatch, (A + B + E) / 3f, pi);
                        }
                }
            }
            if (patchGrids.Count == 0) return "ERROR: no collidable patches parsed from Patches.json.";

            // ---- patch edge ADJACENCY (the runtime recovery march, docs/021): who is across each of a patch's 4 edges,
            // so a (u,v) march that exits [0,1]^2 can continue on the neighbour instead of losing the surface at a seam.
            // Edge e: 0 = u=0 (CPs 0..3, param v), 1 = u=1 (CPs 12..15, v), 2 = v=0 (CPs 0/4/8/12, u), 3 = v=1
            // (CPs 3/7/11/15, u). The quilt is welded, so neighbouring edges share their 4 boundary CPs exactly: match by
            // quantized ENDPOINT pair (patch spans are hundreds of units, so endpoints identify an edge), verified on the
            // 2 interior CPs in the flip the endpoints imply. Packed: neighbour | (neighbourEdge<<16) | (flip<<18), where
            // flip = the shared curve runs opposite to the neighbour's edge param; -1 = boundary / no unique partner
            // (a pole fan or T-junction stays -1: the march clamps there and the ray fallback owns it, nothing regresses).
            var patchAdj = new int[patchGrids.Count * 4];
            int adjMatched = 0, adjAmbiguous = 0;
            {
                for (int i = 0; i < patchAdj.Length; i++) patchAdj[i] = -1;
                int[][] edgeIdx = {
                    new[] { 0, 1, 2, 3 },      // u=0, along v
                    new[] { 12, 13, 14, 15 },  // u=1, along v
                    new[] { 0, 4, 8, 12 },     // v=0, along u
                    new[] { 3, 7, 11, 15 },    // v=1, along u
                };
                (int, int, int) Q(Vector3 w) => (Mathf.RoundToInt(w.x), Mathf.RoundToInt(w.y), Mathf.RoundToInt(w.z));
                // endpoint-pair key (canonically ordered) -> every (patch, edge, fwd) that carries it
                var byKey = new Dictionary<(int, int, int, int, int, int), List<(int p, int e, bool fwd)>>();
                for (int p = 0; p < patchGrids.Count; p++)
                    for (int e = 0; e < 4; e++)
                    {
                        var qa = Q(cpsFlat[p * 16 + edgeIdx[e][0]]);   // edge param t=0 endpoint
                        var qb = Q(cpsFlat[p * 16 + edgeIdx[e][3]]);   // t=1 endpoint
                        if (qa.Equals(qb)) continue;                    // degenerate (collapsed) edge - a pole tip
                        bool fwd = qa.CompareTo(qb) <= 0;               // does t run min->max in canonical order?
                        var key = fwd ? (qa.Item1, qa.Item2, qa.Item3, qb.Item1, qb.Item2, qb.Item3)
                                      : (qb.Item1, qb.Item2, qb.Item3, qa.Item1, qa.Item2, qa.Item3);
                        if (!byKey.TryGetValue(key, out var list)) byKey[key] = list = new List<(int, int, bool)>();
                        list.Add((p, e, fwd));
                    }
                const float tol2 = 4f;                                  // interior CPs agree within 2 units (weld slack)
                foreach (var kv in byKey)
                {
                    var list = kv.Value;
                    if (list.Count != 2) { if (list.Count > 2) adjAmbiguous += list.Count; continue; }
                    var (p0, e0, f0) = list[0];
                    var (p1, e1, f1) = list[1];
                    int flip = f0 == f1 ? 0 : 1;                        // same canonical direction => params co-run
                    // verify the 2 interior CPs in that flip (rejects two distinct edges sharing both endpoints)
                    Vector3 a1 = cpsFlat[p0 * 16 + edgeIdx[e0][1]], a2 = cpsFlat[p0 * 16 + edgeIdx[e0][2]];
                    Vector3 b1 = cpsFlat[p1 * 16 + edgeIdx[e1][flip == 0 ? 1 : 2]], b2 = cpsFlat[p1 * 16 + edgeIdx[e1][flip == 0 ? 2 : 1]];
                    if ((a1 - b1).sqrMagnitude > tol2 || (a2 - b2).sqrMagnitude > tol2) continue;
                    if (p0 >= 65536 || p1 >= 65536) continue;           // beyond the pack width (matches TriKey's guard)
                    patchAdj[p0 * 4 + e0] = p1 | (e1 << 16) | (flip << 18);
                    patchAdj[p1 * 4 + e1] = p0 | (e0 << 16) | (flip << 18);
                    adjMatched++;
                }
            }

            // ---- map each LOADED Surf_ collision triangle -> packed TriKey, in the board's collider order ----
            var triKey = new List<int>();
            var triStart = new List<int>();
            int colliders = 0, mappedTris = 0, unmappedTris = 0;
            for (int i = 0; i < collisionT.childCount; i++)
            {
                Transform child = collisionT.GetChild(i);
                if (child.GetComponent<Collider>() == null) continue; // board skips non-collider children -> no ci
                triStart.Add(triKey.Count);                            // start for this collider (ci = colliders)
                colliders++;
                var mc = child.GetComponent<MeshCollider>();
                Mesh m = mc != null ? mc.sharedMesh : null;
                if (m == null || !m.isReadable) continue;              // no triangles to map (ci still counted)
                int[] tris = m.triangles; Vector3[] verts = m.vertices;
                for (int t = 0; t + 2 < tris.Length; t += 3)
                {
                    Vector3 p0 = verts[tris[t]], p1 = verts[tris[t + 1]], p2 = verts[tris[t + 2]];
                    int key = -1;
                    if (FindPatch(centroidToPatch, (p0 + p1 + p2) / 3f, out int patch) && patch < 65536)
                    {
                        var grid = patchGrids[patch];
                        int c0 = NearestCorner(grid, p0), c1 = NearestCorner(grid, p1), c2 = NearestCorner(grid, p2);
                        if (c0 < 32 && c1 < 32 && c2 < 32)
                            key = patch | (c0 << 16) | (c1 << 21) | (c2 << 26);
                    }
                    if (key >= 0) mappedTris++; else unmappedTris++;
                    triKey.Add(key);
                }
            }
            triStart.Add(triKey.Count); // sentinel (length = colliders + 1)

            // ---- (re)build the TerrainPatches holder + tag it ----
            var prev = collisionT.Find("TerrainPatches");
            if (prev != null) Object.DestroyImmediate(prev.gameObject);
            var go = new GameObject("TerrainPatches");
            go.transform.SetParent(collisionT, false);  // identity-local => same world transform as the Surf_ colliders
            var mk = go.AddComponent<TerrainPatchesMarker>();
            mk.ControlPoints = cpsFlat.ToArray();
            mk.seg = seg;
            mk.TriKey = triKey.ToArray();
            mk.TriStart = triStart.ToArray();
            mk.PatchAdj = patchAdj;
            // The platform wiring pass realizes the runtime patches behaviour and points every board at it (the boards are
            // spawned after import, so board wiring belongs in the wiring/setup path, not here).

            EditorUtility.SetDirty(go);
            UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(rootGo.scene);
            // WARN (not OK) when any collision triangle failed to map to a patch: those triangles ride the faceted
            // collider (chord-sag poke-through returns there), and a high count means the tessellation assumption broke
            // (TerrainRes mismatch / a different quad-split) - the caller raises it as a warning so it isn't missed.
            string prefix = unmappedTris > 0 ? "WARN" : "OK";
            return $"{prefix}: {patchGrids.Count} patches ({cpsFlat.Count} CPs), {colliders} colliders, {mappedTris} tris mapped" +
                   (unmappedTris > 0 ? $" ({unmappedTris} UNMAPPED -> faceted there)" : "") +
                   $", {adjMatched} shared edges adjacent" + (adjAmbiguous > 0 ? $" ({adjAmbiguous} ambiguous -> -1)" : "") +
                   $"; tagged for wiring. (skipped {skippedNoCol} no-collision, {skippedBad} malformed of {total})";
        }

        static void AddCentroid(Dictionary<(int, int, int), int> d, Vector3 c, int patch)
        { d[(Mathf.RoundToInt(c.x), Mathf.RoundToInt(c.y), Mathf.RoundToInt(c.z))] = patch; }

        // Centroid -> patch, searching the rounded key + its 26 neighbours (absorbs sub-unit float jitter without a
        // boundary flip; generated centroids are hundreds of units apart so only the true one is within +/-1).
        static bool FindPatch(Dictionary<(int, int, int), int> d, Vector3 c, out int patch)
        {
            int x = Mathf.RoundToInt(c.x), y = Mathf.RoundToInt(c.y), z = Mathf.RoundToInt(c.z);
            for (int dx = -1; dx <= 1; dx++)
                for (int dy = -1; dy <= 1; dy++)
                    for (int dz = -1; dz <= 1; dz++)
                        if (d.TryGetValue((x + dx, y + dy, z + dz), out patch)) return true;
            patch = -1; return false;
        }

        // Index of the grid point nearest 'p' (= its corner code iu*(seg+1)+iv). Robust (nearest, no quantization).
        static int NearestCorner(Vector3[] grid, Vector3 p)
        {
            int best = 0; float bd = float.MaxValue;
            for (int g = 0; g < grid.Length; g++)
            {
                float dd = (grid[g] - p).sqrMagnitude;
                if (dd < bd) { bd = dd; best = g; }
            }
            return best;
        }

        // OpenSlope/Refresh/Terrain Patches lives in VRC (the platform Refresh menus): re-baking needs the wiring pass to realize the
        // marker + point the boards at it, so it can't sit in the neutral importer.
    }
}
#endif
