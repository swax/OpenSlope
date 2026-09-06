using UnityEngine;
using Basis.Scripts.BasisSdk.Players;
using Basis.Scripts.BasisCharacterController;

namespace OpenSlope.BasisPlugin
{
    using Basis.Scripts.Drivers;                       // BasisLocalBoneDriver (head/hand world pose)
    using Basis.Scripts.Device_Management;             // BasisDeviceManagement
    using Basis.Scripts.Device_Management.Devices;     // BasisInput
    using Basis.Scripts.Device_Management.Devices.Desktop; // BasisLocalInputActions (desktop trigger)
    using Basis.Scripts.TransformBinders.BoneControl;  // BasisBoneTrackedRole

    /// <summary>
    /// "Trigger jetpack" flight for the FREE-STANDING local player - the Basis port of the VRChat <c>PlayerFlight</c>
    /// (docs/vrchat/024-player-flight): jump up, hold the trigger, and get thrust in the direction your hand (VR) / view
    /// (desktop) points, so you fly by pointing where you want to go. It runs ONLY on foot; mounting a
    /// <see cref="BasisBoard"/> tells it to stand down (SetBoardSuppressed), because on the board the inputs already
    /// mean ollie / boost. One always-on singleton per world (BasisPlayerFlight.Instance), local-only.
    ///
    /// The jetpack model - gravity STAYS, the trigger only ADDS thrust, momentum is kept (ballistic coast):
    ///   - You must be airborne (or freshly jumped, i.e. rising) with the trigger held to engage. Basis has no
    ///     read/write player-velocity API - the sanctioned way to drive the walking player is a movement MODE - so
    ///     engaging installs our own <see cref="JetpackMode"/> onto the local character driver
    ///     (<c>LocalCharacterDriver.CurrentMode</c>), seeded from the CharacterController's current velocity so takeoff
    ///     is continuous. While the mode owns motion it integrates its OWN velocity: gravity every frame, thrust along
    ///     the aim while the trigger is held (SaccFlight-style Back_Thrust amplifies thrust that opposes your motion for
    ///     snappy turnarounds; a soft throttle eases the on/off trigger in), clamped to the speed caps, then
    ///     <c>CharacterController.Move</c>. Release and you COAST - momentum carries, gravity arcs you down; to stop or
    ///     turn, point back the way you came and re-thrust. Touch the ground and it hands back to normal walking; jump
    ///     again to re-launch (exactly "jump up AND hold the trigger").
    ///   - VR: thrust follows the RIGHT hand's pointing (right trigger). Desktop: it follows the HEAD/view direction and
    ///     uses left-click (the desktop "use"/trigger) - toggle desktopFlight off to make it VR-only.
    ///
    /// This replaces VRChat's read-add-write-velocity-on-top approach (VRChat exposed player velocity; Basis doesn't) with
    /// a mode swap that owns motion while flying - which is what actually preserves the ballistic momentum the feel needs.
    /// Set up by BasisSetupAll (a PlayerFlight object at scene root); the board finds the singleton, no manual wiring.
    /// </summary>
    public class BasisPlayerFlight : MonoBehaviour
    {
        [Header("Master")]
        [Tooltip("Master on/off for the whole trigger-flight mechanic. Off = the trigger does nothing while on foot.")]
        public bool enableFlight = true;
        [Tooltip("Let DESKTOP (non-VR) players fly too, along their HEAD/view direction with left-click as the trigger. " +
                 "Off = VR-only (avoids clashing with desktop click-to-interact / UI).")]
        public bool desktopFlight = true;

