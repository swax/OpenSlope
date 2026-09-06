using UnityEngine;
using UdonSharp;

namespace OpenSlope.VrcPlugin
{

    // Part of RideableBoard (partial): the carved snow WAKE - a procedural ribbon mesh the board rebuilds each frame.
    // The public knobs (wakeMeshFilter/trailMinSpeed/wakeLife/...) live in the main file; IsSnowSurface lives in the FX
    // partial (shared with the spray).
    //
    // A FIFO ring of cross-sections laid on the snow behind the tail, rebuilt into _wakeMesh every frame, the way the
    // engine builds its carved-wake ribbon of quads [Trailmap: 380-carve-effects]. (A Unity TrailRenderer flickered the ribbon away on the bumpy
    // contact - it Clear()ed on every gate re-acquire; see docs/vrchat/030.) The twin-groove light/dark depression + the age
    // fade live in PER-VERTEX COLOUR (drawn by OpenSlope/WakeRibbon, an unlit overlay blend, so it auto-matches snow shade).
    // World-space mesh: the Wake child is pinned to world origin/identity each frame so its local verts ARE world coords.
    public partial class RideableBoard
    {
        // FIFO ring of cross-sections: index 0 = oldest, _wkN-1 = newest. Per cross-section = world centre, across-track
        // (side) dir, half-width, age, per-surface intensity. The mesh is regenerated from these every frame so the
        // ribbon fades by age and never flickers. Only the across-track grid is baked; the per-vertex shade is computed
        // each frame and the shader overlay-blends it onto the snow.
        private const int WK_MAX = 56;    // max cross-sections (ring length) -> ribbon length = WK_MAX * wakePointSpacing
        private const int WK_CROSS = 20;  // vertices ACROSS the track per cross-section (enough to resolve the THIN ice edge line)
        private Mesh _wakeMesh;
        private Vector3[] _wkCtr;          // ring: world centre of each cross-section (on the snow, behind the tail)
        private Vector3[] _wkSideV;        // ring: across-MOTION unit dir (perp to travel) = the cross-section axis
        private float[] _wkHalfW;          // ring: half-width (m) at each cross-section
        private float[] _wkAgeT;           // ring: age (s) of each cross-section
        private float[] _wkDepth;          // ring: per-surface wake intensity (ice thin .. deep snow thick)
        private int _wkN;                  // number of valid cross-sections in the ring
        private Vector3[] _wkVerts;        // preallocated mesh buffers (WK_MAX*WK_CROSS)
        private Color[] _wkCols;
        private int[] _wkTris;             // preallocated index buffer
        private int _wkTrisRows = -1;      // row count the index buffer currently encodes; -1 = needs (re)build. The strip
                                           // topology depends ONLY on the row count (a+k/b+k index math), not the vertex
                                           // positions, so we rebuild + re-upload mesh.triangles only when this changes -
                                           // a steady carve (rows pinned at WK_MAX) skips it every frame. Reset on Clear().
        private float[] _xsOff;            // cross-section profile: lateral offset fraction per across-vertex (-1..+1)
        private float[] _xsOuter;          // soft outer-rim factor per across-vertex - depends only on |offset|, so baked once
        private Vector3 _wakeSunDir;       // world sun direction (horizontal azimuth) - sets which groove wall is the deep shadow
        private bool _wakeReady;           // mesh + buffers built
        private bool _haveLastWake;        // whether _lastWakePos is valid (false until the first cross-section / after a reset)
        private Vector3 _lastWakePos;      // world centre of the last laid cross-section; a new one is laid after wakePointSpacing
        // Under-board patch = a single triangle: the ring rows are perpendicular full-width rows laid at the board's
        // TRAILING edge, and a TRANSIENT front row (rebuilt each frame) pokes forward to the board's leading corner. The
        // cap between the newest ring row and that front row is the triangle: flat base at the tail tapering to the
        // leading silhouette at the nose. Stored: the head motion frame + board axes + the board's backward reach.
        private Vector3 _wkHeadTdir;       // motion direction (the front row pokes forward along this)
        private float _wkHeadHalfW;        // swept half-width
        private float _wkHeadFx, _wkHeadFy; // board forward, in (across-motion, along-motion) components
        private float _wkHeadSx, _wkHeadSy; // board side, in (across-motion, along-motion) components
        private float _wkHeadHl, _wkHeadHw; // board half-length / half-width
        private float _wkHeadBack;         // board's reach BEHIND centre along motion (rows are laid at this trailing edge)
        private bool _wkHeadCap;           // draw the transient leading-cap front row

