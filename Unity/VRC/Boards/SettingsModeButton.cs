using UnityEngine;
using UdonSharp;

namespace OpenSlope.VrcPlugin
{

    // One INTERACT target per Settings Board RIDE-MODE button (Race / Trick / Free ride) - the picker's counterpart of
    // SettingsToggle, but a one-of-three choice rather than a checkbox: look at a button and press Use/Trigger and it
    // selects THAT mode (SetMode), which repaints all three chips and pushes the mode onto every pooled board.
    // Built + wired by SettingsBoardSetup.
    //
    // Local (sync None): each visitor rides in their own mode. See docs/vrchat/047.
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class SettingsModeButton : UdonSharpBehaviour
    {
        [Tooltip("The Settings Board this button drives.")]
        public SettingsBoard board;

        [Tooltip("The mode this button selects: 0 = Race, 1 = Trick, 2 = Free ride.")]
        public int mode = 0;

        public override void Interact()
        {
            if (board != null) board.SetMode(mode);
        }
    }
}
