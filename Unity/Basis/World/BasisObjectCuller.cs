using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Camera-RANGE cull for placed objects (trick gems, balloons, crash-bags, animated props) - the Basis port of the
    // VRChat ObjectCuller (VRC/World/ObjectCuller.cs). The perf fix for a dense-start course, where the port
    // otherwise draws the WHOLE course's ~119 props at once (the farthest ~1770 m away): from the mountain top every
    // prop is downhill in your view, so frustum culling can't help. It reproduces what the original SSX engine did
    // (Trailmap/specs/400-rendering "placed objects gathered by range"): gather the placed objects within a camera RANGE and draw
    // only those; terrain keeps drawing into the fog past it, but objects are hard-gated at the range.
    //
    // RENDERER-level (toggles Renderer.enabled, not GameObject.SetActive): a prop keeps ticking + colliding while only
    // its DRAW is gated, so culling can't stall a networked/animated prop, and distant colliders never cost the board's
    // short obstacle sweep anyway. Local + per-client. Built + wired by the neutral importer (ObjectCullerSetup ->
    // ObjectCullerMarker) and realized here by BasisWiring; the Perf Board's "Cull distant geometry" checkbox
    // enables/disables this whole component for full draw distance.
    //
    // Basis vs VRChat: identical range gate. VRChat self-scheduled a 10 Hz Udon event to dodge the interpreted per-frame
    // dispatch cost; Basis is plain C#, so a normal Update throttled to the same 10 Hz cadence (with the same SLICE sweep
    // for a big city list) is the direct equivalent - no Udon heartbeat/OnEnable-revival scaffolding needed. The player
    // position comes from BasisLocalPlayerProbe (Basis has no VRCPlayerApi).
    public class BasisObjectCuller : MonoBehaviour
    {
        [Tooltip("Every placed-object renderer to range-cull (importer-flattened from the gems / balloons / crash-bags / " +
                 "animated-prop roots). Renderers, not GameObjects, so an animated/networked prop keeps running while only its draw gates.")]
        public Renderer[] renderers;

        [Tooltip("PER-PLATFORM cull range in METRES, picked at Start from the build target (a Basis Android/Quest build is " +
                 "a separate build from Standalone/PC). Quest needs the tighter bound; PC can see much further. Dial either " +
                 "UP if props pop in too close, DOWN for more headroom. The Perf Board can also turn the whole culler off.")]
        public float rangeQuest = 600f;   // Android (Quest) build
        public float rangePC    = 1200f;  // Standalone (PC) build - bounds the mountain-top fall-line view + compact-city prop draw
        [System.NonSerialized] public float range;   // the active range, set per platform in Start (read every frame)

        [Tooltip("WIDER cull range (m) the 'off' toggle state uses. The culler stays ACTIVE and just widens - 'off' still " +
                 "BOUNDS the draw, it isn't unbounded. Quest off widens to the PC on-range (1200); PC off widens to 3000 " +
                 "(past the farthest prop, so nothing culls = full draw).")]
        public float rangeQuestOff = 1200f;   // Quest 'off' = the PC on-range (a perf-safe 'see more' tier)
        public float rangePCOff    = 3000f;   // PC 'off' = full draw (beyond every prop)

        [Tooltip("Drive RenderSettings distance fog END from the ACTIVE cull range (docs/unity/006): distant props are " +
                 "fully hazed EXACTLY where they cull (no pop-out), and the haze widens with the range when you loosen the " +
                 "cull. URP honours RenderSettings fog via MixFog, so this works the same as VRChat. Only the DISTANCES are " +
                 "set - fog colour + on/off stay per-level. Off = leave the static fog the importer baked.")]
        public bool controlFog = true;
        [Tooltip("Fog BEGIN distance (m), constant across both cull tiers - the near field stays crisp to here, then the haze extends to the fog end.")]
        public float fogStart = 300f;

        [System.NonSerialized] private float _rangeOn, _rangeOff;   // the active platform's tight/wide ranges (picked in SetCull)

        [Tooltip("Re-evaluate the cull set after the player moves this far (m) since the last pass, OR every recheckFrames " +
                 "ticks - movement-driven, the way the engine only re-gathered when its camera cell moved.")]
        public float recheckMoveDist = 25f;
        [Tooltip("Hard cap on how many ticks (0.1 s each) between re-evaluations (a standing player still refreshes occasionally).")]
        public int recheckFrames = 30;

        private const float TICK = 0.1f;   // throttle: 10 evaluations/s instead of a full sweep every frame
        private const int SLICE = 128;     // renderers evaluated per tick while a pass runs (spreads the sweep, no spike)

        private Vector3[] _pos;     // each renderer's mesh world-centre, cached at Start (placed objects don't translate)
        private bool[] _on;         // the enabled state we last set
        private Vector3 _lastPos;   // player position at the last evaluation
        private int _frame;         // ticks since the last pass was armed
        private bool _have;
        private int _drawn;         // running count of currently-enabled renderers
        private int _cursor = -1;   // next renderer index of the pass in progress; -1 = between passes
        private float _nextTick;    // Time.time of the next throttled evaluation

        // Live readout for a debug HUD: how many placed-object renderers are currently drawn vs the total.
        public int DrawnCount() { return _drawn; }
        public int Total() { return renderers == null ? 0 : renderers.Length; }

        void Start()
        {
            // Per-platform range, chosen at build time. Quest = the tighter bound it needs; PC = a much longer reach.
            // Editable per level on the component if a course wants more.
            SetCull(true);    // culling starts ON (tight range); the Perf Board asserts the real toggle state via SetCull. Sets range + fog.
            int n = renderers == null ? 0 : renderers.Length;
            _pos = new Vector3[n];
            _on = new bool[n];
            for (int i = 0; i < n; i++)
            {
                _on[i] = true;     // the importer builds them enabled; the first pass gates them by range
                // Cache the mesh's WORLD-SPACE centre, not transform.position: diverted breakable screens/signs sit at
                // the level origin (their meshes carry absolute root-local coords, so the GameObject is at localPos 0),
                // so transform.position would gate every one of them by distance-to-ORIGIN instead of to the screen.
                // bounds.center is the true location for those AND already equals transform.position for the recentred
                // props / spatial chunks - correct for the whole cull set.
                if (renderers[i] != null) _pos[i] = renderers[i].bounds.center;
            }
            _drawn = n;
            _nextTick = Time.time;   // first evaluation on the next frame
        }

        // The Performance Board turns culling on/off by disabling this component (PC default OFF -> full draw distance;
        // Quest default ON). When it goes disabled we must SHOW EVERYTHING again - the renderers are separate objects, so
        // they'd otherwise stay frozen at whatever the last range pass disabled. Re-enable them all here.
        void OnDisable()
        {
            if (renderers == null) return;
            for (int i = 0; i < renderers.Length; i++)
                if (renderers[i] != null && !renderers[i].enabled) renderers[i].enabled = true;
            if (_on != null) for (int i = 0; i < _on.Length; i++) _on[i] = true;
            _drawn = renderers.Length;
        }

        // Re-enabled (culling turned back on): force a fresh evaluation immediately rather than waiting out the movement
        // throttle, so distant geometry gates again at once.
        void OnEnable()
        {
            _have = false; _frame = 0; _cursor = -1;
            _nextTick = Time.time;
            if (range > 0f) ApplyFog();   // re-assert the fog end for the current range (range is 0 before the first Start, which sets it)
        }

        // Perf Board "Cull distant props" toggle - a two-tier RANGE switch, not an on/off (docs/unity/006): ON = the tight
        // cull range (Quest 600 / PC 1200); OFF = the WIDER range (Quest 1200 / PC 3000). The culler stays ACTIVE either
        // way - 'off' bounds the draw at the wide range, not unbounded, because Quest can't afford a truly-unbounded draw.
        // Swaps the active range + the fog end and forces a fresh sweep. Called by BasisPerfBoard; the platform pair is
        // (re)picked here so it's correct even if the board's first call beats Start.
        public void SetCull(bool tight)
        {
            // OFF ranges fall back to sane values when they serialize as 0: Quest OFF is the PC on-range by design,
            // PC OFF is full draw.
            float qOff = rangeQuestOff > 0f ? rangeQuestOff : rangePC;
            float pOff = rangePCOff   > 0f ? rangePCOff   : 3000f;
    #if UNITY_ANDROID
            _rangeOn = rangeQuest; _rangeOff = qOff;
    #else
            _rangeOn = rangePC;    _rangeOff = pOff;
    #endif
            range = tight ? _rangeOn : _rangeOff;
            ApplyFog();
            _have = false; _frame = 0; _cursor = -1;   // re-evaluate the visible set against the new range on the next tick
        }

        // Drive the scene fog END from the ACTIVE cull range so distant props are fully hazed exactly where the culler
        // drops them (no pop-out); the haze widens with the range when the cull is loosened. fogStart is constant. URP
        // reads RenderSettings fog through MixFog, so this behaves like the VRChat culler. Only the DISTANCES are touched -
        // fog on/off + COLOUR stay per-level. Local render state, per client.
        void ApplyFog()
        {
            if (!controlFog) return;
            RenderSettings.fogStartDistance = fogStart;
            RenderSettings.fogEndDistance = range;
        }

        // Throttled cull loop (10 Hz). Between passes it just watches player movement; an armed pass then sweeps the
        // renderer list in SLICE-sized chunks, one chunk per tick, so a big city list (~770 renderers) costs a bounded
        // ~SLICE distance tests per tick instead of one spike.
        void Update()
        {
            if (renderers == null || renderers.Length == 0) return;
            if (Time.time < _nextTick) return;
            _nextTick = Time.time + TICK;
            if (!BasisLocalPlayerProbe.TryGetPosition(out Vector3 p)) return;

            if (_cursor < 0)
            {
                // Between passes: arm one when the player moved enough (or it's been a while) - the cull set only changes
                // as you travel.
                _frame++;
                if (_have && _frame < recheckFrames && (p - _lastPos).sqrMagnitude < recheckMoveDist * recheckMoveDist) return;
                _frame = 0; _lastPos = p; _have = true; _cursor = 0;
            }

            // Pass in progress: evaluate the next slice against the CURRENT player position.
            float r2 = range * range;
            int count = _on.Length;
            int end = _cursor + SLICE; if (end > count) end = count;
            for (int i = _cursor; i < end; i++)
            {
                Renderer r = renderers[i];
                if (r == null) continue;
                bool want = (_pos[i] - p).sqrMagnitude <= r2;
                if (want != _on[i]) { r.enabled = want; _on[i] = want; _drawn += want ? 1 : -1; }
            }
            _cursor = end < count ? end : -1;
        }
    }
}
