using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.Udon.Common;

namespace OpenSlope.VrcPlugin
{

    // Part of RideableBoard (partial): the mount / dismount lifecycle - Interact + ownership-gated seating,
    // station enter/exit ride-state init + teardown, avatar-fit on mount, the riderless coast, and the respawn/eject
    // recovery paths.
    public partial class RideableBoard
    {
        public override void Interact()
        {
            if (_player == null) _player = Networking.LocalPlayer;
            if (_riding || station == null || _player == null) return;
            // It's in OUR OWN hand: the trigger sets it down under our feet and rides it - hold the board in one hand, pull
            // the trigger on it with the other and you're away. (MountFromHand takes it out of the hand FIRST; seating a
            // rider on a still-held board is what drags your avatar around by your hand. See Grab.cs.)
            if (_held) { MountFromHand(); return; }
            if (occupied) return; // someone else is on it (synced flag) - don't grab a board out from under its rider
            // Ownership-gated mount (docs/vrchat/042): take ownership FIRST, then seat only once it lands, so we never simulate
            // the board while still a non-owner (which would fight the inbound sync = the takeover snap). In a solo
            // instance we already own everything, so this falls straight through to UseStation.
            if (networked && !Networking.IsOwner(gameObject))
            {
                _pendingMount = true; _pendingMountTime = Time.time;
                // SetOwner can dispatch OnOwnershipTransferred before returning. Arm the request first.
                Networking.SetOwner(_player, gameObject);
                return; // OnOwnershipTransferred seats us when ownership arrives (or netMountTimeout abandons it)
            }
            CaptureMountArc(); // an airborne click (flying/falling player) keeps its arc through the seat (Grab.cs)
            station.UseStation(_player);
        }

        // Wake a sleeping board: re-arm its per-frame Update + pose sync. The pool dispenser calls this when it re-poses a
        // board at a post; mounting wakes it via OnStationEntered. Safe to call any time (idempotent). See docs/vrchat/042.
        public void WakeUp()
        {
            _asleep = false;
            _parkTimer = 0f;
            QueuePoseSend(); // keep retrying this pose if the board sleeps before a successful send
        }

        // Dispenser hook (BoardManager.Dispense): re-pose a POOLED board at a gate post and SCRUB its rider/runtime
        // state. A pooled board is just deactivated + reactivated, which keeps every Udon field from its last life - a
        // leftover coast velocity, a half-melted wake ribbon, grind/carve flags - and neither WakeUp nor a transform move
        // clears any of it. So a board reclaimed mid-coast would, once re-dispensed, keep sliding off its gate on the next
        // owner tick (atGate, the CoastUpdate stop-guard, was never being set). This resets motion + visuals to a clean,
        // still, flat board, latches atGate so CoastUpdate bails, wakes it to tick + sync the fresh pose, and frees it.
        // Owner-only: the manager owns the board (TryToSpawn) before calling this. See docs/vrchat/042.
        public void PlaceAtGate(Vector3 pos, Quaternion rot)
        {
            _gatePosition = pos;
            _gateRotation = rot;
            _gatePoseValid = true;
            transform.SetPositionAndRotation(pos, rot);
            occupied = false;        // free to mount
            atGate = true;           // sitting available at its post: CoastUpdate bails, and mounting clears it to dispense the next
            _riding = false; IsRiding = false;
            // Scrub the carry + claim state a reclaimed pool object came back with (Grab.cs). A board recycled to a gate post
            // is a FRESH board for whoever takes it next, so it belongs to nobody - leaving the old claim on it would keep it
            // reserved against a summon by a player who has long since ridden away from it.
            _held = false; IsHeldLocally = false; _summonHeld = false; _heldVel = Vector3.zero;
            claimedBy = -1;
            EndRun(); _scoreAirExit = false; // a recycled board carries no live run (one kept alive by an airborne exit dies here)
            RefreshPickupable();     // fresh at its post: grabbable again (VR)
            _coasting = false;       // stop any leftover riderless coast from a previous life
            _thrownAir = false;      // and any thrown flight
            _grinding = false;       // drop any grind state
            _vel = Vector3.zero; RiderVelocity = Vector3.zero;
            _lean = 0f; _carveSlide = 0f; _slip = 0f; _bank = 0f; _steer = 0f; _throttle = 0f; _flipArmed = false;   // clean, centred deck (no carve / edge-lift)
            _charging = false; _charge = 0f; _boostHeld = false; _airBoostActive = false; _padBoostTimer = 0f;
            // Lay the visible deck flat on the placed pose, facing forward (nothing drives the pivot on a parked board).
            _boardUp = transform.up; if (_boardUp.sqrMagnitude < 1e-4f) _boardUp = Vector3.up;
            _fwd = Vector3.ProjectOnPlane(transform.forward, _boardUp);
            _fwd = _fwd.sqrMagnitude > 1e-4f ? _fwd.normalized : Vector3.forward;
            _contactN = _boardUp; _wasGrounded = false; _airTime = 0f;
            _forcedAir = false; _tickAccum = 0f; _error = 1f; // parked boards run no ticks; the next mount re-seats the contact fields
            if (_pivot != null) { _pivot.rotation = transform.rotation; _pivot.position = transform.position; }
            if (_isSkis)
            {
                if (_skiBankL != null) _skiBankL.localRotation = Quaternion.identity;
                if (_skiBankR != null) _skiBankR.localRotation = Quaternion.identity;
            }
            StopAllBoardSound();     // kill any lingering glide/carve/grind loops a recycled board carried over
            StopBoardEffects();      // and any spray/puff
            ClearWake(); _haveLastWake = false;                        // empty the wake ring so no previous-rider ribbon lingers
            _crumbFilled = 0; _crumbWrite = 0; _haveLastCrumb = false; // fresh out-of-bounds breadcrumb trail
            WakeUp();                // tick + sync the fresh pose now, then it re-sleeps after sleepDelay
            PublishTeleport();       // seed the net sample to the gate pose + zero net velocity so the re-pose can't read as a disp/dt spike
        }

