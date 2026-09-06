using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Part of BasisBoard (partial): the rail-grinding state - lock-on, along-rail motion, ollie-off, junction transfer -
    // ported from the VRChat board's RideableBoard.Rail.cs. A self-contained boarder state run BEFORE the ground/air
    // branch (BasisBoard.Ride.cs), so the tuned ride integration is untouched. The rail-slide model + provenance live in
    // docs/026-rail-grinding.md [Trailmap: 350-rails].
    //
    // Pared to the Basis MVP vs the VRChat original: stick-only steering (VR head-steer / HeadFollow not ported - same as
    // the ride branch). Grind FX (BasisBoard.Fx.cs) and grind score (BasisBoard.Score.cs: ScoreGrindFrame + rail-spin
    // accrual) ARE hooked in. The lock-on gate, anisotropic stay box, magnitude-preserving slew, smooth attach,
    // curve-fling and junction transfer are ported verbatim - it's the same math that makes a grind feel like SSX.
    public partial class BasisBoard
    {
        [Header("Rail grinding (docs/026)")]
        [Tooltip("The level's rail network. Auto-found as OpenSlope_Map/Rails (a BasisRailNetwork realized by BasisWiring) if empty.")]
        public BasisRailNetwork railNetwork;
        [Tooltip("ON: crossing an authored rail aligned + fast enough locks you onto it and you grind, preserving speed; the " +
                 "ollie hops you off, running off the end keeps your speed. Forgiving (no balance/bail). Off = rails inert.")]
        public bool railGrindEnabled = true;
        [Tooltip("How close (world m) the board must come to a rail centerline to LOCK ON.")]
        public float railSnapRadius = 0.7f;
        [Tooltip("Minimum board speed (m/s) to lock onto a rail.")]
        public float railMinSpeed = 3f;
        [Tooltip("How aligned travel must be with the rail to lock on (|dot| of horizontal velocity and rail tangent). Grind either way.")]
        public float railAlign = 0.5f;
        [Tooltip("Ride height (world m) the deck sits ABOVE the rail centerline while grinding.")]
        public float railHeight = 0.12f;
        [Tooltip("Rail drag (1/s). The game has none, so leave 0.")]
        public float railFriction = 0f;
        [Tooltip("Slope/gravity correction on the rail as a fraction of the board gravity (0..1). ~0.516 is faithful for gravity=19.")]
        [Range(0f, 1f)] public float railSlopeAccel = 0.516f;
        [Tooltip("Forward boost THRUST along the rail tangent (m/s^2) while holding boost - accelerates you uphill too.")]
        public float railBoostAccel = 24.5f;
        [Tooltip("Fall off the rail when along-rail speed drops below this (m/s).")]
        public float railMinExitSpeed = 1.5f;
        [Tooltip("BRAKE on a rail: pull back on the stick to scrub along-rail speed (m/s^2). 0 = none.")]
        public float railBrakeStrength = 16f;
        [Tooltip("CURVE FLING: throw the rider off a rail taken too fast through a bend. Off = rails only release on ollie / end / low-speed.")]
        public bool railFlingEnabled = false;
        [Tooltip("Max lateral (centripetal) accel (m/s^2) the rail holds before it FLINGS you.")]
        public float railMaxLateralAccel = 50f;
        [Tooltip("Grace (s) after locking on during which the curve-fling can't fire, and the stay box is widened to settle a sloppy catch.")]
        public float railGraceTime = 0.6f;
        [Tooltip("Transfer onto a CONNECTING rail at a junction instead of dropping off (rails chain end-to-end at the poles).")]
        public bool railTransfer = true;
        [Tooltip("How close (world m) the next rail's endpoint must be to transfer onto it.")]
        public float railTransferRadius = 1.5f;
        [Tooltip("How forward the next rail must head to transfer onto it (dot; ~0.4 ~ within 66deg).")]
        public float railTransferMinDot = 0.4f;
        [Tooltip("LAUNCH speed (m/s) when you ollie OFF a rail - split between UP and your pointing heading. Carried along-rail speed is kept.")]
        public float railOlliePush = 8f;
        [Tooltip("LATERAL accept tolerance (world m): how far to the SIDE of the line the board centre may sit and still grind (the tight axis).")]
        public float railLatTolerance = 0.45f;
        [Tooltip("VERTICAL accept tolerance (world m): how far above/below the line the board centre may be.")]
        public float railVertTolerance = 0.7f;
        [Tooltip("ALONG-RAIL accept tolerance (world m): slop past a rail end before the closest point clamps you off.")]
        public float railAlongTolerance = 0.8f;
        [Tooltip("GEOMETRY-AWARE catch reach (world m): lock-on also probes this far along the DECK (nose + tail). Capped to the deck half-length.")]
        public float railDeckReach = 0.8f;
        [Tooltip("SMOOTH ATTACH time constant (s): eases the lateral/vertical gap onto the line while advancing along the rail at full speed.")]
        public float railAttachTau = 0.12f;
        [Tooltip("VELOCITY-ALIGN slew (deg/s): how fast the carried velocity rotates onto the rail tangent, keeping its magnitude.")]
        public float railVelSlew = 540f;
        [Tooltip("RE-LOCK lockout (s) after leaving a rail, so an ollie/jump-off clears it before you can re-grab.")]
        public float railRelockCooldown = 0.35f;
        // ---- Rail runtime state -----------------------------------------------------------------------------
        bool _grinding;         // true while locked onto a rail
        int _railIndex = -1;    // which rail in railNetwork we're grinding (-1 none)
        Vector3 _railFwd;       // unit travel direction ALONG the rail (oriented to our motion)
        Vector3 _railPoint;     // last frame's contact point ON the rail (we advance from this)
        float _grindCooldown;   // brief lockout after leaving a rail
        float _grindTime;       // seconds on the current rail (drives the entry-grace window)
        float _railStress;      // low-passed lateral (centripetal) accel demand of the bend ahead
        float _deckHalf = 0.75f; // deck half-length (m); the placeholder deck is 1.5 m long

        // Scratch for RailLocalOffset + the best entry candidate (ProbeEntry).
        float _rlLat, _rlVert, _rlAlong;
        bool _entFound; int _entRail; Vector3 _entPoint; Vector3 _entTan; float _entLat;

        // Decompose a world offset 'd' into the rail's LOCAL frame at unit tangent 'tan' -> abs components in _rl*: along,
        // lateral (horizontal-perpendicular) and vertical (rail-up). The snap/stay gate is this ANISOTROPIC box, not a sphere.
        void RailLocalOffset(Vector3 d, Vector3 tan)
        {
            Vector3 t = tan.sqrMagnitude > 1e-6f ? tan.normalized : Vector3.forward;
            Vector3 right = Vector3.Cross(t, Vector3.up);
            if (right.sqrMagnitude < 1e-6f) right = Vector3.Cross(t, Vector3.forward);
            right = right.normalized;
            Vector3 rUp = Vector3.Cross(right, t).normalized;
            _rlAlong = Mathf.Abs(Vector3.Dot(d, t));
            _rlLat   = Mathf.Abs(Vector3.Dot(d, right));
            _rlVert  = Mathf.Abs(Vector3.Dot(d, rUp));
        }

        // One lock-on probe at a sample point: nearest rail, require travel is already roughly ALONG it (railAlign), accept
        // only inside the TIGHT entry box (0.9x steady). Keeps the best (smallest-lateral) candidate across deck samples.
        bool ProbeEntry(Vector3 samplePos, Vector3 velH)
        {
            railNetwork.Query(samplePos, railSnapRadius);
            if (!railNetwork.RFound) return false;
            Vector3 tan = railNetwork.RTangent;
            Vector3 tanH = new Vector3(tan.x, 0f, tan.z);
            if (tanH.sqrMagnitude < 1e-6f) return false;
            tanH = tanH.normalized;
            float align = Vector3.Dot(velH, tanH);
            if ((align < 0f ? -align : align) < railAlign) return false;
            RailLocalOffset(samplePos - railNetwork.RPoint, tan);
            if (_rlLat > railLatTolerance * 0.9f || _rlVert > railVertTolerance * 0.9f || _rlAlong > railAlongTolerance * 0.9f)
                return false;
            if (!_entFound || _rlLat < _entLat)
            { _entFound = true; _entRail = railNetwork.RRail; _entPoint = railNetwork.RPoint; _entTan = tan; _entLat = _rlLat; }
            return true;
        }

        // Try to LOCK ON to a nearby rail this frame. Geometry-aware + swept: probe the centre, the deck nose/tail, and last
        // frame's centre (anti-tunnel), accepting the nearest rail travelled roughly ALONG it inside the tight entry box. On
        // success KEEP the carried velocity - GrindUpdate's smooth attach reels the body onto the line.
        bool TryEnterGrind(Vector3 cur, float dt)
        {
            float speed = _vel.magnitude;
            if (speed < railMinSpeed) return false;
            Vector3 velH = new Vector3(_vel.x, 0f, _vel.z);
            if (velH.sqrMagnitude < 1e-4f) return false;
            velH = velH.normalized;

            Vector3 fwdH = Vector3.ProjectOnPlane(_fwd, Vector3.up);
            fwdH = fwdH.sqrMagnitude > 1e-6f ? fwdH.normalized : velH;
            float half = Mathf.Min(railDeckReach, _deckHalf);

            // Broad-phase: one cheap AnyRailNear covering all samples (nose/tail at +-half, swept last-frame centre at
            // -vel*dt, plus the snap radius). Off a rail (almost every frame) this is one tiny grid walk.
            float reach = railSnapRadius + (half > speed * dt ? half : speed * dt);
            if (!railNetwork.AnyRailNear(cur, reach)) return false;

            _entFound = false; _entLat = 1e9f;
            ProbeEntry(cur, velH);
            if (half > 0.05f)
            {
                ProbeEntry(cur + fwdH * half, velH);
                ProbeEntry(cur - fwdH * half, velH);
            }
            ProbeEntry(cur - _vel * dt, velH);
            if (!_entFound) return false;

            _grinding = true;
            _flipArmed = false;
            _airBoostActive = false; // a rail is not air - the boost roar stays silent while grinding (UpdateBoostAudio)
            _railIndex = _entRail;
            Vector3 entTanH = new Vector3(_entTan.x, 0f, _entTan.z);
            float along = entTanH.sqrMagnitude > 1e-6f ? Vector3.Dot(velH, entTanH.normalized) : 1f;
            _railFwd = along >= 0f ? _entTan : -_entTan;
            railNetwork.QueryRail(_railIndex, cur);
            _railPoint = railNetwork.RFound ? railNetwork.RPoint : _entPoint;
            _grindTime = 0f; _railStress = 0f;
            _jumpGrace = 0f;
            StartGrindFx();   // sparks + scrape loop alive on lock-on
            return true;
        }

        // Advance along the rail and re-project onto it; apply gravity-along-rail + boost/brake; orient; handle exits. Owns
        // the whole frame. Called from the ride Update when _grinding (or right after TryEnterGrind succeeds).
        void GrindUpdate(Vector3 cur, float dt, bool vr)
        {
            float speed = _vel.magnitude;
            Vector3 predicted = _railPoint + _railFwd * (speed * dt);
            railNetwork.QueryRail(_railIndex, predicted);
            if (!railNetwork.RFound) { ExitGrind(); return; }

            Vector3 tan = railNetwork.RTangent;
            if (Vector3.Dot(tan, _railFwd) < 0f) tan = -tan;
            _railFwd = tan;

            _grindTime += dt;
            ScoreGrindFrame(dt); // staying on the rail accrues linear style as part of the open trick (banked when you land off)

            // Ollie OFF the rail (the queued charged-jump release): pop up + keep along-rail speed. Facing forward the whole
            // budget goes UP; turned across/back it splits ~half up / half along the pointing heading so you peel off.
            if (_releaseQueued)
            {
                _releaseQueued = false; _charging = false; _charge = 0f;
                Vector3 h = Vector3.ProjectOnPlane(_fwd, Vector3.up);
                Vector3 travelH = new Vector3(_railFwd.x, 0f, _railFwd.z);
                h = h.sqrMagnitude > 1e-6f ? h.normalized : (travelH.sqrMagnitude > 1e-6f ? travelH.normalized : Vector3.zero);
                float fwd = travelH.sqrMagnitude > 1e-6f ? Mathf.Max(0f, Vector3.Dot(h, travelH.normalized)) : 0f;
                float popUp = railOlliePush * (0.5f + 0.5f * fwd * fwd);
                _vel += Vector3.up * popUp + h * (railOlliePush - popUp);
                ExitGrind();
                return;
            }

            // Ran off an end (closest point clamped to either endpoint while still moving forward). Transfer onto a
            // connecting rail at the junction if one continues forward, else drop off.
            if ((railNetwork.RAtEnd || railNetwork.RAtStart) && Vector3.Dot(_vel, tan) > 0f)
            {
                if (railTransfer && TryTransferRail(railNetwork.RPoint, tan))
                {
                    railNetwork.QueryRail(_railIndex, _railPoint);
                    tan = railNetwork.RTangent;
                    if (Vector3.Dot(tan, _railFwd) < 0f) tan = -tan;
                    _railFwd = tan;
                    _vel = tan * _vel.magnitude;
                }
                else { ExitGrind(); return; }
            }

            // Preserve the rail's own SplineStyle as the active contact surface. This makes Alaska's named style-5
            // IceRails hand their ice row through the grind/landing transition instead of retaining the last terrain
            // or generic-metal row. RailNetwork supplies 13 for older manifests with no per-rail style array.
            _pSurf = railNetwork.RSurface;
            _sinkBudget = Mathf.MoveTowards(_sinkBudget, SinkBudgetFor(_pSurf), sinkBudgetSlew * dt);

            // STAY GATE (the anisotropic rail-local box), measured from the current on-rail foot (_railPoint), not the
            // looked-ahead point. During the grace the lateral/along windows widen so a sloppy catch settles, then tighten.
            RailLocalOffset(transform.position - _railPoint, tan);
            bool grace = _grindTime < railGraceTime;
            float latBox   = grace ? (railDeckReach + railLatTolerance) : railLatTolerance;
            float vertBox  = grace ? (railVertTolerance + 0.2f)         : railVertTolerance;
            float alongBox = grace ? (railAlongTolerance * 2f)          : railAlongTolerance;
            if (_rlLat > latBox || _rlVert > vertBox || _rlAlong > alongBox) { ExitGrind(); return; }

            // Along-rail speed model on the carried MAGNITUDE (magnitude-preserving). Boost is a forward thrust along the
            // tangent (climbs uphill) plus the shared cap; brake scrubs; optional friction. Too slow -> fall off.
            if (railSlopeAccel != 0f) speed += railSlopeAccel * Vector3.Dot(Vector3.down * gravity, tan) * dt;
            if (BoostActive() && railBoostAccel != 0f) speed += railBoostAccel * dt;
            if (_throttle < 0f && railBrakeStrength > 0f) speed += _throttle * railBrakeStrength * dt;
            if (railFriction > 0f) speed *= 1f / (1f + railFriction * dt);
            float capTarget = BoostActive() ? boostMaxSpeed : maxSpeed;
            if (capTarget >= _speedCap) _speedCap = capTarget;
            else _speedCap = Mathf.MoveTowards(_speedCap, capTarget, boostCapDecay * dt);
            if (speed > _speedCap) speed = _speedCap;
            if (speed < railMinExitSpeed) { ExitGrind(); return; }

            // Velocity: ease its DIRECTION onto the tangent, keeping the (slewed) magnitude - so the exit/ollie carries the
            // right line. After it aligns, _vel == tan*speed.
            Vector3 vdir = _vel.sqrMagnitude > 1e-6f ? _vel.normalized : tan;
            vdir = Vector3.RotateTowards(vdir, tan, railVelSlew * Mathf.Deg2Rad * dt, 0f);
            if (vdir.sqrMagnitude < 1e-6f) vdir = tan;
            _vel = vdir.normalized * speed;

            // SMOOTH POSITION ATTACH: advance FULLY along the rail (take all the along-error) but EASE the lateral/vertical
            // gap toward the line over railAttachTau. railAttachTau<=0 falls back to an instant snap.
            Vector3 restPos = railNetwork.RPoint + Vector3.up * railHeight;
            Vector3 toRest = restPos - transform.position;
            float alongErr = Vector3.Dot(toRest, tan);
            Vector3 perp = toRest - alongErr * tan;
            float kAttach = railAttachTau > 1e-4f ? (1f - Mathf.Exp(-dt / railAttachTau)) : 1f;
            transform.position = transform.position + tan * alongErr + perp * kAttach;
            _railPoint = railNetwork.RPoint;

            // CURVE FLING (off by default): if the centripetal accel to follow the bend exceeds railMaxLateralAccel, momentum
            // carries you off the outside. Sample the tangent ~3 m ahead, low-pass, gated by the landing grace.
            if (railFlingEnabled)
            {
                railNetwork.QueryRail(_railIndex, _railPoint + tan * 3f);
                Vector3 tanAhead = railNetwork.RTangent;
                if (Vector3.Dot(tanAhead, tan) < 0f) tanAhead = -tanAhead;
                float curveRad = Vector3.Angle(tan, tanAhead) * Mathf.Deg2Rad / 3f;
                float lateral = speed * speed * curveRad;
                _railStress = Mathf.Lerp(_railStress, lateral, dt / (0.1f + dt));
                if (_grindTime > railGraceTime && _railStress > railMaxLateralAccel) { ExitGrind(); return; }
            }

            // HEADING is freely STEERED while grinding (stick), the deck levels on the rail; travel stays rail-locked (_vel
            // above), so the deck can face any direction (a boardslide). VR gaze-steer isn't ported - stick only, like the ride.
            _boardUp = Vector3.RotateTowards(_boardUp, Vector3.up, tiltRate * Mathf.Deg2Rad * dt, 0f);
            if (_boardUp.sqrMagnitude < 1e-6f) _boardUp = Vector3.up;
            // RAIL SPINS score like air spins (the shared spin scorer): accrue the deck's yaw as discrete spins on TOP of the
            // base grind style, so a 360 on a rail is worth a 360 too.
            Vector3 fwdPreSpin = _fwd;
            float spinBoostMul = (airTrickBoostSpinMul > 1f && BoostActive()) ? airTrickBoostSpinMul : 1f;
            _fwd = Quaternion.AngleAxis(_steer * airTurnRate * spinBoostMul * dt, _boardUp) * _fwd;
            if (scoringEnabled)
            {
                Vector3 spA = Vector3.ProjectOnPlane(fwdPreSpin, _boardUp);
                Vector3 spB = Vector3.ProjectOnPlane(_fwd, _boardUp);
                if (spA.sqrMagnitude > 1e-6f && spB.sqrMagnitude > 1e-6f) _scoreSpinDeg += Vector3.Angle(spA, spB);
            }
            Vector3 fp = Vector3.ProjectOnPlane(_fwd, _boardUp);
            _fwd = fp.sqrMagnitude > 1e-6f ? fp.normalized : _fwd;
            _lean = Mathf.MoveTowards(_lean, 0f, 8f * dt);
            _bank = Mathf.MoveTowards(_bank, 0f, 360f * dt);
            _slip = 0f;
            ApplyGrindOrientation(vr);

            UpdateGrindFx(dt);   // ride the scrape volume/pitch on speed + kick sparks off the rail seam
            UpdateBoardAudio(false, dt); // fade the snow glide/carve loops out while grinding (the scrape loop covers the rail)
            UpdateBoostAudio(false, dt); // rail boost is silent (matches the ground-only boost roar)
            _wasGrounded = false; _wasAir = true; // next normal frame treats the dismount/exit like an air->ground edge
        }

        // At a rail end, TRANSFER onto a connecting rail at the junction (rails join end-to-end at the poles). Returns true
        // and re-points the grind state onto the new rail if one continues roughly forward within railTransferRadius.
        bool TryTransferRail(Vector3 junction, Vector3 travelDir)
        {
            railNetwork.QueryTransfer(junction, travelDir, _railIndex, railTransferRadius, railTransferMinDot);
            if (!railNetwork.RFound) return false;
            _railIndex = railNetwork.RRail;
            _railFwd = railNetwork.RTangent;
            _railPoint = railNetwork.RPoint;
            return true;
        }

        // Leave the grind: brief cooldown so the hop-off/jump clears the rail before we can re-lock.
        void ExitGrind()
        {
            _grinding = false;
            _railIndex = -1;
            _grindCooldown = railRelockCooldown;
            _wasGrounded = false;
            _wasAir = true;
            StopGrindFx();
        }

        // Deck + seat orientation while grinding (same shape as the ride's visual orientation). The visible deck (Heading
        // pivot) faces the steered heading, level on the rail; the SEAT (root) stays level + yawed to the heading so the
        // grind never rolls the rider.
        void ApplyGrindOrientation(bool vr)
        {
            Vector3 faceDir = Vector3.ProjectOnPlane(_fwd, _boardUp);
            faceDir = faceDir.sqrMagnitude > 1e-6f ? faceDir.normalized : _fwd;
            Quaternion deckRot = Quaternion.LookRotation(faceDir, _boardUp);

            Vector3 seatFwd = Vector3.ProjectOnPlane(faceDir, Vector3.up);
            if (seatFwd.sqrMagnitude < 1e-6f) seatFwd = Vector3.ProjectOnPlane(_fwd, Vector3.up);
            if (seatFwd.sqrMagnitude < 1e-6f) seatFwd = Vector3.forward;
            transform.rotation = Quaternion.LookRotation(seatFwd.normalized, Vector3.up);

            // Deck (or skis) level on the rail: no unit bank on a rail; a ski pair rolls each ski to flat as _bank decays.
            ApplyDeckOrientation(deckRot, deckRot);
        }

        // Auto-find the level's rail network (OpenSlope_Map/Rails), realized by BasisWiring. Called from the board's Start.
        void FindRailNetwork()
        {
            if (railNetwork != null) return;
            GameObject railGo = GameObject.Find("OpenSlope_Map/Rails");
            if (railGo != null) railNetwork = railGo.GetComponent<BasisRailNetwork>();
        }

        // Reset the grind state (mount / dismount / respawn), so a fresh ride never inherits a stale lock.
        void ResetGrind()
        {
            _grinding = false;
            _railIndex = -1;
            _grindCooldown = 0f;
            _railStress = 0f;
        }
    }
}
