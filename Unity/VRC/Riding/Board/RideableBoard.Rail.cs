using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.Udon.Common;

namespace OpenSlope.VrcPlugin
{

    // Part of RideableBoard (partial): the rail-grinding state machine - lock-on, along-rail motion, ollie-off,
    // junction transfer, and grind FX. A self-contained boarder state (own move + orient + FX), so the tuned ground/air
    // integration is untouched. The rail-slide model + design provenance live in docs/026-rail-grinding.md. [Trailmap: 350-rails]
    public partial class RideableBoard
    {
        // ---- Rail grinding (the third boarder state - the rail-slide motion state; docs/026) ---------------------
        // Snap onto a rail when close enough, fast enough, and travelling along its tangent; then advance along the
        // spline preserving tangent speed, with exits at rail end, ollie, low speed, or large stray. Forgiving first
        // pass: no balance/bail wipeout.

        // Scratch for the rail-local offset decomposition (RailLocalOffset) and the best entry candidate (ProbeEntry).
        private float _rlLat, _rlVert, _rlAlong;
        private bool _entFound; private int _entRail; private Vector3 _entPoint; private Vector3 _entTan; private float _entLat;

        // Decompose a world offset 'd' into the rail's LOCAL frame at unit tangent 'tan' -> abs components in _rl*:
        // along the rail, lateral (horizontal-perpendicular) and vertical (rail-up). The game's snap/stay gate is this
        // ANISOTROPIC box (lateral tight, vertical/along looser), not an isotropic distance - so a landing that's a bit
        // high AND a bit to the side still catches, where a sphere wrongly rejects that diagonal case.
        // Rail-attach gate: |c0|<lerp(80,150,b) / |c1|<72 / |c2|<lerp(30,72,b) engine units (/100 = m) [Trailmap: 350-rails].
        void RailLocalOffset(Vector3 d, Vector3 tan)
        {
            Vector3 t = tan.sqrMagnitude > 1e-6f ? tan.normalized : Vector3.forward;
            Vector3 right = Vector3.Cross(t, Vector3.up);
            if (right.sqrMagnitude < 1e-6f) right = Vector3.Cross(t, Vector3.forward); // near-vertical rail fallback
            right = right.normalized;
            Vector3 rUp = Vector3.Cross(right, t).normalized;
            _rlAlong = Mathf.Abs(Vector3.Dot(d, t));
            _rlLat   = Mathf.Abs(Vector3.Dot(d, right));
            _rlVert  = Mathf.Abs(Vector3.Dot(d, rUp));
        }

        // One geometry-aware lock-on probe at a sample point: find the nearest rail, require our travel is already roughly
        // ALONG it (railAlign), and accept only inside the TIGHT entry box (0.9x the steady tolerances, the entry-box
        // scale). Keeps the best (smallest-lateral) candidate across the deck samples in _ent*. Returns true if accepted.
        bool ProbeEntry(Vector3 samplePos, Vector3 velH)
        {
            railNetwork.Query(samplePos, railSnapRadius);
            if (!railNetwork.RFound) return false;
            Vector3 tan = railNetwork.RTangent;
            Vector3 tanH = new Vector3(tan.x, 0f, tan.z);
            if (tanH.sqrMagnitude < 1e-6f) return false;
            tanH = tanH.normalized;
            float align = Vector3.Dot(velH, tanH);
            if ((align < 0f ? -align : align) < railAlign) return false; // not travelling along this rail
            RailLocalOffset(samplePos - railNetwork.RPoint, tan);
            if (_rlLat > railLatTolerance * 0.9f || _rlVert > railVertTolerance * 0.9f || _rlAlong > railAlongTolerance * 0.9f)
                return false;                            // outside the tight entry box
            if (!_entFound || _rlLat < _entLat)
            { _entFound = true; _entRail = railNetwork.RRail; _entPoint = railNetwork.RPoint; _entTan = tan; _entLat = _rlLat; }
            return true;
        }