        // Keep the dispenser's pose authoritative while this board is still available at its post. Native pool/pickup
        // activation can restore a stored transform after PlaceAtGate's immediate write. Reassert before sampling/sleep,
        // but never drag a mounted, carried, summoned or abandoned board back to the gate.
        void RestoreGatePose()
        {
            if (!_gatePoseValid || !atGate || occupied || _riding || _held) return;
            if ((transform.position - _gatePosition).sqrMagnitude < 1e-8f &&
                Quaternion.Angle(transform.rotation, _gateRotation) < 0.01f) return;
            transform.SetPositionAndRotation(_gatePosition, _gateRotation);
            if (_pivot != null) { _pivot.position = _gatePosition; _pivot.rotation = _gateRotation; }
            NetGateCorrections++;
            WakeUp();
            PublishTeleport();
        }

        // Position the station enter-location seat for the chase-view test. chaseCamSeat ON -> offset the SeatPoint
        // UP + BEHIND; OFF -> park it at the board origin (normal first-person). VRChat tracks the enter-location
        // continuously, so moving this child re-seats the rider without touching the board's physics origin.
        void ApplyChaseSeat()
        {
            if (_seatPoint == null) return;
            _seatPoint.localPosition = chaseCamSeat ? new Vector3(0f, chaseSeatUp, -chaseSeatBack) : Vector3.zero;
            _seatPoint.localRotation = Quaternion.identity;
        }

