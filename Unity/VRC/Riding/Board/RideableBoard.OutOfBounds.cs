using UnityEngine;

namespace OpenSlope.VrcPlugin
{

    // Part of RideableBoard (partial): the out-of-bounds reset - the breadcrumb trail and the three-tier restore that
    // carries the rider back ONTO THE COURSE (nearest authored race line) near where they left, never to the VRChat spawn.
    // The tuning knobs (resetToTrackOnOOB, crumbSpacing, ...) and the coursePath reference live in the main file; Eject
    // (the shared dismount+respawn exit) stays there too. See docs/031 + docs/011.
    //
    // DETECTION LIVES ALMOST ENTIRELY OUTSIDE THIS FILE, and that is the point. Out-of-bounds is AUTHORED GEOMETRY YOU
    // CROSS, never something the board infers. SSX carries no void check, no death plane, no "is there terrain below me"
    // probe of any kind (the game has no world Y-floor or death-plane constant on the player path; a retail noclip test
    // flies off the world and is never reset) - it authors MainType-13 reset volumes (Mdl_ResetZone*, Water_River,
    // back-of-course walls; dozens to a few hundred per level), which we realize as ResetZone -> TriggerReset.
    //
    // Nor could such an inference be made to work: a rail strung over water satisfies every condition one would test -
    // airborne, descending, far below the last ground touched, nothing underneath. Grinding is not distinguishable from
    // falling by inference; it is distinguishable by geometry. So the one case the authored volumes miss - leaving the
    // world through a gap between them - is covered by ANOTHER volume: the importer fits a slab under the whole map
    // (VolumeBuilder.BuildOobFloor), which is just another ResetZone. See docs/031.
    public partial class RideableBoard
    {
        // Breadcrumb trail: while riding grounded on a real (non-Reset) surface we drop position+heading crumbs into a
        // ring buffer, so an out-of-bounds exit can carry the rider back onto the course near where they left. Allocated
        // in Start; cleared on mount and on any RespawnAt teleport (so a lap-loop's stale trail can't pull you off).
        private Vector3[] _crumbPos;   // ring of recent valid on-track board positions
        private Vector3[] _crumbFwd;   // parallel ring of horizontal headings at each crumb
        private int _crumbWrite;       // next write index (ring head)
        private int _crumbFilled;      // how many crumbs are valid (<= _crumbPos.Length)
        private Vector3 _lastCrumbPos; // last recorded crumb position (distance throttle)
        private bool _haveLastCrumb;
        private float _oobResetCooldown; // debounce so one out-of-bounds event resets once, not every frame
        private float _lastResetTime = -999f; // for the anti-trap streak counter
        private int _resetStreak;      // consecutive resets in a short window -> escalate to a full respawn (escape a loop)
        private float _resetGroundY;   // scratch: ground Y found under a course point by ResetGroundAt
        private Vector3 _resetGroundNormal = Vector3.up; // scratch: that ground's normal (for a robust downhill facing)

        // Per-frame out-of-bounds handling, called once from Update: tick the cooldown, detect the ONE condition we still
        // detect ourselves, and otherwise drop a breadcrumb of this frame's valid spot. Returns true when a reset fired
        // (the caller then returns). Board-only; free-walking is unaffected.
        //
        // The only detector left here is the SSX Reset SURFACE (type-0): grounded on a Surf_0 patch - the authored
        // out-of-bounds skirt ("large skirts surrounding the rideable course"). Every OTHER way
        // out of bounds is an authored VOLUME that calls TriggerReset from outside: the game's own MainType-13 boundaries
        // and the importer's under-the-map floor slab, both ResetZone. Nothing here is gated on rider state, matching
        // the game (SSX polls the same course-reset entry from EVERY control state, the rail state included).
        bool OutOfBoundsUpdate(Vector3 cur, float dt, bool onGround)
        {
            if (_oobResetCooldown > 0f) _oobResetCooldown -= dt;

            // Only reset-to-track during a TIMED RACE (_runActive - the run clock is running). Free-riding is left alone, so
            // you can roam across Reset patches or off the edge without being yanked back; a genuine free-ride fall is still
            // caught by VRChat's respawn height (-> OnPlayerRespawn). See docs/031.
            if (resetToTrackOnOOB && _runActive && _oobResetCooldown <= 0f && onGround && _pSurf == 0)
            {
                ResetToTrack();
                return true;
            }
            // WEDGED ON THE LEVEL: consecutive shoving contacts with an object carried the bump integrator past its
            // threshold (the block at the bottom of this file; fed by ResolveObstacles, decayed in Tick). Same gates as
            // every other reset here - race-only, cooldown-debounced, and the same three-tier carry-back - and no rider
            // state gate, matching the game: pinned against a wall in the air counts exactly like pinned on the ground.
            if (resetWhenWedged && resetToTrackOnOOB && _runActive && _oobResetCooldown <= 0f && _wedge > WEDGE_FIRE)
            {
                ResetToTrack();
                return true;
            }
            // Drop a breadcrumb only on a real rideable surface: _pSurf > 0 excludes Reset(0), airborne(-2) and prop(-1).
            if (onGround && _pSurf > 0) RecordCrumb(cur);
            return false;
        }

