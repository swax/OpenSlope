using UnityEngine;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    // SSX out-of-bounds / reset volumes (docs/053, Trailmap MainType-13): an invisible trigger box on a wall / water /
    // back-of-course boundary that snaps a board rider who crosses it back onto the course. These are THE out-of-bounds
    // mechanism - the game carries no void or death-plane check at all, so crossing an authored volume is the whole of it
    // (a level authors dozens to a few hundred of them, the water among them). The importer's under-the-map OOB floor is
    // one more of these, so a rider who leaves the world through a gap between them lands on one too (docs/031). The rider
    // is a VRCStation passenger, so it raises no OnPlayerTriggerEnter - the board sweeps its RiderProbe capsule through
    // here instead. Local-only (sync None): each client resets its own rider. The importer (ResetZoneBuilder) drops the
    // invisible box + this component. Walking players aren't reset (on foot you're not meaningfully out of bounds).
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class ResetZone : UdonSharpBehaviour
    {
        public void OnTriggerEnter(Collider other)
        {
            if (other == null) return;
            RideableBoard board = other.GetComponentInParent<RideableBoard>();
            if (board != null && board.IsRiding) board.TriggerReset();
        }
    }
}
