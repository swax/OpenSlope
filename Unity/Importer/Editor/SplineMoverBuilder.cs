#if UNITY_EDITOR
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // SSX spline-path movers (docs/053, Trailmap MainType-2/SubType-1): an invisible template prop (e.g. a subway car)
    // walks a named spline. snowknife diverts the template's mesh out of the merged mesh (it's normally dropped as hidden)
    // and bakes the sampled path; PropBuilder builds the mesh under Movers/Mover_<index>_*. This tags it with an
    // SplineMoverMarker carrying that path; the platform wiring pass realizes the runtime mover behaviour so it rides
    // the track with the native end/orientation modes. Nothing else to wire - cosmetic + kinematic.
    public class SplineMoverBuilder
    {
        readonly ImportConfig _cfg;
        public SplineMoverBuilder(ImportConfig cfg) { _cfg = cfg; }

        public void Build(Transform root)
        {
            if (!_cfg.BuildSplineMovers) return;
            var reader = new BundleManifestReader(_cfg);
            if (!reader.Exists || reader.SplineMovers.Count == 0) return;

            var moversRoot = root.Find("Movers");
            if (moversRoot == null) return;   // PropBuilder built no mover mesh (no geometry) - nothing to animate

            // Drop what a previous run made - this rebuilds it, and OpenSlope/Refresh/Spline Movers re-runs on a loaded map.
            // The built prop (Mover_<idx>_*) is PropBuilder's and stays.
            for (int i = moversRoot.childCount - 1; i >= 0; i--)
            {
                var c = moversRoot.GetChild(i);
                if (c.name.StartsWith(CopyPrefix, System.StringComparison.Ordinal)
                    || c.name.StartsWith(CablePrefix, System.StringComparison.Ordinal))
                    UnityEngine.Object.DestroyImmediate(c.gameObject);
            }

            int wired = 0, copies = 0, cables = 0;
            foreach (var m in reader.SplineMovers)
            {
                var go = FindMover(moversRoot, m.Index);
                if (go == null) continue;
                var path = m.Path;
                if (path == null || path.Length < 2) continue;
                float speed = m.Speed * _cfg.SplineMoverSpeedScale;

                // The engine rides InstanceCount copies of the ONE model down the spline, spaced evenly by arc length
                // (a chairlift's 15 chairs - at one copy you'd get a lone chair on an empty wire). Copy 0 is the prop
                // PropBuilder built; the rest are bare renderers sharing its mesh + materials.
                int count = Mathf.Max(1, m.Count);
                float spacing = PathLength(path) / count;

                for (int i = 0; i < count; i++)
                {
                    var target = i == 0 ? go : CloneRenderer(go, moversRoot, $"{CopyPrefix}{m.Index}_{i}");
                    if (target == null) continue;
                    if (i > 0) copies++;
                    // Reuse the marker if there is one: on a refresh, a second marker on the same prop would leave the
                    // wiring pass copying a stale one over the live behaviour.
                    var mk = target.GetComponent<SplineMoverMarker>();
                    if (mk == null) mk = target.gameObject.AddComponent<SplineMoverMarker>();
                    mk.Path = path;
                    mk.Speed = speed;
                    // The template's authored rotation rode into the mesh with the divert. The engine poses a spline mover
                    // from the spline alone (it never reads that rotation), so the behaviour undoes it, then yaws the model
                    // by the authored offset against the tangent - see SplineMover.
                    mk.Baked = m.Rotation;
                    mk.YawOffset = m.YawOffset;
                    mk.OrientMode = m.OrientMode;
                    mk.EndMode = m.EndMode;
                    mk.StartDist = spacing * i;
                }

                // The engine draws the spline itself as a line when the payload says so - that line IS the cable a
                // chairlift's chairs hang from, and no other geometry in the level spans the towers. It's a 1-pixel
                // screen-space line in the engine, so there's no authored thickness: we lay a thin tube on the same
                // curve, in the authored colour.
                if (m.Cable && BuildCable(moversRoot, m, path)) cables++;

                wired++;
            }
            if (wired > 0)
                Debug.Log($"OpenSlope: spline movers -> {wired} prop(s) tagged SplineMoverMarker" +
                          (copies > 0 ? $" (+{copies} copy renderer(s), spaced along the path)" : "") +
                          (cables > 0 ? $", {cables} cable(s) drawn along the spline" : "") +
                          $" (speed = SSX AnimationSpeed x {_cfg.SplineMoverSpeedScale}).");
        }

        // The cable: a ribbon of ZERO width on the mover's own curve - two vertices per sample, one per side (UV0.x), with
        // the local wire direction in NORMAL. OpenSlope/ScreenLine gives it its width in clip space, so it stays a hairline of
        // constant SCREEN width at any distance, which is what the engine's GS line primitive does: it draws 1 pixel wide
        // whether you're on top of the wire or a kilometre down the mountain. A world-space tube can't reproduce that -
        // it swells into a pipe up close and aliases away at range.
        bool BuildCable(Transform moversRoot, BundleManifestReader.SplineMover m, Vector3[] path)
        {
            if (path.Length < 2) return false;
            var shader = Shader.Find("OpenSlope/ScreenLine");
            if (shader == null)
            {
                Debug.LogWarning("OpenSlope: spline movers - shader OpenSlope/ScreenLine is missing (it ships in VRC), so the " +
                                 "chairlift cables can't be drawn. The chairs will hang from nothing.");
                return false;
            }
            Color c = _cfg.SplineMoverCableColor.a > 0f ? _cfg.SplineMoverCableColor : m.CableRgba;

            var verts = new List<Vector3>(path.Length * 2);
            var dirs = new List<Vector3>(path.Length * 2);
            var uv = new List<Vector2>(path.Length * 2);
            var cols = new List<Color>(path.Length * 2);
            var tris = new List<int>((path.Length - 1) * 6);

            for (int i = 0; i < path.Length; i++)
            {
                Vector3 tan = (i == 0) ? path[1] - path[0]
                            : (i == path.Length - 1) ? path[i] - path[i - 1]
                            : path[i + 1] - path[i - 1];
                if (tan.sqrMagnitude < 1e-8f) tan = Vector3.right;
                tan = tan.normalized;

                verts.Add(path[i]); verts.Add(path[i]);     // both sides sit ON the curve; the shader pushes them apart
                dirs.Add(tan); dirs.Add(tan);
                uv.Add(new Vector2(0f, 0f)); uv.Add(new Vector2(1f, 0f));
                cols.Add(c); cols.Add(c);

                if (i == 0) continue;
                int a = (i - 1) * 2, b = i * 2;
                tris.Add(a); tris.Add(b); tris.Add(b + 1);
                tris.Add(a); tris.Add(b + 1); tris.Add(a + 1);
            }

            var mesh = new Mesh { name = $"Cable_{m.Index}", indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
            mesh.SetVertices(verts);
            mesh.SetNormals(dirs);
            mesh.SetUVs(0, uv);
            mesh.SetColors(cols);
            mesh.SetTriangles(tris, 0);
            // The ribbon has no width until the shader gives it one, so its computed bounds are a zero-thickness curve.
            // Grow them a little or Unity frustum-culls the wire the moment the curve itself leaves the view.
            var b2 = mesh.bounds; b2.Expand(50f); mesh.bounds = b2;

            var go = new GameObject($"{CablePrefix}{m.Index}");
            go.transform.SetParent(moversRoot, false);
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            go.AddComponent<MeshRenderer>().sharedMaterial = CableMaterial(shader);
            return true;
        }

        Material _cableMat;
        Material CableMaterial(Shader shader)
        {
            if (_cableMat != null) return _cableMat;
            _cableMat = new Material(shader) { name = "mover_cable" };   // the vertex colour carries the authored line colour
            _cableMat.SetFloat("_WidthPx", Mathf.Max(0.5f, _cfg.SplineMoverCableWidthPx));
            AssetDatabase.CreateAsset(_cableMat, _cfg.MatFolder + "/mover_cable.mat");
            return _cableMat;
        }

        const string CopyPrefix = "MoverCopy_";
        const string CablePrefix = "Cable_";

        static float PathLength(Vector3[] p)
        {
            float len = 0f;
            for (int i = 0; i < p.Length - 1; i++) len += Vector3.Distance(p[i], p[i + 1]);
            return len;   // the path is an OPEN line: no closing segment back to the start (see SplineMover)
        }

        // A copy of the mover prop: the same mesh + materials at a new transform, and nothing else. Built by hand rather
        // than Instantiate'd so it can't clone the marker/behaviour components a previous wiring pass left on the prop.
        static Transform CloneRenderer(Transform src, Transform parent, string name)
        {
            var mf = src.GetComponent<MeshFilter>();
            var mr = src.GetComponent<MeshRenderer>();
            if (mf == null || mr == null || mf.sharedMesh == null) return null;
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            go.AddComponent<MeshFilter>().sharedMesh = mf.sharedMesh;
            go.AddComponent<MeshRenderer>().sharedMaterials = mr.sharedMaterials;
            return go.transform;
        }

        static Transform FindMover(Transform moversRoot, int idx)
        {
            string prefix = "Mover_" + idx + "_";
            for (int i = 0; i < moversRoot.childCount; i++)
            {
                var c = moversRoot.GetChild(i);
                if (c.name.StartsWith(prefix, System.StringComparison.Ordinal)) return c;
            }
            return null;
        }

        // OpenSlope/Refresh/Spline Movers lives in VRC (the platform Refresh menus): re-wiring needs the platform wiring pass.
    }
}
#endif
