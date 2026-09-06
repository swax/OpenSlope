using UnityEngine;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// Camera-RANGE cull for placed objects (trick gems, balloons, crash-bags, animated props) - the perf fix for
    /// a dense-start course, where the port otherwise draws the WHOLE course's props at once (the farthest
    /// ~1770 m away) because from the mountain top every prop is downhill in your view and frustum culling can't help.
    ///
    /// This reproduces what the original SSX engine did (RE, Trailmap/specs/400-rendering "placed objects gathered by
    /// range"): each frame it gathered the placed objects within a ~300 m CAMERA RANGE (a spatial-grid range gather +
    /// frustum cull) and submitted only those - terrain kept drawing into the fog past it, but objects were hard-gated
    /// at the range. There is NO object mesh-LOD or streaming in the original (all objects resident; all three model
    /// LOD slots ship pointing at the same mesh) - the range gather alone is the bound. We don't need the spatial grid
    /// at ~119 objects, so this is the same range gate as a throttled per-object distance test.
    ///
    /// RENDERER-level (we toggle <c>Renderer.enabled</c>, not <c>GameObject.SetActive</c>): a synced or Udon-driven
    /// prop keeps ticking + colliding while only its DRAW is gated, so culling can't cause a sync hiccup, and distant
    /// colliders never cost the board's short (~0.5 m) obstacle sweep anyway. Local + per-client (sync None). Built +
    /// wired by the importer (PropBuilder) / the OpenSlope/Optimize menu; the importer flattens every placed-object renderer in.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class ObjectCuller : UdonSharpBehaviour
    {
        [Tooltip("Every placed-object renderer to range-cull (importer-flattened from the gems / balloons / crash-bags / " +
                 "animated-prop roots). Renderers, not GameObjects, so synced/Udon props keep running while only their draw gates.")]
        public Renderer[] renderers;

        [Tooltip("PER-PLATFORM cull range in METRES, picked at Start from the build target (a VRChat Quest upload is a " +
                 "separate Android build, PC a separate Standalone build, so each gets its own value). Quest needs the " +
                 "tighter bound; PC can see much further. Dial either UP if props pop in too close, DOWN for more headroom. " +
                 "The Diagnostics Board's 'Cull distant geometry' row swaps the tight range for the wider one.")]
        public float rangeQuest = 600f;   // Android (Quest) build
        public float rangePC    = 1200f;  // Standalone (PC) build - bounds the mountain-top fall-line view + compact-city prop draw
        [System.NonSerialized] public float range;   // the active range, set per platform in Start (read every frame)

        [Tooltip("WIDER cull range (m) the 'off' toggle state uses. The culler stays ACTIVE and just widens - 'off' still " +
                 "BOUNDS the draw, it isn't unbounded. Quest off widens to the PC on-range (1200) - Quest can't afford " +
                 "truly-unbounded draw - while PC off widens to 3000 (past the farthest prop, so nothing culls = full draw).")]
        public float rangeQuestOff = 1200f;   // Quest 'off' = the PC on-range (a perf-safe 'see more' tier)
        public float rangePCOff    = 3000f;   // PC 'off' = full draw (beyond every prop)

        [Tooltip("Drive RenderSettings distance fog END from the ACTIVE cull range (docs/unity/006): distant props are " +
                 "fully hazed EXACTLY where they cull (no pop-out), and the haze widens with the range when you loosen the " +
                 "cull. Only the DISTANCES are set - fog colour + on/off stay per-level from the baked sky. Off = leave the static fog.")]
        public bool controlFog = true;
        [Tooltip("Fog BEGIN distance (m), constant across both cull tiers - the near field stays crisp to here, then the haze extends to the fog end.")]
        public float fogStart = 300f;

        [System.NonSerialized] private float _rangeOn, _rangeOff;   // the active platform's tight/wide ranges (picked in SetCull)

        [Tooltip("Re-evaluate the cull set after the player moves this far (m) since the last pass, OR every recheckFrames " +
                 "ticks - movement-driven, the way the engine only re-gathered when its camera cell moved.")]
        public float recheckMoveDist = 25f;
        [Tooltip("Hard cap on how many ticks (0.1 s each) between re-evaluations (a standing player still refreshes occasionally).")]
        public int recheckFrames = 30;

        private const float TICK = 0.1f;   // self-scheduled cadence: 10 dispatches/s instead of a per-frame Update
        private const int SLICE = 128;     // renderers evaluated per tick while a pass runs (spreads the sweep, no spike)

        private VRCPlayerApi _player;
        private Vector3[] _pos;     // each renderer's mesh world-centre, cached at Start (placed objects don't translate)
        private bool[] _on;         // the enabled state we last set
        private Vector3 _lastPos;   // player position at the last evaluation
        private int _frame;         // ticks since the last pass was armed
        private bool _have;
        private int _drawn;         // running count of currently-enabled renderers (for the debug HUD)
        private int _cursor = -1;   // next renderer index of the pass in progress; -1 = between passes
        private float _lastTick;    // heartbeat: Time.time the loop last fired (OnEnable revives a dead loop off it)

        // Live readout for DebugHud: how many placed-object renderers are currently being drawn vs the total.
        public int DrawnCount() { return _drawn; }
        public int Total() { return renderers == null ? 0 : renderers.Length; }

        void Start()
        {
            // Per-platform range, chosen at build time (UdonSharp honours the active build target's #if). Quest = the
            // tighter bound it needs; PC = a much longer reach. Editable per level on the component if a course wants more.
            SetCull(true);    // culling starts ON (tight range); the Diagnostics Board asserts the real toggle state via SetCull. Sets range + fog.
            _player = Networking.LocalPlayer;
            int n = renderers == null ? 0 : renderers.Length;
            _pos = new Vector3[n];
            _on = new bool[n];
            for (int i = 0; i < n; i++)
            {
                _on[i] = true;     // the importer builds them enabled; the first Update gates them by range
                // Cache the mesh's WORLD-SPACE centre, not transform.position: diverted breakable screens/signs sit at
                // the level origin (their meshes carry absolute root-local coords, so the GameObject is at localPos 0),
                // so transform.position would gate every one of them by distance-to-ORIGIN instead of to the screen.
                // bounds.center is the true location for those AND already equals transform.position for the recentred
                // props / spatial chunks - correct for the whole cull set. The video billboard screens are in the set
                // while INACTIVE (video is opt-in), so fall back to transform.position if a renderer that has never been
                // active reports degenerate bounds - each screen's pivot sits on its own board.
                if (renderers[i] == null) continue;
                Bounds b = renderers[i].bounds;
                _pos[i] = b.size.sqrMagnitude > 1e-6f ? b.center : renderers[i].transform.position;
            }
            _drawn = n;
            SendCustomEventDelayedSeconds(nameof(CullTick), TICK);
        }

        // The Diagnostics Board switches the cull range on this object (PC default OFF -> full draw distance;
        // Quest default ON). When it goes inactive we must SHOW EVERYTHING again - the renderers are separate objects, so
        // they'd otherwise stay frozen at whatever the last range pass disabled. Re-enable them all here.
        void OnDisable()
        {
            if (renderers == null) return;
            for (int i = 0; i < renderers.Length; i++)
                if (renderers[i] != null && !renderers[i].enabled) renderers[i].enabled = true;
            if (_on != null) for (int i = 0; i < _on.Length; i++) _on[i] = true;
            _drawn = renderers.Length;
        }

        // Re-enabled (culling turned back on): force a fresh evaluation on the next tick rather than waiting out the
        // movement throttle, so distant geometry gates again immediately. Delayed events fire even on a disabled
        // behaviour, so the tick loop normally survives the board's SetActive toggle; the heartbeat restart is
        // the belt-and-braces for a runtime where they don't - a culler whose loop silently died would draw the whole
        // level forever.
        void OnEnable()
        {
            _have = false; _frame = 0; _cursor = -1;
            if (range > 0f) ApplyFog();   // re-assert the fog end for the current range (range is 0 before the first Start, which sets it)
            if (_lastTick > 0f && Time.time - _lastTick > TICK * 4f + 0.5f) SendCustomEventDelayedSeconds(nameof(CullTick), TICK);
        }

        // Diagnostics Board "Cull distant geometry" toggle - a two-tier RANGE switch, not an on/off (docs/unity/006): ON = the
        // tight cull range (Quest 600 / PC 1200); OFF = the WIDER range (Quest 1200 / PC 3000). The culler stays ACTIVE
        // either way - 'off' bounds the draw at the wide range, not unbounded, because Quest can't afford a truly-unbounded
        // draw. Swaps the active range + the fog end and forces a fresh sweep so the visible set updates at once. Called by
        // the Diagnostics Board; the platform pair is (re)picked here so it's correct even if the board's first call beats Start.
        public void SetCull(bool tight)
        {
            // OFF ranges fall back to sane values if a pre-two-tier culler serialized them as 0 (new fields default to 0,
            // not the initializer, until the level is re-imported): Quest OFF is the PC on-range by design, PC OFF is full draw.
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
        // drops them (no pop-out); the haze widens with the range when the cull is loosened. fogStart is constant. Only the
        // DISTANCES are touched - fog on/off and COLOUR stay as the importer baked them (colour is the per-level sky
        // horizon), so a fog-disabled level shows nothing regardless. Local render state, per client, like the cull itself.
        void ApplyFog()
        {
            if (!controlFog) return;
            RenderSettings.fogStartDistance = fogStart;
            RenderSettings.fogEndDistance = range;
        }

        // SELF-SCHEDULED cull loop (10 Hz instead of a per-frame Update - the interpreted per-behaviour dispatch is
        // the per-frame Udon cost that matters on Quest). Between passes it just watches player movement; an armed
        // pass then sweeps the renderer list in SLICE-sized chunks, one chunk per tick, so a big city list (~770
        // renderers) costs a bounded ~SLICE distance tests per tick instead of one spike. Sweep latency at full list
        // size is ~0.6 s, well inside what a 600 m range gate can hide.
        public void CullTick()
        {
            _lastTick = Time.time;
            SendCustomEventDelayedSeconds(nameof(CullTick), TICK);
            if (!enabled || !gameObject.activeInHierarchy) { _cursor = -1; return; }   // the board turned culling off; OnDisable re-showed everything
            if (_player == null) { _player = Networking.LocalPlayer; if (_player == null) return; }

            if (_cursor < 0)
            {
                // Between passes: arm one when the player moved enough (or it's been a while) - the cull set only
                // changes as you travel.
                Vector3 p = _player.GetPosition();
                _frame++;
                if (_have && _frame < recheckFrames && (p - _lastPos).sqrMagnitude < recheckMoveDist * recheckMoveDist) return;
                _frame = 0; _lastPos = p; _have = true; _cursor = 0;
            }

            // Pass in progress: evaluate the next slice against the CURRENT player position.
            Vector3 pp = _player.GetPosition();
            float r2 = range * range;
            int count = _on.Length;
            int end = _cursor + SLICE; if (end > count) end = count;
            for (int i = _cursor; i < end; i++)
            {
                Renderer r = renderers[i];
                if (r == null) continue;
                bool want = (_pos[i] - pp).sqrMagnitude <= r2;
                if (want != _on[i]) { r.enabled = want; _on[i] = want; _drawn += want ? 1 : -1; }
            }
            _cursor = end < count ? end : -1;
        }
    }
}
