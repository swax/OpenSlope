using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Basis behaviour for SSX MainType-13 RESET ZONES (docs/053) - the Basis analogue of the VRChat ResetZone. An
    // invisible authored boundary box (a wall / water edge / back-of-course line) that snaps a board RIDER who crosses it
    // back onto the course. It sits on top of the board's own out-of-bounds reset (Surf_0 reset surfaces + falling below the
    // map floor); these are the authored boundary volumes. Realized from a ResetZoneMarker by BasisWiring.
    //
    // Detection is the same poll the FX triggers use: Basis has no OnPlayerTriggerEnter and a physics trigger misses a
    // seated rider, so it POLLS the local player against the volume each frame (BasisLocalPlayerProbe.InsideBox) and acts on
    // the rising edge. It resets only while RIDING - read via the static BasisBoard.LocalRider - because a walking player
    // isn't meaningfully out of bounds (matching the game). Purely local: each client resets its own rider, and the board's
    // teleport carries to other players through the pose sync (BasisBoardSync). The reset snaps back to the board's
    // placed spawn (the same path the board's own OOB reset uses; the Basis board keeps no mid-course breadcrumb).
    [RequireComponent(typeof(BoxCollider))]
    public class BasisResetZone : MonoBehaviour
    {
        BoxCollider _volume;
        bool _inside;

        void Start() { _volume = GetComponent<BoxCollider>(); }

        void Update()
        {
            bool now = BasisLocalPlayerProbe.InsideBox(_volume);
            if (now && !_inside)
            {
                var board = BasisBoard.LocalRider;
                if (board != null) board.TriggerReset();   // riding -> snap back to spawn; on foot -> ignored
            }
            _inside = now;
        }
    }
}
