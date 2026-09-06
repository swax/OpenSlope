using UnityEngine;
using OpenSlope.Importer;

namespace OpenSlope.BasisPlugin
{

    /// <summary>
    /// The level's grind-rail network, ported to Basis (plain C# MonoBehaviour) - the Basis analogue of the VRChat
    /// <c>RailNetwork</c>. The authored SSX rail splines (DATA <c>Splines.json</c>, normally <c>SplineStyle 13</c>,
    /// plus named exceptions such as Alaska's style-5 IceRails) baked into flattened polylines, plus the nearest-rail query
    /// the rideable board uses to grind them. Built by the neutral <c>RailBuilder</c> at import time as an
    /// <c>RailMarker</c>, which <c>BasisWiring</c> realizes onto this behaviour (one instance, on
    /// <c>OpenSlope_Map/Rails</c>); see docs/026 / docs/basis.
    ///
    /// The board has no rail data of its own: each frame it asks THIS object where the nearest rail is (<see cref="Query"/>
    /// to lock on, <see cref="QueryRail"/> to follow the one it's grinding). Results come back in public fields (R*), not
    /// return values / out-params, mirroring the VRChat behaviour exactly (the marker seam + query surface are
    /// platform-agnostic, so the port is line-for-line).
    ///
    /// DATA SHAPE. <see cref="LocalPoints"/> is every rail's sampled points concatenated; rail r owns the range
    /// [RailStart[r] .. RailStart[r]+RailCount[r]) and its segments are the consecutive pairs in that range. Points are in
    /// this object's LOCAL space (the importer bakes them as -x,y,z under the level root, which carries the -90 X / 0.01
    /// scale); Start() transforms them to world ONCE (the level is static) and bins the segments into a uniform XZ grid so
    /// the query broad-phases with cheap nearby-cell tests instead of scanning every rail.
    ///
    /// CUBIC CURVE (rails only). Alongside the sampled polyline, rails carry their SOURCE cubic bezier
    /// (<see cref="SegControlPoints"/>, 4/segment) so the FOLLOW query (<see cref="QueryRail"/>) rides the analytic curve
    /// instead of the chords: it brackets with the cheap polyline, then golden-section refines the closest point on the real
    /// cubic and returns the EXACT tangent P'(t) - matching the PS2 engine (docs/026) [Trailmap: 350-rails]. The broad
    /// lock-on scan (<see cref="Query"/>) stays on chords. The course-path network leaves the cubic arrays null and the
    /// whole object falls back to chords.
    /// </summary>
    public class BasisRailNetwork : MonoBehaviour
    {
        [Tooltip("All rails' sampled spline points, concatenated, in this object's LOCAL space (the importer " +
                 "bakes them -x,y,z under the level root). Baked by RailBuilder.")]
        public Vector3[] LocalPoints;
        [Tooltip("Per-rail start index into LocalPoints. Length = rail count.")]
        public int[] RailStart;
        [Tooltip("Per-rail point count. Rail r's segments are the consecutive pairs in [RailStart[r] .. +RailCount[r]).")]
        public int[] RailCount;
        [Tooltip("Source SplineStyle per rail: the surface response row used while grinding. Older bundles default to 13 (metal).")]
        public int[] RailStyle;

        // ---- source cubic bezier (rails only; null/0 = chord fallback, e.g. the course path) -----------------
        [Tooltip("The rails' SOURCE cubic bezier control points, 4 per segment, in this object's LOCAL space. " +
                 "Segment g uses [g*4 .. g*4+4). Lets QueryRail ride the analytic curve. Baked by RailBuilder.")]
        public Vector3[] SegControlPoints;
        [Tooltip("Per-rail first cubic-segment index into SegControlPoints/4. Length = rail count.")]
        public int[] SegStart;
        [Tooltip("Per-rail cubic-segment count.")]
        public int[] SegCount;
        [Tooltip("How LocalPoints was sampled (points/segment). Maps a polyline chord back to its cubic segment + t. 0 = no cubic.")]
        public int SamplesPerSegment;

