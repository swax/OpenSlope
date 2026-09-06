using System.Globalization;
using System.Numerics;
using SSXLibrary.JsonFiles.Tricky;
using Snowknife.Engine;

namespace Snowknife.Export;

/// <summary>
/// Bakes each instance's REAL collision proxy into a single world-space <c>PropsCollision.obj</c>.
///
/// SSX ships collision separately from the visual model [Trailmap: 130-collision-data]. Mode-1 instances point at
/// a triangle proxy in <c>Collision/*.obj</c> (via <c>Instances.json</c>'s CollsionModelPaths); modes 2/3 use an
/// AABB/body instead. This exporter includes only mode-1 instances that set <c>PlayerCollision</c> and have a collision
/// model (<see cref="NativeCollisionMode.TriangleProxy"/>); the other modes have no proxy mesh in this export
/// because their shapes are game-computed bounds/body spheres.
///
/// The proxy is authored in instance-local space, so we apply ONLY the instance transform (no
/// per-object chain like <see cref="PropsExporter"/> uses for the multi-part visual model), with
/// the exact same SRT convention so it lands in the same world space as <c>Props.obj</c>.
/// </summary>
internal static class PropsCollisionExporter
{
    public static int Export(string levelDir)
    {
        string instPath = Path.Combine(levelDir, "Instances.json");
        string colDir = Path.Combine(levelDir, "Collision");

        if (!File.Exists(instPath)) throw new FileNotFoundException($"Instances.json not found in '{levelDir}'. Run `snowknife import ...` first.");
        if (!Directory.Exists(colDir)) { Log.Warn("No Collision/ folder - skipping collision export."); return 1; }

        var instances = InstanceJsonHandler.Load(instPath).Instances ?? new();
        if (instances.Count == 0) { Log.Warn("No instances to collide."); return 1; }

        var meshCache = new Dictionary<string, CachedMesh?>(StringComparer.OrdinalIgnoreCase);

        string objPath = Path.Combine(levelDir, "PropsCollision.obj");
        long gV = 0;                   // running 0-based count of v lines written
        long emittedVerts = 0, emittedTris = 0;
        int placed = 0, skippedNoCol = 0, skippedNoPlayer = 0, missing = 0;

        using (var w = new StreamWriter(objPath, false))
        {
            w.Write("# SSX real collision proxies baked to world space from Instances.json + Collision/*.obj by snowknife\n");
            for (int ii = 0; ii < instances.Count; ii++)
            {
                var inst = instances[ii];
                if (inst.CollsionModelPaths == null || inst.CollsionModelPaths.Length == 0) { skippedNoCol++; continue; }
                if (!inst.PlayerCollision) { skippedNoPlayer++; continue; }

                Matrix4x4 world = Compose(inst.Location, inst.Rotation, inst.Scale);

                bool wrote = false;
                foreach (var cp in inst.CollsionModelPaths)
                {
                    var mesh = GetMesh(meshCache, colDir, cp);
                    if (mesh == null) { missing++; continue; }

                    if (!wrote)
                    {
                        w.Write("o inst");
                        w.Write(ii.ToString(CultureInfo.InvariantCulture));
                        w.Write('_');
                        w.Write(Sanitize(inst.InstanceName, ii));
                        w.Write('\n');
                        wrote = true;
                    }

                    long vBase = gV;
                    foreach (var v in mesh.Verts)
                    {
                        Vector3 p = Vector3.Transform(v, world);
                        w.Write("v "); w.Write(F(p.X)); w.Write(' '); w.Write(F(p.Y)); w.Write(' '); w.Write(F(p.Z)); w.Write('\n');
                    }
                    gV += mesh.Verts.Count;
                    emittedVerts += mesh.Verts.Count;

                    foreach (var t in mesh.Tris)
                    {
                        w.Write('f');
                        for (int k = 0; k < 3; k++)
                        {
                            w.Write(' ');
                            w.Write((vBase + t[k] + 1).ToString(CultureInfo.InvariantCulture));
                        }
                        w.Write('\n');
                    }
                    emittedTris += mesh.Tris.Count;
                }
                if (wrote) placed++;
            }
        }

        Log.Info($"PropsCollision: placed {placed} collision instances -> {emittedTris:n0} triangles ({emittedVerts:n0} verts).");
        if (skippedNoCol > 0)    Log.Warn($"  ({skippedNoCol} instances skipped: no collision model.)");
        if (skippedNoPlayer > 0) Log.Warn($"  ({skippedNoPlayer} instances skipped: PlayerCollision off.)");
        if (missing > 0)         Log.Warn($"  ({missing} collision meshes not found in Collision/.)");
        Log.Info($"  -> {objPath}");
        return 0;
    }

