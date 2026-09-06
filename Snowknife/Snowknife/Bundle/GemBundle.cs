using System.Numerics;
using Newtonsoft.Json;

namespace Snowknife.Bundle;

/// <summary>
/// Reads an authored course's <c>Gems.json</c> (Slopesmith's gem pickups) into the manifest's gem list — the
/// collectible half of the authored trick layer, alongside the grind rails from <see cref="PathBundle"/>
/// (Slopesmith docs/014). This is the AUTHORED gem channel: a plain list of positions + score values, distinct from the
/// EXTRACTED gems snowknife derives from a level's SSF (a MainType-14 pickup effect → spinner DivertInfo).
/// Authored gems carry no baked geometry, so the importer synthesises the gem visual + a collectible marker per
/// record. Positions are read from raw SSX space (cm, Z-up, X-mirrored — the same frame Patches / Splines use)
/// into bundle mesh space (X negated), so a gem lands where the editor placed it.
/// </summary>
public static class GemBundle
{
    public static BundleManifest.GemsInfo? Build(string levelDir)
    {
        string path = Path.Combine(levelDir, "Gems.json");
        if (!File.Exists(path)) return null;
        GemFile? parsed;
        try { parsed = JsonConvert.DeserializeObject<GemFile>(File.ReadAllText(path)); }
        catch (Exception e)
        {
            Log.Warn($"  WARN: {path} is unreadable ({e.Message}) — no authored gems.");
            return null;
        }
        if (parsed?.Gems == null || parsed.Gems.Count == 0) return null;

        var info = new BundleManifest.GemsInfo();
        foreach (var g in parsed.Gems)
        {
            if (g?.Position == null || g.Position.Length < 3) continue;
            info.Gems.Add(new BundleManifest.GemInfo
            {
                Center = BundleSpace.Xyz(BundleSpace.MeshPt(g.Position)),
                Value = g.Value > 0 ? g.Value : 1,
            });
        }
        if (info.Gems.Count == 0) return null;
        Log.Info($"  Gems: {info.Gems.Count} authored pickups.");
        return info;
    }

