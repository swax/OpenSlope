using UnityEngine;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    // The course FINISH LINE: an invisible trigger volume at the bottom of the run that records the rider's run into the
    // shared leaderboard (docs/050). A run starts when you mount a board (score 0, clock running - RideableBoard.Score)
    // and is recorded the first time you cross this volume on a board. Built + placed by LeaderboardSetup, which drops
    // it at the end of the baked course path (move it to the exact spot afterward).
    //
    // Detection mirrors BoostPad / GemPickup - the riding board sweeps its invisible RiderProbe capsule (a kinematic
    // trigger) through us, so we catch OnTriggerEnter and read the board's run off its public fields (RunActive / RunScore
    // / RunTimeCs - the same plain-public-field cross-behaviour read the gem/pad use). A walking player has no run, so the
    // OnPlayerTriggerEnter path is ignored. After reading, EndRun() stops the board's run so sitting in the volume can't
    // double-record; re-mounting starts a fresh run. A short Cooldown is a belt-and-braces re-fire guard.
    //
    // LAPS: this behaviour owns the course's lap count (Laps), because it is the one object per map that counts them.
    // The board seeds its run countdown from it on a gate mount - to the pass count itself, the engine's own seed - and
    // this decrements it once per crossing, sending the rider round again on the same clock while laps are left and
    // recording on the crossing that lands it on zero. That same countdown is what the finish-tube boost volume reads
    // to decide whether to throw them back up the mountain (docs/053), so the race and the tube agree by construction.
    // At the default one lap the first crossing lands zero straight away and records, as ever.
    //
    // The submit itself is LOCAL: leaderboard.Submit runs on the finishing client, which then takes ownership of the
    // leaderboard object and serializes the new top-10s to everyone (the networking lives in Leaderboard). This
    // behaviour sends no network events, so its sync mode is irrelevant; Manual (zero synced vars = no traffic) matches
    // the sibling trigger volumes.
    [UdonBehaviourSyncMode(BehaviourSyncMode.Manual)]
    public class FinishLine : UdonSharpBehaviour
    {
        [Tooltip("The shared leaderboard this finish records into. Wired by LeaderboardSetup; null = the cross is a no-op.")]
        public Leaderboard leaderboard;

        [Tooltip("LAPS this course is raced over - the number of PASSES from the gate to the last crossing here. " +
                 "1 = the classic single pass: mount at the gate, cross here once, recorded. Above 1 and a crossing " +
                 "counts you round again on the same clock until the crossing that lands the countdown on zero. The " +
                 "finish-tube boost volume reads the same countdown off the board (docs/053), so it throws you back " +
                 "up the mountain at every crossing but the last. SEEDED FROM THE MAP by LeaderboardSetup, which " +
                 "reads the bundle's Race.Laps - 4 on MEGAPLEX, the one retail course that laps at all (ridden top " +
                 "to bottom four times; the announcer counts down the last three) " +
                 "[Trailmap: 390-lap-counter, 390-lap-rate], and whatever an authored map exported. Editing it here " +
                 "rides until the next OpenSlope/Setup/Leaderboard, which rebuilds this object; change the map's own " +
                 "count to make it stick.")]
        public int Laps = 1;

        [Tooltip("Seconds a Trick/showoff run starts with. Seeded from manifest.Race.ShowoffSeconds; SOP type-11 " +
                 "checkpoint events add their own payload during the run.")]
        public float ShowoffSeconds = 120f;

        [Tooltip("Minimum seconds between records, so re-entering / lingering in the volume can't re-fire. The run is also " +
                 "ended on the first cross (EndRun), so this is just a belt-and-braces guard.")]
        public float Cooldown = 3f;

        private float _last = -999f;

        // The riding board sweeps its RiderProbe through us. The box is the SECONDARY detector: the primary is the
        // board's own course-progress crossing (RideableBoard.RaceProgressTick), which is how the engine detects a
        // finish crossing - a progress event with no height in it ([Trailmap: 390]) - and which a box cannot fake on a
        // course whose run drops riders into the finish funnel from the air (MEGAPLE). Both land in CrossOnBoard, whose
        // cooldown makes a crossing both detectors see count once; on a map with no baked DTF the box is all there is.
        public void OnTriggerEnter(Collider other)
        {
            if (other == null) return;
            CrossOnBoard(other.GetComponentInParent<RideableBoard>());
        }

        // A finish crossing for `board`, however it was detected. Record the run if one is active, then end it so it
        // can't double-record. A walking player (no board / no run) is ignored.
        public void CrossOnBoard(RideableBoard board)
        {
            if (board == null || !board.IsRiding || !board.RunActive) return;
            if (Time.time - _last < Cooldown) return;
            // A crossing the lap tube's mouth just counted (docs/053) is THIS crossing - don't count it twice. The
            // record branch is deliberately not gated: a pass with nothing left to count records here regardless,
            // because the plane is where a finished pass ends however recently its last lap counted.
            if (board.LapsRemaining > 0 && Time.time - board.LastLapCountTime < Cooldown) return;
            _last = Time.time;

            // A multi-lap course (Laps > 1) counts this crossing down and sends the rider round again with the clock
            // still running while laps are left - it is a lap, not the finish. The finish-tube boost volume reads the
            // same counter just past this line, so it keeps throwing them back up the mountain until the crossing that
            // lands it on zero (docs/053). At the default one lap the first crossing lands zero straight away, so a
            // single-pass course records as ever.
            if (board.CountLapAtFinish()) return;

            int score = board.RunScore;     // banked total + the live in-progress trick (so a mid-air finish still counts)
            int timeCs = board.RunTimeCs;   // run time in centiseconds
            int mode = board.RunMode;       // the mode the run STARTED in - picks which leaderboard list it competes on
            board.EndRun();                 // stop the run so it records exactly once

            if (leaderboard == null) return;
            VRCPlayerApi lp = Networking.LocalPlayer;
            string who = lp != null ? lp.displayName : "Rider";
            leaderboard.Submit(who, score, timeCs, mode);
        }
    }
}
