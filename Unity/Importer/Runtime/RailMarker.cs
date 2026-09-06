using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for a rail network - either the grind rails ("Rails") or the out-of-bounds course line
    // ("CoursePath"), which share one polyline+nearest-point shape (docs/026, docs/011). The importer (RailBuilder /
    // CoursePathBuilder) bakes the bundle polylines onto this marker; the platform wiring pass realizes it into the
    // runtime rail-network behaviour the board queries. DistToFinish/CourseLength are the course-progress fields that
    // CourseProgressBuilder stamps onto the CoursePath marker (left null on the grind rails). Field names mirror the
    // behaviour's, so the wiring pass copies them across by name.
    public sealed class RailMarker : Marker
    {
        public Vector3[] LocalPoints;        // all rail vertices, flattened, in level-local space
        public int[] RailStart;              // per-rail start index into LocalPoints
        public int[] RailCount;              // per-rail vertex count
        public int[] RailStyle;              // source SplineStyle per rail; null in older bundles (runtime defaults to 13)
        public Vector3[] SegControlPoints;   // source cubic Bezier control points (4 per segment); null on the course line
        public int[] SegStart;               // per-rail first segment
        public int[] SegCount;               // per-rail segment count
        public int SamplesPerSegment;        // sampling density used to build LocalPoints from the cubics
        public int[] StartDisabledRails;     // gameplay-gated rail indices that start non-grindable
        public int[] ShowoffRails;            // rails present/grindable only in show-off mode (HideShowOff targets)
        public bool ShowoffStartsDisabled;    // legacy/default preview policy; runtime mode selection may enable them

        public float[] DistToFinish;         // per-point distance-to-finish (course line only; NaN on non-race points)
        public float CourseLength;           // start-to-finish normalizer (course line only)
        public Vector3[] CheckpointLocalPoints; // SOP type-11 event positions (course line only)
        public float[] CheckpointDtf;          // remaining DTF at each event, metres
        public int[] CheckpointBonus;          // seconds payload for each route event
        public int[] CheckpointGroup;          // alternate-route copies share one logical group

        // The level's finish ARCH (Mdl_FinnishGate_*, straddling the DTF=0 crossing), local-space AABB - course line only.
        // Sizes the finish trigger (LeaderboardSetup). Size == 0 means the bundle carries no arch.
        public Vector3 FinishArchCenter;
        public Vector3 FinishArchSize;
    }
}