    /// <summary>
    /// Bake the course's native gem crystals — Slopesmith's <c>GemModels.obj</c> (the donor level's three
    /// tier models, model-local raw verts, one <c>o GemTier&lt;2|3|5&gt;</c> group each) — into glb nodes the
    /// importer instantiates per authored gem, and record the tier → node map on the manifest. The OBJ rides
    /// the same conventions as Props.obj (X negated at read, vt V-flipped for the glb, outward normals), so
    /// the loaded mesh lands in the identical mesh space the gem Centers use. Absent file (older courses /
    /// extracted levels) → empty list; the importer falls back to its synthesized crystal.
    /// </summary>
    public static List<GltfMeshWriter.Node> BuildGeometry(string levelDir, BundleManifest.GemsInfo? info)
    {
        var nodes = new List<GltfMeshWriter.Node>();
        string objPath = Path.Combine(levelDir, "GemModels.obj");
        if (info == null || !File.Exists(objPath)) return nodes;

        static float PF(string s) => float.Parse(s, System.Globalization.CultureInfo.InvariantCulture);
        var pos = new List<Vector3>();
        var uvs = new List<Vector2>();

        // per current node: welded (vIdx, tIdx) pools + triangle lists per usemtl slot
        GltfMeshWriter.Node? cur = null;
        int curTier = 0;
        List<Vector3> wPos = new(); List<Vector2> wUv = new();
        Dictionary<long, int> vmap = new();
        Dictionary<string, List<int>> triBySlot = new(StringComparer.Ordinal);
        string curSlot = "__untextured";
        var tierNodes = new Dictionary<int, string>();

        void Finish()
        {
            if (cur == null || wPos.Count == 0 || triBySlot.Count == 0) return;
            var nrm = OutwardNormals(wPos, triBySlot.Values);
            var nList = new List<Vector3>(nrm);
            foreach (var kv in triBySlot)
                cur.Prims.Add(new GltfMeshWriter.Prim
                {
                    Material = kv.Key,
                    Positions = wPos, Normals = nList, Uv0 = wUv, Indices = kv.Value,
                });
            nodes.Add(cur);
            tierNodes[curTier] = cur.Name;
        }

        foreach (var line in File.ReadLines(objPath))
        {
            if (line.Length < 2) continue;
            char c0 = line[0], c1 = line[1];
            if (c0 == 'v' && c1 == ' ')
            {
                var p = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (p.Length >= 4) pos.Add(new Vector3(-PF(p[1]), PF(p[2]), PF(p[3]))); // SSX X-negation, like Props.obj
            }
            else if (c0 == 'v' && c1 == 't')
            {
                var p = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (p.Length >= 3) uvs.Add(new Vector2(PF(p[1]), PF(p[2])));
            }
            else if (c0 == 'o' && c1 == ' ')
            {
                Finish();
                string name = line.Substring(2).Trim();
                curTier = name.StartsWith("GemTier", StringComparison.Ordinal) && int.TryParse(name.AsSpan(7), out int t) ? t : 0;
                cur = new GltfMeshWriter.Node { Name = name };
                wPos = new List<Vector3>(); wUv = new List<Vector2>();
                vmap = new Dictionary<long, int>();
                triBySlot = new Dictionary<string, List<int>>(StringComparer.Ordinal);
                curSlot = "__untextured";
            }
            else if (line.StartsWith("usemtl ", StringComparison.Ordinal))
            {
                curSlot = line.Substring(7).Trim();
            }
            else if (c0 == 'f' && c1 == ' ' && cur != null)
            {
                var p = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (p.Length < 4) continue;
                if (!triBySlot.TryGetValue(curSlot, out var tris)) triBySlot[curSlot] = tris = new List<int>();
                int Vert(string tok)
                {
                    int slash = tok.IndexOf('/');
                    int vi, ti = -1;
                    if (slash < 0) { if (!int.TryParse(tok, out vi)) return -1; }
                    else
                    {
                        if (!int.TryParse(tok.AsSpan(0, slash), out vi)) return -1;
                        int slash2 = tok.IndexOf('/', slash + 1);
                        var tt = slash2 < 0 ? tok.AsSpan(slash + 1) : tok.AsSpan(slash + 1, slash2 - slash - 1);
                        // A token that fails to parse reads as 0, outside the 1-based OBJ index space; the
                        // decrement below already turns that into "absent".
                        if (tt.Length > 0) _ = int.TryParse(tt, out ti);
                    }
                    vi -= 1; ti -= 1;
                    if (vi < 0 || vi >= pos.Count) return -1;
                    long key = ((long)vi << 32) | (uint)(ti + 1);
                    if (vmap.TryGetValue(key, out int idx)) return idx;
                    idx = wPos.Count;
                    wPos.Add(pos[vi]);
                    wUv.Add(ti >= 0 && ti < uvs.Count ? new Vector2(uvs[ti].X, 1f - uvs[ti].Y) : Vector2.Zero); // vt → glTF V flip
                    vmap[key] = idx;
                    return idx;
                }
                int a = Vert(p[1]);
                for (int i = 2; i + 1 < p.Length; i++) // triangle fan (Slopesmith writes triangles; quads tolerated)
                {
                    int b = Vert(p[i]), c = Vert(p[i + 1]);
                    if (a >= 0 && b >= 0 && c >= 0) { tris.Add(a); tris.Add(b); tris.Add(c); }
                }
            }
        }
        Finish();

        if (tierNodes.Count > 0)
        {
            info.TierNodes = tierNodes;
            Log.Info($"  Gems: native tier crystal(s) {string.Join(" ", tierNodes.Keys.OrderBy(k => k).Select(k => "x" + k))} from GemModels.obj.");
        }
        return nodes;
    }

    // Outward per-vertex normals: area-weighted face-normal sum, normalized, negated (the X-negated geometry
    // would otherwise point inward) — the same treatment PropsBundle gives Props.obj geometry.
    static Vector3[] OutwardNormals(List<Vector3> p, IEnumerable<List<int>> triLists)
    {
        var nrm = new Vector3[p.Count];
        foreach (var t in triLists)
            for (int i = 0; i + 2 < t.Count; i += 3)
            {
                int a = t[i], b = t[i + 1], c = t[i + 2];
                Vector3 fn = Vector3.Cross(p[b] - p[a], p[c] - p[a]);
                nrm[a] += fn; nrm[b] += fn; nrm[c] += fn;
            }
        for (int i = 0; i < nrm.Length; i++)
            nrm[i] = nrm[i].LengthSquared() > 1e-12f ? -Vector3.Normalize(nrm[i]) : new Vector3(0, 1, 0);
        return nrm;
    }

    // Newtonsoft populates these fields through reflection; direct assignments would only add DTO boilerplate.
#pragma warning disable CS0649
    class GemFile { public List<Gem>? Gems; }
    class Gem { public float[]? Position; public int Value = 1; }
#pragma warning restore CS0649
}
