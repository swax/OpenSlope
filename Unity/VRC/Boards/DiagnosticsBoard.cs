using UnityEngine;
using UnityEngine.UI;
using UdonSharp;

namespace OpenSlope.VrcPlugin
{

    // The in-world TUNING BOARD (titled "TUNING"; the class + object keep the older Diagnostics name): everything you flip
    // while WATCHING a frame counter - the FPS/debug overlay and the ride telemetry log, plus every performance claw-back
    // the world has. It's the workbench of the start-gate row; the Settings Board next to it holds the player's own
    // preferences (ride mode, sound, snow). Built + wired by DiagnosticsBoardSetup
    // ("OpenSlope/Setup/Diagnostics Board").
    //
    // DIAGNOSTICS - the two readouts. "Show FPS / debug" SetActives the head-following HUD this board builds; "Ride
    // telemetry log" pushes debugLog onto EVERY pooled board (the field only matters on whichever board you're actually
    // riding, and you can mount any of them, so the trace follows you onto any mount). Both default OFF: they cost real
    // per-frame work, so they're strictly opt-in.
    //
    // PERF - every claw-back, whether it's a world system or one of the per-frame board-FX pipelines, so ONE panel
    // answers "what can I turn off to get frames back". Four switch-off mechanisms, picked per system so "off" is a
    // real change, not just a hide:
    //   - SetActive(false) on a GameObject (every particle root + firework trigger volume): stops the ParticleSystem
    //     simulation AND its rendering, and any Udon Update / collider on that object.
    //   - enabled=false on a Renderer (the fog puff clusters): the puffs are static baked meshes with no state to lose, so
    //     flipping `enabled` is enough and it leaves the hierarchy intact for anything holding a reference into it.
    //   - a bool the rideable boards READ each frame (the two board-FX rows): there's no object to toggle, so the setup
    //     wires this board into every pooled board's `diagnosticsBoard` ref and they read remoteRiderFx / boardLocalFx.
    //   - a two-tier RANGE on the ObjectCuller ("Cull distant geometry"), not an on/off: the culler stays active either
    //     way - Quest can't afford unbounded draw - and the distance fog follows the active range.
    //
    // LOCAL + per-client (sync None): nothing here is networked - the telemetry field gates each client's LOCAL simulation
    // of the board it owns and every perf row is a local cosmetic, so flipping them only changes your own ride/view. No
    // per-frame Update: the whole thing is event-driven off the row Interacts, so it costs nothing while shown.
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class DiagnosticsBoard : UdonSharpBehaviour
    {
        [Tooltip("The pooled rideable boards the telemetry row applies to (every board, so the trace follows you onto any mount).")]
        public BoardManager manager;

        // ---- diagnostics ------------------------------------------------------------------------------------------
        [Header("Show FPS / debug - SetActive a head-following readout (off by default; a diagnostic, not a perf cost)")]
        public Toggle debugHudToggle;
        public GameObject debugHudObject;

        [Header("Ride telemetry - emit parseable RIDE_DBG records for the local ridden board (expensive; default OFF)")]
        public Toggle telemetryToggle;

        // ---- perf -----------------------------------------------------------------------------------------------
        [Header("Particles - ONE row over every authored emitter system: the snow-cannon plumes, road flares/lanterns, " +
                "collision-triggered ambient bursts, and firework trigger volumes (so volleys never fire). All SetActive'd " +
                "together - they're the same kind of thing to a player, and splitting them made rows nobody flipped independently.")]
        public Toggle particlesToggle;
        public GameObject[] particleObjects;

        // Fog banks: the drifting puff clusters, the biggest single fill-rate claw-back the world has. A puff is a
        // camera-facing sprite with ZWrite OFF, so once you are inside a bank it shades every pixel of the viewport, once
        // per overlapping puff, doubled for stereo. Measured on Aloha's tunnel from a rider's position: 61 puffs within
        // 250 m summing to ~27x viewport of blended coverage - which is why the tunnel tanked on Quest while the open
        // course was fine (all 87 puffs are 174 triangles; none of this is geometry).
        [Header("Fog banks - the drifting fog puff clusters (renderer switch; ON by default on every platform)")]
        public Toggle fogToggle;
        public Renderer[] fogRenderers;

        [Header("Cull distant geometry - a TWO-TIER range on the ObjectCuller (CHECKED = tight cull, Quest 600 m / PC " +
                "1200 m; unchecked = WIDER tier, Quest 1200 m / PC full draw). The culler stays active either way - 'off' " +
                "still bounds the draw (Quest can't afford unbounded) - and the distance fog follows the active range.")]
        public Toggle cullToggle;
        public GameObject cullerObject;

        [Header("Other riders' board FX - the pooled boards read remoteRiderFx each frame")]
        public Toggle remoteFxToggle;

        [Header("My board FX - the LOCAL board reads boardLocalFx (your own wake ribbon + snow spray)")]
        public Toggle myFxToggle;

        // Read by every RideableBoard each frame: when false, a remote (other player's) board stops drawing its wake +
        // spray, freeing the particle/mesh budget in a crowded instance. Your OWN board's FX are unaffected. Defaults true
        // (the boards floor a null diagnosticsBoard ref to "FX on", so this can't strand them off).
        public bool remoteRiderFx = true;

        // Read by the LOCAL player's RideableBoard each frame: when false, YOUR OWN board stops drawing its carved wake
        // ribbon + snow spray (the per-frame Udon FX pipeline), letting a weak client reclaim that cost. Distinct from
        // remoteRiderFx (which gates OTHER riders' boards). Local-only; defaults true (a null ref => FX on).
        public bool boardLocalFx = true;

        void Start()
        {
            ApplyPlatformDefaults();   // the per-platform STARTING state of the two board-FX rows (PC vs Quest)
            Apply();                   // then assert the whole board onto the pooled boards + perf systems
        }

        // The STARTING state of the two board-FX checkboxes, per platform - the only PERF rows that don't start ON.
        // Compiled per-build: a VRChat Quest upload defines UNITY_ANDROID (PC defines UNITY_STANDALONE) and UdonSharp
        // respects the active build target, so the Quest branch lands ONLY in the Quest build. Each player runs their own
        // platform's build, so PC and Quest clients in one cross-platform instance each start with their own defaults - no
        // sync needed (this board is sync None). The player can still re-check either box.
        //   Quest only: My board FX OFF (you can't see your own board's wake in first person anyway) and Other riders' FX
        //   OFF - the two per-frame Udon board-FX pipelines, the busy-instance costs worth clawing back on a headset.
        // Setting isOn fires each toggle's Apply listener, but the Apply() above re-asserts the whole board regardless,
        // so the order doesn't matter.
        void ApplyPlatformDefaults()
        {
    #if UNITY_ANDROID
            if (myFxToggle     != null) myFxToggle.isOn     = false;
            if (remoteFxToggle != null) remoteFxToggle.isOn = false;
    #endif
        }

        // Re-read every checkbox and re-assert the whole board. Wired to each row's Interact (via DiagnosticsToggle)
        // and to the toggles' onValueChanged, so any flip re-applies all of it - idempotent and order-independent. A null
        // toggle (a row that wasn't built, because that system isn't in this map) leaves its target untouched.
        public void Apply()
        {
            ApplyDiagnostics();
            ApplyPerf();
        }

        // The two readouts: the head-following HUD (checked => shown) and the per-frame telemetry log pushed onto every
        // pooled board. A missing telemetry toggle leaves debugLog at its shipping default (false).
        private void ApplyDiagnostics()
        {
            ApplyObject(debugHudToggle, debugHudObject);
            if (manager == null || manager.boards == null) return;
            bool telemetry = telemetryToggle != null && telemetryToggle.isOn;

            RideableBoard[] bs = manager.boards;
            for (int i = 0; i < bs.Length; i++)
            {
                RideableBoard b = bs[i];
                if (b == null) continue;
                b.debugLog = telemetry;
            }
        }

        // Assert the perf rows onto their systems.
        private void ApplyPerf()
        {
            ApplyObjects(particlesToggle, particleObjects);
            // Fog banks own real renderers, so this flips them directly (a renderer switch, not SetActive - see the field).
            if (fogToggle != null && fogRenderers != null)
            {
                bool fog = fogToggle.isOn;
                for (int i = 0; i < fogRenderers.Length; i++)
                    if (fogRenderers[i] != null) fogRenderers[i].enabled = fog;
            }
            // The cull toggle is a two-tier RANGE switch, not an on/off SetActive (docs/unity/006): the culler stays
            // active and SetCull swaps the tight/wide range (+ the distance fog end). CHECKED = tight; unchecked = wider.
            if (cullToggle != null && cullerObject != null)
            {
                ObjectCuller culler = cullerObject.GetComponent<ObjectCuller>();
                if (culler != null) culler.SetCull(cullToggle.isOn);
            }
            // The two board-FX flags every pooled board reads each frame (there's no object to toggle).
            if (remoteFxToggle != null) remoteRiderFx = remoteFxToggle.isOn;
            if (myFxToggle != null) boardLocalFx = myFxToggle.isOn;
        }

        // SetActive a HUD / particle root / trigger from its checkbox. Off => its ParticleSystem stops simulating +
        // rendering, its Udon stops, its colliders go quiet - nothing of it remains live.
        private void ApplyObject(Toggle t, GameObject go)
        {
            if (t == null || go == null) return;
            bool on = t.isOn;
            if (go.activeSelf != on) go.SetActive(on);
        }

        // SetActive a set of objects (e.g. every firework trigger volume) from one checkbox.
        private void ApplyObjects(Toggle t, GameObject[] gos)
        {
            if (t == null || gos == null) return;
            bool on = t.isOn;
            for (int i = 0; i < gos.Length; i++)
            {
                GameObject go = gos[i];
                if (go != null && go.activeSelf != on) go.SetActive(on);
            }
        }
    }
}
