using UnityEngine;
using Basis.Scripts.BasisSdk.Players;

namespace OpenSlope.BasisPlugin
{

    // Shared helper for Basis world-trigger behaviours: "where is the local player, and is that inside this volume?".
    // Basis has no VRChat-style OnPlayerTriggerEnter, and physics triggers MISS both a seated rider (the seat driver
    // disables the player's CharacterController) and teleport-ins (the root is moved via SetPositionAndRotation, which
    // emits no enter/exit). So SSX trigger volumes here POLL the local player's root position each frame instead.
    //
    // BasisLocalPlayer.Instance.transform.position is the feet/ground point and is written every frame whether the player
    // WALKS (the character driver writes the root) or RIDES a BasisSeat (the seat driver writes the same root) - so a
    // board rider skiing through a volume is caught exactly like a walking player. Instance is null until the local player
    // has spawned, so every read guards for it.
    public static class BasisLocalPlayerProbe
    {
        // The local player's world position (feet). False until the local player has spawned.
        public static bool TryGetPosition(out Vector3 pos)
        {
            var p = BasisLocalPlayer.Instance;
            if (p == null) { pos = Vector3.zero; return false; }
            pos = p.transform.position;
            return true;
        }

        // The local player's world VELOCITY (m/s), estimated from the root position's per-frame delta. Basis has no
        // read/write player-velocity API, and the ONE signal written every frame in both modes is the root position (the
        // character driver on foot, the seat driver while riding) - so its delta is the rider's closing speed whether they
        // walk or ski a board through a volume. Sampled continuously by the tracker (below) and shared by any number of
        // consumers (e.g. all 63 knockable physics props). A teleport / respawn moves the root without real motion, so the
        // delta is CLAMPED to MaxTrackedSpeed - a warp can't fling a prop to the moon.
        const float MaxTrackedSpeed = 60f;   // m/s ceiling on the tracked delta (clamps teleport/respawn spikes)
        static bool _hasLast;
        static Vector3 _lastPos;
        static Vector3 _velCached;
        static bool _velValid;

        // The current velocity estimate (false until there are two samples to difference, or when unspawned). Pure read -
        // BasisPlayerVelocityTracker keeps _velCached fresh EVERY frame. It must be sampled continuously, NOT on demand:
        // a consumer (a knockable physics prop) reads this only on the rare frame it detects a crossing, so on-demand the
        // "previous" position would be from the LAST crossing (frames/seconds ago) and the delta would be garbage.
        // Continuous sampling keeps it a true one-frame closing speed.
        public static bool TryGetVelocity(out Vector3 vel)
        {
            vel = _velCached;
            return _velValid;
        }

        // Advance the velocity estimate by one frame - called by the tracker in LateUpdate, after the character driver (on
        // foot) / seat driver (riding) has written the root for this frame.
        internal static void SampleVelocity(float dt)
        {
            if (TryGetPosition(out Vector3 pos))
            {
                if (_hasLast && dt > 1e-5f)
                {
                    Vector3 raw = (pos - _lastPos) / dt;
                    float sp = raw.magnitude;
                    if (sp > MaxTrackedSpeed) raw *= MaxTrackedSpeed / sp;   // clamp a warp/respawn spike
                    _velCached = raw;
                    _velValid = true;
                }
                else { _velCached = Vector3.zero; _velValid = false; }       // first sample -> no delta yet
                _lastPos = pos;
                _hasLast = true;
            }
            else { _velCached = Vector3.zero; _velValid = false; _hasLast = false; } // not spawned -> restart tracking
        }

        // Stand up a hidden, persistent per-frame sampler at runtime, so player velocity is always current for any consumer
        // regardless of whether one polls it this frame. DontDestroyOnLoad so it survives the app's additive world load.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void InstallVelocityTracker()
        {
            var go = new GameObject("BasisPlayerVelocityTracker") { hideFlags = HideFlags.HideAndDontSave };
            Object.DontDestroyOnLoad(go);
            go.AddComponent<BasisPlayerVelocityTracker>();
        }

        // Is the local player inside this (possibly rotated/scaled) trigger box? Tested in the box's LOCAL space, so the
        // Level's -90deg/x0.01 hierarchy transform and the collider's own centre/size are all honoured.
        public static bool InsideBox(BoxCollider box)
        {
            if (box == null) return false;
            if (!TryGetPosition(out Vector3 p)) return false;
            return PointInBox(box, p);
        }

        // Is an arbitrary WORLD point inside this (possibly rotated/scaled) box? Same local-space test as InsideBox - used
        // to test the BOARD's position while riding (the board, not the seated rider's root, is what plows through a prop).
        public static bool PointInBox(BoxCollider box, Vector3 worldPoint)
        {
            if (box == null) return false;
            Vector3 l = box.transform.InverseTransformPoint(worldPoint) - box.center;
            Vector3 h = box.size * 0.5f;
            return Mathf.Abs(l.x) <= h.x && Mathf.Abs(l.y) <= h.y && Mathf.Abs(l.z) <= h.z;
        }

        // Does the local player's body COLUMN come within 'radius' (world m) of 'worldCenter'? The player is treated as a
        // vertical segment from the feet up to 'height'. SSX pickup spheres float at rider height, so a feet-only point test
        // would slip under a gem a walking player skis through; the column catches a walking player and a board rider
        // (seated feet written at board level) identically - the analogue of the VRChat capsule trigger.
        public static bool NearSphere(Vector3 worldCenter, float radius, float height)
        {
            if (!TryGetPosition(out Vector3 feet)) return false;
            float y = Mathf.Clamp(worldCenter.y, feet.y, feet.y + Mathf.Max(0f, height));   // closest point on the column
            Vector3 closest = new Vector3(feet.x, y, feet.z);
            return (worldCenter - closest).sqrMagnitude <= radius * radius;
        }
    }

    // The per-frame velocity sampler for BasisLocalPlayerProbe, installed automatically at runtime (InstallVelocityTracker).
    // LateUpdate so it reads the root AFTER the character driver (on foot) / seat driver (riding) has moved it this frame.
    sealed class BasisPlayerVelocityTracker : MonoBehaviour
    {
        void LateUpdate() => BasisLocalPlayerProbe.SampleVelocity(Time.deltaTime);
    }
}
