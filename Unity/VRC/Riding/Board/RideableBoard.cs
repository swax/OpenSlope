using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.Udon.Common;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// A rideable snowboard for an imported SSX level. The player STANDS on it (a <see cref="VRCStation"/> built
    /// seated=false; see RideableBoardSetup) and the board is the vehicle: we hand-integrate a world velocity and
    /// move the station transform, so the standing rider goes with it. This is the ONE way to get real per-surface
    /// physics in VRChat - the walking avatar capsule is engine-controlled and ignores friction, so we can't make the
    /// player slide; a station we drive ourselves, we can.
    ///
    /// Local rider only (sync None). Kinematic on purpose: hand-integrating is predictable on VRChat and keeps the
    /// surface model explicit, where letting PhysX integrate a body that also carries a seated player invites the
    /// station and solver to fight.
    ///
    /// CONTROLS: look at the board + Use/click to mount. Left stick / WASD = steer (X) and tuck/brake (Y). Use /
    /// right-trigger / left-click = ollie. LEFT trigger (VR) / right mouse (desktop) = held boost - on the ground the
    /// forward thrust, in the AIR a gentle thrust aimed by the boost hand (VR) / your look (desktop) (airBoostAccel).
    /// Jump = dismount
    /// (the station's own exit is disabled so steering input can't eject you). In VR the head free-look steers and the
    /// seat stays pinned; on desktop the camera follows the heading and the mouse free-looks.
    ///
    /// The model + design provenance live in the docs, not here: docs/vrchat/017 (ride loop, boost, rider probe,
    /// collide-and-slide), docs/vrchat/020 (per-SurfaceType coefficients, snow spray, snow sink), docs/021 (smooth contact
    /// normal), docs/026 (rail grinding). docs/vrchat/017 maps the partials and records the design history. Tune the global
    /// knobs below; the per-surface response table (contact + carve + cruise) lives in RideableBoard.Surface.cs.
    ///
    /// MOTION runs on a fixed 60 Hz tick (Tick/GroundTick/AirTick below): the engine's contact model is a per-tick
    /// discrete system - the pushout adds a length to velocity once a tick, the grounded redirect removes a flat 40%
    /// of the normal velocity, the contact fields slew a fixed step - so Update banks real time and spends it in
    /// whole ticks [Trailmap: 320-ground-contact]. Per-frame work (input, FX, audio, orientation, telemetry) stays
    /// in Update around the tick loop.
    ///
    /// SurfaceType buckets (PBDHandler legend): 1/3/4/8/16 snow-ish  5/7/11 ice  9/2 rock  10/13/14/18 wall/metal
    /// 18 show-off ramp  0 reset (out of bounds)  17 no-collision (no collider).
    ///
    /// MULTIPLAYER (docs/vrchat/042): a shared, networked vehicle. Manual, server-timestamped sync; the OWNER (the local rider) runs the ride
    /// physics and publishes its pose, every other client eases its copy onto that pose so it sees the board carve under
    /// the rider's avatar. Mounting is OWNERSHIP-GATED (request ownership, seat only once it lands) so taking a board
    /// can't snap, and a ridden board can't be stolen (OnOwnershipRequest refuses while occupied). All of it is behind
    /// the `networked` toggle; in a solo instance the local player owns everything, so it runs exactly as the old
    /// local-only board did.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.Manual)]
    public partial class RideableBoard : UdonSharpBehaviour
    {
        [Header("Wiring (auto-found if empty)")]
        [Tooltip("The station the rider stands on. Falls back to a VRCStation on this object.")]
        public VRCStation station;
        [Tooltip("Parent of the Surf_<type> colliders. Auto-found as OpenSlope_Map/Collision if empty.")]
        public Transform collisionRoot;
        [Tooltip("The level's grind-rail network (RailNetwork on OpenSlope_Rails). Auto-found; null just disables grinding.")]
        public RailNetwork railNetwork;
        [Tooltip("The course path (RailNetwork on OpenSlope_CoursePath, baked from the game's race lines). Auto-found. The " +
                 "out-of-bounds reset snaps you to the nearest point on it; null falls back to the breadcrumb trail.")]
        public RailNetwork coursePath;
        [Tooltip("The course finish line (FinishLine on OpenSlope_Map/FinishLine, built by LeaderboardSetup). Auto-found. " +
                 "The board reads its Laps to seed the run's lap countdown - set a map's lap count THERE, not here. " +
                 "Null = no race to lap: runs stay single-pass and the finish-tube boost volume lifts every time.")]
        public FinishLine finishLine;
        [Tooltip("The level's analytic terrain patches (TerrainPatches on OpenSlope_Map/Collision/TerrainPatches, baked by " +
                 "TerrainPatchBuilder from the level's bicubic patch control points). Auto-found. When present, " +
                 "the ground probe rides the EXACT bicubic surface the PS2 used (Newton-" +
                 "refined) instead of the faceted collider; null falls back to the PN/faceted contact.")]
        public TerrainPatches terrainPatches;
        [Tooltip("The in-world Tuning Board (DiagnosticsBoard), wired by DiagnosticsBoardSetup onto every pooled " +
                 "board. The board reads its PERF section's remoteRiderFx / boardLocalFx flags each frame, so a viewer who " +
                 "unchecked 'Other riders' FX' sees no wake/spray on OTHER players' boards and one who unchecked 'My " +
                 "board FX' drops their own. Null = FX always on (the default).")]
        public DiagnosticsBoard diagnosticsBoard;

        [Header("Multiplayer (shared networked board - see docs/vrchat/042)")]
        [Tooltip("ON: the board is a shared, networked vehicle - the local rider OWNS it and runs the physics, every other " +
                 "client eases its copy onto the owner's synced pose so it sees the board ride under the rider's avatar; " +
                 "mounting is ownership-gated and a ridden board can't be stolen. OFF: the old purely-local board (each " +
                 "client has its own private copy; riders are invisible to each other). In a SOLO instance the local " +
                 "player owns everything either way, so ON behaves identically to OFF there. Set OFF for the from-scratch " +
                 "demo board. NOTE the new-field-default gotcha: this '= true' only reaches RE-BUILT boards.")]
        public bool networked = true;
        [Tooltip("ROTATION follow rate (1/s) for a REMOTE copy slerping its heading/bank onto the owner's synced rotation. " +
                 "(POSITION is smoothed separately via netSmoothTime.) Higher = tighter, lower = smoother/laggier.")]
        public float netFollowRate = 12f;
        [Tooltip("Remote POSITION smoothing time (s): the critically-damped chase of the dead-reckoned target (Unity " +
                 "SmoothDamp). This is the SaccFlight-style velocity-driven smoothing - the ghost is moved by a continuous " +
                 "internal velocity and eases onto the extrapolated target with NO overshoot, so a packet that lands BEHIND " +
                 "the prediction bleeds in smoothly instead of snapping back (the 'lurch forward then snap' artifact). " +
                 "Higher = smoother but laggier/looser; lower = tighter but can show packet jitter. ~0.1-0.15 is a good middle.")]
        public float netSmoothTime = 0.12f;
        [Tooltip("OWNER teleport-reject (m): a one-frame move bigger than this is treated as a TELEPORT (respawn / OOB " +
                 "reset), so the owner publishes ZERO velocity for it instead of a huge spike that would fling remotes. " +
                 "Real riding moves <0.5m/frame, so 8 sits safely above legit motion and below any teleport. (This is the " +
                 "owner-side gate only; the REMOTE follow uses netRemoteSnap.)")]
        public float netSnapDistance = 8f;
        [Tooltip("REMOTE 'real teleport' snap (m): a remote only CUTS its board straight to the owner's pose when the " +
                 "dead-reckoned carrot is THIS far away - i.e. a genuine respawn. Kept LARGE (50) on purpose: in normal " +
                 "riding the carrot never gets this far, so the board ALWAYS smoothly chases it and NEVER teleports forward " +
                 "(the carrot/stick 'never jump' rule). Only a real cross-map respawn cuts; everything else slides in. " +
                 "Lower only if you want respawns to slide less.")]
        public float netRemoteSnap = 50f;
        [Tooltip("Remote DEAD-RECKONING horizon: max time (s) a remote coasts the board along the owner's last synced " +
                 "velocity between packets. MUST exceed the REAL delivery interval, which under VRChat's manual-sync " +
                 "throttle is ~0.5-1s (NOT the 0.1 requested): if it's shorter the prediction FREEZES mid-gap and the " +
                 "board stalls then jumps forward when the next packet lands (the 'smooth-then-jump' artifact). ~1.5 " +
                 "covers the real interval with margin so the ghost glides continuously; past it (a multi-second dropout) " +
                 "the coast HOLDS, bounded to ~vel*1.5, instead of rocketing away. It's a runaway/dropout guard now, not a " +
                 "per-packet clamp - SmoothDamp absorbs the small normal correction. Raising it trades absolute position " +
                 "accuracy for continuous motion (the priority on a big map).")]
        public float netMaxExtrap = 1.5f;
        [Tooltip("Remote ACCELERATION extrapolation: a remote reconstructs the owner's acceleration from consecutive " +
                 "synced-velocity samples (low-passed) and predicts the board's CURVE (target = pos + vel*age + " +
                 "0.5*accel*age^2), so a board that's speeding up or carving is predicted instead of under-shooting and " +
                 "lurching forward each packet (SaccFlight does the same). This CAPS the reconstructed acceleration (m/s^2); " +
                 "keep it near real slope/carve accel (~15-25) - too high lets a noisy sample over-predict and jitter. " +
                 "Set 0 to turn acceleration extrapolation OFF (pure velocity SmoothDamp) - handy as an A/B against the " +
                 "curve-aware version.")]
        public float netMaxAccel = 20f;
        [Tooltip("Remote ROTATION extrapolation: how far (in multiples of a packet interval) a remote may extrapolate the " +
                 "board's heading/bank forward along its reconstructed angular velocity, so a carving/spinning board's " +
                 "ORIENTATION is predicted instead of lagging and stepping to catch up. ~1.5 covers a couple of " +
                 "packets; set 0 for plain slerp-to-last-rotation (no rotation extrapolation).")]
        public float netMaxRotExtrap = 1.5f;
        [Tooltip("Owner SEND interval (s): how often the owner manually serializes the board's pose+velocity+timestamp " +
                 "while it's moving (manual sync, NOT continuous). Lower = smoother/more responsive remotes but more " +
                 "bandwidth - VRChat rate-limits serialization, so going much below ~0.1 risks 'clogging' (sends are " +
                 "skipped while clogged). ~0.1-0.2 is the usable range; 0.1 is responsive, 0.2 is SaccFlight's default.")]
        public float netSendInterval = 0.1f;
        [Tooltip("Safety timeout (s) on an ownership-gated mount: if a requested ownership transfer never lands (lost race " +
                 "or refused), give up the pending mount after this so a click can't leave you stuck.")]
        public float netMountTimeout = 2f;
        [Tooltip("Sleep a board that's parked & settled (no rider, stopped, wake melted): it skips its per-frame Update AND " +
                 "stops publishing its synced pose, so an abandoned or at-the-gate board costs ~nothing (no physics tick, " +
                 "no continuous-sync bandwidth) until someone mounts it or it's re-dispensed. This is what lets boards " +
                 "PERSIST on the mountain cheaply instead of being returned to the pool (docs/vrchat/042). OFF = a parked board " +
                 "keeps ticking + syncing its static pose. Waking is event-driven (mount / WakeUp), so this never blocks a " +
                 "pickup.")]
        public bool sleepWhenParked = true;
        [Tooltip("Seconds a board must sit fully parked before it sleeps - long enough that its resting pose has propagated " +
                 "to every client over the network first.")]
        public float sleepDelay = 1.5f;

        [Header("Start-gate dispenser state (driven by BoardManager - leave alone)")]
        [Tooltip("True while this board is the one sitting AVAILABLE at its start-gate post: set by BoardManager.Dispense " +
                 "(via PlaceAtGate), cleared on mount so the post can dispense another. While set, the riderless coast bails " +
                 "so a recycled board can't slide off its gate. Ignored when the board isn't part of a gate. [UdonSynced] so " +
                 "the MOUNTING client knows a board is gate-fresh: a timed leaderboard run only starts off a fresh gate board " +
                 "(docs/050), and the master sets this when it dispenses one.")]
        [UdonSynced] public bool atGate;
        [Tooltip("True while a rider is on this board, so the spawner never recycles a board out from under someone. " +
                 "[UdonSynced] so EVERY client knows a board is taken: the dispenser only hands out free boards, and " +
                 "Interact / OnOwnershipRequest read it to refuse stealing a board out from under its rider (docs/vrchat/042).")]
        [UdonSynced] public bool occupied;
        [Tooltip("WHOSE board this is: the playerId of the last person to ride it (or to be handed it by the summon), -1 = " +
                 "unclaimed. Riding a board claims it and the claim STICKS after you get off, so the board stays yours " +
                 "wherever it ends up on the mountain - that's what the over-the-shoulder summon recalls (BoardSummon). " +
                 "Mounting someone else's board takes the claim from them. Cleared when the board is recycled to a gate post " +
                 "(PlaceAtGate) or when the claimant leaves the instance. [UdonSynced] so every client can find its own board.")]
        [UdonSynced] public int claimedBy = -1;

        [Header("Rider probe (read by the trigger volumes - leave alone)")]
        [Tooltip("True while a local rider is on this board. The firework / crash-bag volumes read this through the " +
                 "RiderProbe so they only fire while the board is actually ridden.")]
        public bool IsRiding;
        [Tooltip("True while the LOCAL player has this board in their hand - carried by the grip, or summoned over the " +
                 "shoulder. BoardSummon reads it to know your hands are already full. See RideableBoard.Grab.cs.")]
        public bool IsHeldLocally;
        [Tooltip("The board's current world velocity. The crash-bag prop reads it to fling itself along the rider's " +
                 "motion (a VRCStation passenger reports no player velocity of its own).")]
        public Vector3 RiderVelocity;

        // Debug telemetry for DebugHud (the in-world FPS / ride HUD). Set every ridden frame; only meaningful while
        // IsRiding (speed comes from RiderVelocity above). HideInInspector keeps them out of the cluttered board inspector
        // while staying public => Udon-exposed for the HUD's cross-behaviour read.
        [HideInInspector] public int dbgSurf = -2;   // current contact SurfaceType (-2 = airborne)
        [HideInInspector] public bool dbgGround;     // grounded this frame?
        [HideInInspector] public bool dbgResetHost;  // the accepted contact carries the "_R" reset tag: a MainType-13 host
                                                     // whose reset rides on its own collision rather than a ResetZone box
        [HideInInspector] public bool dbgBoost;      // boost active this frame?
        [HideInInspector] public float dbgCharge;    // ollie charge 0..1 while a jump is being charged (0 = not charging)
        [HideInInspector] public float dbgUpdateMs;  // measured wall-time of THIS board's ridden Update() (ms, smoothed) - diagnostic:
                                                     // if frame ms spikes near props but this stays flat, the cost is OUTSIDE our Udon (PhysX / VRChat)
        // Per-section breakdown of the ridden Update (ms, smoothed) - to find WHICH part spikes. Individual floats (not an
        // array) so a new-field null backing can't NRE-halt the board. See DbgLap checkpoints in Update.
        [HideInInspector] public float dbgSecProbe;   // out-of-bounds + boost audio (the pre-tick per-frame work)
        [HideInInspector] public float dbgSecRail;    // rail-grind detection
        [HideInInspector] public float dbgSecInteg;   // the fixed-tick loop: probe + contact + steering + integration + obstacle resolve
        [HideInInspector] public float dbgSecOrient;  // deck orientation / pose
        [HideInInspector] public float dbgSecAudioFx; // board audio + race audio + wake/spray
        // Editor/ClientSim autotest seam. These fields are inert unless AutoTestControl is explicitly enabled by the
        // guarded editor runner; ordinary VRChat input and riding are unchanged. Public fields + parameterless methods
        // are intentional so the runner can drive the compiled UdonBehaviour, not an editor-only proxy.
        [HideInInspector] public bool AutoTestControl;
        [HideInInspector] public float AutoTestSteer;
        [HideInInspector] public float AutoTestThrottle;
        [HideInInspector] public bool AutoTestBoost;
        [HideInInspector] public Vector3 AutoTestDropPosition;
        [HideInInspector] public Vector3 AutoTestDropForward = Vector3.forward;
        [HideInInspector] public float AutoTestDropSpeed = 20f;
        [HideInInspector] public float AutoTestBoostWindow;
        private float _dbgT0;
        private float _dbgLast;
        private int _telemetryFrame;                  // emitted RIDE_DBG frame records in this mount/debug session
        private int _telemetryTick;                   // completed 60 Hz ride ticks since mount
        private int _telemetryEvents;                 // bit 0 takeoff, bit 1 touchdown, bit 2 charged launch this Update
        private bool _telemetryHeaderWritten;

        [Header("Drive")]
        [Tooltip("Riderless-coast quadratic drag only. The shared ridden-ground contract has no generic longitudinal drag.")]
        public float speedDrag = 0.012f;

        [Header("Riderless coast (after you Jump off, the empty board keeps its speed, falls, and slides to a stop)")]
        [Tooltip("ON: jumping off hands the board to a riderless coast - it keeps its speed, falls, and slides to rest " +
                 "like a dropped board. OFF: the board freezes in place the instant you step off.")]
        public bool coastAfterDismount = true;
        [Tooltip("Riderless friction decel (m/s^2) - how hard an empty board scrubs to a stop (applied to the full " +
                 "ground velocity AND the air horizontal carry). Higher = stops sooner; lower = glides farther.")]
        public float coastFriction = 14f;
        [Tooltip("Park the coasting board once it's grounded and slower than this (m/s) so it doesn't creep.")]
        public float coastStopSpeed = 1.5f;
        [Tooltip("Safety cap (s): a riderless board coasts at most this long before it's force-parked.")]
        public float coastMaxTime = 6f;

        [Header("Handling")]
        // Air and ground turn rates come from the shared contract. Rail free-steer deliberately reuses the air rate so
        // keyboard/gamepad and VR stick spins carry the same heading authority across both trick states.
        [Tooltip("DEBUG: log parseable per-frame ride telemetry to the console while riding (prefixed 'RIDE_DBG'). Includes " +
                 "contract identity, position/velocity, probe/contact, trajectory pitch and visible board pitch. Off for " +
                 "normal play (per-frame Debug.Log is not free).")]
        public bool debugLog = false;
        [Tooltip("Edge-pivot the carve bank (game-faithful). The engine rolls the deck but never lifts it, so a bank " +
                 "about the deck CENTRELINE sinks the downhill edge halfWidth*sin(bank) through the snow (the 'half the " +
                 "board in the ground' look). This lifts the visible deck along the slope normal by halfWidth*sin(bank)*this " +
                 "so the bank pivots about the planted DOWNHILL EDGE - the edge stays on the snow and the body rises (the " +
                 "real carving silhouette). 1 = the exact lift that keeps the edge planted; <1 lets the edge bite a little " +
                 "into soft snow; >1 floats the deck higher; 0 = OFF (roll about the centre, old behaviour, clips at steep " +
                 "banks). See docs/deck ride-height.")]
        public float bankLiftScale = 1f;
        [Tooltip("AIR TRICK toggle: in the air, push/pull stick-Y (W/S on desktop, left-stick fwd/back in VR) to SOMERSAULT " +
                 "the deck nose-over-tail (front/back FLIP). Stick-X still spins (yaw). The flip is VISUAL on the deck - your " +
                 "trajectory stays a ballistic arc and your view never inverts (the seat is pinned for comfort), so the board " +
                 "rotates under your upright avatar. Once you start a flip the auto-level + landing pre-align are SUPPRESSED " +
                 "until you land, so an UNFINISHED flip lands crooked and pays the touchdown tilt band (finish it near " +
                 "level to keep your speed). OFF = stick-Y does nothing in the air (the old behaviour). See docs/vrchat/017.")]
        public bool airTrickEnabled = true;
        [Tooltip("Flip rotation rate (deg/s) at full stick-Y - how fast the deck somersaults. 360 = a full flip per second of " +
                 "held stick. Higher = snappier flips that complete in less airtime.")]
        public float airFlipRate = 270f;
        [Tooltip("Stick-Y deadzone for arming a flip, so a light touch doesn't start one (stick-Y is unused in the air " +
                 "otherwise). Below this no flip; the deck auto-levels as before.")]
        public float airTrickDeadzone = 0.2f;
        [Tooltip("Invert the flip direction: when ON, pushing forward (W) is a BACKflip instead of a frontflip. Pure taste - " +
                 "flip it if the default feels backwards in the ride-test.")]
        public bool airFlipInvert = false;
        [Tooltip("TRICK-BOOST air spin-up: while boosting (held boost or a course pad window), the air yaw-spin AND flip rate " +
                 "are multiplied by this. 1.6 is the GAME's own trick-boost constant - the SSX Tricky engine applies exactly " +
                 "x1.6 to the trick-boost spin rate, though in the real game that multiply is gated to the RAIL " +
                 "spin state (state 16, +/-80deg yaw); the air spin reads no boost field (faster air spin there comes from the " +
                 "prewind/tap flick). This lifts that same x1.6 onto the air spin/flip while boosting - an embellishment for " +
                 "feel, grounded in the game's number. 1 = off (engine-faithful: boost doesn't speed air spin).")]
        public float airTrickBoostSpinMul = 1.6f;
        [Tooltip("Fallback contact-normal smoothing time constant (s). Analytic patch contact is exact; this low-pass is " +
                 "used only when a level lacks patch data or an analytic solve cannot be accepted.")]
        public float normalSmoothing = 0.05f;
        [Tooltip("Brake deceleration when pulling back on the stick (m/s^2).")]
        public float brakeStrength = 18f;
        [Tooltip("Hold Use to charge a bigger ollie: charge fills at this rate/s, so 1/this = seconds of hold for full " +
                 "power. The launch magnitude/direction are the traced constants (JUMP_MIN and friends, LaunchOllie).")]
        public float chargeRate = 2.5f;
        [Tooltip("Jump COYOTE TIME (s) - how long after losing ground contact an ollie still counts as grounded, so a " +
                 "jump pressed during a bump-induced air skip still fires. Beyond it a pending ollie is cancelled (no " +
                 "mid-air double-jump). ~0.12 swallows a few skipped frames; 0 = strict.")]
        public float jumpCoyoteTime = 0.12f;
        [Tooltip("Push/skate accel from forward input, used to get going on flats (m/s^2).")]
        public float pushStrength = 12f;
        [Tooltip("Forward push fades to zero by this speed (m/s) - it's only there to start you rolling.")]
        public float pushCapSpeed = 9f;

        [Header("Low-grip steering assist (ice; NOT retail - a rider aid, like wallCrashSpeed 0)")]
        [Tooltip("Make near-frictionless surfaces steerable. Retail ice is laterally frictionless (carve drag 0.0025 " +
                 "against snow's 1.2017) and the measured consequence is not that a skid fails to recover - it is that " +
                 "the skid recovers the WRONG WAY: centre the input mid-carve and the slip angle reaches zero in 0.75 s " +
                 "with 77% of the closure coming from the board YAWING ONTO ITS DRIFT rather than the drift bending back " +
                 "(snow inverts that, 28/72). You are then travelling ~21 deg off your line, reading zero slip, with " +
                 "nothing left to correct it. Survivable on a stick, which holds counter-lean for free; not survivable on " +
                 "head-steer, where a neck has ~60 deg of range and no detent. OFF = exact retail ice everywhere.")]
        public bool lowGripAssist = false;
        [Tooltip("Assist authority ramps in as a surface's own carve drag falls BELOW this, so the ride table selects " +
                 "where the aid applies instead of a hardcoded row: ice (0.0025) -> 0.98, ice crunch (0) -> 1.00, speed " +
                 "(0.03) -> 0.80, off-track metal (0.1) -> 0.33, and every ordinary surface - snow 1.2017, off-track " +
                 "1.5091, powder 3.0013, generic 1.0 - -> exactly 0, so all three terms below vanish and those surfaces " +
                 "ride bit-identically to before.")]
        public float lowGripDragRef = 0.15f;
        [Tooltip("TERM 1. Fraction of the heading yaw withheld while it is UN-COMMITTING - the commanded lead has fallen " +
                 "inside the drift already being carried, so the closure is walking the board out onto that drift. " +
                 "Entering a carve and reversing one keep full retail authority, so the carve itself is untouched. This " +
                 "adds no grip; it only stops the board reporting zero slip while you are still leaving the course.")]
        public float lowGripSelfCenterDamp = 0.97f;
        [Tooltip("TERM 2. Rate (1/s) at which lateral velocity is pulled onto the lean's COMMANDED drift rather than onto " +
                 "zero, so a held lean keeps its full retail drift and only the slip nobody asked for is bled off. The " +
                 "commanded value needs no table: on a near-frictionless surface the settled slip angle IS the heading's " +
                 "own lead angle (measured 0.9734 x turnLean, 0.26 deg max residual over the whole lean range and every " +
                 "speed). Higher = crisper recovery but less ice character; this is the knob to back off first.")]
        public float lowGripSlipRecover = 2.5f;
        [Tooltip("TERM 3. Lifts a low-grip surface's carve TILT toward the 58.3 deg that 17 of the 20 rows carry - this is " +
                 "turn AUTHORITY, the thing that decides whether your line fits inside the course. 0 = retail, 1 = snow " +
                 "parity. Reaches ice (45 deg) and nothing else: rock's 21.34 deg is a high-drag row and reads assist 0, " +
                 "and every other low-grip row already sits at 58.3. At 0.5, ice's full-lean turn radius goes 18.5 m -> " +
                 "14.2 m while the drift angle barely moves (27.2 -> 26.8 deg), so ice keeps its look and gains a line.")]
        public float lowGripTiltLift = 0.5f;

        [Header("Head steering (VR-only: look/turn to steer; the seat stays pinned so the view never spins)")]
        [Tooltip("Steer by looking - VR ONLY (see headLookVROnly). The heading rotates to MATCH where your head points " +
                 "and stops there; the seat is pinned so steering never moves your view (no feedback spin, no sickness). " +
                 "On the GROUND the gaze offset also drives the game's input->lean slew like a stick (full lean ~30 deg " +
                 "past the deadzone), so a head-steered turn carves with the real tilt force - ice included - and banks " +
                 "the deck. Force-disabled on desktop (mouse-look is seat-relative there and would spin) - desktop uses stick-steer.")]
        public bool headLookSteer = true;
        [Tooltip("Head yaw (deg) treated as 'aligned' - the board stops turning once within this of your gaze, so small " +
                 "glances don't nudge it. Smaller = tracks your look more exactly.")]
        public float headLookDeadzone = 5f;
        [Tooltip("Gaze offset from the TRAVEL direction (deg past the deadzone) that maps to FULL lean when head-steering " +
                 "on the ground. Measured against travel, never the nose: the yaw closure parks the nose on the gaze in " +
                 "~0.1 s, so a nose-referenced lean cancels itself before its force can act. The gaze drives the same " +
                 "input->lean slew as the stick, so a head turn EDGES the board and the lean ebbs as the carve brings the " +
                 "path around - on ice the facing yaw alone cannot bend the path (near-zero carve drag); only the lean's " +
                 "banked force can. A deflected stick always overrides the gaze lean. 0 disables gaze lean (head-steer " +
                 "aims the nose only).")]
        public float headLeanFullAngle = 30f;
        // The head-follow slew speed is not separate: air uses the generated rate and rails use their state field.
        [Tooltip("Keep head-steer to VR only (recommended TRUE). Desktop mouse-look is seat-relative, so head-steer there " +
                 "feeds back into a spin; desktop uses stick-steer + free-look instead.")]
        public bool headLookVROnly = true;
        [Tooltip("VR SETTLE-REALIGN rate (deg/s). Head-steer turns the board but leaves your seat pinned, so the body " +
                 "drifts off-axis from the deck; this eases the seat to square up - but ONLY while settled (gaze already " +
                 "down the board), which keeps it from feeding back into a spin. 0 = off (seat stays pinned until the stick moves it).")]
        public float seatFollowRate = 0f;
        [Tooltip("VR ONLY. Your view can swing this far (deg) from the seat before the seat follows. Within the cone the " +
                 "seat stays put (gaze keeps its hard turn-to-match stop); look past it and the seat drags after you so you " +
                 "can turn all the way around. Desktop never drags the seat. Set to 180 to disable.")]
        public float seatFreeAngle = 70f;
        // Headset-tested grounded stick comfort: carry one quarter of board turn into the upright VR seat/view. Air and
        // rail stick turns deliberately carry the view at full state rate.
        private const float VR_GROUND_STICK_VIEW_CARRY = 0.25f;
        [Tooltip("How far (deg) the rider's view may bank with the board on slopes, for feel. 0 = perfectly level (max " +
                 "comfort); 20 = a touch of lean. Stays level in the air.")]
        public float viewLeanMax = 20f;
        [Tooltip("DESKTOP GROUNDED view damper (s) - a smoothed chase-cam. The board still shudders authentically on " +
                 "ground turns, but the seat's follow of the heading + bank is low-passed so the VIEW eases. Air carries " +
                 "the board's full yaw delta and rails lock yaw to the board. ~0.1 absorbs ground shudder; 0 = rigid. VR is " +
                 "unaffected (its seat is pinned). See docs/vrchat/017.")]
        public float viewSmoothTime = 0.1f;
        // A travel-following first-person view (the retail THIRD-person camera's reference: velocity heading through a
        // measured ~0.7 s low-pass - see the ice-pingpong trace) was tried here and rejected: with no body in frame,
        // steering reads as doing nothing until the path bends, which is thoroughly disorienting. First person needs
        // the view coupled to the thing being steered, so the seat follows the BOARD heading - the two fields below
        // tune how much of the nose's whip the first-person view carries, live in play mode.
        [Tooltip("DESKTOP GROUNDED first-person: cap (deg/s) on how fast the VIEW may yaw after the board heading. The nose can " +
                 "snap 200-360 deg/s entering a hard carve while sustained carving bends the path at up to ~100 deg/s. " +
                 "80 rounds the whip off the view and lets it trail the very hardest ice carves slightly, catching up " +
                 "as the carve settles; 160 never lags a held carve. Air and rails bypass this cap and carry the board's " +
                 "full turn rate. 0 = uncapped. Chase cam and VR are unaffected.")]
        public float viewYawRateMax = 80f;
        [Tooltip("DESKTOP first-person: fraction of the board's heading LEAD over the travel direction the view carries. " +
                 "1 = the nose exactly (a deep ice drift holds up to ~28 deg of drift angle in view); 0 = the travel " +
                 "direction (tried and rejected - steering reads as doing nothing); the old comfort build shipped 0.25. " +
                 "Grounded only; the air view always follows the board. Chase cam is unaffected.")]
        [Range(0f, 1f)] public float viewBoardLead = 1f;
        [Header("Landing (touchdown orientation bands) [Trailmap: 340-jump-air-landing]")]
        [Tooltip("Arriving into-surface speed (m/s) of a fully 'hard' landing: the landing-thud volume ramps up to it, " +
                 "and with landBail on it is the wipeout threshold. The arriving speed itself is converted, not " +
                 "scrubbed - the contact pushout + redirect turn it into carried speed; only the two orientation bands " +
                 "cost a crooked landing speed.")]
        public float landHardImpact = 18f;
        [Tooltip("Wipe out (eject + respawn) on a landing ARRIVING harder than landHardImpact. Off by default - on for " +
                 "a punishing SSX-style bail. NOTE gravity ~19 m/s^2 means ~1 s of air arrives near 19 m/s into flat " +
                 "ground, so 18 bails clean big-air landings; raise it if you enable this.")]
        public bool landBail = false;
        [Tooltip("Deck-vs-surface TILT (deg) at/above which a REAL touchdown counts as a BAD LANDING for SCORING - the " +
                 "in-progress trick is wiped (a badly unfinished flip meeting the slope near-sideways). The SPEED cost " +
                 "of a crooked landing is the fixed touchdown bands (tilt free 15 deg -> x0.85 at 50; yaw free 25 deg " +
                 "-> x0.75 at 80), not this; this only gates the score wipe.")]
        public float landAlignBad = 90f;

        [Header("Held boost (the SSX 'Boost' control = Square; HOLD the LEFT TRIGGER in VR / RIGHT MOUSE on desktop)")]
        [Tooltip("Master toggle for hold-to-boost: a ground-only forward thrust (BOOST_ACCEL, gated by the narrow " +
                 "BOOST_LEAN_WINDOW) plus the top speed-cap tier (BOOST_MAX_SPEED) - the traced constants, not knobs " +
                 "[Trailmap: 360-speed-and-boost]. During a scored run the boost meter gates it. The right trigger " +
                 "still ollies.")]
        public bool holdBoostEnabled = true;
        [Tooltip("AIR BOOST: while AIRBORNE with boost held, thrust (m/s^2) toward where the boost HAND points (VR - " +
                 "the same LEFT hand squeezing the trigger; desktop aims by LOOK, having no tracked hand) - full 360, " +
                 "so aiming up stretches the air, aiming down dives you at the landing, aiming sideways reaches a " +
                 "rail while your eyes stay on it. The on-foot trigger-flight's point-to-fly aim (docs/vrchat/024) " +
                 "brought onto the deck, far weaker than its 30 m/s^2; the shared speed cap still clamps at the boost " +
                 "tier, so it shapes the arc rather than flying you. Meter-gated + drained like held boost during a " +
                 "scored run, and the boost sound plays while it fires. An embellishment - the engine's air states " +
                 "read no boost field, so 0 = off (engine-faithful: air boost only sustains the raised cap, silently).")]
        public float airBoostAccel = 8f;
        [Tooltip("AIR BOOST turn authority AT the speed cap (deg/s at a full-sideways aim). Pinned at the shared cap, " +
                 "plain thrust can't add speed - the clamp renormalizes |v| right back down, discarding exactly what " +
                 "was added - so there the SIDEWAYS part of the aim BENDS the velocity toward it at up to this rate " +
                 "instead (magnitude-preserving, so the clamp has nothing to eat), while an against-travel aim still " +
                 "brakes for the soft landing (the cap only bounds from above). Below the cap the plain airBoostAccel " +
                 "thrust runs as before; the two regimes cross-fade over the last ~2 m/s so there is no seam. This " +
                 "decouples turn authority from the accel: raw 8 m/s^2 thrust at the 33.5 m/s cap bends only ~14 deg/s. " +
                 "0/unset reads as the 40 default (the new-field gotcha on pre-knob boards); NEGATIVE = deliberately " +
                 "off (the old clamp-eaten at-cap behaviour).")]
        public float airBoostTurnRate = 40f;

        [Header("Wall riding (contact-normal grounding - ride up & STICK to walls / quarter-pipes) [Trailmap: 320-ground-contact]")]
        [Tooltip("Master toggle. ON: while grounded the board probes for the surface ALONG its cached contact normal " +
                 "(not just straight down) and measures 'on the ground' as the distance along that normal - so with " +
                 "enough speed you ride up a wall, bank or quarter-pipe and the carve momentum sticks you to it (the " +
                 "wall's contact push-back redirects your velocity = centripetal). This is the engine model: its contact " +
                 "probe is aimed by the previous frame's contact normal, and walls " +
                 "(SurfaceType 10/13/14) are ridable terrain, not obstacles. On flat ground the contact normal is ~up so " +
                 "this reduces to the old down-probe (with a down-fallback if the contact cast misses), so nothing " +
                 "regresses. OFF = the old down-only ride probe (walls un-rideable). Flip to A/B the feel.")]
        public bool wallRide = true;
        [Tooltip("OPT-IN wall crash (m/s). The engine wipes you out on the bounce/wall surfaces (type 6/10) when the " +
                 "into-wall contact speed exceeds a threshold; below it they contact normally " +
                 "[Trailmap: 310-surface-response]. The check runs after the grounded redirect, like the engine's. " +
                 "0 = OFF (default) because the goal here is to STICK to walls, not bail off them; raise it (e.g. ~20) " +
                 "for an SSX-style hard-slam bail when you hit a wall too flat/fast.")]
        public float wallCrashSpeed = 0f;

        [Header("Out-of-bounds reset (board-only; carry back ONTO the course - see docs/031)")]
        [Tooltip("During a TIMED RACE only (the run clock is running), on out-of-bounds (an SSX Reset (type 0) surface OR " +
                 "falling off the world) carry the rider back to a valid ON-TRACK position near where they left (facing " +
                 "down-track, stopped), instead of teleporting to the VRChat spawn. Free-riding is left alone - roam past " +
                 "Reset patches / off the edge freely (a genuine fall is still caught by the VRChat respawn height). " +
                 "Board-only: free-walking is unaffected. Off = no out-of-bounds handling at all.")]
        public bool resetToTrackOnOOB = true;
        [Tooltip("During a TIMED RACE only: also carry back a rider WEDGED on the level - shoved back by an object for " +
                 "about five consecutive ticks (the engine's bump integrator, [Trailmap: 395-reset-arm]), which is how " +
                 "SSX gets a rider out of a corner it can't ride out of. Riding ON a prop never counts (its contact " +
                 "normal is the board's own up) and terrain never counts, so a carve on a bank can't trip it. Off = a " +
                 "rider jammed against a fence stays there until they back out. Needs resetToTrackOnOOB on.")]
        public bool resetWhenWedged = true;
        [Tooltip("Crumb-trail length: how many recent on-track positions to remember. count * crumbSpacing is roughly " +
                 "how far back (m) a reset can reach.")]
        public int trailCrumbCount = 48;
        [Tooltip("World metres of valid grounded travel between trail crumbs. Smaller = finer trail (more memory).")]
        public float crumbSpacing = 3f;
        [Tooltip("On reset, drop the rider this far (m) back up the trail from where they went out, so they re-enter " +
                 "pointing down the track. 0 = right where they left.")]
        public float resetBackDistance = 6f;
        [Tooltip("How far (m) the reset may reach to find a point on the course path. Farther than this (or no course " +
                 "path) falls back to the breadcrumb trail. Generous so a fall off any edge still finds the course.")]
        public float courseResetMaxDist = 150f;
        // No void-fall / death-plane knobs, deliberately: the game has none, and no such inference is reliable (a rail over
        // water reads as a fall in every particular). Out-of-bounds is authored volumes you cross -> ResetZone.
        // TriggerReset: the game's MainType-13 boundaries, plus the importer's floor slab under the map. See docs/031.

        [Header("Rail grinding (snap onto the authored grind splines - see docs/026)")]
        [Tooltip("ON: crossing an authored rail aligned and fast enough locks you onto it and you grind, preserving speed; " +
                 "the ollie hops you off, Jump dismounts, running off the end keeps your speed. Forgiving (no balance/bail). " +
                 "Off = the rails are inert.")]
        public bool railGrindEnabled = true;
        [Tooltip("How close (world m) the board must come to a rail centerline to LOCK ON. Bigger = catches the rail from " +
                 "farther; too big and you snap to rails you only passed near.")]
        public float railSnapRadius = 0.7f;
        [Tooltip("Minimum board speed (m/s) to lock onto a rail.")]
        public float railMinSpeed = 3f;
        [Tooltip("How aligned travel must be with the rail to lock on: |dot| of horizontal velocity and rail tangent >= " +
                 "this (1 = dead-on, ~0.5 ~ within 60deg). You can grind in either direction.")]
        public float railAlign = 0.5f;
        [Tooltip("Ride height (world m) the deck sits ABOVE the rail centerline while grinding. Keep well under railStickRadius.")]
        public float railHeight = 0.12f;
        [Tooltip("Rail drag (1/s) bleeding along-rail speed. The game has NONE [Trailmap: 350-rails], so leave 0; >0 is a " +
                 "non-faithful scrub that can stall you on a long rail.")]
        public float railFriction = 0f;
        [Tooltip("Slope/gravity correction on the rail, as a fraction of the board's gravity (0..1). The faithful value is " +
                 "~0.516 (the rail applies a clean 9.8 m/s^2, half the air/ground 19): downhill speeds up, uphill bleeds. " +
                 "0 = constant-speed; 1 = the full shared falling gravity (too steep).")]
        [Range(0f, 1f)] public float railSlopeAccel = 0.516f;
        [Tooltip("Forward boost THRUST along the rail tangent (m/s^2) while holding boost - the game's real rail boost, " +
                 "which accelerates you UPHILL too. Separate from the speed cap; the boost cap tier (BOOST_MAX_SPEED) " +
                 "still limits the top end. 0 = none.")]
        public float railBoostAccel = 24.5f;
        [Tooltip("Fall off the rail when the along-rail speed drops below this (m/s).")]
        public float railMinExitSpeed = 1.5f;
        [Tooltip("Safety bail: leave the rail if the board strays farther than this (world m) from the line. Normally " +
                 "never trips (we force-snap each frame). Must be larger than railHeight.")]
        public float railStickRadius = 0.6f;
        [Tooltip("BRAKE on a rail: pull BACK on the stick to scrub along-rail speed (m/s^2) - an accessibility add (the " +
                 "game has no rail brake) to slow into a tight bend. Over-brake below railMinExitSpeed and you drop off. 0 = none.")]
        public float railBrakeStrength = 16f;
        [Tooltip("CURVE FLING: throw the rider off a rail taken too fast through a bend (a geometric stray, no balance " +
                 "meter). On = a tight curve at high speed launches you; off = rails only release on ollie / end / low-speed.")]
        public bool railFlingEnabled = false;
        [Tooltip("Max lateral (centripetal) accel (m/s^2) the rail holds before it FLINGS you. A fling needs BOTH a tight " +
                 "curve AND high speed. Higher = more forgiving (~50 = only genuinely tight bends at full tilt).")]
        public float railMaxLateralAccel = 50f;
        [Tooltip("Grace (s) after locking on during which the curve-fling can't fire - a sloppy landing settles instead.")]
        public float railGraceTime = 0.6f;
        [Tooltip("Transfer onto a CONNECTING rail at a junction instead of dropping off (the level's rails chain " +
                 "end-to-end at the poles). Off = every rail end drops you off.")]
        public bool railTransfer = true;
        [Tooltip("How close (world m) the next rail's endpoint must be to the junction to transfer onto it.")]
        public float railTransferRadius = 1.5f;
        [Tooltip("How forward the next rail must head to transfer onto it (1 = dead straight, ~0.4 ~ within 66deg) - loose " +
                 "enough for a powerline's sag kink, tight enough to not grab a crossing rail.")]
        public float railTransferMinDot = 0.4f;
        [Tooltip("LAUNCH speed (m/s) when you ollie OFF a rail - a fixed budget split between UP and your pointing heading " +
                 "(VR head / desktop stick). Facing forward the whole budget goes UP; turned across/back it splits ~half " +
                 "up / half along the heading so you peel off the line. The carried along-rail speed is kept on top.")]
        public float railOlliePush = 8f;
        [Tooltip("Looping AudioSource for the metal grind scrape (zboard slot 052). Built by RideableBoardSetup; null = " +
                 "no grind sound. The snow loops fade out while grinding.")]
        public AudioSource grindSource;
        [Tooltip("The grind loop clip (zboard RAIL group). Loaded by RideableBoardSetup.")]
        public AudioClip grindClip;
        [Range(0f, 1f)] public float grindVolume = 0.7f;
        [Tooltip("Spark ParticleSystem kicked off the rail while grinding. Built by RideableBoardSetup; null = no " +
                 "sparks. Gated by the snowParticles master toggle.")]
        public ParticleSystem sparks;
        [Tooltip("LATERAL accept tolerance (world m): how far to the SIDE of the rail line the BOARD CENTRE may sit and " +
                 "still grind. The game's snap/stay gate is an ANISOTROPIC box in the rail's local frame (NOT a sphere) - " +
                 "lateral is the tight axis (~0.30 m steady [Trailmap: 350-rails]; we run a touch looser for the VR deck). Lock-on uses " +
                 "0.9x this; the first railGraceTime widens it (see railDeckReach) so a sloppy landing settles before it " +
                 "tightens. See docs/026.")]
        public float railLatTolerance = 0.45f;
        [Tooltip("VERTICAL accept tolerance (world m): how far ABOVE/BELOW the rail line the board centre may be (~0.72 m, " +
                 "fixed [Trailmap: 350-rails]). Separate from lateral so a landing that's a bit high AND a bit to the side still catches " +
                 "- an isotropic sphere wrongly rejects that diagonal case (it conflates the two axes).")]
        public float railVertTolerance = 0.7f;
        [Tooltip("ALONG-RAIL accept tolerance (world m): slop past a rail end before the closest point clamps you off " +
                 "(~0.80 m) [Trailmap: 350-rails]. Mostly matters near endpoints; an interior closest point sits ~0 along.")]
        public float railAlongTolerance = 0.8f;
        [Tooltip("GEOMETRY-AWARE catch reach (world m): lock-on also probes this far along the DECK (nose + tail), so a " +
                 "rail near the END of the board catches even when the CENTRE is past the lateral tolerance - then the " +
                 "smooth attach reels the body onto the line. Capped to the deck half-length. The game catches on the rider " +
                 "point only; this is a deliberate VR add for the long visible deck. 0 = centre-only (game-faithful).")]
        public float railDeckReach = 0.8f;
        [Tooltip("SMOOTH ATTACH time constant (s): once locked on, the board eases its lateral/vertical gap onto the rail " +
                 "line over ~this (the game's gradual attach, not an instant teleport), while advancing along the rail at " +
                 "full speed. Smaller = snappier; 0 = instant snap (old behaviour). ~0.12 settles within the grace window.")]
        public float railAttachTau = 0.12f;
        [Tooltip("VELOCITY-ALIGN slew (deg/s): how fast the carried velocity rotates onto the rail tangent after lock-on, " +
                 "KEEPING its magnitude (the game's magnitude-preserving rail slew) - a sideways/sloppy catch converts its " +
                 "speed into along-rail speed instead of losing the off-tangent part. Higher = aligns quicker.")]
        public float railVelSlew = 540f;
        [Tooltip("RE-LOCK lockout (s) after leaving a rail, so an ollie/jump-off clears it before you can re-grab. Paired " +
                 "with the tight (non-grace) entry box + popping UP out of the vertical tolerance, this is what lets you " +
                 "jump OFF in a direction without snapping back on.")]
        public float railRelockCooldown = 0.35f;

        [Header("Obstacle collision (props / walls)")]
        [Tooltip("Collide-and-slide off solid props (stands, signage) and walls like the walking player does, instead of " +
                 "passing through them. Off = the old pass-through. See docs/vrchat/017 (collide-and-slide).")]
        public bool collideWithProps = true;
        [Tooltip("Fallback restitution off an obstacle with no PropBounce metadata (terrain walls, hand-placed colliders). " +
                 "0 = stop-and-slide for this generic/manual fallback; response-enabled native props use their authored " +
                 "PlayerBounceAmmount (x obstacleBounceScale) instead.")]
        public float obstacleBounce = 0f;
        [Tooltip("Scale on a response-enabled prop's authored PlayerBounceAmmount. 1 applies the authored amount literally; " +
                 "set 0 to suppress its restitution term while retaining the native minimum eject.")]
        public float obstacleBounceScale = 1f;
        [Tooltip("A swept hit counts as a WALL (not ridable ground) when its normal.y < this. 0.5 ~ surfaces steeper than " +
                 "~60deg block you; shallower you ride over. This lets terrain WALLS (Surf_10/13/14) block without " +
                 "excluding the whole terrain set.")]
        public float wallNormalMax = 0.5f;
        [Tooltip("Contact skin (m) kept between the rider and an obstacle so the sweep doesn't jitter against it.")]
        public float obstacleSkin = 0.05f;
        [Tooltip("How far (m) to raise the OBSTACLE-SWEEP capsule's BOTTOM above the deck - the 'collide with the upper " +
                 "body' trick. The collide-and-slide capsule rides the coarse FACETED collider; in a concave dip the deck " +
                 "rides the true (lower) surface, so a foot-level capsule would embed in the facet and jam the sweep " +
                 "(the old 'stuck'). Lifting the sweep's bottom to ~torso height lets the deck + legs ride down into the " +
                 "real dip while the upper body still collides with walls/props - so you feel the true dips like you feel " +
                 "the bumps. This sizes the analytic sink allowance (SinkAllowance); the deck may ride this much " +
                 "below the facet before the contact clamps. Walls/quarter-pipes are unaffected (the contact " +
                 "probe rides them, not the sweep). TRADEOFF: low standalone solid props below this height aren't collided " +
                 "(walls + tall props still are; triggers/pickups use the full-height probe, unaffected). 0 = old foot-" +
                 "level sweep (concave dips clamp at the facet). Probe reach comes from the shared contract.")]
        public float sweepFootClearance = 0.6f;
        [Tooltip("The rider's BODY SPHERE, which is what a native mode-2 bounding box is met by - not the probe " +
                 "capsule [Trailmap: 370-probe-modes]. The radius is measured off the engine (0.85 m, read two " +
                 "ways off a paused session); the height is where the engine poses it, at the pelvis. It is a " +
                 "coarse ball around the whole rider, so it reaches from just above the deck to over the head. " +
                 "Mode-1 proxies and mode-3 bodies keep the capsule, which stands in for the engine's 0.1-0.3 m " +
                  "limb spheres. Radius 0 turns the split off and gives boxes back to the capsule.")]
        public float bodySphereRadius = 0.85f;
        public float bodySphereHeight = 0.92f;
        [Tooltip("Enable the mode-2 body-sphere collision pass. ON is the shipping behaviour; disable only as an " +
                 "inspector/code fallback. OFF skips that SphereCast while retaining capsule collide-and-slide.")]
        public bool bodySphereCollision = true;

        [Header("Avatar fit (scale the VISIBLE deck + collider to the rider - physics stays absolute)")]
        [Tooltip("Scale the board to the rider's avatar (by eye height) so a tall avatar doesn't ride a toy deck and a " +
                 "tiny one doesn't get a surfboard. The hand-integrated physics reads no transform scale, so speed/handling " +
                 "are identical for everyone - only the deck's look + footprint change. Off = every rider gets the authored deck.")]
        public bool fitBoardToAvatar = true;
        [Tooltip("Avatar eye height (m) that maps to board scale 1.0 (the authored deck size). ~1.6 = a typical adult. No " +
                 "min/max clamp - VRChat already bounds eye height, so the scale stays sane on its own.")]
        public float referenceEyeHeight = 1.6f;

        [Header("Sound (board glide/carve loops + ollie/land one-shots - local rider only)")]
        [Tooltip("Looping source for the GLIDE layer (the board on the snow); volume/pitch ride speed, clip swaps per " +
                 "surface group. Built by RideableBoardSetup. Null = no sound.")]
        public AudioSource glideSource;
        [Tooltip("Looping source for the CARVE layer (the edge bite when you lean), layered over glide; volume rides lean + slip.")]
        public AudioSource carveSource;
        [Tooltip("One-shot source for the ollie pop and the landing thud (PlayOneShot).")]
        public AudioSource eventSource;
        [Tooltip("Dedicated LOOPING source for the held-boost sound, driven by a volume envelope: PUNCH to full on engage, " +
                 "quick drop to a low SUSTAIN while held, fast FADE on release. (The game's clip is a flat roar, so the " +
                 "fade you hear is shaped here.) Built by RideableBoardSetup. Null = no boost sound.")]
        public AudioSource boostSource;
        [Tooltip("Focused-rider big-air wind source (MAIN bank zbxsfx slot 032). This is started only when the " +
                 "takeoff landing predictor finds a flight longer than 1.5 seconds; it is not map ambience.")]
        public AudioSource bigAirWindSource;
        [Tooltip("The shared MAIN-bank big-air wind loop (zbxsfx slot 032). Built by RideableBoardSetup.")]
        public AudioClip bigAirWindClip;
        [Tooltip("Big-air wind level, scaled by soundVolume. The recovered gate/clip are retail; this trim remains tunable.")]
        [Range(0f, 1f)] public float bigAirWindVolume = 0.7f;
        [Tooltip("Predicted total flight duration required to start MAIN/032. Retail compares strictly greater than 1.5 s.")]
        public float bigAirWindMinSeconds = 1.5f;
        [Tooltip("GLIDE loop clips by board-snow audio group: [0]=PACK [1]=POWDER [2]=ICE [3]=ROCK/wall [4]=CHUTE(ramp) " +
                 "[5]=WOOD(bridge planks). The surface under the board picks the index (AudioGroupFor). First-guess clips - retune by ear.")]
        public AudioClip[] glideClips;
        [Tooltip("CARVE loop clips, same group order as glideClips.")]
        public AudioClip[] carveClips;
        [Tooltip("Played once when you pop an ollie (louder the longer you charged).")]
        public AudioClip ollieClip;
        [Tooltip("Played once on touchdown from the air (louder with impact speed).")]
        public AudioClip landClip;
        [Tooltip("Master volume for ALL board sound. 0 = silent.")]
        [Range(0f, 1f)] public float soundVolume = 0.8f;
        [Tooltip("Speed (m/s) at which the glide sound begins to fade up from silence.")]
        public float glideMinSpeed = 1.5f;
        [Tooltip("Speed (m/s) at which the glide sound reaches full volume / top pitch.")]
        public float glideFullSpeed = 18f;
        [Tooltip("Max volume of the glide layer (then scaled by soundVolume).")]
        [Range(0f, 1f)] public float glideVolume = 0.7f;
        [Tooltip("Max volume of the carve layer (then scaled by soundVolume).")]
        [Range(0f, 1f)] public float carveVolume = 0.8f;
        [Tooltip("Glide pitch at low speed (rises toward glidePitchMax with speed).")]
        public float glidePitchMin = 0.8f;
        [Tooltip("Glide pitch at glideFullSpeed and above.")]
        public float glidePitchMax = 1.5f;
        [Tooltip("How fast (volume units/s) the loop volumes ease toward their target, so transitions fade instead of clicking.")]
        public float soundFade = 6f;
        [Tooltip("Boost-engage WHOOSH clips - the SSX held-boost 'Boost' sound (global MAIN bank zbxsfx, slots 120/121/122). " +
                 "The game plays one the instant held boost engages, at the rider, picked by the BOOST/Tricky-meter level: " +
                 "[0]=full(>0.666 -> slot 120) [1]=mid(>0.334 -> slot 121) [2]=low(-> slot 122) - the whoosh gets meatier the " +
                 "more meter you spend ([Trailmap: 420-audio-runtime]). We have no Tricky meter " +
                 "and boost without limit, which is exactly the game's uber-tier 'infinite boost' (meter pinned to 1.0), so " +
                 "boostMeter01 defaults to full and clip [0] plays. Built by RideableBoardSetup; null/empty = silent boost. " +
                 "Played as a volume-enveloped LOOP on boostSource (punch on engage, low sustain while held, fade on release).")]
        public AudioClip[] boostClips;
        [Tooltip("PEAK volume of the boost sound - the engage punch (then scaled by soundVolume).")]
        [Range(0f, 1f)] public float boostVolume = 0.9f;
        [Tooltip("Sustained boost-loop volume WHILE HELD, as a fraction of boostVolume, after the initial punch decays. " +
                 "0 = no sustain (a whoosh that fades even while held); ~0.5 = a clear roar stays under the held boost.")]
        [Range(0f, 1f)] public float boostSustainFrac = 0.5f;
        [Tooltip("Seconds the boost sound holds at PEAK (the punch) on engage before decaying to the sustain. Longer = a " +
                 "bigger burst while you hold.")]
        public float boostPunchSeconds = 0.6f;
        [Tooltip("How smoothly the boost sound FADES (volume units/s) on the way DOWN - the release fade-out and the " +
                 "post-punch decay to sustain. Lower = smoother / more gradual. The engage attack stays fast (punchy) on soundFade.")]
        public float boostFadeRate = 2.5f;
        [Tooltip("Stand-in for the rider's BOOST/Tricky meter (0..1) that picks which boostClips variant the whoosh uses " +
                 "(>0.666 -> [0], >0.334 -> [1], else [2]) - the game's exact thresholds. There's no real meter here " +
                 "(unlimited boost == the game's meter-pinned-to-1.0 infinite boost), so this stays at 1.0 = the full-meter " +
                 "whoosh. Lower it to bias toward the lighter variants.")]
        [Range(0f, 1f)] public float boostMeter01 = 1f;

        [Header("Snow spray — 2 systems distilled from the game's 5 [Trailmap: 380-carve-effects]. Local + remote riders.")]
        [Tooltip("Master toggle for the board snow FX. Off = no spray (sound + physics unaffected).")]
        public bool snowParticles = true;
        // Two additive particle systems (built by RideableBoardSetup, BoardFX node) distilled from the game's five
        // - the two the player can actually tell apart. The SURFACE SPRAY is the 40-slot ring: a real spawn VELOCITY
        // (the rooster-tail thrown out the leaned edge), per-surface sprite/size/alpha, + the landing burst. The CLOUD is one
        // soft additive system standing in for the sys1/sys2 carve veil AND the sys5 powder cloud (age-only ACCUMULATION of
        // soft puffs laid along the path). Game units are /100 = metres here.
        [Tooltip("40-slot SURFACE SPRAY - the main carve fan. Per-surface sprite/size/life/alpha; emit probability ~ " +
                 "speed*(1+149*lean^2), so straight running is a trickle and a hard carve saturates at 60/s. Particles are " +
                 "THROWN up out of the snow (~36 deg back-tilt, toward the carve edge) and carry that velocity for life.")]
        public ParticleSystem surfaceSpray;
        [Tooltip("Surface-spray materials by surface class: 0 snow 'blb1' (snow chunk), 1 off-track 'swp2' (soft puff), " +
                 "2 powder 'str3' (4-point twinkle), 3 ice 'cnf2' (crystal shard) - the surface record's spray sprite in " +
                 "name-table order [Trailmap: 380-carve-effects]. Wired by RideableBoardSetup.")]
        public Material[] surfSprayMats;
        [Tooltip("The surface-spray ParticleSystemRenderer (material swapped per surface class). Wired by setup; " +
                 "auto-fetched from surfaceSpray if empty.")]
        public ParticleSystemRenderer surfSprayRenderer;
        [Tooltip("Soft additive CLOUD - one system standing in for four engine rings: the sys1/sys2 carve VEIL on snow/off-track " +
                 "(not ice) while carving, AND the sys5 dense powder cloud on powder (SurfaceType 3/4). Frozen soft puffs that " +
                 "accumulate along the path (powder puffs anchor to the board); box-scattered so the runtime batch-Emits them.")]
        public ParticleSystem cloud;
        [Tooltip("Speed (m/s) below which the board throws no spray. Spray ramps up from here to glideFullSpeed.")]
        public float sprayMinSpeed = 3f;
        [Tooltip("Extra distance behind the board centre (m) the plume/streak systems spawn. The game anchors the spray AT " +
                 "the boarder contact position (live-checked), so this defaults to 0; raise it to taste.")]
        public float sprayBackOffset = 0f;
        [Tooltip("Global additive-BRIGHTNESS multiplier for ALL board spray (fan + cloud). 1 = the tuned values; >1 brightens " +
                 "(scales the emit RGB so additive punch can exceed alpha=1), <1 dims. Read per-emit - runtime, no rebuild to retune.")]
        public float sprayBrightness = 1.5f;

        [Tooltip("Surface spray: scale on the per-surface emit probability (1 = the game's table rates).")]
        public float surfEmitScale = 1f;
        [Tooltip("Surface spray: scale on the per-surface additive alpha (1 = the game's table alphas).")]
        public float surfAlphaScale = 1f;
        [Tooltip("Surface spray: throw tilt from the contact normal toward -travel. Live capture measured ~0.72 " +
                 "(=36 deg back) on a hard carve - the fan erupts up-and-back out of the snow.")]
        public float surfBackTilt = 0.72f;
        [Tooltip("Surface spray: throw tilt toward the carve (leaned/digging) edge, scaled by lean. Live capture measured " +
                 "~0.16 at full lean. Negative flips it to the outside of the turn.")]
        public float surfSideTilt = 0.16f;
        [Tooltip("Surface spray: touchdown burst - the game seeds the emit motion-scalar to 70 (speed-scaled), decaying " +
                 "x0.9467/tick to a ~10 floor over ~0.6 s, so a landing dusts with the surface's own spray. 0 = off.")]
        public float surfLandingSeed = 70f;

        [Tooltip("Cloud VEIL: minimum |lean| to throw the carve veil on snow/off-track, NOT ice (sys2's veil gate is ~0 on ice; ice throws only the fan's cnf2 specks).")]
        public float cloudVeilGate = 0.2f;
        [Tooltip("Cloud VEIL: soft puffs per 60Hz tick while carving - the accumulated veil density (sys1+sys2 rolled together).")]
        public float cloudVeilRate = 2f;
        [Tooltip("Cloud VEIL: start size (m) of a carve-veil puff; the size curve billows it open as it ages (sys1 grew 0.8->4 m).")]
        public float cloudVeilSize = 1.2f;
        [Tooltip("Cloud VEIL: additive alpha of a veil puff at a full carve (peak = |lean| * this; the game's |lean|*0.2).")]
        public float cloudVeilAlpha = 0.2f;

        [Tooltip("Cloud POWDER: speed (m/s) per EXTRA powder puff per frame - the game's speed/12.7 m/s. Lower = denser.")]
        public float powderSpeedPerPuff = 12.7f;
        [Tooltip("Cloud POWDER: start size (m) of a powder puff - live-measured ~0.45 m drawn on SurfaceType 3 (the sys5 cloud).")]
        public float cloudPowderSize = 0.45f;
        [Tooltip("Cloud POWDER: additive alpha of a powder puff (the game's 0.17); overlapping puffs make the soft deep-snow cloud.")]
        public float powderPuffAlpha = 0.17f;
        [Tooltip("Cloud POWDER: backward creep (m/s) of the cloud relative to the board (the game's -200 u/s = 2 m/s); the cloud " +
                 "ANCHORS to the board and hangs just off the tail; 0 = rigidly stuck to the board.")]
        public float powderDrift = 2f;

        [Tooltip("Cloud: hard cap on puffs emitted per frame (particle-budget guard on a fast schuss / frame hitch).")]
        public int cloudMaxPerFrame = 4;
        [Tooltip("SSX SurfaceType counted as DEEP/POWDERED snow - the surface that throws the big powder spray (type 3). " +
                 "Standard snow (1) sprays at the base rate; the surfaces the game leaves at emit_rate 0 throw nothing.")]
        public int powderSurfaceType = 3;
        [Tooltip("Ride SOLID PROP surfaces too, not just the terrain (Surf_*). SSX prop bridges/ramps have their walkable " +
                 "surface as a separate invisible PINNED collision proxy (e.g. Mesa's bridgesurface), which the importer " +
                 "bakes into the PropsCollision_* buckets - NOT into the terrain set. The real SSX boarder contacts ANY " +
                 "solid surface, so with this on the board's down-probe also rides those proxies (you cross the bridge " +
                 "instead of falling through). The AABB sign/billboard boxes, foliage triggers and knockable crash bags " +
                 "are still skipped. Off = the old terrain-only behaviour. See docs/vrchat/035.")]
        public bool rideSolidProps = true;
        [Tooltip("SurfaceType the board reports while riding a PROP surface (rideSolidProps). Set to -1: the SSX " +
                 "engine's world-contact result gives extracted props SurfaceType == -1 and routes them through object / " +
                 "collision-mode handling, NOT the terrain material table (which is indexed SurfaceType*100, so -1 can't " +
                 "index it - see docs/vrchat/035 [Trailmap: 320-ground-contact]). -1 is therefore faithful: the board's feel funcs " +
                 "hit their firm DEFAULT case (normal friction/grip + snow-speed cruise), and -1 is outside the snow set so a " +
                 "wood bridge gets NO snow spray and NO snow-sink spring (the board's own OOB code already calls -1 'prop'). " +
                 "Avoid wall types 10/13/14/18 (they EJECT) and 0 (OOB Reset). Override only to deliberately give a prop a " +
                 "terrain material's feel (e.g. an icy ramp = 5).")]
        public int propRideSurfaceType = -1;

        [Header("Wake trail (the carved ribbon left in the snow - see RideableBoard.Wake.cs / docs/vrchat/030)")]
        [Tooltip("MeshFilter of the 'Wake' child the board rebuilds a procedural ribbon mesh into each frame. Built by " +
                 "RideableBoardSetup; auto-found by name if empty. Null = no wake.")]
        public MeshFilter wakeMeshFilter;
        [Tooltip("MeshRenderer of the same 'Wake' child (drawn with OpenSlope/WakeRibbon). Auto-found.")]
        public MeshRenderer wakeMeshRenderer;
        [Tooltip("Master on/off for the wake ribbon (independent of the snowParticles spray toggle).")]
        public bool trailEnabled = true;

        [Header("Remote rider FX (wake + spray on boards ridden by OTHER players - distance-LOD'd for perf)")]
        [Tooltip("How close (world m) a board ridden by another player must be for its SPRAY to run on your client. Beyond " +
                 "this the remote FX stop + clear (freeing the particle budget), so cost scales with VISIBLE riders near " +
                 "you, not the instance size. Reuses snowParticles/trailEnabled as the on switches. 0 -> a safe 45 m default " +
                 "(so an un-repushed board still shows remote FX - see the new-field-default note).")]
        public float remoteFxRange = 45f;
        [Tooltip("How close (world m) a remote rider must be for its WAKE RIBBON (the per-frame procedural mesh - the most " +
                 "expensive part) to rebuild; out of this range any existing ribbon just ages out. The real cost guard is " +
                 "NOT this range but the carve gate + the idle/off-snow early-outs upstream - only a rider actively CARVING " +
                 "on snow near you rebuilds a full mesh (a parked or straight-cruising board costs ~nothing), so this can " +
                 "sit at the spray range. Lower it if a big carving pack costs too much. 0 -> a safe 45 m default.")]
        public float remoteWakeRange = 45f;
        [Tooltip("Seconds between the LOCAL ground probe a remote board casts to read its surface type/normal for the FX. " +
                 "The surface changes slowly vs the frame rate, so this is throttled rather than cast every frame. 0 -> 0.1 s.")]
        public float remoteProbeInterval = 0.1f;
        [Tooltip("Speed (m/s) below which the board leaves no wake. Kept LOW so the wake is there whenever you're moving on " +
                 "snow (the wake shows on a straight cruise, not only in turns).")]
        public float trailMinSpeed = 1.0f;
        [Tooltip("The board's WIDTH (m) - the wake width riding straight (the spacing of the deck's two edges).")]
        public float trailWidthMin = 0.40f;
        [Tooltip("The board's LENGTH (m) - the wake width when the deck faces fully SIDEWAYS. The trail width interpolates " +
                 "between trailWidthMin and this by the deck-vs-travel angle, so carving across the fall line widens it.")]
        public float trailWidthMax = 1.35f;
        [Tooltip("How far behind the board (m) the ribbon's newest cross-section is laid. 0 = right under the board. Raise " +
                 "to start the ribbon further back (trail from the tail).")]
        public float trailTailOffset = 0f;
        [Tooltip("Height (m) the ribbon sits above the ground - just enough to avoid z-fighting the snow.")]
        public float trailHeight = 0.03f;
        [Tooltip("Base darkening of BOTH groove walls (0..1), present at any carve angle. The wake MODULATES the actual " +
                 "snow (overlay blend) so it auto-matches shade. Keep SMALL relative to wakeSunSplit or the sun-facing wall " +
                 "can't lighten.")]
        public float wakeDarken = 0.06f;
        [Tooltip("Sun-driven light/dark SPLIT of the two groove walls (0..1), maxed riding PERPENDICULAR to the sun: the " +
                 "sun-facing wall reads lighter, the away wall darker, and the split swings as you carve. Must exceed " +
                 "wakeDarken for the sun wall to brighten; 0 = both walls just darken.")]
        public float wakeSunSplit = 0.30f;
        [Tooltip("How far above the snow (m) the board can be and still carve a wake. Uses a lenient height reach (not the " +
                 "strict physics 'grounded' band, which flickers as the board hops bumps), so a board skimming bumps keeps " +
                 "a continuous track. Raise if the wake still gaps on rough terrain; lower for near-contact only.")]
        public float wakeGroundReach = 0.9f;
        [Tooltip("Distance (m) the board must JUMP since the last cross-section before the ribbon restarts (breaks). Above " +
                 "one frame's travel so a brief gate flicker keeps a continuous ribbon, while a real jump starts a fresh trail.")]
        public float wakeRestartGap = 2.0f;
        [Tooltip("Wake lifetime (s) - how long a laid cross-section lingers before it fully fades + drops (0.9 is game-accurate).")]
        public float wakeLife = 0.9f;
        [Tooltip("Distance (m) between laid wake cross-sections. Smaller = smoother ribbon + more verts; larger = coarser. " +
                 "The ring holds a fixed count, so this also sets the max ribbon length.")]
        public float wakePointSpacing = 0.28f;
        [Tooltip("Per-surface wake WIDTH (game-faithful). The engine's groove width is a per-surface constant (packed snow " +
                 "thin, powder ~2.4x wider, ice/rock/ramp ~none); ON multiplies the deck-footprint width by that per-surface " +
                 "factor (WakeSurfaceWidth) so a powder carve plows a visibly wider groove than a snow slice. OFF = " +
                 "footprint width only (old behaviour).")]
        public bool wakePerSurfaceWidth = true;

        [Header("Chase-view seat (TESTING - pseudo third-person to watch the board + wake)")]
        [Tooltip("TESTING toggle. ON = the station seats the rider UP + BEHIND the board so you can see the wake while " +
                 "riding; OFF = the normal first-person seat. The board's physics origin is never moved, so handling is " +
                 "identical. Best on DESKTOP (in VR the offset seat swings on an arc as the board yaws). Needs a 'SeatPoint' " +
                 "child (built by the setup); apply by (re)mounting after you flip it.")]
        public bool chaseCamSeat = false;
        [Tooltip("Chase seat height above the board (m), when chaseCamSeat is on.")]
        public float chaseSeatUp = 1.8f;
        [Tooltip("Chase seat distance behind the board (m, opposite travel), when chaseCamSeat is on.")]
        public float chaseSeatBack = 3.0f;

        // ---- Runtime state (grouped; glossary in docs/vrchat/017) -----------------------------------------------
        private Collider[] _colliders; // cached terrain surface colliders (same source as SurfaceDetector)
        private int[] _types;          // parallel SSX SurfaceType per collider
        private int[][] _meshTris;     // parallel: each collider's mesh triangle indices (triangleIndex -> its 3 verts)
        private Vector3[][] _meshNorms;// parallel: each collider's baked smooth (analytic Bezier) vertex normals
        private Collider _ownCollider; // the board's own box - must be skipped by the ground ray (else it climbs itself)
        private BoxCollider _box;      // same box as _ownCollider; its size is scaled to the rider's avatar (fitBoardToAvatar)
        private Vector3 _baseBoxSize;  // the authored collider size, captured at Start so the avatar-fit scales from it
        private float _riderScale = 1f;// current avatar-fit scale; 1 = authored. Sizes the wake to the resized deck
        private CapsuleCollider _probeCol; // the RiderProbe capsule; its dims drive the obstacle sweep (and it's skipped by it)
        private float _capRadius;      // swept-capsule radius, read from _probeCol (0 = no probe -> obstacle collision off)
        private float _capLow, _capHigh; // the two capsule sphere-center heights above the board origin
        private RaycastHit[] _hitBuf = new RaycastHit[64]; // reused buffer for the per-frame *NonAlloc casts -> no GC (extras beyond 64 dropped)
        // Colliders the obstacle sweep found itself already inside this frame, for Depenetrate. Four is ample:
        // an overlap is the exceptional case, not the per-frame one.
        private Collider[] _embedded = new Collider[4];
        // The importer parents every mode-2 bounding box directly under one "PropsBoundsCollision" root, so a
        // parent-reference compare tells them apart with no per-hit GetComponent (the allocating scan in Udon).
        private Transform _boundsRoot;
        private bool _boundsRootSearched;
        // The importer's prop collision roots, found once. Depenetration is a PROP response, so this is what
        // keeps terrain out of the embedded list - see OwnedByProps.
        private Transform[] _propRoots;
        private bool _propRootsSearched;
        // Prop impact-sound tuning (private = baked, not inspector-tunable). Volume ramps from
        // _impactMinSpeed (silent below) to _impactMaxSpeed (full); debounced per prop.
        private float _impactMinSpeed = 2f;
        private float _impactMaxSpeed = 16f;
        private float _impactVolume   = 1f;
        private float _impactDebounce = 0.6f; // min seconds before the SAME prop re-triggers (game uses ~0.83s)
        private Collider _lastImpactCol;
        private float _lastImpactTime;
        // Foliage swish-through sound tuning (tree leaves -> 050, bushy -> 051; see CheckFoliageSwish + docs/009).
        private float _swishMinSpeed = 3f;
        private float _swishMaxSpeed = 22f;
        private float _swishVolume   = 0.9f;
        private float _swishDebounce = 0.5f;  // min seconds between swishes (one per leaf cloud you pass through)
        private float _lastSwishTime;
        private Transform _foliageRoot;       // OpenSlope_Map/PropsFoliage; auto-found in Start (null = no swish-through foliage)
        private int _foliageMask = ~0;        // layermask narrowed to the leaf boxes' own layer in Start, so the swish cast returns only foliage
        private VRCPlayerApi _player;
        private PlayerFlight _flight; // free-standing trigger-flight controller (auto-found); suppressed while riding
        private bool _riding;
        // ---- Networking (docs/vrchat/042) ----
        [UdonSynced] private Vector3 _netPos;     // owner's sampled position, sent on the fixed-interval RequestSerialization
        [UdonSynced] private Quaternion _netRot;  // owner's sampled rotation
        [UdonSynced] private Vector3 _netVel;     // owner's world velocity at the sample, so remotes DEAD-RECKON between packets
        [UdonSynced] private double _netSendTime;  // SERVER time the sample was taken -> remotes know each packet's EXACT age (ping-corrected)
        // Avatar-fit deck SIZE is STATE, not motion: the rider's FitToRider scale, so remotes (and late joiners) see the
        // board at the same size the rider does instead of the authored default. Set ONLY when it changes (mount-fit /
        // avatar-resize / dismount-reset) and pushed with an explicit RequestSerialization there - it doesn't need the
        // continuous pose stream. It still rides along in routine pose packets for free (a persisted synced field), which
        // is purely a bonus for late joiners. Defaults 1; a stale 0 on an un-repushed board is floored to 1 on apply.
        [UdonSynced] private float _netScale = 1f;
        private float _appliedScale = 1f;         // remote-side: last scale we applied, so we don't touch the collider every packet
        private bool _netInit;                    // a remote has received at least one packet
        // The VISIBLE deck pose is decoupled from the synced seat/root: the owner writes the carve facing + bank + pitch
        // ONLY on the Heading pivot (the visual block, ~line 1463), and in VR the seat/root we sync is pinned LEVEL - so
        // syncing the root alone leaves a remote viewer watching a flat, non-banking board. We sync the pivot's rotation
        // RELATIVE to the root (mode-agnostic: it captures the snowboard's bank or the skis' heading) plus the roll angle
        // so the ski case can re-edge each ski. Both ride along in the routine pose packet (manual sync bundles them). 042.
        [UdonSynced] private Quaternion _netDeckLocal; // visible deck rotation in the root's local frame (zero/invalid until first push)
        [UdonSynced] private float _netBank;           // visible deck-roll angle (deg) - lets remotes re-roll the ski pivots
        // Teleport signal: the owner bumps this on every GENUINE teleport (gate re-dispense, OOB reset, lap loop-back) so a
        // remote SNAPS straight onto the new pose instead of SmoothDamp-sliding toward it. A gate dispense moves a pooled
        // board only a few metres (from the pool's build pose at the gate centre to its post), well UNDER netRemoteSnap, so
        // the distance test in NetFollow alone would chase (slide) it across the gate - the "new board slides in" bug. 042.
        [UdonSynced] private int _netTeleport;
        private int _appliedTeleport;    // remote: the last _netTeleport we acted on; a change means a teleport landed -> snap
        private bool _snapPending;       // remote: a teleport arrived this packet; NetFollow cuts to the synced pose next frame
        // Remote rider FX (wake + spray for a board ridden by ANOTHER player; RideableBoard.Fx.cs RemoteFxUpdate).
        private bool _remoteFxActive;    // remote: in range + FX systems running (Playing). Drives the wake carve gate too.
        private Vector3 _fxLastPos;      // remote: last frame's position, to derive the rendered-motion velocity for the FX
        private bool _fxHavePos;         // remote: _fxLastPos is valid (skip the first-frame velocity spike)
        private float _fxProbeTimer;     // remote: countdown to the next throttled ground probe
        private bool _fxProbedOnce;      // remote: we've probed at least once since entering range
        private Quaternion _deckLocalSm; // remote: smoothed deck-local rotation (it arrives at the packet rate; slerped per frame)
        private float _bankSm;           // remote: smoothed deck-roll angle for the ski re-edge
        private bool _deckSmValid;       // remote: _deckLocalSm holds a real value (snap the first apply, don't slerp from zero)
        private double _prevSendTime;             // previous packet's _netSendTime, for the (regular, server-timed) accel interval
        private Vector3 _smoothVel;               // SmoothDamp velocity state for the remote position chase (the continuous internal velocity)
        private Vector3 _prevNetVel;              // previous packet's velocity, to reconstruct acceleration on the remote
        private Vector3 _netAccel;                // reconstructed owner acceleration (m/s^2, low-passed), for curve-aware extrapolation
        private Quaternion _prevNetRot;           // previous packet's rotation, to reconstruct angular velocity on the remote
        private Quaternion _rotDelta;             // the rotation change over one interval (= angular velocity), low-passed
        private float _rotInterval = 0.1f;        // server-time span of _rotDelta, for the rotation extrapolation fraction
        private bool _rotValid;                   // _rotDelta has been computed (>= 2 packets) - else don't extrapolate rotation
        private double _nextSendTime;             // owner: next SERVER time to RequestSerialization (the fixed-interval send timer)
        private double _serverClock;              // smooth, drift-corrected estimate of server time (ServerNow); eased not snapped = no jumps
        private int _clockFrame;                  // last frame _serverClock advanced (advance once per frame even if ServerNow called twice)
        private bool _clockSet;
        private bool _pendingMount;               // we requested ownership on Interact and are waiting to seat on OnOwnershipTransferred
        private float _pendingMountTime;          // when the request went out (netMountTimeout abandons a request that never lands)
        private bool _asleep;                     // parked & settled: skip Update + pose-publish until a mount/dispense wakes us (sleepWhenParked)
        private float _parkTimer;                 // seconds fully parked, counting toward sleepDelay before we sleep
        private Vector3 _vel;          // world-space velocity we integrate
        private Vector3 _fwd;          // board heading (unit); yawed around the contact normal while grounded
        private Vector3 _boardUp;      // visual up (unit); blends toward the contact normal with a rate limit
        private Vector3 _contactN;     // physics contact normal: exact analytic directly, faceted fallback low-passed
        private Transform _pivot;      // "Heading" child carrying the visible board's facing/bank (decoupled from the seat)
        [HideInInspector] public Transform DeckPivot; // public mirror of _pivot - the VISIBLE deck pose (facing + bank + flip, already lifted). Read by RunHud so the run readout rides flat on the deck and banks/flips with it. null on an old / seat-locked board.
        private Transform _skiBankL;   // ski mode: the LEFT ski's roll pivot (child of Heading, on that ski's centreline); null on a board
        private Transform _skiBankR;   // ski mode: the RIGHT ski's roll pivot; null on a board
        private bool _isSkis;          // this deck is a PAIR OF SKIS (each banks about its OWN centreline) not a single snowboard
        private Vector3 _seatFwd;      // stable upright seat heading (world, horizontal) the gaze-follow settles against
        private Vector3 _seatUp = Vector3.up; // smoothed seat up (desktop view damper; low-passes the board roll into the view)
        private bool _headAligned;     // VR: gaze ~ down the board (settled) -> seat eases to the deck (seatFollowRate)
        private bool _wasGrounded;     // grounded state as of the last contact tick - the ground/air hysteresis state (grounded ends past the surface's threshold, resumes on contact) AND the probe-aim select [Trailmap: 320-ground-contact]
        private float _airTime;        // seconds continuously airborne; <= RIDE_ORIENTATION_GRACE = a brief bump-skip
        private bool _wasAir;          // true after an air tick; the next grounded tick runs the one-shot touchdown block
        private float _error;          // signed clearance of the deck reference along the contact normal (negative = penetrating) - the contact error the response acts on; ~-bog at rest [Trailmap: 320-ground-contact]
        private int _rideSurf = 1;     // last probed SurfaceType, driving the response row + the contact-field slews; holds through probe misses (off the probe's reach there is no surface to read)
        private float _sinkBudget;     // the rider's rate-limited copy of the surface's sink budget (m); slews at 1 m/s on EVERY tick [Trailmap: 310-surface-response]
        private float _sinkBog;        // rate-limited copy of the surface's bog depth (m) - the soft give the deck settles into
        private float _lift;           // per-surface visual lift (m) of the DRAWN deck, slewed in while grounded and to 0 otherwise; a render offset along the smoothed up, never the physics position [Trailmap: 320-ground-contact]
        private bool _forcedAir;       // an ollie forces the air state until the deck clears the ground band, so the pop isn't spent against the contact response [Trailmap: 300-rider-states]
        private float _tickAccum;      // real time banked toward the next fixed 60 Hz physics tick
        private Vector3 _tickAccel;    // the tick's acceleration, frozen at its opening state; Tick integrates it AFTER the position step (the engine's explicit-Euler order)
        private float _steer;          // -1..1 from InputMoveHorizontal (steer stick, both platforms)
        private float _lean;           // smoothed stick steering intent (-0.905..0.905); the game's shared input->lean slew
        private float _carveSlide;     // slewed lateral carve slide (m, OUT of the turn) along the contact-frame lateral; the drawn deck AND the ground probe both carry it [Trailmap: 330-carving]
        private float _bank;           // current visual deck-roll angle (deg); shared max on ground, 0 in air
        private float _deckLenBase = 1.68f; // measured deck length at avatar-scale 1; used by rail-contact reach
        private float _throttle;       // -1..1 from InputMoveVertical (tuck/brake on ground/rail; air FLIP when airTrickEnabled)
        private bool _flipArmed;       // a flip was started in this airtime (stick-Y in the air) -> suppress auto-level until landing, so an unfinished flip lands crooked and pays the touchdown tilt band. Cleared on ground contact.
        private bool _charging;        // Use held -> building ollie charge
        private bool _boostHeld;       // LEFT trigger (VR) / right mouse (desktop) held -> hold-to-boost
        private bool _airBoostActive;  // the aimed air thrust fired this tick -> the boost sfx plays airborne too (cleared on ground/rail)
        private float _padBoostTimer;  // >0 = a course SPEED PAD is boosting us (timed auto-boost, ApplyPadSpeedBoost) - reuses the held-boost cap+thrust
        private bool _boostWasActive;  // grounded held-boost last frame -> detect the engage edge to (re)arm the boost punch
        private bool _boostLoopOn;     // the boost-sound loop (boostSource) is currently running
        private float _boostEngageTime; // Time.time the boost last engaged -> the punch window (UpdateBoostAudio)
        private bool _bigAirWindLoopOn; // focused-rider MAIN/032 voice exists for the current predicted big air
        private bool _audioWasGrounded; // audio-only takeoff edge (physics _wasGrounded is already this frame's result)
        private float _predictedAirTime; // total flight seconds latched by the state-entry landing predictor
        private float _speedCap;       // current top-speed cap; snaps up to the boost tier (BOOST_MAX_SPEED) on boost/air, eases down on release
        private float _charge;         // 0..1 ollie charge; squared into launch power on release
        private bool _releaseQueued;   // Use released -> launch on the next grounded (or coyote-grace) frame
        private float _ollieCooldown;
        private float _jumpGrace;      // coyote timer: >0 = recently grounded, so an ollie still fires through a bump-induced air skip
        private float _slip;           // current lateral (sideways) slide speed -> carve/skid sound; 0 in the air
        private int _audioGroup = -1;  // which surface group's clips are loaded on the loop sources (-1 = none yet)
        private bool _audioOn;         // true between mount and dismount, while the loop sources run
        private bool _fxOn;            // true between mount and dismount, while the particle systems are alive
        private ParticleSystem.EmitParams _cloudEmit; // reused per-emit overrides (velocity/size/colour) for the cloud (position comes from its box shape)
        private ParticleSystem.EmitParams _surfEmit;  // separate params for the surface spray (it also overrides size + lifetime; keep those off the shared struct)
        private ParticleSystemRenderer _surfSprayRend; // surface-spray renderer (material swapped per surface class)
        private int   _surfMatIdx = -1; // surfSprayMats index currently bound (-1 = none; avoids redundant material sets)
        private float _surfBurst;      // surface-spray landing burst: decaying motion-scalar seed (game 70 -> x0.9467/tick -> ~10 floor)
        private float _surfCarry;      // surface-spray fractional-emit carry (stochastic floor, like the game's +rand[0,1))
        private float _cloudCarry;     // cloud fractional-emit carry (carve veil + powder cloud share the one system)
        // Out-of-bounds reset state lives in RideableBoard.OutOfBounds.cs; wake-ribbon runtime state in RideableBoard.Wake.cs.
        private bool _grinding;        // true while locked onto a rail (the self-contained grind state)
        private int _railIndex;        // which rail in railNetwork we're grinding (-1 none)
        private Vector3 _railFwd;      // unit travel direction ALONG the rail (full 3D tangent, oriented to our motion)
        private Vector3 _railPoint;    // last frame's contact point ON the rail (we advance from this, so stray stays ~0)
        private float _grindCooldown;  // brief lockout after leaving a rail, so the hop-off clears it before re-locking
        private float _grindTime;      // seconds on the current rail (curve-fling landing grace)
        private float _railStress;     // low-passed lateral (centripetal) accel demand of the rail bend ahead
        private bool _grindFxOn;       // true while the grind loop/sparks are live
        private float _sparkAccum;     // fractional spark-emit budget carried frame to frame (rail seam + terrain grit)
        private bool _gritOn;          // true while the spark system is playing FOR the terrain grit gate (rails own it separately)
        private bool _coasting;        // riderless board (after a Jump-off) sliding/falling to a halt; owns Update while set
        private float _coastTime;      // safety countdown so a coasting board can't drift forever (coastMaxTime)
        private Transform _seatPoint;  // the VRCStation enter-location child; moved up+behind by ApplyChaseSeat for the chase-view test

        // Probe() results (instance fields instead of out-params, to stay Udon-friendly).
        private bool _pFound;
        private Vector3 _pNormal;
        private bool _pAnalytic;       // fresh probe came from the exact bicubic path; its normal needs no low-pass
        private int _pSource;          // telemetry: 0 none, 1 analytic ray, 2 faceted ray, 3 analytic seam recovery
        private int _pSurf;
        private int _pAudioSurf = -2;  // the contact's REAL SurfaceType for the ride-AUDIO table: terrain = _pSurf, a prop proxy = its name-suffix type (_T12 = the wood bridge; -1 = untyped). Feel keeps propRideSurfaceType (docs/vrchat/035)
        private float _pGroundY;
        private Vector3 _pPoint;       // world contact point of the last probe; ContactGap measures along _pNormal from here
        // The probed ride surface carries the "_R" reset tag. The obstacle sweep only ever sees a reset host as a WALL
        // (it discards up-facing hits, which the down-probe owns), so riding onto the TOP of one - the Parlament's
        // roof slab in MERQUER - reached no reset at all. A contact is a contact whichever face it lands on.
        private bool _pResetHost;
        private bool _wasOnResetHost;   // last tick's accepted contact was a reset host, so the fire above is an EDGE
        private bool _warped;           // RespawnAt moved the transform mid-tick; the tick loop must adopt it, not overwrite

        void Start()
        {
            // A pooled board can receive the editor autotest's custom mount event in the activation frame before Udon's
            // normal Start dispatch. AutoTestMount calls Start defensively in that case; keep initialization idempotent so
            // the later engine dispatch cannot rebuild caches and runtime buffers underneath an active ride.
            if (_colliders != null) return;
            if (station == null) station = GetComponent<VRCStation>();
            _ownCollider = GetComponent<Collider>();
            _box = GetComponent<BoxCollider>();
            if (_box != null) _baseBoxSize = _box.size; // remember the authored footprint to scale avatar-fit from
            if (collisionRoot == null)
            {
                GameObject go = GameObject.Find("OpenSlope_Map/Collision");
                if (go != null) collisionRoot = go.transform;
            }
            CacheSurfaces();
            // Analytic terrain patches (approach A): prefer the serialized ref (baked by TerrainPatchBuilder); else
            // auto-find the TerrainPatches holder under the collision root. Null just leaves the PN/faceted contact.
            if (terrainPatches == null && collisionRoot != null)
            {
                Transform tp = collisionRoot.Find("TerrainPatches");
                if (tp != null) terrainPatches = tp.GetComponent<TerrainPatches>();
            }
            _pivot = transform.Find("Heading"); // the visible board's heading pivot; null on an old board => seat-locked view
            DeckPivot = _pivot;                  // expose it so RunHud can ride flat on the deck (banks/flips with it)
            if (_pivot != null)
            {
                // Ski mode: a pair of skis is built as two roll-pivots (SkiBank_L/R) under Heading - each carrying its own
                // "Deck" on that ski's centreline - so each ski can bank individually. Detect it so the orient step banks
                // each ski instead of rolling the whole Heading as a unit. A snowboard has a single centred "Deck" instead.
                _skiBankL = _pivot.Find("SkiBank_L");
                _skiBankR = _pivot.Find("SkiBank_R");
                _isSkis = _skiBankL != null && _skiBankR != null;

                // Rail contact uses the real deck half-length. The game boards differ substantially, so measure the
                // visible mesh once and keep the conservative 1.68 m fallback for an old/missing mesh.
                Transform deckT = _isSkis ? _skiBankL.Find("Deck") : _pivot.Find("Deck");
                MeshFilter dmf = deckT != null ? deckT.GetComponent<MeshFilter>() : null;
                if (dmf != null && dmf.sharedMesh != null)
                {
                    Vector3 bs = dmf.sharedMesh.bounds.size;
                    float longest = Mathf.Max(bs.x, Mathf.Max(bs.y, bs.z));
                    float wlen = longest * Mathf.Abs(deckT.lossyScale.x);
                    if (wlen > 0.1f) _deckLenBase = wlen;
                }

            }
            // RiderProbe capsule: the obstacle sweep reuses its dims (same body that fires the triggers). Null on an old
            // board built before the probe -> _capRadius stays 0 -> obstacle collision no-ops (the board still rides).
            Transform probe = transform.Find("RiderProbe");
            if (probe != null) _probeCol = probe.GetComponent<CapsuleCollider>();
            if (_probeCol != null)
            {
                _capRadius = _probeCol.radius;
                float off = Mathf.Max(0f, _probeCol.height * 0.5f - _probeCol.radius); // sphere-center offset from capsule centre
                _capLow = _probeCol.center.y - off;
                _capHigh = _probeCol.center.y + off;
            }
            if (wakeMeshFilter == null)
            {
                Transform w = transform.Find("Wake"); // old board built before the wake -> stays null -> no-op
                if (w != null) { wakeMeshFilter = w.GetComponent<MeshFilter>(); wakeMeshRenderer = w.GetComponent<MeshRenderer>(); }
            }
            InitWakeMesh(); // build the procedural mesh + buffers + cross-section profile (no-op if no Wake child)
            // Chase-view test seat (the station enter-location child). ApplyChaseSeat offsets it when chaseCamSeat is on.
            // Null on an old board built before it existed -> the flag no-ops.
            _seatPoint = transform.Find("SeatPoint");
            ApplyChaseSeat();
            _player = Networking.LocalPlayer;
            // The grab pickup (RideableBoard.Grab.cs): the same box the trigger mounts, the grip carries. Auto-found so a
            // board whose Udon var was never pushed still picks it up; null (a board built before grabbing) leaves the board
            // ride-only. RefreshPickupable decides per-client who may grab it - VR only, and never a board already in use.
            if (pickup == null) pickup = (VRC_Pickup)GetComponent(typeof(VRC_Pickup));
            RefreshPickupable();
            // The free-standing trigger-flight controller: tell it to stand down while we're ridden (on the board the
            // triggers are ollie/boost, not fly). Auto-found; null just means the calls below no-op.
            GameObject flightGo = GameObject.Find("OpenSlope_Map/PlayerFlight");
            if (flightGo != null) _flight = flightGo.GetComponent<PlayerFlight>();
            // The grind-rail network. Auto-found; null (imported before rails, or BuildRails off) leaves grinding disabled.
            if (railNetwork == null)
            {
                GameObject railGo = GameObject.Find("OpenSlope_Map/Rails");
                if (railGo != null) railNetwork = railGo.GetComponent<RailNetwork>();
            }
            // The course path (baked from the game's AIP/SOP race lines). Auto-found; null makes the OOB reset fall back
            // to the breadcrumb trail.
            if (coursePath == null)
            {
                GameObject courseGo = GameObject.Find("OpenSlope_Map/CoursePath");
                if (courseGo != null) coursePath = courseGo.GetComponent<RailNetwork>();
            }
            // The finish line, for its lap count. Same auto-find as the course path; absent on a map with no leaderboard,
            // which simply means there is no race to lap.
            if (finishLine == null)
            {
                GameObject finishGo = GameObject.Find("OpenSlope_Map/FinishLine");
                if (finishGo != null) finishLine = finishGo.GetComponent<FinishLine>();
            }
            // The swish-through leaf volumes (trigger boxes under PropsFoliage). Null leaves the leaf-swish sound disabled.
            GameObject foliageGo = GameObject.Find("OpenSlope_Map/PropsFoliage");
            if (foliageGo != null) _foliageRoot = foliageGo.transform;
            // Narrow the swish cast to the leaf boxes' own physics layer so it returns only foliage. Read the layer off an
            // actual box rather than a name lookup, so it tracks whatever layer the importer used. ~0 fallback if missing.
            if (_foliageRoot != null && _foliageRoot.childCount > 0)
            {
                Transform grp = _foliageRoot.GetChild(0);                 // a Snd05x sound group
                if (grp != null && grp.childCount > 0)
                    _foliageMask = 1 << grp.GetChild(0).gameObject.layer; // a Leaf_ box
            }
            _railIndex = -1;
            // Out-of-bounds reset trail ring buffers (see resetToTrackOnOOB). Sized once here.
            int crumbs = trailCrumbCount > 2 ? trailCrumbCount : 2;
            _crumbPos = new Vector3[crumbs];
            _crumbFwd = new Vector3[crumbs];
            _crumbWrite = 0; _crumbFilled = 0; _haveLastCrumb = false;
        }

        // ---- Input (fires even while the station immobilizes the avatar) ----------------------------------

        // Steering is the LEFT stick X / A-D on BOTH platforms (the same stick whose Y is accel/brake), leaving the VR
        // right look-stick free for the view. See docs/vrchat/017 (the VR steer-stick move).
        public override void InputMoveHorizontal(float value, UdonInputEventArgs args)
        {
            if (_riding && !AutoTestControl) _steer = value;
        }
        public override void InputMoveVertical(float value, UdonInputEventArgs args)   { if (_riding && !AutoTestControl) _throttle = value; } // accel/brake (both)

        // Headset-tested stick shaping: square magnitude in every state. Small deflections get more precision, while hard
        // left/right remains exactly ±1 and therefore reaches 100% of the ground, air, or rail state's turn rate.
        bool StickActive() { return Mathf.Abs(_steer) > 0.05f; }
        float StickSteer()
        {
            float value = Mathf.Clamp(_steer, -1f, 1f);
            return Mathf.Sign(value) * value * value;
        }
        // Charged ollie: hold Use to build charge, release to launch (longer hold = bigger jump, squared). The mount
        // click is swallowed by the _ollieCooldown grace.
        public override void InputUse(bool value, UdonInputEventArgs args)
        {
            if (!_riding || AutoTestControl) return;
            // VR LEFT trigger = the held 'Boost' control, NOT the ollie. args.handType tells us which trigger fired Use;
            // the left one is reserved for boost. Desktop has one Use (reports RIGHT/UNKNOWN) and falls through to the
            // ollie (desktop boost is the right mouse button, polled in Update).
            if (_player != null && _player.IsUserInVR() && args.handType == HandType.LEFT)
            {
                if (holdBoostEnabled) _boostHeld = value;
                return;
            }
            // RIGHT trigger (VR) / left-click (desktop) = charged ollie.
            if (value) { if (_ollieCooldown <= 0f && !_charging) { _charging = true; _charge = 0f; } }
            else if (_charging) { _charging = false; _releaseQueued = true; }
        }
        // Jump is our explicit dismount in EVERY state (the station's built-in exit is disabled so steer input can't
        // eject you) - on a rail it frees you off the board entirely; the ollie (InputUse) is what hops you OFF the rail.
        public override void InputJump(bool value, UdonInputEventArgs args)            { if (_riding && !AutoTestControl && value) Dismount(); }

        // The charged launch [Trailmap: 340-jump-air-landing] - an impulse ADDED to the carried velocity, never
        // replacing it, built in the contact frame off the CACHED contact normal (so a release on a coyote tick still
        // pops off the slope it just left). The caller (Tick) gates WHEN it runs.
        //
        // Direction: `steep` measures how far past 50 deg the ground has tipped, and is NEGATIVE on ordinary ground -
        // flat ground gives ~-1.19, not zero. That negative is not a clamp to be swallowed; it selects a different
        // blend. Ordinary flat-to-gentle launches take the fixed fallback normalize(n + 0.2*tangent), leaning the pop
        // slightly down-course (~6.19 m/s vertical at the minimum launch). Only past 50 deg, with the travel tangent
        // pointing up, does the weighted normal<->tangent blend take over and throw the rider down the lip. There is
        // no ramp-surface special case: a booter is its table row plus this geometry.
        //
        // Magnitude: charge^2 * riderCurve * speedFactor, floored at JUMP_MIN (6.309 m/s - even a bare tap is a real
        // pop). The charge pays quadratically and a faster approach jumps higher, until speedFactor saturates at
        // ~9 m/s worth; at the mid rider stat the product rarely clears the floor, so charge mostly buys height at speed.
        private void LaunchOllie()
        {
            Vector3 n = _contactN.sqrMagnitude > 1e-6f ? _contactN.normalized : Vector3.up;
            Vector3 travel = _vel.sqrMagnitude > 1e-4f ? _vel : _fwd;
            Vector3 tangent = Vector3.ProjectOnPlane(travel, n);
            bool flatTangent = tangent.sqrMagnitude <= 1e-6f;
            if (flatTangent) tangent = _fwd; else tangent = tangent.normalized;

            float steep = (0.642788f - n.y) / 0.300768f;  // (cos50 - n.y) / (cos50 - cos70); < 0 on ordinary ground
            Vector3 launchDir;
            if (steep <= 0f || flatTangent) launchDir = n + tangent * LAUNCH_FALLBACK_TANGENT; // the ordinary case
            else launchDir = n + tangent * Mathf.Clamp(steep * (tangent.y / 0.342020f), 0f, 0.9f); // past 50 deg: down the lip
            launchDir = launchDir.sqrMagnitude > 1e-6f ? launchDir.normalized : n;

            float speedFactor = Mathf.Min(0.88093346f * _vel.magnitude + 0.24678448f, JUMP_SPEED_FACTOR_MAX);
            float launch = Mathf.Max(JUMP_MIN, _charge * _charge * JUMP_RIDER_CURVE * speedFactor);
            _vel += launchDir * launch;
            _telemetryEvents |= 4;
            _ollieCooldown = 0.35f;
            // The launch forces motion state 1 ([Trailmap: 300-rider-states]: it fires with no contact check, and the
            // deck is still inside the surface on the tick it fires). Tick holds the air state until the clearance
            // passes the surface's ground threshold - without this the pop is spent against the contact response the
            // deck has not yet climbed out of.
            _forcedAir = true;
            // Ollie pop (louder the longer you charged).
            if (eventSource != null && ollieClip != null)
                eventSource.PlayOneShot(ollieClip, Mathf.Clamp01((0.5f + 0.5f * _charge) * soundVolume));
        }

        // ---- Per-frame update + the fixed 60 Hz motion tick ------------------------------------------------

        // The physics tick. The engine integrates at a fixed 60 Hz and its contact constants are PER TICK, not per
        // second: the pushout adds a length to velocity once a tick, the redirect removes a flat 40% of the normal
        // velocity, and the contact fields slew a flat 1.6667 units a tick. Scaling those by a variable dt would make
        // the ride a different game at every frame rate, so Update banks real time and spends it in whole ticks
        // [Trailmap: 320-ground-contact].
        private const float TICK_H = 1f / RIDE_SIMULATION_HZ;
        private const int TICK_MAX = RIDE_MAX_CATCHUP_TICKS; // catch-up bound: past it the ride runs slow rather than teleporting

        // The spec-traced motion constants live here as consts, NOT inspector knobs: a scene-serialized knob silently
        // overrides the traced value on every existing board, which is exactly the tuning-contradicts-spec failure
        // this model replaces. Steering lead and grip shaping are generated contract values too.
        // [Trailmap: 360-speed-and-boost] the shared speed cap: default tier, top (boost) tier, and the ~2.08 m/s per
        // second it eases DOWN at. There is no boost meter-tier selection here - boost selects the top tier directly.
        private const float MAX_SPEED = RIDE_MAX_SPEED;
        private const float BOOST_MAX_SPEED = RIDE_BOOST_MAX_SPEED;
        private const float BOOST_CAP_DECAY = RIDE_BOOST_CAP_DECAY;
        // [Trailmap: 360-speed-and-boost] cruise drive: the rider-statistic factor (mid of the traced 0.738-1.015
        // band), the held-boost ground thrust, and the narrow lean window that gates the thrust - edging past the
        // window while boosting throws the thrust away.
        private const float RIDER_DRIVE = RIDE_RIDER_DRIVE;
        private const float BOOST_ACCEL = RIDE_BOOST_ACCEL;
        private const float BOOST_LEAN_WINDOW = RIDE_BOOST_LEAN_WINDOW;
        // [Trailmap: 330-carving] The generated response helper owns the per-tick yaw cap and resistance laws.
        // [Trailmap: 340-jump-air-landing] the charged launch: the 6.309 m/s floor (a bare tap is already a real pop),
        // the mid-stat rider curve, the speed-factor saturation, and the flat fallback tangent lean an ordinary
        // flat-to-gentle launch takes.
        private const float JUMP_MIN = 6.309f;
        private const float JUMP_RIDER_CURVE = 0.8855f;
        private const float JUMP_SPEED_FACTOR_MAX = 8.9987f;
        private const float LAUNCH_FALLBACK_TANGENT = 0.2f;

        void Update()
        {
            // EXPIRE a requested mount that never landed - BEFORE the non-owner return below, which is the whole point. A
            // click that asks for ownership sets _pendingMount and waits for OnOwnershipTransferred to seat us; if that
            // transfer never arrives (lost race, refused, board taken) we stay a NON-owner, so a timeout check placed after
            // that return would never run and the flag would stay latched on this board forever. A stale latch is live
            // ammunition: the next time ownership arrives for ANY reason - the over-the-shoulder summon taking the board to
            // pull it to your hand, or VRChat reassigning a board whose owner left - it would be read as "seat this player",
            // planting a rider on a board that's in their own hand. See OnOwnershipTransferred (docs/vrchat/042).
            if (_pendingMount && Time.time - _pendingMountTime > netMountTimeout) _pendingMount = false;
            // Networking (docs/vrchat/042): only the OWNER simulates. A remote copy eases onto the owner's synced pose and
            // returns (its cheap "sleep" - no physics). In a solo instance the local player owns everything, so this
            // never blocks and the board runs exactly as the old local-only one did.
            if (networked && !Networking.IsOwner(gameObject)) { IsRiding = false; NetFollow(); RemoteFxUpdate(); return; }
            // We own this board now. If we were just driving it as a remote (FX running), hand the FX back to the owner
            // paths: clear the flag so the wake carve gate reverts, and stop the remote-started systems UNLESS we own it
            // because we just mounted (the ride owns them then). Idempotent - the flag is false after the first owner frame.
            if (_remoteFxActive) { _remoteFxActive = false; if (!_riding) { StopBoardEffects(); ClearWake(); _haveLastWake = false; _wkN = 0; } }
            // CARRIED (RideableBoard.Grab.cs): the VRC_Pickup owns the transform while the board is in your hand, so every
            // transform writer below - the ride, the riderless coast, the park-and-sleep - stands down. We only MEASURE the
            // hand (for the throw on release) and stay awake, so PostLateUpdate keeps publishing the carried pose to remotes.
            // Ahead of the sleep check on purpose: a board picked up off a gate post was asleep, and a sleeping board neither
            // ticks nor publishes - it would move in your hand and stay frozen at the gate for everyone else.
            if (_held) { HeldUpdate(); return; }
            if (_asleep) { IsRiding = false; return; } // parked & asleep - skip everything until a mount/dispense wakes us (docs/vrchat/042)
            IsRiding = _riding;          // expose to the trigger volumes (their RiderProbe path fires only while ridden)
            if (!_riding)
            {
                ScoreOffBoardUpdate(); // a run kept alive by an airborne exit: clock ticks while the board coasts, ends if the player lands on foot
                // Self-healing audio/FX guard: VRChat doesn't reliably fire OnStationExited on a programmatic
                // ExitStation, which left the glide loop droning after a jump-off. Catch any state still flagged ON here
                // and kill it, so the loops can't outlive the ride by more than a frame. Idempotent. See docs/vrchat/017.
                if (_audioOn) StopBoardAudio();
                if (_grindFxOn) StopGrindFx();
                if (_fxOn) StopBoardEffects();
                if (_coasting) { CoastUpdate(); _parkTimer = 0f; } // riderless: keep momentum, fall, slide to a stop, then park
                else if (_wkN > 0) { WakeAgeOnly(Time.deltaTime); _parkTimer = 0f; } // melt any leftover wake on a now-parked board
                else if (sleepWhenParked)
                {
                    // Fully parked (stopped, wake melted). After a short settle - long enough that the resting pose has
                    // synced out to everyone - SLEEP: stop the per-frame Update + the pose publish, so an abandoned or
                    // at-the-gate board costs ~nothing until a mount (OnStationEntered) or re-dispense (WakeUp). docs/vrchat/042.
                    _parkTimer += Time.deltaTime;
                    if (_parkTimer >= sleepDelay) _asleep = true;
                }
                return;
            }
            if (_player == null) { _player = Networking.LocalPlayer; if (_player == null) return; }
            bool vr = _player.IsUserInVR(); // VR -> head-steer + pinned seat; desktop -> stick-steer + seat follows board

            if (AutoTestControl)
            {
                // ClientSim validation must be deterministic and independent of whichever desktop/VR input state the
                // editor currently has. Treat it as desktop stick steering and feed the explicit test controls.
                vr = false;
                _steer = Mathf.Clamp(AutoTestSteer, -1f, 1f);
                _throttle = Mathf.Clamp(AutoTestThrottle, -1f, 1f);
                _boostHeld = AutoTestBoost && holdBoostEnabled;
            }

            // Desktop boost = HOLD the right mouse button (no left trigger on desktop). Input.GetMouseButton(1) is
            // Udon-whitelisted. Must NOT poll the mouse in VR (there's none) or a false read would clobber the trigger.
            if (!AutoTestControl && !vr && holdBoostEnabled) _boostHeld = Input.GetMouseButton(1);

            _dbgT0 = Time.realtimeSinceStartup;   // diagnostic: time this ridden Update (see dbgUpdateMs at the bottom)
            _dbgLast = _dbgT0;
            float dt = Time.deltaTime;
            if (dt <= 0f) return;
            float launchSpd = RIDE_LAUNCH_WORLD_UP_SPEED;
            _ollieCooldown -= dt;                            // control timers stay per-frame: a grind frame runs zero contact ticks but still consumes _releaseQueued for the rail hop-off
            if (_padBoostTimer > 0f) _padBoostTimer -= dt;   // course speed-pad boost window (must keep draining on grind frames too)
            AutoTestBoostWindow = Mathf.Max(0f, _padBoostTimer);

            Vector3 cur = transform.position;

            // Out-of-bounds reset + breadcrumb recording (board-only; RideableBoard.OutOfBounds.cs), read off the
            // LAST tick's contact state. When it teleports us back onto the course, RespawnAt has already drained the
            // tick accumulator and re-seated the slewed contact fields, and this frame is done.
            if (OutOfBoundsUpdate(cur, dt, _wasGrounded)) return;

            // Boost SOUND (the SSX boost cue): a volume-enveloped loop - punch on the engage edge, low sustain while
            // held, fast fade on release (the engine clip is flat, so the fade is shaped in UpdateBoostAudio). It runs
            // wherever the boost actually THRUSTS: on the ground, and in the air while the aimed air boost fires
            // (_airBoostActive); on a rail a held boost stays silent and just sustains the speed cap. Local rider only -
            // by here we've already returned for non-owners, matching the game gating the boost sfx to the local human.
            UpdateBoostAudio(_wasGrounded, dt);
            BoostMeterTick(dt);   // drain the boost meter while held boost is consuming it (run-scoped; see Score.cs)
            { float __t = Time.realtimeSinceStartup; dbgSecProbe = Mathf.Lerp(dbgSecProbe, (__t - _dbgLast) * 1000f, 0.1f); _dbgLast = __t; } // section: oob + boost audio

            // ---- Rail grinding (docs/026): a self-contained state, run BEFORE the contact ticks so their integration
            // is untouched. A grind frame OWNS the whole frame and runs ZERO contact ticks; the banked tick time is
            // DRAINED (not frozen) so leaving a rail starts contact fresh instead of spending a backlog of stale ticks
            // on the first free frame.
            if (_grindCooldown > 0f) _grindCooldown -= dt;
            if (railGrindEnabled && railNetwork != null && _grindCooldown <= 0f)
            {
                // A grind frame runs ZERO contact ticks, so the wedge integrator would neither be fed nor decay - it
                // would sit frozen across the whole grind and fire off a stale count on the first shove after it. A
                // rider carried along a rail is the opposite of wedged, so the count goes with the banked tick time.
                if (_grinding) { _tickAccum = 0f; _wedge = 0f; GrindUpdate(cur, dt, vr); return; }
                if (TryEnterGrind(cur, dt)) { _tickAccum = 0f; _wedge = 0f; GrindUpdate(cur, dt, vr); return; }
            }
            { float __t = Time.realtimeSinceStartup; dbgSecRail = Mathf.Lerp(dbgSecRail, (__t - _dbgLast) * 1000f, 0.1f); _dbgLast = __t; } // section: rail-detect (grind frames return above)

            // ---- The fixed 60 Hz physics ticks. ALL motion - probe, ground/air decision, contact response, steering,
            // carve, cruise, boost, drag, speed cap, integration - runs in whole TICK_H steps ([Trailmap:
            // 320-ground-contact]: the engine's contact constants are per-tick, and a dt-scaled port is a different
            // game at every frame rate). Everything after the loop is per-frame: visual orientation, FX, audio,
            // telemetry. A hitch banks at most TICK_MAX ticks - the ride runs slow, it never teleports through terrain.
            _tickAccum += dt;
            if (_tickAccum > TICK_MAX * TICK_H) _tickAccum = TICK_MAX * TICK_H;
            Vector3 pos = cur;
            _telemetryEvents = 0;
            while (_tickAccum >= TICK_H)
            {
                _tickAccum -= TICK_H;
                pos = Tick(pos, vr, launchSpd);
                // A tick ejected the rider (wall crash / landBail wipeout): the board is released. Keep the ticks the
                // frame already ran - abandoning `pos` here would rewind up to 0.1 s of integrated motion.
                if (!_riding) { transform.position = pos; return; }
                // A tick WARPED the rider (course reset from a reset zone, a reset host's collision, or the OOB
                // floor): RespawnAt has already written the carried-back pose to the transform, while `pos` still
                // holds this tick's pre-warp integration. Adopt the warp - the write-back below would otherwise
                // undo it and the rider would appear to barely move. RespawnAt drains _tickAccum, so this is the
                // frame's last tick either way.
                if (_warped) { _warped = false; pos = transform.position; }
            }
            transform.position = pos; // the canonical physics position, written back once per frame
            CheckFoliageSwish(pos);   // swish-through leaf clouds (pass-through triggers; doesn't block, just sounds)

            bool onGround = _wasGrounded; // the tick loop's closing contact state; every per-frame consumer below reads it
            dbgGround = onGround; dbgSurf = onGround ? _pSurf : -2; dbgBoost = BoostActive(); dbgCharge = _charging ? _charge : 0f;   // debug HUD telemetry
            { float __t = Time.realtimeSinceStartup; dbgSecInteg = Mathf.Lerp(dbgSecInteg, (__t - _dbgLast) * 1000f, 0.1f); _dbgLast = __t; } // section: the tick loop

            // Visual orientation is part of the shared model: grounded rotation follows the measured cubic error law
            // (90*error^3 rad/s, capped at 270 deg/s), while neutral air levels at 9 deg/s. A real launch is recognized
            // by world-up speed OR outward speed along the cached takeoff normal, because a downhill lip can leave with
            // negative world-Y velocity. That departure skips bump grace and preserves the takeoff pose.
            bool launching = !onGround && (_vel.y > launchSpd ||
                              Vector3.Dot(_vel, _contactN) > RIDE_LAUNCH_OUTWARD_SPEED);
            bool orientGrounded = onGround || (_airTime <= RIDE_ORIENTATION_GRACE && !launching);
            Vector3 targetUp = orientGrounded ? _contactN : Vector3.up;
            if (targetUp.sqrMagnitude < 1e-6f) targetUp = Vector3.up;
            // A flip armed in the air holds its orientation; otherwise the contract's air level-off runs.
            float upError = Vector3.Angle(_boardUp, targetUp) * Mathf.Deg2Rad;
            float upRate;
            if (orientGrounded)
                upRate = Mathf.Min(RIDE_GROUND_ORIENT_RATE_CAP * Mathf.Deg2Rad,
                                   RIDE_GROUND_ORIENT_GAIN * upError * upError * upError);
            else upRate = _flipArmed ? 0f : RIDE_AIR_LEVEL_RATE * Mathf.Deg2Rad;
            _boardUp = Vector3.RotateTowards(_boardUp, targetUp, upRate * dt, 0f);
            if (_boardUp.sqrMagnitude < 1e-6f) _boardUp = Vector3.up;
            // The deck faces the heading you steer/look toward in BOTH states (not the travel direction in air), so
            // air-steer/gaze visibly rotate it, the trajectory stays a pure arc, and your aimed heading carries into the
            // landing (land facing your travel and you're riding switch: vF goes negative). Projecting _fwd onto _boardUp
            // re-derives the in-plane (pitched) forward, so a slope landing pitches the nose to match, not only banks.
            // The final retail board matrix has its own measured cubic response, so physics and visuals share _boardUp;
            // rendering the raw contact normal here instead bypasses that law and tilts the nose down on a lip.
            Vector3 deckUp = _boardUp;
            if (deckUp.sqrMagnitude < 1e-6f) deckUp = Vector3.up;
            Vector3 faceDir = Vector3.ProjectOnPlane(_fwd, deckUp);
            faceDir = faceDir.sqrMagnitude > 1e-6f ? faceDir.normalized : _fwd;
            Quaternion boardRot = Quaternion.LookRotation(faceDir, deckUp);
            // Carve bank (VISUAL only): roll the deck about its forward axis by the Lean signal (~50 deg/unit, natural cap
            // ~45 deg); eases to level in the air. We DON'T bank the seat/view (sim-sickness) and the physics _boardUp is untouched.
            float bankTarget = orientGrounded ? _lean * RIDE_BANK_MAX : 0f; // hold the carve bank through a brief bump-skip
            _bank = Mathf.MoveTowards(_bank, bankTarget, 360f * dt);
            Quaternion deckRot = Quaternion.AngleAxis(-_bank, faceDir) * boardRot; // -_bank: edge INTO the carve
            if (_pivot != null)
            {
                // The VISIBLE board (Heading pivot) points where we travel, banks with the slope, and rolls into carves.
                // SKIS differ here: a snowboard is one rigid plank that banks as a UNIT about its centreline (the Heading
                // carries the carve roll). A pair of skis instead EDGES EACH SKI about its OWN centreline so both stay
                // planted and edge in parallel - so for skis the Heading carries FACING only and we roll the two ski pivots.
                Quaternion pivotRot = _isSkis ? boardRot : deckRot;
                if (_isSkis)
                {
                    Quaternion skiRoll = Quaternion.AngleAxis(-_bank, Vector3.forward); // roll about each ski's own long axis (local Z)
                    if (_skiBankL != null) _skiBankL.localRotation = skiRoll;
                    if (_skiBankR != null) _skiBankR.localRotation = skiRoll;
                }
                // The SEAT (root) orientation is per-platform:
                //   VR - the seat is LEVEL and yaws only with the stick's turn INTENT (the grounded/air carries in the
                //   tick). Head-steer turns the board to your physical look while the seat never chases it, so the view
                //   is never force-rotated by your own gaze (no nausea, no feedback spin). No view bank either.
                //   DESKTOP - grounded view follows the full board heading through the viewSmoothTime low-pass (and the
                //   first-person yaw cap); air carries the board's full yaw delta without snapping away the ground lag,
                //   and rails already follow at full rate. The mouse remains free-look. seatFollowRate / seatFreeAngle unused.
                if (_seatFwd.sqrMagnitude < 1e-6f) _seatFwd = Vector3.ProjectOnPlane(faceDir, Vector3.up).normalized;
                if (vr)
                {
                    Vector3 sp = Vector3.ProjectOnPlane(_seatFwd, Vector3.up);
                    if (sp.sqrMagnitude > 1e-6f) _seatFwd = sp.normalized;
                    // Settle-realign: when NOT actively head-steering (_headAligned), ease the body to square up with the
                    // deck so head-steered turns don't leave it drifted off-axis. Gated to settled -> no gaze offset to
                    // chase -> no feedback spin. seatFollowRate=0 disables.
                    if (_headAligned && seatFollowRate > 0f)
                    {
                        Vector3 bh = Vector3.ProjectOnPlane(_fwd, Vector3.up);
                        if (bh.sqrMagnitude > 1e-6f)
                            _seatFwd = Vector3.RotateTowards(_seatFwd, bh.normalized, seatFollowRate * Mathf.Deg2Rad * dt, 0f);
                    }
                    transform.rotation = Quaternion.LookRotation(_seatFwd, Vector3.up); // pinned + level
                }
                else
                {
                    // DESKTOP: while GROUNDED the seat follows the board heading through a low-pass (viewSmoothTime)
                    // instead of a rigid lock, so the board's authentic per-turn shudder is smoothed out of the view.
                    // In AIR the shared air tick rotates the seat by the board's exact stick-yaw delta: keyboard/gamepad
                    // then gets the same full-rate carry that the VR stick already uses, without snapping away any ground
                    // lag at takeoff. Desktop rails already follow at full rate. The grounded view follows the FULL board
                    // heading - on a drifting ice path the nose visibly leads the travel direction.
                    Vector3 bh = Vector3.ProjectOnPlane(_fwd, Vector3.up);
                    if (bh.sqrMagnitude < 1e-6f) bh = _seatFwd; else bh = bh.normalized; // board heading (horizontal)
                    // First-person comfort dials (grounded): viewBoardLead blends the reference from the travel
                    // direction (0) to the nose (1); viewYawRateMax below rounds the entry snap off the view.
                    if (!chaseCamSeat && orientGrounded && viewBoardLead < 1f)
                    {
                        Vector3 travelView = Vector3.ProjectOnPlane(_vel, Vector3.up);
                        if (travelView.sqrMagnitude > 0.25f)
                            bh = Vector3.Slerp(travelView.normalized, bh, viewBoardLead).normalized;
                    }
                    Vector3 upTarget = viewLeanMax > 0f
                        ? Vector3.RotateTowards(Vector3.up, _boardUp, viewLeanMax * Mathf.Deg2Rad, 0f) // a touch of bank, capped
                        : Vector3.up;
                    if (upTarget.sqrMagnitude < 1e-6f) upTarget = Vector3.up;
                    if (_seatUp.sqrMagnitude < 1e-6f) _seatUp = Vector3.up;
                    float k = viewSmoothTime > 0f ? dt / (viewSmoothTime + dt) : 1f; // implicit-stable low-pass fraction (<1)
                    Vector3 seatTarget = orientGrounded
                        ? Vector3.Slerp(_seatFwd, bh, k).normalized // ground: ease heading (smooths the turn shudder)
                        : _seatFwd.normalized;                       // air: preserve the full-rate yaw carried in AirTick
                    _seatFwd = orientGrounded && !chaseCamSeat && viewYawRateMax > 0f
                        ? Vector3.RotateTowards(_seatFwd, seatTarget, viewYawRateMax * Mathf.Deg2Rad * dt, 0f).normalized
                        : seatTarget; // the cap is ground-only; air and rails track the board 1:1
                    _seatUp = Vector3.Slerp(_seatUp, upTarget, k).normalized;   // ease bank (smooths the roll shudder)
                    transform.rotation = Quaternion.LookRotation(_seatFwd, _seatUp);
                }
                // Set the child pose LAST, after the seat rotation. Bank EDGE-LIFT raises a snowboard so it pivots about
                // its planted downhill edge; skis bank independently about their own centrelines and need no shared lift.
                // The per-surface VISUAL LIFT (_lift, slewed by the ticks) rides the smoothed up on top: the physics
                // position rests a bog depth INTO the surface, and the lift draws the DRAWN deck back - its authored
                // values nearly cancel the sink on hard surfaces and deliberately do not on powder, so the net visible
                // deck height IS the surface character [Trailmap: 320-ground-contact]. The SEAT (this transform, where
                // the rider stands) stays on the physics position - the rider's feet ride into the powder with the deck.
                // The carve slide draws the deck at the same slid station the ground probe measures - out of the
                // turn along the contact-frame lateral [Trailmap: 330-carving]. The SEAT stays on the physics
                // position, exactly like the lift: the rider's stance holds while the deck washes outward.
                Vector3 pivotPos = transform.position + deckUp * (_isSkis ? 0f : DeckBankLift()) + _boardUp * _lift;
                Vector3 pivotLat = Vector3.Cross(_contactN, _fwd);
                if (pivotLat.sqrMagnitude > 1e-6f) pivotPos += pivotLat.normalized * _carveSlide;
                _pivot.position = pivotPos;
                // WORLD rotation must be the final child write. Rotating the seat/root after setting this child used to
                // yaw the visible deck a second time on a 60 Hz air tick; the next render frame reset it to deckRot,
                // producing a continuous overshoot/snap-back jitter while spinning.
                _pivot.rotation = pivotRot;
            }
            else
            {
                transform.rotation = boardRot; // old board with no Heading pivot: fall back to the seat-locked view
            }

            { float __t = Time.realtimeSinceStartup; dbgSecOrient = Mathf.Lerp(dbgSecOrient, (__t - _dbgLast) * 1000f, 0.1f); _dbgLast = __t; } // section: orientation / pose
            UpdateBoardAudio(onGround, dt); // drive the glide/carve loop volumes + pitch from this frame's state
            RaceAudioUpdate(onGround, dt);  // feed the race-music path level + the announcer's time-based events
            ScoreUpdate(onGround, dt);      // run clock + bank spins/flips on landing (the leaderboard run score)
            // Local wake + spray, gated by the Settings Board's "My board FX" so a weak client can drop them for itself
            // (your OWN board only - other riders' boards go through remoteRiderFx). Off => fade any laid ribbon, emit nothing.
            if (LocalFxOn()) { UpdateSpray(onGround, dt); UpdateWakeTrail(dt); }
            else if (_wkN > 0) WakeAgeOnly(dt);

            RiderVelocity = _vel;    // the crash-bag props read this to fling along our motion (seated player has none)
            { float __t = Time.realtimeSinceStartup; dbgSecAudioFx = Mathf.Lerp(dbgSecAudioFx, (__t - _dbgLast) * 1000f, 0.1f); _dbgLast = __t; } // section: audio + fx
            dbgUpdateMs = Mathf.Lerp(dbgUpdateMs, (Time.realtimeSinceStartup - _dbgT0) * 1000f, 0.1f); // diagnostic: this Update's wall-time
            RideTelemetryUpdate(pos, onGround, dt);
        }

        // Human-readable, machine-parseable telemetry for matching a Unity ride against the PCSX2/Slopesmith gold.
        // Each console line is a pipe-delimited record with stable key names; logging is strictly opt-in because Udon
        // string construction and Debug.Log are intentionally too expensive for a shipping ride.
        void RideTelemetryUpdate(Vector3 pos, bool onGround, float dt)
        {
            // Strictly opt-in, and only for the one locally ridden board: flip the Diagnostics Board's "Ride telemetry
            // log" row (or the board's debugLog field) to capture a trace.
            if (!debugLog) { _telemetryHeaderWritten = false; _telemetryFrame = 0; return; }
            if (!_telemetryHeaderWritten)
            {
                Debug.Log("RIDE_DBG|kind=header|schema=unity-ride-telemetry/v1|contractSchema=" + RIDE_CONTRACT_SCHEMA +
                          "|contractVersion=" + RIDE_CONTRACT_VERSION + "|contractProfile=" + RIDE_CONTRACT_PROFILE +
                          "|simulationHz=" + RIDE_SIMULATION_HZ + "|upAxis=Y|unitsPerMeter=1");
                _telemetryHeaderWritten = true;
            }

            Vector3 deckForward = _pivot != null ? _pivot.forward : transform.forward;
            float speed = _vel.magnitude;
            float trajectoryPitch = Mathf.Atan2(_vel.y, Mathf.Sqrt(_vel.x * _vel.x + _vel.z * _vel.z)) * Mathf.Rad2Deg;
            float boardPitch = Mathf.Atan2(deckForward.y,
                                          Mathf.Sqrt(deckForward.x * deckForward.x + deckForward.z * deckForward.z)) * Mathf.Rad2Deg;
            float normalSpeed = _pFound ? Vector3.Dot(_vel, _pNormal) : 0f;
            float residual = (_pSource == 1 && terrainPatches != null) ? terrainPatches.RRayResidual : -1f;
            string probeSource = _pSource == 1 ? "analytic-ray" : (_pSource == 2 ? "faceted-ray" : (_pSource == 3 ? "recovery" : "none"));
            string eventName = "none";
            if ((_telemetryEvents & 1) != 0) eventName = "takeoff";
            if ((_telemetryEvents & 2) != 0) eventName = eventName == "none" ? "touchdown" : eventName + "+touchdown";
            if ((_telemetryEvents & 4) != 0) eventName = eventName == "none" ? "launch" : eventName + "+launch";

            _telemetryFrame++;
            Debug.Log("RIDE_DBG|kind=frame|frame=" + _telemetryFrame + "|tick=" + _telemetryTick +
                      "|unityFrame=" + Time.frameCount + "|time=" + Time.time.ToString("F6") + "|dt=" + dt.ToString("F6") +
                      "|event=" + eventName + "|grounded=" + (onGround ? 1 : 0) + "|forcedAir=" + (_forcedAir ? 1 : 0) +
                      "|surfaceType=" + _rideSurf + "|probeSource=" + probeSource + "|probeFound=" + (_pFound ? 1 : 0) +
                      "|acceptedGround=" + (onGround ? 1 : 0) + "|analyticResidual=" + residual.ToString("F6") +
                      "|error=" + _error.ToString("F6") + "|groundThreshold=" + SurfThresh(_rideSurf).ToString("F6") +
                      "|normalSpeed=" + normalSpeed.ToString("F6") + "|airTime=" + _airTime.ToString("F6") +
                      "|speedCap=" + _speedCap.ToString("F6") + "|steer=" + _steer.ToString("F6") +
                      "|steerEffective=" + StickSteer().ToString("F6") +
                      "|lean=" + _lean.ToString("F6") + "|slip=" + _slip.ToString("F6") +
                      "|throttle=" + _throttle.ToString("F6") + "|boost=" + (BoostActive() ? 1 : 0) +
                      "|px=" + pos.x.ToString("F6") + "|py=" + pos.y.ToString("F6") + "|pz=" + pos.z.ToString("F6") +
                      "|vx=" + _vel.x.ToString("F6") + "|vy=" + _vel.y.ToString("F6") + "|vz=" + _vel.z.ToString("F6") +
                      "|speed=" + speed.ToString("F6") + "|trajectoryPitchDeg=" + trajectoryPitch.ToString("F6") +
                      "|boardPitchDeg=" + boardPitch.ToString("F6") +
                      "|fx=" + _fwd.x.ToString("F6") + "|fy=" + _fwd.y.ToString("F6") + "|fz=" + _fwd.z.ToString("F6") +
                      "|dfx=" + deckForward.x.ToString("F6") + "|dfy=" + deckForward.y.ToString("F6") + "|dfz=" + deckForward.z.ToString("F6") +
                      "|bux=" + _boardUp.x.ToString("F6") + "|buy=" + _boardUp.y.ToString("F6") + "|buz=" + _boardUp.z.ToString("F6") +
                      "|cnx=" + _contactN.x.ToString("F6") + "|cny=" + _contactN.y.ToString("F6") + "|cnz=" + _contactN.z.ToString("F6") +
                      "|cpx=" + _pPoint.x.ToString("F6") + "|cpy=" + _pPoint.y.ToString("F6") + "|cpz=" + _pPoint.z.ToString("F6"));
        }

        // ---- One 60 Hz physics tick ------------------------------------------------------------------------
        // Contact is a STATE of the deck, not a decision [Trailmap: 320-ground-contact]. The probe writes the signed
        // clearance (the contact error), and the rider is grounded while that clearance stays under the surface's own
        // ground_threshold - 2.7 cm on snow, 15-30 cm in powder. Nothing tests a velocity threshold to leave the
        // ground, and nothing tests for a lip: a rider crests a roll when gravity can no longer supply the centripetal
        // acceleration the surface demands (v^2/R against g*n), the clearance climbs past the threshold, and the next
        // tick is an air tick. That band is also what keeps the response's above-surface pull from welding the board
        // down: -(A/30)*error reaches 21 m/s^2 half a metre up, but the grounded state never extends that far - at the
        // band edge on snow it is 1.2 m/s^2, and an ollie crosses the band in two ticks.
        // Returns the tick's new position; velocity + orientation state mutate in place.
        Vector3 Tick(Vector3 pos, bool vr, float launchSpd)
        {
            float h = TICK_H;
            bool openingGrounded = _wasGrounded;
            _telemetryTick++;
            WedgeTick(); // the "stuck against the level" integrator decays every tick, fed below by ResolveObstacles (OutOfBounds.cs)
            _headAligned = false; // set true only by a grounded tick with the gaze settled ~down the board (VR seat-realign gate)

            // The lateral CARVE SLIDE slews every tick from the lean [Trailmap: 330-carving]: the deck - and the
            // ground probe with it - slides OUT of the turn, full magnitude at any riding speed, home through zero
            // lean. Probing under the slid deck is the carve's curvature sensor: on concave terrain (a banked
            // trail's wall-floor junction) the offset sample reads a DEEPER contact error, the three-zone response
            // climbs toward its 2A clamp, and response*tan(tilt*lean) becomes the second-half carve authority.
            // Without it, ice carve force pins at the flat-ground neutral equilibrium (~11.6 m/s^2 vs retail's
            // sustained 13-17) and the retail ice ping-pong line is unreachable.
            float slideGate = Mathf.Min(1f, _vel.magnitude * RIDE_CARVE_SLIDE_SPEED_GATE);
            _carveSlide = Mathf.MoveTowards(_carveSlide, -RIDE_CARVE_SLIDE_SCALE * _lean * slideGate, RIDE_CARVE_SLIDE_SLEW * h);

            // Grounded, the probe aims along the PREVIOUS tick's contact normal - how the engine keeps contact
            // continuous around a curve, and up a wall / bank / quarter-pipe (the surface is beside us, not below).
            // Airborne it aims world-down: _contactN is a memory of whatever was last touched, and after a steep lip
            // it points sideways, so a segment along it would sweep past the ground the rider is falling toward.
            // The probe base carries the carve slide only while grounded, so a stale contact frame cannot shift
            // touchdown detection sideways.
            Vector3 probeBase = pos;
            bool probeSlid = false;
            if (_wasGrounded && Mathf.Abs(_carveSlide) > 1e-4f)
            {
                Vector3 slideLat = Vector3.Cross(_contactN, _fwd);
                if (slideLat.sqrMagnitude > 1e-6f) { probeBase += slideLat.normalized * _carveSlide; probeSlid = true; }
            }
            if (wallRide && _wasGrounded) ProbeContact(probeBase); else Probe(probeBase);
            float error = _pFound ? ContactGap(probeBase) : RIDE_PROBE_BELOW + 1f; // out of the probe's reach = airborne
            // The slide is a RESPONSE sensor, not a contact gate - it must never itself end contact. On a wall the
            // lateral lies in the face plane, so the slid sample walks up to half a metre across it: a convex
            // shoulder reads past the ground band (2.78 cm on ice) and a mesh lip misses outright, peeling a
            // carving wall ride into the air. If the slid read would end grounded contact, re-read at the unoffset
            // deck and ride this tick on it; every tick the slid read keeps contact is untouched, so the concave
            // response build stands.
            if (probeSlid && (!_pFound || error > SurfThresh(_pFound ? _pSurf : _rideSurf)))
            {
                if (wallRide) ProbeContact(pos); else Probe(pos);
                error = _pFound ? ContactGap(pos) : RIDE_PROBE_BELOW + 1f;
            }
            _error = error;
            if (_pFound) _rideSurf = _pSurf; // off the probe's reach there is no surface to read, so the last row stands
            float thresh = SurfThresh(_rideSurf);
            float normalSpeed = _pFound ? Vector3.Dot(_vel, _pNormal) : 0f;
            // The broad type-6/10 band is a non-riding wall/bounce response. Do not let it catch and redirect a rider
            // who is already moving outward from the face; the Snowdream far-side false contacts separate at 1.4-11.8
            // m/s, while coherent transition noise in the gold trace stays below this shared tolerance.
            bool leavingUnrideable = _wasGrounded && (_pSurf == 6 || _pSurf == 10) &&
                                      normalSpeed > RIDE_CONTACT_SEPARATION_SPEED;
            bool redirectContact = _pFound && error <= thresh && !leavingUnrideable;

            // Landing on / riding a MainType-13 host resets, the same as smacking into its side. Gated on ACCEPTED
            // contact rather than mere probe reach, so passing over one at height is untouched [Unity docs/053].
            //
            // EDGE-triggered: one arrival on the host is one reset. Level-triggering it re-fired every 1.5 s (the
            // cooldown) for as long as the rider sat on the roof, and three inside 4 s is the streak that escalates
            // to a full Eject - which is why a slab landing threw the rider back to the start gate instead of onto
            // the course beside it.
            // The latch is set only when the reset ACTUALLY fires. TriggerReset refuses while the 1.5 s cooldown is
            // running or outside an active run; latching on the attempt threw that arrival away, and staying on the
            // slab produces no second edge, so the rider rode over it with nothing happening at all.
            bool onResetHost = redirectContact && _pResetHost;
            if (!onResetHost) _wasOnResetHost = false;
            else if (!_wasOnResetHost && _runActive && _oobResetCooldown <= 0f)
            {
                TriggerReset();
                _wasOnResetHost = true;
            }
            dbgResetHost = onResetHost;

            // The grounded REDIRECT - the term that keeps the stiff contact quiet, applied once the tick's motion is
            // resolved [Trailmap: 320-ground-contact]. This tick's probe IS the engine's post-integration re-probe: it
            // removes 40% of the velocity's normal component along the fresh accepted normal - both signs on a
            // coherent grounded tick - then scales the whole velocity back to its previous magnitude. No speed is lost: it is a
            // ROTATION of the velocity toward the contact plane, not damping, which is also why a landing converts
            // impact into carried speed. Without it, snow's 5 mm bog is an unstable spring under the explicit Euler
            // step (|lambda| = 1.28 per tick) and the deck buzzes on perfectly smooth ground; with it the normal
            // channel contracts at riding speed. Standing dead still it does nothing - the rescale exactly undoes the
            // kill when velocity is all normal. The two powders are exempt: their 15-25 cm bogs are stable springs on
            // their own, and the mush is the point. Runs BEFORE the ground <-> air decision, but only when the fresh
            // contact is still accepted - a rejected far-side patch is not grounded contact. An ollie tick
            // skips it because the pop has already joined the velocity when this tick opens.
            if (_wasGrounded && redirectContact && !_forcedAir && _rideSurf != 3 && _rideSurf != 4)
            {
                Vector3 rn = _pNormal;
                float rvn = Vector3.Dot(_vel, rn);
                float spd0 = _vel.magnitude;
                _vel -= rn * (RIDE_CONTACT_REDIRECT * rvn);
                float spd1 = _vel.magnitude;
                if (spd1 > 1e-8f) _vel *= spd0 / spd1;
            }

            // Wall crash (faithful, opt-in): the engine wipes out on the bounce/wall surfaces (type 6/10) past an
            // into-surface contact speed, checked AFTER the redirect [Trailmap: 320-ground-contact]. Off by default
            // (wallCrashSpeed 0) because the point here is to STICK to walls.
            if (wallCrashSpeed > 0f && _wasGrounded && _pFound && (_pSurf == 6 || _pSurf == 10))
            {
                float wallInto = -Vector3.Dot(_vel, _pNormal);
                if (wallInto > wallCrashSpeed) { Eject(); return pos; }
            }

            // Ground <-> air, with the hysteresis the engine's two state machines give it for free: the grounded state
            // ends when the clearance passes ground_threshold, and it resumes on CONTACT (error <= 0), not on
            // re-entering the band. The ollie forces the air state outright ([Trailmap: 300-rider-states]: the launch
            // fires with no contact check at all), so the pop is never spent against the response the deck has not yet
            // climbed out of.
            if (_forcedAir && error > thresh) _forcedAir = false;
            // A penetrating probe while the rider is strongly separating is a far-side crossing, not a touchdown.
            // A currently grounded rider retains the ordinary clearance hysteresis except for the unrideable rows above.
            bool approachingContact = _wasGrounded || normalSpeed <= RIDE_CONTACT_SEPARATION_SPEED;
            bool onGround = _pFound && !_forcedAir && approachingContact && !leavingUnrideable &&
                            (_wasGrounded ? error <= thresh : error <= 0f);

            // The contact fields ease in on EVERY tick, grounded or not ([Trailmap: 310-surface-response] slews in the
            // shared update), so a fall toward powder has its ~36 cm budget already easing in by the time the deck
            // arrives. Only the visual lift is ground-gated.
            float slew = RIDE_CONTACT_FIELD_SLEW * h;
            _sinkBudget = Mathf.MoveTowards(_sinkBudget, SurfBudget(_rideSurf), slew);
            _sinkBog = Mathf.MoveTowards(_sinkBog, SurfBog(_rideSurf), slew);
            _lift = Mathf.MoveTowards(_lift, onGround ? SurfLift(_rideSurf) : 0f, slew);

            // Jump COYOTE grace: "grounded for an ollie" = on the ground OR within the grace window of leaving it, so
            // a pop released during a bump-skip still fires; past it a pending charge is cancelled (no mid-air
            // double-jump). See docs/vrchat/017 (step 5).
            if (onGround) _jumpGrace = jumpCoyoteTime;
            else if (_jumpGrace > 0f) _jumpGrace -= h;
            if (!onGround && _jumpGrace <= 0f) { _charging = false; _releaseQueued = false; _charge = 0f; }

            if (onGround)
            {
                if (_wasAir)
                {
                    Touchdown();                    // one-shot air->ground: normal snap, orientation bands, hooks
                    if (!_riding) return pos;       // Touchdown can bail (landBail) - the board is released
                    // Retail enters clean ground at error zero. The discovery probe may already be penetrating, but
                    // pushout/contact response begin from the surface and build the landing transient on later ticks.
                    _error = RIDE_TOUCHDOWN_RESPONSE_ERROR;
                }
                else GroundNormalUpdate(h, launchSpd);
                pos = GroundTick(pos, h, vr);
                _airTime = 0f;
                _wasAir = false;
                _flipArmed = false; // grounded -> any air flip is over; the deck follows the active grounded pose law
                _airBoostActive = false; // grounded -> the boost sfx gate is onGround again
            }
            else
            {
                AirTick(h, vr);
                _wasAir = true;
            }
            _wasGrounded = onGround;
            if (openingGrounded && !onGround) _telemetryEvents |= 1;
            else if (!openingGrounded && onGround) _telemetryEvents |= 2;

            // Charged ollie (engine antic/jump CONTROL state, docs/vrchat/017): build charge while Use is held, launch
            // on the queued release - decoupled from the live ground/air state, so a coyote-frame release still pops.
            // The coyote block above already zeroed _charging/_releaseQueued once genuinely airborne.
            if (_charging) _charge = Mathf.Min(1f, _charge + chargeRate * h);
            if (_releaseQueued)
            {
                if (_ollieCooldown <= 0f) LaunchOllie();  // pop + cooldown + sound + forced air, off the cached contact normal
                _releaseQueued = false;                   // consume the release even if cooling (mount-grace swallow)
                _charge = 0f;
            }

            // Speed cap [Trailmap: 360-speed-and-boost]: a shared cap that only ever bounds speed from above. Boost
            // selects the top tier, and the AIRBORNE integrator re-arms at that same top tier, so a jump never bleeds
            // carried speed. It snaps UP and eases DOWN, so an expiring boost bleeds off smoothly instead of clipping.
            float capTarget = (BoostActive() || !onGround) ? BOOST_MAX_SPEED : MAX_SPEED;
            if (capTarget >= _speedCap) _speedCap = capTarget;
            else _speedCap = Mathf.MoveTowards(_speedCap, capTarget, BOOST_CAP_DECAY * h);
            float spd = _vel.magnitude;
            if (spd > _speedCap) _vel *= _speedCap / spd;

            // The integration, in the engine's own order: POSITION first, with the tick's opening velocity, then
            // VELOCITY, with the acceleration frozen at the tick's opening state - plain explicit Euler
            // [Trailmap: 320-ground-contact]. It survives snow's 5 mm bog - a spring this step cannot integrate stably
            // on its own - because the grounded redirect at the top of the NEXT tick rotates the ringing back into the
            // contact plane. The spring, the step, the pushout and the redirect are one mechanism split across the
            // tick; port any subset alone and the contact is a different game (the spring without the redirect buzzes;
            // a semi-implicit step without either is quiet but mushier than the original). The position step
            // collide-and-slides off solid props/walls - but NOT while riding a steep face (onWall): there the contact
            // model owns the wall, and letting the obstacle sweep ALSO treat it as a blocker would fight the wall-ride.
            bool onWall = wallRide && onGround && _contactN.y < wallNormalMax;
            Vector3 displacement = _vel * h;
            _vel += _tickAccel * h;
            // Finish impacts after acceleration so cruise cannot immediately cancel their outward response.
            Vector3 newPos = (collideWithProps && !onWall) ? ResolveObstacles(pos, displacement) : pos + displacement;
            if (onGround && !_grinding) GroundSteering(h, vr);
            return newPos;
        }

        // Air -> ground, one-shot ([Trailmap: 340-jump-air-landing] Touchdown). A clean landing enters the grounded
        // state directly - the full contact-plane velocity projection belongs to the WIPEOUT state, not to an ordinary
        // landing, so it is not here, and there is no impact-ramp speed scrub. The arriving normal speed is taken out
        // by the pushout's vn-kill the moment the deck passes its budget, the redirect converts the rest into carried
        // speed, and the plunge that follows is the contact response's own transient. What does apply are the two
        // ORIENTATION error bands - square landings keep their speed. They need no "is this a real landing" gate: after
        // a bump-skip both error angles are ~0, so they multiply by 1 and cost nothing. A cartwheel pays.
        void Touchdown()
        {
            Vector3 rawN = _pNormal;
            // A re-landing only counts as REAL (snap-worthy) air past the shared orientation grace; a brief bump-skip eases the
            // contact normal instead, so fast riding over bumps doesn't snap the deck every tick.
            bool realLanding = _airTime > RIDE_ORIENTATION_GRACE;
            if (realLanding || _pAnalytic) _contactN = rawN;
            else _contactN = Vector3.Slerp(_contactN, rawN, TICK_H / (normalSmoothing + TICK_H)).normalized;

            float impact = -Vector3.Dot(_vel, rawN); // the ARRIVING into-surface speed; the contact model converts it after this
            if (impact < 0f) impact = 0f;

            // Landing thud: quiet on a soft touchdown, loud on a slam.
            if (eventSource != null && landClip != null)
            {
                float lv = Mathf.Clamp01(impact / Mathf.Max(1f, landHardImpact));
                if (lv > 0.05f) eventSource.PlayOneShot(landClip, Mathf.Clamp01((0.25f + 0.75f * lv) * soundVolume));
            }
            // Snow puff on touchdown (docs/vrchat/032) [Trailmap: 380-carve-effects]: the 40-slot surface spray seeds its
            // emit motion-scalar to ~70 (speed-scaled), decaying x0.9467/tick to a ~10 floor over ~0.6 s - the
            // surface's own sprite dusts the touchdown (subtle on groomed, a real clod puff on powder).
            if (snowParticles && impact > 4f)
                _surfBurst = surfLandingSeed * Mathf.Min(1f, _vel.magnitude / 2.78f); // game: seed * min(1, speed/277.78u)

            // Hard-slam wipeout (opt-in): eject on an arriving impact past landHardImpact.
            if (landBail && realLanding && impact >= landHardImpact) { Eject(); return; }

            // The two orientation error bands [Trailmap: 340-jump-air-landing]: the tighter band takes the deck-vs-
            // surface TILT (free to 15 deg, x0.85 at 50), the looser one the facing-vs-travel YAW (free to 25 deg,
            // x0.75 at 80). _boardUp here is the INCOMING deck up, so an unfinished flip arrives crooked and pays.
            float tilt = Vector3.Angle(_boardUp, rawN);
            float yawErr = 0f;
            Vector3 travel = Vector3.ProjectOnPlane(_vel, rawN);
            if (travel.sqrMagnitude > 1e-4f)
            {
                Vector3 face = Vector3.ProjectOnPlane(_fwd, rawN);
                if (face.sqrMagnitude > 1e-6f) yawErr = Vector3.Angle(face, travel);
            }
            _vel *= LandBand(tilt, 15f, 50f, 0.85f) * LandBand(yawErr, 25f, 80f, 0.75f);

            if (realLanding)
            {
                RunLastImpact = impact; RunLastAlignErr = tilt; // HUD landing debug (Score partial)
                // BAD LANDING for SCORING (docs/050): a badly-misaligned REAL touchdown (an unfinished flip meeting the
                // slope near-sideways) zeroes the in-progress trick - no points - but does NOT eject (that stays
                // landBail's job). The scorer (ScoreUpdate) reads this flag on the landing bank.
                if (badLandingZerosTrick && tilt >= landAlignBad) _scoreBadLanding = true;
                RaceLandingHook(_airTime); // announcer landing call (reads the airtime before the grounded tick resets it)
            }
        }

        // One touchdown band: 1.0 below `free`, ramping to `floorScale` at `hard` [Trailmap: 340-jump-air-landing].
        float LandBand(float err, float free, float hard, float floorScale)
        {
            float t = (err - free) / (hard - free);
            if (t < 0f) t = 0f; else if (t > 1f) t = 1f;
            return 1f - (1f - floorScale) * t;
        }

        // Contact-normal update for a tick that STAYED grounded. The engine low-passes nothing - it rides an analytic
        // surface [Trailmap: 320-ground-contact] - and the analytic patch contact is smooth here too; the faceted
        // fallback inherits facet steps and takes normalSmoothing as its compensation.
        void GroundNormalUpdate(float h, float launchSpd)
        {
            Vector3 rawN = _pNormal;
            if (_pAnalytic)
            {
                // The engine rides the analytic surface directly. Temporal filtering belongs only to the faceted fallback.
                _contactN = rawN;
            }
            else if ((_vel.y > launchSpd || Vector3.Dot(_vel, _contactN) > RIDE_LAUNCH_OUTWARD_SPEED) &&
                     Vector3.Angle(_contactN, rawN) > 12f && rawN.y > wallNormalMax)
            {
                // Cresting a LIP while launching (rising > launchSpd) and the ground probe just jumped >12 deg to the
                // lip-top / far face: tracking it would FLATTEN/nose-drop the deck for the last grounded tick before
                // the air level-off takes over. HOLD the takeoff normal so the deck keeps its ramp pitch into the air.
                // Self-releases: airborne within a tick or two (then world-up leveling owns it), and a real landing snaps
                // _contactN fresh. GATED to a FLATTENING normal (rawN.y > wallNormalMax): riding UP a wall also rises
                // with a >12 deg normal swing, but there the normal tilts toward HORIZONTAL (rawN.y low) and we must
                // NOT hold - the Slerp below has to ease _contactN onto the wall so ProbeContact keeps following it up
                // (the wall-ride). Only a lip, which crests toward a near-up normal, takes this hold.
            }
            else _contactN = Vector3.Slerp(_contactN, rawN, h / (normalSmoothing + h)).normalized;
        }

        // Accumulate contact, resistance, cruise and boost, then apply bounded pushout.
        // Tick integrates position/velocity before GroundSteering changes the physical heading.
        Vector3 GroundTick(Vector3 pos, float h, bool vr)
        {
            Vector3 n = _contactN;
            int surf = _pSurf, row = SurfRow(surf);
            Vector3 ride = Vector3.ProjectOnPlane(_fwd, n).normalized;
            Vector3 side = Vector3.Cross(n, ride);
            float vn = Vector3.Dot(_vel, n), u = Vector3.Dot(_vel, ride), w = Vector3.Dot(_vel, side);
            float A = SurfA(surf);
            float response = ContactResponse(A, SurfP(surf), _error, vn, _sinkBog, _sinkBudget);
            float capped = Mathf.Min(response, 2f * A / 100f);
            float assist = SurfIceAssist(surf);
            float theta = SurfCarveTilt(surf, assist) * Mathf.Deg2Rad * _lean;
            // [Trailmap: 330-bank-force] Residual normal response plus the banked force and world-down load.
            _tickAccel = n * RideBankedNormalResponse(response, capped, theta)
                + side * (capped * Mathf.Tan(theta)) + Vector3.down * (A / 100f);
            float boost = BoostActive() ? 1f : 0f;
            _tickAccel += ride * RideForwardResistance(row, u, _error, _sinkBudget, _charge, boost);
            _tickAccel += side * RideLateralResistance(row, u, w, _lean, boost);
            _slip = Mathf.Abs(w);
            if (assist > 0f)
            {
                float want = -Mathf.Sqrt(u * u + w * w) * Mathf.Sin(RideHeadingLead(_lean, _charge));
                float corrected = want + (w - want) / (1f + lowGripSlipRecover * assist * h);
                _tickAccel += side * ((corrected - w) / h);
            }
            if (_throttle > 0f) _tickAccel += ride * (pushStrength * _throttle * Mathf.Clamp01(1f - u / pushCapSpeed));
            else if (_throttle < 0f) _tickAccel += ride * ((Mathf.MoveTowards(u, 0f, -_throttle * brakeStrength * h) - u) / h);
            float speedNow = _vel.magnitude;
            float deficit = Mathf.Min(SurfTarget(surf) - speedNow, RIDE_CRUISE_DEFICIT_MAX);
            if (deficit > 0f && speedNow > 0.5f)
            {
                float offDeg = Mathf.Acos(Mathf.Clamp(u / speedNow, -1f, 1f)) * Mathf.Rad2Deg;
                float driveAlign = Mathf.Clamp01((60f - offDeg) / 30f);
                _tickAccel += ride * (RIDER_DRIVE * driveAlign * SurfMult(surf) * deficit);
            }
            if (boost > 0f) _tickAccel += ride * (BOOST_ACCEL * Mathf.Clamp01(1f - Mathf.Abs(_lean) / BOOST_LEAN_WINDOW));
            if (_throttle < 0f && u * (u + Vector3.Dot(_tickAccel, ride) * h) < 0f)
                _tickAccel += ride * (-u / h - Vector3.Dot(_tickAccel, ride));
            float excess = _sinkBudget + _error;
            if (excess < -RIDE_PUSHOUT_CAP && n.y >= wallNormalMax) excess = -RIDE_PUSHOUT_CAP;
            if (excess < 0f)
            {
                pos -= n * excess;
                _vel -= n * vn;
                _error -= excess;
                float into = Vector3.Dot(_tickAccel, n);
                if (into < 0f) _tickAccel -= n * into;
            }
            return pos;
        }

        void GroundSteering(float h, bool vr)
        {
            Vector3 n = _contactN;
            int surf = _pSurf;
            float assist = SurfIceAssist(surf);
            // --- Steering: the SSX heading model (docs/vrchat/020) [Trailmap: 330-carving]. A stick "lean" yaws the heading around the
            // contact normal toward a REFERENCE direction, LEADING it by the lean angle; the carve below drags the
            // velocity to follow. The yaw is speed-GATED UP (quadratic) and capped at GROUND_TURN_RATE, surface-
            // INDEPENDENT (forward resistance does not set yaw). The self-centering slip term makes the cap a bounded carve angle.
            float vmag = _vel.magnitude;
            Vector3 fwdN = Vector3.ProjectOnPlane(_fwd, n);
            fwdN = fwdN.sqrMagnitude > 1e-6f ? fwdN.normalized : _fwd;
            Vector3 velN = Vector3.ProjectOnPlane(_vel, n);
            Vector3 velDir = velN.sqrMagnitude > 1e-4f ? velN.normalized : fwdN;

            // The direction the heading homes onto: in VR head-steer your GAZE; otherwise your VELOCITY (let go of the
            // stick and the board straightens onto its travel). Head-steer stays VR-only. The gaze also drives the
            // shared input->lean slew below whenever the stick is centred (headLeanFullAngle), so a head-steered turn
            // EDGES the board instead of only aiming the nose - the facing yaw alone cannot bend an ice line.
            bool headOn = headLookSteer && (!headLookVROnly || vr) && vr;
            Vector3 refDir = velDir;
            float headSteer = 0f; // gaze-derived steer intent: 0 inside the deadzone, full at headLeanFullAngle past it
            if (headOn)
            {
                VRCPlayerApi.TrackingData head = _player.GetTrackingData(VRCPlayerApi.TrackingDataType.Head);
                Vector3 gaze = Vector3.ProjectOnPlane(head.rotation * Vector3.forward, n);
                if (gaze.sqrMagnitude > 1e-5f)
                {
                    gaze = gaze.normalized;
                    float off = Mathf.Atan2(Vector3.Dot(Vector3.Cross(fwdN, gaze), n), Vector3.Dot(fwdN, gaze));
                    bool settled = Mathf.Abs(off) <= headLookDeadzone * Mathf.Deg2Rad;
                    refDir = settled ? fwdN : gaze; // within deadzone: just hold
                    _headAligned = settled;         // settled -> let the seat ease to square up with the deck (orientation block)
                    // The gaze LEAN measures the gaze against the TRAVEL direction, never the heading: the yaw closure
                    // below parks the heading on the gaze within ~0.1 s (and at equilibrium LEADS it by turnLean, which
                    // flips a heading-referenced offset's sign), so a heading-referenced lean self-cancels before its
                    // tilt force can act - on ice, where that force is the only thing that bends the path, a head turn
                    // then does nothing. Against travel it mirrors the stick's own loop: the lean holds while the PATH
                    // still points away from the gaze and ebbs as the carve brings it around. Same Atan2 frame as
                    // slipRef/slipVel, so gaze right of travel -> positive -> the rightward tilt force.
                    if (headLeanFullAngle > 0f)
                    {
                        float offTravel = Mathf.Atan2(Vector3.Dot(Vector3.Cross(velDir, gaze), n), Vector3.Dot(velDir, gaze));
                        if (Mathf.Abs(offTravel) > headLookDeadzone * Mathf.Deg2Rad)
                            headSteer = Mathf.Sign(offTravel) * Mathf.Clamp01(
                                (Mathf.Abs(offTravel) - headLookDeadzone * Mathf.Deg2Rad) / (headLeanFullAngle * Mathf.Deg2Rad));
                    }
                }
                else _headAligned = true; // looking straight up/down the normal (no yaw to steer) counts as settled
            }

            // Lean: smooth the steer intent through the game's shared input slew. The STICK owns the lean whenever it
            // is deflected; a centred stick hands it to the gaze offset (VR head-steer), so a head turn carves with
            // the real tilt force and builds the carve slide/response exactly like a stick turn - ice included.
            // Builds/ebbs over ~0.15 s, ramps in with speed, and slews slower on powder.
            bool stickActive = StickActive();
            float steerIntent = stickActive ? StickSteer() : headSteer;
            float speedRef = resistanceMode == 2 ? 11.3827f : resistanceMode == 0 ? 11.3497f : 11.1901f;
            float leanTarget = Mathf.Clamp(steerIntent, -0.9051856f, 0.9051856f) * Mathf.Min(1f, vmag / speedRef);
            float leanRate = Mathf.Clamp(Mathf.Abs(leanTarget - _lean) * 7.017359f, 0.1f, 8.018349f);
            if (surf == 3 || surf == 4) leanRate *= 0.5999726f; // powder steers into the lean slower
            _lean = Mathf.MoveTowards(_lean, leanTarget, leanRate * h);
            float turnLean = RideHeadingLead(_lean, _charge) * RIDE_STEER_STRENGTH;
            float slipRef = Mathf.Atan2(Vector3.Dot(Vector3.Cross(refDir, fwdN), n), Vector3.Dot(refDir, fwdN));
            float slipVel = Mathf.Atan2(Vector3.Dot(Vector3.Cross(velDir, fwdN), n), Vector3.Dot(velDir, fwdN));
            Vector3 fallLine = n * n.y - Vector3.up;
            fallLine = fallLine.sqrMagnitude > 1e-8f ? fallLine.normalized : fwdN;
            float projection = Vector3.Dot(Vector3.Cross(_vel, fwdN), n) / Mathf.Max(vmag, 1e-6f);
            if (headOn) projection = Mathf.Sin(slipRef); // VR reference adaptation.
            float rawYaw = RideHeadingYaw(_lean, turnLean, projection, vmag,
                Vector3.Dot(_vel, fwdN), Vector3.Dot(_vel, fallLine), h);
            // Low-grip assist term 1: damp the yaw only while it is UN-COMMITTING - the commanded lead has fallen
            // inside the drift already being carried, and lies on the same side of it, so the closure is walking the
            // heading out onto that drift. Both guards matter: the magnitude test alone would also fire while the
            // rider is REVERSING the carve (lead and drift on opposite sides), which is the one moment full retail
            // authority is most wanted. Entering a carve fails the magnitude test and is likewise untouched.
            //
            // The gate reads slipVel (the DRIFT), never slipRef, while the yaw itself stays referenced to slipRef.
            // Under head-steer those are different quantities - slipRef measures the GAZE against the heading - so a
            // slipRef-gated damp would key on where the rider is looking rather than on the drift. That also makes
            // the same-side guard do real work here that it never had to do in Slopesmith: looking ACROSS a drift to
            // correct it puts the lead opposite the slip, which now correctly exempts the correction from damping.
            // Slopesmith cannot show any of this - it has no head-steer and aliases `slipVel = slipRef`.
            //
            // Damps the CLAMPED yaw: the re-alignment runs into the 6 deg/tick cap, so scaling the pre-clamp closure
            // fraction would not reach it. Gating on "is the input centred" also does not work - the lean slews to
            // zero over ~0.14 s while three quarters of the re-alignment is already done (measured: 77/23 -> 73/27,
            // i.e. nothing), so the condition has to be the yaw's DIRECTION rather than the input's state.
            if (assist > 0f && turnLean * slipVel >= 0f && Mathf.Abs(turnLean) < Mathf.Abs(slipVel))
                rawYaw *= 1f - assist * lowGripSelfCenterDamp;
            float yawDeg = rawYaw * Mathf.Rad2Deg;
            // Seat/view carry (VR only): the STICK's full turn intent rotates the upright seat with the board, the
            // same full-strength carry the air spin applies. It is intent (turnLean), not the applied board yaw, and
            // gaze-derived lean must NEVER enter it: gaze rotating the seat is a feedback spin (look left -> lean ->
            // seat drags left -> gaze reads further left), so a gaze-led turn leaves the seat pinned and look-to-steer
            // stays self-limiting.
            float seatTurnLean = stickActive ? turnLean : 0f;
            // Headset-tested grounded comfort carry: the seat/view receives a quarter of the already-clamped stick turn.
            // It is applied AFTER the clamp; applying it before still lets full-stick/high-speed turns hit 6 deg/tick.
            float seatYaw = RideHeadingYaw(_lean, seatTurnLean, 0f, vmag, Vector3.Dot(_vel, fwdN), Vector3.Dot(_vel, fallLine), h)
                          * Mathf.Rad2Deg * VR_GROUND_STICK_VIEW_CARRY;
            _fwd = Quaternion.AngleAxis(yawDeg, n) * fwdN;
            if (vr) _seatFwd = Quaternion.AngleAxis(seatYaw, Vector3.up) * _seatFwd;
            _fwd = Vector3.ProjectOnPlane(_fwd, n);
            if (_fwd.sqrMagnitude < 1e-6f) _fwd = Vector3.ProjectOnPlane(transform.forward, n);
            _fwd = _fwd.normalized;

        }

        // The air integrator [Trailmap: 340-jump-air-landing] - a separate integrator with no contact term at all,
        // which is why the grounded response's above-surface pull can never reach a rider who has left the band.
        // Two-stage gravity (weak rising, strong falling) is the whole vertical model; horizontal velocity is only
        // damped, never rebuilt, so takeoff carry survives to the landing. Input is angular control on the deck.
        void AirTick(float h, bool vr)
        {
            _tickAccel = new Vector3(-RIDE_AIR_HORIZONTAL_DRAG * _vel.x,
                                     -(_vel.y > 0f ? RIDE_AIR_GRAVITY_RISING : RIDE_AIR_GRAVITY_FALLING),
                                     -RIDE_AIR_HORIZONTAL_DRAG * _vel.z);
            _airTime += h; // the shared orientation grace distinguishes a bump-skip from real air
            _slip = 0f;    // no snow contact in the air -> no carve/skid layer

            // AIR BOOST: held boost in the air thrusts toward where the boost HAND points (VR - the same LEFT hand
            // squeezing the trigger, the flight's point-to-fly gesture on the deck, docs/vrchat/024) / where you LOOK
            // (desktop, no tracked hand) - full 360, so aiming up stretches the air, aiming down dives at the landing,
            // aiming sideways reaches a rail. Hand, not head, in VR: the head already gaze-steers the board in the air
            // (HeadFollow), so a head aim could only ever thrust where you're looking - the hand lets you eye the rail
            // and retro-thrust toward or away from it. Far weaker than the flight's 30 m/s^2; folded into _tickAccel
            // so it integrates in the engine's own explicit-Euler order. Meter-gated like the held boost itself.
            // Embellishment: the engine's air states read no boost field (airBoostAccel 0 = off).
            //
            // TWO REGIMES around the shared speed cap, cross-faded over the last ~2 m/s so there is no seam:
            //   BELOW it - plain thrust, as always (it bends AND speeds the arc; the cap still bounds the result).
            //   AT it - plain thrust silently dies (the clamp renormalizes |v| right back down, discarding exactly
            //   what was added), so the aim is DECOMPOSED against the travel direction: the against-travel part stays
            //   real deceleration (the cap only bounds from above, so braking always lands - the soft-landing flare),
            //   a with-travel part is dropped (the clamp would only eat it), and the SIDEWAYS part ROTATES the
            //   velocity toward the aim at up to airBoostTurnRate deg/s - magnitude-preserving, so the clamp has
            //   nothing to eat, and turn authority no longer collapses with speed (8 m/s^2 of raw thrust at the
            //   33.5 m/s cap bends the arc only ~14 deg/s).
            // _airBoostActive stays HONEST: false when the boost is doing nothing (pinned at the cap aiming with
            // travel), so the boost roar no longer plays over a clamped-dead thrust (UpdateBoostAudio).
            _airBoostActive = false;
            if (airBoostAccel > 0f && holdBoostEnabled && _boostHeld && BoostMeterHasCharge() && _player != null)
            {
                VRCPlayerApi.TrackingData aimSrc = _player.GetTrackingData(
                    vr ? VRCPlayerApi.TrackingDataType.LeftHand : VRCPlayerApi.TrackingDataType.Head);
                Vector3 aim = aimSrc.rotation * Vector3.forward;
                if (aim.sqrMagnitude > 1e-6f)
                {
                    aim = aim.normalized;
                    float spd = _vel.magnitude;
                    float capness = Mathf.Clamp01((spd - (_speedCap - 2f)) * 0.5f); // 0 = real headroom, 1 = pinned at the cap
                    if (capness < 1f)
                    {
                        _tickAccel += aim * (airBoostAccel * (1f - capness));
                        _airBoostActive = true; // adding real speed/bend - the boost sfx runs (UpdateBoostAudio)
                    }
                    if (capness > 0f) // spd is within 2 m/s of the cap (>= ~26) here, so the travel direction is well-defined
                    {
                        Vector3 vDir = _vel / spd;
                        float par = Vector3.Dot(aim, vDir);
                        if (par < 0f) { _tickAccel += vDir * (par * airBoostAccel * capness); _airBoostActive = true; } // brake
                        Vector3 perp = aim - vDir * par; // sideways part of the aim (|perp| = sin of the off-travel angle)
                        // A board built before this knob existed reads 0 here (the new-field default gotcha) - that
                        // means the 40 default; only a NEGATIVE value turns the at-cap bend off deliberately.
                        float turnRate = airBoostTurnRate == 0f ? 40f : airBoostTurnRate;
                        if (turnRate > 0f && perp.sqrMagnitude > 1e-6f)
                        {
                            Vector3 axis = Vector3.Cross(vDir, perp).normalized;
                            _vel = Quaternion.AngleAxis(turnRate * capness * perp.magnitude * h, axis) * _vel;
                            _airBoostActive = true; // bending the arc - the sfx runs
                        }
                    }
                }
            }

            // TRICK-BOOST spin-up: while boosting, the game's x1.6 trick-boost spin constant (rail state 16 in the
            // engine) is lifted onto the stick-driven air yaw-spin AND the flip (below). Applied to the SPIN inputs
            // only, not HeadFollow (head-aim rotates-toward-and-stops; scaling it would overshoot the head direction).
            float spinBoostMul = (airTrickBoostSpinMul > 1f && BoostActive()) ? airTrickBoostSpinMul : 1f;
            float stickYawAir = StickSteer() * RIDE_AIR_TURN_RATE * spinBoostMul * h;
            // AIR-state direct yaw rate (x1.6 while boosting). Precision shapes partial deflection but full lock remains
            // 100%; only the grounded 25% view carry stops at takeoff, so the aerial seat follows this yaw in full.
            _fwd = Quaternion.AngleAxis(stickYawAir, _boardUp) * _fwd; // stick air-steer
            if (scoringEnabled) _scoreSpinDeg += stickYawAir < 0f ? -stickYawAir : stickYawAir; // bank the spin (run score)
            // Full-rate AIR view carry. On desktop it starts with the same real-air test the orientation block uses, so
            // a sub-grace bump skip keeps the ground damper/cap and is not double-rotated. A real launch (or sustained
            // air past the grace) bypasses those ground filters and preserves the takeoff offset instead of snapping the
            // seat onto the deck. In VR this remains the existing behavior: grounded quarter-carry ends at takeoff and
            // the air spin carries the seat at 100%.
            bool carryAirSeat = vr || _airTime > RIDE_ORIENTATION_GRACE ||
                                _vel.y > RIDE_LAUNCH_WORLD_UP_SPEED ||
                                Vector3.Dot(_vel, _contactN) > RIDE_LAUNCH_OUTWARD_SPEED;
            if (carryAirSeat) _seatFwd = Quaternion.AngleAxis(stickYawAir, Vector3.up) * _seatFwd;
            Vector3 fwdPreHead = _fwd;
            _fwd = HeadFollow(_fwd, _boardUp, h, RIDE_AIR_TURN_RATE); // head-steer (VR only) yaws the board in the air at the air rate
            if (scoringEnabled) // count VR head-look spins too: the in-deck-plane angle HeadFollow yawed = the exact head-spin this tick
            {
                Vector3 hSpinA = Vector3.ProjectOnPlane(fwdPreHead, _boardUp);
                Vector3 hSpinB = Vector3.ProjectOnPlane(_fwd, _boardUp);
                if (hSpinA.sqrMagnitude > 1e-6f && hSpinB.sqrMagnitude > 1e-6f) _scoreSpinDeg += Vector3.Angle(hSpinA, hSpinB);
            }
            // AIR FLIP (stick-Y): somersault the deck nose-over-tail. We rotate BOTH the heading (_fwd) and the deck-up
            // (_boardUp) RIGIDLY about the deck's right axis, so it's a true full somersault (rotating only _boardUp would
            // gimbal-lock at vertical). Once armed it suppresses the auto-level + landing pre-align, so the deck HOLDS
            // the rotation you leave it at and an unfinished flip lands crooked -> the touchdown tilt band bleeds
            // speed (finish near level to land clean). Visual on the deck only: the seat/view stays upright (carried by
            // _seatFwd, yaw-only), so no inversion/nausea. Stick-X spin (above) still composes with it for flip+spin.
            if (airTrickEnabled && Mathf.Abs(_throttle) > airTrickDeadzone)
            {
                Vector3 rightAx = Vector3.Cross(_boardUp, _fwd); // deck's right axis (pitch axis)
                if (rightAx.sqrMagnitude > 1e-6f)
                {
                    rightAx = rightAx.normalized;
                    // push fwd (W, _throttle>0) = frontflip by default; airFlipInvert swaps it.
                    // spinBoostMul (computed above) applies the trick-boost x1.6 to the somersault rate while boosting.
                    float flipDeg = (airFlipInvert ? -_throttle : _throttle) * airFlipRate * spinBoostMul * h;
                    Quaternion flip = Quaternion.AngleAxis(flipDeg, rightAx);
                    _fwd = flip * _fwd;
                    _boardUp = flip * _boardUp;
                    _flipArmed = true;
                    if (scoringEnabled) _scoreFlipDeg += flipDeg < 0f ? -flipDeg : flipDeg; // bank the flip (run score)
                }
            }
            // We DON'T wipe the charge/queued ollie here: a charge started on the ground must survive a brief bump-
            // skip and still launch (Tick's coyote block cancels it once airborne past jumpCoyoteTime).
        }

        // Edge-pivot lift (m) for the carve bank. The engine rolls the deck but never lifts it, so a bank about the deck
        // CENTRELINE drops the downhill edge by halfWidth*sin(bank) - i.e. half the board sinks through the snow at a
        // steep carve. Lifting the visible deck by that amount along the slope normal makes the bank pivot about the
        // planted downhill EDGE: the edge stays on the snow, the body rises (the real carving silhouette). Uses the same
        // avatar-scaled board half-width the wake uses. Returns 0 when bankLiftScale is 0 or the bank is level, so callers
        // can apply it every frame.
        float DeckBankLift()
        {
            float halfW = trailWidthMin * 0.5f * _riderScale;   // deck half-width (m), avatar-fit scaled
            return halfW * Mathf.Sin(Mathf.Abs(_bank) * Mathf.Deg2Rad) * bankLiftScale;
        }

        // Ground Y under an arbitrary XZ (terrain only, our own board skipped), WITHOUT touching the _p* ride-probe fields.
        // Returns the nearest up-facing terrain hit's Y, or a large-negative sentinel (< -1e8) when nothing is found.
        // The wake uses it to keep its leading cap on terrain without disturbing the active ride-probe result.
        float SampleGroundY(Vector3 atXZ, float fromY, float length)
        {
            float best = -1e9f;
            float nearest = 1e9f;
            int nHits = Physics.RaycastNonAlloc(new Vector3(atXZ.x, fromY, atXZ.z), Vector3.down, _hitBuf, length);
            bool haveTerrain = _colliders != null && _colliders.Length > 0;
            for (int i = 0; i < nHits; i++)
            {
                Collider c = _hitBuf[i].collider;
                if (c == _ownCollider) continue;
                int ci = IndexOf(c);
                int ty = ci >= 0 ? _types[ci] : -1;
                if (haveTerrain && ty == -1)                 // not a terrain surface...
                {
                    if (!IsRideableProp(c)) continue;        // ...skip non-surface props (sign boxes / triggers / bags)
                    ty = propRideSurfaceType;                // ...but ride solid prop proxies (bridges/ramps) - docs/vrchat/035
                }
                if (_hitBuf[i].normal.y <= 0f) continue;     // floors only (skip undersides / walls)
                if (_hitBuf[i].distance < nearest) { nearest = _hitBuf[i].distance; best = _hitBuf[i].point.y; }
            }
            return best;
        }

        // Gaze steering (YAW ONLY), used by the AIR branch (the grounded branch folds head-steer into its carve model's
        // reference direction instead): rotate the board's heading toward where the rider is looking and STOP at
        // alignment. We project head-forward onto the RIDE PLANE (planeN), stripping the look's up/down so only left/right
        // head-turn steers; then slew _fwd toward the projected gaze at the state's rate, within a deadzone.
        // rateDegPerSec is the already-selected active-state rate, so the same value owns stick and VR head-steer.
        Vector3 HeadFollow(Vector3 fwd, Vector3 planeN, float dt, float rateDegPerSec)
        {
            if (!headLookSteer || _player == null) return fwd;
            if (headLookVROnly && !_player.IsUserInVR()) return fwd;
            VRCPlayerApi.TrackingData head = _player.GetTrackingData(VRCPlayerApi.TrackingDataType.Head);
            Vector3 hf = Vector3.ProjectOnPlane(head.rotation * Vector3.forward, planeN);
            if (hf.sqrMagnitude < 1e-6f) return fwd; // looking straight up/down the normal - no yaw to follow
            hf = hf.normalized;
            // Measure the misalignment IN THE RIDE PLANE: flatten the heading onto planeN too. In the air _fwd keeps its
            // takeoff PITCH while planeN levels back toward world-up, so the raw 3D angle stays inflated and never reaches
            // the deadzone -> the board overshoots the gaze azimuth and jitters (VR-only; desktop returns early above).
            // The flattened heading makes deg the TRUE in-plane yaw, so the deadzone catches and it converges; the
            // rotation still spins the raw fwd about planeN (preserving its pitch for the landing). See docs/vrchat/017.
            Vector3 fwdN = Vector3.ProjectOnPlane(fwd, planeN);
            if (fwdN.sqrMagnitude < 1e-6f) return fwd; // heading points straight along the normal - no in-plane yaw to steer
            fwdN = fwdN.normalized;
            float dot = Mathf.Clamp(Vector3.Dot(fwdN, hf), -1f, 1f);
            float deg = Mathf.Acos(dot) * Mathf.Rad2Deg;
            if (deg <= headLookDeadzone) return fwd; // already pointed where you look -> stop turning
            float step = rateDegPerSec * dt;
            float reach = deg - headLookDeadzone;
            if (step > reach) step = reach;          // don't overshoot past your gaze
            float sign = Vector3.Dot(Vector3.Cross(fwdN, hf), planeN) < 0f ? -1f : 1f;
            return Quaternion.AngleAxis(sign * step, planeN) * fwd;
        }

        // Collide-and-slide the intended move ('disp', from 'from') off admitted solid props and walls, returning the
        // resolved end position and removing the into-wall part of _vel. Native PlayerBounce-off contacts are omitted
        // from solid buckets; obstacleBounce=0 is the generic/manual fallback for colliders with no native metadata. Each
        // iteration sweeps the rider capsule (RiderProbe dims) along the remaining move, stops at the nearest WALL-LIKE
        // hit, and slides the rest along that face; a few iterations let corners resolve. We exclude by hit-normal, not
        // terrain membership (up-facing = ridable ground the down-probe owns; steep = a wall/prop to block on), so terrain
        // WALLS block too. Triggers are skipped (anchored crash bags still knock); our own deck box + probe are skipped.
        // See docs/vrchat/017 (collide-and-slide).
        Vector3 ResolveObstacles(Vector3 from, Vector3 disp)
        {
            if (_capRadius <= 0f) return from + disp; // no probe capsule cached (old board) -> feature off
            Vector3 pos = from;
            Vector3 remaining = disp;
            int embeddedCount = 0;  // colliders this sweep found itself already inside -> Depenetrate below
            float wedgeFrame = 0f; // the hardest object shove any iteration of this sweep landed -> the wedge integrator
            for (int it = 0; it < 4; it++)
            {
                float dist = remaining.magnitude;
                if (dist < 1e-5f) break;
                Vector3 dir = remaining / dist;
                // Raise the sweep's BOTTOM sphere to ~torso height (sweepFootClearance) so the deck + legs can ride down
                // into a concave dip without the capsule embedding in the faceted collider (the old jam). Clamped below
                // the top sphere so the capsule stays valid. The trigger probe + foliage cast keep the full _capLow.
                float swLow = _capLow + sweepFootClearance; if (swLow > _capHigh) swLow = _capHigh;
                Vector3 p0 = pos + Vector3.up * swLow;
                Vector3 p1 = pos + Vector3.up * _capHigh;
                int nHits = Physics.CapsuleCastNonAlloc(p0, p1, _capRadius, dir, _hitBuf, dist + obstacleSkin, ~0, QueryTriggerInteraction.Ignore);
                float nearest = 1e9f; bool found = false; Vector3 hn = Vector3.up; float hitBounce = obstacleBounce;
                bool hitPlayerBounce = false; Collider hitCol = null;
                for (int i = 0; i < nHits; i++)
                {
                    Collider c = _hitBuf[i].collider;
                    // A CapsuleCastNonAlloc slot can come back with a null collider (a hit invalidated mid-sweep, e.g. a
                    // breakable/gem destroyed this frame, or a degenerate overlap). Skip it FIRST: the checks below deref c
                    // (GetComponent<PhysicsProp> lowers to c.transform.GetComponents in Udon), and a null c there throws
                    // a NullReferenceException that HALTS the whole board UdonBehaviour - the rider then freezes mid-air,
                    // can't dismount, and the ride loops keep droning.
                    if (c == null) continue;
                    // CHEAP geometric + nearest rejects BEFORE the per-hit GetComponent (an allocating GetComponents scan in
                    // Udon): on the ground the swept capsule is buried in terrain, so the 64-slot buffer is mostly up-facing
                    // terrain-floor hits we discard here - running the component lookups only for the surviving, CLOSER
                    // wall-like candidates removes the bulk of those scans (the grounded per-frame win). Behaviour-identical:
                    // own-deck / knockable hits still never update 'nearest', so the accepted nearest wall is unchanged.
                    if (_hitBuf[i].distance <= 0f)
                    {
                        // Already INSIDE this collider. A zero-distance cast hit carries no usable normal so it
                        // cannot drive collide-and-slide - but skipping it outright is what let the rider take the
                        // whole move and sail through the very thing they were embedded in, and then stay stuck
                        // in it. Remember it for the push-out below, which is the engine's own answer
                        // [Trailmap: 370-depenetrate]. Kept cheap: identity checks only, no component lookups.
                        // Props only. As the note above says, on the ground this capsule is BURIED in terrain -
                        // that is the sink spring working, not an overlap to escape - so terrain must never enter
                        // the list or the push-out fights the contact model and jerks the ride [see OwnedByProps].
                        if (c != _ownCollider && c != _probeCol && embeddedCount < _embedded.Length && OwnedByProps(c))
                        {
                            bool already = false;
                            for (int k = 0; k < embeddedCount; k++) { if (_embedded[k] == c) { already = true; break; } }
                            if (!already) { _embedded[embeddedCount] = c; embeddedCount++; }
                        }
                        continue;
                    }
                    if (_hitBuf[i].normal.y > wallNormalMax) continue;    // up-facing -> ridable ground (the down-probe owns it)
                    if (_hitBuf[i].distance >= nearest) continue;         // not closer than the best wall so far -> skip the c-deref checks
                    if (c == _ownCollider || c == _probeCol) continue;    // our own deck box / probe capsule
                    if (c.GetComponent<PhysicsProp>() != null) continue; // mode-3 knockable: physics-routed in the game, it gets knocked & never walls the rider
                    nearest = _hitBuf[i].distance;
                    hn = _hitBuf[i].normal;
                    hitBounce = BounceForObstacle(c);
                    hitPlayerBounce = PlayerBounceForObstacle(c);
                    hitCol = c;
                    found = true;
                }
                // The BODY SPHERE pass: a native mode-2 bounding box is met by one 0.85 m ball at the pelvis,
                // not by the probe capsule [Trailmap: 370-probe-modes]. The ball is larger than the swept
                // capsule everywhere the capsule exists, so it always reports the earlier hit on a box - which
                // is why the capsule sweep above does not need to exclude them, and why a box no longer slips
                // under the capsule's raised foot.
                if (bodySphereCollision && bodySphereRadius > 0f && BoundsRoot() != null)
                {
                    Vector3 sc = pos + Vector3.up * bodySphereHeight;
                    int nSphere = Physics.SphereCastNonAlloc(sc, bodySphereRadius, dir, _hitBuf,
                                                             dist + obstacleSkin, ~0, QueryTriggerInteraction.Ignore);
                    for (int i = 0; i < nSphere; i++)
                    {
                        Collider c = _hitBuf[i].collider;
                        if (c == null) continue;
                        if (_hitBuf[i].distance <= 0f)
                        {
                            if (c != _ownCollider && c != _probeCol && embeddedCount < _embedded.Length
                                && c.transform.parent == _boundsRoot)
                            {
                                bool seen = false;
                                for (int k = 0; k < embeddedCount; k++) { if (_embedded[k] == c) { seen = true; break; } }
                                if (!seen) { _embedded[embeddedCount] = c; embeddedCount++; }
                            }
                            continue;
                        }
                        if (_hitBuf[i].normal.y > wallNormalMax) continue;   // up-facing -> the down-probe owns it
                        if (_hitBuf[i].distance >= nearest) continue;
                        if (c.transform.parent != _boundsRoot) continue;     // not a mode-2 box: the capsule owns it
                        nearest = _hitBuf[i].distance;
                        hn = _hitBuf[i].normal;
                        hitBounce = BounceForObstacle(c);
                        hitPlayerBounce = PlayerBounceForObstacle(c);
                        hitCol = c;
                        found = true;
                    }
                }
                if (!found) { pos += remaining; break; }               // nothing in the way -> take the whole move
                float move = Mathf.Max(0f, nearest - obstacleSkin);
                pos += dir * move;                                     // advance up to (just shy of) the wall
                Vector3 leftover = remaining - dir * move;
                remaining = Vector3.ProjectOnPlane(leftover, hn);      // slide the rest along the wall face
                float into = Vector3.Dot(_vel, hn);
                if (into < 0f)
                {
                    float delta = -(1f + hitBounce) * into;
                    if (hitPlayerBounce) delta = Mathf.Max(delta, -into + 2f / 3.6f);
                    _vel += delta * hn;                               // native bounce includes its universal 2 km/h eject floor
                    PlayImpactSound(hitCol, -into);                   // play the prop's real collision clip, volume from the closing speed
                    // A prop carrying the host's MainType-13 on its own collision (an animated reset host - the
                    // megaplex doors) resets on CONTACT, which is where the engine puts it. Same gate as the impact
                    // sound, so it is a real hit and not a graze; TriggerReset is race-gated and cooldown-guarded.
                    if (ResetOnContact(hitCol)) TriggerReset();
                    // One shoved tick for the WEDGE integrator (OutOfBounds.cs). Fed from the BLOCKING response only -
                    // a graze we slid along without being pushed back is not wedging - and worth zero for terrain or
                    // for a face the board is standing on. Banked once per tick below, not once per iteration.
                    float w = WedgeContribution(hitCol, hn);
                    if (w > wedgeFrame) wedgeFrame = w;
                }
            }
            AddWedge(wedgeFrame);
            return Depenetrate(pos, embeddedCount);
        }

        // Push the rider back out of anything the sweep found itself already inside.
        //
        // The engine resolves a solid prop contact by depenetration FIRST - the rider's position moves along the
        // contact normal by 1.1x the reported penetration - and only then applies the restitution
        // [Trailmap: 370-depenetrate]. Collide-and-slide has no answer for an overlap that already exists: a sweep
        // starting inside a collider has nowhere to advance to, so the rider passes through and stays stuck.
        //
        // ONE new API call, Physics.ComputePenetration. If a VRChat SDK build rejects it as not Udon-exposed, the
        // whole feature reverts by returning `pos` unchanged - the sweep above is untouched and keeps its old
        // behaviour. Only the deepest overlap is resolved per call: overlaps are rare (the sweep capsule's bottom
        // sphere rides at torso height, so it does not sit in the ground), and taking the deepest first lets the
        // next frame handle any remainder instead of fighting several pushes into each other.
        // The level's mode-2 bounding-box root, found once. Null on a map with no bounds colliders, which turns
        // the body-sphere pass off rather than making it search every frame.
        Transform BoundsRoot()
        {
            if (!_boundsRootSearched)
            {
                _boundsRootSearched = true;
                GameObject go = GameObject.Find("PropsBoundsCollision");
                if (go != null) _boundsRoot = go.transform;
            }
            return _boundsRoot;
        }

        // The three solid prop collision roots the importer builds (foliage and contact-sound roots are triggers,
        // which the sweeps ignore). Found once; a map without them simply has no prop to be pushed out of.
        Transform[] PropRoots()
        {
            if (!_propRootsSearched)
            {
                _propRootsSearched = true;
                _propRoots = new Transform[3];
                GameObject solid = GameObject.Find("PropsCollision");
                GameObject body = GameObject.Find("PropsBodyCollision");
                GameObject bounds = GameObject.Find("PropsBoundsCollision");
                if (solid != null) { _propRoots[0] = solid.transform; }
                if (body != null) { _propRoots[1] = body.transform; }
                if (bounds != null) { _propRoots[2] = bounds.transform; }
            }
            return _propRoots;
        }

        /// <summary>
        /// Is this collider part of a prop, as opposed to the terrain the rider is riding?
        ///
        /// Depenetration answers a solid PROP contact [Trailmap: 370-depenetrate]. The ride surface is owned by the
        /// down-probe and its sink spring, and that spring parks the board INSIDE the snow on purpose - 26 cm in
        /// deep powder (powderSinkDepth * 1.2). Through a dip the terrain facet rises around the rider, so even the
        /// raised sweep foot (sweepFootClearance) ends up embedded in ground that is behaving exactly as intended.
        /// Pushing out of that fights the contact model every frame, which is felt as the ride jerking.
        ///
        /// Reference compares up the parent chain: no per-hit GetComponent (the allocating scan in Udon), and
        /// overlaps are rare enough that the walk never shows up in a frame.
        /// </summary>
        bool OwnedByProps(Collider col)
        {
            Transform[] roots = PropRoots();
            for (Transform t = col.transform; t != null; t = t.parent)
            {
                for (int i = 0; i < roots.Length; i++)
                {
                    if (roots[i] != null && t == roots[i]) { return true; }
                }
            }
            return false;
        }

        Vector3 Depenetrate(Vector3 pos, int embeddedCount)
        {
            if (embeddedCount <= 0 || _probeCol == null) return pos;
            Vector3 probeOffset = _probeCol.transform.position - transform.position;
            Vector3 probePos = pos + probeOffset;
            Quaternion probeRot = _probeCol.transform.rotation;
            Vector3 bestDir = Vector3.zero;
            float bestDepth = 0f;
            for (int i = 0; i < embeddedCount; i++)
            {
                Collider c = _embedded[i];
                if (c == null) continue;
                if (c.GetComponent<PhysicsProp>() != null) continue;   // knockable: physics-routed, never walls the rider
                Vector3 dir = Vector3.zero;
                float depth = 0f;
                bool hit = Physics.ComputePenetration(_probeCol, probePos, probeRot,
                                                     c, c.transform.position, c.transform.rotation, out dir, out depth);
                if (!hit) continue;
                // An up-facing push is the ground holding the rider up, which the down-probe owns; taking it here
                // would fight the contact model for the whole descent.
                if (dir.y > wallNormalMax) continue;
                if (depth > bestDepth) { bestDepth = depth; bestDir = dir; }
            }
            if (bestDepth <= 0f) return pos;
            pos += bestDir * (bestDepth * 1.1f);   // the engine's own 1.1x, so the rider ends up clear of the surface
            float into = Vector3.Dot(_vel, bestDir);
            if (into < 0f) _vel -= into * bestDir; // stop driving back into what we just left
            return pos;
        }

        // Per-material prop impact sound. Every collidable prop carries an AudioSource holding the game's real collision
        // clip (CollisionBuilder maps SSX's CollisonSound id -> the course-bank slot; docs/009). We read the clip off
        // the hit collider and play it on the board's OWN 2D event source (the merged proxy colliders sit at the origin,
        // not where you hit, so playing on the prop's source would put the sound at (0,0,0); at the rider is right
        // anyway). Volume scales with the into-wall closing speed, debounced so sliding along a wall doesn't machine-gun it.
        [Tooltip("World manager for hit-gated interactive ambient loops (car alarm / police siren / hydrant spray). " +
                 "Retail enables a prop's loop whenever its impact one-shot plays, so the wall impact below arms the " +
                 "nearest inactive loop. Wired by VrcWiring; null = map has none. [Trailmap: 420-audio-runtime]")]
        public HitGatedLoops hitGatedLoops;

        void PlayImpactSound(Collider c, float speed)
        {
            if (c == null || speed < _impactMinSpeed) return;
            if (c == _lastImpactCol && Time.time - _lastImpactTime < _impactDebounce) return; // same prop, too soon
            AudioSource a = c.GetComponent<AudioSource>();
            if (a == null || a.clip == null) return;
            float t = Mathf.Clamp01((speed - _impactMinSpeed) / Mathf.Max(0.01f, _impactMaxSpeed - _impactMinSpeed));
            AudioSource outp = (eventSource != null) ? eventSource : a;   // rider's own 2D source; fall back to the prop's
            outp.PlayOneShot(a.clip, t * _impactVolume);
            _lastImpactCol = c;
            _lastImpactTime = Time.time;
            // Retail interactive-ambient: playing a prop's impact one-shot also enables its hit-gated loop (car
            // alarm, police siren, hydrant spray) [Trailmap: 420-audio-runtime]. Nearest-inactive within range;
            // the merged proxy colliders sit at the origin, so the board's own position is the impact point.
            if (hitGatedLoops != null) hitGatedLoops.ActivateNearest(transform.position);
        }

        // Foliage swish-through sound. The leaf cutouts are zero-response-mass pass-through volumes (you ride straight through them),
        // built by the importer as TRIGGER boxes grouped by material under PropsFoliage (Snd050 = tree-leaf swish, Snd051
        // = bushy-leaf swish, one AudioSource per group). The obstacle sweep ignores triggers so these never wall the
        // rider; this is a SEPARATE probe that DOES see triggers, purely to play the swish when we're inside a leaf cloud.
        // Plays on the board's own 2D event source, scaled by ride speed, debounced (one swish per cloud). See docs/009.
        void CheckFoliageSwish(Vector3 pos)
        {
            if (_foliageRoot == null || _capRadius <= 0f || eventSource == null) return;
            float speed = _vel.magnitude;
            if (speed < _swishMinSpeed) return;                                  // too slow to swish (cheap early-out before the cast)
            if (Time.time - _lastSwishTime < _swishDebounce) return;            // one swish per leaf cloud, not every frame
            Vector3 p0 = pos + Vector3.up * _capLow;
            Vector3 p1 = pos + Vector3.up * _capHigh;
            // A near-zero sweep reports the colliders the capsule is currently INSIDE (initial overlaps), i.e. the leaf
            // box we're passing through. Collide so the triggers show up at all.
            int nHits = Physics.CapsuleCastNonAlloc(p0, p1, _capRadius, _fwd, _hitBuf, 0.05f, _foliageMask, QueryTriggerInteraction.Collide);
            for (int i = 0; i < nHits; i++)
            {
                Collider c = _hitBuf[i].collider;
                if (c == null) continue;
                Transform grp = c.transform.parent;                              // box -> Snd05x group
                if (grp == null || grp.parent != _foliageRoot) continue;         // not one of our leaf boxes
                AudioSource a = grp.GetComponent<AudioSource>();
                if (a == null || a.clip == null) continue;
                float t = Mathf.Clamp01((speed - _swishMinSpeed) / Mathf.Max(0.01f, _swishMaxSpeed - _swishMinSpeed));
                eventSource.PlayOneShot(a.clip, Mathf.Clamp01(t * _swishVolume * soundVolume));
                _lastSwishTime = Time.time;
                return;                                                          // one swish per pass
            }
        }

        // Restitution for an obstacle: a response-enabled prop's authored PlayerBounceAmmount (x obstacleBounceScale).
        // Legacy/manual metadata with the flag off returns zero; obstacles without metadata use obstacleBounce.
        float BounceForObstacle(Collider c)
        {
            if (c != null)
            {
                PropBounce prop = c.GetComponent<PropBounce>();
                if (prop != null) return prop.PlayerBounce ? Mathf.Max(0f, prop.PlayerBounceAmmount) * obstacleBounceScale : 0f;
            }
            return Mathf.Max(0f, obstacleBounce);
        }

        // A zero amount is not enough to identify the native eject branch: the flag itself selects the universal
        // 2 km/h minimum outward response. Native flag-off props are omitted from solid buckets; this remains for
        // legacy/manual colliders.
        bool PlayerBounceForObstacle(Collider c)
        {
            if (c == null) return false;
            PropBounce prop = c.GetComponent<PropBounce>();
            return prop != null && prop.PlayerBounce;
        }

        // The CONTACT ERROR: the signed clearance of 'pos' along the probed surface normal - positive = clear of the
        // surface, negative = penetrating it [Trailmap: 320-ground-contact]. This one number is the whole ground
        // model's state: the contact response acts on it, the pushout fires past -(budget), and the grounded state
        // holds while it stays under the surface's ground_threshold.
        float ContactGap(Vector3 pos)
        {
            return Vector3.Dot(pos - _pPoint, _pNormal);
        }

        // ---- Boost state + the course speed-pad API -------------------------------------------------------
        // A boost is active while the rider HOLDS boost, or while a course SPEED PAD's timed window is running.
        // Both consumers are the same: the raised speed cap (BOOST_MAX_SPEED) and the lean-gated ground/rail thrust -
        // matching the engine, where a speed pad doesn't write velocity but raises the cap + feeds the cruise drive
        // (spec 360-speed-and-boost). The held boost still respects holdBoostEnabled; a pad always boosts.
        private bool BoostActive()
        {
            // held boost needs the meter's charge during a scored run (BoostMeterHasCharge); a pad boost is independent.
            return (holdBoostEnabled && _boostHeld && BoostMeterHasCharge()) || _padBoostTimer > 0f;
        }

        // A gold speed pad crossed: run the boost window for `seconds`. Takes the MAX with any active window, so
        // overlapping/re-crossed pads don't stack (the engine's RequestBoostAmount is also a max). Called by
        // BoostPad as the rider's RiderProbe sweeps the pad's trigger volume.
        public void ApplyPadSpeedBoost(float seconds)
        {
            if (seconds > _padBoostTimer) _padBoostTimer = seconds;
        }

        // ---- The MainType-0 boost family (docs/053) ------------------------------------------------------------
        // The shared push behind all four boost volumes: speed along an authored WORLD direction approaches `target`
        // as a first-order lag with time constant 1/rate ([Trailmap: 360-node-apply]). Called EVERY TICK the rider is
        // inside the volume, not once on the cross - these are containment volumes, and a lift that fired once would
        // lurch instead of climb.
        //
        // It only ever ADDS: a rider already faster along the axis is left alone, so a boost never brakes. That's what
        // separates it from a speed pad (which raises the cap + drives forward thrust along your OWN travel) - this
        // drives a designer's vector, so it can shove a slow rider sideways or straight up. The cap follows the result
        // so the volume can carry you past the normal top speed, like a boost.
        public void ApplyBoostPush(Vector3 worldDir, float target, float rate, float dt)
        {
            if (rate <= 0f || dt <= 0f || worldDir.sqrMagnitude < 1e-6f) return;
            Vector3 d = worldDir.normalized;
            float deficit = target - Vector3.Dot(_vel, d);
            if (deficit <= 0f) return;                       // add-only: never brake a rider already going faster
            _vel += d * (deficit * rate * dt);
            // AND THE CAP IS LEFT ALONE. A scripted boost node writes neither pad-request field, so it raises no
            // cap tier of its own ([Trailmap: 360-cap]) - a grounded rider stays bounded at MAX_SPEED however
            // violent the push, and only going airborne re-arms the top tier. Letting the cap follow the push
            // instead is not a small difference: the volume's target is the ceiling rather than the cap, so
            // Megaplex's conveyors (60 m/s) and exhaust vents (100 m/s) would each pin the cap at their own
            // number and it would then bleed off at only BOOST_CAP_DECAY, keeping the rider absurdly fast for a
            // dozen seconds after they left the volume. Measured on PS2 across retail's own vent (three passes,
            // autotest cell `vent-throw`): peak carried speed was 33.47 m/s every time, which is BOOST_MAX_SPEED
            // to three figures - the airborne re-arm below, not the boost.
        }

        // The two LIFT volumes (sub-15/sub-18) cancel travel every tick they lift, leaving only the climb - that's what
        // makes them elevators rather than pushes.
        public void KillBoostHorizontalVelocity()
        {
            _vel = new Vector3(0f, _vel.y, 0f);
        }

        // The vertical lift's arrival branch: place the rider at the target altitude and leave everything else alone.
        // POSITION ONLY - the engine writes the altitude and moves straight to the next rider, so the climb velocity
        // survives, and that surviving climb is exactly what the tube-end launch then builds on.
        public void SnapToBoostAltitude(float worldY)
        {
            Vector3 p = transform.position;
            transform.position = new Vector3(p.x, worldY, p.z);
        }

        // The launch stage the LAP boost recorded, read by the TUBE-END boost at the top of the same shaft. The engine
        // keeps this in a small global table indexed by rider, referenced only by those two nodes - so the two volumes
        // are really one mechanism ([Trailmap: 360-tube-pair]), and per-rider board state is the honest home for it.
        [HideInInspector] public int BoostStage;

        // ---- Checkpoint / lap reset (for a course finish trigger to call) -------------------------------------

        // Teleport the board - carrying the standing rider - to a pose and reset its motion, WITHOUT dismounting (unlike
        // Eject, which drops you on foot + respawns). The station carries the player as we move the transform, so this
        // whisks the rider to 'pos' still aboard, facing 'forwardDir', stopped and on the ground. A finish trigger
        // calls this to loop you back to the start. Mirrors the OnStationEntered mount init.
        public void RespawnAt(Vector3 pos, Vector3 forwardDir)
        {
            Vector3 fwd = Vector3.ProjectOnPlane(forwardDir, Vector3.up);
            fwd = fwd.sqrMagnitude > 1e-4f ? fwd.normalized : Vector3.forward;
            transform.SetPositionAndRotation(pos, Quaternion.LookRotation(fwd, Vector3.up));
            _vel = Vector3.zero;
            _boardUp = Vector3.up; _fwd = fwd; _seatFwd = fwd;
            _contactN = Vector3.up; _wasGrounded = false;
            _steer = 0f; _lean = 0f; _carveSlide = 0f; _bank = 0f; _throttle = 0f; _flipArmed = false; _slip = 0f;
            _charging = false; _charge = 0f; _releaseQueued = false; _ollieCooldown = 0.4f; _jumpGrace = 0f;
            _wasAir = false; _airTime = 0f; _boostHeld = false; _airBoostActive = false; _padBoostTimer = 0f; _speedCap = MAX_SPEED;
            BoostStage = 0;   // a respawned rider has no recorded finish-tube launch stage
            // Re-seat the fixed-tick contact state on the teleport: drain the banked tick time (a teleport is not ride
            // time) and SEAT the slewed contact fields on the new spot's surface rather than slewing them in from
            // stale values - a stale/zero budget makes the pushout fire on the first contact tick and shove the deck
            // straight back out. [Trailmap: 310-surface-response]
            _forcedAir = false; _tickAccum = 0f; _error = 1f;
            Probe(pos);
            _rideSurf = _pFound ? _pSurf : 1;
            _sinkBudget = SurfBudget(_rideSurf); _sinkBog = SurfBog(_rideSurf); _lift = 0f;
            if (_grinding) { _grinding = false; StopGrindFx(); } // drop any in-progress grind cleanly
            _coasting = false; // teleporting the board overrides any riderless coast
            _asleep = false; _parkTimer = 0f; // a teleport/re-dispense wakes the board so it ticks + syncs the new pose
            _railIndex = -1; _grindCooldown = railRelockCooldown;
            ClearWake(); _haveLastWake = false; // fresh ribbon after a teleport (don't stitch across the world)
            // Any teleport invalidates the out-of-bounds trail; start fresh from the new spot, with a brief grace before a
            // reset can fire so we don't immediately re-trigger.
            _crumbFilled = 0; _crumbWrite = 0; _haveLastCrumb = false; _oobResetCooldown = 0.5f;
            // Tell the frame's tick loop that the transform now holds a warped pose, so it adopts this instead of
            // writing back the position it was integrating. Set for EVERY caller: a respawn raised from inside a
            // tick (reset zone, reset host, OOB floor) is otherwise silently undone a few lines later.
            _warped = true;
            _wedge = 0f; // whatever we were jammed against is somewhere else now
            RiderVelocity = Vector3.zero;
            PublishTeleport(); // seed the net sample to the new pose + zero net velocity (no bogus disp/dt spike) and send next tick
        }

        // ClientSim autotest entry points. AutoTestMount uses the real ownership/station path; AutoTestDrop uses the real
        // teleport reset and then seeds only the approach velocity. All subsequent contact/trigger handling is the same
        // fixed-tick ride code used in VRChat.
        public void AutoTestMount()
        {
            AutoTestControl = true;
            if (_colliders == null) Start();
            WakeUp();
            bool canSeatNow = !networked || Networking.IsOwner(gameObject);
            Interact();
            // ClientSim activates these UdonBehaviours out of an initially-inactive VRCObjectPool. Its station manager
            // seats the local player, but currently omits OnStationEntered for that activation path. Reuse the real ride
            // initialization after the real ownership + UseStation path, while remaining inert outside explicit autotest
            // control. A delayed callback is harmless because OnStationEntered is now idempotent while already riding.
            if (canSeatNow && !_riding && station != null && _player != null) OnStationEntered(_player);
        }

        public void AutoTestDrop()
        {
            Vector3 fwd = Vector3.ProjectOnPlane(AutoTestDropForward, Vector3.up);
            fwd = fwd.sqrMagnitude > 1e-4f ? fwd.normalized : Vector3.forward;
            RespawnAt(AutoTestDropPosition, fwd);
            _vel = fwd * Mathf.Max(0f, AutoTestDropSpeed);
            RiderVelocity = _vel;
            AutoTestBoostWindow = 0f;
        }

        public void AutoTestOllie()
        {
            if (!_riding) return;
            _charge = 1f;
            _charging = false;
            _releaseQueued = true;
            _ollieCooldown = 0f;
        }

    }
}
