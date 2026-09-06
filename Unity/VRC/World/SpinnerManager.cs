using UdonSharp;
using UnityEngine;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// Revolves ALL of SSX's trick-multiplier "gem" pickups from a SINGLE Update(), instead of one
    /// spinner behaviour (and its own Update) per gem. Functionally identical to a per-gem spinner — same
    /// formula, <c>Quaternion.AngleAxis(phase + dps*Time.time, axis) * rest</c> — but 79 separate Udon Update
    /// dispatches collapse to one VM context iterating a flat array, which is the per-frame cost that matters on
    /// Udon (the interpreted event dispatch, paid once per behaviour per frame). This is the same "one manager,
    /// parallel arrays the importer fills" shape as <see cref="FlipbookAnimator"/>.
    ///
    /// RANGE-GATED: only gems within <see cref="SpinRange"/> of the local player actually spin. Each transform
    /// write is an interpreted-VM extern (the expensive unit on Quest), and a 1 m gem's rotation is invisible
    /// well inside the ObjectCuller draw range — so the per-frame loop walks a NEAR list, rebuilt with the
    /// culler's movement throttle (every 25 m of travel or 30 frames) from world positions cached at Start
    /// (gems spin and scale in place; they never translate). A gem re-entering range picks up the correct
    /// absolute phase — the spin formula runs on shared Time.time, not an accumulator.
    ///
    /// Purely cosmetic and LOCAL — sync mode None, every client spins its own copy; nothing networked, no
    /// late-join state. The gems' COLLECT logic stays per-gem on <see cref="GemPickup"/> (it's event-driven,
    /// has no Update, and drives its own pop/grow-back on a hit via its trigger callbacks), so only the spin half is
    /// consolidated here - the two write different transform channels (this rotation, the pickup scale), so they don't fight.
    ///
    /// You don't add this by hand: the importer (PropBuilder.BuildSpinners) attaches one of these on OpenSlope_Spinners
    /// and fills the arrays via UdonTools.AddConfigured. See docs/vrchat/013-udon-components.md.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class SpinnerManager : UdonSharpBehaviour
    {
        [Tooltip("Gem transform per slot (parallel arrays the importer fills).")]
        public Transform[] Targets;
        [Tooltip("Spin axis per slot, in WORLD space (Unity world-up for SSX pickups after the importer's orientation fix).")]
        public Vector3[] Axes;
        [Tooltip("Revolve rate per slot, in degrees per second.")]
        public float[] DegreesPerSecond;
        [Tooltip("Per-slot starting angle (deg) so a cluster of gems doesn't spin in lockstep.")]
        public float[] PhaseDegrees;
        [Tooltip("Per-gem ambient floor for the GPU-instanced shared-mesh gems, re-applied via a MaterialPropertyBlock in " +
                 "Start (an edit-time block is runtime-only, so it's lost entering play/build - without this the gems draw black).")]
        public Color[] InstAmbient;
        [Tooltip("Exact per-gem directional keys and fixed Unity-world TOWARD-light directions.")]
        public Color[] InstKey1, InstKey2, InstKey3;
        public Vector3[] InstDir1, InstDir2, InstDir3;
        [Tooltip("Metres to the local player inside which a gem spins. A 1 m gem's rotation reads as static well " +
                 "inside the culler's draw range, so this bounds the per-frame VM work to the gems that matter.")]
        public float SpinRange = 300f;

        [Tooltip("Rebuild the near set after the player moves this far (m) since the last pass (the culler's throttle).")]
        public float RecheckMoveDist = 25f;
        [Tooltip("Hard cap on how many frames between near-set rebuilds.")]
        public int RecheckFrames = 30;

        private Quaternion[] _rest;   // each slot's orientation to spin around, captured once at Start
        private Vector3[] _axis;      // normalized spin axis per slot, precomputed so Update doesn't normalize
        private Vector3[] _pos;       // each gem's world position, cached at Start (gems never translate)
        private int[] _near;          // slot indices currently within SpinRange (the per-frame working set)
        private int _nearCount;
        private VRCPlayerApi _player;
        private Vector3 _lastPos;     // player position at the last near-set rebuild
        private int _frame;
        private bool _have;
        private int _count;
        private bool _ready;

        void Start()
        {
            _count = Targets == null ? 0 : Targets.Length;
            _rest = new Quaternion[_count];
            _axis = new Vector3[_count];
            _pos = new Vector3[_count];
            _near = new int[_count];
            // Re-apply each GPU-instanced gem's per-instance SSX light. SetPropertyBlock is runtime-only (not serialized),
            // so the importer's edit-time block is gone by play/build - re-push it here so the shader's _DIRLIGHT_INST path
            // lights each shared-mesh gem individually (same fix as PhysicsProp; docs/012). SetVector preserves the
            // raw /256 factors and directions; SetColor would apply an unwanted sRGB->linear conversion.
            var mpb = new MaterialPropertyBlock();
            bool hasLight = InstAmbient != null && InstAmbient.Length == _count;
            for (int i = 0; i < _count; i++)
            {
                Transform tr = Targets[i];
                _rest[i] = tr != null ? tr.rotation : Quaternion.identity;
                _pos[i] = tr != null ? tr.position : Vector3.zero;
                Vector3 a = (Axes != null && i < Axes.Length) ? Axes[i] : Vector3.up;
                _axis[i] = a.sqrMagnitude > 1e-6f ? a.normalized : Vector3.up;
                if (hasLight && tr != null)
                {
                    MeshRenderer mr = (MeshRenderer)tr.GetComponent(typeof(MeshRenderer));
                    if (mr != null)
                    {
                        Color a2 = InstAmbient[i];
                        mr.GetPropertyBlock(mpb);
                        mpb.SetVector("_InstAmbient", new Vector4(a2.r, a2.g, a2.b, 1f));
                        SetLight(mpb, "_InstKey1", InstKey1, i, false);
                        SetLight(mpb, "_InstKey2", InstKey2, i, false);
                        SetLight(mpb, "_InstKey3", InstKey3, i, false);
                        SetDirection(mpb, "_InstDir1", InstDir1, i);
                        SetDirection(mpb, "_InstDir2", InstDir2, i);
                        SetDirection(mpb, "_InstDir3", InstDir3, i);
                        mr.SetPropertyBlock(mpb);
                    }
                }
            }
            _ready = true;
        }

        private void SetLight(MaterialPropertyBlock block, string name, Color[] values, int index, bool white)
        {
            Color c = values != null && index < values.Length ? values[index] : (white ? Color.white : Color.black);
            block.SetVector(name, new Vector4(c.r, c.g, c.b, 1f));
        }

        private void SetDirection(MaterialPropertyBlock block, string name, Vector3[] values, int index)
        {
            Vector3 d = values != null && index < values.Length ? values[index] : Vector3.up;
            block.SetVector(name, new Vector4(d.x, d.y, d.z, 0f));
        }

        void Update()
        {
            if (!_ready) return;
            if (_player == null) { _player = Networking.LocalPlayer; if (_player == null) return; }
            Vector3 p = _player.GetPosition();

            // Movement-throttled near-set rebuild — the visible-spin set only changes as you travel.
            _frame++;
            if (!_have || _frame >= RecheckFrames || (p - _lastPos).sqrMagnitude >= RecheckMoveDist * RecheckMoveDist)
            {
                _frame = 0; _lastPos = p; _have = true;
                _nearCount = 0;
                float r2 = SpinRange * SpinRange;
                for (int i = 0; i < _count; i++)
                {
                    if (Targets[i] == null) continue;
                    if ((_pos[i] - p).sqrMagnitude <= r2) { _near[_nearCount] = i; _nearCount++; }
                }
            }

            float t = Time.time;   // t >= 0; absolute time over the captured rest, so the spin never drifts
            int n = _nearCount;
            for (int k = 0; k < n; k++)
            {
                int i = _near[k];
                Transform tr = Targets[i];
                if (tr == null) continue;
                float angle = PhaseDegrees[i] + DegreesPerSecond[i] * t;
                tr.rotation = Quaternion.AngleAxis(angle, _axis[i]) * _rest[i];
            }
        }
    }
}
