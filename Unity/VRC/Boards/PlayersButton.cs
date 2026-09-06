using UnityEngine;
using UdonSharp;

namespace OpenSlope.VrcPlugin
{

    // One INTERACT target for the Players Board - the counterpart of SettingsToggle / DiagnosticsToggle, but a one-shot button
    // rather than a checkbox. VRChat's world-space UI laser doesn't reliably drive a Canvas widget in-world, so every
    // interactive element on the board (a player row, a ◀ Prev / Next ▶ nav button, the "Hide me" checkbox) carries a
    // BoxCollider + this behaviour: look at it and press Use/Trigger (VRChat's Interact, the proven path the other boards
    // use) and it calls back into PlayersBoard. Built + wired by PlayersBoardSetup.
    //
    // `slot >= 0` marks a player row and warps to the player shown in that visible slot; `slot < 0` marks a command button
    // dispatched by `command`. Local + (mostly) cosmetic - the only networked effect is the hide toggle. See docs/vrchat/048.
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class PlayersButton : UdonSharpBehaviour
    {
        [Tooltip("The Players Board this element drives.")]
        public PlayersBoard board;

        [Tooltip("A player ROW: the visible slot index to warp to (0..pageSize-1). Set to -1 for a command button.")]
        public int slot = -1;

        [Tooltip("When slot < 0, the command: 1 = previous page, 2 = next page, 3 = toggle 'Hide me on the board'.")]
        public int command = 0;

        public override void Interact()
        {
            if (board == null) return;
            if (slot >= 0) { board._TeleportToSlot(slot); return; }
            if (command == 1) board._PagePrev();
            else if (command == 2) board._PageNext();
            else if (command == 3) board._ToggleHide();
        }
    }
}
