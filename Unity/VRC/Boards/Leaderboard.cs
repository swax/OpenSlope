using UnityEngine;
using UnityEngine.UI;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    // The course LEADERBOARD: a display board at the bottom of the run holding two top-10 lists - best TRICK SCORES and
    // fastest TIMES - keyed by player name, one best entry per player per list (docs/050). A rider's run is timed + scored
    // by the board (RideableBoard.Score) from mount to the moment they cross the finish trigger (FinishLine), which
    // calls Submit here. WHICH list a run competes on is the rider's MODE (the Settings Board's Race / Trick picker,
    // docs/vrchat/047), frozen into the run at mount: race runs enter the times list, trick runs the scores list, and a
    // free-ride never starts a recordable run at all. Both lists still DISPLAY the other metric alongside.
    //
    // NETWORKING mirrors PlayersBoard: the lists are the ONE synced thing, held by whoever last finished (sync Manual).
    // Submit takes ownership of this object, folds the new result into the two lists (replacing the player's previous entry
    // only if it's BETTER - higher score / lower time), trims each to ten, and RequestSerialization()s the arrays to
    // everyone; each client repaints from the set it last received (OnDeserialization). Two finishes in the very same
    // network frame can race (last-writer-wins on the whole arrays), which at worst drops one record that the next finish
    // re-establishes - acceptable for a leaderboard, and the cost of per-player objects isn't worth airtight ordering.
    // Records persist for the instance's life (a player who leaves keeps their entry - it's a record board).
    //
    // DISPLAY-ONLY: no Interact, no per-frame work. The board only repaints on a submit / deserialize. LeaderboardSetup
    // builds the two-column panel and fills scoreRows / timeRows (parallel Text arrays, length = Capacity).
    [UdonBehaviourSyncMode(BehaviourSyncMode.Manual)]
    public class Leaderboard : UdonSharpBehaviour
    {
        public const int Capacity = 10;   // top-N kept per list

        [Header("Row labels (built by LeaderboardSetup; length = Capacity)")]
        [Tooltip("The Text on each row of the TOP SCORES column (highest first). Blank past the end.")]
        public Text[] scoreRows;
        [Tooltip("The Text on each row of the BEST TIMES column (fastest first). Blank past the end.")]
        public Text[] timeRows;

        // ---- the synced lists. Score list: sorted DESC by score; Time list: sorted ASC by time. The "secondary" array on
        // each holds the OTHER metric from that same run (the time of the best-score run / the score of the best-time run),
        // shown alongside. Each player appears at most once per list. ----
        [UdonSynced] private string[] sNames;   // top scores: player names
        [UdonSynced] private int[]    sScores;  // top scores: the score (sort key, desc)
        [UdonSynced] private int[]    sTimes;   // top scores: that run's time (centiseconds, for display)

        [UdonSynced] private string[] tNames;   // best times: player names
        [UdonSynced] private int[]    tTimes;   // best times: the time in centiseconds (sort key, asc)
        [UdonSynced] private int[]    tScores;  // best times: that run's score (for display)

        // Scratch outputs of InsertSorted (Udon has no out-params / tuples; the helper writes here, the caller copies out).
        private string[] _outN;
        private int[]    _outP;
        private int[]    _outS;

        void Start()
        {
            if (sNames == null) { sNames = new string[0]; sScores = new int[0]; sTimes = new int[0]; }
            if (tNames == null) { tNames = new string[0]; tTimes = new int[0]; tScores = new int[0]; }
            Repaint();
        }

        // A finished run from FinishLine (LOCAL call on the finishing client). Update this player's best in the list
        // the run's MODE competes on, then publish. Called with the player's display name, run score, run time in
        // centiseconds, and the run's mode (RideableBoard.RunMode, from the Settings Board's picker - docs/vrchat/047):
        //   RACE (0)  -> the BEST TIMES list (its score rides along as the secondary column)
        //   TRICK (1) -> the TOP SCORES list (its time rides along)
        // A run only enters the list it was RIDDEN for, so a time-trial pass with no tricks can't park a 0 in the score
        // table, and a points run that dawdled for a big line can't be read as a race time. (FREE RIDE never reaches
        // here - it starts no timed run at all.) The other list still SHOWS both numbers, so nothing is lost from view.
        public void Submit(string playerName, int score, int timeCs, int mode)
        {
            if (playerName == null) playerName = "Rider";
            EnsureArrays();
            bool trick = mode == 1;

            // Take ownership so we may write the synced fields (no-op if we already own it).
            VRCPlayerApi lp = Networking.LocalPlayer;
            if (lp != null && !Networking.IsOwner(gameObject)) Networking.SetOwner(lp, gameObject);

            bool changed = false;

            // TOP SCORES (higher is better): insert/replace only if it beats this player's existing best score.
            int es = IndexOf(sNames, playerName);
            if (trick && (es < 0 || score > sScores[es]))
            {
                InsertSorted(sNames, sScores, sTimes, playerName, score, timeCs, true);
                sNames = _outN; sScores = _outP; sTimes = _outS;
                changed = true;
            }

            // BEST TIMES (lower is better): insert/replace only if it beats this player's existing best time.
            int et = IndexOf(tNames, playerName);
            if (!trick && (et < 0 || timeCs < tTimes[et]))
            {
                InsertSorted(tNames, tTimes, tScores, playerName, timeCs, score, false);
                tNames = _outN; tTimes = _outP; tScores = _outS;
                changed = true;
            }

            if (changed) RequestSerialization();
            Repaint();
        }

        // A new set of lists arrived from the owner - repaint from the authoritative arrays.
        public override void OnDeserialization()
        {
            EnsureArrays();
            Repaint();
        }

        // ---- list maintenance ----------------------------------------------------------------------------------------

        private void EnsureArrays()
        {
            if (sNames == null) sNames = new string[0];
            if (sScores == null) sScores = new int[0];
            if (sTimes == null) sTimes = new int[0];
            if (tNames == null) tNames = new string[0];
            if (tTimes == null) tTimes = new int[0];
            if (tScores == null) tScores = new int[0];
        }

        private int IndexOf(string[] names, string name)
        {
            if (names == null) return -1;
            for (int i = 0; i < names.Length; i++) if (names[i] == name) return i;
            return -1;
        }

        // Rebuild a (names, primary, secondary) list: drop any existing entry for `name`, insert the new triple at its
        // sorted position (primary desc when higherBetter, else asc), and trim to Capacity. Result -> _outN/_outP/_outS.
        private void InsertSorted(string[] names, int[] prim, int[] sec, string name, int primV, int secV, bool higherBetter)
        {
            int n = names.Length;
            string[] nN = new string[n + 1];
            int[]    nP = new int[n + 1];
            int[]    nS = new int[n + 1];

            // copy everything except the player's old entry
            int m = 0;
            for (int i = 0; i < n; i++)
            {
                if (names[i] == name) continue;
                nN[m] = names[i]; nP[m] = prim[i]; nS[m] = sec[i]; m++;
            }

            // find the sorted insert position among the m kept entries
            int pos = m;
            for (int i = 0; i < m; i++)
            {
                bool before = higherBetter ? (primV > nP[i]) : (primV < nP[i]);
                if (before) { pos = i; break; }
            }

            // shift the tail up and drop the new entry in
            for (int i = m; i > pos; i--) { nN[i] = nN[i - 1]; nP[i] = nP[i - 1]; nS[i] = nS[i - 1]; }
            nN[pos] = name; nP[pos] = primV; nS[pos] = secV;
            m++;

            int keep = m < Capacity ? m : Capacity;
            _outN = new string[keep];
            _outP = new int[keep];
            _outS = new int[keep];
            for (int i = 0; i < keep; i++) { _outN[i] = nN[i]; _outP[i] = nP[i]; _outS[i] = nS[i]; }
        }

        // ---- display -------------------------------------------------------------------------------------------------

        private void Repaint()
        {
            if (scoreRows != null)
                for (int i = 0; i < scoreRows.Length; i++)
                {
                    if (scoreRows[i] == null) continue;
                    bool has = sNames != null && i < sNames.Length;
                    scoreRows[i].text = has
                        ? (i + 1) + ". " + sNames[i] + "  —  " + Commas(sScores[i]) + "   <size=20>" + FormatTime(sTimes[i]) + "</size>"
                        : "";
                }

            if (timeRows != null)
                for (int i = 0; i < timeRows.Length; i++)
                {
                    if (timeRows[i] == null) continue;
                    bool has = tNames != null && i < tNames.Length;
                    timeRows[i].text = has
                        ? (i + 1) + ". " + tNames[i] + "  —  " + FormatTime(tTimes[i]) + "   <size=20>" + Commas(tScores[i]) + "</size>"
                        : "";
                }
        }

        // Centiseconds -> "m:ss.cc" (the game's HUD clock format, %d:%02d.%02d).
        private string FormatTime(int cs)
        {
            if (cs < 0) cs = 0;
            int m = cs / 6000;
            int s = (cs / 100) % 60;
            int c = cs % 100;
            return m + ":" + Two(s) + "." + Two(c);
        }

        private string Two(int v) { return v < 10 ? "0" + v : "" + v; }

        // Thousands separators for the score, built with Substring (Udon-safe; scores are non-negative).
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