        // ---- runtime-gated rails (SSX MainType-25 rail toggle, docs/026) --------------------------------------
        // Rail indices that start NOT grindable and only become grindable when a rail gate fires (e.g. a fallen-tree
        // trunk). Baked by RailBuilder from the bundle; empty on a level that authors none. Query/AnyRailNear skip a
        // disabled rail's chords, so a gated rail is invisible to lock-on until SetRailEnabled turns it on.
        [Tooltip("Rail indices that start disabled (grindable only after a rail gate enables them). Baked by RailBuilder.")]
        public int[] StartDisabledRails;
        public int[] ShowoffRails;
        public bool ShowoffStartsDisabled;

        // ---- Query results (read by the board AFTER calling Query / QueryRail) ------------------------------
        [HideInInspector] public bool    RFound;    // a rail was found within range
        [HideInInspector] public int     RRail;     // index of the found/queried rail
        [HideInInspector] public Vector3 RPoint;    // closest point ON the rail (world)
        [HideInInspector] public Vector3 RTangent;  // unit rail direction at that point (world; sign is the segment's a->b)
        [HideInInspector] public float   RDist;     // distance from the query pos to RPoint (world m)
        [HideInInspector] public int     RSurface;  // source SplineStyle for RRail; 13 when an older bundle has no styles
        [HideInInspector] public bool    RAtStart;  // QueryRail: closest point is clamped to the rail's FIRST vertex
        [HideInInspector] public bool    RAtEnd;    // QueryRail: closest point is clamped to the rail's LAST vertex

        // ---- course PROGRESS (distance-to-finish), baked ONLY on the CoursePath network (null on the rails net) ----------
        // Per-point distance-to-finish in metres (parallel to LocalPoints), baked by CourseProgressBuilder. Kept for parity
        // with the VRChat network; the board's grinding never reads it.
        [Tooltip("Per-point distance-to-finish (m), parallel to LocalPoints. Baked by CourseProgressBuilder. null = no progress data.")]
        public float[] DistToFinish;
        [Tooltip("Total course length (m) = max DistToFinish; the normalizer for PProgress01. 0 = no progress data.")]
        public float CourseLength;
        // Neutral course checkpoint carry. Basis does not yet run a showoff countdown, but retaining the same
        // marker field names prevents the platform wire from discarding the authored SOP stations.
        public Vector3[] CheckpointLocalPoints;
        public float[] CheckpointDtf;
        public int[] CheckpointBonus;
        public int[] CheckpointGroup;
        // The level's finish ARCH (Mdl_FinnishGate_*), a local-space AABB straddling the DTF=0 crossing. Carried for parity
        // with the VRChat network (whose leaderboard setup sizes its finish trigger from it); nothing on Basis reads it.
        [Tooltip("Finish-arch AABB centre, local space (course path only). Baked by CoursePathBuilder.")]
        public Vector3 FinishArchCenter;
        [Tooltip("Finish-arch AABB size, local space (course path only). Zero = no arch in the bundle.")]
        public Vector3 FinishArchSize;
        [HideInInspector] public bool    PFound;        // QueryProgress: a course point was within range
        [HideInInspector] public float   PDistToFinish; // metres to the finish at the rider's projected point
        [HideInInspector] public float   PProgress01;   // 0 at the start .. 1 at the finish

        // World-space bake (done once in Start; the level is static).
        private Vector3[] _world;     // LocalPoints transformed to world
        private Vector3[] _segWorld;  // SegControlPoints transformed to world (null if no cubic)
        private bool      _hasCubic;  // cubic data present + consistent
        private bool[]    _railValid; // per-rail: false if its [start,count] range is degenerate
        private bool[]    _railEnabled; // per-rail: false = runtime-gated OFF (MainType-25)
        private bool[]    _railModeEnabled; // independent HideShowOff gate
        private int       _railN;     // rail count
        private bool      _ready;

        // Scratch outputs of the shared closest-point-on-rail helper (avoids out-params).
        private Vector3 _cPoint;
        private Vector3 _cTangent;
        private float   _cDist;
        private bool    _cAtStart;
        private bool    _cAtEnd;
        private int     _cChord;      // rail-local index of the winning chord (for the cubic refine)

