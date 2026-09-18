using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.Udon.Common;

namespace OpenSlope.VrcPlugin
{

    // Part of RideableBoard (partial): the multiplayer transport + ownership protocol (docs/vrchat/042) - the owner's
    // pose/velocity send, the remote dead-reckoned follow, the server clock, deserialization, ownership
    // transfer/refusal, and the synced avatar-fit deck scale. The [UdonSynced] fields stay in the core file.
    public partial class RideableBoard
    {
        // Ownership landed: either we requested it to mount (seat the rider, no takeover snap), or VRChat handed us the
        // board because its previous owner left - in which case we recover it if that owner abandoned it mid-ride.
        public override void OnOwnershipTransferred(VRCPlayerApi player)
        {
            if (player == null) return;
            if (!player.isLocal) { _gatePoseValid = false; return; } // discard our old post when handing the board away
            _haveNetSample = false; // the previous owner's sample is not our frame-to-frame motion
            WakeUp();
            // Only a FRESH mount request of our own may seat us. Ownership lands here for reasons that have nothing to do
            // with a click - the over-the-shoulder summon takes ownership to pull the board to your hand, and VRChat
            // reassigns a board whose owner left the instance - and honouring a STALE _pendingMount off one of those seats a
            // rider on a board that is in their own hand: the station rides the board's transform, so with seated=false the
            // avatar's feet get planted wherever you wave it and your body is dragged around in front of you. Consume the
            // flag either way, so it can never fire late. (Update also expires it on the timeout, even as a non-owner.)
            bool wantedMount = _pendingMount && Time.time - _pendingMountTime <= netMountTimeout;
            _pendingMount = false;
            if (wantedMount)
            {
                if (_riding || _held || occupied || station == null || _player == null) return; // raced/taken meanwhile - abort cleanly
                CaptureMountArc(); // sampled HERE, not at the click: the player kept moving while ownership was in flight (Grab.cs)
                station.UseStation(_player);
                return;
            }
            // Inherited ownership WITHOUT a mount of our own = VRChat reassigned this board to us, which happens when its
            // previous owner LEFT the instance (a forced reassignment that bypasses OnOwnershipRequest). If that owner left
            // while still mounted, the dismount that clears `occupied` never ran on any client, so the synced flag is stuck
            // true with no rider - which strands the board forever: Interact refuses it, OnOwnershipRequest refuses transfer,
            // and the BoardManager sweep treats occupied as in-use so it's never reclaimed. We're the new owner and not
            // riding it, so free it. See docs/vrchat/042.
            ClearOrphanedOccupied();
        }

        // Recover a board left stuck `occupied == true` by a rider who DISCONNECTED while mounted (no local dismount ever
        // ran to clear it). Only the current OWNER may publish the cleared flag, and a genuine local rider (_riding) is left
        // alone. Called by the inheriting owner on a handoff (above) and, as a periodic backstop, by the pool owner's
        // BoardManager sweep. Idempotent - safe to call any time. See docs/vrchat/042.
        public void ClearOrphanedOccupied()
        {
            if (!occupied || _riding || _held) return;                 // genuinely free, or we really are the rider/carrier - nothing to recover
            if (networked && !Networking.IsOwner(gameObject)) return;  // only the owner may write + broadcast the synced flag
            occupied = false;
            RefreshPickupable();                                       // free again: it may be grabbed
            if (networked) RequestSerialization();                     // tell everyone it's free so the gates/Interact/manager unblock it
        }

        // Refuse to transfer a board while it's being ridden, so a stale "free" read on another client (or the pool
        // reclaim) can't steal it out from under its rider. Free/abandoned boards (occupied == false) transfer freely so
        // the pool can recycle them. See docs/vrchat/042.
        public override bool OnOwnershipRequest(VRCPlayerApi requestingPlayer, VRCPlayerApi requestedOwner)
        {
            return !occupied;
        }

