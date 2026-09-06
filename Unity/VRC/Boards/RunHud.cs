using UnityEngine;
using UnityEngine.UI;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// A small LOCAL run readout that rides just above the TOP of the board/skis you're riding and shows your live run while
    /// a timed run is active (mount a fresh gate board → cross the finish; docs/050):
    ///   line 1 — the current TIME (m:ss.cc)
    ///   line 2 — the current POINTS (your run score)
    ///   line 3 — on a course that laps, the lap standing as the announcer counts it ("3 laps left" / "final lap")
    ///   line 4 — the in-progress trick as a <c>w × x × y × z = pts</c> breakdown (rotations × style-per-360 × gem-mult × base)
    /// plus, under the boost-meter dots at the panel's bottom edge, a live speed readout in whole mph.
    ///
    /// Local + per-client (sync None): each client scans the board pool for the board the LOCAL player is riding
    /// (<c>IsRiding</c> is true only on the owner-rider's board) and reads the run straight off it — the same plain-public-
    /// field reads <see cref="DebugHud"/> uses (<c>RunActive</c> / <c>RunTimeCs</c> / <c>RunScore</c> /
    /// <c>RunStyleRots</c> / <c>RunGemMult</c>). Nothing here is networked, so other players don't see your readout.
    ///
    /// The panel rides FLAT on the deck — LOCKED to the VISIBLE board pose (<see cref="RideableBoard.DeckPivot"/>), so it
    /// banks into your carves and flips end-over-end with the board, sitting just above the deck a touch ahead of your feet.
    /// It does NOT billboard — it's bolted to the board. Rather than re-place it every frame, the panel is PARENTED to the
    /// deck pivot on mount (its flat-on-deck pose set once, then <c>SetParent(deck, true)</c>): Unity then moves/banks/flips
    /// it with the board for FREE, so <see cref="PostLateUpdate"/> only detects mount/dismount + rebuilds the text. On
    /// dismount it detaches back home (so a recycled board never drags it away) and hides. An old board with no visible deck
    /// pivot keeps the per-frame billboarded fallback. Built + wired by RunHudSetup.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class RunHud : UdonSharpBehaviour
    {
        [Tooltip("The board manager - the HUD scans its board list for the one the LOCAL player is riding. Wired by setup.")]
        public BoardManager boardManager;
        [Tooltip("The visible panel (Canvas child), shown only while a run is active. Wired by setup.")]
        public GameObject panel;
        [Tooltip("The readout Text (3 lines: time / points / breakdown). Wired by setup.")]
        public Text text;
        [Tooltip("The boost-meter 15-DOT Image (a 5-step yellow->orange->red dot ramp, horizontally Filled a whole dot at a time by the meter 0..1). Wired by setup.")]
        public Image boostMeterImage;
        [Tooltip("The boost meter's GameObject - shown only while the meter governs the run. Wired by setup.")]
        public GameObject boostMeterRoot;
        [Tooltip("The jump-charge WEDGE Image (15 white vertical stripes in a triangle, horizontally Filled by the ollie charge 0..1). Wired by setup.")]
        public Image jumpChargeImage;
        [Tooltip("The jump-charge wedge's GameObject - shown only while a jump is being charged (Use held). Wired by setup.")]
        public GameObject jumpChargeRoot;
        [Tooltip("The speed readout Text just under the boost bar (whole mph from RiderVelocity). Wired by setup.")]
        public Text speedText;

        [Tooltip("Forward offset (m) along the deck so the panel sits ahead of the rider's feet toward the nose. DECK-space, so it banks/pitches with the board.")]
        public float forwardOffset = 0.70f;
        [Tooltip("Height (m) the panel floats above the deck surface (along the deck's up, so it stays flush as the board banks/flips). Small = sitting on the deck.")]
        public float height = 0.05f;
        [Tooltip("Tilt the panel up toward the rider (deg) so it isn't dead flat on the deck - leans the readout back into your view. 0 = flat; ~15-30 reads well. Negative tilts the other way (toward the nose).")]
        public float tiltDegrees = 20f;
        [Tooltip("Readable face points UP toward a rider looking down at the deck (default ON). This canvas reads from its -Z side (like DebugHud's billboard), so 'up' means +Z points DOWN the deck normal. Turn OFF only if the panel is invisible / shows its back.")]
        public bool faceUp = true;
        [Tooltip("Flip the readout 180 deg in the deck plane if it reads upside down.")]
        public bool flipText = false;
        [Tooltip("Text-rebuild interval (s) - how often the readout (clock / score / boost bar) refreshes. The panel itself is parented to the deck, so it tracks the board with no per-frame placement.")]
        public float refreshInterval = 0.02f;
        [Tooltip("How long (s) a landed/bailed trick's coloured result stays on screen before it clears.")]
        public float resultHoldSeconds = 3f;

        private VRCPlayerApi _player;
        private float _timer;
        private int   _lastResolveTick = -1; // last seen board.RunResolveTick - a change means a trick just resolved
        private float _resultTime = -999f;   // when that resolution happened (drives the result hold window)
        private int   _lastTimeBonusTick = -1;
        private float _timeBonusAt = -999f;

        private Transform  _attachedDeck;    // the deck the panel is currently parented to (null = home / not riding)
        private Vector3    _homePos;         // the panel's local pose under THIS object, restored when it detaches back home
        private Quaternion _homeRot;
        private Vector3    _homeScale;
        private bool       _homeCaptured;

        void Start()
        {
            _player = Networking.LocalPlayer;
            if (panel != null)
            {
                _homePos = panel.transform.localPosition;   // remember where it sits when detached (for the billboard fallback)
                _homeRot = panel.transform.localRotation;
                _homeScale = panel.transform.localScale;
                _homeCaptured = true;
                panel.SetActive(false);
            }
        }

        public override void PostLateUpdate()
        {
            RideableBoard b = LocalBoard();
            bool show = b != null && b.RunActive;
            if (panel != null && panel.activeSelf != show) panel.SetActive(show);

            // The deck we want the panel GLUED to (parented), or null when not riding a run / on an old seat-locked board.
            Transform targetDeck = (show && b != null) ? b.DeckPivot : null;

            // Re-PARENT only on a CHANGE (mount / dismount / board swap). Once parented to the deck, Unity moves + banks +
            // flips the panel with the board for FREE - there is NO per-frame transform here anymore.
            if (targetDeck != _attachedDeck) { AttachPanel(targetDeck); _attachedDeck = targetDeck; }

            if (!show) { if (b != null) _lastResolveTick = b.RunResolveTick; return; }

            // A trick just resolved (banked or bailed) -> start the result-hold window so it shows green/red for a few seconds.
            if (b.RunResolveTick != _lastResolveTick) { _lastResolveTick = b.RunResolveTick; _resultTime = Time.time; }
            if (b.RunTimeBonusTick != _lastTimeBonusTick)
            { _lastTimeBonusTick = b.RunTimeBonusTick; if (b.RunLastTimeBonusCs > 0) _timeBonusAt = Time.time; }

            // Old / seat-locked board (no visible deck): the panel stayed HOME, so billboard it to the head each frame.
            if (targetDeck == null) BillboardFallback(b);

            // Boost meter: 15 dots along the bottom, lit left->right by the live meter every frame (independent of the text
            // throttle) - QUANTIZED to whole dots so a dot pops on/off as it's earned/spent instead of slicing. Shown only
            // when the meter actually governs this run (a scored gate run).
            if (boostMeterRoot != null)
            {
                bool mshow = b.boostMeterEnabled && b.scoringEnabled;
                if (boostMeterRoot.activeSelf != mshow) boostMeterRoot.SetActive(mshow);
            }
            if (boostMeterImage != null) boostMeterImage.fillAmount = Mathf.Floor(b.RunBoostMeter * 15f + 0.001f) / 15f;

            // Jump charge: the white-striped WEDGE just above the boost dots, filled left->no-height to right->full-height by
            // the ollie charge, shown ONLY while a jump is being charged (Use held). dbgCharge is >0 exactly while charging.
            if (jumpChargeRoot != null)
            {
                bool jshow = b.dbgCharge > 0f;
                if (jumpChargeRoot.activeSelf != jshow) jumpChargeRoot.SetActive(jshow);
            }
            if (jumpChargeImage != null) jumpChargeImage.fillAmount = b.dbgCharge;

            _timer += Time.deltaTime;
            if (_timer < refreshInterval || text == null) return;
            _timer = 0f;
            text.text = BuildText(b);
            if (speedText != null) speedText.text = Mathf.RoundToInt(b.RiderVelocity.magnitude * 2.236936f) + " mph";
        }

        // Parent the panel under the deck with the flat-on-deck WORLD pose (then Unity tracks it for free), or detach it back
        // HOME (under this object) when not riding a visible-deck board. SetParent(.., true) keeps the pose + world scale, so
        // the readout stays a constant size regardless of the deck's rider-scaling; this runs only on mount/dismount/swap.
        private void AttachPanel(Transform deck)
        {
            if (panel == null) return;
            if (deck != null)
            {
                // The flat-on-deck pose, applied ONCE here instead of every frame. The canvas reads
                // from its -Z side, so +Z points DOWN the deck (-deck.up) to aim the readable face up at the rider; faceUp
                // flips that, flipText spins the text 180 deg in-plane, tiltDegrees leans it back toward you.
                Vector3 pos = deck.position + deck.up * height + deck.forward * forwardOffset;
                Vector3 faceDir = faceUp ? -deck.up : deck.up;
                Vector3 textUp  = flipText ? -deck.forward : deck.forward;
                Quaternion rot = Quaternion.AngleAxis(-tiltDegrees, deck.right) * Quaternion.LookRotation(faceDir, textUp);
                panel.transform.SetPositionAndRotation(pos, rot);
                panel.transform.SetParent(deck, true);   // worldPositionStays: keep pose + world scale; track the deck for free
            }
            else
            {
                // Back home under this behaviour's object (so a recycled board never drags the panel away); restore its local pose.
                panel.transform.SetParent(transform, false);
                if (_homeCaptured)
                {
                    panel.transform.localPosition = _homePos;
                    panel.transform.localRotation = _homeRot;
                    panel.transform.localScale = _homeScale;
                }
            }
        }

        // No visible deck pivot (an old board): position THIS object (the panel rides home as its child) out front of the
        // board + billboard to the head. The only remaining per-frame placement, and only on legacy boards.
        private void BillboardFallback(RideableBoard b)
        {
            if (_player == null) { _player = Networking.LocalPlayer; if (_player == null) return; }
            VRCPlayerApi.TrackingData head = _player.GetTrackingData(VRCPlayerApi.TrackingDataType.Head);
            Vector3 fwd = b.transform.forward;
            Vector3 pos = b.transform.position + fwd * forwardOffset + Vector3.up * height;
            transform.position = pos;
            Vector3 toHead = pos - head.position;
            if (toHead.sqrMagnitude > 1e-6f) transform.rotation = Quaternion.LookRotation(toHead, Vector3.up);
        }

        private string BuildText(RideableBoard b)
        {
            // Lines 1-2: the running clock + total points. (The boost dots + jump-charge wedge are separate Images, not text.)
            string s = "<size=64>" + FormatTime(b.RunClockCs) + "</size>\n"
                     + "<size=54><color=#ffd24d>" + Commas(b.RunScore) + " pts</color></size>";
            if (Time.time - _timeBonusAt < 2.2f && b.RunLastTimeBonusCs > 0)
                s += "\n<size=34><color=#ffb45c>TIME BONUS +" + FormatTime(b.RunLastTimeBonusCs) + "</color></size>";

            // The lap standing, the way the game's announcer counts it: the board's own countdown is the passes left
            // COUNTING the one under way (docs/053), so it reads "3 laps left" after MEGAPLEX's first crossing and
            // "final lap" once one pass remains. Only on a course that actually laps - a single-pass course (the
            // default) would sit on "final lap" for the whole run, which is noise, so Laps > 1 gates the line.
            if (b.LapsRemaining > 0 && b.finishLine != null && b.finishLine.Laps > 1)
                s += "\n<size=30><color=#9fe4ff>" + (b.LapsRemaining == 1 ? "final lap" : b.LapsRemaining + " laps left") + "</color></size>";

            // The TRICK block: while a trick is LIVE the accumulating score is WHITE (with the equation / grind state below);
            // once it RESOLVES the score turns GREEN (landed) or RED (bailed, with the reason) for resultHoldSeconds, then clears.
            if (b.RunGrinding)
            {
                s += ScoreLine(b.RunTrickPts, "#ffffff")
                   + "\n<size=26><color=#c6a3ff>grind  " + Fmt1(b.RunGrindTime) + "s</color></size>";
            }
            else if (b.RunGrabbing)
            {
                // The mid-air deck grab: the hand labels it, the held seconds tick up toward the next tier (flat ladder).
                s += ScoreLine(b.RunTrickPts, "#ffffff")
                   + "\n<size=26><color=#ffb3d1>" + (b.RunGrabRight ? "right" : "left") + " grab  " + Fmt1(b.RunGrabTime) + "s</color></size>";
            }
            else if (b.RunTrickActive && b.RunTrickPts > 0)
            {
                float w = b.RunStyleRots, x = b.scoreSpinPer360, z = b.scoreStyleConstant;
                int y = b.RunGemMult;
                s += ScoreLine(b.RunTrickPts, "#ffffff")
                   + "\n<size=26><color=#9fd4ff>" + Fmt2(w) + " × " + Fmt2(x) + " × " + y + " × " + Mathf.RoundToInt(z) + "</color></size>";
            }
            else if ((Time.time - _resultTime) < (resultHoldSeconds > 0f ? resultHoldSeconds : 3f) && b.RunLastTrickPts > 0)
            {
                // Just resolved (within the hold window): GREEN landed, or RED + reason on a bail. Clears after the window.
                if (b.RunLastBailed)
                    s += ScoreLine(b.RunLastTrickPts, "#ff5a4d")
                       + "\n<size=26><color=#ff8a7a>" + BailReason(b.RunLastBailReason) + "</color></size>";
                else
                    s += ScoreLine(b.RunLastTrickPts, "#8fe39a");
            }
            return s;
        }


        // The accumulating / result score line ("+12,340" in the given hex colour).
        private string ScoreLine(int pts, string hex)
        {
            return "\n<size=40><color=" + hex + ">+" + Commas(pts) + "</color></size>";
        }

        private string BailReason(int code)
        {
            if (code == 2) return "out of bounds";
            return "sloppy landing";
        }

        // The board the LOCAL player is riding (IsRiding is true only on the owner-rider's board) - or HOLDING mid-run
        // (the mid-air deck grab keeps the run alive, and the panel rides the deck in your hand so the grab line + clock
        // stay visible through the trick). Null when neither.
        private RideableBoard LocalBoard()
        {
            if (boardManager == null || boardManager.boards == null) return null;
            int n = boardManager.boards.Length;
            for (int i = 0; i < n; i++)
            {
                RideableBoard b = boardManager.boards[i];
                if (b != null && (b.IsRiding || (b.RunActive && b.IsHeldLocally))) return b;
            }
            return null;
        }

        // Centiseconds -> "m:ss.cc" (the game's HUD clock format).
        private string FormatTime(int cs)
        {
            if (cs < 0) cs = 0;
            int m = cs / 6000;
            int s = (cs / 100) % 60;
            int c = cs % 100;
            return m + ":" + Two(s) + "." + Two(c);
        }
        private string Two(int v) { return v < 10 ? "0" + v : "" + v; }

        private string Fmt2(float v) { return v.ToString("F2"); }
        private string Fmt1(float v) { return v.ToString("F1"); }

        // Thousands separators (Udon-safe via Substring; values are non-negative).
        private string Commas(int v)
        {
            if (v < 0) v = 0;
            string s = v.ToString();
            if (s.Length <= 3) return s;
            int first = s.Length % 3;
            string outp = first > 0 ? s.Substring(0, first) : "";
            for (int i = first; i < s.Length; i += 3)
            {
                if (outp.Length > 0) outp += ",";
                outp += s.Substring(i, 3);
            }
            return outp;
        }
    }
}
