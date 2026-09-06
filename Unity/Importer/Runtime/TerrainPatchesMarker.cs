using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for the analytic terrain-contact patches (docs/021): the board rides the level's ORIGINAL bicubic
    // patches instead of the faceted collider. TerrainPatchBuilder bakes, per collision triangle, a packed patch+corner
    // code (the cheap-eval table) and tags a holder under Collision with this marker; the platform wiring pass realizes
    // the runtime patches behaviour and points every rideable board at it. Field names mirror the behaviour's.
    public sealed class TerrainPatchesMarker : Marker
    {
        public Vector3[] ControlPoints;   // 16 mesh-local control points per collidable patch, flattened
        public int seg;                   // patch tessellation resolution (matches the corner codes)
        public int[] TriKey;              // per-triangle packed patch + 3 corner grid codes (board collider order)
        public int[] TriStart;            // per-collider start offset into TriKey (+ sentinel)
        public int[] PatchAdj;            // per patch x4 edges: packed neighbour | (neighbourEdge<<16) | (flip<<18); -1 = none
    }
}