        // Build the mesh, the reusable vertex/index buffers, and the cross-section colour profile. Called from Start; no
        // Wake child (old board) -> no-op. Pins the Wake child to world identity so the mesh can carry world-space verts.
        void InitWakeMesh()
        {
            if (wakeMeshFilter == null) { _wakeReady = false; return; }
            if (_wakeMesh == null)
            {
                _wakeMesh = new Mesh();
                _wakeMesh.MarkDynamic();                       // rewritten every frame
                wakeMeshFilter.mesh = _wakeMesh;
            }
            int vCount = (WK_MAX + 1) * WK_CROSS;   // +1 row = the transient front leading-cap row (rebuilt each frame)
            if (_wkVerts == null || _wkVerts.Length != vCount)
            {
                _wkVerts = new Vector3[vCount];
                _wkCols  = new Color[vCount];
                _wkTris  = new int[WK_MAX * (WK_CROSS - 1) * 6];   // WK_MAX strips (ring rows + the transient front row)
                _wkCtr   = new Vector3[WK_MAX];
                _wkSideV = new Vector3[WK_MAX];
                _wkHalfW = new float[WK_MAX];
                _wkAgeT  = new float[WK_MAX];
                _wkDepth = new float[WK_MAX];
                // Project-authored fallback horizontal sun azimuth, matching the editor's default. We dot this with
                // the across-track axis for the light/dark split; normalizing lets the split reach +-1 when riding
                // perpendicular to the sun -> one wall clearly LIGHTER than the snow, one clearly darker.
                _wakeSunDir = new Vector3(-0.533f, 0f, -0.308f).normalized;
                BuildWakeProfile();
            }
            PinWakeTransform();
            _wkN = 0;
            _wakeReady = true;
            ClearWake();
        }

        // The Wake child renders the mesh through its transform; since the mesh verts are WORLD coordinates, the child
        // must sit at world origin with identity rotation. Re-pinned each rebuild because the child rides the moving board.
        void PinWakeTransform()
        {
            if (wakeMeshFilter == null) return;
            Transform wt = wakeMeshFilter.transform;
            wt.position = Vector3.zero;
            wt.rotation = Quaternion.identity;
        }

        // The fixed cross-section GRID: WK_CROSS samples across the track (offset fraction -1..+1). That's ALL that's
        // baked - the per-vertex shade is computed every frame in AgeAndRebuildWake.
        void BuildWakeProfile()
        {
            _xsOff = new float[WK_CROSS];
            _xsOuter = new float[WK_CROSS];
            for (int k = 0; k < WK_CROSS; k++)
            {
                float u = (WK_CROSS == 1) ? 0f : (k / (float)(WK_CROSS - 1));
                float off = u * 2f - 1f;                        // -1..+1 across the track
                _xsOff[k] = off;
                // Soft outer rim falloff: depends ONLY on |offset|, so bake it per column once instead of recomputing
                // (a Clamp01 extern + smoothstep) for every vertex every frame in AgeAndRebuildWake.
                float ax = off < 0f ? -off : off;
                float eo = (ax - 0.92f) / 0.08f; if (eo < 0f) eo = 0f; else if (eo > 1f) eo = 1f;
                _xsOuter[k] = 1f - eo * eo * (3f - 2f * eo);
            }
        }