        // ---- segment SPATIAL GRID (the lock-on broad-phase) ------------------------------------------------------
        // Every segment ("chord") is binned into a uniform XZ grid by its AABB, so Query/AnyRailNear test only the handful
        // of chords in the cells near the query point instead of all rails x their segments every frame. CSR layout (no
        // per-query allocation); a visit stamp dedups chords spanning several cells.
        private const float GridCell = 12f;   // base cell size (m); auto-grown if the level span would exceed _gridMaxDim
        private const int   _gridMaxDim = 256;
        private int   _gnx, _gnz;             // grid dimensions
        private float _gminX, _gminZ, _gcell; // grid origin (world XZ) + effective cell size
        private bool  _gridReady;
        private int[] _cellStart;             // CSR: per-cell start index into _cellItems (length _gnx*_gnz + 1)
        private int[] _cellItems;             // CSR: global chord indices, grouped by cell
        private int[] _chordP0;               // per global chord: _world index of its first point (second = +1)
        private int[] _chordRail;             // per global chord: owning rail index
        private int[] _chordLocal;            // per global chord: rail-local chord index (for the cubic refine)
        private int[] _visit;                 // per global chord: last query stamp that touched it (dedup across cells)
        private int   _visitTok;              // monotonic query stamp
        private int   _chordN;

        void Start()
        {
            Bake();
        }

        // Transform the baked local points to world and build the segment grid. Idempotent and self-healing (re-runs if the
        // arrays weren't ready at Start) so the board can call Query before our Start.
        void Bake()
        {
            if (_ready) return;
            if (LocalPoints == null || RailStart == null || RailCount == null ||
                RailStart.Length == 0 || RailStart.Length != RailCount.Length)
            {
                _ready = false; _railN = 0; return;
            }
            int np = LocalPoints.Length;
            _world = new Vector3[np];
            for (int i = 0; i < np; i++) _world[i] = transform.TransformPoint(LocalPoints[i]);

            _railN = RailStart.Length;

            _hasCubic = SegControlPoints != null && SegControlPoints.Length >= 4 && SamplesPerSegment >= 2 &&
                        SegStart != null && SegCount != null &&
                        SegStart.Length == _railN && SegCount.Length == _railN;
            if (_hasCubic)
            {
                int ns = SegControlPoints.Length;
                _segWorld = new Vector3[ns];
                for (int i = 0; i < ns; i++) _segWorld[i] = transform.TransformPoint(SegControlPoints[i]);
            }
            else _segWorld = null;

            _railValid = new bool[_railN];
            for (int r = 0; r < _railN; r++)
            {
                int s = RailStart[r], c = RailCount[r];
                _railValid[r] = c > 0 && s >= 0 && s + c <= np;
            }

            _railEnabled = new bool[_railN];
            _railModeEnabled = new bool[_railN];
            for (int r = 0; r < _railN; r++) { _railEnabled[r] = true; _railModeEnabled[r] = true; }
            if (StartDisabledRails != null)
                for (int i = 0; i < StartDisabledRails.Length; i++)
                {
                    int r = StartDisabledRails[i];
                    if (r >= 0 && r < _railN) _railEnabled[r] = false;
                }
            if (ShowoffStartsDisabled && ShowoffRails != null)
                for (int i = 0; i < ShowoffRails.Length; i++)
                {
                    int r = ShowoffRails[i];
                    if (r >= 0 && r < _railN) _railModeEnabled[r] = false;
                }

            BuildGrid(np);
            _ready = true;
        }

        // Turn a runtime-gated rail on (or off). Called by a rail gate when the rider crosses the trigger that makes a
        // MainType-25 rail grindable. Cheap: flips a bool the lock-on query reads - no grid rebuild.
        public void SetRailEnabled(int rail, bool on)
        {
            if (!_ready) { Bake(); if (!_ready) return; }
            if (_railEnabled != null && rail >= 0 && rail < _railEnabled.Length) _railEnabled[rail] = on;
        }