        public override void OnStationEntered(VRCPlayerApi player)
        {
            if (player == null || !player.isLocal) return;
            // ClientSim can report a successful station entry without dispatching this callback when the UdonBehaviour
            // began Play Mode inactive inside a VRCObjectPool. AutoTestMount uses this same entry point as a fallback;
            // ignore a later/double callback after the ride has already been initialized.
            if (_riding) { IsRiding = true; return; }
            // BACKSTOP: a board in a hand must NEVER carry a rider. The station rides the board's own transform, and the
            // board is seated=false, so a rider on a held board has their avatar's feet planted wherever the hand is - wave
            // it and your body is dragged around in front of you, detached from where you're standing. Every legitimate
            // mount clears _held first (MountFromHand), so reaching here held means something seated us that shouldn't
            // have: refuse and get straight back off rather than ride a board out of our own hand. See Grab.cs.
            if (_held) { station.ExitStation(player); return; }
            bool fromGate = atGate; // capture BEFORE we clear it: was this a fresh board sitting at its start-gate post?
            _riding = true; IsRiding = true;
            occupied = true; atGate = false; // taken: this board's gate post can now dispense another
            Claim();                          // riding a board makes it YOURS, and it stays yours after you step off - that's
                                              // the board the over-the-shoulder summon recalls (Grab.cs / BoardSummon)
            RefreshPickupable();              // riding it: nobody grabs it, us included (Grab.cs)
            WakeUp(); // mounting always wakes the board and queues occupied=true without waiting a tick
            ApplyChaseSeat();  // re-apply in case the flag/offset changed since Start (re-mount to refresh the chase seat)
            _airTime = 0f;     // fresh airborne timer (orientation grace)
            _telemetryFrame = 0; _telemetryTick = 0; _telemetryEvents = 0; _telemetryHeaderWritten = false;
            _coasting = false; // mounting cancels any riderless coast still in progress on this board
            _vel = Vector3.zero;
            // SELF-RIGHT the mount pose. A thrown board can come to rest crooked (the tumble can park before the
            // grounded settle rights it - see CoastUpdate), and the station rides this very transform, so seating a
            // rider on a sideways deck seats a SIDEWAYS VIEW - and seeds _boardUp/_fwd/_seatFwd below off the crooked
            // axes (a near-vertical nose even degenerates the seat heading). Re-seat the deck flat on the surface
            // under it, KEEPING its heading, before anything reads the pose. A legitimately parked board already lies
            // flat on its slope (up == the probed normal), so this is a no-op there. Skipped for an AIRBORNE mount
            // (the mid-air catch): MountFromHand already posed it level, and the ground far below isn't its surface.
            if (!_remountAir)
            {
                Probe(transform.position);
                Vector3 upN = _pFound && _pNormal.sqrMagnitude > 1e-6f ? _pNormal.normalized : Vector3.up;
                Vector3 headFlat = Vector3.ProjectOnPlane(transform.forward, upN);
                // Nose straight up/down (a board standing on its tail): the deck's own up axis carries the heading;
                // failing that too, face the way the mounting player faces.
                if (headFlat.sqrMagnitude < 1e-4f) headFlat = Vector3.ProjectOnPlane(transform.up, upN);
                if (headFlat.sqrMagnitude < 1e-4f) headFlat = Vector3.ProjectOnPlane(player.GetRotation() * Vector3.forward, upN);
                if (headFlat.sqrMagnitude < 1e-4f) headFlat = Vector3.forward;
                transform.rotation = Quaternion.LookRotation(headFlat.normalized, upN);
                if (_pivot != null) _pivot.rotation = transform.rotation;
            }
            // Heading from the board's current facing; up from its current up (we lean it toward the snow below).
            _boardUp = transform.up;
            if (_boardUp.sqrMagnitude < 1e-4f) _boardUp = Vector3.up;
            _fwd = Vector3.ProjectOnPlane(transform.forward, _boardUp);
            if (_fwd.sqrMagnitude < 1e-4f) _fwd = Vector3.forward;
            _fwd = _fwd.normalized;
            Vector3 sf = Vector3.ProjectOnPlane(_fwd, Vector3.up);
            _seatFwd = sf.sqrMagnitude > 1e-4f ? sf.normalized : _fwd; // upright seat faces the mount heading, then holds
            _seatUp = Vector3.up; // reset the smoothed desktop view-up
            _contactN = _boardUp; _wasGrounded = false; // first grounded frame snaps the contact normal to the snow
            // The Use/click that mounts also fires InputUse, so the _ollieCooldown grace below swallows ollies briefly so
            // you don't launch on the very click that seats you.
            _steer = 0f; _lean = 0f; _carveSlide = 0f; _bank = 0f; _throttle = 0f; _flipArmed = false; _charging = false; _charge = 0f; _releaseQueued = false; _ollieCooldown = 0.5f; _jumpGrace = 0f; _wasAir = false; _boostHeld = false; _airBoostActive = false; _padBoostTimer = 0f; _speedCap = MAX_SPEED; BoostStage = 0;
            // Seat the fixed-tick contact state for this ride: fresh accumulator, no forced air, and the slewed contact
            // fields SEATED on the surface below rather than slewed up from stale values - a zero budget fires the
            // pushout on the very first contact tick and shoves the deck straight back out. [Trailmap: 310-surface-response]
            _forcedAir = false; _tickAccum = 0f; _error = 1f;
            Probe(transform.position);
            _rideSurf = _pFound ? _pSurf : 1;
            _sinkBudget = SurfBudget(_rideSurf); _sinkBog = SurfBog(_rideSurf); _lift = 0f;
            // AIRBORNE MOUNT: everything above reset this as a FRESH mount (velocity zeroed, contact seeded on the surface
            // below) - right for stepping onto a parked board, wrong when the player ARRIVES with an arc of their own:
            // the mid-air deck catch, or a flying/falling player (trigger-flight superman) getting on. Put the arc back
            // and re-arm the air state, so the flight/trick continues. No-op on a grounded mount. See Grab.cs.
            bool airMount = _remountAir; // captured before ApplyAirRemount consumes it - the score hook's air-catch resume needs it
            ApplyAirRemount();
            FitToRider(player); // scale the visible deck + collider to this avatar's size (physics stays absolute)
            StartBoardAudio(); // spin up the glide/carve loop sources (silent until we're moving)
            StartBoardEffects(); // bring the snow spray / landing-puff systems alive (Emit-driven, silent until we ride)
            ClearWake(); // fresh ribbon on mount: empty the ring, don't stitch from a previous rider
            _haveLastWake = false;
            if (_flight != null) _flight.SetBoardSuppressed(true); // on the board the triggers are ollie/boost, not fly
            _crumbFilled = 0; _crumbWrite = 0; _haveLastCrumb = false; // fresh out-of-bounds trail for this rider
            _wedge = 0f;              // and a fresh wedge integrator: no previous rider's jam carries into this ride
            _oobResetCooldown = 0.5f; // small grace at mount before an OOB reset can fire
            RaceMountHook(fromGate); // race music up, intro bed ducks; the announcer's "GO" only on a run-starting gate mount
            ScoreMountHook(fromGate, airMount); // timed run ONLY off a fresh gate board; an airborne catch RESUMES a live run
        }

