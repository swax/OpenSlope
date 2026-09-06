using UnityEngine;

namespace OpenSlope.BasisPlugin
{
    using Basis.Scripts.BasisSdk.Players;   // BasisLocalPlayer
    using Basis.Scripts.Networking;         // BasisNetworkPlayers (player registry)

    /// <summary>
    /// The in-world INFO BOARD for Basis: a pure DISPLAY panel behind the start gate that shows a live line (how many
    /// players are here + your name) above a static cheat-sheet of the board controls. The Basis analogue of the VRChat
    /// <c>InfoBoard</c>. Display-only, so it's plain 3D TextMesh with NO interaction - it needs none of Basis's UI
    /// raycast plumbing (unlike the Performance Board's toggle plates), it just renders.
    ///
    /// LOCAL + read-only: the only moving part is the player line, refreshed on a slow poll from Basis's networked-player
    /// registry (offline it reads as "1 (you)"). The control list is baked text set by the setup. No networked state.
    /// </summary>
    public class BasisInfoBoard : MonoBehaviour
    {
        [Tooltip("The line that shows the live player count + local name (the rest of the board is static baked text).")]
        public TextMesh playerText;
        [Tooltip("Prefix on the player line.")]
        public string playerPrefix = "Riders here:  ";
        [Tooltip("Seconds between player-line refreshes (the count changes only on join/leave, so a slow poll is plenty).")]
        public float refreshInterval = 1.0f;

        float _nextRefresh;

        void OnEnable() { _nextRefresh = 0f; }

        void Update()
        {
            if (Time.time < _nextRefresh) return;
            _nextRefresh = Time.time + Mathf.Max(0.25f, refreshInterval);
            Refresh();
        }

        // Player count (from the networked registry; floored to 1 so offline/solo still reads sensibly) + the local name.
        void Refresh()
        {
            if (playerText == null) return;
            int count = BasisNetworkPlayers.Players.Count;
            if (count < 1) count = 1;

            string me = null;
            var lp = BasisLocalPlayer.Instance;
            if (lp != null && !string.IsNullOrEmpty(lp.DisplayName)) me = lp.DisplayName;

            playerText.text = me != null ? $"{playerPrefix}{count}   (you: {me})"
                                         : $"{playerPrefix}{count}";
        }
    }
}