        public void SetShowoffEnabled(bool on)
        {
            if (!_ready) { Bake(); if (!_ready) return; }
            if (ShowoffRails == null || _railModeEnabled == null) return;
            for (int i = 0; i < ShowoffRails.Length; i++)
            {
                int r = ShowoffRails[i];
                if (r >= 0 && r < _railModeEnabled.Length) _railModeEnabled[r] = on;
            }
        }

        // Bin every valid segment ("chord") into a uniform XZ grid (CSR) so the lock-on query touches only nearby segments.
        void BuildGrid(int np)
        {
            _gridReady = false;
            int g = 0;
            for (int r = 0; r < _railN; r++) { if (!_railValid[r]) continue; int c = RailCount[r]; if (c >= 2) g += c - 1; }
            _chordN = g;
            if (_chordN <= 0) return;
            _chordP0 = new int[_chordN]; _chordRail = new int[_chordN]; _chordLocal = new int[_chordN];
            int gi = 0;
            for (int r = 0; r < _railN; r++)
            {
                if (!_railValid[r]) continue;
                int s = RailStart[r]; int c = RailCount[r];
                for (int j = 0; j < c - 1; j++) { _chordP0[gi] = s + j; _chordRail[gi] = r; _chordLocal[gi] = j; gi++; }
            }

            float minX = 1e9f, minZ = 1e9f, maxX = -1e9f, maxZ = -1e9f;
            for (int i = 0; i < np; i++)
            {
                Vector3 w = _world[i];
                if (w.x < minX) minX = w.x; if (w.x > maxX) maxX = w.x;
                if (w.z < minZ) minZ = w.z; if (w.z > maxZ) maxZ = w.z;
            }
            if (maxX < minX) return;
            float spanX = maxX - minX, spanZ = maxZ - minZ;
            float cell = GridCell;
            if (spanX / _gridMaxDim > cell) cell = spanX / _gridMaxDim;
            if (spanZ / _gridMaxDim > cell) cell = spanZ / _gridMaxDim;
            if (cell < 0.01f) cell = 12f;
            _gminX = minX; _gminZ = minZ; _gcell = cell;
            _gnx = Mathf.CeilToInt(spanX / cell) + 1; if (_gnx < 1) _gnx = 1;
            _gnz = Mathf.CeilToInt(spanZ / cell) + 1; if (_gnz < 1) _gnz = 1;
            int cells = _gnx * _gnz;

            var counts = new int[cells];
            for (int q = 0; q < _chordN; q++)
            {
                int ia = _chordP0[q]; Vector3 a = _world[ia]; Vector3 b = _world[ia + 1];
                int cx0 = CellX(Mathf.Min(a.x, b.x)), cx1 = CellX(Mathf.Max(a.x, b.x));
                int cz0 = CellZ(Mathf.Min(a.z, b.z)), cz1 = CellZ(Mathf.Max(a.z, b.z));
                for (int cz = cz0; cz <= cz1; cz++) for (int cx = cx0; cx <= cx1; cx++) counts[cz * _gnx + cx]++;
            }
            _cellStart = new int[cells + 1];
            int run = 0;
            for (int i = 0; i < cells; i++) { _cellStart[i] = run; run += counts[i]; }
            _cellStart[cells] = run;
            _cellItems = new int[run];
            var cursor = new int[cells];
            for (int i = 0; i < cells; i++) cursor[i] = _cellStart[i];
            for (int q = 0; q < _chordN; q++)
            {
                int ia = _chordP0[q]; Vector3 a = _world[ia]; Vector3 b = _world[ia + 1];
                int cx0 = CellX(Mathf.Min(a.x, b.x)), cx1 = CellX(Mathf.Max(a.x, b.x));
                int cz0 = CellZ(Mathf.Min(a.z, b.z)), cz1 = CellZ(Mathf.Max(a.z, b.z));
                for (int cz = cz0; cz <= cz1; cz++) for (int cx = cx0; cx <= cx1; cx++) { int ci = cz * _gnx + cx; _cellItems[cursor[ci]] = q; cursor[ci]++; }
            }
            _visit = new int[_chordN]; _visitTok = 0;
            _gridReady = true;
        }

