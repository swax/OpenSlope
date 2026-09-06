using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Part of BasisBoard (partial): a trimmed RUN SCORE so collected gems actually matter - the Basis port of the
    // VRChat RideableBoard.Score.cs, pared to the MVP. A "run" is one ride (mount -> dismount). While airborne it
    // accrues the degrees you spin (stick-X yaw) and flip (stick-Y somersault); a clean landing BANKS style points =
    // round10( rotations * scoreSpinPer360 * gemMult * scoreStyleConstant ) plus a flat big-air bonus, into the run total.
    // Grinding accrues linear style continuously (banked when you land off the rail). A collected gem raises the multiplier
    // MAX-not-stack (BasisGemPickup -> ApplyGemMultiplier), which the next banked trick consumes. A bad landing or an
    // out-of-bounds reset WIPES the uncommitted trick + the multiplier but keeps the run. The numbers follow the
    // clean scoring contract [Trailmap: 390-pickups-and-race]; a bare clean 360 with no gem is about 1700 points.
    //
    // Dropped vs VRChat (each a separate deferred feature): the run TIMER + finish-line leaderboard, the boost METER
    // (boost stays unlimited here), and the nose HUD read surface. RunScore / RunGemMult are exposed so a future HUD or
    // leaderboard can read them; with no HUD yet, `logTricks` prints each banked / lost trick + gem so the scoring is
    // visible in a ride-test.
    public partial class BasisBoard
    {
        [Header("Trick scoring (banked on landing; gems set the multiplier - docs/050)")]
        [Tooltip("Master toggle. ON: spins/flips/grinds bank a trick score over a ride and gems raise the multiplier. OFF: no scoring (gems still pop cosmetically).")]
        public bool scoringEnabled = true;
        [Tooltip("Style->points scale (RE 0.67869 * 10000): banked points = round10( rotations * scoreSpinPer360 * gemMult * this ).")]
        public float scoreStyleConstant = 6786.9f;
        [Tooltip("Style accrued per full 360 of rotation (RE +0.25 per 360). Spins (stick-X) and flips (stick-Y) both feed it.")]
        public float scoreSpinPer360 = 0.25f;
        [Tooltip("Airtime (s) at/above which the flat BIG-AIR bonus kicks in (RE 4 s).")]
        public float scoreBigAirSeconds = 4f;
        [Tooltip("Big-air bonus points per second over 3 s (RE (airtime-3)*1000).")]
        public float scoreBigAirPerSecond = 1000f;
        [Tooltip("A hard slam / badly-misaligned touchdown WIPES the in-progress trick (no points) but keeps you riding. OFF = every clean-enough landing banks.")]
        public bool badLandingZerosTrick = true;
        [Tooltip("Style per SECOND while grinding a rail (RE ~0.15 -> the game-tested ~1000 pts/sec). Rail spins score on top as discrete spins.")]
        public float scoreGrindStylePerSec = 0.15f;
        [Tooltip("Log each banked / lost trick + collected gem to the console. There's no run HUD yet, so this makes scoring visible in a ride-test.")]
        public bool logTricks = true;

        // ---- read surface for a future HUD / leaderboard ----
        [HideInInspector] public bool  RunActive;
        // Laps left COUNTING the one under way, the way the engine counts them: seeded to the course's pass count,
        // decremented once per finish crossing, 0 only once the crossing that ends the race has counted
        // ([Trailmap: 390-lap-rate, 360-lapboost-gate]). -1 means no lap race is running, which is nonzero and so
        // reads as "laps left" - the finish tube lifts every time. That is the standing state here until a finish
        // trigger exists to count it down; the lap-gated boost volume tests it for nonzero, and its mouth counts the
        // crossing on a course whose tube sits up-course of its finish plane (see the VRChat twin).
        [HideInInspector] public int   LapsRemaining = -1;
        // When a lap last counted, so two crossing stations in sequence can't both count the same pass.
        [HideInInspector] public float LastLapCountTime = -999f;
        [HideInInspector] public int   RunScore;          // banked total + the live in-progress trick preview
        [HideInInspector] public int   RunGemMult = 1;    // active gem multiplier (1/2/3/5)
        [HideInInspector] public float RunStyleRots;      // in-progress rotations (spins+flips)/360
        [HideInInspector] public int   RunLastTrickPts = -1; // last resolved trick's points (-1 = none this run; on a wipe = the lost value)
        [HideInInspector] public bool  RunLastBailed;     // the last resolved trick was wiped (bad landing / OOB)
        [HideInInspector] public bool  RunTrickActive;    // airborne / grinding in a trick right now -> the HUD shows the LIVE accumulating score
        [HideInInspector] public bool  RunGrinding;       // on a rail right now
        [HideInInspector] public float RunGrindTime;      // seconds on the current grind

        // ---- run state ----
        bool  _runActive;
        int   _runScore;
        bool  _scoreAir;          // airborne inside a trick (our own latch, independent of _airTime)
        bool  _scoreBadLanding;   // the touchdown this trick resolves on was a bad landing (set by the ride loop) -> wipe
        float _scoreSpinDeg;      // degrees of yaw spin accrued this air/grind
        float _scoreFlipDeg;      // degrees of somersault flip accrued this air
        float _scoreAirTime;      // seconds in this air (own counter)
        float _scoreGrindStyle;   // style accrued on the rail this trick
        float _scoreGrindTime;    // seconds on the rail this trick
        int   _gemMult = 1;       // active gem multiplier, MAX-not-stack, consumed by the next banked trick

        // Mounting starts a fresh run. From HandleMount.
        void ScoreMountHook()
        {
            _runScore = 0;
            ScoreClearCombo();
            _scoreAir = false;
            _scoreBadLanding = false;
            _runActive = true;
            // No finish trigger exists on this platform yet, so there is nothing to count laps down and no lap count to
            // seed from: -1 means no lap race, which reads as "laps left" and lifts at the finish tube on every pass.
            // A future Basis finish trigger seeds this from its own lap count and calls CountLapAtFinish, as the
            // VRChat FinishLine does.
            LapsRemaining = -1;
            RunActive = true; RunScore = 0; RunGemMult = 1; RunStyleRots = 0f; RunLastTrickPts = -1; RunLastBailed = false;
            RunTrickActive = false; RunGrinding = false; RunGrindTime = 0f;
        }

        // Getting off ends the run. From HandleDismount.
        void ScoreDismountHook()
        {
            _runActive = false;
            RunActive = false;
            LapsRemaining = -1;   // off the board: no lap race, so the tube lifts again
        }

        // A finish crossing: count the lap down, and say whether the run goes round again. One decrement per crossing,
        // the engine's own arithmetic ([Trailmap: 390-lap-rate]). Returns true while laps are still left (the caller
        // sends the rider round on the same clock), false when this crossing lands the counter on 0 - the FINISH - or
        // no lap race is running, and the caller should record. A future Basis finish trigger seeds LapsRemaining to
        // its own pass count on mount and calls this per crossing, as the VRChat FinishLine does.
        public bool CountLapAtFinish()
        {
            if (LapsRemaining <= 0) return false;
            LapsRemaining--;
            LastLapCountTime = Time.time;
            return LapsRemaining > 0;
        }

        // An out-of-bounds reset: wipe the uncommitted trick + drop the multiplier, but keep the run going. From RespawnToSpawn.
        void ScoreBailHook()
        {
            if (_scoreAir || _scoreSpinDeg > 0f || _scoreFlipDeg > 0f || _scoreGrindTime > 0f)
            {
                RunLastTrickPts = ScorePreviewPts(); RunLastBailed = true;
                if (logTricks && RunLastTrickPts > 0) Debug.Log($"[BasisBoard] Trick LOST (out of bounds): {RunLastTrickPts}");
            }
            ScoreClearCombo();
            _scoreAir = false;
        }

        // Per non-grind frame from the ride Update: run the air<->ground trick transitions (bank on landing) + republish
        // the read fields. The grind path uses ScoreGrindFrame instead (it owns the frame + returns before this runs).
        void ScoreUpdate(bool onGround, float dt)
        {
            if (!_runActive) { RunActive = false; return; }
            RunActive = true;

            if (!onGround)
            {
                if (!_scoreAir) { _scoreAir = true; _scoreAirTime = 0f; _scoreBadLanding = false; } // fresh trick
                else _scoreAirTime += dt;
            }
            else if (_scoreAir)
            {
                if (_scoreAirTime > orientationGrace || _scoreGrindTime > 0f) // a real air (past the bump grace) or any grind this string
                {
                    if (_scoreBadLanding && badLandingZerosTrick)
                    {
                        RunLastTrickPts = ScorePreviewPts(); RunLastBailed = true;
                        if (logTricks && RunLastTrickPts > 0) Debug.Log($"[BasisBoard] Trick WIPED (sloppy landing): {RunLastTrickPts}");
                        ScoreClearCombo();
                    }
                    else
                    {
                        int pts = ScorePreviewPts();
                        _runScore += pts;
                        RunLastTrickPts = pts; RunLastBailed = false;
                        if (logTricks && pts > 0) Debug.Log($"[BasisBoard] Trick banked +{pts} (run total {_runScore})");
                        ScoreClearCombo();
                    }
                }
                else { _scoreSpinDeg = 0f; _scoreFlipDeg = 0f; _scoreAirTime = 0f; } // bump-skip: drop the tiny rotation, KEEP the gem multiplier
                _scoreBadLanding = false;
                _scoreAir = false;
            }

            int preview = ScorePreviewPts();
            RunScore = _runScore + preview;
            RunGemMult = _gemMult;
            RunStyleRots = (_scoreSpinDeg + _scoreFlipDeg) / 360f;
            RunTrickActive = _scoreAir;   // airborne in a trick -> HUD shows the live calc
            RunGrinding = false;          // a normal (non-grind) frame ran; ScoreGrindFrame sets this true
        }

        // Per grind frame from GrindUpdate: accrue the grind as part of the open trick (continuous linear style; the trick
        // stays OPEN and banks when you land off the rail). Rail spins are accrued separately into _scoreSpinDeg.
        void ScoreGrindFrame(float dt)
        {
            if (!_runActive) return;
            RunActive = true;
            if (scoringEnabled)
            {
                _scoreAir = true;      // the grind keeps the trick open; landing off the rail banks it
                _scoreAirTime = 0f;    // a grind is not airborne time (no big-air)
                _scoreGrindTime += dt;
                float rate = scoreGrindStylePerSec > 0f ? scoreGrindStylePerSec : 0.15f;
                _scoreGrindStyle += rate * dt;
            }
            int preview = ScorePreviewPts();
            RunScore = _runScore + preview;
            RunGemMult = _gemMult;
            RunStyleRots = (_scoreSpinDeg + _scoreFlipDeg) / 360f;
            RunTrickActive = _scoreAir;
            RunGrinding = true;
            RunGrindTime = _scoreGrindTime;
        }

        // Points the CURRENT (uncommitted) trick is worth: (rotation + grind) style * gem multiplier + the flat big-air add.
        int ScorePreviewPts()
        {
            if (!scoringEnabled) return 0;
            float spins = (_scoreSpinDeg + _scoreFlipDeg) / 360f;
            float style = spins * scoreSpinPer360 + _scoreGrindStyle;
            float raw = style * _gemMult * scoreStyleConstant;
            int pts = raw > 0f ? Mathf.RoundToInt(raw / 10f) * 10 : 0; // round to the nearest 10 (RE round10)
            if (_scoreAirTime >= scoreBigAirSeconds)
                pts += Mathf.RoundToInt((_scoreAirTime - 3f) * scoreBigAirPerSecond); // flat big-air add (un-multiplied)
            return pts;
        }

        // Clear the in-progress trick + reset the multiplier to x1 (a land or a bail). Does NOT touch the run total.
        void ScoreClearCombo()
        {
            _scoreSpinDeg = 0f; _scoreFlipDeg = 0f; _scoreAirTime = 0f; _gemMult = 1;
            _scoreGrindStyle = 0f; _scoreGrindTime = 0f;
        }

        // A trick-multiplier gem was collected while riding (BasisGemPickup, tier 2/3/5). MAX-not-stack: it raises the
        // active multiplier, consumed by the next banked trick. Ignored when not in a run / scoring off.
        public void ApplyGemMultiplier(int tier)
        {
            if (!scoringEnabled || !_runActive) return;
            if (tier > _gemMult)
            {
                _gemMult = tier; RunGemMult = _gemMult;
                if (logTricks) Debug.Log($"[BasisBoard] Gem collected - multiplier now x{_gemMult}");
            }
        }
    }
}
