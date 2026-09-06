using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Revolves ALL of an SSX level's trick-multiplier "gem" pickups from a SINGLE Update - the Basis analogue of the VRChat
    // SpinnerManager. Same spin formula (Quaternion.AngleAxis(phase + dps*Time.time, axis) * rest) over the parallel
    // arrays the importer fills: PropBuilder.BuildSpinners tags the Spinners root with a SpinnerMarker, and
    // BasisWiring realizes this behaviour and copies the arrays across by name. On plain C# the per-gem-Update collapse
    // matters far less than on Udon, but the shape is kept for parity + the range gate is a genuine cull.
    //
    // RANGE-GATED: only gems within SpinRange of the local player spin, the near set rebuilt as the player travels (every
    // RecheckMoveDist of movement or RecheckFrames frames). Gems spin + scale in place and never translate, so their world
    // positions are cached once at Start; a gem re-entering range picks up the correct absolute phase (the formula runs on
    // shared Time.time, not an accumulator).
    //
    // Purely cosmetic + LOCAL. The COLLECT half lives on the sibling BasisGemPickup - the two write different transform
    // channels (this rotation, the pickup scale), so they never fight. See docs/023 / docs/vrchat/013.
    public class BasisSpinnerManager : MonoBehaviour
    {
        [Tooltip("Gem transform per slot (parallel arrays the importer fills).")]
        public Transform[] Targets;
        [Tooltip("Spin axis per slot, in WORLD space (world-up for SSX pickups after the importer's orientation fix).")]
        public Vector3[] Axes;
        [Tooltip("Revolve rate per slot, in degrees per second.")]
        public float[] DegreesPerSecond;
        [Tooltip("Per-slot starting angle (deg) so a cluster of gems doesn't spin in lockstep.")]
        public float[] PhaseDegrees;
        [Tooltip("Per-gem ambient floor for the GPU-instanced shared-mesh gems, re-applied via a MaterialPropertyBlock in " +
                 "Start (an edit-time block is runtime-only, so it's lost entering play - without this the gems draw black).")]
        public Color[] InstAmbient;
        [Tooltip("Exact per-gem directional keys and fixed Unity-world TOWARD-light directions.")]
        public Color[] InstKey1, InstKey2, InstKey3;
        public Vector3[] InstDir1, InstDir2, InstDir3;
        [Tooltip("Metres to the local player inside which a gem spins (a 1 m gem reads as static farther out).")]
        public float SpinRange = 300f;
        [Tooltip("Rebuild the near set after the player moves this far (m) since the last pass.")]
        public float RecheckMoveDist = 25f;
        [Tooltip("Hard cap on how many frames between near-set rebuilds.")]
        public int RecheckFrames = 30;

        Quaternion[] _rest;   // each slot's orientation to spin around, captured once at Start
        Vector3[] _axis;      // normalized spin axis per slot, precomputed
        Vector3[] _pos;       // each gem's world position, cached at Start (gems never translate)
        int[] _near;          // slot indices currently within SpinRange (the per-frame working set)
        int _nearCount;
        Vector3 _lastPos;     // player position at the last near-set rebuild
        int _frame;
        bool _have;
        int _count;
        bool _ready;

        void Start()
        {
            _count = Targets == null ? 0 : Targets.Length;
            _rest = new Quaternion[_count];
            _axis = new Vector3[_count];
            _pos = new Vector3[_count];
            _near = new int[_count];
            // Re-apply each GPU-instanced gem's per-instance SSX light. SetPropertyBlock is runtime-only (not serialized),
            // so the importer's edit-time block is gone by play - re-push it here so the URP shader's _DIRLIGHT_INST path
            // lights each shared-mesh gem individually (same fix as BasisPhysicsProp; docs/012). SetVector preserves
            // the raw /256 factors and directions; SetColor would apply an unwanted sRGB->linear conversion.
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
                    MeshRenderer mr = tr.GetComponent<MeshRenderer>();
                    if (mr != null)
                    {
                        Color a2 = InstAmbient[i];
                        mr.GetPropertyBlock(mpb);
                        mpb.SetVector("_InstAmbient", new Vector4(a2.r, a2.g, a2.b, 1f));
                        SetLight(mpb, "_InstKey1", InstKey1, i);
                        SetLight(mpb, "_InstKey2", InstKey2, i);
                        SetLight(mpb, "_InstKey3", InstKey3, i);
                        SetDirection(mpb, "_InstDir1", InstDir1, i);
                        SetDirection(mpb, "_InstDir2", InstDir2, i);
                        SetDirection(mpb, "_InstDir3", InstDir3, i);
                        mr.SetPropertyBlock(mpb);
                    }
                }
            }
            _ready = true;
        }

        static void SetLight(MaterialPropertyBlock block, string name, Color[] values, int index)
        {
            Color c = values != null && index < values.Length ? values[index] : Color.black;
            block.SetVector(name, new Vector4(c.r, c.g, c.b, 1f));
        }

        static void SetDirection(MaterialPropertyBlock block, string name, Vector3[] values, int index)
        {
            Vector3 d = values != null && index < values.Length ? values[index] : Vector3.up;
            block.SetVector(name, new Vector4(d.x, d.y, d.z, 0f));
        }

        void Update()
        {
            if (!_ready || _count == 0) return;
            if (!BasisLocalPlayerProbe.TryGetPosition(out Vector3 p)) return;

            // Movement-throttled near-set rebuild - the visible-spin set only changes as you travel.
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