        public override void OnStationExited(VRCPlayerApi player)
        {
            if (player == null || !player.isLocal) return;
            _riding = false;
            // Taking the board off your feet INTO YOUR HAND exits the station too (TakeFromFeet), and the board is still very
            // much in use - it's in your hand. Freeing it here would let the pool reclaim it, or another player mount the
            // board you're holding. While held, Grab.cs owns `occupied`.
            if (!_held) { occupied = false; RefreshPickupable(); } // off it AND out of hand: it may be carried again
            _grinding = false; StopGrindFx(); // drop any in-progress grind so a recycled board starts clean
            // No size reset on dismount: the board KEEPS the rider's avatar-fit size while it lies around / sits at a gate
            // (it's persistent state), and the next rider re-fits it on mount. The synced _netScale already holds it.
            StopBoardAudio(); // silence a parked/recycled board
            StopBoardEffects(); // and clear any lingering spray
            // Off the station but still HOLDING the board (TakeFromFeet)? The trigger is still the board's - it's what puts
            // the deck back under your feet - so the jetpack stays suppressed. Only a real return to foot hands it back.
            if (_flight != null && !_held) _flight.SetBoardSuppressed(false); // back on foot - free-standing trigger-flight resumes
            RaceDismountHook(); // race music fades out, intro bed comes back
            ScoreDismountHook(); // end the run with no record (only the finish line records)
        }

        // Match the board's LOOK to the rider: read the avatar eye height and scale the Heading pivot (visible deck) +
        // the box collider by eyeHeight/referenceEyeHeight. The hand-integrated physics reads no transform scale
        // (absolute world metres), so feel is identical for everyone - only the deck mesh + footprint change. The
        // station transform stays unit-scale, so VRChat's player placement is unaffected. Local rider only; mid-ride
        // avatar resizes come back through OnAvatarEyeHeightChanged.
        void FitToRider(VRCPlayerApi player)
        {
            if (!fitBoardToAvatar || player == null) return;
            float eye = player.GetAvatarEyeHeightAsMeters();
            if (eye <= 0f) return; // avatar not measured yet - leave the deck at its authored size
            // No min/max clamp by design (VRChat bounds eye height); the Mathf.Max only guards a 0 referenceEyeHeight divide-by-zero.
            float s = eye / Mathf.Max(0.01f, referenceEyeHeight);
            if (_pivot != null) _pivot.localScale = new Vector3(s, s, s);
            if (_box != null) _box.size = _baseBoxSize * s;
            _riderScale = s; // so the carved wake widens with the resized deck (UpdateWakeTrail multiplies its half-width by this)
            _appliedScale = s; // keep the cache truthful so a later remote-apply (if we lose ownership) isn't wrongly skipped
            PublishScale(s); // tell remotes the new size (state, sent ON the resize - not in the continuous pose stream)
        }

