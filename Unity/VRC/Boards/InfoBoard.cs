using UnityEngine;
using UnityEngine.UI;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    // The in-world INFO BOARD: the leftmost panel in the row behind the start gate (bench slot 0). It's a pure DISPLAY
    // panel - no interactive widgets - that shows the live INSTANCE OWNER plus a static cheat-sheet of the board controls
    // (desktop + VR), so a visitor can read who's hosting and how to ride without leaving the gate. Built + wired by
    // InfoBoardSetup ("OpenSlope/Setup/Info Board").
    //
    // LOCAL + read-only (sync None): the only moving part is the owner line, refreshed from VRChat's own player list on
    // join / leave (the control lists are baked text). No networked state and no per-frame work - it just sits there.
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class InfoBoard : UdonSharpBehaviour
    {
        [Tooltip("The line that shows the instance owner's name (the rest of the board is static baked text).")]
        public Text ownerText;
        [Tooltip("Prefix on the owner line; the owner's display name is appended.")]
        public string ownerPrefix = "Instance owner:  ";

        void Start() { RefreshOwner(); }
        public override void OnPlayerJoined(VRCPlayerApi player) { RefreshOwner(); }
        public override void OnPlayerLeft(VRCPlayerApi player)   { RefreshOwner(); }

        // Name the instance owner (whoever opened the instance) from VRChat's player list. If no owner is present (they
        // left, or an instance type that has none), fall back to the current master so the line still names who's in
        // charge; if even that's unresolved, show a dash. Runs only on join/leave, so allocating the list here is fine.
        private void RefreshOwner()
        {
            if (ownerText == null) return;
            int n = VRCPlayerApi.GetPlayerCount();
            if (n < 0) n = 0;
            VRCPlayerApi[] all = new VRCPlayerApi[n];
            all = VRCPlayerApi.GetPlayers(all);

            string owner = null, master = null;
            for (int i = 0; i < all.Length; i++)
            {
                VRCPlayerApi p = all[i];
                if (!Utilities.IsValid(p)) continue;
                if (p.isInstanceOwner) owner = p.displayName;
                if (p.isMaster)        master = p.displayName;
            }

            string who = owner != null ? owner : (master != null ? master + "  (master)" : "—");
            ownerText.text = ownerPrefix + who;
        }
    }
}