    // ---- transforms --------------------------------------------------------

    /// <summary>SRT matrix matching <see cref="PropsExporter"/>'s instance compose exactly.</summary>
    private static Matrix4x4 Compose(float[]? loc, float[]? rot, float[]? scale)
    {
        Vector3 t = V3(loc);
        Quaternion q = (rot != null && rot.Length >= 4)
            ? new Quaternion(rot[0], rot[1], rot[2], rot[3])
            : Quaternion.Identity;
        Vector3 s = (scale != null && scale.Length >= 3)
            ? new Vector3(scale[0], scale[1], scale[2])
            : Vector3.One;
        return Matrix4x4.CreateScale(s) * Matrix4x4.CreateFromQuaternion(q) * Matrix4x4.CreateTranslation(t);
    }

    private static Vector3 V3(float[]? a) =>
        (a != null && a.Length >= 3) ? new Vector3(a[0], a[1], a[2]) : Vector3.Zero;

    // ---- mesh cache / OBJ parsing -----------------------------------------
    // Collision OBJs are pure geometry: "v" + "f" (triangles), no "vt"/materials. We fan-
    // triangulate defensively in case any face is an n-gon.

    private sealed class CachedMesh
    {
        public List<Vector3> Verts = new();
        public List<int[]> Tris = new();
    }

    private static CachedMesh? GetMesh(Dictionary<string, CachedMesh?> cache, string dir, string? path)
    {
        if (string.IsNullOrEmpty(path)) return null;
        if (cache.TryGetValue(path, out var hit)) return hit;

        string full = Path.Combine(dir, path);
        CachedMesh? mesh = File.Exists(full) ? ParseObj(full) : null;
        cache[path] = mesh;
        return mesh;
    }

    private static CachedMesh ParseObj(string path)
    {
        var mesh = new CachedMesh();
        foreach (var raw in File.ReadLines(path))
        {
            if (raw.Length < 2) continue;
            if (raw[0] == 'v' && raw[1] == ' ')
            {
                var p = raw.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (p.Length >= 4)
                    mesh.Verts.Add(new Vector3(PF(p[1]), PF(p[2]), PF(p[3])));
            }
            else if (raw[0] == 'f' && raw[1] == ' ')
            {
                var p = raw.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                int n = p.Length - 1;
                if (n < 3) continue;
                var idx = new int[n];
                for (int k = 0; k < n; k++)
                {
                    var bits = p[k + 1].Split('/');
                    idx[k] = int.Parse(bits[0], CultureInfo.InvariantCulture) - 1;
                }
                for (int k = 1; k < n - 1; k++)
                    mesh.Tris.Add(new[] { idx[0], idx[k], idx[k + 1] });
            }
        }
        return mesh;
    }

    private static float PF(string s) => float.Parse(s, CultureInfo.InvariantCulture);
    private static string F(float value) => value.ToString("0.######", CultureInfo.InvariantCulture);

    private static string Sanitize(string? name, int fallback)
    {
        if (string.IsNullOrWhiteSpace(name)) return fallback.ToString();
        Span<char> buf = name.Length <= 64 ? stackalloc char[name.Length] : new char[name.Length];
        for (int i = 0; i < name.Length; i++)
        {
            char c = name[i];
            buf[i] = (char.IsLetterOrDigit(c) || c is '_' or '-' or '.') ? c : '_';
        }
        return new string(buf);
    }
}