        // The rider rescaled their avatar mid-ride (VRChat universal avatar scaling) - re-fit so the deck tracks them.
        public override void OnAvatarEyeHeightChanged(VRCPlayerApi player, float prevEyeHeightAsMeters)
        {
            if (_riding && player != null && player.isLocal) FitToRider(player);
        }

        // VRChat fires this on a LOCAL respawn - the menu's "Respawn" button, a fall past the respawn height, or any
        // Networking/Udon Respawn(). If we were riding, a respawn MUST get us cleanly off the board: otherwise the ride
        // loop keeps running on a board that's now elsewhere, so the glide/carve loops drone on and you stay stuck on a
        // station VRChat just teleported you out of. The normal on-track out-of-bounds path uses RespawnAt (carry, no
        // Respawn()), so this only catches EXTERNAL respawns -
        // exactly the ones we want to recover from. Eject() already clears _riding before its Respawn(), so this no-ops there.
        public override void OnPlayerRespawn(VRCPlayerApi player)
        {
            if (player == null || !player.isLocal) return;
            ForceCleanDismount();
        }

        // Hard, immediate release of the board with NO riderless coast - the recovery path for a respawn. Mirrors Eject's
        // cleanup but does NOT itself call Respawn() (the caller owns that). Idempotent: safe to call when already clean.
        void ForceCleanDismount()
        {
            // A respawn lets go of a SUMMONED board: we're the ones holding it to the hand (no VRC_Pickup involved), so
            // nothing else would ever release it and it would ride your hand through the teleport. VRChat drops a GRABBED
            // board by itself, and that OnDrop is what releases those. See Grab.cs.
            if (_summonHeld) { ReleaseSummonHold(); return; }
            if (!_riding && !_audioOn && !_grindFxOn && !_fxOn && !_coasting) return; // already released
            _riding = false; IsRiding = false;
            // A respawn while CARRYING the board must not free it: the pickup still has it, so it stays in use (VRChat drops
            // it on respawn on its own, and that OnDrop is what releases it). Only a real dismount frees the board. Grab.cs.
            if (!_held) { occupied = false; RefreshPickupable(); }
            _coasting = false; _grinding = false;
            _vel = Vector3.zero; RiderVelocity = Vector3.zero;
            StopAllBoardSound();  // glide/carve + grind scrape
            StopBoardEffects();   // snow spray / puff
            if (_flight != null) _flight.SetBoardSuppressed(false); // back on foot - free-standing trigger-flight resumes
            if (station != null && _player != null) station.ExitStation(_player); // get VRChat to actually let us off
        }

        // Rider chose to get off (Jump). The station's auto-exit is disabled, so this is the only way out.
        void Dismount()
        {
            // Stepping off IN THE AIR hands you the board's arc, so you fly on instead of dropping out of it - a station
            // passenger has no velocity of their own, so without this an airborne jump-off strands you dead in the sky.
            // Grounded dismounts are untouched. See CarryTrajectoryOnExit (Grab.cs).
            CarryTrajectoryOnExit();
            ScoreFlagAirExit(); // an airborne jump-off is a trick, not the end of the run - the clock keeps going (Score.cs)
            _riding = false;
            occupied = false; // free to be recycled
            RefreshPickupable(); // off it: it may be carried again (Grab.cs)
            StopAllBoardSound(); // silence NOW, don't wait on OnStationExited (VRChat doesn't always fire it)
            if (station != null && _player != null) station.ExitStation(_player);
            // Don't freeze mid-air: hand the board off to the riderless coast (CoastUpdate) so it keeps the speed it had,
            // falls, and slides to a stop. _vel still holds that velocity. coastAfterDismount off = it freezes in place.
            // NOT a throw (_thrownAir off): a jumped-off board scrubs its horizontal carry in the air and drops - only a
            // hand release flies the ballistic thrown arc.
            if (coastAfterDismount) { _coasting = true; _thrownAir = false; _coastTime = coastMaxTime; _lean = 0f; _slip = 0f; } // flat, centred coast wake
            else _vel = Vector3.zero;
        }

