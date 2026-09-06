#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Grind RAILS (docs/026). SSX authored its grindable rails as splines in DATA Splines.json - normally
    // SplineStyle 13, plus Alaska's six named SplineStyle 5 IceRails. The style is the surface row used while grinding.
    // each a chain of cubic Bezier segments. The VISIBLE rail/fence geometry already renders as ordinary props
    // (PropBuilder); these splines are the separate grind CENTERLINES the rideable board snaps onto. No new visuals.
    //
    // snowknife samples each spline's Beziers into a polyline (same -x,y,z handedness flip + level-root transform as
    // all geometry, docs/unity/004) and ships them in the bundle (manifest.Paths.Rails) - flattened into one point array
    // plus per-rail [start,count] ranges - AND the source cubic bezier segments alongside (manifest.Paths.Rails.Cubic)
    // so the network can ride the analytic curve (exact closest point + tangent), matching the PS2 engine (docs/026).
    // Build() bakes both onto a RailMarker on a Rails child of the level root; the platform wiring pass realizes the
    // runtime rail-network behaviour, which the board auto-finds and queries to grind (docs/vrchat/017, Snowknife docs/034).
    // Mirrors the other builder services: ctor takes config, Build(root) does the work.
    public class RailBuilder
    {
        readonly ImportConfig _cfg;
        public RailBuilder(ImportConfig cfg) { _cfg = cfg; }

        public void Build(Transform root)
        {
            var bundle = new BundleManifestReader(_cfg);
            if (bundle.Exists && bundle.Rails != null && bundle.Rails.Points.Length > 0)
            {
                // Editor/default preview (docs/026): GateShowoffRails starts the authored show-off set disabled.
                // The separate ShowoffRails field lets a runtime mode selector change that state later.
                int[] extraDisabled = _cfg.GateShowoffRails ? bundle.Rails.Showoff : null;
                BuildNetworkFromBundle(root, "Rails", bundle.Rails, extraDisabled);
                int cubicSegs = bundle.Rails.SegControlPoints != null ? bundle.Rails.SegControlPoints.Length / 4 : 0;
                int showoff = _cfg.GateShowoffRails && bundle.Rails.Showoff != null ? bundle.Rails.Showoff.Length : 0;
                Debug.Log($"OpenSlope: rails from bundle -> {bundle.Rails.Start.Length} splines, {bundle.Rails.Points.Length} points, {cubicSegs} cubic segments" +
                          (showoff > 0 ? $" ({showoff} show-off rails disabled for free-ride)" : "") + ".");
            }
            else Debug.Log("OpenSlope: no rails in the bundle - skipping rails.");
        }

        // Bake a bundle polyline set (points already root-local mesh space) onto a RailMarker for the platform wiring
        // pass to realize. Shared shape with CoursePathBuilder; kept here as a static so both can reuse it. extraDisabled
        // selects whether the separately tagged show-off set starts OFF; null on the course path.
        // Returns the marker so the caller can stamp extra fields onto it (CoursePathBuilder stamps course progress).
        public static RailMarker BuildNetworkFromBundle(Transform root, string name, BundleManifestReader.Poly poly, int[] extraDisabled = null)
        {
            var prev = root.Find(name);
            if (prev != null) Object.DestroyImmediate(prev.gameObject);
            var go = new GameObject(name);
            go.transform.SetParent(root, false);
            var mk = go.AddComponent<RailMarker>();
            mk.LocalPoints = poly.Points;
            mk.RailStart = poly.Start;
            mk.RailCount = poly.Count;
            mk.RailStyle = poly.Style;
            // Rails carry their source cubic so the board rides the analytic curve; the course polyline leaves these
            // null and the network falls back to the sampled chords (docs/026, Snowknife docs/034).
            mk.SegControlPoints = poly.SegControlPoints;
            mk.SegStart = poly.SegStart;
            mk.SegCount = poly.SegCount;
            mk.SamplesPerSegment = poly.SamplesPerSegment;
            mk.ShowoffRails = poly.Showoff;
            mk.ShowoffStartsDisabled = extraDisabled != null && extraDisabled.Length > 0;
            // Gameplay-gated rails stay independent from the mode-gated show-off set.
            mk.StartDisabledRails = poly.Gated;
            return mk;
        }

        // OpenSlope/Refresh/Rails lives in VRC (the platform Refresh menus): rebuilding the network in a loaded map needs the wiring pass
        // to realize the RailMarker, so it can't sit in the neutral importer.
    }
}
#endif
