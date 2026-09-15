using UnityEngine;
using Basis.Scripts.BasisSdk.Players;
using Basis.Scripts.Device_Management;

namespace OpenSlope.BasisPlugin
{

    // Fixed-tick ride integration. Response and heading follow [Trailmap: 330-carving];
    // the retained snap/sink contact and approximate banking load differ from the compliant
    // VRChat contact model. See docs/vrchat/040-carving-response.md.
    public partial class BasisBoard
    {
        private float _rideRemainder;

        void Update()
        {
            if (!_riding) { _rideRemainder = 0f; return; }
            if (_player == null) { _player = BasisLocalPlayer.Instance; if (_player == null) return; }
            bool vr = BasisDeviceManagement.IsCurrentModeVR();
            ReadInput(vr);
            if (!_riding) return;   // a jump this frame dismounted us (ReadInput -> Stand); don't integrate a stray frame

            _rideRemainder = Mathf.Min(_rideRemainder + Time.deltaTime, 6f / 60f);
            while (_rideRemainder >= 1f / 60f && _riding)
            {
                _rideRemainder -= 1f / 60f;
                RideTick(1f / 60f, vr);
            }
        }

        void RideTick(float dt, bool vr)
        {
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

                // [Trailmap: 330] Basis uses the common resistance laws. Its snap contact supplies
                // an approximate normal reaction; the full compliant contact is owned by VRC/Slopesmith.
                int row = SurfaceRow(surf);
                Vector3 fwdN = Vector3.ProjectOnPlane(_fwd, n).normalized;
                Vector3 side = Vector3.Cross(n, fwdN);
                float vF = Vector3.Dot(_vel, fwdN), vS = Vector3.Dot(_vel, side), vN = Vector3.Dot(_vel, n);
                float boost = BoostActive() ? 1f : 0f;
                float theta = _rideSurfTilt[row] * Mathf.Deg2Rad * _lean;
                float load = _rideSurfA[row] / RESPONSE_UNITS_CENTIMETRES_PER_METRE;
                Vector3 groundAccel = Vector3.ProjectOnPlane(Vector3.down * load, n)
                    + side * (load * Mathf.Max(0f, n.y) * Mathf.Tan(theta));
                float forwardAccel = RideForwardResistance(row, vF, -_sinkDepth,
                    Mathf.Max(_sinkBudget, _rideSurfBudget[row]), _charge, boost);
                float sideAccel = RideLateralResistance(row, vF, vS, _lean, boost);
                _slip = Mathf.Abs(vS);
                vF += (Vector3.Dot(groundAccel, fwdN) + forwardAccel) * dt;
                vS += (Vector3.Dot(groundAccel, side) + sideAccel) * dt;

                // Push/skate to get rolling from rest; pull back to brake.
                if (_throttle > 0f) vF += pushStrength * _throttle * Mathf.Clamp01(1f - vF / pushCapSpeed) * dt;
                else if (_throttle < 0f) vF = Mathf.MoveTowards(vF, 0f, -_throttle * brakeStrength * dt);

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

                _vel = fwdN * vF + side * vS + n * vN;
                float vmag = _vel.magnitude;
                float speedRef = resistanceMode == 2 ? RESPONSE_LEAN_SPEED_MODE2_MPS
                    : resistanceMode == 0 ? RESPONSE_LEAN_SPEED_MODE0_MPS : RESPONSE_LEAN_SPEED_DEFAULT_MPS;
                float leanTarget = Mathf.Clamp(_steer, -RESPONSE_LEAN_INPUT_LIMIT, RESPONSE_LEAN_INPUT_LIMIT)
                    * Mathf.Min(1f, vmag / speedRef);
                float leanRate = Mathf.Clamp(Mathf.Abs(leanTarget - _lean) * RESPONSE_LEAN_SLEW_GAIN,
                    RESPONSE_LEAN_SLEW_MIN_PER_SECOND, RESPONSE_LEAN_SLEW_MAX_PER_SECOND);
                if (surf == 3 || surf == 4) leanRate *= RESPONSE_LEAN_POWDER_SLEW_SCALE;
                _lean = Mathf.MoveTowards(_lean, leanTarget, leanRate * dt);
                Vector3 fallLine = n * n.y - Vector3.up;
                fallLine = fallLine.sqrMagnitude > RESPONSE_YAW_FLAT_CROSS_LENGTH_SQ ? fallLine.normalized : fwdN;
                float projection = Vector3.Dot(Vector3.Cross(_vel, fwdN), n) / Mathf.Max(vmag, RESPONSE_GUARDS_SPEED_MPS);
                float yaw = RideHeadingYaw(_lean, RideHeadingLead(_lean, _charge), projection, vmag,
                    Vector3.Dot(_vel, fwdN), Vector3.Dot(_vel, fallLine), dt);
                _fwd = (Quaternion.AngleAxis(yaw * Mathf.Rad2Deg, n) * fwdN).normalized;
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