        // A remote received a packet (manual sync). Reconstruct the owner's acceleration for curve-aware extrapolation.
        // The interval is the SERVER-TIME gap between the two samples (regular + accurate, because the owner sends
        // on a fixed timer and stamps each packet), so Dv/interval is well conditioned. Still
        // guarded: skip the first packet / odd gaps (KEEP the last accel, don't flicker to zero), zero on a sharp velocity
        // reversal (carve flip / wall - no bounce), drop it when ~stopped (no parked drift), low-pass + clamp. docs/vrchat/042.
        public override void OnDeserialization()
        {
            NetReceiveCount++;
            NetLastReceiveTime = Time.time;
            float interval = (float)(_netSendTime - _prevSendTime);
            if (_netVel.sqrMagnitude < 1e-4f)
            {
                _netAccel = Vector3.zero;
            }
            else if (_netInit && interval > 0.04f && interval < 1f && netMaxAccel > 0f)
            {
                Vector3 a = (_netVel - _prevNetVel) / interval;
                if (Vector3.Dot(_netVel, _prevNetVel) < 0f) a = Vector3.zero;
                float am = a.magnitude;
                if (am > netMaxAccel) a *= netMaxAccel / am;
                _netAccel = Vector3.Lerp(_netAccel, a, 0.35f);
            }
            // Angular velocity for rotation extrapolation: the rotation change over this (server-time) interval, low-passed.
            // Mirrors the accel handling - keep last on odd intervals (no flicker); it decays to identity when not turning.
            if (_netInit && interval > 0.04f && interval < 1f && netMaxRotExtrap > 0f)
            {
                Quaternion d = _netRot * Quaternion.Inverse(_prevNetRot);
                _rotDelta = _rotValid ? Quaternion.Slerp(_rotDelta, d, 0.5f) : d;
                _rotInterval = interval;
                _rotValid = true;
            }
            _prevNetRot = _netRot;
            _prevNetVel = _netVel;
            _prevSendTime = _netSendTime;
            _netInit = true;
            // A genuine teleport (gate dispense / OOB reset / lap loop-back) bumped _netTeleport: cut to the new pose next
            // NetFollow rather than sliding. A re-dispense moves the board only a few metres - under netRemoteSnap - so the
            // distance test would otherwise SmoothDamp it from the pool's gate-centre build pose onto its post. A late joiner's
            // first packet (nonzero seq vs our 0) snaps too, which is right - land on the board's real pose, don't slide in. 042.
            if (_netTeleport != _appliedTeleport) { _appliedTeleport = _netTeleport; _snapPending = true; }
            ApplyRemoteScale(); // size the deck to the synced rider-fit (no-op when unchanged; carries late-joiner state too)
            // `occupied` rides this same packet, so this is where we LEARN that someone else took (mounted or picked up) the
            // board - and the only place we can, since a non-owner's Update returns at NetFollow. Re-decide whether we may
            // grab it, so a board in another player's hands or under their feet stops offering us its grip. See Grab.cs.
            RefreshPickupable();
        }

        // Push the avatar-fit deck size to remotes the moment it changes (owner only). Manual sync bundles every field,
        // so this one RequestSerialization carries the current pose too - fine, it's a rare event (mount / mid-ride
        // avatar resize), not a per-frame send.
        void PublishScale(float s)
        {
            _netScale = s;
            if (networked && Networking.IsOwner(gameObject)) RequestSerialization();
        }

        // Remote / late-joiner: size the visible deck + collider to the synced rider-fit scale, so the board matches the
        // rider it carries (FitToRider is owner-local; this carries its result). A _netScale <= 0 is the new-field default
        // on an un-repushed board -> treat as authored (1) so existing boards don't
        // shrink to nothing. Skipped when unchanged so we don't resize the collider on every pose packet.
        void ApplyRemoteScale()
        {
            float s = _netScale > 0.01f ? _netScale : 1f;
            if (Mathf.Abs(s - _appliedScale) < 1e-3f) return;
            _appliedScale = s;
            if (_pivot != null) _pivot.localScale = new Vector3(s, s, s);
            if (_box != null) _box.size = _baseBoxSize * s;
            _riderScale = s; // keep the deck's internal size consistent on remotes too (cheap; harmless if no FX run)
        }

        // A smooth, server-synced clock: anchored once to Networking.GetServerTimeInSeconds() and advanced by local time,
        // so every client agrees on "now" in server seconds (and it's smooth per-frame, unlike sampling the server time
        // raw). Re-anchored on a long frame. This is what lets a remote know the EXACT age of each packet (incl. ping).
        private double ServerNow()
        {
            double real = Networking.GetServerTimeInSeconds();
            if (!_clockSet) { _serverClock = real; _clockFrame = Time.frameCount; _clockSet = true; return _serverClock; }
            if (Time.frameCount != _clockFrame) // advance ONCE per frame, even if ServerNow() is called more than once
            {
                _clockFrame = Time.frameCount;
                _serverClock += (double)Time.deltaTime;            // advance smoothly by local time (no per-network-tick steps)
                double err = real - _serverClock;                  // drift: Time.time lags real time after a hitch (maximumDeltaTime cap)
                if (err > 0.5 || err < -0.5) _serverClock = real;  // far off (startup / big stall) -> snap once
                else _serverClock += err * 0.05;                   // else EASE the drift out smoothly -> no jump
            }
            return _serverClock;
        }

