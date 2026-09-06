using UnityEngine;
using UnityEngine.UI;
using UdonSharp;

namespace OpenSlope.VrcPlugin
{

    // One INTERACT target per Settings Board checkbox row - the exact counterpart of DiagnosticsToggle.
    // VRChat's world-space UI laser doesn't reliably drive a Canvas Toggle in-world, so each row carries a BoxCollider +
    // this behaviour: look at the row and press Use/Trigger (VRChat's Interact, the same proven path the board-mount uses)
    // and it flips that row's Toggle. Flipping the Toggle from code updates its checkmark AND fires its onValueChanged ->
    // SettingsBoard.Apply; we also call Apply directly here so the row takes effect even if that listener didn't fire.
    // Built + wired by SettingsBoardSetup. (The MODE picker is a one-of-three button instead - SettingsModeButton.)
    //
    // Local + cosmetic (sync None): each visitor sets their own. See docs/vrchat/047.
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class SettingsToggle : UdonSharpBehaviour
    {
        [Tooltip("The row's UI Toggle (holds the on/off state + drives the checkmark visual).")]
        public Toggle toggle;

        [Tooltip("The Settings Board this row belongs to - re-applied after the flip.")]
        public SettingsBoard board;

        public override void Interact()
        {
            if (toggle != null) toggle.isOn = !toggle.isOn;   // flip state + checkmark (also fires onValueChanged -> Apply)
            if (board != null) board.Apply();                 // re-assert directly too, so the row takes effect regardless
        }
    }
}
