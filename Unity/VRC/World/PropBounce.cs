using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    // Metadata component for static prop collision buckets. The importer attaches this to the invisible
    // PropsCollision MeshColliders so the rideable board can apply the authored PlayerBounce flag/value that
    // SSX stores per placed object.
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class PropBounce : UdonSharpBehaviour
    {
        public bool PlayerBounce;
        public float PlayerBounceAmmount;
        public int SurfaceType = -1;
        public int InstanceCount;
        // Native collision shape that produced this collider (NativeCollision.*). The board currently takes the
        // faster structural path (mode-2 boxes live under PropsBoundsCollision), but keep the decoded mode on the
        // runtime component so the neutral marker contract remains lossless and available to diagnostics/tools.
        public int NativeMode = 1;
    }
}
