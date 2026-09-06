using UnityEngine;
using UdonSharp;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// The level's terrain as its ORIGINAL bicubic Bezier patches, for EXACT analytic ground contact - the board
    /// rides the true surface the PS2 used instead of the coarse faceted collider (terrain-render model, docs/021, [Trailmap: 400-rendering]).
    ///
    /// BOUNDED REFINE design. The faceted raycast identifies the patch and supplies a close (u,v) seed through the
    /// triangle's packed grid corners. A small allocation-free Newton solve then makes that bicubic point satisfy the
    /// probe ray itself. This is essential on tight lips: an unchanged triangle seed can evaluate 0.86-1.30 m sideways
    /// from the probe. The solve uses the exact analytic tangents already produced by PatchAndTangents and a scalar 2x2
    /// Jacobian perpendicular to the ray; it does no search, allocates no arrays, and is bounded by the generated ride
    /// contract.
    ///
    /// Built by <c>TerrainPatchBuilder</c> at import (one instance on <c>OpenSlope_Map/Collision/TerrainPatches</c>) from
    /// the same <c>Patches.json</c> snowknife tessellates. Flattened arrays + per-collider offsets, the same shape as
    /// <see cref="RailNetwork"/>. Control points are LOCAL (placed identity under Collision, so transform.TransformPoint
    /// maps to the identical world surface the colliders raycast); Start() world-bakes them ONCE. Results come back in
    /// public R* fields. The board calls <see cref="Refine"/> each ground probe with the faceted hit (ci/triangleIndex/
    /// barycentric); a prop (no patch) or a triangle with no mapping reports RFound=false and the board falls back.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public partial class TerrainPatches : UdonSharpBehaviour
    {
        [Tooltip("Every collidable patch's 16 control points, concatenated (patch p owns [p*16 .. p*16+16)), in this " +
                 "object's LOCAL space (-x,y,z, the collider-vertex space). Baked by TerrainPatchBuilder.")]
        public Vector3[] ControlPoints;
        [Tooltip("Tessellation quads/edge the collision mesh was built at (ImportConfig.TerrainRes, =4). Grid corner " +
                 "(u,v) = (iu/seg, iv/seg). Must be <=4 for the packed corner codes.")]
        public int seg = 4;
        [Tooltip("Per collision TRIANGLE: one packed int = patch | (corner0<<16) | (corner1<<21) | (corner2<<26), where " +
                 "cornerN = iu*(seg+1)+iv of that triangle's Nth vertex IN THE LOADED MESH'S VERTEX ORDER (so the hit's " +
                 "barycentric blends straight onto them). -1 = unmapped (fall back). Flattened across colliders; collider " +
                 "ci owns [TriStart[ci] .. TriStart[ci+1]). Baked by TerrainPatchBuilder.")]
        public int[] TriKey;
        [Tooltip("Per-collider start index into TriKey, in the SAME order the board caches its colliders (collisionRoot " +
                 "children that have a Collider). Length = collider count + 1 (last = TriKey.Length).")]
        public int[] TriStart;
        [Tooltip("Per patch x4 edges (0: u=0, 1: u=1, 2: v=0, 3: v=1): packed neighbour | (neighbourEdge<<16) | " +
                 "(flip<<18), -1 = level boundary / no unique partner. Lets MarchTo cross a patch seam. Baked by " +
                 "TerrainPatchBuilder; null on a pre-adjacency bake (march then clamps at every seam).")]
        public int[] PatchAdj;

        // ---- Refine results (read by the board after calling Refine) --------------------------------------
        [HideInInspector] public bool    RFound;   // the triangle mapped to a patch and we evaluated the surface
        [HideInInspector] public Vector3 RPoint;   // exact contact point on the true bicubic surface (world)
        [HideInInspector] public Vector3 RNormal;  // exact unit surface normal there (world), signed toward the probe
        [HideInInspector] public float   RRayResidual; // final perpendicular distance from patch point to probe ray (m)

        // Warm-start context from the last Refine, reused only by the bounded seam-recovery march. RHasPatch is false
        // whenever Refine hits a prop, an unmapped triangle, or a degenerate normal.
        [HideInInspector] public bool    RHasPatch;
        [HideInInspector] public int     RPatch;       // contact patch index (x16 = its control-point base in _cpW)
        [HideInInspector] public float   RU, RV;       // contact (u,v) within RPatch

        private Vector3[] _cpW;     // ControlPoints transformed to world (done once in Start; the level is static)
        private bool _ready, _failed;
        private Vector3 _evPu, _evPv; // PatchAndTangents result tangents (scratch; avoids out params)

        void Start() { Bake(); }

        void Bake()
        {
            if (_ready || _failed) return;
            if (ControlPoints == null || ControlPoints.Length < 16 || (ControlPoints.Length % 16) != 0 ||
                TriKey == null || TriStart == null || TriStart.Length < 2 || seg < 1)
            { _failed = true; return; }
            int np = ControlPoints.Length;
            _cpW = new Vector3[np];
            for (int i = 0; i < np; i++) _cpW[i] = transform.TransformPoint(ControlPoints[i]);
            _ready = true;
        }

        /// <summary>
        /// Exact contact on the true bicubic surface for a ground probe, from the faceted raycast hit. <paramref
        /// name="ci"/> is the board's collider index, <paramref name="tri"/> the RaycastHit.triangleIndex, <paramref
        /// name="bary"/> its barycentricCoordinate. Writes RFound/RPoint/RNormal. RFound=false => this triangle isn't a
        /// mapped terrain patch (prop / unmapped); the caller falls back. <paramref name="rayDir"/> (world, need not be
        /// unit) just orients the returned normal toward the probe (like the faceted hit normal).
        /// </summary>
        public void Refine(int ci, int tri, Vector3 bary, Vector3 flatPoint, Vector3 rayDir)
        {
            RFound = false; RHasPatch = false; RRayResidual = 1e9f;
            if (!_ready) { Bake(); if (!_ready) return; }
            if (ci < 0 || ci + 1 >= TriStart.Length || tri < 0) return;
            int k = TriStart[ci] + tri;
            if (k < 0 || k >= TriStart[ci + 1]) return;        // out of this collider's triangle range
            int key = TriKey[k];
            if (key < 0) return;                                // unmapped triangle -> fall back

            int patch = key & 0xFFFF;
            int c0 = (key >> 16) & 0x1F, c1 = (key >> 21) & 0x1F, c2 = (key >> 26) & 0x1F;
            int b16 = patch * 16;
            if (b16 + 15 >= _cpW.Length) return;
            int s1 = seg + 1;
            float inv = 1f / seg;
            // corner (u,v) of each of the triangle's 3 verts, in the loaded vertex order bary indexes.
            float u0 = (c0 / s1) * inv, v0 = (c0 % s1) * inv;
            float u1 = (c1 / s1) * inv, v1 = (c1 % s1) * inv;
            float u2 = (c2 / s1) * inv, v2 = (c2 % s1) * inv;
            float u = bary.x * u0 + bary.y * u1 + bary.z * u2;
            float v = bary.x * v0 + bary.y * v1 + bary.z * v2;

            Vector3 d = rayDir.sqrMagnitude > 1e-12f ? rayDir.normalized : Vector3.down;
            float ax = d.x < 0f ? -d.x : d.x, ay = d.y < 0f ? -d.y : d.y, az = d.z < 0f ? -d.z : d.z;
            Vector3 p = flatPoint;
            for (int it = 0; it < RIDE_ANALYTIC_NEWTON_ITERATIONS; it++)
            {
                p = PatchAndTangents(b16, u, v);
                float rx = p.x - flatPoint.x, ry = p.y - flatPoint.y, rz = p.z - flatPoint.z;
                float f0, f1, j00, j01, j10, j11;
                // Two independent components of cross(P-flatPoint, d) = 0. Selecting the dominant ray axis keeps
                // the 2x2 system well-scaled without constructing an orthonormal basis (important in Udon's VM).
                if (ay >= ax && ay >= az)
                {
                    f0 = rx * d.y - ry * d.x; f1 = rz * d.y - ry * d.z;
                    j00 = _evPu.x * d.y - _evPu.y * d.x; j01 = _evPv.x * d.y - _evPv.y * d.x;
                    j10 = _evPu.z * d.y - _evPu.y * d.z; j11 = _evPv.z * d.y - _evPv.y * d.z;
                }
                else if (ax >= az)
                {
                    f0 = ry * d.x - rx * d.y; f1 = rz * d.x - rx * d.z;
                    j00 = _evPu.y * d.x - _evPu.x * d.y; j01 = _evPv.y * d.x - _evPv.x * d.y;
                    j10 = _evPu.z * d.x - _evPu.x * d.z; j11 = _evPv.z * d.x - _evPv.x * d.z;
                }
                else
                {
                    f0 = rx * d.z - rz * d.x; f1 = ry * d.z - rz * d.y;
                    j00 = _evPu.x * d.z - _evPu.z * d.x; j01 = _evPv.x * d.z - _evPv.z * d.x;
                    j10 = _evPu.y * d.z - _evPu.z * d.y; j11 = _evPv.y * d.z - _evPv.z * d.y;
                }
                if (f0 * f0 + f1 * f1 < 1e-12f) break;
                float det = j00 * j11 - j01 * j10;
                if (det < 1e-10f && det > -1e-10f) return;
                float du = (-f0 * j11 + j01 * f1) / det;
                float dv = (f0 * j10 - j00 * f1) / det;
                float step = du < 0f ? -du : du; float av = dv < 0f ? -dv : dv; if (av > step) step = av;
                if (step > 0.5f) { float scale = 0.5f / step; du *= scale; dv *= scale; }
                u += du; v += dv;
            }

            p = PatchAndTangents(b16, u, v);
            Vector3 delta = p - flatPoint;
            float t = Vector3.Dot(delta, d);
            Vector3 off = delta - d * t;
            RRayResidual = off.magnitude;
            if (RRayResidual > RIDE_ANALYTIC_RAY_RESIDUAL_MAX || t * t > 25f ||
                u < -0.5f || u > 1.5f || v < -0.5f || v > 1.5f) return;
            Vector3 n = Vector3.Cross(_evPu, _evPv);
            if (n.sqrMagnitude < 1e-12f) return;
            n = n.normalized;
            RPatch = patch; RU = u; RV = v; RHasPatch = true;
            RPoint = flatPoint + d * t;                           // exactly on the probe; <1 mm from the solved patch
            RNormal = Vector3.Dot(d, n) > 0f ? -n : n;           // face the probe (opposite the ray direction)
            RFound = true;
        }

        /// <summary>
        /// RECOVERY march (docs/021): closest point on the analytic surface to <paramref name="target"/>, warm-started
        /// from the LAST contact's (RPatch, RU, RV). The board calls this on the tick its contact RAY misses (a chord
        /// gap / front-face reject on a wall or steep seam) so the ride keeps the true surface instead of dropping to
        /// the down-probe, which cannot see a wall beside it. It runs ONLY on ray-miss ticks, warm-started so 3
        /// Gauss-Newton steps converge (the contact moves ~0.04 in
        /// (u,v) per tick at top speed), each step one patch evaluation. Exiting [0,1]^2
        /// crosses to the neighbour through PatchAdj; a boundary/unmatched edge clamps. Writes the same R* fields as
        /// Refine; RFound=false (and RHasPatch=false, disarming further recovery) when there is no warm start, the
        /// tangents degenerate (a pole), or the result lands implausibly far - the caller falls back to the ray probes.
        /// </summary>
        public void MarchTo(Vector3 target)
        {
            RFound = false; RRayResidual = -1f; // recovery has no probe ray; never expose the previous ray solve's residual
            if (!_ready || !RHasPatch) { RHasPatch = false; return; }
            int patch = RPatch;
            float u = RU, v = RV;
            for (int it = 0; it < 3; it++)
            {
                int b = patch * 16;
                if (b < 0 || b + 15 >= _cpW.Length) { RHasPatch = false; return; }
                Vector3 p = PatchAndTangents(b, u, v);
                Vector3 r = target - p;
                // Gauss-Newton step for min |P(u,v) - target|^2: solve the 2x2 normal equations on the tangents.
                float guu = Vector3.Dot(_evPu, _evPu), guv = Vector3.Dot(_evPu, _evPv), gvv = Vector3.Dot(_evPv, _evPv);
                float det = guu * gvv - guv * guv;
                if (det < 1e-8f && det > -1e-8f) { RHasPatch = false; return; }   // degenerate tangents (pole/collapsed row)
                float ru = Vector3.Dot(_evPu, r), rv = Vector3.Dot(_evPv, r);
                float du = (ru * gvv - rv * guv) / det, dv = (guu * rv - guv * ru) / det;
                if (du > 0.5f) du = 0.5f; else if (du < -0.5f) du = -0.5f;        // bounded step: a bad Jacobian can't fling it
                if (dv > 0.5f) dv = 0.5f; else if (dv < -0.5f) dv = -0.5f;
                u += du; v += dv;
                // Cross at most two seams per step (a corner exit crosses one axis, then the other).
                for (int x = 0; x < 2; x++)
                {
                    int edge; float s, t;
                    if      (u < 0f) { edge = 0; s = -u;      t = v; }
                    else if (u > 1f) { edge = 1; s = u - 1f;  t = v; }
                    else if (v < 0f) { edge = 2; s = -v;      t = u; }
                    else if (v > 1f) { edge = 3; s = v - 1f;  t = u; }
                    else break;
                    int ai = patch * 4 + edge;
                    int adj = (PatchAdj != null && ai >= 0 && ai < PatchAdj.Length) ? PatchAdj[ai] : -1;
                    if (adj < 0)
                    {   // level boundary / unmatched seam: stay on this patch's border (the ray fallback owns beyond)
                        if (u < 0f) u = 0f; else if (u > 1f) u = 1f;
                        if (v < 0f) v = 0f; else if (v > 1f) v = 1f;
                        break;
                    }
                    if (s > 1f) s = 1f;                                  // don't overshoot past the neighbour too
                    int ne = (adj >> 16) & 3;
                    if (((adj >> 18) & 1) == 1) t = 1f - t;              // the shared curve runs opposite over there
                    if      (ne == 0) { u = s;      v = t; }             // enter across the neighbour's u=0 edge...
                    else if (ne == 1) { u = 1f - s; v = t; }
                    else if (ne == 2) { v = s;      u = t; }
                    else              { v = 1f - s; u = t; }
                    patch = adj & 0xFFFF;
                }
            }
            int bf = patch * 16;
            if (bf < 0 || bf + 15 >= _cpW.Length) { RHasPatch = false; return; }
            Vector3 pf = PatchAndTangents(bf, u, v);
            Vector3 n = Vector3.Cross(_evPu, _evPv);
            if (n.sqrMagnitude < 1e-12f) { RHasPatch = false; return; }
            n = n.normalized;
            Vector3 off = target - pf;
            if (off.sqrMagnitude > 16f) { RHasPatch = false; return; }   // >4 m off the surface: lost it - no fake contact
            if (Vector3.Dot(n, off) < 0f) n = -n;                        // face the board, like the probe normals
            RPatch = patch; RU = u; RV = v;
            RPoint = pf; RNormal = n;
            RFound = true; RHasPatch = true;
        }

        // ---- bicubic Bezier on the WORLD-baked control points (row-major, matches snowknife Bezier.Patch) ----
        static Vector3 Pt4(Vector3 a, Vector3 bb, Vector3 cc, Vector3 dd, float t)
        {
            float s = 1f - t;
            return s * s * s * a + 3f * s * s * t * bb + 3f * s * t * t * cc + t * t * t * dd;
        }
        static Vector3 Dv4(Vector3 a, Vector3 bb, Vector3 cc, Vector3 dd, float t)
        {
            float s = 1f - t;
            return 3f * s * s * (bb - a) + 6f * s * t * (cc - bb) + 3f * t * t * (dd - cc);
        }

        // Point + the two surface tangents at (u,v) -> _evPu/_evPv (scratch); returns the point. Their cross is the normal.
        Vector3 PatchAndTangents(int b, float u, float v)
        {
            Vector3 r0 = Pt4(_cpW[b], _cpW[b + 1], _cpW[b + 2], _cpW[b + 3], v);
            Vector3 r1 = Pt4(_cpW[b + 4], _cpW[b + 5], _cpW[b + 6], _cpW[b + 7], v);
            Vector3 r2 = Pt4(_cpW[b + 8], _cpW[b + 9], _cpW[b + 10], _cpW[b + 11], v);
            Vector3 r3 = Pt4(_cpW[b + 12], _cpW[b + 13], _cpW[b + 14], _cpW[b + 15], v);
            _evPu = Dv4(r0, r1, r2, r3, u);
            Vector3 d0 = Dv4(_cpW[b], _cpW[b + 1], _cpW[b + 2], _cpW[b + 3], v);
            Vector3 d1 = Dv4(_cpW[b + 4], _cpW[b + 5], _cpW[b + 6], _cpW[b + 7], v);
            Vector3 d2 = Dv4(_cpW[b + 8], _cpW[b + 9], _cpW[b + 10], _cpW[b + 11], v);
            Vector3 d3 = Dv4(_cpW[b + 12], _cpW[b + 13], _cpW[b + 14], _cpW[b + 15], v);
            _evPv = Pt4(d0, d1, d2, d3, u);
            return Pt4(r0, r1, r2, r3, u);
        }
    }
}
