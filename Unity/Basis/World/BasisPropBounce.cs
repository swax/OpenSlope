using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Basis realization of the static prop bucket metadata. The board reads the authored restitution and SurfaceType;
    // the component itself has no Update and therefore adds no per-frame work.
    public sealed class BasisPropBounce : MonoBehaviour
    {
        public bool PlayerBounce;
        public float PlayerBounceAmmount;
        public int SurfaceType = -1;
        public int InstanceCount;
        // Native collision shape that produced this collider (NativeCollision.*). Basis also identifies mode-2
        // boxes by their collision root at runtime, while this preserves the neutral marker's decoded metadata.
        public int NativeMode = 1;
    }
}
