using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.Udon.Common;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// "Trigger jetpack" flight for the FREE-STANDING local player - the common VRChat world mechanic where you
    /// jump up, hold the trigger, and get thrust in the direction your hand points, so you can fly by pointing where
    /// you want to go (docs/vrchat/024-player-flight.md). It runs ONLY while you're on foot; the moment you mount a <see cref="RideableBoard"/> the
    /// board tells us to stand down (SetBoardSuppressed), because on the board the triggers already mean ollie
    /// (right) and boost (left). One always-on instance per world, local-only (sync None), like SurfaceDetector.
    ///
    /// The model (jetpack - gravity STAYS; the trigger only ADDS thrust):
    ///   - You must be airborne to get thrust (just jumped, or off the ground). Holding the trigger while standing
    ///     does nothing - the gate is "jump up AND hold the trigger", exactly the described gesture. We treat a
    ///     fresh upward velocity (the jump) as airborne too, so takeoff engages on the very jump even before you've
    ///     cleared the ground probe.
    ///   - While flying we read the player's CURRENT velocity (which VRChat has already had gravity applied to),
    ///     add flyAccel along the hand each frame (Back_Thrust amplifies it when you point against your motion, for
    ///     snappy turnarounds), clamp to the speed caps, and write it back. We never touch gravity strength: point up and out-thrust
    ///     gravity to climb; point flat and you glide-and-arc down. Let go and you COAST - momentum carries and gravity
    ///     arcs you back down to land; to stop or turn, point back the way you came and the Back_Thrust assist scrubs
    ///     your speed. That read-add-write-on-top is what makes it a jetpack rather than free noclip flight.
    ///   - VR: thrust follows the RIGHT hand's pointing direction (the right trigger; the left trigger stays free).
    ///     Desktop has no tracked hand, so it flies along the HEAD/look direction and uses the Use action (click) as
    ///     the trigger (toggle desktopFlight off to make it VR-only).
    ///
    /// Setup: 'OpenSlope/Setup/Player Flight' drops a single OpenSlope_Map/PlayerFlight object carrying this. The
    /// board auto-finds it by that path at Start and calls SetBoardSuppressed on mount/dismount - no manual wiring.
    /// All the feel knobs are tunable below.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class PlayerFlight : UdonSharpBehaviour
    {
        [Header("Master")]
        [Tooltip("Master on/off for the whole trigger-flight mechanic. Off = the trigger does nothing while on foot.")]
        public bool enableFlight = true;
        [Tooltip("Let DESKTOP (non-VR) players fly too, along their HEAD/look direction with the Use action (click) " +
                 "as the trigger. Off = VR-only (the board's trigger handling is already platform-split this way), " +
                 "which avoids clashing with desktop click-to-interact.")]
        public bool desktopFlight = true;

        [Header("Thrust (jetpack - gravity always stays on)")]
        [Tooltip("Acceleration (m/s^2) added along your hand (VR) / look (desktop) each frame while the trigger is " +
                 "held and you're airborne. Must beat gravity to climb when pointing straight up - the world's player " +
                 "gravity is ~9.8 m/s^2. Tuned to 30 for the long-haul 'superman' dash: 30 m/s^2 ramps you to the " +
                 "300 m/s cap in ~10s, covering ~3000m in 15s. Lower = floatier/weaker jetpack.")]
        public float flyAccel = 30f;
        [Tooltip("Top HORIZONTAL flight speed (m/s) - the cap on your sideways jetpack speed while flying. Vertical is " +
                 "capped separately (maxVerticalSpeed). Doesn't affect normal falling (we only clamp while flying). " +
                 "300 = the superman top speed (1080 km/h); the 30 m/s^2 accel reaches it in ~10s.")]
        public float maxHorizontalSpeed = 300f;
        [Tooltip("Cap (m/s) on climb AND descent speed WHILE FLYING (both directions), so a hard up-thrust or a long " +
                 "fall under thrust stays controllable. Normal (non-flying) falling is untouched. Matched to the " +
                 "horizontal cap (300) so a diagonal climb isn't throttled to a different speed than a flat dash.")]
        public float maxVerticalSpeed = 300f;

        [Header("Feel (from SaccFlight)")]
        [Tooltip("Decel / turnaround assist (SaccFlight's Back_Thrust): when your velocity points AGAINST where you aim, " +
                 "thrust is amplified, so pointing back the way you came stops or reverses you snappily instead of " +
                 "mushing through your own momentum. The boost scales with how fast you're fighting your motion " +
                 "(opposing m/s x backThrust). 0 = off (plain thrust). Thrust ALONG your motion is never amplified.")]
        public float backThrust = 0.45f;
        [Tooltip("Cap on the backThrust amplification (multiplier). At 300 m/s the raw scaling would be enormous and " +
                 "snap you around in a single frame (nausea in VR); this clamps it to a strong-but-survivable max. " +
                 "8 = up to 8x thrust when fighting your own momentum. Ignored if backThrust is 0.")]
        public float maxBackThrustScale = 8f;
        [Tooltip("Soft-throttle ramp (1/s). VRChat's trigger is on/off through Udon (no analog pressure), so rather " +
                 "than slamming thrust from 0 to full we ease it in over ~1/throttleRampUp seconds while held (4 = full " +
                 "in ~0.25s) for a smoother, more controllable climb than a hard jolt. Higher = snappier / closer to " +
                 "instant-on. Spools only while airborne; forced to 0 on the ground. Letting go just coasts (no brake).")]
        public float throttleRampUp = 4f;

        [Header("Ground probe (decides 'airborne' - you must jump up to fly)")]
        [Tooltip("How far below your feet still counts as standing on the ground (m). Within this you're 'grounded' " +
                 "and the trigger gives no thrust; above it you're airborne and can fly. A fresh upward (jump) " +
                 "velocity also counts as airborne so takeoff is reliable even with a small jump.")]
        public float groundProbe = 0.2f;

        private VRCPlayerApi _player;
        private bool _suppressed;   // true while the local player is riding a board (the board owns the triggers then)
        private bool _triggerHeld;  // right trigger (VR) / Use (desktop) currently held
        private bool _flying;       // actively thrusting this frame (trigger held + airborne)
        private float _throttle;    // soft-throttle 0..1, eased toward 1 while held (VRChat triggers have no analog)

        void Start()
        {
            _player = Networking.LocalPlayer;
        }

        // The board calls this on local mount (true) / dismount (false): while riding, the right trigger is the ollie
        // and the left is boost, so flight must stand down. Clearing the held/flying state on suppress means a dismount
        // never leaves us mid-thrust.
        public void SetBoardSuppressed(bool suppressed)
        {
            _suppressed = suppressed;
            if (suppressed) { _triggerHeld = false; _flying = false; _throttle = 0f; }
        }

        // VR: only the RIGHT trigger flies you (left stays free). Desktop: the single Use action is the trigger.
        // Ignored entirely while a board owns the trigger (suppressed) or the mechanic is off.
        public override void InputUse(bool value, UdonInputEventArgs args)
        {
            if (!enableFlight || _suppressed) return;
            if (_player == null) _player = Networking.LocalPlayer;
            bool vr = _player != null && _player.IsUserInVR();
            if (vr)
            {
                if (args.handType == HandType.RIGHT) _triggerHeld = value; // right trigger = fly; left trigger free
            }
            else if (desktopFlight)
            {
                _triggerHeld = value; // desktop has one Use (click) - treat it as the trigger
            }
        }

        void Update()
        {
            if (!enableFlight) return;
            if (_player == null) { _player = Networking.LocalPlayer; if (_player == null) return; }
            if (_suppressed) { _flying = false; return; }

            float dt = Time.deltaTime;
            if (dt <= 0f) return;
            if (dt > 0.05f) dt = 0.05f; // clamp big hitches so a stutter can't fling the player

            bool vr = _player.IsUserInVR();
            if (!vr && !desktopFlight) { _flying = false; return; }

            Vector3 pos = _player.GetPosition();
            Vector3 v = _player.GetVelocity();
            // Airborne if we've left the ground OR we're rising (the jump itself), so the very jump that launches you
            // engages flight even before you've physically cleared the ground probe.
            bool grounded = Grounded(pos);
            bool airborne = v.y > 0.5f || !grounded;
            if (grounded) _throttle = 0f; // landed: throttle spooled down (we don't SetVelocity off-thrust = normal physics)
            _flying = _triggerHeld && airborne;
            // Soft throttle: VRChat's trigger is on/off (no analog via Udon), so ease 0->1 while held for a smoother,
            // more controllable climb than an instant jolt. Spools only airborne; forced to 0 on the ground above.
            if (airborne) _throttle = Mathf.MoveTowards(_throttle, _triggerHeld ? 1f : 0f, throttleRampUp * dt);

            // Not thrusting (released, grounded, or not airborne): hands off entirely - we never call SetVelocity, so
            // VRChat's own physics carry you. You COAST on your momentum and gravity arcs you down to land; to stop or
            // turn, point back the way you came and re-thrust (Back_Thrust scrubs the speed). No automatic brake.
            if (!_flying) return;

            // Thrust direction: VR follows the right hand's pointing; desktop follows the head/look direction.
            Vector3 dir;
            if (vr)
            {
                VRCPlayerApi.TrackingData hand = _player.GetTrackingData(VRCPlayerApi.TrackingDataType.RightHand);
                dir = hand.rotation * Vector3.forward;
            }
            else
            {
                VRCPlayerApi.TrackingData head = _player.GetTrackingData(VRCPlayerApi.TrackingDataType.Head);
                dir = head.rotation * Vector3.forward;
            }
            if (dir.sqrMagnitude < 1e-6f) return;
            dir = dir.normalized;

            // Decel / turnaround assist (SaccFlight's Back_Thrust): amplify thrust that OPPOSES your current motion, so
            // pointing back the way you came stops/reverses you snappily instead of mushing through your own momentum.
            // Scales with how fast you're fighting your motion, clamped so a 300 m/s reversal isn't a one-frame snap
            // (VR comfort). Thrust ALONG your motion gets 1x (opposing <= 0 -> no boost).
            float opposing = -Vector3.Dot(v, dir); // m/s of velocity pointing against the aim (>0 = fighting it)
            float thrustScale = 1f;
            if (backThrust > 0f && opposing > 0f)
                thrustScale = Mathf.Clamp(opposing * backThrust, 1f, maxBackThrustScale);

            // Soft throttle eases the magnitude in (no analog trigger); Back_Thrust sharpens reversals.
            v += dir * (flyAccel * _throttle * thrustScale * dt); // ON TOP of VRChat's gravity (already applied to v)

            // Cap horizontal so you don't outrun maxHorizontalSpeed; momentum is otherwise KEPT (ballistic) - slowing is
            // handled by Back_Thrust (point back) or just coasting, not a continuous air drag. Vertical: clamped below.
            Vector3 horiz = new Vector3(v.x, 0f, v.z);
            float hs = horiz.magnitude;
            if (hs > maxHorizontalSpeed) horiz *= maxHorizontalSpeed / hs;
            v.x = horiz.x;
            v.z = horiz.z;

            if (v.y >  maxVerticalSpeed) v.y =  maxVerticalSpeed;
            if (v.y < -maxVerticalSpeed) v.y = -maxVerticalSpeed;

            _player.SetVelocity(v);
        }

        // Standing on solid ground? Cast down from a bit above the feet; triggers ignored so the firework / crash-bag /
        // rider-probe volumes scattered through the level never read as a floor.
        bool Grounded(Vector3 pos)
        {
            RaycastHit hit;
            return Physics.Raycast(pos + Vector3.up * 0.4f, Vector3.down, out hit, 0.4f + groundProbe,
                                   ~0, QueryTriggerInteraction.Ignore);
        }
    }
}