        int CellX(float x) { int c = Mathf.FloorToInt((x - _gminX) / _gcell); return c < 0 ? 0 : (c >= _gnx ? _gnx - 1 : c); }
        int CellZ(float z) { int c = Mathf.FloorToInt((z - _gminZ) / _gcell); return c < 0 ? 0 : (c >= _gnz ? _gnz - 1 : c); }

        // Nearest rail to 'pos' within 'maxDist' (world m). The spatial grid tests only the segments in the cells near
        // 'pos'; chord math (no cubic refine) is enough for lock-on gating. Results -> R*; RFound false if nothing in range.
        // The grid is the ONLY lock-on path (no brute-force fallback), so a broken grid fails loud instead of silently
        // restoring the all-rails scan. Used by the board to decide when to LOCK ON.
        public void Query(Vector3 pos, float maxDist)
        {
            RFound = false; RRail = -1; RSurface = 13; RDist = 1e9f;
            if (!_ready) { Bake(); if (!_ready) return; }
            float best = maxDist;
            if (_gridReady)
            {
                int cx0 = CellX(pos.x - maxDist), cx1 = CellX(pos.x + maxDist);
                int cz0 = CellZ(pos.z - maxDist), cz1 = CellZ(pos.z + maxDist);
                _visitTok++;
                for (int cz = cz0; cz <= cz1; cz++)
                for (int cx = cx0; cx <= cx1; cx++)
                {
                    int cell = cz * _gnx + cx;
                    int end = _cellStart[cell + 1];
                    for (int k = _cellStart[cell]; k < end; k++)
                    {
                        int q = _cellItems[k];
                        if (_visit[q] == _visitTok) continue;
                        _visit[q] = _visitTok;
                        if (_railEnabled != null && (!_railEnabled[_chordRail[q]] || !_railModeEnabled[_chordRail[q]])) continue;
                        int ia = _chordP0[q];
                        Vector3 a = _world[ia], b = _world[ia + 1], ab = b - a;
                        float len2 = ab.sqrMagnitude;
                        float t = len2 > 1e-10f ? Vector3.Dot(pos - a, ab) / len2 : 0f;
                        if (t < 0f) t = 0f; else if (t > 1f) t = 1f;
                        Vector3 cp = a + ab * t;
                        float d = (pos - cp).magnitude;
                        if (d < best)
                        {
                            best = d; RFound = true; RRail = _chordRail[q];
                            RSurface = SurfaceForRail(RRail);
                            RPoint = cp; RTangent = len2 > 1e-10f ? ab / Mathf.Sqrt(len2) : Vector3.forward; RDist = d;
                            _cChord = _chordLocal[q];
                        }
                    }
                }
                return;
            }
        }

        // Cheap gate: is ANY rail segment within 'reach' (world m) of 'pos'? Grid-accelerated, no fallback. The caller
        // passes a 'reach' that already covers its probe offsets so a catchable rail is never gated out.
        public bool AnyRailNear(Vector3 pos, float reach)
        {
            if (!_ready) { Bake(); if (!_ready) return false; }
            if (_gridReady)
            {
                int cx0 = CellX(pos.x - reach), cx1 = CellX(pos.x + reach);
                int cz0 = CellZ(pos.z - reach), cz1 = CellZ(pos.z + reach);
                _visitTok++;
                float reach2 = reach * reach;
                for (int cz = cz0; cz <= cz1; cz++)
                for (int cx = cx0; cx <= cx1; cx++)
                {
                    int cell = cz * _gnx + cx;
                    int end = _cellStart[cell + 1];
                    for (int k = _cellStart[cell]; k < end; k++)
                    {
                        int q = _cellItems[k];
                        if (_visit[q] == _visitTok) continue;
                        _visit[q] = _visitTok;
                        if (_railEnabled != null && (!_railEnabled[_chordRail[q]] || !_railModeEnabled[_chordRail[q]])) continue;
                        int ia = _chordP0[q];
                        Vector3 a = _world[ia], b = _world[ia + 1], ab = b - a;
                        float len2 = ab.sqrMagnitude;
                        float t = len2 > 1e-10f ? Vector3.Dot(pos - a, ab) / len2 : 0f;
                        if (t < 0f) t = 0f; else if (t > 1f) t = 1f;
                        if ((pos - (a + ab * t)).sqrMagnitude <= reach2) return true;
                    }
                }
                return false;
            }
            return false;
        }