        // Per-SurfaceType wake intensity (0 = no wake). The wake-bearing set is the game trail updater's per-SurfaceType
        // surface families: {1,2,8,15,16} snow-family, {3,4} powder, {5} ice; every other
        // type lays NOTHING - including 12, whose "small wake" data label the code ignores. The returned weight drives the
        // carved-edge LINE THICKNESS in AgeAndRebuildWake (ice = a thin fast-fading rim, deep snow = a wide groove).
        float WakeSurfaceDepth(int t)
        {
            if (t == powderSurfaceType) return 1.0f;   // 3 powdered snow - the deep, strong groove
            if (t == 4) return 1.0f;                    // 4 slow/deep powder - also deep
            if (t == 1 || t == 2 || t == 15) return 0.85f; // 1 standard snow / 2 off-track / 15 standard-unknown - medium
            if (t == 8) return 0.7f;                    // 8 glidy snow particles - lighter
            if (t == 16) return 0.5f;                   // 16 sand - a faint track
            if (t == 5) return 0.4f;                    // 5 ice standard - a thin scratch (7 & 11 are "no trail" -> 0 below)
            return 0f;                                  // 0/6/7/9-14/17/18/19 - no-trail/metal/rock/wall/ramp/air
        }

        // Per-SurfaceType wake WIDTH multiplier = the per-surface wake width: packed
        // snow is the thin baseline (1.0), powder/slow-powder plow ~1.85-2.4x wider, off-track a touch narrower, ice a
        // narrow scratch. Layered on the deck-footprint width in UpdateWakeTrail so a powder carve reads as a wider groove
        // than a snow slice [Trailmap: 380-carve-effects]. The no-trail surfaces are already zeroed by
        // WakeSurfaceDepth, so this only shapes the surfaces that DO carve.
        float WakeSurfaceWidth(int t)
        {
            if (t == powderSurfaceType) return 2.4f;    // 3 powdered snow - widest (wake width ~1.14 vs snow ~0.47)
            if (t == 4) return 1.85f;                   // 4 slow/deep powder (0.87)
            if (t == 2) return 0.85f;                   // 2 standard off-track snow - a touch narrower
            if (t == 5) return 0.9f;                    // 5 ice standard - a narrow scratch
            return 1.0f;                                // 1/8/16 snow + any other carving surface - the thin baseline
        }

        // Empty the ribbon (drop all cross-sections) and clear the drawn mesh. Mount, teleport, melted-out parked board.
        void ClearWake()
        {
            _wkN = 0;
            if (_wakeMesh != null) _wakeMesh.Clear();
            _wkTrisRows = -1; // mesh.Clear() drops the index buffer -> force a rebuild on the next ribbon
        }