        // A pool activation or late join can happen while the owner is parked. Keep the pose pending until the SDK
        // confirms serialization; a fixed 1.5-second awake window is not a network-delivery guarantee.
        void OnEnable()
        {
            WakeUp();
        }

        public override void OnPlayerJoined(VRCPlayerApi player)
        {
            if (networked && Networking.IsOwner(gameObject)) QueuePoseSend();
        }

        void QueuePoseSend()
        {
            _poseRevision++;
            _poseSendPending = true;
            _nextSendTime = 0;
        }

        // RequestSerialization is queued/rate-limited by VRChat. Capture position AND timestamp when the packet is
        // actually serialized, including sends requested by Claim/PublishScale rather than the frame timer.
        public override void OnPreSerialization()
        {
            if (!networked || !Networking.IsOwner(gameObject)) return;
            RestoreGatePose();
            _netPos = transform.position;
            _netRot = transform.rotation;
            _netDeckLocal = _pivot != null ? Quaternion.Inverse(_netRot) * _pivot.rotation : Quaternion.identity;
            _netBank = _bank;
            _netSendTime = ServerNow();
            _sendingPoseRevision = _poseRevision;
        }

        public override void OnPostSerialization(SerializationResult result)
        {
            if (!networked || !Networking.IsOwner(gameObject)) return;
            if (!result.success)
            {
                NetSendFailures++;
                _poseSendPending = true;
                return; // the timer retries even if motion has already gone to sleep
            }
            NetSendCount++;
            NetLastBytes = result.byteCount;
            NetLastSendTime = Time.time;
            if (_sendingPoseRevision == _poseRevision) _poseSendPending = false;
        }

        // Owner-side send (after every Update path has moved the board, so the rail/OOB/coast early-returns are all
        // covered). We sample velocity each frame and request a send on netSendInterval. OnPreSerialization captures
        // the final pose and SERVER time together when VRChat services that request. Manual sync = timestamped
        // packets, which is what makes the dead-reckoning + acceleration smooth (docs/vrchat/042; mirrors SaccFlight's transport).
        public override void PostLateUpdate()
        {
            if (!networked || !Networking.IsOwner(gameObject)) return; // remotes follow in Update/NetFollow
            RestoreGatePose();
            float dt = Time.deltaTime;
            if (_asleep && !_poseSendPending) return; // only confirmed parked poses can leave the sync budget
            Vector3 pos = transform.position;
            if (!_haveNetSample || _asleep) _netVel = Vector3.zero;
            else if (dt > 1e-4f)
            {
                // The board's ACTUAL world velocity from the transform delta (mode-agnostic: ground, air, rail, coast,
                // unlike the _vel integrator). Lightly low-passed. A teleport is not real motion: a LARGE one (> netSnapDistance)
                // reads zero here, and every teleport path (RespawnAt / PlaceAtGate) calls PublishTeleport to seed the sample to
                // the destination + zero _netVel, so even a SHORT hop reads disp = 0 instead of a bogus disp/dt spike. docs/vrchat/042.
                Vector3 disp = pos - _lastNetSamplePos;
                if (disp.sqrMagnitude > netSnapDistance * netSnapDistance) _netVel = Vector3.zero;
                else _netVel = Vector3.Lerp(_netVel, disp / dt, 0.5f);
            }
            _lastNetSamplePos = pos;
            _haveNetSample = true;
            _netPos = pos;
            _netRot = transform.rotation;
            // Also capture the VISIBLE deck pose: the Heading pivot carries the carve facing/bank/pitch the seat/root does
            // NOT (and in VR the root is pinned level), so without this remotes see a flat board. Stored RELATIVE to the
            // root so a remote recomposes it onto its own followed root; _bank lets the ski case re-roll each ski. Sampled
            // here in PostLateUpdate - after Update/Rail wrote the visual - so it's the final, mode-agnostic pose. docs/vrchat/042.
            _netDeckLocal = _pivot != null ? Quaternion.Inverse(transform.rotation) * _pivot.rotation : Quaternion.identity;
            _netBank = _bank;
            // Serialize on the fixed interval. We do NOT gate on Networking.IsClogged: VRChat already caches a manual
            // RequestSerialization and retries it once the pipe clears, so skipping while clogged only drops the FRESHEST
            // pose and lengthens the very gap the remote has to coast over (clog is exactly when the next sample matters
            // most). Let the latest pose go out and let Udon coalesce.
            double now = ServerNow();
            if (now >= _nextSendTime)
            {
                RequestSerialization();
                // Parked retries need no ride-rate bandwidth. Once a send succeeds they stop entirely.
                float interval = _asleep ? 0.5f : (netSendInterval > 0.02f ? netSendInterval : 0.02f);
                _nextSendTime = now + interval;
            }
        }

