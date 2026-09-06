using UnityEngine;
using UnityEngine.UI;
using UdonSharp;

namespace OpenSlope.VrcPlugin
{

    // One INTERACT target per Diagnostics Board checkbox row - the counterpart of SettingsToggle.
    // VRChat's world-space UI laser doesn't reliably drive a Canvas Toggle in-world, so each row carries a BoxCollider +
    // this behaviour: look at the row and press Use/Trigger and it flips that row's Toggle, then calls Apply on the board
    // (which pushes the new value onto every pooled board and re-asserts the effect rows). Built + wired by
    // DiagnosticsBoardSetup. Local (sync None).
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class DiagnosticsToggle : UdonSharpBehaviour
    {
        [Tooltip("The row's UI Toggle (holds the on/off state + drives the checkmark visual).")]
        public Toggle toggle;

        [Tooltip("The Diagnostics Board this row belongs to - re-applied after the flip.")]
        public DiagnosticsBoard board;

        public override void Interact()
        {
            if (toggle != null) toggle.isOn = !toggle.isOn;   // flip state + checkmark (also fires onValueChanged -> Apply)
            if (board != null) board.Apply();                 // re-assert directly too, so the row takes effect regardless
        }
    }
}
