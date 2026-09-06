#if UNITY_EDITOR
using UnityEngine;

namespace OpenSlope.Importer
{

    // COURSE PROGRESS (distance-to-finish) bake. Stamps a per-point distance-to-finish (metres) onto the CoursePath
    // RailMarker so the realized rail network lets the rideable board read a rider's live course progress (the
    // foundation for race standings / splits / a run-% HUD). docs/050.
    //
    // This is the engine's OWN progress metric (Trailmap 250/390): in SSX every race-line point carries a distance-to-finish
    // and a rider's position is the nearest point's stored value. We carry the game's AUTHORED per-race-line DistanceToFinish
    // through the bundle (snowknife PathBundle -> manifest.Paths.Course.LineDtf + RaceLineCount) and reconstruct the continuous
    // per-point metric exactly as the engine does: each race line is anchored at its authored DTF, minus the horizontal
    // arc-length walked along it. Race lines only; AI/respawn lines are excluded. Stamped when CoursePathBuilder builds the
    // course path (map import / the VRC Refresh menus). A level whose bundle predates the DTF carry has no LineDtf ->
    // regenerate it (snowknife gltf <level>) and re-import.
    public static class CourseProgressBuilder
    {
        // Stamp the game's authored distance-to-finish onto the course marker. Called by CoursePathBuilder at build time.
        // No authored DTF in the bundle -> log + skip (regenerate the bundle with the DTF-carrying snowknife).
        public static void Stamp(RailMarker marker, float[] lineDtf, int raceLineCount)
        {
            if (marker == null || marker.LocalPoints == null || marker.LocalPoints.Length < 2) return;
            if (lineDtf != null && lineDtf.Length > 0 && raceLineCount > 0) { StampAuthored(marker, lineDtf, raceLineCount); return; }
            Debug.LogWarning("OpenSlope: Course Progress - the bundle carries no authored DistanceToFinish (LineDtf); the progress " +
                             "metric is OFF for this level. Regenerate its bundle with `snowknife gltf <level>` and re-import.");
        }

        // Carry the SOP type-11 stations onto the neutral marker. Positions stay root-local like the course
        // points; DTF scales into world metres so the runtime can compare it directly with PDistToFinish.
        public static void StampCheckpoints(RailMarker marker, BundleManifestReader.CourseCheckpoint[] checkpoints)
        {
            if (marker == null || checkpoints == null || checkpoints.Length == 0) return;
            float scale = Mathf.Abs(marker.transform.lossyScale.x);
            if (scale < 1e-6f) scale = 1f;
            int n = checkpoints.Length;
            marker.CheckpointLocalPoints = new Vector3[n];
            marker.CheckpointDtf = new float[n];
            marker.CheckpointBonus = new int[n];
            marker.CheckpointGroup = new int[n];
            for (int i = 0; i < n; i++)
            {
                marker.CheckpointLocalPoints[i] = checkpoints[i].Position;
                marker.CheckpointDtf[i] = checkpoints[i].Dtf * scale;
                marker.CheckpointBonus[i] = checkpoints[i].BonusSeconds;
                marker.CheckpointGroup[i] = checkpoints[i].Group;
            }
        }

        // Each race line is anchored at its authored distance-to-finish (engine units, from the AIP/SOP file via the bundle)
        // and per-point DTF is that anchor minus the horizontal (XZ) arc-length walked along the line - exactly how the engine
        // derives a continuous DTF from the per-line-start value (Trailmap 250). Race lines are the FIRST `raceLineCount` rails
        // (the bundle bakes them first); AI/respawn lines get NaN so QueryProgress ignores them. Progress is normalized against
        // the StageArea_Start gate (so the gate reads 0), else the top race line's anchor.
        public static void StampAuthored(RailMarker marker, float[] lineDtf, int raceLineCount)
        {
            int n = marker.LocalPoints.Length;
            var world = new Vector3[n];
            for (int i = 0; i < n; i++) world[i] = marker.transform.TransformPoint(marker.LocalPoints[i]);
            float scale = Mathf.Abs(marker.transform.lossyScale.x);        // engine units -> world metres (~0.01; uniform level scale)
            if (scale < 1e-6f) scale = 1f;

            var dtf = new float[n];
            for (int i = 0; i < n; i++) dtf[i] = float.NaN;                 // default = "not a race-line point" (AI/respawn lines)
            float maxStart = 0f; int stamped = 0;
            int lines = Mathf.Min(raceLineCount, marker.RailStart.Length);
            for (int r = 0; r < lines; r++)
            {
                if (r >= lineDtf.Length || float.IsNaN(lineDtf[r])) continue;
                int s = marker.RailStart[r], c = marker.RailCount[r];
                if (c < 2 || s < 0 || s + c > n) continue;
                float startM = lineDtf[r] * scale;
                if (startM > maxStart) maxStart = startM;
                float acc = 0f;
                dtf[s] = startM;
                for (int j = 1; j < c; j++)
                {
                    Vector3 a = world[s + j - 1], b = world[s + j];
                    acc += Mathf.Sqrt((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z));   // horizontal only
                    dtf[s + j] = startM - acc;                              // may dip below 0 on the finish line (overshoot) - fine
                }
                stamped++;
            }

            // Normalizer = the START gate marker's distance (so the gate reads progress 0), else the top race line's anchor.
            // Points above the gate (a lead-in) just clamp to 0.
            float normalizer = maxStart;
            Vector3 start;
            if (TryFindMarker("StageArea_Start", out start))
            {
                int si = -1; float sb = float.PositiveInfinity;
                for (int i = 0; i < n; i++) { if (float.IsNaN(dtf[i])) continue; float h = HDist(world[i], start); if (h < sb) { sb = h; si = i; } }
                if (si >= 0 && dtf[si] > 1f) normalizer = dtf[si];
            }

            marker.DistToFinish = dtf;
            marker.CourseLength = normalizer;
            Debug.Log($"OpenSlope: Course Progress (AUTHORED) baked on {marker.name} - {stamped}/{lines} race lines anchored from the " +
                      $"game's DistanceToFinish; start-to-finish {normalizer:F0} m (max anchor {maxStart:F0}). " +
                      "(AI/respawn lines excluded from progress.)");
        }

        // Horizontal (XZ) distance - the engine's progress metric ignores vertical (Trailmap 250).
        static float HDist(Vector3 a, Vector3 b) { float dx = a.x - b.x, dz = a.z - b.z; return Mathf.Sqrt(dx * dx + dz * dz); }

        // First scene object whose name contains `sub` (a StageArea marker), at its collider-bounds centre (the import brings
        // them in as Bounds_Mdl_StageArea_Start/Finish_*). Editor-time only.
        static bool TryFindMarker(string sub, out Vector3 pos)
        {
            pos = Vector3.zero;
            var all = Object.FindObjectsOfType<Transform>(true);
            for (int i = 0; i < all.Length; i++)
            {
                if (all[i].name.IndexOf(sub, System.StringComparison.OrdinalIgnoreCase) < 0) continue;
                var col = all[i].GetComponent<Collider>();
                pos = col != null ? col.bounds.center : all[i].position;
                return true;
            }
            return false;
        }
    }
}
#endif