        // Owner-side: after a TELEPORT (lap loop-back, on-track OOB reset, gate re-dispense), seed the network sample to the
        // new pose with ZERO velocity and force an immediate send. PostLateUpdate derives _netVel from the transform DELTA,
        // so a teleport shorter than netSnapDistance would otherwise serialize a huge bogus velocity (disp/dt) and remote
        // ghosts would dead-reckon a rocket off the destination; and without resetting the send timer the new pose waits up
        // to a full netSendInterval. Seeding the frame sample makes the next PostLateUpdate read disp = 0 (no spike).
        // QueuePoseSend requests the clean pose next tick and keeps it pending through sleep until serialization succeeds.
        void PublishTeleport()
        {
            if (!networked) return;
            _netPos = transform.position;
            _netRot = transform.rotation;
            _netVel = Vector3.zero;
            _lastNetSamplePos = _netPos;
            _haveNetSample = true;
            _netTeleport++;    // bump the teleport signal so remotes SNAP onto this pose even when the jump is under netRemoteSnap (a
                               // gate re-dispense moves a board only a few metres - the distance test alone would slide it). See NetFollow.
            QueuePoseSend(); // send on the next PostLateUpdate; OnPreSerialization stamps the actual packet time
        }

        // Remote copy: CHASE this board onto the owner's dead-reckoned pose (carrot/stick - it only ever chases, it never
        // teleports during a ride; only a genuine respawn cuts, see netRemoteSnap). Runs in Update (below) so VRChat seats
        // the remote rider's avatar on the fresh pose the SAME frame, keeping the board glued under them. See docs/vrchat/042.
        void NetFollow()
        {
            if (!_netInit) return; // no owner packet received yet - leave the board where it was placed
            // A genuine teleport just landed (gate dispense / OOB reset / lap loop-back): cut straight to the synced pose
            // instead of chasing it. The distance snap below only fires past netRemoteSnap (~50 m); a gate re-dispense moves
            // the board just a few metres (the pool builds every board at the gate centre, then it's posed onto a post), so
            // without this explicit signal the SmoothDamp would visibly glide it across the gate - the "new board slides in
            // from the side" bug. _netVel is zero on a teleport, so the synced pose IS the destination. See PublishTeleport.
            if (_snapPending)
            {
                _snapPending = false;
                transform.SetPositionAndRotation(_netPos, _netRot);
                _smoothVel = Vector3.zero;
                ApplyRemoteDeckPose(true);
                return;
            }
            // DEAD-RECKON the target: where the owner is NOW. age = server-now minus the packet's SAMPLE time, so it
            // includes the network latency (ping) - we extrapolate the EXACT amount the data is stale, not just the local
            // time since we received it (the ping-corrected age + the velocity coast below are what cure the lurch). docs/vrchat/042.
            float age = (float)(ServerNow() - _netSendTime);
            if (age < 0f) age = 0f;
            // Effective horizon, FLOORED against the new-field-default gotcha: a netMaxExtrap < 1.0 is either a stale 0 on an
            // already-built board (the proxy default never reaches existing instances) or a setting below VRChat's real ~1s
            // delivery interval - both wrong, both cause the freeze-then-jump - so fall back to 1.5. The floor takes
            // effect on existing boards on a plain recompile, WITHOUT re-pushing the field to every instance.
            float horizon = netMaxExtrap >= 1.0f ? netMaxExtrap : 1.5f;
            if (age > horizon) age = horizon;
            // Curve-aware dead reckoning: position + velocity*age + 0.5*accel*age^2, so a speeding-up / carving board is
            // predicted along its arc instead of a straight under-shoot (the per-packet forward lurch). The VELOCITY term
            // coasts the FULL (horizon-clamped) age, so the ghost keeps gliding through the real ~1s packet gap instead of
            // freezing partway and stalling. The ACCEL parabola is capped at 0.5s: the quadratic would otherwise blow up
            // over the long horizon (0.5*20*1.5^2 = 22m), and reconstructed accel is only trustworthy for ~one interval
            // anyway - so it nudges the carve entry (<=0.5*20*0.5^2 = 2.5m) without running away. See docs/vrchat/042.
            float accelAge = age < 0.5f ? age : 0.5f;
            Vector3 target = _netPos + _netVel * age + (0.5f * accelAge * accelAge) * _netAccel;
            Vector3 p = transform.position;
            float gap2 = (p - target).sqrMagnitude;
            // Idle (a parked/sleeping owner publishes ~zero velocity): once we're on the static target, hold the root but
            // still settle the visible deck (a near-stationary owner can still be banking) onto its synced pose.
            if (_netVel.sqrMagnitude < 1e-4f && gap2 < 1e-8f) { _smoothVel = Vector3.zero; ApplyRemoteDeckPose(false); return; }
            // CARROT/STICK 'never jump': only a GENUINE teleport (the carrot landing netRemoteSnap ~50m away = a respawn)
            // cuts straight to the pose; everything smaller is CHASED by the SmoothDamp below, so a normal per-packet
            // correction can never render as a forward jump. The >0 guard makes a not-yet-pushed board (field still 0) fall
            // back to 50 instead of snapping every frame. docs/vrchat/042.
            float remoteSnap = netRemoteSnap > 0.01f ? netRemoteSnap : 50f;
            if (gap2 > remoteSnap * remoteSnap) // genuine respawn/teleport - cut, don't slide across the world
            { transform.SetPositionAndRotation(target, _netRot); _smoothVel = Vector3.zero; ApplyRemoteDeckPose(true); return; }
            // CRITICALLY-DAMPED chase (SaccFlight-style velocity-driven smoothing, via Unity SmoothDamp): the ghost is moved
            // by a continuous internal velocity (_smoothVel) that eases onto the moving target with NO overshoot - so when a
            // packet lands BEHIND our extrapolation, the error bleeds off smoothly rather than snapping the position back.
            Vector3 np = Vector3.SmoothDamp(p, target, ref _smoothVel, netSmoothTime);
            // Rotation: extrapolate the heading/bank forward by the reconstructed angular velocity (the last rotation delta,
            // projected `age` past the packet via SlerpUnclamped), then slerp the rendered rotation onto that - same
            // dead-reckon idea as position, so a carving board's orientation is predicted instead of lagging + stepping.
            Quaternion targetRot = _netRot;
            if (_rotValid && netMaxRotExtrap > 0f && _rotInterval > 1e-3f)
            {
                float frac = age / _rotInterval;
                if (frac > netMaxRotExtrap) frac = netMaxRotExtrap;
                targetRot = Quaternion.SlerpUnclamped(_netRot, _rotDelta * _netRot, frac);
            }
            float t = 1f - Mathf.Exp(-netFollowRate * Time.deltaTime);
            transform.SetPositionAndRotation(np, Quaternion.Slerp(transform.rotation, targetRot, t));
            ApplyRemoteDeckPose(false);
        }

