using UdonSharp;
using UnityEngine;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// Cycles the _MainTex of SSX's flipbook material slots on the Udon runtime — the crowd billboards, the
    /// flickering signs / LCD panels, the start gate. Purely cosmetic and LOCAL — sync mode None, every client
    /// flips its own copy; nothing networked.
    ///
    /// You don't add this by hand: the importer attaches and configures it directly via UdonTools.AddConfigured on
    /// OpenSlope_Flipbooks (LevelImporter, fed by PropBuilder via FlipbookAccum). See docs/vrchat/013-udon-components.md
    /// and docs/008-texture-animation.md.
    ///
    /// GROUPED BY MATERIAL: a city level authors the same handful of flipbook animations across hundreds of
    /// renderer slots (every breakable screen plus each of its shatter shards carries a slot — a city map can wire
    /// hundreds of slots over many distinct animations), and per-frame per-SLOT work in the interpreted Udon VM is exactly the
    /// cost that breaks Quest. So Start() groups the slots by their shared flipbook .mat asset (same asset ==
    /// same frames/fps/dwell — MaterialFactory names one .mat per frame set), instantiates ONE material per
    /// group on a leader slot, and points every member renderer's slot at that same instance. Update() then
    /// walks only the GROUPS: one texture write per group per flip drives every renderer in it, and the
    /// per-frame VM cost scales with the number of distinct animations, not the number of screens/shards.
    /// Members keep their other (non-flip) material slots shared, so batching on those is untouched.
    ///
    /// TWO Udon-forced traits shape the data + draw path:
    ///   1. DATA LAYOUT. UdonSharp can't serialize a List of a custom class, so each animated slot is split
    ///      across parallel arrays indexed by target i — <see cref="Renderers"/>/<see cref="Slots"/>/<see
    ///      cref="Fps"/>/<see cref="FrameCounts"/> — plus a single <see cref="Frames"/> with every target's
    ///      frames concatenated, sliced by a prefix-sum offset computed in Start. FlipbookAccum builds this.
    ///   2. NO MaterialPropertyBlock. Udon doesn't expose it (nor per-slot SetPropertyBlock), so instead of a
    ///      per-draw _MainTex override we instantiate the group leader's material once (first .materials access
    ///      instantiates and the renderer keeps the instances) and set its _MainTex — one material copy per
    ///      GROUP, functionally identical on screen.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class FlipbookAnimator : UdonSharpBehaviour
    {
        [Tooltip("Target renderer per flipbook slot (parallel arrays the importer fills).")]
        public Renderer[] Renderers;
        [Tooltip("Material-slot (submesh) index on the matching renderer.")]
        public int[] Slots;
        [Tooltip("Each slot's own frames-per-second. Always > 0 - a material with no playback rate is not a flipbook.")]
        public float[] Fps;
        [Tooltip("Number of frames each slot cycles (>= 2); slices the flat Frames array.")]
        public int[] FrameCounts;
        [Tooltip("Every slot's frames, concatenated in slot order, in play order within each slot.")]
        public Texture2D[] Frames;
        [Tooltip("U4 pause screens: base hold seconds for frame A (0 = uniform Fps playback). Each cycle the actual hold is base/u, u ~ uniform[0.25,1) - the engine's random re-arm.")]
        public float[] DwellBase;
        [Tooltip("U4 pause screens: seconds frame B flashes (the engine's fixed 1/6-per-tick re-arm = 6 ticks = 0.1s at the measured 60 Hz list).")]
        public float[] DwellFlash;

        // Per-GROUP state (one group per distinct flipbook .mat asset; built in Start).
        private Material[] _mats;     // the group's single instanced material (every member renderer points at it)
        private int[] _offsets;       // start index into Frames for the group's leader slot
        private int[] _counts;        // frame count of the group's animation
        private float[] _fps;         // the group's playback rate
        private float[] _dwellBase;   // dwell hold seconds (0 = uniform fps path); folded from any member slot
        private float[] _dwellFlash;  // dwell flash seconds
        private int[] _applied;       // last frame index pushed to the group (-1 = none yet)
        private float[] _dwellNext;   // dwell groups: Time.time at which the current frame expires
        private int _groups;
        private bool _ready;

        void Start()
        {
            int n = Renderers == null ? 0 : Renderers.Length;

            // Pass 1: assign each slot to a group keyed on its shared flipbook .mat asset. Same asset == same
            // animation (frames, fps, dwell) by construction, and identical look is guaranteed. Groups are few
            // (~a dozen), so a linear key scan is fine — this runs once at load.
            int[] slotGroup = new int[n];
            int[] groupKey = new int[n];
            int[] leaderSlot = new int[n];
            int[] slotOffset = new int[n];
            _groups = 0;
            int off = 0;
            for (int i = 0; i < n; i++)
            {
                slotOffset[i] = off;
                off += FrameCounts[i];
                slotGroup[i] = -1;
                var r = Renderers[i];
                if (r == null || FrameCounts[i] < 2) continue;
                var sm = r.sharedMaterials;
                int s = Slots[i];
                if (s < 0 || s >= sm.Length || sm[s] == null) continue;
                int key = sm[s].GetInstanceID();
                int g = -1;
                for (int j = 0; j < _groups; j++) if (groupKey[j] == key) { g = j; break; }
                if (g < 0) { g = _groups; _groups++; groupKey[g] = key; leaderSlot[g] = i; }
                slotGroup[i] = g;
            }

            // Pass 2: instantiate each group's material on its leader (first .materials access instantiates the
            // renderer's set and it keeps the instances) and capture the group's animation parameters. Leaders
            // instantiate BEFORE any member write, so a renderer that leads one group and belongs to another
            // clones only original assets.
            _mats = new Material[_groups];
            _offsets = new int[_groups];
            _counts = new int[_groups];
            _fps = new float[_groups];
            _dwellBase = new float[_groups];
            _dwellFlash = new float[_groups];
            _applied = new int[_groups];
            _dwellNext = new float[_groups];
            for (int g = 0; g < _groups; g++)
            {
                int i = leaderSlot[g];
                var mats = Renderers[i].materials;
                int s = Slots[i];
                if (s >= 0 && s < mats.Length) _mats[g] = mats[s];
                _offsets[g] = slotOffset[i];
                _counts[g] = FrameCounts[i];
                _fps[g] = (Fps != null && i < Fps.Length) ? Fps[i] : 0f;
                _applied[g] = -1;
            }

            // Fold dwell params from ANY member onto its group (a screen's shards ride the intact slot's dwell
            // law), then point every non-leader member's slot at the group material. sharedMaterials set writes
            // just the one entry — members' other slots stay on their shared assets.
            for (int i = 0; i < n; i++)
            {
                int g = slotGroup[i];
                if (g < 0) continue;
                if (DwellBase != null && i < DwellBase.Length && DwellBase[i] > _dwellBase[g])
                {
                    _dwellBase[g] = DwellBase[i];
                    _dwellFlash[g] = (DwellFlash != null && i < DwellFlash.Length && DwellFlash[i] > 0f) ? DwellFlash[i] : 0.1f;
                }
                if (i == leaderSlot[g]) continue;
                var r = Renderers[i];
                var sm = r.sharedMaterials;
                int s = Slots[i];
                if (s < 0 || s >= sm.Length) continue;
                sm[s] = _mats[g];
                r.sharedMaterials = sm;
            }

            _ready = _groups > 0;
        }

        void Update()
        {
            if (!_ready) return;
            float t = Time.time;   // Udon has no Time.timeAsDouble; float is fine for a cosmetic flipbook
            int n = _groups;
            for (int g = 0; g < n; g++)
            {
                var m = _mats[g];
                if (m == null) continue;
                int cnt = _counts[g];

                // U4 pause screens [Trailmap: 410-texture-animation]: hold frame A for
                // base/u seconds with u rolled uniform[0.25,1) each cycle (first hold exactly base), then flash
                // frame B for the fixed DwellFlash. Timer-driven per GROUP — one group per distinct screen
                // animation, so distinct screens drift out of sync organically like the original, and a screen's
                // shards flip in lockstep with it (they share the material).
                if (_dwellBase[g] > 0f)
                {
                    if (_applied[g] >= 0 && t < _dwellNext[g]) continue;
                    int fi;
                    if (_applied[g] <= 0)   // first frame (-1) -> start dwelling on A; dwell ended (0) -> flash B
                    {
                        fi = _applied[g] < 0 ? 0 : 1;
                        _dwellNext[g] = t + (fi == 0 ? _dwellBase[g] : _dwellFlash[g]);
                    }
                    else                    // flash ended -> back to A, re-roll the hold
                    {
                        fi = 0;
                        _dwellNext[g] = t + _dwellBase[g] / Random.Range(0.25f, 1f);
                    }
                    _applied[g] = fi;
                    var dtex = Frames[_offsets[g] + fi];
                    if (dtex != null) m.SetTexture("_MainTex", dtex);
                    continue;
                }

                float fps = _fps[g];
                if (fps <= 0f) continue;
                int idx = (int)(t * fps) % cnt;   // t >= 0 so the truncating cast == floor; no negative-mod dance
                if (idx == _applied[g]) continue;
                _applied[g] = idx;
                var tex = Frames[_offsets[g] + idx];
                if (tex == null) continue;
                m.SetTexture("_MainTex", tex);
            }
        }
    }
}
