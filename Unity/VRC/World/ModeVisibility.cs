using UdonSharp;

namespace OpenSlope.VrcPlugin
{
    // Runtime data tag for an object controlled by the authored mode functions. SettingsBoard owns the switch;
    // this component persists after the neutral ModeVisibilityMarker has been consumed by VrcWiring.
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class ModeVisibility : UdonSharpBehaviour
    {
        public int ModeMask = 7; // race=1, show-off=2, freeride=4
    }
}
