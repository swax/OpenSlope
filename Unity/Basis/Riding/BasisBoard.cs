using UnityEngine;
using Basis.Scripts.BasisSdk.Players;
using Basis.Scripts.BasisSdk.Interactions;
using Basis.Scripts.BasisCharacterController;
using Basis.Scripts.Device_Management;
using Basis.Scripts.Device_Management.Devices;
using Basis.Scripts.Device_Management.Devices.Desktop;
using Basis.Scripts.Drivers;
using Basis.Scripts.TransformBinders.BoneControl;

namespace OpenSlope.BasisPlugin
{

    /// <summary>
    /// A rideable snowboard for an imported SSX level, ported to Basis (Unity 6 / URP, plain C#). The Basis analogue of
    /// the VRChat <c>RideableBoard</c>. It subclasses <see cref="BasisSeat"/>: the rider walks up and presses interact
    /// to mount, Basis's seat driver re-fits their body onto this transform every frame (the ExampleMovingChair pattern),
    /// and we drive the transform with a hand-integrated per-surface physics model - so the standing rider goes with it.
    ///
    /// Ported faithfully: the RIDE FEEL (the surface table, carve/turn model, air + flip, charged ollie, held boost,
    /// landing quality, snow-sink spring, wall-ride, collide-and-slide), rail grinding (BasisBoard.Rail.cs), a trimmed
    /// run SCORE (BasisBoard.Score.cs - gems raise the multiplier, tricks/grinds bank points), grind FX (sparks;
    /// BasisBoard.Fx.cs), and networked POSE (a BasisBoardSync + BasisSeatSync companion built by the setup, so
    /// remotes see the board carrying its rider). It also drops the whole VRChat seat/gaze/spin workaround - Basis's seat
    /// re-fits the body without hijacking the view. Still DEFERRED: the carved wake + snow spray (URP shaders), VR
    /// gaze-steer, the race timer + finish-line leaderboard, the boost meter, and the grind-scrape audio clip.
    ///
    /// The board ROOT is the seat: kept level and yawed to the heading so a carve never rolls the rider. A "Heading"
    /// child pivot carries the visible deck's full bank / slope orientation. The physics is hand-integrated in world
    /// metres (no transform scale read), exactly like the VRChat board.
    ///
    /// CONTROLS (the VRChat board's scheme): walk up + interact (trigger) to mount. Left stick / WASD = steer (X) and
    /// tuck/brake (Y). The OLLIE TRIGGER (VR right-hand trigger / desktop left-click) = charged ollie (hold to charge,
    /// release to launch). The BOOST TRIGGER (VR left-hand trigger / desktop Run-Shift) = held boost - on the ground the
    /// forward thrust, in the AIR a gentle thrust aimed by the boost hand (VR) / your look (desktop) (airBoostAccel).
    /// JUMP = dismount (hop
    /// off) - so while riding the interact/trigger ollies instead of standing you up (OnInteractStart is suppressed
    /// mid-ride; jump owns the exit, exactly like the VRChat board).
    ///
    /// The model and remaining contact differences are documented in docs/vrchat/040-carving-response.md.
    /// SurfaceType buckets: 1/3/4/8/16 snow-ish, 5/7/11 ice, 9/2 rock, 10/13/14/18 wall/metal, 18 show-off ramp,
    /// 0 reset (out of bounds), 17 no-collision.
    /// </summary>
    public partial class BasisBoard : BasisSeat
    {
        [Header("Wiring (auto-found if empty)")]
        [Tooltip("Parent of the Surf_<type> colliders. Auto-found as OpenSlope_Map/Collision if empty.")]
        public Transform collisionRoot;
        [Tooltip("The visible deck pivot (a 'Heading' child). Auto-found. Null just means the board root carries the deck.")]
        public Transform headingPivot;

        [Header("Motion")]
        public float gravity = 19f;
        public float gravityRising = 8.5f;
        public float maxSpeed = 33.5f;
        public float airHorizontalDrag = 0.2f;
        [Tooltip("Cruise-target re-accel toward the per-surface speed (the surface speed character).")]
        public float surfaceDrive = 0.6f;

        [Header("Steering (the SSX carve model)")]
        public float airTurnRate = 270f;
        [Tooltip("Visual deck bank into a carve (deg per lean unit).")]
        public float bankAngleMax = 50f;