        [Header("Thrust (jetpack - gravity always stays on)")]
        [Tooltip("Acceleration (m/s^2) added along your hand (VR) / view (desktop) each frame while the trigger is held and " +
                 "you're airborne. Must beat gravity (~9.8) to climb pointing straight up. 30 ramps to the 300 m/s cap in " +
                 "~10 s for the long-haul 'superman' dash; lower = floatier/weaker.")]
        public float flyAccel = 30f;
        [Tooltip("Top HORIZONTAL flight speed (m/s) while flying. Vertical is capped separately. 300 = the superman top speed.")]
        public float maxHorizontalSpeed = 300f;
        [Tooltip("Cap (m/s) on climb AND descent speed WHILE FLYING, so a hard up-thrust or a long thrust-fall stays controllable.")]
        public float maxVerticalSpeed = 300f;
        [Tooltip("Downward gravity (m/s^2) applied every frame while flying (kept on, jetpack-style). ~9.81 = world gravity.")]
        public float gravity = 9.81f;

        [Header("Feel (from SaccFlight)")]
        [Tooltip("Decel / turnaround assist (Back_Thrust): thrust that points AGAINST your velocity is amplified, so pointing " +
                 "back the way you came stops/reverses you snappily instead of mushing through your own momentum. 0 = off. " +
                 "Thrust ALONG your motion is never amplified.")]
        public float backThrust = 0.45f;
        [Tooltip("Cap on the Back_Thrust amplification. 8 = up to 8x thrust when fighting your own momentum (clamped so a " +
                 "300 m/s reversal isn't a one-frame snap - VR comfort). Ignored if backThrust is 0.")]
        public float maxBackThrustScale = 8f;
        [Tooltip("Soft-throttle ramp (1/s). The trigger is treated on/off, so rather than slamming thrust 0->full we ease it " +
                 "in over ~1/throttleRampUp s while held (4 = full in ~0.25 s). Letting go just coasts (no brake).")]
        public float throttleRampUp = 4f;

        [Header("Input")]
        [Tooltip("Analog-trigger press point [0..1] that counts as 'held' (VR trigger / desktop left-click).")]
        [Range(0.1f, 1f)] public float triggerPressPoint = 0.5f;
        [Tooltip("Upward speed (m/s) that counts as 'airborne' even while the ground probe still reads grounded, so the very " +
                 "jump that launches you engages flight (matches 'a fresh upward velocity counts as airborne').")]
        public float takeoffRiseSpeed = 0.5f;

        // The one flight singleton, so the board can suppress it on mount without a path lookup.
        public static BasisPlayerFlight Instance { get; private set; }

        bool _suppressed;        // true while the local player is riding a board (the board owns the inputs then)
        bool _flightActive;      // our JetpackMode is currently installed on the character driver
        readonly JetpackMode _mode = new JetpackMode();

        void OnEnable() { Instance = this; }

        void OnDisable()
        {
            if (_flightActive) ExitFlight();   // never leave the driver stuck in our mode if this is disabled/destroyed
            if (Instance == this) Instance = null;
        }

        // The board calls this on local mount (true) / dismount (false): while riding, the trigger is ollie / grip is boost,
        // so flight must stand down. Suppressing while airborne drops us straight back to normal walking (the board takes over).
        public void SetBoardSuppressed(bool suppressed)
        {
            _suppressed = suppressed;
            if (suppressed && _flightActive) ExitFlight();
        }

        // On-foot poll (Basis has no per-hand input event we can bind flight to, so we poll like the trigger volumes do).
        // While the mode is installed it Ticks itself and owns the motion, so there's nothing to poll here - we only watch
        // for the ENGAGE edge (trigger held + airborne). Cheap: a couple of reads and out on the common not-flying frame.
        void Update()
        {
            if (!enableFlight || _suppressed || _flightActive) return;
            var lp = BasisLocalPlayer.Instance;
            var cd = lp != null ? lp.LocalCharacterDriver : null;
            if (cd == null) return;

            bool triggerHeld = ReadTriggerHeld(out bool vr);
            if (!triggerHeld) return;
            if (!vr && !desktopFlight) return;

            var cc = cd.characterController;
            bool grounded = cc != null ? cc.isGrounded : cd.groundedPlayer;
            float vy = cc != null ? cc.velocity.y : cd.currentVerticalSpeed;
            bool airborne = !grounded || vy > takeoffRiseSpeed;   // rising (the jump) counts, so takeoff is reliable
            if (airborne) EnterFlight(cd);
        }