        // Per-frame wake: lay a new cross-section when carving snow above trailMinSpeed, then age + rebuild the mesh.
        void UpdateWakeTrail(float dt)
        {
            if (!_wakeReady || !trailEnabled) return;
            float speed = _vel.magnitude;
            // Lenient ground test: lay the wake whenever SNOW is within wakeGroundReach below, NOT only when the strict
            // physics 'grounded' band holds (which flickers as the board hops bumps at speed, dropping the trail to ~10%).
            // Under-snow gate: burial is a property of the SURFACE's rest state, not a live depth. The two powders rest
            // 15-25 cm under the surface and show a plowed plume, not a groove; type 8 "glidy" rides 14 cm deep and
            // KEEPS its groove - and no depth constant can split 0.1435 from 0.1509 across slopes (the rest depth is
            // bog*cos(slope), so any threshold between them flickers with grade).
            float depth = WakeSurfaceDepth(_pSurf);
            float hAbove = transform.position.y - _pGroundY;
            bool underSnow = _pSurf == 3 || _pSurf == 4;
            // The board cuts a snow track whenever it's over a wake surface and moving above trailMinSpeed - riding
            // STRAIGHT as well as carving. Live-verified: the game's trail
            // updater gates only on motion state + the per-surface table, with NO lean term - a paused straight glide
            // (lean 0.000) held a full live ring with the newest cross-section at the board. The carve-gated 0.9s effect
            // is sys2's spry columns (the carve spray), a different system. The groove WIDTH comes from the deck footprint
            // projected across the motion (below) plus the per-surface width: a straight run lays a narrow board-width
            // slice, a crabbed carve lays a wide one (also matches live: ~0.46 m straight vs ~1.1 m carved). Deep-powder
            // burial (underSnow) still suppresses it - under the snow there's no surface groove to draw, just the plume.
            bool wake = _pFound && depth > 0f && !underSnow && hAbove <= wakeGroundReach && speed >= trailMinSpeed;

            if (wake)
            {
                Vector3 n = _contactN.sqrMagnitude > 1e-6f ? _contactN.normalized : Vector3.up;
                // Cross-section laid PERPENDICULAR to the motion direction, so the ribbon's two long edges run parallel to
                // travel and the body is full-width RECTANGULAR patches behind the board. The depression's width = the
                // board footprint PROJECTED onto the across-motion axis (deck aligned = WIDTH thin, sideways = LENGTH
                // widest). The board crabbing is reconciled at the HEAD with a forward TRIANGLE (added per-vertex to the
                // NEWEST cross-section in AgeAndRebuildWake via WakeLeadOffset); everything behind it stays full-width.
                Vector3 travel = Vector3.ProjectOnPlane(_vel, n);
                Vector3 tdir = travel.sqrMagnitude > 1e-4f ? travel.normalized : Vector3.ProjectOnPlane(_fwd, n).normalized;
                Vector3 side = Vector3.Cross(n, tdir);                 // across-MOTION, in the slope plane (the cross-section axis)
                if (side.sqrMagnitude < 1e-6f) side = Vector3.Cross(n, Vector3.forward);
                side = side.normalized;
                Vector3 f = Vector3.ProjectOnPlane(_fwd, n); f = f.sqrMagnitude > 1e-6f ? f.normalized : tdir; // board forward in plane
                Vector3 sBoard = Vector3.Cross(n, f);                  // board's own side edge (across the deck)
                if (sBoard.sqrMagnitude < 1e-6f) sBoard = side;
                sBoard = sBoard.normalized;
                // Avatar-fit scale: widen the carved ribbon to match the resized deck (the wake tracks the LOOK, not the
                // world-absolute physics). 1 when unmounted / authored size.
                float hl = trailWidthMax * 0.5f * _riderScale;         // board half-LENGTH
                float hw = trailWidthMin * 0.5f * _riderScale;         // board half-WIDTH
                float fx = Vector3.Dot(f, side),      fy = Vector3.Dot(f, tdir);      // board fwd  in (across-motion, along-motion)
                float sx = Vector3.Dot(sBoard, side), sy = Vector3.Dot(sBoard, tdir); // board side in (across-motion, along-motion)
                float half = hl * Mathf.Abs(fx) + hw * Mathf.Abs(sx); // swept half-width onto the across-motion axis (variable)
                // Per-surface groove WIDTH (per-surface wake width [Trailmap: 380-carve-effects]): packed snow is the thin baseline, powder plows
                // ~2.4x wider, off-track a touch narrower. Multiplied onto the footprint width so the per-surface groove
                // width matches the game. (Width only - the trailing-edge reach below is unscaled geometry.)
                if (wakePerSurfaceWidth) half *= WakeSurfaceWidth(_pSurf);
                float backDist = hl * Mathf.Abs(fy) + hw * Mathf.Abs(sy); // board's reach BEHIND centre along motion (trailing edge)
                // Lay the row at the board's TRAILING edge (perpendicular, full width), stepped back ALONG THE SLOPE PLANE.
                // Lay it at the ACTUAL ground height under that (often-behind) point, not the board's centre ground extrapolated
                // along tdir: on CONCAVE terrain (a dip/bowl) the snow behind rises FASTER than the straight tangent step, so
                // the extrapolated row sinks beneath the rising snow and ZTest-occludes = "the trail vanishes in dips". A
                // down-sample here makes the row hug the real terrain; the generous ray start clears a steep rise, and a miss
                // (cliff edge / void) falls back to the old tangent extrapolation so flat/convex ground is unchanged.
                float reach = backDist + trailTailOffset;
                Vector3 ctr = transform.position - tdir * reach;     // step back along the slope-plane travel dir (3D)
                float gy = SampleGroundY(ctr, transform.position.y + RIDE_PROBE_ABOVE + reach,
                                         RIDE_PROBE_ABOVE + RIDE_PROBE_BELOW + 2f * reach);
                ctr.y = gy > -1e8f ? gy + trailHeight : (_pGroundY + trailHeight) - tdir.y * reach;
                // Stash the head's frame for the transient leading-cap front row.
                _wkHeadTdir = tdir; _wkHeadHalfW = half; _wkHeadFx = fx; _wkHeadFy = fy;
                _wkHeadSx = sx; _wkHeadSy = sy; _wkHeadHl = hl; _wkHeadHw = hw; _wkHeadBack = backDist; _wkHeadCap = true;

                float gapSq = _haveLastWake ? (ctr - _lastWakePos).sqrMagnitude : 0f;
                if (_haveLastWake && gapSq > wakeRestartGap * wakeRestartGap) _wkN = 0; // real jump/teleport: fresh run

                bool lay = !_haveLastWake || _wkN == 0 || gapSq >= wakePointSpacing * wakePointSpacing;
                if (lay)
                {
                    if (_wkN >= WK_MAX) DropOldestWake();
                    int i = _wkN++;
                    _wkCtr[i] = ctr; _wkSideV[i] = side; _wkHalfW[i] = half; _wkAgeT[i] = 0f; _wkDepth[i] = depth;
                    _lastWakePos = ctr; _haveLastWake = true;
                }
                else if (_wkN > 0)
                {
                    // Not far enough to drop a new cross-section yet - keep the newest one tracking the board.
                    int i = _wkN - 1;
                    _wkCtr[i] = ctr; _wkSideV[i] = side; _wkHalfW[i] = half; _wkDepth[i] = depth;
                }
            }
            // off snow / too slow / buried: stop laying; the ribbon ages out in AgeAndRebuildWake (keep _lastWakePos so a
            // brief gate flicker stitches back onto the same run instead of starting a new one).

            AgeAndRebuildWake(dt);
        }