        // Try to LOCK ON to a nearby rail this frame. GEOMETRY-AWARE + swept: probe the board CENTRE, the deck NOSE/TAIL
        // (out to railDeckReach) and last frame's centre (anti-tunnel), accepting the nearest rail travelled roughly ALONG
        // (railAlign) and inside the tight anisotropic entry box. On success we KEEP the carried velocity (magnitude-
        // preserving) and let GrindUpdate's smooth attach reel the body onto the line - so a sideways/sloppy catch turns
        // its speed into along-rail speed instead of dropping the off-rail component. See docs/026.
        bool TryEnterGrind(Vector3 cur, float dt)
        {
            float speed = _vel.magnitude;
            if (speed < railMinSpeed) return false;
            Vector3 velH = new Vector3(_vel.x, 0f, _vel.z);
            if (velH.sqrMagnitude < 1e-4f) return false;
            velH = velH.normalized;

            Vector3 fwdH = Vector3.ProjectOnPlane(_fwd, Vector3.up);
            fwdH = fwdH.sqrMagnitude > 1e-6f ? fwdH.normalized : velH;
            float half = Mathf.Min(railDeckReach, _deckLenBase * 0.5f * _riderScale);

            // Broad-phase gate: skip the four ProbeEntry calls below with one cheap AnyRailNear (grid) query whenever no
            // rail is within reach of any sample - the nose/tail sit +-half from cur and the swept last-frame centre at
            // -vel*dt, so every sample is within max(half, speed*dt) of cur; add the snap radius for a conservative reach
            // that never gates out a catchable rail. Off a rail (almost every frame) this is one tiny grid walk.
            float reach = railSnapRadius + (half > speed * dt ? half : speed * dt);
            if (!railNetwork.AnyRailNear(cur, reach)) return false;

            _entFound = false; _entLat = 1e9f;
            ProbeEntry(cur, velH);                       // board centre
            if (half > 0.05f)
            {
                ProbeEntry(cur + fwdH * half, velH);     // deck NOSE - a rail near the front end still catches
                ProbeEntry(cur - fwdH * half, velH);     // deck TAIL
            }
            ProbeEntry(cur - _vel * dt, velH);           // last frame's centre (swept - a fast drop can't tunnel the rail)
            if (!_entFound) return false;

            _grinding = true;
            _flipArmed = false; // locking onto a rail ends any in-air flip, so leaving the rail can't inherit a stale armed flip
            _railIndex = _entRail;
            Vector3 entTanH = new Vector3(_entTan.x, 0f, _entTan.z);
            float along = entTanH.sqrMagnitude > 1e-6f ? Vector3.Dot(velH, entTanH.normalized) : 1f;
            _railFwd = along >= 0f ? _entTan : -_entTan;   // travel along the rail the way we're already going
            railNetwork.QueryRail(_railIndex, cur);        // start from the CENTRE's on-rail point (attach reels the body, not the tip)
            _railPoint = railNetwork.RFound ? railNetwork.RPoint : _entPoint;
            _grindTime = 0f; _railStress = 0f;
            _jumpGrace = 0f;                              // a grind owns its own ollie-off; don't let frozen ground-coyote leak into the post-grind air
            // A grind frame runs ZERO contact ticks, so the contact sensors would otherwise sit FROZEN at whatever the last
            // tick saw for the whole grind. Say what's actually true - we're on a rail, not on terrain - so nothing reads
            // stale ground off us: notably the OOB Surf_0 check (OutOfBounds.cs), which would fire mid-grind off a frozen
            // grounded-on-Reset if you crossed a Reset patch and ollied straight onto the rail. -2 = airborne (the surface
            // detector's own value for "nothing found"); it also keeps the boost sfx correctly silent on a rail
            // (UpdateBoostAudio - the air-boost flag is dropped too: a rail is not air). The probe re-derives both on
            // the first post-grind tick, so nothing leaks back out.
            _wasGrounded = false; _pSurf = -2; _airBoostActive = false;
            // We deliberately DON'T touch _fwd here - the board keeps the yaw it LANDED with and free-steers from there;
            // travel is rail-locked regardless. We KEEP _vel: the smooth attach (GrindUpdate) slews it onto the tangent.
            StartGrindFx();
            return true;
        }