        void EnterFlight(BasisLocalCharacterDriver cd)
        {
            if (_flightActive) return;
            _mode.Owner = this;
            cd.CurrentMode?.Exit(cd);   // let the outgoing (walk) mode clean up, mirroring SetMode's contract
            cd.CurrentMode = _mode;     // the driver's SimulateMovement now Ticks our mode every frame
            // Mark the kind as non-Walk (Fly is the closest): the driver's SetMode(Walk) on exit is GUARDED by
            // (CurrentModeKind == Walk), so leaving it Walk would make the exit no-op and strand us in flight.
            cd.CurrentModeKind = BasisLocalCharacterDriver.Mode.Fly;
            _mode.Enter(cd);            // seed velocity from the current motion (we bypass SetMode, so Enter is on us)
            _flightActive = true;
        }

        // Leave flight: hand the driver back to normal WALKING. SetMode(Walk) Exits our mode + runs Walk's Enter, so the
        // ground/gravity state resets cleanly (no inherited fall speed). Safe to call when already on foot.
        public void ExitFlight()
        {
            if (!_flightActive) return;
            _flightActive = false;
            var lp = BasisLocalPlayer.Instance;
            var cd = lp != null ? lp.LocalCharacterDriver : null;
            if (cd == null) return;
            // Only if OUR mode is still installed - a board mount / teleport may already have swapped the driver's mode, and
            // we must not yank it back to walking underneath them. SetMode(Walk) itself calls our JetpackMode.Exit.
            if (cd.CurrentMode == _mode)
                cd.SetMode(BasisLocalCharacterDriver.Mode.Walk);
        }

        // VR: the RIGHT hand's trigger (analog). Desktop: left-click (the desktop "use", surfaced as the shared Trigger axis).
        bool ReadTriggerHeld(out bool vr)
        {
            vr = BasisDeviceManagement.IsCurrentModeVR();
            if (vr)
            {
                var dm = BasisDeviceManagement.Instance;
                if (dm != null && dm.FindDevice(out BasisInput rh, BasisBoneTrackedRole.RightHand) && rh != null)
                    return rh.CurrentInputState.Trigger >= triggerPressPoint;
                return false;
            }
            return BasisLocalInputActions.InputState != null && BasisLocalInputActions.InputState.Trigger >= triggerPressPoint;
        }

        // Thrust direction: VR follows the right hand's pointing; desktop follows the head/view direction. World-space
        // forward from the bone driver's outgoing (calibrated world) pose. Zero vector if the bones aren't up yet.
        Vector3 ReadAim(bool vr)
        {
            if (vr)
            {
                var rh = BasisLocalBoneDriver.RightHandControl;
                if (rh != null) return rh.OutgoingWorldData.rotation * Vector3.forward;
                return Vector3.zero;
            }
            var head = BasisLocalBoneDriver.HeadControl;
            if (head != null) return head.OutgoingWorldData.rotation * Vector3.forward;
            return Vector3.zero;
        }