        // Age + rebuild the mesh WITHOUT laying anything - a now-parked board melting its leftover trail (called from
        // Update's idle branch while the ring still has cross-sections).
        void WakeAgeOnly(float dt)
        {
            if (!_wakeReady) return;
            AgeAndRebuildWake(dt);
        }

        // Drop the oldest cross-section (index 0), shifting the FIFO down one.
        void DropOldestWake()
        {
            for (int i = 1; i < _wkN; i++)
            {
                _wkCtr[i - 1] = _wkCtr[i]; _wkSideV[i - 1] = _wkSideV[i];
                _wkHalfW[i - 1] = _wkHalfW[i]; _wkAgeT[i - 1] = _wkAgeT[i]; _wkDepth[i - 1] = _wkDepth[i];
            }
            _wkN--;
        }

        // Leading-cap chord between the two ACROSS-EXTREME corners (through centre). Which diagonal that is flips with
        // crab direction, so pick the corner by the sign of the across components.
        float WakeLeadOffset(float off)
        {
            float r = Mathf.Sign(_wkHeadFx) * _wkHeadHl * _wkHeadFy
                    + Mathf.Sign(_wkHeadSx) * _wkHeadHw * _wkHeadSy;
            return off * r;
        }

        // Age every cross-section, drop expired ones from the front, and regenerate the mesh: positions fixed at lay
        // time, per-vertex colour = the cross-section profile * its age-fade. A connected strip is built between
        // consecutive cross-sections; the unused tail collapses to degenerate (zero-area) triangles.
        void AgeAndRebuildWake(float dt)
        {
            if (_wakeMesh == null) return;
            PinWakeTransform(); // mesh verts are world-space; keep the child at world identity so they render in place

            for (int i = 0; i < _wkN; i++) _wkAgeT[i] += dt;
            int drop = 0;
            while (drop < _wkN && _wkAgeT[drop] >= wakeLife) drop++;
            if (drop > 0)
            {
                for (int i = drop; i < _wkN; i++)
                {
                    _wkCtr[i - drop] = _wkCtr[i]; _wkSideV[i - drop] = _wkSideV[i];
                    _wkHalfW[i - drop] = _wkHalfW[i]; _wkAgeT[i - drop] = _wkAgeT[i]; _wkDepth[i - drop] = _wkDepth[i];
                }
                _wkN -= drop;
            }
            if (_wkN < 2) { _wakeMesh.Clear(); _wkTrisRows = -1; return; } // a strip needs at least two cross-sections (Clear drops the index buffer)

            float invLife = 1f / Mathf.Max(0.01f, wakeLife);
            for (int i = 0; i < _wkN; i++)
            {
                float fade = 1f - _wkAgeT[i] * invLife; if (fade < 0f) fade = 0f; // 1 fresh -> 0 about to drop
                float depth = Mathf.Clamp01(_wkDepth[i]);                          // per-surface intensity -> carved-line THICKNESS
                // Carved-line thickness: the two edge walls bracket a transparent floor; 'depth' sets how far the wall
                // band reaches IN from the rim - ICE (low) -> a thin rim scratch; deep snow -> a wide bold groove.
                float inner = Mathf.Lerp(0.82f, 0.30f, Mathf.Clamp01((depth - 0.4f) / 0.5f));
                float span = 0.92f - inner; if (span < 0.04f) span = 0.04f;
                // Sun-direction light/dark split: how much the across-track axis aligns with the world sun. The wall
                // FACING the sun reads lighter, the away wall is the deep shadow, so it swings to follow the sun as you
                // turn. The NEGATE is ride-confirmed (the raw dot put the shadow on the wrong wall).
                float sunSide = -Vector3.Dot(_wkSideV[i], _wakeSunDir);
                int baseV = i * WK_CROSS;
                for (int k = 0; k < WK_CROSS; k++)
                {
                    float off = _xsOff[k];
                    _wkVerts[baseV + k] = _wkCtr[i] + _wkSideV[i] * (off * _wkHalfW[i]); // plain perpendicular row: the trail + its trailing-edge base
                    float ax = off < 0f ? -off : off;                                            // |offset| from centre
                    float w = (ax - inner) / span; if (w < 0f) w = 0f; else if (w > 1f) w = 1f;   // inline Clamp01 (no extern)
                    float wall = w * w * (3f - 2f * w);                                           // 0 floor -> 1 wall
                    float cov = wall * _xsOuter[k] * fade;                                        // outer rim baked per column; 0 floor/old -> 1 fresh wall
                    float litness = (off >= 0f ? 1f : -1f) * sunSide;                            // >0 sun-facing wall, <0 away
                    // Overlay value: 0.5 leaves the snow alone; the groove darkens by wakeDarken and the sun split shifts
                    // one wall lighter / the other darker. The shader's DstColor SrcColor blend turns this into a
                    // darken/lighten of the real snow pixel (auto shade-match).
                    float val = 0.5f + cov * (wakeSunSplit * litness - wakeDarken);
                    if (val < 0f) val = 0f; else if (val > 1f) val = 1f;
                    _wkCols[baseV + k] = new Color(val, val, val, 1f);
                }
            }
            // Transient LEADING-cap row at the very FRONT (buffer index _wkN), rebuilt each frame. The ring rows are laid
            // at the board's TRAILING edge; this row pokes FORWARD past them to the leading silhouette, so the cap between
            // the newest ring row and this one IS the board's under-deck patch (flat base at the tail tapering to the nose).
            int nRows = _wkN;
            if (_wkHeadCap && _wkN >= 1)
            {
                int hi = _wkN - 1;                                  // newest ring row (the trailing edge / triangle base)
                float fadeH = 1f - _wkAgeT[hi] * invLife; if (fadeH < 0f) fadeH = 0f;
                float depthH = Mathf.Clamp01(_wkDepth[hi]);
                float innerH = Mathf.Lerp(0.82f, 0.30f, Mathf.Clamp01((depthH - 0.4f) / 0.5f));
                float spanH = 0.92f - innerH; if (spanH < 0.04f) spanH = 0.04f;
                float sunSideH = -Vector3.Dot(_wkSideV[hi], _wakeSunDir);
                int baseE = _wkN * WK_CROSS;
                for (int k = 0; k < WK_CROSS; k++)
                {
                    float off = _xsOff[k];
                    // forward to the leading silhouette: + _wkHeadBack brings it from the trailing-edge base to the board
                    // centre, + WakeLeadOffset(off) then out to the nose/leading corner at this across position.
                    _wkVerts[baseE + k] = _wkCtr[hi] + _wkSideV[hi] * (off * _wkHalfW[hi]) + _wkHeadTdir * (WakeLeadOffset(off) + _wkHeadBack);
                    float ax = off < 0f ? -off : off;
                    float w = (ax - innerH) / spanH; if (w < 0f) w = 0f; else if (w > 1f) w = 1f; // inline Clamp01 (no extern)
                    float wall = w * w * (3f - 2f * w);
                    float cov = wall * _xsOuter[k] * fadeH;                                       // outer rim baked per column
                    float litness = (off >= 0f ? 1f : -1f) * sunSideH;
                    float val = 0.5f + cov * (wakeSunSplit * litness - wakeDarken);
                    if (val < 0f) val = 0f; else if (val > 1f) val = 1f;
                    _wkCols[baseE + k] = new Color(val, val, val, 1f);
                }
                nRows = _wkN + 1;
            }
            // The unused tail of the vertex/colour buffers (indices >= nRows*WK_CROSS) is NEVER referenced by a drawn
            // triangle - every spare index slot below is collapsed onto vertex 0 - so we leave whatever stale data is
            // there instead of rewriting up to ~1k verts/colours every frame. Bounds are set explicitly below, so a
            // stale tail position can't affect frustum culling either.
            // Positions + colours change every frame, so always upload them. The vertex buffer is a FIXED length, so this
            // never invalidates the index buffer. Set vertices FIRST (indices reference them).
            _wakeMesh.vertices = _wkVerts;
            _wakeMesh.colors = _wkCols;      // no UVs: WakeRibbon reads only POSITION + COLOR, so we never build/upload them

            // Index buffer (strip topology) depends ONLY on the row count - a + k / b + k math, no vertex data - so rebuild
            // and re-upload mesh.triangles ONLY when nRows changes. A steady carve sits at the ring max, so this is skipped
            // most frames (the costly part: ~WK_MAX*19*6 index writes + the triangles setter's index revalidation).
            if (nRows != _wkTrisRows)
            {
                int t = 0;
                for (int i = 0; i < nRows - 1; i++)
                {
                    int a = i * WK_CROSS, b = (i + 1) * WK_CROSS;
                    for (int k = 0; k < WK_CROSS - 1; k++)
                    {
                        _wkTris[t++] = a + k;     _wkTris[t++] = a + k + 1; _wkTris[t++] = b + k;
                        _wkTris[t++] = b + k;     _wkTris[t++] = a + k + 1; _wkTris[t++] = b + k + 1;
                    }
                }
                while (t < _wkTris.Length) _wkTris[t++] = 0; // degenerate (collapsed) triangles for the unused span
                _wakeMesh.triangles = _wkTris;
                _wkTrisRows = nRows;
            }
            _wakeMesh.bounds = new Bounds(_wkCtr[_wkN - 1], Vector3.one * 400f); // big: never frustum-cull the ribbon
        }
    }
}
