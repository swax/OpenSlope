using UdonSharp;
using UnityEngine;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// The MC announcer (docs/039): SSX Tricky fires a voice line from an event-named bank when
    /// something happens in the race - Big_Air while you're flying, Land on a clean touchdown,
    /// Knockdown on a wipeout, Slow when you're dawdling, Boost_Icon, Go at the start. Each bank in
    /// SPEECH.BIG is N variants of the call; the game gates each fire through a per-event probability
    /// table indexed by an "excitement" level [Trailmap: 430-music-and-announcer]. We keep the
    /// shape with per-event chance knobs plus a global cooldown so the MC doesn't babble, and pick a
    /// random variant (never the same one twice running). One 2D AudioSource; local-only - the MC is
    /// in YOUR headset, like the game. Events come from the board (RideableBoard.Race.cs).
    /// Set up by OpenSlope/VRChat/Setup Race Audio.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class AnnouncerU : UdonSharpBehaviour
    {
        public AudioSource source;
        public float volume = 0.8f;

        [Header("Voice banks (variants; filled by Setup Race Audio from Maps/Shared/speech/mc)")]
        public AudioClip[] goClips;          // mount / off you go
        public AudioClip[] bigAirClips;      // huge airtime, fired mid-flight
        public AudioClip[] landClips;        // clean landing after real air
        public AudioClip[] knockdownClips;   // wipeout / out-of-bounds reset
        public AudioClip[] slowClips;        // dawdling
        public AudioClip[] boostClips;       // boost engaged
        public AudioClip[] sweetClips;       // long clean run (the MC likes you)

        [Header("Fire chances (0..1; the game gates per-event by an excitement table)")]
        public float bigAirChance = 0.9f;
        public float landChance = 0.45f;
        public float knockdownChance = 0.9f;
        public float slowChance = 0.8f;
        public float boostChance = 0.5f;
        public float sweetChance = 0.6f;

        [Tooltip("Seconds between any two announcer lines (a playing line always finishes).")]
        public float cooldownSeconds = 5f;

        [Tooltip("Master mute from the Settings Board's 'Announcer' checkbox: when true no new lines fire and any " +
                 "playing line is cut. A bool defaulting to false (= audible).")]
        public bool muted;

        private float _coolUntil;    // Time.time the cooldown expires (a timestamp needs no per-frame decrement)
        private int _lastGo = -1, _lastBigAir = -1, _lastLand = -1, _lastKnockdown = -1;
        private int _lastSlow = -1, _lastBoost = -1, _lastSweet = -1;

        void Start()
        {
            SendCustomEventDelayedSeconds(nameof(MuteTick), 0.25f);
        }

        // SELF-SCHEDULED 4 Hz watchdog, the announcer's only periodic work: cut a line already playing when the Sound
        // Board mutes the MC. Everything else is event-driven (the On* calls) and the cooldown is a timestamp, so
        // there's no per-frame Update - the interpreted per-behaviour dispatch is exactly the per-frame Udon cost
        // Quest pays for. Delayed events fire even on a disabled behaviour, so the loop is immortal.
        public void MuteTick()
        {
            SendCustomEventDelayedSeconds(nameof(MuteTick), 0.25f);
            if (muted && source != null && source.isPlaying) source.Stop();
        }

        public void OnGo()        { _lastGo        = Say(goClips, _lastGo, 1.1f, true); }
        public void OnBigAir()    { if (Roll(bigAirChance))    _lastBigAir    = Say(bigAirClips, _lastBigAir, 1f, false); }
        public void OnLand()      { if (Roll(landChance))      _lastLand      = Say(landClips, _lastLand, 1f, false); }
        public void OnKnockdown() { if (Roll(knockdownChance)) _lastKnockdown = Say(knockdownClips, _lastKnockdown, 1f, true); }
        public void OnSlow()      { if (Roll(slowChance))      _lastSlow      = Say(slowClips, _lastSlow, 1f, false); }
        public void OnBoost()     { if (Roll(boostChance))     _lastBoost     = Say(boostClips, _lastBoost, 1f, false); }
        public void OnSweet()     { if (Roll(sweetChance))     _lastSweet     = Say(sweetClips, _lastSweet, 1f, false); }

        bool Roll(float chance) => Random.value < chance;

        // Play a random variant from a bank (no immediate repeat). Returns the index played, or the
        // previous one when gated. interrupt = this call matters enough to cut a playing line off.
        int Say(AudioClip[] bank, int last, float cooldownMul, bool interrupt)
        {
            if (source == null || bank == null || bank.Length == 0) return last;
            if (muted) return last;   // the Settings Board muted the MC
            if (Time.time < _coolUntil && !interrupt) return last;
            if (source.isPlaying && !interrupt) return last;

            int idx = Random.Range(0, bank.Length);
            if (bank.Length > 1 && idx == last) idx = (idx + 1) % bank.Length;
            if (bank[idx] == null) return last;

            source.Stop();
            source.clip = bank[idx];
            source.volume = volume;
            source.Play();
            _coolUntil = Time.time + cooldownSeconds * cooldownMul + bank[idx].length;
            return idx;
        }
    }
}