        // Advance along the rail and re-project onto it (so we travel the curve, not stick at one projection); apply
        // gravity-along-the-rail + boost/brake; orient + drive FX; and handle the exits. Owns the whole frame.
        void GrindUpdate(Vector3 cur, float dt, bool vr)
        {
            // Advance from the last on-rail contact point ALONG THE RAIL at our carried speed (not raw _vel, which may
            // still be settling onto the tangent during the attach), then snap back onto the spline.
            float speed = _vel.magnitude;
            Vector3 predicted = _railPoint + _railFwd * (speed * dt);
            railNetwork.QueryRail(_railIndex, predicted);
            if (!railNetwork.RFound) { ExitGrind(); return; } // rail data gone (shouldn't happen)

            Vector3 tan = railNetwork.RTangent;
            if (Vector3.Dot(tan, _railFwd) < 0f) tan = -tan; // keep going the same way along the rail
            _railFwd = tan;

            _grindTime += dt;            // seconds on this rail; drives the entry-grace window (railGraceTime)
            // Score the grind: staying on the rail accrues the linear base style every frame as part of the open trick (the
            // run clock keeps ticking here too - this branch returns before ScoreUpdate). Spins on the rail are scored
            // separately, as discrete spins (just above, into _scoreSpinDeg). See docs/050.
            ScoreGrindFrame(dt);

            // Hop OFF the rail (staying on the board) with the OLLIE (Use / right-trigger / left-click): pop up and keep
            // your along-rail speed. Jump is NOT handled here - it fully dismounts (InputJump).
            if (_releaseQueued)
            {
                _releaseQueued = false; _charging = false; _charge = 0f;
                // LAUNCH off the rail with a fixed speed budget (railOlliePush) split between UP and the board's POINTING
                // heading (the freely-steered _fwd, flattened). Facing forward the whole budget goes UP; turned across/back
                // it splits ~half up / half along the heading so you peel off the line. Forwardness is the squared cos of
                // heading-vs-rail-travel: up = budget*(0.5 + 0.5*fwd^2). (We KEEP the carried along-rail velocity.)
                Vector3 h = Vector3.ProjectOnPlane(_fwd, Vector3.up);
                Vector3 travelH = new Vector3(_railFwd.x, 0f, _railFwd.z);
                h = h.sqrMagnitude > 1e-6f ? h.normalized : (travelH.sqrMagnitude > 1e-6f ? travelH.normalized : Vector3.zero);
                float fwd = travelH.sqrMagnitude > 1e-6f ? Mathf.Max(0f, Vector3.Dot(h, travelH.normalized)) : 0f;
                float popUp = railOlliePush * (0.5f + 0.5f * fwd * fwd); // 50%..100% of the budget goes up (forward = all up)
                _vel += Vector3.up * popUp + h * (railOlliePush - popUp); // remainder shoves along the pointing heading
                if (eventSource != null && ollieClip != null)
                    eventSource.PlayOneShot(ollieClip, Mathf.Clamp01(0.6f * soundVolume));
                ExitGrind();
                return;
            }

            // Ran off an end of the rail. tan is travel-oriented, so Dot(_vel, tan) >= 0 - when we've clamped to EITHER
            // endpoint (RAtEnd OR RAtStart) and we're still moving, we've run off that end. (Gating RAtStart on Dot < 0
            // can never be true once tan is travel-oriented, and would leave the board STUCK at a rail's START vertex
            // when grinding start-ward; see docs/026.) If a CONNECTING rail continues from the junction, TRANSFER; else drop off.
            if ((railNetwork.RAtEnd || railNetwork.RAtStart) && Vector3.Dot(_vel, tan) > 0f)
            {
                if (railTransfer && TryTransferRail(railNetwork.RPoint, tan))
                {
                    // Re-query the NEW rail at the junction so R* are consistent for the rest of the frame, re-point the
                    // tangent, and redirect velocity onto it preserving speed through the junction.
                    railNetwork.QueryRail(_railIndex, _railPoint);
                    tan = railNetwork.RTangent;
                    if (Vector3.Dot(tan, _railFwd) < 0f) tan = -tan;
                    _railFwd = tan;
                    _vel = tan * _vel.magnitude;
                }
                else { ExitGrind(); return; } // ran off the end, nothing to transfer onto
            }

            // A grind owns a surface row just like terrain contact does. Keep the physical probe at -2 (there is no
            // terrain hit while rail-locked), but slew the same response fields toward this rail's authored SplineStyle.
            // This is what distinguishes Alaska's style-5 IceRails from ordinary style-13 metal, including after a
            // junction transfer; older bundles report 13 from RailNetwork's compatibility fallback.
            _rideSurf = railNetwork.RSurface;
            float surfaceSlew = RIDE_CONTACT_FIELD_SLEW * dt;
            _sinkBudget = Mathf.MoveTowards(_sinkBudget, SurfBudget(_rideSurf), surfaceSlew);
            _sinkBog = Mathf.MoveTowards(_sinkBog, SurfBog(_rideSurf), surfaceSlew);
            _lift = Mathf.MoveTowards(_lift, 0f, surfaceSlew); // railHeight already seats the deck on the tube crown
            _error = 0f;

            // STAY GATE (the game's ANISOTROPIC rail-local box, not an isotropic stray radius). Decompose the board
            // centre's offset from the line into along/lateral/vertical and require all three inside their windows. For the
            // first railGraceTime (the b=1 grace) lateral/along widen so a sloppy or geometry-aware (deck-end)
            // catch SETTLES while the smooth attach reels the body in, then the box tightens to its steady tolerances.
            // Measure from _railPoint (the board's CURRENT on-rail foot, set by last frame's attach), NOT the looked-ahead
            // QueryRail point: the look-ahead sits speed*dt down the rail, so measuring against it would bake that per-frame
            // advance into the ALONG axis (~speed*dt) and spuriously trip the gate at speed - the attach removes that lag
            // every frame anyway. Against the foot point, ALONG reflects genuine slop (~0 mid-rail, only grows near a real
            // end, where RAtEnd/RAtStart already handle the drop-off); lateral/vertical are unchanged.
            RailLocalOffset(transform.position - _railPoint, tan);
            bool grace = _grindTime < railGraceTime;
            float latBox   = grace ? (railDeckReach + railLatTolerance) : railLatTolerance; // grace covers a deck-end catch's centre offset
            float vertBox  = grace ? (railVertTolerance + 0.2f)         : railVertTolerance;
            float alongBox = grace ? (railAlongTolerance * 2f)          : railAlongTolerance;
            if (_rlLat > latBox || _rlVert > vertBox || _rlAlong > alongBox) { ExitGrind(); return; } // strayed off the line

            // Along-rail speed model on the carried MAGNITUDE (magnitude-preserving: a sloppy/sideways catch keeps its
            // speed and the slew below rotates it onto the rail, instead of projecting away the off-tangent part). Boost is
            // TWO paths (docs/026): a forward THRUST along the tangent (railBoostAccel, climbs an UPHILL rail) and the
            // shared cap (BOOST_MAX_SPEED, clamps DOWN only). Too slow -> fall off.
            if (railSlopeAccel != 0f) speed += railSlopeAccel * Vector3.Dot(Vector3.down * RIDE_AIR_GRAVITY_FALLING, tan) * dt; // slope/gravity correction (0 = magnitude-preserving)
            if (BoostActive() && railBoostAccel != 0f) speed += railBoostAccel * dt;          // rail boost thrust along the tangent (held boost or a speed pad)
            if (_throttle < 0f && railBrakeStrength > 0f) speed += _throttle * railBrakeStrength * dt;         // BRAKE: pull back to scrub speed (accessibility add; the game has no rail brake)
            if (railFriction > 0f) speed *= 1f / (1f + railFriction * dt);   // optional light rail drag (0 = faithful; game has none)
            float capTarget = BoostActive() ? BOOST_MAX_SPEED : MAX_SPEED; // boost also raises the cap (clamps DOWN only)
            if (capTarget >= _speedCap) _speedCap = capTarget;
            else _speedCap = Mathf.MoveTowards(_speedCap, capTarget, BOOST_CAP_DECAY * dt);
            if (speed > _speedCap) speed = _speedCap;
            if (speed < railMinExitSpeed) { ExitGrind(); return; } // stalled out

            // Velocity: ease its DIRECTION onto the tangent at railVelSlew, keeping the (slewed) magnitude - the game's
            // magnitude-preserving rail slew. After it aligns, _vel == tan*speed (so the exit/ollie carries the right line).
            Vector3 vdir = _vel.sqrMagnitude > 1e-6f ? _vel.normalized : tan;
            vdir = Vector3.RotateTowards(vdir, tan, railVelSlew * Mathf.Deg2Rad * dt, 0f);
            if (vdir.sqrMagnitude < 1e-6f) vdir = tan;
            _vel = vdir.normalized * speed;

            // SMOOTH POSITION ATTACH (game-authentic gradual attach, NOT an instant teleport): advance the board FULLY
            // along the rail (take all of the along-error so it tracks the spline at full speed) but EASE the lateral/
            // vertical gap toward the line over railAttachTau. railAttachTau<=0 falls back to an instant snap.
            Vector3 restPos = railNetwork.RPoint + Vector3.up * railHeight;  // the deck sits railHeight above the line
            Vector3 toRest = restPos - transform.position;
            float alongErr = Vector3.Dot(toRest, tan);
            Vector3 perp = toRest - alongErr * tan;
            float kAttach = railAttachTau > 1e-4f ? (1f - Mathf.Exp(-dt / railAttachTau)) : 1f;
            transform.position = transform.position + tan * alongErr + perp * kAttach;
            _railPoint = railNetwork.RPoint;                                 // remember the on-rail point for next frame

            // CURVE FLING - the game's "thrown off without jumping" (a GEOMETRIC stray off the line, NOT a balance meter;
            // docs/026). The lateral (centripetal) accel needed to follow the bend = speed^2 * curvature; if it's more
            // than the rail can hold, your momentum carries you off the outside. We sample the tangent a short look AHEAD
            // for the curvature, low-pass it, and fling past railMaxLateralAccel - gated by a landing grace. On fling we
            // keep _vel (tangent), so you fly off the bend and arc down under gravity.
            if (railFlingEnabled)
            {
                railNetwork.QueryRail(_railIndex, _railPoint + tan * 3f);     // tangent ~3 m ahead
                Vector3 tanAhead = railNetwork.RTangent;
                if (Vector3.Dot(tanAhead, tan) < 0f) tanAhead = -tanAhead;
                float curveRad = Vector3.Angle(tan, tanAhead) * Mathf.Deg2Rad / 3f; // rad per metre
                float lateral = speed * speed * curveRad;                    // centripetal accel (m/s^2)
                _railStress = Mathf.Lerp(_railStress, lateral, dt / (0.1f + dt)); // light low-pass (~0.1 s)
                if (_grindTime > railGraceTime && _railStress > railMaxLateralAccel)
                {
                    ExitGrind(); // curve too tight for the speed - flung off the bend
                    return;
                }
            }

            // The board's HEADING is FREELY STEERED while grinding (it does NOT snap to the rail). In VR a deflected
            // precision-shaped left stick owns it at the shared air/rail rate + full view carry; full lock remains 100%, and centred
            // hands it to target-based head steering. Desktop uses the same curve. We KEEP the yaw you LANDED with, so
            // you grind at that angle and steer from there. TRAVEL stays rail-locked (_vel above), so the deck can face
            // anywhere - even sideways (a boardslide).
            _boardUp = Vector3.RotateTowards(_boardUp, Vector3.up, RIDE_GROUND_ORIENT_RATE_CAP * Mathf.Deg2Rad * dt, 0f); // deck levels on the rail
            if (_boardUp.sqrMagnitude < 1e-6f) _boardUp = Vector3.up;
            // RAIL SPINS score like air spins (the game scores both through the same spin scorer) - so a 360 on a rail
            // is worth a discrete 360 on TOP of the base grind style. Accrue the deck's yaw rotation (stick or VR head)
            // into _scoreSpinDeg, measured as the in-deck-plane angle turned.
            Vector3 fwdPreSpin = _fwd;
            float spinBoostMul = (airTrickBoostSpinMul > 1f && BoostActive()) ? airTrickBoostSpinMul : 1f;
            if (vr)
            {
                if (StickActive())
                {
                    // VR RAIL STICK: precision-shaped input and full seat/view carry. Hard lock still reaches the full
                    // air/rail rate. The grounded 25% carry stops here; releasing hands control back to gentle HeadFollow.
                    float stickRailYaw = StickSteer() * RIDE_AIR_TURN_RATE * spinBoostMul * dt;
                    _fwd = Quaternion.AngleAxis(stickRailYaw, _boardUp) * _fwd;
                    _seatFwd = Quaternion.AngleAxis(stickRailYaw, Vector3.up) * _seatFwd;
                }
                else _fwd = HeadFollow(_fwd, _boardUp, dt, RIDE_AIR_TURN_RATE);
            }
            else // desktop: precision-shaped A/D / stick, at the same full rate as air at hard left/right
                _fwd = Quaternion.AngleAxis(StickSteer() * RIDE_AIR_TURN_RATE * spinBoostMul * dt, _boardUp) * _fwd;
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

            UpdateGrindFx(dt);
            _wasGrounded = false; _wasAir = true; // next normal frame treats the dismount/exit like an air->ground edge
            RiderVelocity = _vel;
        }

