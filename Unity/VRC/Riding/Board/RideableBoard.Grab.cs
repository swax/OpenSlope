using UnityEngine;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    // Part of RideableBoard (partial): the board IN YOUR HAND - carry it, set it down, throw it, and the
    // over-the-shoulder summon that recalls it from anywhere on the mountain.
    //
    // TWO WAYS INTO THE HAND, one held state:
    //   GRAB  - the same BoxCollider the trigger mounts, the grip carries. VRChat routes the two actions apart on its own
    //           (trigger = Use/Interact = mount, grip = Grab = the VRC_Pickup), so one collider carries both verbs with no
    //           separate handle to aim at. VRChat drives the transform; we just stand down and measure.
    //   SUMMON- reach behind your head and grip with empty hands: your board flies to your hand from wherever it lies
    //           (BoardSummon owns the gesture; it calls BeginSummonHold here). VRChat has NO force-pickup API - a
    //           VRC_Pickup can be Drop()ed from code but never PUT into a hand - so a summoned board is held by US: we
    //           drive its transform onto the hand bone each frame until the grip is released. Same held state either way,
    //           so the release, the throw and the coast are shared.
    //   ...and a held board PASSES hand to hand: gripping with your FREE hand on the deck takes it into that hand
    //           (TryHandTransfer, routed by BoardSummon) - either hold becomes a summon hold on the new hand (no
    //           force-pickup, so a native grab can't be re-handed natively), keeping the deck's orientation. The old
    //           grip can then open without throwing it.
    //
    // DESKTOP gets ride, not grab. Desktop collapses Use and Grab onto the one left-click, so the click can only resolve
    // to a single verb - and riding is the primary one. RefreshPickupable clears `pickupable` on desktop clients, which is
    // a LOCAL component field (nothing syncs it), so each client picks its own policy: a VR player can carry the very
    // board a desktop player can only ride. The summon is VR-only for the same reason.
    //
    // The board is a KINEMATIC rigidbody, so PhysX never integrates it and can never fight the hand-integrated ride. That
    // also means VRChat can't throw it for us - a kinematic body carries no velocity - so we measure the hand's own throw
    // off the transform delta while held (HeldUpdate) and hand it to the riderless coast on release. A dropped board
    // therefore falls, slides and parks through the SAME model a jumped-off board does (CoastUpdate), not through PhysX.
    //
    // IN USE = HANDS OFF: a board in a hand sets the synced `occupied` flag, exactly as a ridden one does. That single flag
    // is what every other system already reads to keep its hands off - Interact refuses to seat a rider on it,
    // OnOwnershipRequest refuses to transfer it, and BoardManager won't dispense, replace or reclaim it. So a carried
    // board can't be yanked back to the pool mid-carry, nobody can mount the board in your hands, and a summon can't rip a
    // board out of the hands (or from under the feet) of whoever currently has it - you recall it once they let go.
    public partial class RideableBoard
    {
        [Header("Grabbing (carry the board in your hand - VR grip; the trigger still mounts it)")]
        [Tooltip("The VRC_Pickup that makes the board's box grabbable. Built + wired by RideableBoardSetup; auto-found " +
                 "on this object if empty. Null (a board built before grabbing existed) just leaves the board un-grabbable - " +
                 "re-run 'OpenSlope/Setup/Start Gate Boards' to add it.")]
        public VRC_Pickup pickup;
        [Tooltip("Master toggle for the board ever being in a hand - the grip carry AND the over-the-shoulder summon. OFF = " +
                 "the board is ride-only (the pickup is disabled and the box behaves exactly as it did before grabbing existed).")]
        public bool grabbable = true;
        [Tooltip("Scale on the THROW: the board leaves your hand at (hand velocity x this). The board is kinematic, so " +
                 "VRChat can't throw it for us - we measure your hand off the transform delta and seed the riderless coast " +
                 "with it. 1 = throw it exactly as fast as your hand moved; >1 for an arcade-y fling, 0 to set it down dead.")]
        public float throwScale = 1f;
        [Tooltip("Cap (m/s) on the measured throw, so a hard flick (or a one-frame tracking spike) can't launch the board " +
                 "across the level. ~12 is a hard human throw.")]
        public float throwMaxSpeed = 12f;

        [Header("Grab off your feet (the grip, WHILE RIDING: snatch the deck out from under you)")]
        [Tooltip("ON: the grip while riding takes the board off your feet and into your hand (BoardSummon routes it here) - " +
                 "the inverse of holding it and pulling the trigger to ride. OFF = the grip does nothing while you're riding.")]
        public bool grabWhileRiding = true;
        [Tooltip("Only allow it IN THE AIR (recommended). On the ground the grip would rip the board out from under a carve " +
                 "any time your hand strayed, and this wants to be a trick, not a hazard. OFF = you can also grab it off your " +
                 "feet while grounded, which stops you dead and leaves you standing with the deck in hand.")]
        public bool grabWhileRidingAirOnly = true;
        [Tooltip("Leaving the board IN THE AIR hands your avatar the board's velocity, so you keep flying the arc you were on " +
                 "instead of dropping out of it. This matters because a VRCStation passenger has NO velocity of their own - " +
                 "the board carries them by moving the station - so without it, stepping off mid-flight strands you as a " +
                 "stationary player and every bit of speed you'd built vanishes. Grounded dismounts are untouched (handing a " +
                 "walking avatar 30 m/s would fire them across the mountain). Applies to the grip-off-your-feet AND the Jump " +
                 "dismount, so any airborne exit keeps its trajectory.")]
        public bool carryAirDismountVelocity = true;

        [Header("Summon hold (how a board recalled over the shoulder / grabbed off your feet sits in your hand)")]
        [Tooltip("Where the board's centre sits relative to the holding hand, in HAND space (x=right, y=up, z=forward " +
                 "along the fingers). The default hangs it just below the palm so the deck reads as held at its middle. " +
                 "ORIENTATION is not authored: the hold keeps the rotation the board HAD at the grab - it translates to " +
                 "the hand and rides the wrist from there - matching the native VRC_Pickup grab (orientation = Any).")]
        public Vector3 summonHoldOffset = new Vector3(0f, -0.06f, 0.05f);
        [Tooltip("How fast (1/s) a summoned board FLIES to your hand rather than appearing in it. The board is teleported to " +
                 "your hand and then tracks it rigidly; this only eases the FIRST moment so the recall reads as a snap-to-hand " +
                 "rather than a pop. High = instant. 0 = a hard cut.")]
        public float summonEaseRate = 25f;

        private bool _held;            // the LOCAL player has this board in hand (VRC_Pickup's grab OR our summon); every transform writer stands down
        private bool _summonHeld;      // ...and it's the SUMMON hold, so WE drive the transform onto the hand (no force-pickup API exists)
        private bool _summonRightHand; // which hand summoned it
        private Quaternion _summonGripRot = Quaternion.identity; // the deck's rotation RELATIVE TO THE HAND, captured at
                                       // the grab (BeginSummonHold): the hold keeps the orientation the board had - it
                                       // translates to the hand and then rides the wrist - never snapping to a canned
                                       // carry pose. Grabbed off your feet mid-trick, the deck arrives still oriented
                                       // exactly as it flew.
        private float _summonEase;     // 0..1 ease-in of the snap-to-hand on the first frames of a summon
        private Vector3 _heldVel;      // hand velocity measured off the transform delta while held - the throw we hand to the coast on release
        private Vector3 _heldPrevPos;  // last frame's held position, for that delta
        private Vector3 _heldAngVel;   // hand ANGULAR velocity measured off the rotation delta while held (world axis * deg/s) - the tumble a throw leaves with
        private Quaternion _heldPrevRot = Quaternion.identity; // last frame's held rotation, for that delta
        private bool _thrownAir;       // the coasting board is a THROW still in FLIGHT: ballistic (no air scrub) and tumbling
                                       // until it first touches ground - then it's a standard coasting board again (slides,
                                       // parks). Only ReleaseFromHand sets it; every mount/recycle/ground-touch clears it.
        private Vector3 _throwAngVel;  // that flight's tumble (world axis * deg/s), seeded from _heldAngVel on release
        private const float THROW_MAX_SPIN = 720f; // cap (deg/s) on the seeded tumble, so a wrist flick / one bad tracking frame can't turn the board into a saw blade
        private Vector3 _exitVel;      // the board's arc, handed to the PLAYER on an airborne exit (applied a frame later)
        private bool _remountAir;      // this mount is AIRBORNE (mid-air deck catch, or a flying/falling player stepping on): keep the arc instead of the fresh-mount zero
        private Vector3 _remountVel;   // ...that arc - the player's live velocity at the moment the mount seated them

        // ---- Into the hand -------------------------------------------------------------------------------------------

        // The native grab: VRChat's VRC_Pickup has the transform from here. Everything the board was doing stands down.
        public override void OnPickup()
        {
            TakeIntoHand();
            _summonHeld = false; // VRChat drives this one, not us
        }

        // The over-the-shoulder summon (BoardSummon): the board is recalled to `rightHand` from wherever it lies. We hold
        // it ourselves - there is no VRChat API to put a pickup INTO a hand - so HeldUpdate drives the transform onto the
        // hand bone until the grip is released. Called only once we already OWN the board, so our writes are authoritative.
        public void BeginSummonHold(bool rightHand)
        {
            if (_held || _riding) return;
            TakeIntoHand();
            _summonHeld = true;
            _summonRightHand = rightHand;
            _summonEase = 0f;
            // Capture the deck's pose RELATIVE to the grabbing hand, so the hold KEEPS the orientation the board has
            // right now - the grab translates it to the hand and it follows the wrist from there (the same feel as the
            // native VRC_Pickup grab, orientation = Any). TakeIntoHand ensured _player above; identity if tracking is out.
            if (_player != null)
            {
                VRCPlayerApi.TrackingData grabHand = _player.GetTrackingData(
                    rightHand ? VRCPlayerApi.TrackingDataType.RightHand : VRCPlayerApi.TrackingDataType.LeftHand);
                _summonGripRot = Quaternion.Inverse(grabHand.rotation) * transform.rotation;
            }
            else _summonGripRot = Quaternion.identity;
            // A recall crosses the whole map. Snap the board to the hand NOW and TELL REMOTES it teleported: without the
            // teleport signal they'd read the jump as motion and SmoothDamp their copy across the level (a recall under
            // netRemoteSnap ~50 m slides rather than cuts - the board would visibly fly in from the mountainside). See
            // PublishTeleport / NetFollow's _snapPending (docs/vrchat/042).
            PoseInHand(1f);
            _heldPrevPos = transform.position;
            _heldPrevRot = transform.rotation; // re-seat the spin sample too, or the cross-map snap reads as a monster tumble
            PublishTeleport();
            // Ours now, and it stays ours after we set it down - that's what makes the next summon find THIS board.
            Claim();
            if (pickup != null) pickup.pickupable = false; // we're holding it; don't let VRChat's own grab fight us for it
        }

        // Shared entry for both paths: the board is in a hand, so every other writer - the ride, the riderless coast, the
        // park-and-sleep - has to stand down, and the board must be AWAKE. WakeUp is the load-bearing call: a board parked
        // at a gate (or abandoned on the mountain) is ASLEEP, and an asleep board runs no Update and publishes no pose
        // (docs/vrchat/042) - without it a board in your hand would move for you and stay frozen where it lay for everyone else.
        void TakeIntoHand()
        {
            if (_player == null) _player = Networking.LocalPlayer;
            _held = true; IsHeldLocally = true;
            _heldPrevPos = transform.position;
            _heldVel = Vector3.zero;
            _heldPrevRot = transform.rotation;
            _heldAngVel = Vector3.zero;
            _thrownAir = false; // a board plucked out of its flight is in a hand, not a throw

            // The synced flags below are only OURS to write if we actually own the board - so ask explicitly rather than
            // assume. A free board's owner always allows it (OnOwnershipRequest returns !occupied), and a board already in
            // use was never grabbable or summonable in the first place, so this only ever confirms.
            if (networked && _player != null && !Networking.IsOwner(gameObject)) Networking.SetOwner(_player, gameObject);

            occupied = true;  // in use: Interact, OnOwnershipRequest and the whole BoardManager pool sweep now leave it alone
            atGate = false;   // it's off its post - the gate is free to dispense another
            WakeUp();         // it must tick + publish its pose so everyone sees it move in your hand

            _coasting = false; _grinding = false;
            _vel = Vector3.zero; RiderVelocity = Vector3.zero;
            StopAllBoardSound();
            StopBoardEffects();

            // A board in your hand OWNS the trigger - it's what puts the deck back under your feet. Stand the free-standing
            // trigger-jetpack down, or that same pull fires thrust instead of (and as well as) the mount, which is a
            // spectacular thing to have happen in the middle of a jump. The ride suppresses it too; this closes the window
            // between letting go of the station and getting back on it.
            if (_flight != null) _flight.SetBoardSuppressed(true);

            if (networked) RequestSerialization(); // push `occupied` now so nobody races us for the board we're holding
        }

        // ---- Out of the hand -----------------------------------------------------------------------------------------

        // The trigger, on a board we are ALREADY HOLDING (Interact -> here): set it down under our feet and ride it. Hold
        // the board in one hand, pull the trigger on it with the other, and you're away.
        //
        // Taking it out of the hand FIRST is the entire point. The VRCStation rides the board's own transform and the board
        // is seated=false, so seating a rider while the board is still hand-driven plants that rider's avatar feet wherever
        // your hand is - your body gets dragged around in front of you while your head stays put.
        //
        // Reached BOTH from the board's Interact (VRChat's raycast, which works fine when you're standing still) and - the
        // path that actually matters - straight from BoardSummon's trigger handler, which needs no raycast at all. See
        // the note there: a board moving at ride speed outruns its own collider, so Interact alone cannot land the catch.
        public void MountFromHand()
        {
            if (!_held || _riding || station == null) return;
            if (_player == null) { _player = Networking.LocalPlayer; if (_player == null) return; }

            // Clear the held state BEFORE letting VRChat drop a grabbed board: pickup.Drop() fires OnDrop, and
            // ReleaseFromHand bails on !_held - which is what stops the drop handing the board to the riderless coast we're
            // about to ride away on.
            _held = false; IsHeldLocally = false; _summonHeld = false;
            _heldVel = Vector3.zero;
            if (pickup != null) pickup.Drop(); // no-op on a summoned board (VRChat never had it); releases a grabbed one
            _coasting = false;

            // THE MID-AIR CATCH - the trick this whole path exists for: ride, hit the jump, pull the deck off your feet,
            // put it back ON your feet, land it. You're flying the board's old arc (CarryTrajectoryOnExit handed it to you
            // on the way off), so the board must resume THAT arc as it goes back under you. OnStationEntered zeroes _vel on
            // a fresh mount - exactly right for stepping onto a parked board, and fatal here: you'd stop dead in the air and
            // drop straight down. Flag the catch and let ApplyAirRemount put the velocity back after that reset.
            CaptureMountArc();

            // Lay the deck on the ground under us, facing the way we're facing. It just jumped from your hand to your feet,
            // so TELL REMOTES it teleported - without the signal they read the jump as motion and slide their copy over.
            Vector3 fwd = _player.GetRotation() * Vector3.forward;
            fwd.y = 0f;
            fwd = fwd.sqrMagnitude > 1e-4f ? fwd.normalized : Vector3.forward;
            transform.SetPositionAndRotation(_player.GetPosition(), Quaternion.LookRotation(fwd, Vector3.up));
            if (_pivot != null) { _pivot.rotation = transform.rotation; _pivot.position = transform.position; }
            PublishTeleport();

            occupied = true;             // stays in use straight through the handover from hand to feet
            station.UseStation(_player); // OnStationEntered takes it from here (claim, wake, audio, contact seed)
        }

        // The OTHER hand gripped while this board is in a hand: take it if that hand is actually ON the deck - the
        // hand-to-hand PASS (BoardSummon routes the grip here; it owns the new hand's release afterwards). Works from
        // EITHER hold: a summon hold just re-captures onto the new hand, and a native VRC_Pickup hold is converted to a
        // summon hold on the new hand - VRChat cannot PUT a pickup into a hand, only Drop it, so the pass can't stay
        // native. BeginSummonHold re-captures the grip-relative pose, so the deck keeps its orientation and just moves
        // over. Returns true if the transfer happened.
        public bool TryHandTransfer(bool rightHand, float reach)
        {
            if (!_held || _riding) return false;
            // Already in that very hand? Then this grip means nothing here.
            if (_summonHeld) { if (_summonRightHand == rightHand) return false; }
            else if (pickup != null && pickup.currentHand ==
                     (rightHand ? VRC_Pickup.PickupHand.Right : VRC_Pickup.PickupHand.Left)) return false;
            if (_player == null) return false;
            VRCPlayerApi.TrackingData hand = _player.GetTrackingData(
                rightHand ? VRCPlayerApi.TrackingDataType.RightHand : VRCPlayerApi.TrackingDataType.LeftHand);
            if (!HandNearDeck(hand.position, reach)) return false;

            // Out of the current hold WITHOUT the throw: clear _held FIRST so pickup.Drop()'s OnDrop (ReleaseFromHand)
            // bails - the same dance MountFromHand does - then hold it ourselves on the new hand. `occupied` stays true
            // straight through, so there's no window where the board reads as free.
            _held = false; IsHeldLocally = false; _summonHeld = false;
            if (pickup != null) pickup.Drop();
            BeginSummonHold(rightHand);
            return true;
        }

        // Is a world point within `reach` of the deck's grab box? Measured to the box (its own frame + avatar-fit size),
        // not the board centre, so grabbing the nose of a long deck counts. Fallback sphere if a pre-grab board has no box.
        bool HandNearDeck(Vector3 worldPos, float reach)
        {
            if (_box == null) return (worldPos - transform.position).magnitude <= reach + 0.8f;
            Vector3 local = _box.transform.InverseTransformPoint(worldPos) - _box.center;
            Vector3 half = _box.size * 0.5f;
            Vector3 clamped = new Vector3(Mathf.Clamp(local.x, -half.x, half.x),
                                          Mathf.Clamp(local.y, -half.y, half.y),
                                          Mathf.Clamp(local.z, -half.z, half.z));
            return (local - clamped).sqrMagnitude <= reach * reach;
        }

        // The grip, while you're RIDING: take the board off your feet and into your hand - the exact inverse of MountFromHand.
        // Boost off a lip, snatch the deck out from under you mid-flight, and land back on it (trigger) or throw it away.
        //
        // AIR ONLY by default (grabWhileRidingAirOnly). On the ground the grip would rip the board out from under a carve
        // every time your hand brushed the wrong way, and it wants to be a trick, not a hazard.
        //
        // Get OFF the station FIRST, for the same reason MountFromHand gets on it LAST: the station rides the board's own
        // transform and the board is seated=false, so pulling the board up to your hand while you're still seated on it
        // plants your avatar's feet in your hand and drags your body around after it. Exit, then take.
        //
        // No riderless coast on the way out - the board isn't being dropped down the hill, it's being picked up.
        public void TakeFromFeet(bool rightHand)
        {
            if (!_riding || _held || station == null || !grabWhileRiding) return;
            if (grabWhileRidingAirOnly && _wasGrounded) return; // grounded: leave the carve alone
            if (_player == null) { _player = Networking.LocalPlayer; if (_player == null) return; }

            CarryTrajectoryOnExit(); // hand US the board's arc before TakeIntoHand zeroes it - we're mid-flight
            ScoreFlagAirExit();      // a mid-air deck grab is a trick, not the end of the run - the clock keeps going (Score.cs)
            _riding = false; IsRiding = false;
            _coasting = false;   // it's coming to your hand, not sliding away downhill
            StopAllBoardSound(); // silence NOW rather than wait on OnStationExited (VRChat doesn't always fire it)
            station.ExitStation(_player);

            // OnStationExited may land after this - its !_held guard is what stops it freeing the board we now hold.
            BeginSummonHold(rightHand); // pulls it to the hand, publishes the teleport, re-claims it, marks it in use
        }

        // Leaving the board IN THE AIR hands your avatar the board's velocity, so you keep flying the arc you were already
        // on instead of dropping out of it. Without this, stepping off mid-flight strands you: a VRCStation passenger has no
        // velocity of their own (the board carries them by moving the station), so the instant you exit you're a stationary
        // player who simply falls - all the speed you'd built vanishes. Grounded dismounts are left alone: handing a walking
        // avatar 30 m/s would fire them across the mountain.
        //
        // Applied a FRAME LATER (ApplyExitVelocity): VRChat re-establishes its own locomotion on the player as they leave a
        // station, and a SetVelocity called inside that same exit gets overwritten by it.
        void CarryTrajectoryOnExit()
        {
            if (!carryAirDismountVelocity || _wasGrounded || _player == null) return;
            _exitVel = _vel;
            SendCustomEventDelayedFrames(nameof(ApplyExitVelocity), 1);
        }

        public void ApplyExitVelocity()
        {
            if (_player == null) _player = Networking.LocalPlayer;
            if (_player == null || _riding) return; // back on the board already - leave their motion to the ride
            _player.SetVelocity(_exitVel);
        }

        // Sample the player's arc at the moment a mount is about to seat them - BEFORE UseStation, because a station
        // passenger has no velocity of their own (seating discards it), so this is the last moment it's readable. An
        // AIRBORNE mount keeps that arc: the mid-air deck catch above, AND a flying/falling player stepping onto a board
        // (the trigger-flight superman, docs/vrchat/024 - PlayerFlight drives the real player velocity, so GetVelocity
        // reads the live arc). A grounded mount stays the clean zero-velocity start (a walking player carries no speed
        // worth keeping, and a parked board must not creep). Called by EVERY path that seats a rider: Interact's direct
        // UseStation, the ownership-gated seat (OnOwnershipTransferred), and MountFromHand.
        void CaptureMountArc()
        {
            _remountAir = _player != null && !_player.IsPlayerGrounded();
            _remountVel = _remountAir ? _player.GetVelocity() : Vector3.zero;
        }

        // The other half of an AIRBORNE mount (CaptureMountArc), run from OnStationEntered AFTER its fresh-mount reset
        // (which zeroes the velocity and seeds the contact state as if you'd just stepped onto a parked board). Puts the
        // arc back and tells the ride it is AIRBORNE, so the deck orients for flight and the landing pre-align can arm -
        // i.e. so you can actually land the jump/flight you're in the middle of. No-op on a grounded mount.
        void ApplyAirRemount()
        {
            if (!_remountAir) return;
            _remountAir = false;
            _vel = _remountVel;                  // resume the arc the player is flying - don't drop out of the sky
            _wasGrounded = false;
            _wasAir = true;                       // so the LANDING tick runs its touchdown block (thud + the tilt/yaw bands)
            _forcedAir = false;                   // nothing to force: the probe reads airborne on its own, far off the ground
            _airTime = RIDE_ORIENTATION_GRACE + 0.01f;  // past the bump-skip grace, so orientation goes straight to the AIR path
            // CARRY THE WHOLE ARC - including speed the board itself can't reach. The superman trigger-flight cruises
            // far past the board's air tier (BOOST_MAX_SPEED 33.5), and OnStationEntered just reset _speedCap to
            // MAX_SPEED, so without this the FIRST tick's cap clamp instantly scrubs a fast flight-mount down to the
            // tier - mounting slams the brakes (the air drag bleed is gradual; the clamp is a cliff). Same mechanism
            // as a boost volume's push (ApplyBoostPush): raise the cap to the arriving speed and let
            // BOOST_CAP_DECAY ease it back down while drag scrubs the real excess.
            float sp = _vel.magnitude;
            if (sp > _speedCap) _speedCap = sp;
        }

        // Drop a latched mount request. The over-the-shoulder summon calls this before it takes ownership: that grab is a
        // SUMMON, not a click, and OnOwnershipTransferred must not read it as "seat this player" - which would ride you on
        // the very board it's about to put in your hand.
        public void CancelPendingMount() { _pendingMount = false; }

        // VRChat's own release of a grabbed board.
        public override void OnDrop() { ReleaseFromHand(); }

        // The summon's release: BoardSummon saw the grip come up on the hand that summoned it. (Also the recovery path
        // if the hold is interrupted - a respawn, a dismount, the board being recycled.) Idempotent.
        public void ReleaseSummonHold()
        {
            if (!_summonHeld) return;
            ReleaseFromHand();
        }

        // Shared release: hand the board to the riderless coast with the throw we measured, so it flies, falls, slides and
        // parks through the same model as a board jumped off mid-run - a set-down board settles on the snow, a thrown one
        // sails. NOT a teleport: the pose was published continuously while held, so there's no PublishTeleport here (that
        // would make remotes CUT to the release pose instead of carrying their smooth chase straight into the coast).
        void ReleaseFromHand()
        {
            if (!_held) return;
            _held = false; IsHeldLocally = false;
            _summonHeld = false;
            occupied = false; // free again: mountable, transferable, reclaimable

            Vector3 throwVel = _heldVel * throwScale;
            float sp = throwVel.magnitude;
            float cap = throwMaxSpeed > 0.01f ? throwMaxSpeed : 12f;
            if (sp > cap) throwVel *= cap / sp;

            _vel = throwVel;
            RiderVelocity = throwVel;
            _heldVel = Vector3.zero;

            // The throw's tumble: the hand's angular velocity at release, capped like the linear throw.
            _throwAngVel = _heldAngVel;
            float spinSp = _throwAngVel.magnitude;
            if (spinSp > THROW_MAX_SPIN) _throwAngVel *= THROW_MAX_SPIN / spinSp;
            _heldAngVel = Vector3.zero;

            // The flight continues from the pose in your hand: seed the coast's orientation fields off the released
            // transform. The coast renders LookRotation(_fwd, _boardUp), which otherwise still holds the last RIDE
            // pose - the deck would snap at the instant of release instead of tumbling away exactly as thrown.
            _boardUp = transform.up;
            _fwd = transform.forward;

            // The coast integrates gravity + ground-stick + friction until it settles (or coastMaxTime expires), then parks
            // and lets the board fall back asleep. coastAfterDismount off = the board freezes where you let go of it.
            // _thrownAir marks the flight as a THROW: a thrown object flies its full ballistic arc, tumbling with the
            // hand's spin, and only becomes a standard sliding/parking board when it first touches ground (CoastUpdate) -
            // without it the coast's airborne scrub bleeds the throw dry mid-arc and the board just drops.
            if (coastAfterDismount) { _coasting = true; _thrownAir = true; _coastTime = coastMaxTime; _lean = 0f; _slip = 0f; }
            else _vel = Vector3.zero;

            if (_flight != null) _flight.SetBoardSuppressed(false); // empty-handed and on foot again - the jetpack is yours

            RefreshPickupable();
            if (networked) RequestSerialization(); // publish the release (occupied cleared) without waiting on the send timer
        }

        // ---- While held ----------------------------------------------------------------------------------------------

        // In hand. For a GRABBED board the pickup is driving the transform and we only MEASURE it; for a SUMMONED board we
        // drive it onto the hand ourselves. Either way we keep the board awake, so PostLateUpdate keeps publishing the
        // carried pose to everyone else, and we track the hand's velocity for the throw on release (low-passed like the net
        // sample, so one bad tracking frame doesn't become the throw).
        void HeldUpdate()
        {
            IsRiding = false;
            _parkTimer = 0f; // a board in your hand is not parked - it must never sleep out from under the carry
            ScoreOffBoardUpdate(); // a run kept alive by the mid-air deck grab: clock ticks in hand, ends if you land on foot

            float dt = Time.deltaTime;
            if (_summonHeld)
            {
                // Ease the snap-to-hand over the first frames so the recall reads as the board flying home, not popping.
                if (summonEaseRate > 0.01f) _summonEase = Mathf.Min(1f, _summonEase + summonEaseRate * dt);
                else _summonEase = 1f;
                PoseInHand(_summonEase);
            }

            Vector3 pos = transform.position;
            if (dt > 1e-4f) _heldVel = Vector3.Lerp(_heldVel, (pos - _heldPrevPos) / dt, 0.5f);
            _heldPrevPos = pos;

            // Angular velocity off the rotation delta, same low-pass as the linear throw - the tumble a released board
            // carries into its flight. Manual angle-axis (angle = 2*acos(w), axis = xyz/sin(half)) with the short-way
            // flip; a near-identity delta (sinHalf ~ 0) reads as zero spin rather than a degenerate axis.
            Quaternion rot = transform.rotation;
            if (dt > 1e-4f)
            {
                Quaternion dq = rot * Quaternion.Inverse(_heldPrevRot);
                if (dq.w < 0f) { dq.x = -dq.x; dq.y = -dq.y; dq.z = -dq.z; dq.w = -dq.w; }
                float halfRad = Mathf.Acos(Mathf.Clamp(dq.w, -1f, 1f));
                float sinHalf = Mathf.Sin(halfRad);
                Vector3 spin = Vector3.zero;
                if (sinHalf > 1e-4f)
                    spin = new Vector3(dq.x, dq.y, dq.z) / sinHalf * (halfRad * 2f * Mathf.Rad2Deg / dt);
                _heldAngVel = Vector3.Lerp(_heldAngVel, spin, 0.5f);
            }
            _heldPrevRot = rot;

            if (_wkN > 0) WakeAgeOnly(dt); // melt any ribbon the board carried into your hands
        }

        // Put the held board on the hand. `t` is the ease weight: 1 = exactly on the hand (the steady state), <1 during
        // the first frames of the recall. The rotation is the grab-relative pose captured in BeginSummonHold - the deck
        // keeps the orientation it was grabbed with and rides the wrist, it is never re-posed into a canned carry
        // orientation. Falls back to leaving the board alone if tracking isn't available.
        void PoseInHand(float t)
        {
            if (_player == null) { _player = Networking.LocalPlayer; if (_player == null) return; }
            VRCPlayerApi.TrackingData hand = _player.GetTrackingData(
                _summonRightHand ? VRCPlayerApi.TrackingDataType.RightHand : VRCPlayerApi.TrackingDataType.LeftHand);

            Quaternion targetRot = hand.rotation * _summonGripRot;
            Vector3 targetPos = hand.position + hand.rotation * summonHoldOffset;
            if (t >= 1f) { transform.SetPositionAndRotation(targetPos, targetRot); }
            else
            {
                transform.SetPositionAndRotation(Vector3.Lerp(transform.position, targetPos, t),
                                                 Quaternion.Slerp(transform.rotation, targetRot, t));
            }
            // The visible deck rides the frame while it's in your hand (nothing is carving it).
            if (_pivot != null) { _pivot.rotation = transform.rotation; _pivot.position = transform.position; }
        }

        // ---- Claim ("this is MY board") ------------------------------------------------------------------------------

        // Stamp the board as ours. Riding it claims it (OnStationEntered) and the claim STICKS through the dismount, so the
        // board stays yours wherever it comes to rest - that's the board the over-the-shoulder summon recalls. Mounting
        // someone else's board takes the claim off them. Owner-only, like every synced write.
        void Claim()
        {
            if (_player == null) _player = Networking.LocalPlayer;
            if (_player == null) return;
            if (networked && !Networking.IsOwner(gameObject)) return;
            if (claimedBy == _player.playerId) return; // already ours - don't burn a serialization on it
            claimedBy = _player.playerId;
            if (networked) RequestSerialization();
        }

        // MASTER-SIDE (BoardManager.OnSummon): a player reached over their shoulder with no board of their own, so we
        // ready a fresh pool board FOR them. We own it (TryToSpawn handed it to us), so we scrub it exactly as a gate
        // dispense does - a reactivated pool object still carries its last life's coast velocity, wake ribbon and grind
        // state - and stamp their claim. We do NOT hand ownership over: their client is already hunting for a board claimed
        // by it and takes ownership itself, which is the same path a recall follows.
        public void PrepareSummonFor(VRCPlayerApi p)
        {
            if (p == null) return;
            // Park it at the summoner rather than at the gate, so the board exists near them for the instant before their
            // client pulls it to hand (and so a dropped summon doesn't strand a board across the map).
            PlaceAtGate(p.GetPosition() + Vector3.up, Quaternion.identity);
            atGate = false;         // it is NOT sitting available at a post - it's spoken for, and its coast must not bail
            claimedBy = p.playerId; // theirs: their BoardSummon recognises it, takes ownership, and pulls it to hand
            if (networked) RequestSerialization();
        }

        // The claimant left the instance. Drop the claim so their board isn't reserved forever against a playerId that
        // VRChat may hand to somebody else later. Owner-only (the board's own network owner publishes it); the master's
        // BoardManager sweep is the backstop for boards whose owner also left.
        public override void OnPlayerLeft(VRCPlayerApi player)
        {
            if (player == null || claimedBy < 0 || player.playerId != claimedBy) return;
            if (networked && !Networking.IsOwner(gameObject)) return;
            claimedBy = -1;
            if (networked) RequestSerialization();
        }

        // True when this board is free for `playerId` to summon: theirs, alive, and nobody's hands or feet are on it.
        // Read by BoardSummon when it looks for your board before falling back to the master pool.
        public bool IsSummonableBy(int playerId)
        {
            return grabbable && !occupied && !_riding && !_held && claimedBy == playerId;
        }

        // ---- Who may grab this board ---------------------------------------------------------------------------------

        // Decided per-client (pickupable is a local component field - nothing syncs it):
        //   - VR only. Desktop's one click is spent on riding (see the header).
        //   - Not while it's IN USE by anyone - ridden or in a hand (the synced `occupied` flag), so you can't pull a board
        //     out from under its rider or out of someone else's hands.
        //   - Not while WE are riding it, which would let a rider grab their own deck out from under themselves.
        // Never touched while WE hold it: clearing `pickupable` mid-carry makes VRChat drop the board on the spot.
        void RefreshPickupable()
        {
            if (pickup == null || _held) return;
            if (_player == null) _player = Networking.LocalPlayer;
            bool vr = _player != null && _player.IsUserInVR();
            pickup.pickupable = grabbable && vr && !occupied && !_riding;
        }
    }
}