        // Closest point on ONE specific rail to 'pos' (no range gate - the board already committed to this rail). Results
        // -> R*, plus RAtStart/RAtEnd flagging that the closest point clamped to an end vertex. Used while GRINDING.
        public void QueryRail(int rail, Vector3 pos)
        {
            RFound = false; RSurface = 13; RAtStart = false; RAtEnd = false;
            if (!_ready) { Bake(); if (!_ready) return; }
            if (rail < 0 || rail >= _railN || !_railValid[rail]) return;
            ClosestOnRail(rail, pos, true);   // FOLLOW: ride the analytic cubic - exact point + continuous tangent P'(t)
            RFound = true; RRail = rail;
            RSurface = SurfaceForRail(rail);
            RPoint = _cPoint; RTangent = _cTangent; RDist = _cDist;
            RAtStart = _cAtStart; RAtEnd = _cAtEnd;
        }

        // Find the best rail to TRANSFER onto at a junction - where one rail ends and another begins (the level's rails are
        // authored as separate splines meeting at near-coincident endpoints). Looks for a rail (!= excludeRail) with an
        // ENDPOINT within maxDist of 'pos' whose OUTGOING direction best aligns with 'travelDir' and is at least minDot.
        // Results -> R*: RRail, RPoint = the connecting endpoint, RTangent = the outgoing direction. RFound false = drop off.
        public void QueryTransfer(Vector3 pos, Vector3 travelDir, int excludeRail, float maxDist, float minDot)
        {
            RFound = false; RRail = -1; RSurface = 13;
            if (!_ready) { Bake(); if (!_ready) return; }
            Vector3 td = travelDir;
            if (td.sqrMagnitude > 1e-10f) td = td.normalized;
            float bestDot = minDot;
            for (int r = 0; r < _railN; r++)
            {
                if (r == excludeRail || !_railValid[r]) continue;
                int s = RailStart[r];
                int c = RailCount[r];
                if (c < 2) continue;
                Vector3 sp = _world[s];
                if ((sp - pos).magnitude <= maxDist)
                {
                    Vector3 dir = _world[s + 1] - sp;
                    if (dir.sqrMagnitude > 1e-10f)
                    {
                        dir = dir.normalized;
                        float dot = Vector3.Dot(dir, td);
                        if (dot > bestDot) { bestDot = dot; RFound = true; RRail = r; RSurface = SurfaceForRail(r); RPoint = sp; RTangent = dir; }
                    }
                }
                Vector3 ep = _world[s + c - 1];
                if ((ep - pos).magnitude <= maxDist)
                {
                    Vector3 dir = _world[s + c - 2] - ep;
                    if (dir.sqrMagnitude > 1e-10f)
                    {
                        dir = dir.normalized;
                        float dot = Vector3.Dot(dir, td);
                        if (dot > bestDot) { bestDot = dot; RFound = true; RRail = r; RSurface = SurfaceForRail(r); RPoint = ep; RTangent = dir; }
                    }
                }
            }
        }

        // Style is optional for backwards-compatible bundle v3 readers; pre-field bundles were all treated as metal.
        int SurfaceForRail(int rail)
        {
            return RailStyle != null && rail >= 0 && rail < RailStyle.Length ? RailStyle[rail] : 13;
        }