        [Header("Orientation")]
        public float tiltRate = 270f;
        public float airLevelRate = 15f;
        public float orientationGrace = 0.15f;
        public float launchLevelSpeed = 2.0f;
        public bool smoothContactNormal = true;
        public float normalSmoothing = 0.05f;

        [Header("Air tricks")]
        public bool airTrickEnabled = true;
        public float airFlipRate = 270f;
        public float airTrickDeadzone = 0.2f;
        public bool airFlipInvert = false;
        public float airTrickBoostSpinMul = 1.6f;

        [Header("Push / brake / ollie")]
        public float brakeStrength = 18f;
        public float pushStrength = 12f;
        public float pushCapSpeed = 9f;
        public float jumpSpeed = 6.3f;
        public float chargeRate = 2.5f;
        public float chargeJumpMax = 1.27f;
        public float jumpCoyoteTime = 0.12f;
        [Tooltip("Blend the ollie launch toward the up-slope tangent on steep ground (0..1).")]
        public float launchTangentMix = 1f;

        [Header("Landing")]
        public float landSoftImpact = 7f;
        public float landHardImpact = 18f;
        public float landScrub = 0.5f;
        public bool landBail = false;
        public bool landAnticipate = true;
        public float landAnticipateTime = 0.35f;
        public float landAnticipateHeight = 16f;
        public float landAnticipateMinFall = 2.0f;
        public float landAlignClean = 26f;
        public float landAlignBad = 90f;
        public float landAlignScrub = 0.4f;

        [Header("Boost")]
        public bool holdBoostEnabled = true;
        public float boostAccel = 18f;
        public float boostMaxSpeed = 40f;
        public float boostLeanWindow = 0.3f;
        public float boostCapDecay = 2f;
        public float airBoostAccel = 8f;   // held boost in the AIR thrusts where the boost hand (VR) / look (desktop) points; 0 = off

        [Header("Ground probe")]
        public float rayUp = 1.0f;
        public float rayDown = 3.0f;
        public float hoverHeight = 0.12f;
        public float groundSnap = 0.2f;
        public bool wallRide = true;
        [Tooltip("Into-wall contact speed that bails you (0 = off; the point is to STICK to walls).")]
        public float wallCrashSpeed = 0f;
        [Tooltip("Hit normal.y above this is ridable ground (not a wall) for the obstacle sweep.")]
        public float wallNormalMax = 0.5f;

        [Header("Snow sink (soft contact spring)")]
        public bool snowSink = true;
        public float sinkDepthScale = 1f;
        public float sinkStiffness = 1f;
        public float sinkDamping = 1f;
        public float sinkBudgetSlew = 1f;
        public float sinkLandingPunch = 0.30f;
        public float sinkMaxOvershoot = 0.05f;
        public float sinkBogScale = 1f;

        [Header("Obstacle collide-and-slide")]
        public bool collideWithProps = true;
        public float obstacleBounce = 0f;
        public float obstacleBounceScale = 1f;
        public float obstacleSkin = 0.05f;
        public float sweepFootClearance = 0.6f;
        public bool rideSolidProps = true;
        public int propRideSurfaceType = -1;

        [Header("Out of bounds")]
        [Tooltip("Reset the board to its spawn when it falls below this world Y. Set by the setup from terrain bounds; a " +
                 "very low sentinel disables the floor check (Surf_0 reset still fires).")]
        public float oobFloorY = -1e9f;
        public float oobResetGrace = 0.5f;

        // The board the LOCAL player is currently riding (null when on foot). A world-trigger behaviour with no board
        // reference of its own - a gem pickup - reads this to award its multiplier to the rider (BasisGemPickup).
        public static BasisBoard LocalRider { get; private set; }

        // The rider's current board speed (m/s) - the gem speed-gate reads it. Zero when not ridden.
        public float RiderSpeed => _riding ? _vel.magnitude : 0f;

        // The rider's current board VELOCITY (m/s, world) - a knockable physics prop reads this to fling itself along the
        // board's travel (the board, not the seated rider's root, is what hits it). Zero when not ridden.
        public Vector3 RiderVelocity => _riding ? _vel : Vector3.zero;

        // ---- Runtime state -----------------------------------------------------------------------------
        BasisLocalPlayer _player;
        BasisBoardSync _boardSync;   // pose-network companion (built by BasisBoardSetup); null offline / MVP boards