        // Drop a breadcrumb of the current valid on-track position + heading, throttled so crumbs sit ~crumbSpacing apart.
        void RecordCrumb(Vector3 pos)
        {
            if (_crumbPos == null) return;
            if (_haveLastCrumb)
            {
                Vector3 d = pos - _lastCrumbPos;
                if (d.sqrMagnitude < crumbSpacing * crumbSpacing) return; // not far enough yet
            }
            Vector3 f = Vector3.ProjectOnPlane(_fwd, Vector3.up);
            _crumbFwd[_crumbWrite] = f.sqrMagnitude > 1e-4f ? f.normalized : _fwd;
            _crumbPos[_crumbWrite] = pos;
            _crumbWrite = (_crumbWrite + 1) % _crumbPos.Length;
            if (_crumbFilled < _crumbPos.Length) _crumbFilled++;
            _lastCrumbPos = pos; _haveLastCrumb = true;
        }

        // Out-of-bounds: carry the rider back ONTO THE COURSE, near where they left, facing down-course, stopped. Uses
        // RespawnAt (station carry, no dismount), not Respawn(). Three tiers, best first:
        //   1) snap to the nearest point on the authored COURSE path - always in-bounds and pointing down-course, so you
        //      can't slide straight back into the Reset patch you left (loop-proof);
        //   2) if there's no course path (an authored map with no AIP.json), a recent breadcrumb up the trail;
        //   3) if even the trail is empty, a plain dismount+respawn (Eject, in the main file).
        // Anti-trap: if resets keep firing in a tight window we've found a spot that re-triggers, so escalate to a full
        // respawn to break the loop. See docs/031.
        // Public entry for an AUTHORED reset volume (ResetZone, Trailmap MainType-13, docs/053) to snap the rider
        // back onto the course when they ride into an out-of-bounds boundary (a wall, water, back-of-course crowd stand).
        // Race-only, same as the auto-detection: outside a timed run (_runActive) crossing the volume is ignored, so a
        // free-rider isn't yanked. Respects the OOB cooldown so re-crossing the volume can't spam the reset.
        public void TriggerReset()
        {
            if (!_runActive || _oobResetCooldown > 0f) return;
            ResetToTrack();
        }

        void ResetToTrack()
        {
            _wedge = 0f; // the warp IS the answer to being wedged; carrying the count over would re-fire on the next frame
            float now = Time.time;
            _resetStreak = (now - _lastResetTime < 4f) ? _resetStreak + 1 : 0;
            _lastResetTime = now;
            _oobResetCooldown = 1.5f; // one OOB event resets once; ride away before another can fire
            RaceKnockdownHook(); // the wipeout moment: announcer Knockdown + song back to normal
            if (_resetStreak >= 3) { _resetStreak = 0; Eject(); return; } // stuck bouncing -> full respawn to escape

            // 1) Nearest authored course line.
            if (coursePath != null)
            {
                coursePath.Query(transform.position, courseResetMaxDist);
                if (coursePath.RFound)
                {
                    Vector3 cp = coursePath.RPoint;
                    bool gotGround = ResetGroundAt(cp);
                    Vector3 n = (gotGround && _resetGroundNormal.sqrMagnitude > 1e-6f) ? _resetGroundNormal.normalized : Vector3.up;
                    Vector3 slopeDown = Vector3.ProjectOnPlane(Vector3.down, n); // steepest descent on the landing slope (the fall line)

                    // Face down-course. Use the course line's horizontal direction when well-defined; some race-line
                    // segments are near-vertical, so fall back to the fall line, then to our current heading. Finally
                    // force the sign downhill against the slope so a reset never drops you facing uphill.
                    Vector3 tan = coursePath.RTangent;
                    Vector3 face = new Vector3(tan.x, 0f, tan.z);
                    if (face.sqrMagnitude < 0.0625f) face = slopeDown;                       // |horiz tangent| < 0.25: use the fall line
                    if (face.sqrMagnitude < 1e-4f) face = new Vector3(_fwd.x, 0f, _fwd.z);   // flat + vertical: keep current heading
                    if (slopeDown.sqrMagnitude > 1e-4f && Vector3.Dot(face, slopeDown) < 0f) face = -face; // never uphill
                    face = new Vector3(face.x, 0f, face.z);
                    if (face.sqrMagnitude < 1e-6f) face = Vector3.forward;

                    Vector3 target = gotGround ? new Vector3(cp.x, _resetGroundY + 0.1f, cp.z)  // drop in just above the ground; the contact model lands it
                                               : cp + Vector3.up * 0.5f; // no ground found: let the contact model settle it
                    RespawnAt(target, face);
                    return;
                }
            }

            // 2) Breadcrumb fallback: a recent on-track crumb a little way back up the trail.
            if (_crumbPos != null && _crumbFilled > 0)
            {
                int maxBack = _crumbFilled - 1;                              // newest = offset 0, oldest = offset maxBack
                int back = Mathf.CeilToInt(resetBackDistance / Mathf.Max(0.5f, crumbSpacing));
                if (back > maxBack) back = maxBack;
                if (back < 0) back = 0;
                int len = _crumbPos.Length;
                int idx = ((_crumbWrite - 1 - back) % len + len) % len;     // newest is _crumbWrite-1, walk back
                RespawnAt(_crumbPos[idx] + Vector3.up * 0.5f, _crumbFwd[idx]);
                return;
            }

            // 3) Nothing to reset onto.
            Eject();
        }