        // Shared: closest point on rail 'rail' to 'pos', over its consecutive-point segments. Writes _c* scratch: point,
        // unit tangent (segment a->b), distance, and whether it clamped to the rail's first/last vertex. 'refine' upgrades
        // the winning chord to the analytic cubic when cubic data exists (the grind FOLLOW passes true).
        void ClosestOnRail(int rail, Vector3 pos, bool refine)
        {
            int s = RailStart[rail];
            int c = RailCount[rail];
            _cPoint = _world[s]; _cTangent = Vector3.forward; _cDist = 1e9f; _cAtStart = false; _cAtEnd = false; _cChord = 0;
            if (c < 2) return;
            int segCount = c - 1;
            for (int seg = 0; seg < segCount; seg++)
            {
                Vector3 a = _world[s + seg];
                Vector3 b = _world[s + seg + 1];
                Vector3 ab = b - a;
                float len2 = ab.sqrMagnitude;
                float t = len2 > 1e-10f ? Vector3.Dot(pos - a, ab) / len2 : 0f;
                if (t < 0f) t = 0f; else if (t > 1f) t = 1f;
                Vector3 cp = a + ab * t;
                float d = (pos - cp).magnitude;
                if (d < _cDist)
                {
                    _cDist = d;
                    _cPoint = cp;
                    _cTangent = len2 > 1e-10f ? ab / Mathf.Sqrt(len2) : Vector3.forward;
                    _cAtStart = (seg == 0) && (t <= 0f);
                    _cAtEnd = (seg == segCount - 1) && (t >= 1f);
                    _cChord = seg;
                }
            }
            if (refine && _hasCubic) RefineOnCubic(rail, _cChord, pos);
        }

        // Upgrade the closest point from the winning CHORD to the actual cubic: golden-section minimize the distance to the
        // real cubic over the winning chord's sub-range, then read the EXACT tangent P'(t) [Trailmap: 350-rails].
        void RefineOnCubic(int rail, int chord, Vector3 pos)
        {
            if (_segWorld == null || rail < 0 || rail >= SegCount.Length) return;
            int S = SamplesPerSegment;
            int segCountRail = SegCount[rail];
            if (segCountRail <= 0) return;
            int localSeg = chord / S;
            if (localSeg >= segCountRail) localSeg = segCountRail - 1;
            int baseIx = (SegStart[rail] + localSeg) * 4;
            if (baseIx < 0 || baseIx + 3 >= _segWorld.Length) return;
            Vector3 p0 = _segWorld[baseIx], p1 = _segWorld[baseIx + 1], p2 = _segWorld[baseIx + 2], p3 = _segWorld[baseIx + 3];

            int jWithin = chord - localSeg * S;
            float lo = (float)jWithin / S;
            float hi = (float)(jWithin + 1) / S;
            if (hi > 1f) hi = 1f;

            float gr = 0.6180339887f;
            float a = lo, b = hi;
            float x1 = b - gr * (b - a);
            float x2 = a + gr * (b - a);
            float f1 = CubicSqDist(p0, p1, p2, p3, x1, pos);
            float f2 = CubicSqDist(p0, p1, p2, p3, x2, pos);
            for (int it = 0; it < 16; it++)
            {
                if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - gr * (b - a); f1 = CubicSqDist(p0, p1, p2, p3, x1, pos); }
                else         { a = x1; x1 = x2; f1 = f2; x2 = a + gr * (b - a); f2 = CubicSqDist(p0, p1, p2, p3, x2, pos); }
                if (b - a < 1e-4f) break;
            }
            float tBest = 0.5f * (a + b);

            Vector3 pt = CubicPoint(p0, p1, p2, p3, tBest);
            Vector3 dv = CubicDeriv(p0, p1, p2, p3, tBest);
            _cPoint = pt;
            if (dv.sqrMagnitude > 1e-10f) _cTangent = dv.normalized;
            _cDist = (pos - pt).magnitude;
        }

        Vector3 CubicPoint(Vector3 p0, Vector3 p1, Vector3 p2, Vector3 p3, float t)
        {
            float u = 1f - t, uu = u * u, tt = t * t;
            return uu * u * p0 + 3f * uu * t * p1 + 3f * u * tt * p2 + tt * t * p3;
        }

        Vector3 CubicDeriv(Vector3 p0, Vector3 p1, Vector3 p2, Vector3 p3, float t)
        {
            float u = 1f - t;
            return 3f * u * u * (p1 - p0) + 6f * u * t * (p2 - p1) + 3f * t * t * (p3 - p2);
        }

        float CubicSqDist(Vector3 p0, Vector3 p1, Vector3 p2, Vector3 p3, float t, Vector3 pos)
        {
            Vector3 d = CubicPoint(p0, p1, p2, p3, t) - pos;
            return d.sqrMagnitude;
        }
    }
}