        // Ski mode: a pair of skis is built as two roll pivots (SkiBank_L/R under the Heading pivot, each carrying its own
        // Deck on that ski's centreline) so each ski EDGES about its OWN long axis; a snowboard is a single centred Deck
        // that banks as a unit. Detected at Start from the deck hierarchy. Null / false on a board.
        Transform _skiBankL, _skiBankR;
        bool _isSkis;

        bool _riding;
        Vector3 _spawnPos;
        Vector3 _spawnFwd = Vector3.forward;

        Vector3 _vel;
        Vector3 _fwd = Vector3.forward;   // board heading (unit); yawed around the contact normal while grounded
        Vector3 _boardUp = Vector3.up;    // physics up (unit); blends toward the contact normal with a rate limit
        Vector3 _contactN = Vector3.up;   // smoothed contact normal
        Vector3 _airUp = Vector3.up;      // airborne deck-up target (level, eased to the landing normal near touchdown)
        bool _wasGrounded;
        bool _wasAir;
        float _airTime;

        float _steer;     // -1..1 stick X
        float _throttle;  // -1..1 stick Y (tuck/brake)
        float _lean;      // smoothed steering intent (-0.905..0.905)
        float _bank;      // current visual deck-roll angle (deg)
        float _slip;      // |sideways slide| (unused on the sink side; kept for parity with the VRChat board)
        float _speedCap;

        bool _charging;
        float _charge;
        bool _releaseQueued;
        float _ollieCooldown;
        float _jumpGrace;
        bool _flipArmed;
        bool _prevOllieHeld;      // ollie TRIGGER held last frame (charge edge detection)
        bool _prevJumpHeld;       // JUMP held last frame (dismount rising-edge detection)
        float _mountGrace;        // brief window after mounting where a still-held jump won't instantly dismount
        bool _boostHeld;
        bool _airBoostActive;   // the aimed air thrust fired this frame -> the boost roar plays airborne too
        const float TriggerPressPoint = 0.5f;   // analog trigger threshold counted as "pressed" (matches the flight)
        float _oobResetCooldown;
        float _padBoostTimer;   // speed-pad boost window (s); while > 0, boost is active without the held input

        float _sinkDepth, _sinkVel, _sinkBudget;

        // probe outputs
        bool _pFound;
        Vector3 _pNormal = Vector3.up;
        int _pSurf = -2;
        float _pGroundY = -1e9f;
        Vector3 _pPoint;
        // The probed ride surface carries the "_R" reset tag. The obstacle sweep only ever meets a reset host as a
        // WALL (it discards up-facing hits, which the down-probe owns), so riding onto the TOP of one reached no
        // reset at all. A contact is a contact whichever face it lands on.
        bool _pResetHost;
        bool _wasOnResetHost;   // last tick's grounded contact was a reset host, so the fire is an EDGE not a level

        // surface cache
        Collider[] _colliders;
        int[] _types;
        int[][] _meshTris;
        Vector3[][] _meshNorms;
        Collider _ownCollider;
        RaycastHit[] _hitBuf = new RaycastHit[64];
        // Colliders the obstacle sweep found itself already inside this frame, for the push-out in
        // ResolveObstacles. Four is ample: an overlap is the exceptional case, not the per-frame one.
        readonly Collider[] _embedded = new Collider[4];
        // The importer parents every mode-2 bounding box under one "PropsBoundsCollision" root, so a
        // parent-reference compare tells them apart with no per-hit GetComponent.
        Transform _boundsRoot;
        bool _boundsRootSearched;
        // The importer's prop collision roots, found once. Depenetration is a PROP response, so this is what
        // keeps terrain out of the embedded list - see OwnedByProps.
        Transform[] _propRoots;
        bool _propRootsSearched;
        /// <summary>
        /// The rider's BODY SPHERE, which is what a native mode-2 bounding box is met by - not the probe
        /// capsule [Trailmap: 370-probe-modes]. Radius measured off the engine at 0.85 m; height is the pelvis,
        /// where the engine poses it. Mode-1 proxies and mode-3 bodies keep the capsule, which stands in for
        /// the engine's 0.1-0.3 m limb spheres. Radius 0 turns the split off.
        /// </summary>
        public float bodySphereRadius = 0.85f;
        public float bodySphereHeight = 0.92f;

        // rider probe capsule (obstacle sweep dims)
        CapsuleCollider _probeCol;
        float _capRadius;
        float _capLow, _capHigh;

        // ---- Lifecycle ---------------------------------------------------------------------------------