        // Riderless coast: after the rider Jumps off, the empty board keeps its velocity, falls under gravity, and slides
        // along the ground until friction parks it. Self-contained and cheap: NO steering / surface-cruise / audio /
        // spray - just gravity + ground-stick + friction, PLUS the wake (it keeps carving a trail while it slides). Runs
        // from Update's !_riding branch while _coasting is set; clears when it settles, the safety timer expires, or the
        // board is re-mounted / recycled.
        void CoastUpdate()
        {
            if (atGate || _riding) { _coasting = false; return; } // recycled to a gate or re-mounted -> stop coasting
            float dt = Time.deltaTime;
            if (dt <= 0f) return;
            if (dt > 0.05f) dt = 0.05f; // clamp hitches like the ride integrator
            _coastTime -= dt;

            // The coast keeps its own cheap snap-contact - a riderless board sliding to rest doesn't need the ridden
            // fixed-tick contact model. A fixed stick band and a near-zero seat so a dropped deck lies on the snow.
            Vector3 cur = transform.position;
            float stick = 0.25f;      // how high above the ground still counts as sliding on it
            float seatHeight = 0.02f; // where the coasting deck rests above the hit
            Probe(cur);
            bool onGround = _pFound && cur.y <= _pGroundY + stick;
            if (onGround && _thrownAir) EndThrownFlight(); // first ground touch ends a THROWN flight - standard coasting board from here

            if (onGround)
            {
                Vector3 n = _pNormal.sqrMagnitude > 1e-6f ? _pNormal.normalized : Vector3.up;
                _contactN = n; // keep the cached contact normal fresh so the coast wake lies flat on the slope
                // Gravity with the into-surface part clamped off (keep only the downhill pull): the coast's snap-seat
                // has no contact spring to balance the full pull, so a board dropped on a slope slides downhill, not
                // into the ground. (The RIDDEN model never does this - its per-surface gravity is what the contact
                // response balances; the clamp is safe only on this seated riderless path.)
                Vector3 gAccel = Vector3.down * RIDE_AIR_GRAVITY_FALLING;
                float gInto = Vector3.Dot(gAccel, n);
                if (gInto < 0f) gAccel -= n * gInto;
                _vel += gAccel * dt;
                // Riderless friction: with nobody driving the surface cruise, a linear decel (+ the quadratic drag) scrubs
                // the board to rest.
                float sp = _vel.magnitude;
                if (sp > 1e-4f)
                {
                    float newSp = sp - (coastFriction + speedDrag * sp * sp) * dt;
                    if (newSp < 0f) newSp = 0f;
                    _vel *= newSp / sp;
                }
                _boardUp = Vector3.RotateTowards(_boardUp, n, RIDE_GROUND_ORIENT_RATE_CAP * Mathf.Deg2Rad * dt, 0f);
            }
            else
            {
                _vel += Vector3.down * ((_vel.y > 0f ? RIDE_AIR_GRAVITY_RISING : RIDE_AIR_GRAVITY_FALLING) * dt); // fall (two-stage like the ride)
                if (_thrownAir)
                {
                    // A THROW in flight is a thrown object: it keeps its full ballistic arc (no air scrub) and tumbles
                    // with the spin the hand gave it, until the first ground touch above hands it back to the standard
                    // coast (slide, park). The jump-off dismount coast below is untouched - only a hand release throws.
                    float spinSp = _throwAngVel.magnitude;
                    if (spinSp > 1f)
                    {
                        Quaternion spin = Quaternion.AngleAxis(spinSp * dt, _throwAngVel / spinSp);
                        _boardUp = spin * _boardUp;
                        _fwd = spin * _fwd;
                    }
                }
                else
                {
                    // Bleed the HORIZONTAL carry in the air too (the same coastFriction scrub) so a board jumped off at speed
                    // doesn't sail away on a long arc - it loses its throw and drops. Vertical (gravity) is untouched.
                    Vector3 vH = new Vector3(_vel.x, 0f, _vel.z);
                    float hsp = vH.magnitude;
                    if (hsp > 1e-4f)
                    {
                        float newH = hsp - coastFriction * dt;
                        if (newH < 0f) newH = 0f;
                        float k = newH / hsp;
                        _vel = new Vector3(vH.x * k, _vel.y, vH.z * k);
                    }
                    _boardUp = Vector3.RotateTowards(_boardUp, Vector3.up, RIDE_GROUND_ORIENT_RATE_CAP * Mathf.Deg2Rad * dt, 0f); // level in air
                }
            }

            // Move, then stick to the ground. NOTE: no obstacle collide-and-slide here (unlike the ridden path) - on the
            // first coast frame the just-dismounted player avatar stands right where the board is, so a capsule sweep
            // would cast into the player's own collider (a VRChat-internal one whose component lookup NREs in Udon). A
            // riderless board sliding to a halt doesn't need to collide off props, so we integrate it straight.
            Vector3 newPos = cur + _vel * dt;
            Probe(newPos);
            bool movingOff = Vector3.Dot(_vel, _pNormal) > 0.25f;
            bool land = _pFound && newPos.y <= _pGroundY + stick && !movingOff;
            if (land)
            {
                newPos.y = _pGroundY + seatHeight;
                float into = Vector3.Dot(_vel, _pNormal);
                if (into < 0f) _vel -= _pNormal * into; // absorb the into-surface part on contact
                if (_thrownAir) EndThrownFlight(); // touchdown: a thrown board is a standard coasting board from here
            }
            transform.position = newPos;

            // Lay the visible deck flat on the slope (or level in the air), facing its travel - no carve bank.
            if (_boardUp.sqrMagnitude < 1e-6f) _boardUp = Vector3.up;
            Vector3 faceDir = Vector3.ProjectOnPlane(_fwd, _boardUp);
            faceDir = faceDir.sqrMagnitude > 1e-6f ? faceDir.normalized : Vector3.forward;
            Quaternion rot = Quaternion.LookRotation(faceDir, _boardUp);
            // No carve bank on a riderless coast: drop the deck back onto the centreline (clear any edge-lift left over
            // from the ride) so a dropped board lies flat on the snow.
            if (_pivot != null) { _pivot.rotation = rot; _pivot.position = transform.position; } else transform.rotation = rot;

            RiderVelocity = _vel; // keep the exposed velocity honest while it slides

            // Keep laying the wake while the riderless board slides on snow. Centred + no carve (we zeroed _lean/_slip on
            // dismount); UpdateWakeTrail self-gates to snow + trailMinSpeed and stops emitting as the coast drops below it,
            // so the ribbon then melts on its own. (Spray + audio stay OFF - a dropped board doesn't make ride noise.)
            _slip = 0f;
            if (LocalFxOn()) UpdateWakeTrail(dt); else if (_wkN > 0) WakeAgeOnly(dt); // "My board FX" off: fade, don't lay

            // Settle. Park once it's resting slow on the ground. The safety timer must NEVER freeze it in mid-air (it
            // would hang there on nothing): if time's up while still airborne, drop the horizontal carry so gravity
            // drops it straight down and a later frame parks it. A hard backstop 2 s past expiry stops a
            // board that flew clean off the world.
            if (land && _vel.magnitude < coastStopSpeed)
            {
                _vel = Vector3.zero;
                RiderVelocity = Vector3.zero;
                _coasting = false;
                ParkRaiseToSurface();
            }
            else if (_coastTime <= 0f)
            {
                if (land || _coastTime <= -2f) { _vel = Vector3.zero; RiderVelocity = Vector3.zero; _coasting = false; ParkRaiseToSurface(); }
                else { _vel = new Vector3(0f, _vel.y, 0f); RiderVelocity = _vel; } // airborne: kill horizontal, let it fall
            }

            // The board PARKED while a run was still riding out an off-board trick (an airborne jump-off whose catch
            // never came): the run is over. A remount mid-coast resumes instead - see ScoreMountHook.
            if (!_coasting && _runActive) EndRun();
        }