        // At a rail end, try to TRANSFER onto a connecting rail at the junction (rails join end-to-end at the poles).
        // Returns true and re-points the grind state onto the new rail if one continues roughly forward within
        // railTransferRadius; false means nothing connects -> drop off.
        bool TryTransferRail(Vector3 junction, Vector3 travelDir)
        {
            railNetwork.QueryTransfer(junction, travelDir, _railIndex, railTransferRadius, railTransferMinDot);
            if (!railNetwork.RFound) return false;
            _railIndex = railNetwork.RRail;
            _railFwd = railNetwork.RTangent;   // outgoing direction along the new rail
            _railPoint = railNetwork.RPoint;   // the new rail's connecting endpoint (the junction)
            return true;
        }

        // Leave the grind: brief cooldown so the hop-off/jump clears the rail before we can re-lock, and stop the FX.
        void ExitGrind()
        {
            _grinding = false;
            _railIndex = -1;
            _grindCooldown = railRelockCooldown;
            _wasGrounded = false;
            StopGrindFx();
        }

        // Deck + seat orientation while grinding (same model as the air state). The VISIBLE deck faces the freely-steered
        // heading _fwd, level on the rail. Seat: VR PINNED + level (the head IS the free-look); desktop the camera FOLLOWS
        // the steered heading (and the mouse free-looks). Old board (no Heading pivot) rotates the whole board.
        void ApplyGrindOrientation(bool vr)
        {
            Vector3 faceDir = Vector3.ProjectOnPlane(_fwd, _boardUp);
            faceDir = faceDir.sqrMagnitude > 1e-6f ? faceDir.normalized : _fwd;
            Quaternion deckRot = Quaternion.LookRotation(faceDir, _boardUp);
            if (_pivot != null)
            {
                if (_seatFwd.sqrMagnitude < 1e-6f) _seatFwd = Vector3.ProjectOnPlane(faceDir, Vector3.up).normalized;
                if (vr)
                {
                    Vector3 sp = Vector3.ProjectOnPlane(_seatFwd, Vector3.up);
                    if (sp.sqrMagnitude > 1e-6f) _seatFwd = sp.normalized;
                    transform.rotation = Quaternion.LookRotation(_seatFwd, Vector3.up); // pinned + level; the head is the free-look
                }
                else
                {
                    Vector3 bh = Vector3.ProjectOnPlane(_fwd, Vector3.up);               // desktop camera follows the steered heading
                    if (bh.sqrMagnitude > 1e-6f) _seatFwd = bh.normalized;
                    transform.rotation = Quaternion.LookRotation(_seatFwd, Vector3.up);
                }
                _pivot.position = transform.position; // grinding doesn't bank: clear any carve edge-lift left from the ride
                _pivot.rotation = deckRot;             // child world pose LAST, after the parent seat rotation
            }
            else transform.rotation = deckRot;
        }