        public override void Awake()
        {
            base.Awake();                              // BasisSeat: sets up the interactable + colliders
            OnLocalPlayerEnterSeat += HandleMount;
            OnLocalPlayerExitSeat += HandleDismount;
        }

        public override void OnDestroy()
        {
            OnLocalPlayerEnterSeat -= HandleMount;
            OnLocalPlayerExitSeat -= HandleDismount;
            base.OnDestroy();
        }

        // While riding, the interact/trigger is the OLLIE - so suppress BasisSeat's interact-toggle (which would otherwise
        // stand you up), leaving JUMP as the one way off (the VRChat scheme). When NOT seated the base runs normally, so
        // walking up + interact still mounts.
        public override void OnInteractStart(BasisInput input)
        {
            if (LocallyInSeat) return;   // mid-ride: ignore the stand-on-interact; jump owns the dismount
            base.OnInteractStart(input);
        }

        void Start()
        {
            _ownCollider = GetComponent<Collider>();
            _boardSync = GetComponent<BasisBoardSync>();   // pose sync (present on setup-built boards; null offline is fine)
            if (collisionRoot == null)
            {
                GameObject go = GameObject.Find("OpenSlope_Map/Collision");
                if (go != null) collisionRoot = go.transform;
            }
            FindRailNetwork();   // OpenSlope_Map/Rails (BasisRailNetwork), realized by BasisWiring
            CacheSurfaces();
            if (headingPivot == null) headingPivot = transform.Find("Heading");
            if (headingPivot != null)
            {
                // A pair of skis is built as two SkiBank_L/R roll pivots under Heading; a snowboard has a single "Deck".
                _skiBankL = headingPivot.Find("SkiBank_L");
                _skiBankR = headingPivot.Find("SkiBank_R");
                _isSkis = _skiBankL != null && _skiBankR != null;
            }
            Transform probe = transform.Find("RiderProbe");
            if (probe != null) _probeCol = probe.GetComponent<CapsuleCollider>();
            if (_probeCol != null)
            {
                _capRadius = _probeCol.radius;
                float off = Mathf.Max(0f, _probeCol.height * 0.5f - _probeCol.radius);
                _capLow = _probeCol.center.y - off;
                _capHigh = _probeCol.center.y + off;
            }
            // The board's placed pose is its out-of-bounds respawn.
            _spawnPos = transform.position;
            Vector3 sf = Vector3.ProjectOnPlane(transform.forward, Vector3.up);
            _spawnFwd = sf.sqrMagnitude > 1e-4f ? sf.normalized : Vector3.forward;
            _speedCap = maxSpeed;
        }

        void HandleMount(BasisPlayer player)
        {
            if (player == null || !player.IsLocal) return;
            _player = BasisLocalPlayer.Instance;
            _riding = true;
            _vel = Vector3.zero;
            _boardUp = transform.up;
            if (_boardUp.sqrMagnitude < 1e-4f) _boardUp = Vector3.up;
            _fwd = Vector3.ProjectOnPlane(transform.forward, _boardUp);
            _fwd = _fwd.sqrMagnitude > 1e-4f ? _fwd.normalized : Vector3.forward;
            _contactN = _boardUp; _wasGrounded = false; _airUp = Vector3.up; _airTime = 0f;
            _steer = 0f; _throttle = 0f; _lean = 0f; _bank = 0f; _slip = 0f;
            _charging = false; _charge = 0f; _releaseQueued = false; _prevOllieHeld = false;
            _prevJumpHeld = false; _mountGrace = 0.4f;   // don't let a jump held from the mount hop you right back off
            _ollieCooldown = 0.5f; _jumpGrace = 0f; _wasAir = false; _flipArmed = false;
            _boostHeld = false; _airBoostActive = false; _speedCap = maxSpeed; _oobResetCooldown = oobResetGrace; _padBoostTimer = 0f;
            BoostStage = 0;             // a fresh mount carries no recorded finish-tube launch stage
            ResetGrind();
            LocalRider = this;          // gems read this to award their multiplier to the rider
            ScoreMountHook();           // start a fresh run (score 0)
            StartBoardAudio();          // spin up the glide/carve loops (silent until moving; clips wired by the setup)
            if (BasisPlayerFlight.Instance != null) BasisPlayerFlight.Instance.SetBoardSuppressed(true); // trigger = ollie now, not fly
            if (_boardSync != null) _boardSync.OnLocalMount(); // take network ownership so our pose streams to everyone
        }