        // Touchdown of a THROWN board (Grab.cs): the tumbling flight is over - from here it's a standard coasting
        // board that slides and settles flat (the grounded RotateTowards in CoastUpdate). If the tumble arrived
        // TOPSHEET-DOWN, mirror the up through the deck so that settle rolls it the short way back onto its base
        // instead of grinding a half-turn through the snow - a thrown board LANDS UP. (The full flatten happens the
        // instant it parks - ParkRaiseToSurface - so even a throw that stops dead on touchdown never rests crooked.)
        void EndThrownFlight()
        {
            _thrownAir = false;
            Vector3 n = _pFound && _pNormal.sqrMagnitude > 1e-6f ? _pNormal.normalized : Vector3.up;
            if (Vector3.Dot(_boardUp, n) < 0f) _boardUp = -_boardUp;
        }

        // The instant the coast PARKS, lift the deck up onto the VISIBLE surface so an abandoned board can be found.
        // The coast seats on the PROBED contact - the exact analytic patch surface when the level has one - and in a
        // CONCAVE dip (a powder bowl is exactly that) the true curve lies BELOW the faceted render mesh, so a board
        // parked there sits under the drawn snow. The ride masks that (the rider feels the true dips like the bumps);
        // a parked board just disappears. Re-cast against the actual COLLIDERS (the faceted mesh the player sees) and
        // seat on the LOWEST up-facing terrain hit at-or-above the deck: in a dip that's the visible facet overhead
        // (the board pops up out of the snow); on flat ground it's the surface it already rests on (a no-op); a bridge
        // or overhang above never wins because the lowest qualifying hit does. RAISE-ONLY - a convex perch (analytic
        // crest above the facet chords) is left alone rather than sunk into the smooth visible surface. One cast, once,
        // at park; no per-frame cost.
        void ParkRaiseToSurface()
        {
            // LAY IT FLAT first: a thrown/tumbled board can park the very frame it touches down (a soft landing passes
            // the stop-speed gate immediately), before the grounded settle has righted it - leaving it wedged on its
            // side or nose, and the next mount would inherit that crooked pose. Snap the resting pose flat on the
            // probed surface, keeping the heading (CoastUpdate's last Probe was at this resting position; a board that
            // flew off the world and never found ground falls back to world up).
            Vector3 restN = _pFound && _pNormal.sqrMagnitude > 1e-6f ? _pNormal.normalized : Vector3.up;
            _boardUp = restN;
            _contactN = restN;
            Vector3 restFwd = Vector3.ProjectOnPlane(_fwd, restN);
            if (restFwd.sqrMagnitude < 1e-6f) restFwd = Vector3.ProjectOnPlane(Vector3.forward, restN);
            if (restFwd.sqrMagnitude < 1e-6f) restFwd = Vector3.ProjectOnPlane(Vector3.right, restN);
            _fwd = restFwd.normalized;
            Quaternion restRot = Quaternion.LookRotation(_fwd, restN);
            transform.rotation = restRot;
            if (_pivot != null) _pivot.rotation = restRot;

            Vector3 pos = transform.position;
            int nHits = Physics.RaycastNonAlloc(pos + Vector3.up * 2.5f, Vector3.down, _hitBuf, 3f);
            bool haveTerrain = _colliders != null && _colliders.Length > 0;
            bool found = false; float bestY = 0f;
            for (int i = 0; i < nHits; i++)
            {
                Collider c = _hitBuf[i].collider;
                if (c == _ownCollider) continue;
                int ci = IndexOf(c);
                int ty = ci >= 0 ? _types[ci] : -1;
                if (haveTerrain && ty == -1 && !IsRideableProp(c)) continue; // same ground filter as the ride probe
                if (_hitBuf[i].normal.y <= 0f) continue;                     // floors only
                float y = _hitBuf[i].point.y;
                if (y < pos.y - 0.35f) continue;                             // a lower terrace, not the surface at the deck
                if (!found || y < bestY) { found = true; bestY = y; }
            }
            float restY = bestY + 0.05f; // proud of the facet so the topsheet shows on the snow
            if (!found || restY <= pos.y) return; // already at/above the visible surface
            pos.y = restY;
            transform.position = pos;
            if (_pivot != null) _pivot.position = pos; // the visible deck parks here too (no further coast frames re-pose it)
        }

