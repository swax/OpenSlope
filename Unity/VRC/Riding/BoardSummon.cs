using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.Udon.Common;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// Reach behind your head and squeeze the grip: your board comes to your hand from wherever it lies on the mountain.
    /// One per scene (built by StartGateSetup), purely LOCAL - it reads the local player's tracking, so it needs no
    /// synced state of its own (sync None). VR only: desktop's single click is spent on riding (see RideableBoard.Grab.cs).
    ///
    /// WHICH BOARD YOU GET. Riding a board CLAIMS it (<c>RideableBoard.claimedBy</c>) and the claim sticks after you step
    /// off, so the board stays yours wherever it comes to rest. The summon therefore has two paths that converge:
    ///   - you have a claimed board somewhere -> RECALL it, however far away it is.
    ///   - you don't -> ask the master to dispense a fresh one from the pool and stamp your claim on it.
    /// Both end in the same place: find the board claimed by me, take ownership, pull it to hand. The master never hands
    /// ownership over itself - it just spawns and claims, and our own ownership request (which a free board always allows)
    /// is what completes either path. That's why the pool case needs no extra protocol.
    ///
    /// A board someone is riding or carrying is NOT summonable (the synced `occupied` flag), so a recall can never rip a
    /// board out of another player's hands or from under their feet - you get it back once they let go.
    ///
    /// NO FORCE-PICKUP. VRChat can Drop() a VRC_Pickup from code but cannot PUT one into a hand, so a summoned board isn't
    /// a native pickup hold: the board drives its own transform onto the hand bone until the grip comes up
    /// (RideableBoard.BeginSummonHold / ReleaseSummonHold). Releasing hands it to the same throw + riderless coast a
    /// normally-carried board gets.
    ///
    /// HAND-TO-HAND PASS. Gripping with your FREE hand on a deck already held in the other takes the board into that hand
    /// (RideableBoard.TryHandTransfer): the old grip can then open without throwing it. This behaviour routes the grip
    /// there whenever a board is held, whichever way it first got into the hand.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class BoardSummon : UdonSharpBehaviour
    {
        [Tooltip("The pool dispenser, for its `boards` array - we scan it to find the board claimed by us. Wired by StartGateSetup.")]
        public BoardManager manager;
        [Tooltip("The synced mailbox that routes a pool request to the master, for when we have no board of our own to " +
                 "recall. Wired by StartGateSetup.")]
        public BoardRequest request;
        [Tooltip("Master toggle for the over-the-shoulder summon. OFF = boards are only picked up by hand / ridden off the gate.")]
        public bool summonEnabled = true;

        [Header("The gesture (reach behind your head and grip)")]
        [Tooltip("How far BEHIND the head (m) the hand must be for the grip to read as a summon, measured against the head's " +
                 "YAW-ONLY facing - so looking down at your board doesn't turn 'behind me' into 'below me'. Bigger = you must " +
                 "reach further back (fewer false fires); smaller = a lighter reach triggers it.")]
        public float reachBehind = 0.10f;
        [Tooltip("How close to the head (m) the hand must stay. This is what keeps the gesture an over-the-SHOULDER reach " +
                 "rather than 'any time your hand is behind you' - an arm hanging back at your side is far outside it.")]
        public float reachRadius = 0.55f;
        [Tooltip("Lowest the hand may be relative to the head (m, negative = below) and still count. Keeps a hand behind your " +
                 "HIPS from summoning; only a reach up toward the shoulder blades fires.")]
        public float reachMinHeight = -0.25f;
        [Tooltip("How long (s) to keep trying after the gesture before giving up - it covers the round trip to the master for " +
                 "a pool board, plus the ownership handshake on a recall. Past it the summon is abandoned so a reach can't " +
                 "leave you stuck waiting.")]
        public float summonTimeout = 3f;

        [Header("Hand-to-hand pass (grip your FREE hand on a held deck to take it into that hand)")]
        [Tooltip("How close (m) the free hand must be to the held deck's grab box for its grip to TAKE the board (the " +
                 "hand-to-hand pass; the old hand can then open without throwing it). Measured to the box, not the board " +
                 "centre, so grabbing the nose of a long deck works. 0 -> a safe 0.35 default (the new-field gotcha: an " +
                 "un-repushed scene reads 0); negative = the pass is off.")]
        public float handTransferReach = 0.35f;

        private VRCPlayerApi _player;
        private bool _vr;
        private bool _armed;          // grip went down behind the head; resolved on the NEXT Update (see TryStartSummon)
        private bool _armedRight;
        private bool _pending;        // hunting for / taking ownership of the board to pull to hand
        private bool _pendingRight;
        private float _pendingDeadline;
        private RideableBoard _heldBoard; // the board we summoned into the hand; we let go of it when the grip comes up
        private bool _heldRight;

        void Start()
        {
            _player = Networking.LocalPlayer;
            _vr = _player != null && _player.IsUserInVR();
        }

        // The grip. Desktop also raises this (left-click), which is why the VR gate is here - on desktop the click is the
        // ride, and a behind-the-head reach has no meaning without hand tracking anyway.
        public override void InputGrab(bool value, UdonInputEventArgs args)
        {
            if (!summonEnabled || !_vr || _player == null || manager == null) return;
            bool right = args.handType == HandType.RIGHT;

            if (value)
            {
                // ARM, don't act. VRChat may ALSO be resolving a real VRC_Pickup grab on this same grip press (a board
                // genuinely lying behind you), and the order of InputGrab vs OnPickup isn't guaranteed - acting here could
                // hand you a second board. Deferring the decision to the next Update lets that grab land first, and the
                // "hands already full" check below then cancels us.
                _armed = true;
                _armedRight = right;
            }
            else
            {
                if (_pending && right == _pendingRight) _pending = false;             // let go before it reached us
                if (_heldBoard != null && right == _heldRight) ReleaseHeld();         // let go of the summoned board
            }
        }

        // The TRIGGER, while a board is in your hand: put it back under your feet and ride it. This is the other half of the
        // trick - grip pulls the deck off your feet mid-jump, trigger drops it back under you so you can land.
        //
        // Deliberately NOT left to the board's own Interact. VRChat's Interact is a RAYCAST against the board's collider,
        // and the board is moved by writing its transform every frame, so PhysX's collider trails the visible board by about
        // one physics step. Standing still that lag is nothing and Interact works fine; at ride speed it's over half a metre
        // and the ray misses entirely - the board outruns its own hitbox, so the catch silently fails exactly when you need
        // it, at speed, mid-air. We already know WHICH board is in the hand, so no ray is needed: mount it directly.
        // (The board's Interact still routes to the same MountFromHand, for the standing-still case.)
        public override void InputUse(bool value, UdonInputEventArgs args)
        {
            if (!value || _heldBoard == null) return;
            _heldBoard.MountFromHand();
            _heldBoard = null;
        }

        void Update()
        {
            if (!_armed && !_pending && _heldBoard == null) return; // idle: this behaviour costs one bool check a frame

            if (_armed) { _armed = false; TryStartSummon(_armedRight); }
            if (_pending) TickPending();
            // The board left our hand by some path other than the grip coming up (a respawn, a forced dismount): let go of
            // our reference so the next summon isn't blocked by a board we no longer hold.
            if (_heldBoard != null && !_heldBoard.IsHeldLocally) _heldBoard = null;
        }

        // The gesture passed its deferral. Decide what this grip meant.
        void TryStartSummon(bool right)
        {
            // RIDING -> the grip snatches the deck out from under you and into that hand: the trick is ride, hit the jump,
            // board off the feet, board back on the feet, land it. The board self-gates (air-only by default, and it hands
            // you its arc on the way off so you keep flying), so a grounded grip mid-carve simply does nothing.
            RideableBoard ridden = FindRiddenBoard();
            if (ridden != null)
            {
                ridden.TakeFromFeet(right);
                if (ridden.IsHeldLocally) { _heldBoard = ridden; _heldRight = right; } // it took - we own the release
                return;
            }

            // A grip while a board is ALREADY in a hand: the OTHER hand gripping ON the deck takes it - the hand-to-hand
            // pass (the board checks which hand holds it + proximity, and keeps its orientation through the swap). We then
            // own the NEW hand's release, whichever way the board first got into a hand. Any other grip while holding
            // meant something else - never start a second summon.
            RideableBoard held = FindHeldBoard();
            if (held != null)
            {
                if (handTransferReach >= 0f)
                {
                    float reach = handTransferReach > 0.001f ? handTransferReach : 0.35f; // 0 = un-repushed scene -> default
                    if (held.TryHandTransfer(right, reach)) { _heldBoard = held; _heldRight = right; }
                }
                return;
            }
            if (!HandBehindHead(right)) return;   // a plain grip out in front is just a grab; leave it to VRC_Pickup

            _pending = true;
            _pendingRight = right;
            _pendingDeadline = Time.time + summonTimeout;

            // No board of our own anywhere? Ask the master to dispense one and claim it for us. We do NOT wait on a reply:
            // TickPending is already hunting for a board claimed by us, and the master's claim landing is what ends the hunt.
            if (FindMyBoard() == null && request != null) request.Summon(_player.playerId);
        }

        // Pull whichever board is ours to the hand, once it exists and once we own it. Runs every frame until it lands or
        // the deadline passes. Both summon paths - recall and fresh-from-pool - resolve right here.
        void TickPending()
        {
            if (Time.time > _pendingDeadline) { _pending = false; return; } // master never answered / ownership never landed

            RideableBoard b = FindMyBoard();
            if (b == null) return; // a pool board is still being dispensed + claimed for us; keep waiting

            // Ownership is what makes our writes to the board authoritative (it publishes its own pose). A free board's
            // owner always allows the transfer (OnOwnershipRequest returns !occupied); we just have to wait for it to land.
            if (!Networking.IsOwner(_player, b.gameObject))
            {
                // This ownership grab is a SUMMON, not a click. Clear any mount the board is still waiting to seat, or its
                // OnOwnershipTransferred reads our grab as "seat this player" and rides us on the board it's about to put in
                // our hand - a station in your hand drags your avatar around by it. See RideableBoard.CancelPendingMount.
                b.CancelPendingMount();
                Networking.SetOwner(_player, b.gameObject);
                return;
            }

            _pending = false;
            _heldBoard = b;
            _heldRight = _pendingRight;
            b.BeginSummonHold(_pendingRight); // teleports it to the hand and publishes the teleport, so remotes cut rather than slide
        }

        void ReleaseHeld()
        {
            if (_heldBoard != null) _heldBoard.ReleaseSummonHold();
            _heldBoard = null;
        }

        // The board claimed by us that nobody is riding or carrying, or null. A board someone else took is deliberately not
        // findable here - that's what stops a recall yanking it out of their hands.
        RideableBoard FindMyBoard()
        {
            if (manager == null || manager.boards == null || _player == null) return null;
            int me = _player.playerId;
            RideableBoard[] bs = manager.boards;
            for (int i = 0; i < bs.Length; i++)
            {
                RideableBoard b = bs[i];
                if (b == null || !b.gameObject.activeSelf) continue;
                if (b.IsSummonableBy(me)) return b;
            }
            return null;
        }

        // The board we're currently riding, or null.
        RideableBoard FindRiddenBoard()
        {
            if (manager == null || manager.boards == null) return null;
            RideableBoard[] bs = manager.boards;
            for (int i = 0; i < bs.Length; i++)
            {
                RideableBoard b = bs[i];
                if (b == null || !b.gameObject.activeSelf) continue;
                if (b.IsRiding) return b;
            }
            return null;
        }

        // The board currently in one of OUR hands (native grab or summon hold), or null. A grip while this is non-null
        // is never a summon - it's either the hand-to-hand pass (other hand, on the deck) or nothing.
        RideableBoard FindHeldBoard()
        {
            if (manager == null || manager.boards == null) return null;
            RideableBoard[] bs = manager.boards;
            for (int i = 0; i < bs.Length; i++)
            {
                RideableBoard b = bs[i];
                if (b == null || !b.gameObject.activeSelf) continue;
                if (b.IsHeldLocally) return b;
            }
            return null;
        }

        // Is that hand reaching behind the head - the sword-draw pose? Measured in a YAW-ONLY head frame: using the head's
        // full rotation would tip "behind me" toward "below me" the moment you looked down, so a rider glancing at their
        // feet could summon by dropping a hand. Flattening the facing keeps the gesture about where your hand is relative
        // to your SHOULDERS, which is what the player is actually doing.
        bool HandBehindHead(bool right)
        {
            VRCPlayerApi.TrackingData head = _player.GetTrackingData(VRCPlayerApi.TrackingDataType.Head);
            VRCPlayerApi.TrackingData hand = _player.GetTrackingData(
                right ? VRCPlayerApi.TrackingDataType.RightHand : VRCPlayerApi.TrackingDataType.LeftHand);

            Vector3 d = hand.position - head.position;
            Vector3 fwd = head.rotation * Vector3.forward;
            fwd.y = 0f;
            if (fwd.sqrMagnitude < 1e-4f) return false; // looking straight up/down - no usable facing this frame
            fwd = fwd.normalized;

            if (-Vector3.Dot(d, fwd) < reachBehind) return false; // not behind the head
            if (d.y < reachMinHeight) return false;               // down at the hips, not up at the shoulder blades
            return d.magnitude <= reachRadius;                    // an over-the-shoulder reach, not an arm trailing behind
        }
    }
}