        void HandleDismount(BasisPlayer player)
        {
            if (player == null || !player.IsLocal) return;
            _riding = false;
            _vel = Vector3.zero;
            _padBoostTimer = 0f;
            if (LocalRider == this) LocalRider = null;
            ScoreDismountHook();
            StopBoardAudio();           // silence the glide/carve/boost loops so a parked board is quiet
            if (BasisPlayerFlight.Instance != null) BasisPlayerFlight.Instance.SetBoardSuppressed(false); // on foot again: flight re-armed
        }

        // ---- Input -------------------------------------------------------------------------------------

        void ReadInput(bool vr)
        {
            var cd = _player != null ? _player.LocalCharacterDriver : null;
            if (cd == null) { _steer = 0f; _throttle = 0f; return; }
            Vector2 mv = cd.MovementVector;
            _steer = Mathf.Clamp(mv.x, -1f, 1f);
            _throttle = Mathf.Clamp(mv.y, -1f, 1f);

            // Dismount = JUMP (rising edge), like the VRChat board's jump-to-exit. GetVerticalMovement() is the jump/crouch
            // axis, still readable while seated. The mount grace stops a jump that's still held from the mount action from
            // hopping you straight back off. Stand() ends the ride (-> HandleDismount), so bail before touching the ollie.
            if (_mountGrace > 0f) _mountGrace -= Time.deltaTime;
            bool jumpHeld = cd.GetVerticalMovement() > 0.5f;
            if (jumpHeld && !_prevJumpHeld && _mountGrace <= 0f) { _prevJumpHeld = true; RequestDismount(); return; }
            _prevJumpHeld = jumpHeld;

            // Ollie = the OLLIE TRIGGER (VR right-hand trigger / desktop left-click) - charge while held, launch on release.
            bool ollieHeld = ReadOllieTrigger(vr);
            if (ollieHeld && !_prevOllieHeld) { if (_ollieCooldown <= 0f && !_charging) { _charging = true; _charge = 0f; } }
            else if (!ollieHeld && _prevOllieHeld && _charging) { _charging = false; _releaseQueued = true; }
            _prevOllieHeld = ollieHeld;

            // Held boost: the BOOST TRIGGER (VR left-hand trigger / Run-Shift on desktop).
            _boostHeld = holdBoostEnabled && ReadBoostHeld(vr);
        }

        // Exit the board = stand up. LocalSeatDriver.Stand() fires the seat's OnExitSeat -> HandleDismount, which clears
        // the ride state, so the whole dismount runs through the one path the mount does.
        void RequestDismount()
        {
            if (_player != null && _player.LocalSeatDriver != null) _player.LocalSeatDriver.Stand();
        }

        // The OLLIE trigger: VR = the RIGHT hand's analog trigger; desktop = left-click (the shared Trigger axis, same
        // source the flight reads).
        bool ReadOllieTrigger(bool vr)
        {
            if (vr)
            {
                var dm = BasisDeviceManagement.Instance;
                if (dm != null && dm.FindDevice(out BasisInput r, BasisBoneTrackedRole.RightHand) && r != null)
                    return r.CurrentInputState.Trigger >= TriggerPressPoint;
                return false;
            }
            return BasisLocalInputActions.InputState != null && BasisLocalInputActions.InputState.Trigger >= TriggerPressPoint;
        }

        // The BOOST trigger: VR = the LEFT hand's analog trigger; desktop = hold Run/Shift (desktop has no second trigger).
        bool ReadBoostHeld(bool vr)
        {
            if (vr)
            {
                var dm = BasisDeviceManagement.Instance;
                if (dm != null && dm.FindDevice(out BasisInput l, BasisBoneTrackedRole.LeftHand) && l != null)
                    return l.CurrentInputState.Trigger >= TriggerPressPoint;
                return false;
            }
            return BasisLocalInputActions.IsRunHeld; // desktop: hold Shift
        }

        bool BoostActive() { return _padBoostTimer > 0f || (holdBoostEnabled && _boostHeld); }

        // Aim direction for the air boost: VR = the LEFT hand (the one squeezing the boost trigger), the flight's
        // point-to-fly gesture; desktop = the head/view (no tracked hand). World-space forward from the bone driver's
        // calibrated pose - the same source the flight's aim reads. Zero if the bones aren't up yet.
        Vector3 BoostAimDir(bool vr)
        {
            var control = vr ? BasisLocalBoneDriver.LeftHandControl : BasisLocalBoneDriver.HeadControl;
            return control != null ? control.OutgoingWorldData.rotation * Vector3.forward : Vector3.zero;
        }