        // Shared dismount + plain Respawn exit. Used by the hard-landing bail AND as the out-of-bounds last resort (when
        // there's no course path or trail to reset onto, or as the anti-trap escape). The normal out-of-bounds path is
        // the on-track ResetToTrack in RideableBoard.OutOfBounds.cs (carry, no dismount).
        void Eject()
        {
            _riding = false;
            occupied = false; // free to be recycled
            RefreshPickupable(); // off it: it may be carried again (Grab.cs)
            ScoreBailHook(); // lose the uncommitted trick + multiplier (the run total survives; dismount ends the run)
            _coasting = false; // out of bounds: stop dead, don't slide (the player is respawning)
            StopAllBoardSound(); // silence NOW, don't wait on OnStationExited (VRChat doesn't always fire it)
            if (station != null && _player != null) station.ExitStation(_player);
            if (_player != null) _player.Respawn();
        }

        // Kill every looping/scrape sound the ride spins up - the glide/carve snow loops AND the rail grind scrape - in
        // one call. Used by the explicit dismount paths so the sound cuts the instant you get off, rather than depending
        // on OnStationExited (which VRChat doesn't guarantee). Idempotent (the Stop* clear their own flags).
        void StopAllBoardSound()
        {
            StopBoardAudio();
            StopGrindFx();
        }
    }
}
