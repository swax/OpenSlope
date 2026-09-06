using UnityEngine;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    // Part of RideableBoard (partial): the RUN SCORE + RUN TIMER that feed the course leaderboard (docs/050).
    //
    // The board doesn't model SSX's full trick engine, but it DOES animate real spins (stick-X yaws the deck) and flips
    // (stick-Y somersaults it), and it tracks airtime. So this partial banks a RE-grounded trick score from exactly
    // those: while you're in the air it accumulates the degrees you spin + flip, and on a clean landing it banks
    // style points = round10( spins * 0.25 * gemMult * 6786.9 ), plus a flat big-air bonus for long airtime, into the
    // run total. A bail/out-of-bounds wipes the uncommitted trick (and the multiplier) but keeps the run total; the
    // run total persists across the run. The numbers mirror [Trailmap: 390-pickups-and-race]: a banked trick scores
    // style * gemMult * 0.67869 * 10000; +0.25 style per 360; big air >=4 s adds (airtime-3)*1000; gems set
    // the multiplier MAX-not-stack, consumed by the next banked trick. The engine's GRAB-HOLD tier is mapped onto the
    // board's own grab mechanic: taking the deck off your feet into a VR hand mid-air (TakeFromFeet) IS the grab, the
    // seconds it stays held step the game's flat tier ladder (4000/8000/12000/16000, ScoreGrabPts), and the hand picks
    // the label (left/right grab). Like the engine, the hold ALSO accrues style (begin bump + rate x 0.045/s) - style
    // reaches the points and the BOOST METER both - while the flat tier points stay score-only (no gem, no meter).
    //
    // LIFECYCLE: mounting starts a fresh run (score 0, timer running) - ScoreMountHook from OnStationEntered. Crossing
    // the finish trigger (FinishLine) reads RunScore + RunTimeCs, then calls EndRun() so the run can't double-record.
    // Getting off GROUNDED ends the run with no record. Getting off AIRBORNE (the mid-air jump-off / the deck grabbed
    // off your feet) is a TRICK, not the end of the run: the clock keeps running while you fly, and an airborne remount
    // resumes the run untouched (ScoreMountHook's air-catch branch). That kept-alive run really ends when you touch
    // ground without the board (ScoreOffBoardUpdate), the riderless board parks (CoastUpdate), or the board is
    // ejected/recycled. The three public fields (RunActive / RunScore / RunTimeCs)
    // are the cross-UdonBehaviour read surface the finish line consumes - same plain-public-fields pattern the board
    // already uses for IsRiding / RiderVelocity (Udon-friendly: no cross-behaviour return values).
    public partial class RideableBoard
    {
        [Header("Ride mode (the Settings Board's picker, pushed onto every pooled board - docs/vrchat/047)")]
        [Tooltip("What a gate mount STARTS, read once at mount and frozen into the run (RunMode): 0 = RACE - a timed run, " +
                 "recorded on the leaderboard's BEST TIMES list. 1 = TRICK - the same run, recorded on the TOP SCORES " +
                 "list instead. 2 = FREE RIDE - no timed run at all: no clock, no HUD run readout, nothing recorded at " +
                 "the finish, and boost stays unlimited (the meter only governs a scored run). Tricks still animate + " +
                 "score on the HUD in race mode; the mode only decides which board you're competing on. LOCAL per client " +
                 "(the Settings Board is sync None), so each player rides in their own mode.")]
        public int runMode = 1; // Trick / Showoff until the local Settings Board applies its selection.

        [Header("Trick scoring (run score banked on landing; recorded at the finish line - docs/050)")]
        [Tooltip("Master toggle for the run scorer. ON: spins/flips/air bank a trick score during a run, recorded when " +
                 "you cross the finish line. OFF: no scoring (the finish line records time only, score stays 0).")]
        public bool scoringEnabled = true;
        [Tooltip("Style->points scale (RE 0.67869 * 10000): banked style points = round10( spins * stylePer360 * " +
                 "gemMult * this ). A bare clean 360 with no gem ~= 1700 pts, as in the game.")]
        public float scoreStyleConstant = 6786.9f;
        [Tooltip("Style accrued per full 360 of rotation (RE +0.25 per 360). Spins (stick-X yaw) and flips (stick-Y " +
                 "somersault) both feed it.")]
        public float scoreSpinPer360 = 0.25f;
        [Tooltip("Airtime (s) at/above which the flat BIG-AIR bonus kicks in (RE 4.0 s).")]
        public float scoreBigAirSeconds = 4f;
        [Tooltip("Big-air bonus points per second over 3 s (RE (airtime-3)*1000): 1000 @ 4 s, 2000 @ 5 s, ...).")]
        public float scoreBigAirPerSecond = 1000f;
        [Tooltip("A BAD LANDING zeroes the in-progress trick (no points) but does NOT kick you off the board: a hard slam " +
                 "(into-surface speed >= landHardImpact) or a badly-misaligned, unfinished-flip touchdown (deck-vs-surface " +
                 "angle >= landAlignBad). The run + clock carry on and you keep riding; the nose HUD shows 'bail +0'. OFF = " +
                 "every clean-enough landing banks its trick (only a true crash / out-of-bounds zeroes it).")]
        public bool badLandingZerosTrick = true;
        [Tooltip("GRINDING scores continuously as part of the accumulated trick (the game's held-trick rail scoring): just " +
                 "STAYING on a rail accrues style every frame, no input needed, and any spins stack on top (banked when you " +
                 "land off the rail). Style per SECOND on the rail (frame-rate independent). The GAME TEST measures a plain " +
                 "grind at ~1000 pts/sec, roughly LINEAR (=0.15 style/sec x 6787; ~5000 for 5 s, ~2000 for 2 s), so 0.15 " +
                 "matches it. There is NO flat hold-tier on a grind - the measured score is just this linear style accrual.")]
        public float scoreGrindStylePerSec = 0.15f;
        [Tooltip("MID-AIR DECK GRABS score the game's grab-hold ladder: taking the board off your feet into a VR hand " +
                 "(TakeFromFeet) IS the grab, and the seconds it stays held step the tier - banked with the open trick " +
                 "when you catch the deck and land. Left/right hand labels the grab on the HUD. OFF: a deck grab scores nothing.")]
        public bool scoreGrabEnabled = true;
        [Tooltip("Seconds of held-deck time per grab TIER step. The game pays a flat 0 / 0 / 4000 / 8000 / 12000 / 16000 " +
                 "at tiers 0..5+ but its tier cadence isn't wall-clock, so this maps " +
                 "tiers to seconds: at 0.5, a 1.0 s hold = 4000, 1.5 s = 8000, 2.0 s = 12000, 2.5 s+ = 16000 (capped). " +
                 "A flat add like big-air: no gem multiplier, and the TIER points fill no boost meter - the " +
                 "grab's meter charge comes from its STYLE rate instead (scoreGrabStyleRate).")]
        public float scoreGrabTierSeconds = 0.5f;
        [Tooltip("The grab's STYLE RATE - the game's authored per-trick constant (" +
                 "1.0 for plain tricks up to 5.0 for ubers). A held trick accrues style at rate x 0.045/s (plus a flat " +
                 "+0.0425 style on recognition), and style is what fills the BOOST METER: at 1.0 a held grab earns " +
                 "~305 pts + ~3% meter per second, on top of the flat tier ladder. 0 = the hold pays tier points only.")]
        public float scoreGrabStyleRate = 1f;

        [Header("Boost meter (tricks fill it, holding boost spends it - shown on the run HUD; 'full is full', no uber tier)")]
        [Tooltip("Master toggle. ON: during a scored RUN, held boost draws from a 0..1 meter that tricks fill and boosting " +
                 "drains, and boost is unavailable at empty. OFF: boost is unlimited (no meter, no HUD bar). Free-riding (not " +
                 "a gate run) is ALWAYS unlimited regardless. Needs scoringEnabled (the meter fills from banked trick score). " +
                 "This is the boost/Tricky meter decoded in Trailmap 360 - simplified: full is just full, no 'It's Tricky'/uber/infinite tier.")]
        public bool boostMeterEnabled = true;
        [Tooltip("Meter charge (0..1) you start a run with, so the first boost isn't impossible. 0 = earn it all from tricks " +
                 "(the GAME starts the bar empty); 1 = start full. 0.25 = ~5.5 s of held boost before you have to earn more.")]
        [Range(0f, 1f)] public float boostMeterStart = 0.25f;
        [Tooltip("Meter gained per banked trick BASE point - EXACT: the game's fill is the trick's raw " +
                 "style x 0.67869 = base style points / 10000, so 0.0001. The GEM " +
                 "multiplier and the flat big-air bonus fill NOTHING (the fill call gets base points, not banked points): " +
                 "a clean 360 (1700 pts) = ~17% of the bar; a grind earns ~10%/s (the game-measured ~1000 base pts/s).")]
        public float boostFillPerPoint = 0.0001f;
        [Tooltip("Meter drained per SECOND while holding boost. The game's value is ~0.045/s (= ~22 s of boost per full bar). " +
                 "Higher = boost runs out faster. A course speed PAD boost does NOT draw the meter.")]
        public float boostDrainPerSec = 0.045f;
        [Tooltip("Meter lost when you BAIL / go out of bounds. The game's decoded penalties: -0.1 on a wipeout or a rider " +
                 "body bump, -0.02 light bump, -0.12 placement reset - one 0.1 knob covers our bail+OOB. 0 = no crash penalty.")]
        [Range(0f, 1f)] public float boostCrashPenalty = 0.1f;

        // ---- cross-UdonBehaviour read surface (the finish line reads these; leave alone) ----
        [HideInInspector] public bool RunActive;     // a run is in progress (mounted - or mid-air off the board in a trick - not yet finished/ended)
        [HideInInspector] public int  RunMode;       // the runMode this run STARTED in (frozen at mount, so switching the
                                                     // Settings Board mid-run doesn't rewrite the run you're on) - the
                                                     // finish line reads it to pick the leaderboard list
        [HideInInspector] public int  RunScore;      // current run score = banked total + the live in-progress trick preview
        [HideInInspector] public int  RunTimeCs;     // current run time in CENTISECONDS (frozen at the finish value once ended)
        [HideInInspector] public int  RunClockCs;    // HUD clock: elapsed in Race, remaining in Trick/showoff
        [HideInInspector] public int  RunLastTimeBonusCs; // most recent type-11 award, for the HUD cue
        [HideInInspector] public int  RunTimeBonusTick;   // increments on each checkpoint award
        // Laps left COUNTING the one under way, the way the engine counts them: seeded to the course's pass count,
        // decremented once per crossing, 0 only once the crossing that ends the race has counted
        // ([Trailmap: 390-lap-rate, 360-lapboost-gate]). On MEGAPLEX's four it reads 3 after the first crossing -
        // the announcer's "3 laps to go". A crossing is counted at whichever station the rider meets: the finish
        // line's detectors (the DTF=0 plane / the gate box), or the LAP-GATED volume's own mouth - on MEGAPLE the
        // shaft sits ~24 m UP-course of the finish plane, so mid-race passes end at the tube and only the last
        // pass, which the tube declines to lift, ever reaches the plane and records. The two stations share
        // LastLapCountTime so a course carrying both in sequence counts one crossing once. -1 means no lap race is
        // running (free-riding, or no finish line), which is nonzero and so reads as "laps left" - the finish tube
        // lifts a free-rider every time. The run HUD shows it as "N laps left".
        [HideInInspector] public int  LapsRemaining = -1;
        // When a lap last counted (CountLapAtFinish), so the two crossing stations above can't both count the same
        // pass. -999 = never this run.
        [HideInInspector] public float LastLapCountTime = -999f;
        [HideInInspector] public float RunStyleRots; // in-progress trick rotation count (spins+flips)/360 - the nose HUD's w x x x y x z 'w'
        [HideInInspector] public int   RunGemMult;   // active gem multiplier (1/2/3/5) - the nose HUD's 'y'
        [HideInInspector] public bool  RunTrickActive;     // airborne in a trick right now -> the HUD shows the LIVE accumulating score + equation
        [HideInInspector] public int   RunTrickPts;        // the in-progress trick's current worth (accumulating score line)
        [HideInInspector] public int   RunLastTrickPts = -1; // last RESOLVED trick's points (-1 = none this run yet); on a bail = the LOST value
        [HideInInspector] public bool  RunLastBailed;      // the last resolved trick was WIPED by a bail -> the HUD shows its (lost) score in red
        [HideInInspector] public int   RunLastBailReason; // why the last trick was disqualified: 1 = sloppy landing, 2 = out of bounds
        [HideInInspector] public int   RunResolveTick;   // ++ each time a trick RESOLVES (bank or bail) -> the HUD starts its 3 s result window
        [HideInInspector] public float RunLastImpact;      // last real landing's into-surface impact (m/s) - HUD landing debug
        [HideInInspector] public float RunLastAlignErr;    // last real landing's deck-vs-surface angle (deg) - HUD landing debug
        [HideInInspector] public bool  RunGrinding;        // on a rail right now (scoring continuously) -> HUD shows a grind line
        [HideInInspector] public float RunGrindTime;       // seconds on the current grind -> HUD
        [HideInInspector] public bool  RunGrabbing;        // deck held in a hand mid-air right now (the grab-hold trick) -> HUD shows a grab line
        [HideInInspector] public float RunGrabTime;        // seconds the deck has been held this trick -> HUD
        [HideInInspector] public bool  RunGrabRight;       // the grab's hand: true = right, false = left -> HUD label
        [HideInInspector] public float RunBoostMeter;      // current boost meter 0..1 (the run HUD's BOOST bar)

        // ---- run state ----
        private bool  _runActive;     // mirrors RunActive (the private driver)
        private float _runStartTime;  // Time.time at mount
        private int   _showoffSeedCs;
        private int   _runBonusCs;
        private int   _runScore;      // banked run total (the live preview is added on top for RunScore)
        private bool  _scoreAirExit;  // the station exit in progress is a deliberate AIRBORNE one (jump-off / deck grab
                                      // mid-air) - set by ScoreFlagAirExit just before ExitStation, consumed by
                                      // ScoreDismountHook to keep the run alive through the trick
        private float _scoreOffGrace; // settle window (s) after an airborne exit before the player-grounded end-check may
                                      // fire - VRChat is still re-establishing the player's own locomotion on the exit
                                      // frame (same reason ApplyExitVelocity waits a frame), so a same-frame grounded
                                      // read must not kill the run we just kept

        // ---- in-progress (current air) trick, wiped on land/bail ----
        private bool  _scoreAir;      // currently airborne inside a trick (our own air-state latch, independent of _airTime)
        private bool  _scoreBadLanding; // the touchdown this trick is resolving on was a BAD landing (set by the ride loop) -> wipe, no points
        private float _scoreGrindStyle; // style accrued on the rail this trick (added to the rotation style; reset on land/bail)
        private float _scoreGrindTime;  // seconds on the rail this trick -> the flat grind hold-tier
        private float _scoreGrabTime;   // seconds the deck was HELD IN A HAND this trick -> the flat tier ladder (score only)
        private float _scoreGrabStyle;  // style accrued by the held grab (rate x 0.045/s + the begin bump) -> points AND boost meter
        private bool  _scoreGrabRight;  // which hand held it (true = right) - the HUD's left/right grab label
        private bool  _scoreGrabHeldPrev; // deck was in hand last off-board frame - edge-detects a fresh grab segment (the begin bump)
        private float _scoreSpinDeg;  // degrees of yaw spin accrued this air (stick-X + VR head-look)
        private float _scoreFlipDeg;  // degrees of somersault flip accrued this air (stick-Y)
        private float _scoreAirTime;  // seconds in this air (our own counter; the board's _airTime is reset elsewhere)
        private int   _gemMult = 1;   // active gem multiplier (1/2/3/5), MAX-not-stack, consumed by the next banked trick
        private float _boostMeter;    // 0..1 boost energy; banked tricks fill it, holding boost drains it

        // Mount: start a timed, recordable run ONLY when you got on a FRESH board at its start gate (fromGate) AND the
        // rider's mode isn't FREE RIDE (runMode 2 - the Settings Board's picker, docs/vrchat/047) - a board
        // ridden off and re-mounted mid-mountain isn't a clean run, so it doesn't start the clock and the finish won't
        // record it. Either way the score state is cleared - EXCEPT the AIR CATCH: remounting IN THE AIR while the run
        // is still alive (an airborne exit kept it - see ScoreDismountHook) is the middle of that run, not a new one,
        // so everything (clock, banked score, open trick, gem multiplier, boost meter) carries straight through
        // untouched. From OnStationEntered (beside RaceMountHook).
        void ScoreMountHook(bool fromGate, bool airCatch)
        {
            _scoreAirExit = false; // any seat invalidates a pending airborne-exit latch (it's per-exit state)
            if (airCatch && _runActive) return; // mid-run air catch: the run never stopped - change nothing
            _runScore = 0;
            ScoreClearCombo();
            _scoreAir = false;
            _scoreBadLanding = false;
            // FREE RIDE (the Settings Board's third mode) starts no run at all: no clock, nothing recordable, and boost
            // stays unlimited (BoostMeterActive needs a live run). The mode is read HERE and frozen into RunMode, so
            // switching the board mid-mountain only changes your NEXT gate mount.
            RunMode = runMode;
            bool timed = fromGate && runMode != 2;
            _runActive = timed;              // only a fresh gate board, outside free ride, starts the clock + becomes recordable
            if (timed) _runStartTime = Time.time;
            // Seed the lap countdown with the run, from the COURSE's own lap count (FinishLine.Laps) - one number per
            // map, set on the one object that counts laps. Seeded to the pass count itself, the engine's own seed: at the
            // default 1 the first crossing lands it on 0 - records, and the finish tube lets you ride through. No finish
            // line in the scene means no race to lap, so it stays at -1 and the tube lifts every time.
            LapsRemaining = (timed && finishLine != null && finishLine.Laps > 0) ? finishLine.Laps : -1;
            // Start the progress-crossing detector with the run (below). One loop serves however many runs RunActive
            // stays true across; it dies with the run and a fresh gate mount starts it again.
            _lapArmed = false;
            _checkpointProgressReady = false;
            LastLapCountTime = -999f;
            if (timed && !_lapTickLive) { _lapTickLive = true; SendCustomEventDelayedSeconds(nameof(RaceProgressTick), LapTickSeconds); }
            _showoffSeedCs = finishLine != null ? Mathf.Max(0, Mathf.RoundToInt(finishLine.ShowoffSeconds * 100f)) : 12000;
            _runBonusCs = 0;
            RunActive = timed; RunScore = 0; RunTimeCs = 0;
            RunClockCs = RunMode == SettingsBoard.ModeTrick ? _showoffSeedCs : 0;
            RunLastTimeBonusCs = 0; RunTimeBonusTick = 0;
            RunStyleRots = 0f; RunGemMult = 1;
            RunTrickActive = false; RunTrickPts = 0; RunLastTrickPts = -1; RunLastBailed = false; RunLastBailReason = 0; // fresh run: no resolved trick yet
            RunGrinding = false; RunGrindTime = 0f; RunGrabbing = false; RunGrabTime = 0f; RunLastImpact = 0f; RunLastAlignErr = 0f; RunResolveTick = 0;
            _boostMeter = Mathf.Clamp01(boostMeterStart); RunBoostMeter = _boostMeter; // start with the configured boost charge
        }

        // Getting off ends the run with NO record (only the finish line records) - EXCEPT a deliberate AIRBORNE exit
        // (the mid-air jump-off / the deck grabbed off your feet, flagged by ScoreFlagAirExit): that's a trick in
        // progress, not the end of the run. The clock keeps running while you fly (ScoreOffBoardUpdate), an airborne
        // remount resumes the run (ScoreMountHook), and the run really ends when you touch ground without the board,
        // the riderless board parks, or the board is ejected/recycled. From OnStationExited (beside RaceDismountHook).
        void ScoreDismountHook()
        {
            bool airTrickExit = _scoreAirExit && _runActive;
            _scoreAirExit = false;
            if (airTrickExit) return;
            _runActive = false;
            RunActive = false;
            LapsRemaining = -1;   // off the board: no lap race, so the tube lifts again
        }

        // Called by the two DELIBERATE exit paths (Dismount / TakeFromFeet) just before ExitStation: flag an airborne
        // exit so ScoreDismountHook keeps the run alive through the trick. A grounded exit flags nothing (the run ends
        // as ever), and the recovery exits (Eject / respawn) never call this, so a bail always ends the run.
        void ScoreFlagAirExit()
        {
            _scoreAirExit = !_wasGrounded;
            if (_scoreAirExit) _scoreOffGrace = 0.3f;
        }

        // Per-frame while a run is riding out an OFF-BOARD moment (an airborne exit kept it alive): the board is in
        // your hand or coasting somewhere below, and you're flying/falling toward the catch. Keeps the visible clock
        // ticking (RunActive stays true, so the run HUD stays up), and ENDS the run the moment the player touches the
        // ground without the board - a trick landed on your feet is a run that's over, not one parked forever against
        // a remount. Called from HeldUpdate and Update's not-riding branch; no-op when no run is pending.
        void ScoreOffBoardUpdate()
        {
            if (!_runActive || _riding) return;
            if (!ScorePublishClock()) return;

            // THE GRAB: the deck held in a hand during this off-board flight is the game's held grab. The hold time steps
            // the flat tier ladder (ScoreGrabPts, score only), and the hold accrues STYLE like the engine's held tricks
            // (begin bump + rate x 0.045/s) - style reaches both the points AND
            // the boost meter. All banked with the still-open trick once you catch the deck and land it. A throw-and-
            // recatch pauses while the deck flies (a fresh catch re-bumps, like the engine re-recognizing the trick).
            // Keeps the live preview fields fresh too, since ScoreUpdate doesn't run while off-board.
            if (scoringEnabled && scoreGrabEnabled && _held)
            {
                if (!_scoreGrabHeldPrev) _scoreGrabStyle += 0.0425f;         // the engine's named-trick begin bump
                _scoreGrabHeldPrev = true;
                _scoreGrabTime += Time.deltaTime;
                _scoreGrabStyle += scoreGrabStyleRate * 0.045f * Time.deltaTime; // held-trick style accrual (rate x 0.045/s)
                _scoreGrabRight = GrabHandIsRight();
                int preview = ScorePreviewPts();
                RunScore = _runScore + preview;
                RunTrickPts = preview;
            }
            else _scoreGrabHeldPrev = false;
            RunGrabbing = scoringEnabled && scoreGrabEnabled && _held;
            RunGrabTime = _scoreGrabTime;
            RunGrabRight = _scoreGrabRight;

            if (_scoreOffGrace > 0f) { _scoreOffGrace -= Time.deltaTime; return; }
            if (_player != null && _player.IsPlayerGrounded()) EndRun();
        }

        // A bail / out-of-bounds reset: lose the uncommitted trick + drop the multiplier, but KEEP the run going - the run
        // total AND the clock carry on (going out of bounds does NOT reset the timer; it just costs you the time spent
        // recovering + the current trick). The OOB reset uses RespawnAt (station carry, no dismount), so _runActive /
        // _runStartTime are untouched and the run survives. From RaceKnockdownHook (OOB) and Eject (hard bail / respawn -
        // Eject dismounts, which separately ends the run via ScoreDismountHook).
        void ScoreBailHook()
        {
            // If a trick was in progress (airborne / mid-rotation / grinding), the bail WIPES it -> the HUD shows its LOST
            // score in red + "out of bounds".
            if (_scoreAir || _scoreSpinDeg > 0f || _scoreFlipDeg > 0f || _scoreGrindTime > 0f || _scoreGrabTime > 0f)
            {
                RunLastTrickPts = ScorePreviewPts(); RunLastBailed = true; RunLastBailReason = 2; // 2 = out of bounds
                RunResolveTick++;
            }
            if (boostCrashPenalty > 0f) { _boostMeter = Mathf.Max(0f, _boostMeter - boostCrashPenalty); RunBoostMeter = _boostMeter; } // a bail costs meter (RE ~-0.1)
            ScoreClearCombo();
            _scoreAir = false;
            RunTrickActive = false;
            RunTrickPts = 0;
        }

        // Per-frame, called from Update beside RaceAudioUpdate with this frame's grounded state. Runs the clock, the
        // air<->ground trick transitions (bank on landing), and republishes the cross-behaviour read fields.
        void ScoreUpdate(bool onGround, float dt)
        {
            if (!_runActive) { RunActive = false; return; }
            RunActive = true;
            if (!ScorePublishClock()) return;

            if (!onGround)
            {
                if (!_scoreAir) { _scoreAir = true; _scoreAirTime = 0f; _scoreBadLanding = false; } // fresh trick (spin/flip already 0)
                else _scoreAirTime += dt;
            }
            else if (_scoreAir)
            {
                // A real trick worth resolving = a genuine air (past the bump grace) OR any grind or deck-grab held this string.
                if (_scoreAirTime > RIDE_ORIENTATION_GRACE || _scoreGrindTime > 0f || _scoreGrabTime > 0f)
                {
                    if (_scoreBadLanding)
                    {
                        // BAD LANDING (badly unfinished flip): the trick is WIPED - no points - but you keep riding (no
                        // eject). Show its LOST score in red + "sloppy landing" on the HUD.
                        RunLastTrickPts = ScorePreviewPts(); RunLastBailed = true; RunLastBailReason = 1; // 1 = sloppy landing
                        RunResolveTick++;
                        ScoreClearCombo();
                    }
                    else
                    {
                        // A clean-enough landing: bank the trick, then end the combo (resets rotation AND the gem multiplier).
                        int pts = ScorePreviewPts();
                        _runScore += pts;
                        BoostMeterAddFromTrick(ScoreMeterBasePts());   // meter fills from BASE style points (no gem, no big-air)
                        ScoreClearCombo();
                        RunLastTrickPts = pts; RunLastBailed = false; RunLastBailReason = 0; // the HUD shows just this trick's score
                        RunResolveTick++;
                    }
                }
                else
                {
                    // A bump-skip (sub-grace air): drop the tiny in-progress rotation but KEEP the gem multiplier for the
                    // real trick to come (a bump isn't a committed landing).
                    _scoreSpinDeg = 0f; _scoreFlipDeg = 0f; _scoreAirTime = 0f;
                }
                _scoreBadLanding = false; // this landing is resolved
                _scoreAir = false;
            }

            int preview = ScorePreviewPts();
            RunScore = _runScore + preview;                           // banked + what the current in-progress trick is worth right now
            RunTrickPts = preview;                                    // the accumulating trick score line
            RunGemMult = _gemMult;                                    // HUD breakdown 'y'
            RunStyleRots = (_scoreSpinDeg + _scoreFlipDeg) / 360f;    // HUD breakdown 'w' (in-progress rotations)
            RunTrickActive = _scoreAir;                               // airborne -> HUD shows the live calc, grounded -> the last-trick total
            RunGrinding = false;                                      // a normal (non-grind) frame ran - ScoreGrindFrame sets this true
            RunGrabbing = false;                                      // riding again - the deck is back under your feet (ScoreOffBoardUpdate sets this)
            RunGrabTime = _scoreGrabTime;                             // any held-grab time still open in this trick (banked with it)
            _scoreGrabHeldPrev = false;                               // next deck-grab is a fresh segment (re-arms the begin bump)
        }

        // Per GRIND frame, called from GrindUpdate (which owns the frame + returns, so ScoreUpdate never runs while you're on
        // a rail). Keeps the run clock ticking and accrues the grind as part of the open trick: continuous style + the flat
        // hold-tier, no input needed; the trick stays OPEN (banks when you finally land off the rail), and any spins you add
        // stack through the shared rotation accumulators. Matches the game's held-trick rail scoring.
        void ScoreGrindFrame(float dt)
        {
            if (!_runActive) return;
            RunActive = true;
            if (!ScorePublishClock()) return;
            if (scoringEnabled)
            {
                _scoreAir = true;        // the grind keeps the trick OPEN; the landing off the rail banks it
                _scoreAirTime = 0f;      // a grind is NOT airborne time (no big-air); air time restarts when you leave the rail
                _scoreGrindTime += dt;
                // Linear base style (the game-tested ~1000/sec). Spins/turns are scored separately as discrete spins
                // (GrindUpdate -> _scoreSpinDeg), like the air. Floor the rate against the new-field-default gotcha.
                float rate = scoreGrindStylePerSec > 0f ? scoreGrindStylePerSec : 0.15f;
                _scoreGrindStyle += rate * dt;
            }
            int preview = ScorePreviewPts();
            RunScore = _runScore + preview;
            RunTrickPts = preview;
            RunGemMult = _gemMult;
            RunStyleRots = (_scoreSpinDeg + _scoreFlipDeg) / 360f;
            RunTrickActive = _scoreAir;
            RunGrinding = true;
            RunGrindTime = _scoreGrindTime;
        }

        // The airborne branch of the ride integrator accrues this air's rotation straight into _scoreSpinDeg (stick-X yaw
        // AND VR head-look yaw) and _scoreFlipDeg (stick-Y somersault) - both gated on scoringEnabled there - which
        // ScoreUpdate banks on landing.

        // The BASE style points of the current trick - no gem multiplier, no big-air - the quantity the GAME feeds the
        // boost meter (fill = style * 0.67869; base points are that x10000). Call before
        // ScoreClearCombo like ScorePreviewPts.
        int ScoreMeterBasePts()
        {
            if (!scoringEnabled) return 0;
            float style = (_scoreSpinDeg + _scoreFlipDeg) / 360f * scoreSpinPer360 + _scoreGrindStyle + _scoreGrabStyle;
            float raw = style * scoreStyleConstant;
            return raw > 0f ? Mathf.RoundToInt(raw / 10f) * 10 : 0;
        }

        // Points the CURRENT (uncommitted) trick is worth: style (rotation + grind) * gem multiplier, plus the flat big-air
        // bonus and the flat grind hold-tier. Zero when scoring is off or there's nothing accrued. Pure - banking just adds it.
        int ScorePreviewPts()
        {
            if (!scoringEnabled) return 0;
            float spins = (_scoreSpinDeg + _scoreFlipDeg) / 360f;        // total rotations this trick
            float style = spins * scoreSpinPer360 + _scoreGrindStyle + _scoreGrabStyle; // rotation + grind + held-grab style
            float raw = style * _gemMult * scoreStyleConstant;
            int pts = raw > 0f ? Mathf.RoundToInt(raw / 10f) * 10 : 0;   // round to the nearest 10 (RE round10)
            if (_scoreAirTime >= scoreBigAirSeconds)
                pts += Mathf.RoundToInt((_scoreAirTime - 3f) * scoreBigAirPerSecond); // flat big-air add (un-multiplied)
            pts += ScoreGrabPts();                                       // flat grab-hold ladder (un-multiplied, like the engine's)
            return pts;                                                  // grind is part of the style term above - it's LINEAR (no flat tier; game-tested)
        }

        // The game's flat grab-hold ladder ([Trailmap: 390-pickups-and-race]): tiers 0/1 pay
        // nothing, 2 = 4000, 3 = 8000, 4 = 12000, 5+ = 16000. Tier = held-deck seconds / scoreGrabTierSeconds. A flat add
        // like big-air - NOT gem-multiplied - and deliberately absent from ScoreMeterBasePts: the TIER points never reach
        // the meter; the grab charges the meter through _scoreGrabStyle instead, inside the style term.
        int ScoreGrabPts()
        {
            if (!scoreGrabEnabled || _scoreGrabTime <= 0f) return 0;
            float step = scoreGrabTierSeconds > 0f ? scoreGrabTierSeconds : 0.5f;
            int tier = (int)(_scoreGrabTime / step);
            if (tier >= 5) return 16000;
            if (tier == 4) return 12000;
            if (tier == 3) return 8000;
            if (tier == 2) return 4000;
            return 0;
        }

        // Which hand has the deck right now: the summon-hold knows (TakeFromFeet passed it), a native VRC_Pickup grab
        // (a thrown deck caught out of the air) asks the pickup.
        bool GrabHandIsRight()
        {
            if (_summonHeld) return _summonRightHand;
            return pickup != null && pickup.currentHand == VRC_Pickup.PickupHand.Right;
        }

        // Clear the in-progress trick + reset the multiplier to x1 (a land or a bail). Does NOT touch the run total.
        void ScoreClearCombo()
        {
            _scoreSpinDeg = 0f; _scoreFlipDeg = 0f; _scoreAirTime = 0f; _gemMult = 1;
            _scoreGrindStyle = 0f; _scoreGrindTime = 0f; _scoreGrabTime = 0f; _scoreGrabStyle = 0f;
        }

        // ---- public hooks called by other behaviours -----------------------------------------------------------------

        // A score-multiplier gem was collected (GemPickup, tier 2/3/5). MAX-not-stack: it raises the active multiplier,
        // which the next banked trick consumes. Native gems are Showoff-only, and retail's MainType-14 handler also
        // independently accepts only Showoff (our Trick mode); retain the guard for manually wired/custom pickups.
        public void ApplyGemMultiplier(int tier)
        {
            if (!scoringEnabled || !_runActive || RunMode != SettingsBoard.ModeTrick) return;
            if (tier > _gemMult) _gemMult = tier;
        }

        // Publish the mode-facing clock. RunTimeCs remains elapsed for result/leaderboard compatibility; the HUD
        // reads RunClockCs, which counts down in Trick/showoff and includes crossed type-11 awards.
        private bool ScorePublishClock()
        {
            RunTimeCs = Mathf.Clamp(Mathf.RoundToInt((Time.time - _runStartTime) * 100f), 0, 5999999);
            if (RunMode != SettingsBoard.ModeTrick) { RunClockCs = RunTimeCs; return true; }
            RunClockCs = Mathf.Max(0, _showoffSeedCs + _runBonusCs - RunTimeCs);
            if (_showoffSeedCs > 0 && RunClockCs == 0) { EndRun(); return false; }
            return true;
        }

        /** Apply one logical SOP type-11 checkpoint. Only Trick is retail's showoff mode; race crosses the same
         *  station for progress but its handler writes no time. */
        public void ApplyCheckpointBonus(int seconds)
        {
            if (!_runActive || RunMode != SettingsBoard.ModeTrick || seconds <= 0) return;
            int cs = Mathf.Clamp(seconds * 100, 0, 60000);
            _runBonusCs = Mathf.Clamp(_runBonusCs + cs, 0, 5999999);
            RunLastTimeBonusCs = cs;
            RunTimeBonusTick++;
            ScorePublishClock();
        }

        // End the current run without resetting the read fields - the finish line calls this AFTER reading RunScore /
        // RunTimeCs, so the values freeze and the run can't double-record (re-mount starts a fresh run).
        public void EndRun()
        {
            _runActive = false;
            RunActive = false;
            LapsRemaining = -1;   // the race is over, so the tube goes back to lifting
        }

        // A finish crossing: count the lap down, and say whether the run goes round again. One decrement per crossing,
        // the engine's own arithmetic - the value it lands on is what the game announces ("3 laps to go" first on
        // MEGAPLEX) and what the finish tube reads just past the line. Returns true while laps are still left (the
        // caller sends the rider round on the same clock), false when this crossing lands the counter on 0 - the
        // FINISH - or no lap race is running, and the caller should record.
        public bool CountLapAtFinish()
        {
            if (LapsRemaining <= 0) return false;
            LapsRemaining--;
            LastLapCountTime = Time.time;
            return LapsRemaining > 0;
        }

        // ---- the finish crossing, detected on course PROGRESS ---------------------------------------------------
        //
        // The engine detects a finish crossing on the rider's PROGRESS - their distance-to-finish passing zero - not
        // on a volume: the crossing has no height in it ([Trailmap: 390]), and MEGAPLE is why that matters here. Its
        // run drops riders into the finish funnel from the air, over any gate box of sane height, and the funnel then
        // feeds them straight into the finish-tube shaft - so a rider could be lifted lap after lap with the trigger
        // box never touched and the countdown never moving. While a run is active the board therefore polls its own
        // DTF (the baked course progress the standings board reads, docs/050) and hands a zero crossing to the finish
        // line, which counts or records it exactly as the box does; the finish line's cooldown makes a crossing both
        // detectors see count once. On a map with no baked DTF, PFound stays false and the box remains the detector.
        //
        // Armed only once the rider has been properly UP-course, so a crossing counts exactly once however long they
        // linger and bounce around the foot: after firing, the detector waits for the tube to throw them back up the
        // mountain (DTF beyond LapRearmDtf) before it can fire again - the same hysteresis the editor's lap counter
        // runs, sized to the trip a lap course's loop actually makes rather than to line noise (MEGAPLE's line
        // overshoots its own zero by only ~20 m).
        private const float LapTickSeconds = 0.1f;   // at 30 m/s a tick is ~3 m of travel; the line-to-shaft gap is ~15 m
        private const float LapRearmDtf = 120f;      // m of DTF the rider must regain before another crossing can count
        private bool _lapArmed;
        private bool _lapTickLive;   // a poll loop is scheduled; guards a rapid dismount/remount against starting a second
        private bool _checkpointProgressReady;
        private float _checkpointPreviousDtf;

        public void RaceProgressTick()
        {
            if (!RunActive) { _lapTickLive = false; return; }   // the run is over; a fresh gate mount restarts the loop
            SendCustomEventDelayedSeconds(nameof(RaceProgressTick), LapTickSeconds);
            if (coursePath == null) return;
            coursePath.QueryProgressNearest(transform.position);
            if (!coursePath.PFound) return;
            float dtf = coursePath.PDistToFinish;
            CheckpointProgressCrossings(dtf);
            if (finishLine != null && _lapArmed && dtf <= 0f)
            {
                _lapArmed = false;
                finishLine.CrossOnBoard(this);
            }
            else if (!_lapArmed && dtf >= LapRearmDtf) _lapArmed = true;
        }

        // The native EventPath query returns events whose stations lie in the forward previous->current arc
        // interval. DTF decreases in that direction, so this is the same crossing test over the baked records.
        // Route alternatives share Group; choose the event position nearest the board and award it once.
        private void CheckpointProgressCrossings(float dtf)
        {
            if (!_checkpointProgressReady)
            {
                _checkpointPreviousDtf = dtf;
                _checkpointProgressReady = true;
                return;
            }
            float previous = _checkpointPreviousDtf;
            _checkpointPreviousDtf = dtf;
            if (RunMode != SettingsBoard.ModeTrick || dtf >= previous - 0.001f) return;
            float[] eventDtf = coursePath.CheckpointDtf;
            int[] bonuses = coursePath.CheckpointBonus;
            Vector3[] positions = coursePath.CheckpointLocalPoints;
            if (eventDtf == null || bonuses == null || eventDtf.Length == 0) return;
            int n = Mathf.Min(eventDtf.Length, bonuses.Length);
            for (int i = 0; i < n; i++)
            {
                if (!(eventDtf[i] < previous - 0.001f && eventDtf[i] >= dtf - 0.001f)) continue;
                int group = coursePath.CheckpointGroup != null && i < coursePath.CheckpointGroup.Length
                    ? coursePath.CheckpointGroup[i] : i;
                // Another crossed row in this same interval already owns the group.
                bool handled = false;
                for (int k = 0; k < i; k++)
                {
                    int kg = coursePath.CheckpointGroup != null && k < coursePath.CheckpointGroup.Length
                        ? coursePath.CheckpointGroup[k] : k;
                    if (kg == group && eventDtf[k] < previous - 0.001f && eventDtf[k] >= dtf - 0.001f)
                    { handled = true; break; }
                }
                if (handled) continue;
                int chosen = i;
                float best = float.PositiveInfinity;
                if (positions != null)
                {
                    for (int j = 0; j < n && j < positions.Length; j++)
                    {
                        int jg = coursePath.CheckpointGroup != null && j < coursePath.CheckpointGroup.Length
                            ? coursePath.CheckpointGroup[j] : j;
                        if (jg != group) continue;
                        float distance = (transform.position - coursePath.transform.TransformPoint(positions[j])).sqrMagnitude;
                        if (distance < best) { best = distance; chosen = j; }
                    }
                }
                ApplyCheckpointBonus(bonuses[chosen]);
            }
        }

        // ---- Boost meter (the decoded SSX boost/Tricky meter, Trailmap 360; simplified - "full is full", no uber tier) ----
        //
        // A 0..1 energy that banked tricks fill and holding boost drains. It governs the held boost ONLY during a scored
        // run (boostMeterEnabled + scoringEnabled + a gate run) - so a real run earns + spends boost, while free-riding keeps
        // the old unlimited hold. The held-boost gate (BoostActive) and the engage-sound tier (BoostMeterClip) read it; a
        // course speed PAD boost is independent and never draws it.

        // Is the meter currently governing the held boost? (Free-riding / scoring off / meter off -> no, boost is unlimited.)
        bool BoostMeterActive() { return boostMeterEnabled && scoringEnabled && _runActive; }

        // True if held boost is allowed right now: always when the meter isn't governing, otherwise only with charge left.
        bool BoostMeterHasCharge() { return !BoostMeterActive() || _boostMeter > 0f; }

        // Per-frame from the ride loop: drain the meter while the rider HOLDS boost (the held input only - a PAD boost is
        // free), then publish it for the HUD. Drains in every state while held (simpler than the game's ground-only active
        // drain; the player just reads "hold boost = spend meter").
        void BoostMeterTick(float dt)
        {
            if (BoostMeterActive() && holdBoostEnabled && _boostHeld && _boostMeter > 0f)
                _boostMeter = Mathf.Max(0f, _boostMeter - (boostDrainPerSec > 0f ? boostDrainPerSec : 0.045f) * dt);
            RunBoostMeter = _boostMeter;
        }

        // A banked trick adds to the meter, proportional to its BASE style points (the engine's decoded fill excludes the
        // gem multiplier and the flat big-air add - pass ScoreMeterBasePts, not ScorePreviewPts), clamped to full. No-op
        // when the meter isn't governing this run.
        void BoostMeterAddFromTrick(int pts)
        {
            if (!BoostMeterActive() || pts <= 0) return;
            _boostMeter = Mathf.Min(1f, _boostMeter + pts * boostFillPerPoint);
            RunBoostMeter = _boostMeter;
        }
    }
}
