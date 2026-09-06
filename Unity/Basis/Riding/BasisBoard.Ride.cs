using UnityEngine;
using Basis.Scripts.BasisSdk.Players;
using Basis.Scripts.Device_Management;

namespace OpenSlope.BasisPlugin
{

    // Part of BasisBoard (partial): the per-frame ride integration (ground + air branches, charged ollie, speed cap,
    // integrate/collide/land/snap, orientation) and the out-of-bounds respawn. Ported faithfully from the VRChat board's
    // Update (VRC/Riding/Board/RideableBoard.cs) with the VRChat-only pieces removed: gaze/head-steer (the ground
    // branch homes onto VELOCITY only), the seat/view saga (the root is simply held level + yawed to the heading), and
    // all rail / score / race / audio / FX / networking / coast hooks. The math that makes it feel like a snowboard is
    // unchanged.
    public partial class BasisBoard
    {
        void Update()
        {
            if (!_riding) return;
            if (_player == null) { _player = BasisLocalPlayer.Instance; if (_player == null) return; }
            bool vr = BasisDeviceManagement.IsCurrentModeVR();
            ReadInput(vr);
            if (!_riding) return;   // a jump this frame dismounted us (ReadInput -> Stand); don't integrate a stray frame

            float dt = Time.deltaTime;
            if (dt <= 0f) return;
            if (dt > 0.05f) dt = 0.05f; // clamp big hitches so a stutter can't fling the board
            float launchSpd = launchLevelSpeed > 0.01f ? launchLevelSpeed : 2.0f;
            _ollieCooldown -= dt;
            if (_oobResetCooldown > 0f) _oobResetCooldown -= dt;
            if (_padBoostTimer > 0f) _padBoostTimer -= dt;   // speed-pad boost window counts down

            Vector3 cur = transform.position;
            float stick = hoverHeight + groundSnap;

            // Contact-aligned probe when grounded (wall riding); plain down-probe otherwise (spot a floor to land on).
            if (wallRide && _wasGrounded) ProbeContact(cur); else Probe(cur);
            bool onGround = _pFound && ContactGap(cur) <= stick;

            // Out of bounds: on a Reset (Surf_0) surface, ARRIVING on a MainType-13 host (its "_R" collision - the
            // obstacle sweep only ever meets one as a wall, so landing on its top face reached nothing), or fell
            // below the floor -> snap back to spawn. The host test is EDGE-triggered: one arrival is one reset, so
            // sitting on the slab cannot re-fire it every time the cooldown lapses.
            bool onResetHost = onGround && _pResetHost;
            bool enteredResetHost = onResetHost && !_wasOnResetHost;
            _wasOnResetHost = onResetHost;
            if (_oobResetCooldown <= 0f && ((onGround && _pSurf == 0) || enteredResetHost || cur.y < oobFloorY)) { RespawnToSpawn(); return; }

            // ---- Rail grinding (docs/026): a self-contained state, run BEFORE the ground/air branch so the tuned
            // integration is untouched. If we lock onto / are riding a rail, GrindUpdate owns this whole frame and returns.
            if (_grindCooldown > 0f) _grindCooldown -= dt;
            if (railGrindEnabled && railNetwork != null && _grindCooldown <= 0f)
            {
                if (_grinding) { GrindUpdate(cur, dt, vr); return; }
                if (TryEnterGrind(cur, dt)) { GrindUpdate(cur, dt, vr); return; }
            }

            // Jump coyote grace so an ollie pressed during a bump-skip still fires; beyond it, cancel any pending charge.
            if (onGround) _jumpGrace = jumpCoyoteTime;
            else if (_jumpGrace > 0f) _jumpGrace -= dt;
            bool jumpAllowed = onGround || _jumpGrace > 0f;
            if (!jumpAllowed) { _charging = false; _releaseQueued = false; _charge = 0f; }

            if (onGround)
            {
                _wasAir = false;
                _flipArmed = false;
                _airBoostActive = false; // grounded -> the boost roar's gate is onGround again
                bool realLanding = !_wasGrounded && _airTime > orientationGrace;
                _airTime = 0f;
                // Low-pass the contact normal; snap on a genuine landing, hold the takeoff normal off a cresting lip.
                Vector3 rawN = _pNormal;
                if (realLanding) _contactN = rawN;
                else if (_vel.y > launchSpd && Vector3.Angle(_contactN, rawN) > 12f && rawN.y > wallNormalMax) { /* hold */ }
                else _contactN = Vector3.Slerp(_contactN, rawN, dt / (normalSmoothing + dt)).normalized;
                Vector3 n = _contactN;
                int surf = _pSurf;

                // Grounded gravity = accel-clamp: keep only the downhill-tangential pull (penetration is the snap's job).
                Vector3 gAccel = Vector3.down * gravity;
                float gInto = Vector3.Dot(gAccel, n);
                if (gInto < 0f) gAccel -= n * gInto;
                _vel += gAccel * dt;

                // Quadratic drag only (terminal limiter). Tuck thins it.
                float tuck = _throttle > 0f ? _throttle : 0f;
                float dragMul = 1f - 0.4f * tuck;
                float sp = _vel.magnitude;
                if (sp > 1e-4f)
                {
                    float newSp = sp - speedDrag * dragMul * sp * sp * dt;
                    if (newSp < 0f) newSp = 0f;
                    _vel *= newSp / sp;
                }

                // Steering: a stick "lean" yaws the heading toward the VELOCITY (auto-center), leading it by the lean
                // angle; speed-gated up, capped at groundTurnRate, surface-independent. The self-centering slip bounds the
                // cap into a steady carve angle.
                float carveGrip = Mathf.Clamp01(CarveGripFor(surf) * gripScale);
                float vmag = _vel.magnitude;
                Vector3 fwdN = Vector3.ProjectOnPlane(_fwd, n);
                fwdN = fwdN.sqrMagnitude > 1e-6f ? fwdN.normalized : _fwd;
                Vector3 velN = Vector3.ProjectOnPlane(_vel, n);
                Vector3 velDir = velN.sqrMagnitude > 1e-4f ? velN.normalized : fwdN;

                float leanTarget = Mathf.Clamp(_steer, -1f, 1f) * 0.9051856f * Mathf.Min(1f, vmag / 11.19f);
                float leanRate = Mathf.Clamp(Mathf.Abs(leanTarget - _lean) * 7.017359f, 0.1f, 8.018349f);
                if (surf == 3 || surf == 4) leanRate *= 0.5999726f; // powder steers into the lean slower
                _lean = Mathf.MoveTowards(_lean, leanTarget, leanRate * dt);
                float turnLean = _lean * 0.5239824f * (1f + 0.2f * (1f - _lean * _lean)) * steerStrength;

                Vector3 refDir = velDir; // MVP: velocity auto-center (VR gaze-steer not ported)
                float slipRef = Mathf.Atan2(Vector3.Dot(Vector3.Cross(refDir, fwdN), n), Vector3.Dot(refDir, fwdN));
                float slipVel = Mathf.Atan2(Vector3.Dot(Vector3.Cross(velDir, fwdN), n), Vector3.Dot(velDir, fwdN));

                float speedGate = Mathf.Min(1f, vmag * vmag * 0.0033383f);
                float align = 40f * Mathf.Min(1f, vmag / 5.5556f) * (1f - Mathf.Abs(Mathf.Sin(slipVel)));
                align = Mathf.Min(1f, Mathf.Max(0f, align) + 0.01004205f);
                float postMult = Mathf.Max(Mathf.Abs(_lean), align);

                float capTick = groundTurnRate * Mathf.Deg2Rad / 60f;
                float hGain = speedGate * postMult * headingResponse * 60f * dt;
                float hClose = hGain / (1f + hGain);                 // implicit-stable closure (always < 1)
                float capFrame = capTick * 60f * dt;
                float yawDeg = Mathf.Clamp((turnLean - slipRef) * hClose, -capFrame, capFrame) * Mathf.Rad2Deg;
                _fwd = Quaternion.AngleAxis(yawDeg, n) * fwdN;
                _fwd = Vector3.ProjectOnPlane(_fwd, n);
                if (_fwd.sqrMagnitude < 1e-6f) _fwd = Vector3.ProjectOnPlane(transform.forward, n);
                _fwd = _fwd.normalized;

                // Split velocity in the contact frame; carve away only the LATERAL slip (preserve forward + normal lift).
                Vector3 side = Vector3.Cross(n, _fwd);
                float vF = Vector3.Dot(_vel, _fwd);
                float vS = Vector3.Dot(_vel, side);
                float vN = Vector3.Dot(_vel, n);
                _slip = vS < 0f ? -vS : vS;
                vS *= 1f / (1f + carveGrip * carveBite * dt); // implicit decay

                // Push/skate to get rolling from rest; pull back to brake.
                if (_throttle > 0f) vF += pushStrength * _throttle * Mathf.Clamp01(1f - vF / pushCapSpeed) * dt;
                else if (_throttle < 0f) vF += _throttle * brakeStrength * dt;

                // Surface cruise-target re-accel (the surface speed character): deficit-only, only while roughly aligned.
                float target = SpeedGainFor(surf);
                if (vF > 0.5f && vF < target)
                {
                    float speedNow = Mathf.Sqrt(vF * vF + vS * vS + vN * vN);
                    float offDeg = speedNow > 1e-4f ? Mathf.Acos(Mathf.Clamp(vF / speedNow, -1f, 1f)) * Mathf.Rad2Deg : 0f;
                    float driveAlign = Mathf.Clamp01((60f - offDeg) / 30f);
                    if (driveAlign > 0f)
                        vF += surfaceDrive * driveAlign * SpeedMultFor(surf) * Mathf.Min(target - vF, 11.1f) * dt;
                }

                // Held boost: a forward shove along the heading, ground-only and lean-gated, surface-scaled.
                if (BoostActive())
                {
                    float straight01 = Mathf.Clamp01(1f - Mathf.Abs(_lean) / Mathf.Max(0.01f, boostLeanWindow));
                    if (straight01 > 0f)
                        vF += boostAccel * (SpeedMultFor(surf) * 0.4997f) * straight01 * dt;
                }

                _vel = _fwd * vF + side * vS + n * vN;
            }
            else
            {
                // Airborne: two-stage gravity (weak rising, strong falling); preserve takeoff velocity; free-rotate steer.
                _vel += Vector3.down * ((_vel.y > 0f ? gravityRising : gravity) * dt);
                _wasAir = true;
                _airTime += dt;
                _slip = 0f;
                if (airHorizontalDrag > 0f)
                {
                    float vy = _vel.y;
                    Vector3 vH = new Vector3(_vel.x, 0f, _vel.z) * (1f / (1f + airHorizontalDrag * dt));
                    _vel = new Vector3(vH.x, vy, vH.z);
                }
                // AIR BOOST: held boost in the air thrusts toward where the boost HAND points (VR - the same left
                // hand squeezing the trigger, the flight's point-to-fly gesture) / where you LOOK (desktop, no
                // tracked hand) - full 360, so aiming up stretches the air, aiming down dives at the landing, aiming
                // sideways reaches a rail while your eyes stay on it. Far weaker than the flight; the speed cap
                // (boost tier while held) still bounds the result, and the boost roar runs while it fires
                // (UpdateBoostAudio). 0 = off.
                _airBoostActive = false;
                if (airBoostAccel > 0f && holdBoostEnabled && _boostHeld)
                {
                    Vector3 aim = BoostAimDir(vr);
                    if (aim.sqrMagnitude > 1e-6f)
                    {
                        _vel += aim.normalized * (airBoostAccel * dt);
                        _airBoostActive = true;
                    }
                }
                float spinBoostMul = (airTrickBoostSpinMul > 1f && BoostActive()) ? airTrickBoostSpinMul : 1f;
                float stickYawAir = _steer * airTurnRate * spinBoostMul * dt;
                _fwd = Quaternion.AngleAxis(stickYawAir, _boardUp) * _fwd;
                if (scoringEnabled) _scoreSpinDeg += Mathf.Abs(stickYawAir); // trick spin accrual (banked on landing)
                // Air flip (stick-Y): rigid somersault of heading + deck-up about the deck's right axis.
                if (airTrickEnabled && Mathf.Abs(_throttle) > airTrickDeadzone)
                {
                    Vector3 rightAx = Vector3.Cross(_boardUp, _fwd);
                    if (rightAx.sqrMagnitude > 1e-6f)
                    {
                        rightAx = rightAx.normalized;
                        float flipDeg = (airFlipInvert ? -_throttle : _throttle) * airFlipRate * spinBoostMul * dt;
                        Quaternion flip = Quaternion.AngleAxis(flipDeg, rightAx);
                        _fwd = flip * _fwd;
                        _boardUp = flip * _boardUp;
                        _flipArmed = true;
                        if (scoringEnabled) _scoreFlipDeg += Mathf.Abs(flipDeg); // trick flip accrual (banked on landing)
                    }
                }
                // Air orientation target: level, easing toward the predicted landing normal near touchdown.
                _airUp = Vector3.up;
                float minFall = landAnticipateMinFall > 0.01f ? landAnticipateMinFall : 2.0f;
                if (landAnticipate && _vel.y < -minFall && !_flipArmed)
                {
                    Vector3 flat = Vector3.ProjectOnPlane(_vel, Vector3.up);
                    Vector3 aheadXZ = cur + flat * landAnticipateTime;
                    float reach = Mathf.Max(rayDown, landAnticipateHeight * 3f);
                    ProbeDown(new Vector3(aheadXZ.x, cur.y + rayUp, aheadXZ.z), rayUp + reach);
                    if (_pFound)
                    {
                        float gap = cur.y - _pGroundY;
                        float t = 1f - Mathf.Clamp01(gap / Mathf.Max(0.01f, landAnticipateHeight));
                        if (t > 0f) _airUp = Vector3.Slerp(Vector3.up, _pNormal, t);
                    }
                }
            }

            // Charged ollie: build charge while jump held, launch on the queued release. Fires from ground or coyote air.
            if (_charging) _charge = Mathf.Min(1f, _charge + chargeRate * dt);
            if (_releaseQueued)
            {
                if (_ollieCooldown <= 0f) LaunchOllie();
                _releaseQueued = false;
                _charge = 0f;
            }

            // Speed cap: boost lifts it; snaps up, eases down.
            float capTarget = BoostActive() ? boostMaxSpeed : maxSpeed;
            if (capTarget >= _speedCap) _speedCap = capTarget;
            else _speedCap = Mathf.MoveTowards(_speedCap, capTarget, boostCapDecay * dt);
            float spd2 = _vel.magnitude;
            if (spd2 > _speedCap) _vel *= _speedCap / spd2;

            // Integrate, collide-and-slide off walls (not while riding a steep face), re-probe, decide stick vs fly.
            bool onWall = wallRide && onGround && _contactN.y < wallNormalMax;
            Vector3 newPos = (collideWithProps && !onWall) ? ResolveObstacles(cur, _vel * dt) : cur + _vel * dt;
            if (wallRide && onGround) ProbeContact(newPos); else Probe(newPos);
            bool movingOff = Vector3.Dot(_vel, _pNormal) > 0.25f;
            bool land = _pFound && ContactGap(newPos) <= stick && !movingOff;
            if (land)
            {
                float into2 = Vector3.Dot(_vel, _pNormal);
                if (_wasAir)
                {
                    float impact = into2 < 0f ? -into2 : 0f;
                    if (impact > landSoftImpact)
                    {
                        if (landBail && impact >= landHardImpact) { RespawnToSpawn(); return; }
                        if (impact >= landHardImpact) _scoreBadLanding = true; // slammed it (no bail) -> the trick is wiped
                        float hard = Mathf.Clamp01((impact - landSoftImpact) / Mathf.Max(0.01f, landHardImpact - landSoftImpact));
                        _vel *= 1f - landScrub * hard;
                        into2 = Vector3.Dot(_vel, _pNormal);
                    }
                    // Alignment scrub: even a soft touchdown bleeds speed if the deck meets the slope crooked.
                    float alignErr = Vector3.Angle(_boardUp, _pNormal);
                    if (alignErr >= landAlignBad) _scoreBadLanding = true;     // badly-misaligned (unfinished flip) touchdown -> wiped
                    if (alignErr > landAlignClean)
                    {
                        float miss = Mathf.Clamp01((alignErr - landAlignClean) / Mathf.Max(1f, landAlignBad - landAlignClean));
                        _vel *= 1f - landAlignScrub * miss;
                        into2 = Vector3.Dot(_vel, _pNormal);
                    }
                    if (_airTime > orientationGrace) SinkLandingPunch(impact);
                    _flipArmed = false;
                    _wasAir = false;
                }
                float wallInto = into2 < 0f ? -into2 : 0f;
                if (wallCrashSpeed > 0f && (_pSurf == 10 || _pSurf == 13 || _pSurf == 14) && wallInto > wallCrashSpeed) { RespawnToSpawn(); return; }
                if (into2 < 0f) _vel -= _pNormal * into2; // absorb the into-surface part (the centripetal "stick" on a wall)
                newPos = _pPoint + _pNormal * (hoverHeight - SinkUpdate(_pSurf, dt));
            }

            transform.position = newPos;

            // ---- Visual orientation --------------------------------------------------------------------
            bool launching = !onGround && _vel.y > launchSpd;
            bool orientGrounded = onGround || (_airTime <= orientationGrace && !launching);
            Vector3 targetUp = orientGrounded ? _contactN : (land ? _pNormal : _airUp);
            if (targetUp.sqrMagnitude < 1e-6f) targetUp = Vector3.up;
            float upRate = orientGrounded ? tiltRate : (_flipArmed ? 0f : airLevelRate);
            _boardUp = Vector3.RotateTowards(_boardUp, targetUp, upRate * Mathf.Deg2Rad * dt, 0f);
            if (_boardUp.sqrMagnitude < 1e-6f) _boardUp = Vector3.up;

            Vector3 deckUp = orientGrounded ? _contactN : _boardUp;
            if (deckUp.sqrMagnitude < 1e-6f) deckUp = _boardUp;
            Vector3 faceDir = Vector3.ProjectOnPlane(_fwd, deckUp);
            faceDir = faceDir.sqrMagnitude > 1e-6f ? faceDir.normalized : _fwd;
            Quaternion boardRot = Quaternion.LookRotation(faceDir, deckUp);

            // Carve bank (visual only): roll the deck about its forward axis by the lean; level in the air.
            float bankTarget = orientGrounded ? _lean * bankAngleMax : 0f;
            _bank = Mathf.MoveTowards(_bank, bankTarget, 360f * dt);
            Quaternion deckRot = Quaternion.AngleAxis(-_bank, faceDir) * boardRot; // -_bank: edge INTO the carve

            // SEAT (root, carries the rider): level + yawed to the heading, so a carve never rolls or pitches the rider.
            Vector3 seatFwd = Vector3.ProjectOnPlane(faceDir, Vector3.up);
            if (seatFwd.sqrMagnitude < 1e-6f) seatFwd = Vector3.ProjectOnPlane(_fwd, Vector3.up);
            if (seatFwd.sqrMagnitude < 1e-6f) seatFwd = Vector3.forward;
            transform.rotation = Quaternion.LookRotation(seatFwd.normalized, Vector3.up);

            // DECK (Heading pivot): the visible board points where we travel, banks with the slope, rolls into carves. A
            // snowboard banks as one unit (deckRot); a pair of skis edges each ski about its own centreline (boardRot = no
            // unit bank, plus a per-ski roll).
            ApplyDeckOrientation(boardRot, deckRot);

            ScoreUpdate(onGround, dt); // air<->ground trick transitions (bank on landing) + the run read fields
            UpdateBoardAudio(onGround, dt); // glide/carve loops ride speed/lean; fade out in the air
            UpdateBoostAudio(onGround, dt); // held-boost roar (ground only)
            _wasGrounded = onGround;
        }