        // The per-frame flight integration, called by JetpackMode.Tick while our mode owns the driver. Integrates the mode's
        // own velocity (gravity + aimed thrust + Back_Thrust + caps), moves the CharacterController, and hands back to walking
        // on touchdown.
        void JetpackTick(BasisLocalCharacterDriver ctx, JetpackMode mode, float dt)
        {
            var cc = ctx.characterController;
            if (cc == null || !cc.enabled) { ExitFlight(); return; }
            if (dt <= 0f) return;
            if (dt > 0.05f) dt = 0.05f;   // clamp big hitches so a stutter can't fling the player

            bool triggerHeld = ReadTriggerHeld(out bool vr);
            bool thrusting = triggerHeld && enableFlight && !_suppressed;
            Vector3 aim = thrusting ? ReadAim(vr) : Vector3.zero;

            // Gravity ALWAYS (jetpack): point up and out-thrust it to climb, point flat and glide-arc down.
            mode.Vel += Vector3.down * (gravity * dt);

            // Soft throttle: the trigger is on/off, so ease 0->1 while held for a controllable climb instead of a jolt.
            mode.Throttle = Mathf.MoveTowards(mode.Throttle, thrusting ? 1f : 0f, throttleRampUp * dt);

            if (thrusting && aim.sqrMagnitude > 1e-6f)
            {
                aim = aim.normalized;
                // Back_Thrust: amplify thrust that OPPOSES current motion (fighting your momentum) so a point-back stops/
                // reverses you snappily; thrust along your motion gets 1x. Clamped for VR comfort.
                float opposing = -Vector3.Dot(mode.Vel, aim);
                float thrustScale = 1f;
                if (backThrust > 0f && opposing > 0f)
                    thrustScale = Mathf.Clamp(opposing * backThrust, 1f, maxBackThrustScale);
                mode.Vel += aim * (flyAccel * mode.Throttle * thrustScale * dt);
            }

            // Caps: horizontal so you don't outrun the top speed; momentum is otherwise KEPT (ballistic - slowing is
            // Back_Thrust or coasting, not air drag). Vertical clamped both ways.
            Vector3 horiz = new Vector3(mode.Vel.x, 0f, mode.Vel.z);
            float hs = horiz.magnitude;
            if (hs > maxHorizontalSpeed) { float k = maxHorizontalSpeed / hs; mode.Vel.x = horiz.x * k; mode.Vel.z = horiz.z * k; }
            if (mode.Vel.y >  maxVerticalSpeed) mode.Vel.y =  maxVerticalSpeed;
            if (mode.Vel.y < -maxVerticalSpeed) mode.Vel.y = -maxVerticalSpeed;

            ctx.Flags = cc.Move(mode.Vel * dt);
            ctx.BasisLocalPlayerTransform.GetPositionAndRotation(out ctx.CurrentPosition, out ctx.CurrentRotation);

            bool grounded = cc.isGrounded;
            ctx.groundedPlayer = grounded;
            ctx.IsFalling = !grounded && mode.Vel.y < 0f;

            // Touched down (and not still climbing off a lip): hand back to walking. Jump again to re-launch.
            if (grounded && mode.Vel.y <= 0.01f) ExitFlight();
        }

        // Our movement mode: a thin IMovementMode that carries the flight velocity/throttle and delegates the per-frame
        // integration back to the owning behaviour (so all the feel config + input lives in one place).
        class JetpackMode : IMovementMode
        {
            public BasisPlayerFlight Owner;
            public Vector3 Vel;
            public float Throttle;

            public string Name => "Jetpack";
            public CollisionHandling Collision => CollisionHandling.Solid;   // keep CharacterController collisions (fly INTO the world, not through it)

            // Seed our velocity from the player's current motion so takeoff is continuous (no dead stop on engage).
            public void Enter(BasisLocalCharacterDriver ctx)
            {
                if (ctx.characterController != null)
                {
                    ctx.characterController.detectCollisions = true;
                    ctx.characterController.enabled = true;
                    Vel = ctx.characterController.velocity;
                }
                else Vel = Vector3.zero;
                Throttle = 0f;
            }

            // Clear the driver's vertical scalar so walking doesn't inherit our fall speed on landing.
            public void Exit(BasisLocalCharacterDriver ctx) { ctx.currentVerticalSpeed = 0f; }

            public void Tick(BasisLocalCharacterDriver ctx, float dt)
            {
                if (Owner != null) Owner.JetpackTick(ctx, this, dt);
            }
        }
    }
}
