using UdonSharp;
using UnityEngine;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// Plays the level's chill background music in VRChat by sequencing the A-tier stems instead of looping
    /// one. SSX Tricky's level theme ships as three intensity arrangements (A=cruise, B/C=energetic), each a
    /// set of equal-length, grid-aligned 5.818 s bars (e.g. A1-A4, B1-B4, C1-C8); the game swapped tiers by
    /// player intensity and advanced through the bars so the loop never obviously repeated (see docs/015).
    /// This dynamic layer sequences a tier's bars and shuffles them so you get an evolving arrangement rather
    /// than one 6 s loop. A map-declared EnvironmentBed takes precedence as the simple off-board layer; intro
    /// stems remain the fallback for a map without that declaration. (Default stem set is C, the
    /// energetic / "Tricky" arrangement; A1-A4 is the chill alternative.)
    ///
    /// Native AudioSources can't sequence themselves, so this has to be Udon (like SurfaceDetector, and
    /// unlike the crowd/placed ambient beds which just loop). It runs LOCAL on every client - music is personal
    /// ambiance, so sync mode None, no ownership, no late-join state.
    ///
    /// Two AudioSources so a bar can crossfade into the next at the boundary (the stems carry no loop points,
    /// so a raw wrap can click). Each tier's bars vary differently: A's four are mutually distinct (most shuffle
    /// variety), C's eight are two groups of near-twins (subtle variation plus a jump between groups) - the setup
    /// script picks which set. The set is fixed - there is no tier escalation here, so player speed/tricks never
    /// crossfade between the A/B/C arrangements. Set up by OpenSlope/Setup/Music Director; re-run after every
    /// re-import.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class MusicDirector : UdonSharpBehaviour
    {
        [Tooltip("The bars to sequence (chill mode = the four A-tier stems). All should be equal length.")]
        public AudioClip[] tracks;

        [Tooltip("Two AudioSources to ping-pong between for a clickless crossfade at each bar boundary.")]
        public AudioSource sourceA;
        public AudioSource sourceB;

        [Header("Off-board environment (Audio/Environment.json; preferred over intro tracks)")]
        [Tooltip("The importer-built EnvironmentBed source. When declared, it is the map's off-board layer and intro stems stay silent.")]
        public AudioSource fallbackBed;
        [Tooltip("Map-authored gain captured from Audio/Environment.json by MusicDirectorSetup.")]
        public float fallbackBedVolume = 0.15f;
        [Tooltip("Seconds to fade the filler away on mount and restore it on dismount.")]
        public float fallbackFadeSeconds = 1.5f;

        [Tooltip("Playback volume for whichever bar is foremost.")]
        public float volume = 0.45f;

        [Tooltip("External duck multiplier 0..1 - the race-music director pulls this to 0 while you ride " +
                 "(the game's INTRODUCK: the off-board bed gives way to the PathFinder song).")]
        public float duck = 1f;

        [Tooltip("Second, independent duck multiplier 0..1 - the video billboards pull this to ~0 while a video " +
                 "plays so its audio wins. Kept separate from 'duck' (they multiply) so the race duck and the " +
                 "video duck never overwrite each other - whichever is lower silences the bed.")]
        public float videoDuck = 1f;

        [Tooltip("Master mute from the Settings Board's 'Background music' checkbox: when true the bed is silenced " +
                 "(the bars keep advancing silently, so un-muting resumes cleanly). A bool defaulting to false (= " +
                 "audible) so an un-repushed instance can't be left silent by the new-field-default gotcha.")]
        public bool uiMuted;

        [Tooltip("Seconds to crossfade one bar into the next (0 -> shortest clickless cut). The bars are " +
                 "grid-aligned, so a short fade lands on-beat; long fades drift tempo slightly (fine for chill).")]
        public float crossfadeSeconds = 0.25f;

        [Tooltip("Shuffle-bag order (play all bars in a random order, reshuffle, never the same bar twice " +
                 "running) vs a strict A1->A2->A3->A4 loop.")]
        public bool shuffle = true;

        private bool _activeIsA;     // which source is foreground
        private bool _crossfading;
        private float _fadeT;        // seconds into the current crossfade
        private int[] _bag;          // shuffle-bag of track indices
        private int _bagPos;
        private int _current = -1;   // last index handed out (for no-immediate-repeat)
        private bool _ok;
        private bool _tracksOk;
        private bool _fallbackOk;
        private bool _riding;
        private float _fallbackFade = 1f;
        private float _lastTickT;    // Time.time the tick loop last ran (its own dt across the variable cadence)

        void Start()
        {
            _fallbackOk = fallbackBed != null && fallbackBed.clip != null;
            _tracksOk = !_fallbackOk && tracks != null && tracks.Length > 0 && sourceA != null;
            if (fallbackBed != null)
            {
                fallbackBed.Stop();
                fallbackBed.playOnAwake = false;
                fallbackBed.loop = true;
                fallbackBed.spatialBlend = 0f;
                fallbackBed.dopplerLevel = 0f;
                fallbackBed.volume = 0f;
                if (_fallbackOk) fallbackBed.Play();
            }
            if (!_tracksOk && !_fallbackOk)
            {
                Debug.LogWarning("MusicDirector: no declared environment bed and no intro tracks - nothing to play.");
                return;
            }
            if (_tracksOk)
            {
                ConfigureSource(sourceA);
                if (sourceB != null) ConfigureSource(sourceB);

                StartOn(sourceA, tracks[NextIndex()]);
                _activeIsA = true;
            }
            _ok = true;
            _lastTickT = Time.time;
            SendCustomEventDelayedSeconds(nameof(MusicTick), 0.05f);
        }

        void ConfigureSource(AudioSource s)
        {
            s.playOnAwake = false;   // the director drives playback, not playOnAwake
            s.loop = false;          // we sequence by hand; never let a source loop itself
            s.spatialBlend = 0f;     // 2D bed, heard everywhere
            s.dopplerLevel = 0f;
            s.volume = 0f;
        }

        void StartOn(AudioSource s, AudioClip clip)
        {
            s.clip = clip;
            s.time = 0f;
            s.volume = volume * Mathf.Clamp01(duck) * Mathf.Clamp01(videoDuck) * (uiMuted ? 0f : 1f);
            s.Play();
        }

        // SELF-SCHEDULED sequencer tick, cadence matched to the work: PER-FRAME only while a crossfade is running
        // (a 0.25 s volume ramp needs smooth steps), 20 Hz the rest of the bar - watching for the bar-end lead and
        // applying duck changes needs nothing finer, and the interpreted per-behaviour Update dispatch is exactly
        // the per-frame Udon cost Quest pays for. The fade advances by its own elapsed time (_lastTickT), so the
        // cadence never changes its speed. Rescheduled at the top so the loop is unconditional.
        public void MusicTick()
        {
            float fallbackTarget = _riding ? 0f : 1f;
            bool fadingFallback = _fallbackOk && Mathf.Abs(_fallbackFade - fallbackTarget) > 0.001f;
            if (_crossfading || fadingFallback) SendCustomEventDelayedFrames(nameof(MusicTick), 1);
            else SendCustomEventDelayedSeconds(nameof(MusicTick), 0.05f);
            float dt = Time.time - _lastTickT;
            _lastTickT = Time.time;
            if (!_ok) return;

            if (_fallbackOk)
            {
                _fallbackFade = Mathf.MoveTowards(_fallbackFade, fallbackTarget,
                    dt / Mathf.Max(0.05f, fallbackFadeSeconds));
                fallbackBed.volume = fallbackBedVolume * _fallbackFade * Mathf.Clamp01(videoDuck)
                    * (uiMuted ? 0f : 1f);
            }
            if (!_tracksOk) return;

            AudioSource active = _activeIsA ? sourceA : sourceB;
            AudioSource other  = _activeIsA ? sourceB : sourceA;
            float v = volume * Mathf.Clamp01(duck) * Mathf.Clamp01(videoDuck) * (uiMuted ? 0f : 1f);   // live duck: race director / video / the board's mute can pull us down mid-bar

            if (_crossfading)
            {
                float c = Mathf.Max(0.03f, crossfadeSeconds);
                _fadeT += dt;
                float t = Mathf.Clamp01(_fadeT / c);
                active.volume = v * (1f - t);
                other.volume  = v * t;
                if (t >= 1f)
                {
                    active.Stop();
                    active.volume = v;
                    _activeIsA = !_activeIsA;
                    _crossfading = false;
                }
                return;
            }

            active.volume = v;

            if (active.clip == null) return;

            // No second source -> can't crossfade; just re-trigger when the bar ends (a tiny gap is possible).
            if (other == null)
            {
                if (!active.isPlaying) StartOn(active, tracks[NextIndex()]);
                return;
            }

            float len = active.clip.length;
            float lead = Mathf.Min(Mathf.Max(0.08f, crossfadeSeconds), len * 0.5f);
            if (active.time >= len - lead)
            {
                StartOn(other, tracks[NextIndex()]);
                other.volume = 0f;
                _fadeT = 0f;
                _crossfading = true;
            }
        }

        /** Board-local state: the environment filler is an off-board layer, independent of race-music availability. */
        public void OnMount() { _riding = true; }
        public void OnDismount() { _riding = false; }

        // Next bar to play: shuffle-bag (no immediate repeat) or strict sequence.
        int NextIndex()
        {
            int n = tracks.Length;
            if (n <= 1) { _current = 0; return 0; }
            if (!shuffle)
            {
                _current = (_current + 1) % n;
                return _current;
            }
            if (_bag == null || _bag.Length != n || _bagPos >= n) RebuildBag();
            int idx = _bag[_bagPos];
            _bagPos++;
            _current = idx;
            return idx;
        }

        // Fresh Fisher-Yates shuffle; if the first pick repeats the last bar played, swap it to the back.
        void RebuildBag()
        {
            int n = tracks.Length;
            if (_bag == null || _bag.Length != n) _bag = new int[n];
            for (int i = 0; i < n; i++) _bag[i] = i;
            for (int i = n - 1; i > 0; i--)
            {
                int j = Random.Range(0, i + 1);
                int tmp = _bag[i]; _bag[i] = _bag[j]; _bag[j] = tmp;
            }
            if (n > 1 && _bag[0] == _current) { int tmp = _bag[0]; _bag[0] = _bag[n - 1]; _bag[n - 1] = tmp; }
            _bagPos = 0;
        }
    }
}