        // A speed pad was crossed (BasisBoostPad): run the board's boost for `seconds` WITHOUT the held input - it raises
        // the top-speed cap + feeds the lean-gated forward thrust, exactly like holding boost (an accel, not a velocity
        // write, so it can't fling a stopped rider). MAX-not-stack: re-crossing extends to the longer window, doesn't add.
        public void ApplyPadSpeedBoost(float seconds) { if (seconds > _padBoostTimer) _padBoostTimer = seconds; }

        // ---- The MainType-0 boost family (docs/053) - the Basis analogue of the VRChat board's ------------------
        // The shared push behind all four boost VOLUMES: speed along an authored WORLD direction approaches `target` as
        // a first-order lag with time constant 1/rate ([Trailmap: 360-node-apply]). Called EVERY TICK the rider is
        // inside the volume - these are containment volumes, and a lift that fired once on the cross would lurch
        // instead of climb. Unlike the speed PAD above (an accel along your own travel), this drives a designer's
        // vector, so it can shove a slow rider sideways or straight up. It only ever ADDS - a rider already faster
        // along the axis is left alone, so a boost never brakes. It does NOT touch the speed cap: a scripted boost node
        // writes neither pad-request field, so it raises no cap tier ([Trailmap: 360-cap]), and a grounded rider stays
        // bounded at MAX_SPEED however violent the push - only going airborne re-arms the top tier. Measured on PS2
        // across retail's own exhaust vent (autotest cell `vent-throw`): peak carried speed 33.47 m/s in all three
        // passes, which is BOOST_MAX_SPEED to three figures.
        public void ApplyBoostPush(Vector3 worldDir, float target, float rate, float dt)
        {
            if (rate <= 0f || dt <= 0f || worldDir.sqrMagnitude < 1e-6f) return;
            Vector3 d = worldDir.normalized;
            float deficit = target - Vector3.Dot(_vel, d);
            if (deficit <= 0f) return;
            _vel += d * (deficit * rate * dt);
        }

        // The two LIFT volumes cancel travel every tick they lift, leaving only the climb - that is what makes them
        // elevators rather than pushes.
        public void KillBoostHorizontalVelocity() { _vel = new Vector3(0f, _vel.y, 0f); }

        // The vertical lift's arrival branch: place the rider at the target altitude, POSITION ONLY. The engine writes
        // the altitude and moves straight to the next rider, so the climb velocity survives - and that surviving climb
        // is exactly what the tube-end launch then builds on.
        public void SnapToBoostAltitude(float worldY)
        {
            Vector3 p = transform.position;
            transform.position = new Vector3(p.x, worldY, p.z);
        }

        // The launch stage the LAP boost recorded, read by the TUBE-END boost at the top of the same shaft. The engine
        // keeps this in a small global table indexed by rider, referenced only by those two nodes - the two volumes are
        // really one mechanism ([Trailmap: 360-tube-pair]), so per-rider board state is the honest home for it.
        [HideInInspector] public int BoostStage;

        // Apply the charged-ollie launch impulse along the cached contact normal, blended toward the up-slope tangent on
        // steep ground. Mirrors the VRChat LaunchOllie (minus the sound).
        void LaunchOllie()
        {
            Vector3 n = _contactN.sqrMagnitude > 1e-6f ? _contactN.normalized : Vector3.up;
            Vector3 travel = _vel.sqrMagnitude > 1e-4f ? _vel : _fwd;
            Vector3 tangent = Vector3.ProjectOnPlane(travel, n);
            tangent = tangent.sqrMagnitude > 1e-6f ? tangent.normalized : _fwd;
            float nUp = Mathf.Clamp01(n.y);
            float steep01 = Mathf.Clamp01((0.642788f - nUp) / 0.300768f);          // cos50 -> cos70
            float tangentUp = Mathf.Clamp01((tangent.y - 0.342020f) / 0.657980f);  // up past ~sin20
            float weight = Mathf.Clamp(steep01 * tangentUp * Mathf.Clamp01(launchTangentMix), 0f, 0.9f);
            Vector3 launchDir = n + tangent * weight;
            launchDir = launchDir.sqrMagnitude > 1e-6f ? launchDir.normalized : n;
            _vel += launchDir * (jumpSpeed * (1f + (chargeJumpMax - 1f) * _charge * _charge));
            _ollieCooldown = 0.35f;
        }
    }
}
