using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    /// <summary>
    /// The in-world PERFORMANCE BOARD for Basis: a panel of toggle PLATES (BasisWorldToggle) that lets each visitor turn
    /// the world's heavier cosmetic systems off for THEMSELVES, to claw back framerate on a weaker headset/PC. The Basis
    /// analogue of the VRChat <c>PerfBoard</c>, pared to the systems Basis has ported.
    ///
    /// PER-PLAYER + LOCAL: toggling a plate only affects this client - a low-end player can kill the emitters for
    /// themselves without changing what anyone else sees. Every system it controls is itself a local cosmetic (the
    /// continuous emitters, the gem spinner, the per-client fireworks, the range culler, your own board's grind sparks).
    /// The STARTING plate state is set per-platform by ApplyPlatformDefaults (compiled per build via #if UNITY_ANDROID):
    /// Quest starts the emitters + board FX OFF (the heaviest), PC keeps them on; distance cull defaults ON both (its range
    /// is per-platform, so on PC it barely culls - just bounds the mountain-top fall-line draw).
    ///
    /// Each plate's <see cref="BasisWorldToggle.Changed"/> is wired to <see cref="Apply"/>, which re-reads EVERY plate
    /// and re-asserts the whole board - so it's order-independent and idempotent, exactly like the VRChat board. Any field
    /// left null (a system absent from this level, or a trimmed plate set) is simply skipped.
    /// </summary>
    public class BasisPerfBoard : MonoBehaviour
    {
        [Header("Cull distant geometry (the range culler; CHECKED = cull on, the RANGE is per-platform)")]
        public BasisWorldToggle cullToggle;
        public BasisObjectCuller culler;

        [Header("Continuous emitters (snow cannons / flares / lanterns) - SetActive the Emitters root")]
        public BasisWorldToggle emittersToggle;
        public GameObject emittersObject;

        [Header("Gem spin - disable the spinner manager (gems stay visible + collectible)")]
        public BasisWorldToggle gemSpinToggle;
        public BasisSpinnerManager spinner;

        [Header("Fireworks - SetActive the trigger volumes so volleys never fire")]
        public BasisWorldToggle fireworksToggle;
        public GameObject[] fireworkObjects;

        [Header("My board FX - your own board's grind sparks (BasisBoard.ShowLocalBoardFx)")]
        public BasisWorldToggle boardFxToggle;

        void Start()
        {
            WirePlates();            // each plate's Changed -> Apply (re-assert on any click)
            ApplyPlatformDefaults(); // per-platform STARTING plate state (PC vs Quest)
            Apply();                 // then assert it (drive the controlled systems to match)
        }

        // Point every present plate at Apply, so any flip re-asserts the whole board.
        void WirePlates()
        {
            if (cullToggle != null)      cullToggle.Changed      = Apply;
            if (emittersToggle != null)  emittersToggle.Changed  = Apply;
            if (gemSpinToggle != null)   gemSpinToggle.Changed   = Apply;
            if (fireworksToggle != null) fireworksToggle.Changed = Apply;
            if (boardFxToggle != null)   boardFxToggle.Changed   = Apply;
        }

        // Per-platform STARTING plate state. Compiled per build (a Basis Android/Quest build defines UNITY_ANDROID), so each
        // player's client starts with its own defaults - no sync needed (this board is local). Quest starts the heaviest
        // cosmetics OFF; distance cull ON both platforms. The player can re-check anything. Only the OFF plates are touched.
        void ApplyPlatformDefaults()
        {
    #if UNITY_ANDROID
            if (emittersToggle != null) emittersToggle.IsOn = false;
            if (boardFxToggle != null)  boardFxToggle.IsOn  = false;
    #endif
            // cull defaults ON both platforms (range is per-platform); gems/fireworks keep their all-ON state.
        }

        // Re-read every plate and re-assert the whole board. Wired to each plate's Changed, so any flip re-applies all of it -
        // idempotent and order-independent. Cheap: only runs on a click.
        public void Apply()
        {
            if (cullToggle != null && culler != null) culler.SetCull(cullToggle.IsOn); // two-tier range (docs/unity/006): checked = tight cull, off = wider tier (still bounded); the culler stays active
            ApplyObject(emittersToggle, emittersObject);
            if (gemSpinToggle != null && spinner != null) spinner.enabled = gemSpinToggle.IsOn; // stops the spin Update (gems stay)
            ApplyObjects(fireworksToggle, fireworkObjects);
            if (boardFxToggle != null) BasisBoard.ShowLocalBoardFx = boardFxToggle.IsOn;
        }

        static void ApplyObject(BasisWorldToggle t, GameObject go)
        {
            if (t == null || go == null) return;
            if (go.activeSelf != t.IsOn) go.SetActive(t.IsOn);
        }

        static void ApplyObjects(BasisWorldToggle t, GameObject[] gos)
        {
            if (t == null || gos == null) return;
            for (int i = 0; i < gos.Length; i++)
                if (gos[i] != null && gos[i].activeSelf != t.IsOn) gos[i].SetActive(t.IsOn);
        }
    }
}