        // Remote: rebuild the VISIBLE deck pose on the (already-followed) root. The owner writes the carve facing/bank/
        // pitch only on the Heading pivot, which we sync RELATIVE to the root (_netDeckLocal) - recompose it here so a
        // remote viewer sees the board actually turn/bank/pitch instead of a flat plank (the VR case, where the seat is
        // pinned level). The deck-local rotation arrives at the packet rate, so we slerp it per frame (snap on a respawn
        // cut / the first sample). Position rides the root (the cm-scale edge/pitch lift isn't worth a synced field). 042.
        void ApplyRemoteDeckPose(bool snap)
        {
            if (_pivot == null) return;
            // Quaternion's struct default is (0,0,0,0) - NOT identity: an un-repushed board
            // reads a zero quat here, and root*zero is garbage. Treat any non-unit value as "no deck data yet" = identity,
            // so the deck tracks the root exactly (today's behaviour) until the owner pushes a real sample.
            Quaternion local = _netDeckLocal;
            float qm = local.x * local.x + local.y * local.y + local.z * local.z + local.w * local.w;
            if (qm < 0.5f) local = Quaternion.identity;
            if (snap || !_deckSmValid) { _deckLocalSm = local; _bankSm = _netBank; _deckSmValid = true; }
            else
            {
                float t = 1f - Mathf.Exp(-netFollowRate * Time.deltaTime);
                _deckLocalSm = Quaternion.Slerp(_deckLocalSm, local, t);
                _bankSm = Mathf.Lerp(_bankSm, _netBank, t);
            }
            _pivot.rotation = transform.rotation * _deckLocalSm; // snowboard: full deck (bank baked in); skis: heading only
            _pivot.position = transform.position;
            if (_isSkis)
            {
                Quaternion skiRoll = Quaternion.AngleAxis(-_bankSm, Vector3.forward); // re-edge each ski about its own long axis
                if (_skiBankL != null) _skiBankL.localRotation = skiRoll;
                if (_skiBankR != null) _skiBankR.localRotation = skiRoll;
            }
        }
    }
}
