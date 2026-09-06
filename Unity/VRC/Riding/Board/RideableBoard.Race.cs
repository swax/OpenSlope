using UnityEngine;

namespace OpenSlope.VrcPlugin
{

    // Part of RideableBoard (partial): race-audio hooks - the board is the event source for the
    // PathFinder race-music director and the MC announcer (docs/039). The game's boarder states post
    // audio events through a game-event-to-audio mapping [Trailmap: 420-audio-runtime]; here the board pushes the same
    // moments directly: ride state every frame (the music's path level), big-air mid-flight, landings,
    // wipeouts (OOB reset), boost (standing in for the uber-trick tiers: song events 1/2), run start = Go.
    public partial class RideableBoard
    {
        [Header("Race audio (music director + announcer; wired by Setup Race Audio)")]
        [Tooltip("The PathFinder race-music director - fed ride state while the local player rides.")]
        public RaceMusicDirector raceMusic;
        [Tooltip("The off-board intro/fallback director - receives mount state even when this map has no race graph.")]
        public MusicDirector introMusic;
        [Tooltip("The MC announcer - fired on race moments (big air, landings, wipeouts...).")]
        public AnnouncerU announcer;
        [Tooltip("Continuous airtime (s) that counts as BIG AIR (announced mid-flight).")]
        public float bigAirSeconds = 1.4f;
        [Tooltip("Airtime (s) a landing must follow to merit a landing call.")]
        public float landAirSeconds = 0.7f;
        [Tooltip("Riding below this speed fraction for a while gets you the 'too slow' call.")]
        public float slowSpeed01 = 0.18f;

        private bool _bigAirCalled;      // one Big_Air per flight
        private float _slowTimer;
        private float _boostCallCooldown;
        private bool _boostWasHeld;      // edge detect for the tier enter/exit song events
        private float _sweetTimer;       // clean riding (no wipeout/reset) earns a Sweet call

        // Per-frame, beside UpdateBoardAudio. Pushes the music path-level inputs and runs the
        // time-based announcer events (big air mid-flight, slow, boost edges, sweet).
        void RaceAudioUpdate(bool onGround, float dt)
        {
            if (!_riding) return;

            float speed01 = Mathf.Clamp01(_vel.magnitude / MAX_SPEED);
            if (raceMusic != null)
            {
                raceMusic.SetRideState(speed01, onGround, _boostHeld, _airTime);
                // Boost edges stand in for the game's uber-trick tiers (song events 1 enter / 2 exit).
                if (_boostHeld != _boostWasHeld)
                {
                    raceMusic.FireEvent(_boostHeld ? 1 : 2);
                    _boostWasHeld = _boostHeld;
                }
            }

            if (announcer == null) return;

            // Big air is called WHILE you fly (the game announces from the airborne boarder state).
            if (!onGround && !_bigAirCalled && _airTime >= bigAirSeconds)
            {
                _bigAirCalled = true;
                announcer.OnBigAir();
            }
            if (onGround) _bigAirCalled = false;

            if (_boostCallCooldown > 0f) _boostCallCooldown -= dt;
            if (_boostHeld && onGround && _boostCallCooldown <= 0f)
            {
                announcer.OnBoost();
                _boostCallCooldown = 45f;
            }

            // Dawdling -> Slow (then a long re-arm so it doesn't nag).
            if (onGround && speed01 < slowSpeed01)
            {
                _slowTimer += dt;
                if (_slowTimer > 6f) { announcer.OnSlow(); _slowTimer = -30f; }
            }
            else if (_slowTimer > 0f) _slowTimer = 0f;

            // A long clean stretch at speed earns a Sweet (reset by wipeouts below).
            if (onGround && speed01 > 0.5f) _sweetTimer += dt;
            if (_sweetTimer > 40f) { announcer.OnSweet(); _sweetTimer = 0f; }
        }

        // A REAL landing (airTime is pre-reset). Big flights get the landing call.
        void RaceLandingHook(float airTime)
        {
            if (!_riding || announcer == null) return;
            if (airTime >= landAirSeconds) announcer.OnLand();
        }

        // The out-of-bounds / wipeout reset = the game's knockdown moment.
        void RaceKnockdownHook()
        {
            _sweetTimer = 0f;
            ScoreBailHook(); // out-of-bounds reset: lose the uncommitted trick + multiplier (the run total + clock carry on)
            if (!_riding) return;
            if (announcer != null) announcer.OnKnockdown();
            if (raceMusic != null) raceMusic.FireEvent(0);   // song back to normal
        }

        // startsRun = this mount starts the clock (a fresh gate board). GO is the race start, not a mount jingle:
        // it fires only here. Free-ride mounts and mid-air trick remounts (the run resuming - see ScoreMountHook)
        // seat you silently; the music still comes up on every mount (OnMount just cancels the dismount fade, so a
        // quick air catch keeps it near-seamless).
        void RaceMountHook(bool startsRun)
        {
            _bigAirCalled = false; _slowTimer = 0f; _boostCallCooldown = 10f; _boostWasHeld = false; _sweetTimer = 0f;
            if (raceMusic != null) raceMusic.OnMount();
            if (introMusic != null) introMusic.OnMount();
            if (startsRun && announcer != null) announcer.OnGo();
        }

        void RaceDismountHook()
        {
            if (raceMusic != null) raceMusic.OnDismount();
            if (introMusic != null) introMusic.OnDismount();
        }
    }
}