        // Find the terrain surface Y at a world point's XZ, preferring a real (non-Reset) up-facing surface, so the course
        // reset lands the board ON the ground - NOT at the course point's own Y, which can't be trusted (the race line
        // floats above jumps and sometimes dips below our terrain by tens of metres). Cast from well ABOVE the point
        // straight down. Result -> _resetGroundY/Normal; returns false only if nothing solid is below.
        bool ResetGroundAt(Vector3 pos)
        {
            int n = Physics.RaycastNonAlloc(pos + Vector3.up * 220f, Vector3.down, _hitBuf, 460f);
            bool haveTerrain = _colliders != null && _colliders.Length > 0;
            float nearest = 1e9f; bool found = false;
            for (int i = 0; i < n; i++)
            {
                Collider c = _hitBuf[i].collider;
                if (c == _ownCollider) continue;
                if (_hitBuf[i].normal.y <= 0f) continue;        // floors only
                int ci = IndexOf(c);
                int ty = ci >= 0 ? _types[ci] : -1;
                if (haveTerrain && ty == -1) continue;          // ignore props/walls
                if (ty == 0) continue;                          // don't land back on a Reset patch
                if (_hitBuf[i].distance < nearest) { nearest = _hitBuf[i].distance; _resetGroundY = _hitBuf[i].point.y; _resetGroundNormal = _hitBuf[i].normal; found = true; }
            }
            return found;
        }

        // ---- Wedged on the level: the bump integrator [Trailmap: 395-reset-arm] --------------------------------------
        //
        // The one automatic reset the game arms from CONTACT rather than from geometry you crossed, and the reason no
        // rider ever needs a "stuck" detector: a counter that decays every tick and is fed on every tick an OBJECT
        // contact actually shoves the rider back. About five CONSECUTIVE shoved ticks carry it past the threshold and the
        // rider goes out of play - here, through the same carry-back onto the course line an authored volume fires. This
        // does not contradict the note at the top of this file: it infers nothing about the world (no void test, no
        // no-progress test), it reads contacts the obstacle sweep has already resolved, and the engine traces it.
        //
        // Both halves of the feed matter. `1 - dot(boardUp, contactNormal)` is ZERO for a rider whose board up lies along
        // the contact normal - riding ON a prop is contact without wedging, however long you stay on it - and a full 1
        // for a face square across the board's up, the wall you cannot get past. And TERRAIN never feeds it: the engine
        // arms on contact with an OBJECT, and counting the mountain would reset every rider carving a bank.
        //
        // The engine's second, slower integrator over the same feed (decay 0.97836, fire 12.0021) can only ever fire
        // later than this one on a rider this one has not already reset, so it is not fielded. Nor is the crash path's
        // "slam it to 1000000" - our wipeouts run through landBail / wallCrashSpeed instead.
        private const float WEDGE_DECAY = 0.95614f; // per fixed 60 Hz tick
        private const float WEDGE_FIRE = 4.4920f;   // ~five consecutive ticks of a square-on shove
        private float _wedge;                       // the integrator; cleared by any mount, teleport or reset

        // Decay, once per fixed tick - called from the top of Tick, so a tick that resolved no contact still bleeds it
        // down and only CONSECUTIVE shoving ticks ever reach the threshold. The feed is per-tick too (ResolveObstacles
        // runs inside the tick loop), so the engine's per-tick constants port across as they are, at any frame rate.
        void WedgeTick() { if (_wedge > 0f) _wedge *= WEDGE_DECAY; }

        // One shoved tick's contribution, from the normal of the obstacle contact that pushed us back. Zero for a tagged
        // terrain Surf_ collider - and zero on a map with no tagged terrain at all, where we cannot tell the mountain
        // from a crate and would rather arm nothing than warp a rider off a bank.
        float WedgeContribution(Collider c, Vector3 normal)
        {
            if (c == null || _colliders == null || _colliders.Length == 0) return 0f;
            if (IndexOf(c) >= 0) return 0f;                    // terrain: what a rider carves on all day
            if (normal.sqrMagnitude < 1e-6f) return 0f;
            Vector3 up = _boardUp.sqrMagnitude > 1e-6f ? _boardUp.normalized : Vector3.up;
            float dot = Vector3.Dot(up, normal.normalized);
            return dot < 0f ? 1f : 1f - dot;
        }

        // Bank one frame's worth, called by ResolveObstacles once per tick with the hardest push any iteration landed.
        void AddWedge(float amount) { if (amount > 0f) _wedge += amount; }

    }
}