        // Teleport the board - carrying the standing rider (BasisSeat re-fits them onto the moved transform) - back to its
        // placed spawn pose. Used by the out-of-bounds reset, the hard-landing bail, and an authored reset zone.
        void RespawnToSpawn() { RespawnAt(_spawnPos, _spawnFwd); }

        // An authored reset zone (BasisResetZone) crossed while riding: snap back to spawn. Public entry for the trigger.
        public void TriggerReset() { RespawnToSpawn(); }

        // Teleport the board (carrying the rider) to an arbitrary pose, stopped and clean - the shared reset/warp path used
        // by RespawnToSpawn (OOB / bail / reset zone) and by a teleport portal (BasisTeleport -> RespawnAt at the exit).
        // `face` is a heading (any length); it's flattened to horizontal. The rider stays aboard and rides out of it.
        public void RespawnAt(Vector3 pos, Vector3 face)
        {
            ScoreBailHook();            // a reset/warp wipes the uncommitted trick + the gem multiplier (keeps the run)
            Vector3 f = Vector3.ProjectOnPlane(face, Vector3.up);
            f = f.sqrMagnitude > 1e-4f ? f.normalized : _spawnFwd;
            Quaternion rot = Quaternion.LookRotation(f, Vector3.up);
            transform.SetPositionAndRotation(pos, rot);
            _vel = Vector3.zero;
            _boardUp = Vector3.up; _fwd = f; _contactN = Vector3.up; _wasGrounded = false; _airUp = Vector3.up;
            _steer = 0f; _lean = 0f; _bank = 0f; _throttle = 0f; _flipArmed = false;
            _charging = false; _charge = 0f; _releaseQueued = false; _ollieCooldown = 0.4f;
            _wasAir = false; _boostHeld = false; _airBoostActive = false; _speedCap = maxSpeed; _padBoostTimer = 0f;
            BoostStage = 0;             // a respawned rider has no recorded finish-tube launch stage
            _oobResetCooldown = oobResetGrace;
            ResetGrind();
            if (headingPivot != null) headingPivot.SetPositionAndRotation(pos, rot);
            if (_boardSync != null) _boardSync.OnLocalTeleport(); // remotes SNAP onto the reset pose instead of sliding across the map
        }

        // Apply the visible-deck orientation to the Heading pivot (shared by the ride loop and the grind path). A single
        // snowboard banks as ONE unit (deckRot already carries the -_bank carve roll). A pair of skis keeps the Heading at
        // facing+slope only (boardRot, no unit roll) and edges EACH ski about its OWN long axis (the SkiBank_L/R pivots'
        // local Z) by -_bank, so both stay planted and edge in parallel - the SSX ski carve (docs/018-board-visual).
        void ApplyDeckOrientation(Quaternion boardRot, Quaternion deckRot)
        {
            if (headingPivot == null) return;
            headingPivot.position = transform.position;
            if (_isSkis)
            {
                headingPivot.rotation = boardRot;   // facing + slope/pitch only, no unit bank
                Quaternion skiRoll = Quaternion.AngleAxis(-_bank, Vector3.forward); // roll about each ski's own long axis (local Z)
                if (_skiBankL != null) _skiBankL.localRotation = skiRoll;
                if (_skiBankR != null) _skiBankR.localRotation = skiRoll;
            }
            else headingPivot.rotation = deckRot;   // single plank banks as a unit
        }
    }
}
