#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // COURSE PATH for out-of-bounds reset (the "put me back ON the course" data the game actually used).
    //
    // SSX courses ship path tables in DATA AIP.json / SOP.json (decoded into the export, docs/011):
    //   - RaceLines (the ordered course spine) and the Respawnable AIPaths ("where a fallen rider gets put back").
    // snowknife bakes those into world-space polylines (PathPos seed + cumulative PathPoint deltas, the same
    // -x,y,z handedness flip + level-root transform as all geometry, docs/unity/004) and ships them in the bundle
    // (manifest.Paths.Course; see Snowknife docs/034).
    //
    // We don't need a new runtime type: a course line is just a polyline with a nearest-point query, which is
    // exactly what the rail network already provides (Query -> RPoint/RTangent). So Build() bakes the bundle's
    // lines into a SECOND rail network on a CoursePath child of the level root; the rideable board auto-finds
    // it and, on out-of-bounds, snaps the rider to the nearest point on the nearest course line (in-bounds,
    // pointing down-course) instead of teleporting to spawn - loop-proof, unlike a breadcrumb that drops you
    // back on the fall-line above a mid-course Reset patch. See the rideable board + docs/011.
    //
    // Mirrors the other builder services (ctor takes config, Build(root) does the work); also exposed as a
    // standalone menu item so the course path can be (re)baked into an already-imported scene without a full
    // re-import.
    public class CoursePathBuilder
    {
        readonly ImportConfig _cfg;
        public CoursePathBuilder(ImportConfig cfg) { _cfg = cfg; }

        public void Build(Transform root)
        {
            var bundle = new BundleManifestReader(_cfg);
            if (bundle.Exists && bundle.Course != null && bundle.Course.Points.Length > 0)
            {
                var marker = RailBuilder.BuildNetworkFromBundle(root, "CoursePath", bundle.Course);
                Debug.Log($"OpenSlope: course path from bundle -> {bundle.Course.Start.Length} lines, {bundle.Course.Points.Length} points.");

                // Stamp the authored distance-to-finish progress field onto the marker we just built
                // (CourseProgressBuilder). The realized network carries it; the board reads it for live run %.
                if (marker != null) CourseProgressBuilder.Stamp(marker, bundle.Course.LineDtf, bundle.Course.RaceLineCount);
                if (marker != null) CourseProgressBuilder.StampCheckpoints(marker, bundle.Course.Checkpoints);

                // ... and the level's finish arch (Mdl_FinnishGate_*), which straddles the DTF=0 crossing. It sizes the
                // leaderboard's finish trigger, so the box comes from the course's own geometry (docs/050).
                if (marker != null && bundle.Course.FinishArch != null)
                {
                    marker.FinishArchCenter = bundle.Course.FinishArch.Center;
                    marker.FinishArchSize = bundle.Course.FinishArch.Size;
                }
            }
            else Debug.Log("OpenSlope: no course path in the bundle - skipping (OOB reset falls back to the breadcrumb trail).");
        }

        // OpenSlope/Refresh/Course Path lives in VRC (the platform Refresh menus): re-baking into a loaded map needs the wiring pass to
        // realize the RailMarker, so it can't sit in the neutral importer.
    }
}
#endif