        // Bring the grind loop + sparks alive on lock-on (and stop the snow wake - we're off the snow now).
        void StartGrindFx()
        {
            _sparkAccum = 0f;
            if (grindSource != null)
            {
                grindSource.loop = true;
                if (grindClip != null) grindSource.clip = grindClip;
                grindSource.volume = 0f;
                grindSource.Play();
            }
            if (sparks != null) sparks.Play();
            ClearWake(); // on a rail there's no snow wake; drop the ribbon so it doesn't stitch across the grind
            _grindFxOn = grindSource != null || sparks != null;
        }

        // Silence + clear the grind FX when leaving a rail / dismounting.
        void StopGrindFx()
        {
            _grindFxOn = false;
            _gritOn = false; // the shared spark system just stopped - the terrain grit gate must re-Play it on its next metal contact
            if (grindSource != null) grindSource.Stop();
            if (sparks != null) { sparks.Stop(); sparks.Clear(); }
        }

        // Per-frame grind FX: fade the snow glide/carve loops out (we skip UpdateBoardAudio on the grind path), ride the
        // grind scrape's volume/pitch on speed, and kick sparks off the contact point.
        void UpdateGrindFx(float dt)
        {
            float speed = _vel.magnitude;
            if (glideSource != null) glideSource.volume = Mathf.MoveTowards(glideSource.volume, 0f, soundFade * dt);
            if (carveSource != null) carveSource.volume = Mathf.MoveTowards(carveSource.volume, 0f, soundFade * dt);
            UpdateBigAirWind(true, dt); // a rail is not airborne; keep the rider wind stopped and its edge latch grounded

            if (grindSource != null)
            {
                float span = Mathf.Max(0.1f, glideFullSpeed - glideMinSpeed);
                float s01 = Mathf.Clamp01((speed - glideMinSpeed) / span);
                grindSource.volume = Mathf.MoveTowards(grindSource.volume, grindVolume * s01 * soundVolume, soundFade * dt);
                grindSource.pitch = Mathf.Lerp(0.9f, 1.4f, s01);
            }

            if (snowParticles && sparks != null && speed > sprayMinSpeed)
            {
                // Sparks come from the BOARD/RAIL CONTACT (the line directly under the deck, _railPoint), NOT the back of
                // the deck - up off the edge and BACK ALONG THE RAIL, so they trail the contact point no matter which way
                // the deck faces (grind sideways and the sparks still peel off the rail). See docs/026.
                Vector3 along = _railFwd.sqrMagnitude > 1e-6f ? _railFwd.normalized
                              : (_vel.sqrMagnitude > 1e-4f ? _vel.normalized : _fwd);
                Vector3 dir = (Vector3.up - along).normalized;        // up and back along the rail
                if (dir.sqrMagnitude < 1e-6f) dir = Vector3.up;
                sparks.transform.position = _railPoint + Vector3.up * (railHeight * 0.5f); // the seam where the deck meets the rail
                sparks.transform.rotation = Quaternion.LookRotation(dir, Vector3.up);
                float span = Mathf.Max(0.1f, glideFullSpeed - sprayMinSpeed);
                float s01 = Mathf.Clamp01((speed - sprayMinSpeed) / span);
                _sparkAccum += 12f * s01 * dt; // ~12/s at full speed - a steady scrape of sparks off the rail seam
                int cnt = (int)_sparkAccum;
                if (cnt > 0) { _sparkAccum -= cnt; sparks.Emit(cnt); }
            }
        }
    }
}
