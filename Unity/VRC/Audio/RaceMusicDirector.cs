using UdonSharp;
using UnityEngine;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// Plays the level's RACE soundtrack the way the game does: EA PathFinder interactive music
    /// (docs/039). A song is a directed graph of ~2.4 s bar-aligned music chunks; at each chunk end
    /// the engine follows one of the node's links by the link-selection rule: each link is
    /// {min, max, next} and the first link with min &lt;= PATH LEVEL &lt;= max wins (level 0..127,
    /// in-race default 80, trick tiers 90, "It's Tricky" 127) [Trailmap: 270-music-graph]. Logic nodes
    /// (no chunk) pass straight through. EVENTS (queued at runtime) are consumed at the next
    /// chunk boundary: eventTable[event,section] picks a router whose target node the playhead jumps
    /// to - the game fires 1/3/5 on uber-trick tier enter, 2/4/6 on tier exit, 0 = back to normal,
    /// 10 = finish. We schedule chunks gaplessly on two ping-ponged AudioSources via PlayScheduled
    /// (the chunks butt-join on the bar).
    ///
    /// The board pushes ride state (SetRideState) while the local player rides; the path level eases
    /// toward base + speed + boost + air (we have no trick system, so riding hard stands in for the
    /// trick tiers - boost also fires the tier-1 enter/exit events). Race music fades in on mount and
    /// out on dismount, ducking the off-board environment/intro director (MusicDirector) like the game's
    /// INTRODUCK. Local-only (sync None) - music is personal ambiance. OpenSlope/VRChat/Setup Race Audio.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class RaceMusicDirector : UdonSharpBehaviour
    {
        [Header("Song graph (filled by Setup Race Audio from the song's graph.json)")]
        [Tooltip("Decoded .mus chunks; nodeSample indexes into this.")]
        public AudioClip[] chunks;
        [Tooltip("Per node: the chunk it plays (-1 = logic node, passes straight to its link).")]
        public int[] nodeSample;
        [Tooltip("Per node: first entry in the flattened link arrays.")]
        public int[] nodeLinkStart;
        public int[] nodeLinkCount;
        [Tooltip("Flattened links: target node + the inclusive path-level range [lo..hi] that selects it.")]
        public int[] linkNext;
        public int[] linkLo;
        public int[] linkHi;
        [Tooltip("Per node: its section id (node flags & 0x7f) - the event table is per section.")]
        public int[] nodeSection;
        [Tooltip("eventTable[event * sections + section] = router index.")]
        public int[] eventTable;
        [Tooltip("Routers: packed u32 {action s8, flags u8, targetNode s16<<16}; flags&3 = node change.")]
        public int[] routers;
        public int sections = 4;
        public int entryNode = 0;

        [Header("Playback")]
        public AudioSource sourceA;
        public AudioSource sourceB;
        public float volume = 0.42f;
        [Tooltip("Seconds of dspTime lead when queueing the next chunk (intensity is sampled then).")]
        public float scheduleAhead = 0.5f;
        [Tooltip("Seconds to fade the race music in on mount / out on dismount.")]
        public float fadeSeconds = 1.5f;
        [Tooltip("External duck multiplier 0..1 - the video billboards pull this to ~0 while a video plays so its " +
                 "audio wins. Applied on top of the mount/dismount fade.")]
        public float externalDuck = 1f;

        [Tooltip("Master mute from the Settings Board's 'Race music' checkbox: when true the race soundtrack is " +
                 "silenced (the graph keeps walking under the hood, so un-muting resumes cleanly). A bool defaulting " +
                 "to false (= audible) so an un-repushed instance can't be left silent by the new-field-default gotcha.")]
        public bool uiMuted;

        [Header("Path level (0..127 - the game's link-selection variable; in-race default 80)")]
        [Tooltip("Path level while riding at any speed (the game holds 80 in a race).")]
        public float baseIntensity = 55f;
        [Tooltip("Full-speed riding adds this much on top of the base.")]
        public float speedToIntensity = 30f;
        [Tooltip("Boost stands in for the game's trick tiers (level 90+).")]
        public float boostBonus = 25f;
        public float airBonus = 12f;
        [Tooltip("Seconds for the level to ease toward its target (rise fast, fall slow).")]
        public float riseSmoothing = 1.2f;
        public float fallSmoothing = 4f;

        [Header("Off-board-bed ducking (the game's INTRODUCK)")]
        [Tooltip("The environment/intro director to duck while the race music plays.")]
        public MusicDirector introDirector;

        // ---- runtime ----
        private bool _playing;        // graph walk active (riding, or fading out after dismount)
        private bool _riding;
        private float _fade;          // 0..1 race-music fade level
        private float _intensity = 20f;
        private float _speed01;
        private bool _boost;
        private bool _airborne;

        private int _curNode = -1;
        private double _curEnd;       // dspTime the current chunk ends
        private bool _aIsCurrent;
        private bool _queued;
        private int _queuedNode;
        private double _queuedStart;
        private int _pendingEvent = -1;   // queued song event, consumed at the next chunk boundary

        void Start()
        {
            if (sourceA != null) ConfigureSource(sourceA);
            if (sourceB != null) ConfigureSource(sourceB);
        }

        void ConfigureSource(AudioSource s)
        {
            s.playOnAwake = false;
            s.loop = false;
            s.spatialBlend = 0f;
            s.dopplerLevel = 0f;
            s.volume = 0f;
        }

        /// <summary>Board push, every frame while the local player rides.</summary>
        public void SetRideState(float speed01, bool onGround, bool boosting, float airTime)
        {
            _speed01 = speed01;
            _boost = boosting;
            _airborne = !onGround && airTime > 0.4f;
        }

        public void OnMount()
        {
            _riding = true;
            if (!_playing) StartGraph();
        }

        public void OnDismount()
        {
            _riding = false; // keep walking the graph while the fade-out runs; Update stops it at 0
        }

        /// <summary>
        /// Queue a song event (consumed at the next chunk boundary, like the engine's event queue [Trailmap: 270-music-graph]):
        /// 0 = back to normal, 1/3/5 = trick-tier 1/2/3 enter, 2/4/6 = tier exit, 10 = finish.
        /// </summary>
        public void FireEvent(int songEvent)
        {
            if (songEvent >= 0) _pendingEvent = songEvent;
        }

        void StartGraph()
        {
            if (chunks == null || chunks.Length == 0 || sourceA == null || sourceB == null ||
                nodeSample == null || nodeSample.Length == 0) return;

            int node = entryNode;
            if (node < 0 || node >= nodeSample.Length) node = 0;
            if (nodeSample[node] < 0) node = ResolveToSampleNode(node);
            if (node < 0) return;

            double startAt = AudioSettings.dspTime + 0.15;
            sourceA.clip = chunks[nodeSample[node]];
            sourceA.volume = 0f;
            sourceA.PlayScheduled(startAt);
            _curNode = node;
            _curEnd = startAt + ClipLength(node);
            _aIsCurrent = true;
            _queued = false;
            _playing = true;
            _fade = 0f;
        }

        void StopGraph()
        {
            _playing = false;
            _queued = false;
            if (sourceA != null) sourceA.Stop();
            if (sourceB != null) sourceB.Stop();
        }

        void Update()
        {
            float dt = Time.deltaTime;

            // Fade the race layer in while riding, out after dismount; duck the off-board bed inversely.
            float fadeTarget = _riding ? 1f : 0f;
            _fade = Mathf.MoveTowards(_fade, fadeTarget, dt / Mathf.Max(0.05f, fadeSeconds));
            if (introDirector != null) introDirector.duck = 1f - _fade;
            if (!_playing) return;

            if (!_riding && _fade <= 0f) { StopGraph(); return; }

            UpdateIntensity(dt);

            float v = volume * _fade * Mathf.Clamp01(externalDuck) * (uiMuted ? 0f : 1f);
            if (sourceA != null) sourceA.volume = v;
            if (sourceB != null) sourceB.volume = v;

            double now = AudioSettings.dspTime;

            // Queue the next chunk a little before the current one ends (sampling the path level now).
            // A pending song event routes the playhead via the event table instead of the normal link.
            if (!_queued && now + scheduleAhead >= _curEnd)
            {
                int next = -1;
                if (_pendingEvent >= 0)
                {
                    next = ResolveEvent(_pendingEvent, _curNode);
                    _pendingEvent = -1;
                }
                if (next < 0) next = ResolveToSampleNode(PickLink(_curNode));
                if (next < 0) next = entryNode >= 0 && nodeSample[entryNode] >= 0 ? entryNode : _curNode;
                AudioSource idle = _aIsCurrent ? sourceB : sourceA;
                idle.clip = chunks[nodeSample[next]];
                idle.volume = v;
                idle.PlayScheduled(_curEnd);
                _queuedNode = next;
                _queuedStart = _curEnd;
                _queued = true;
            }

            // The queued chunk has started: it becomes current; the other source is free for the next queue.
            if (_queued && now >= _queuedStart)
            {
                _curNode = _queuedNode;
                _curEnd = _queuedStart + ClipLength(_curNode);
                _aIsCurrent = !_aIsCurrent;
                _queued = false;
            }
        }

        void UpdateIntensity(float dt)
        {
            float target = baseIntensity + _speed01 * speedToIntensity;
            if (_boost) target += boostBonus;
            if (_airborne) target += airBonus;
            if (!_riding) target = 0f;
            if (target > 127f) target = 127f;

            float tau = target > _intensity ? riseSmoothing : fallSmoothing;
            _intensity = Mathf.Lerp(_intensity, target, dt / Mathf.Max(0.05f, tau) );
            if (_intensity < 0f) _intensity = 0f;
            if (_intensity > 127f) _intensity = 127f;
        }

        // The link-selection rule [Trailmap: 270-music-graph]: first link whose inclusive [min..max] contains the path level.
        int PickLink(int node)
        {
            if (node < 0 || nodeLinkStart == null || node >= nodeLinkStart.Length) return -1;
            int start = nodeLinkStart[node];
            int count = nodeLinkCount[node];
            if (count <= 0) return -1;
            int it = (int)_intensity;
            for (int i = 0; i < count; i++)
            {
                if (it >= linkLo[start + i] && it <= linkHi[start + i]) return linkNext[start + i];
            }
            return linkNext[start]; // out-of-range guard: first link
        }

        // The event path [Trailmap: 270-music-graph]: eventTable[event, current node's section] -> router -> jump target.
        // Router flags&3 == 0 means "no node change" (volume/end actions we don't model) -> -1.
        int ResolveEvent(int songEvent, int node)
        {
            if (eventTable == null || routers == null || nodeSection == null) return -1;
            int section = node >= 0 && node < nodeSection.Length ? nodeSection[node] : 0;
            if (section >= sections) section = 0;
            int idx = songEvent * sections + section;
            if (idx < 0 || idx >= eventTable.Length) return -1;
            int r = eventTable[idx];
            if (r < 0 || r >= routers.Length) return -1;
            int router = routers[r];
            if (((router >> 8) & 0x3) == 0) return -1;       // no node change
            int target = router >> 16;                        // s16 (sign carried by int shift)
            if (target < 0 || target >= nodeSample.Length) return -1;
            return ResolveToSampleNode(target);
        }

        // Logic nodes carry no chunk - pass through them (bounded walk so a malformed graph can't hang).
        int ResolveToSampleNode(int node)
        {
            for (int guard = 0; guard < 16; guard++)
            {
                if (node < 0 || node >= nodeSample.Length) return -1;
                if (nodeSample[node] >= 0) return node;
                node = PickLink(node);
            }
            return -1;
        }

        double ClipLength(int node)
        {
            AudioClip c = chunks[nodeSample[node]];
            if (c == null) return 1.0;
            return (double)c.samples / c.frequency;
        }
    }
}
