using UnityEngine;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    // VRChat/Udon component for SSX's MainType-24 TELEPORTS (spec 390-teleport, docs/051) - the one that actually
    // warps in-world. SSX's Mdl_TeleportStart volumes are invisible boxes the rider crosses; the game
    // warped the rider to near a named destination instance. The importer (TeleportBuilder)
    // rebuilds each pair as an invisible trigger volume + a destination anchor at the exit pivot; this behaviour
    // carries the rider there when they cross.
    //
    // Detection mirrors BoostPad / FireworkTrigger - the same two ways to be hit:
    //   - WALKING player: OnPlayerTriggerEnter from the local player's capsule -> VRCPlayerApi.TeleportTo.
    //   - RIDING the board: a VRCStation passenger stops raising OnPlayerTriggerEnter, so the board sweeps its
    //     invisible RiderProbe capsule through us and we catch it in OnTriggerEnter; we warp only while ridden, via
    //     the board's own RespawnAt (station carry, no dismount - the same path the out-of-bounds reset + finish loop
    //     use), so the rider stays aboard and keeps riding out of the exit.
    //
    // A teleport is inherently PER-PLAYER and LOCAL: each client only ever warps ITSELF (VRChat networks the moved
    // player / the board's own RespawnAt handles its sync), so this behaviour syncs nothing and sends no network
    // events - BehaviourSyncMode.None is correct here (unlike the firework/boost broadcasters, which need Manual to
    // let SendCustomNetworkEvent through). Detection is single-source: the local walking player, or the owner's board
    // whose IsRiding is true on the owner alone. A Cooldown stops the volume re-firing if you land back inside it.
    //
    // You don't add this by hand: the importer attaches + configures it directly via UdonTools.AddConfigured.
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)] // teleport is purely local (warps only the crossing client); no synced state, no SendCustomNetworkEvent
    public class Teleport : UdonSharpBehaviour
    {
        [Tooltip("The destination anchor: an empty at the exit instance's pivot (built + placed by the importer under " +
                 "the level root, so its world pose follows the recenter/scale). The rider lands at its world position.")]
        public Transform destination;

        [Tooltip("World-metre lift added on landing so a walking player doesn't spawn inside the ground. The board " +
                 "settles to the surface on its own, so this only really matters on foot.")]
        public float UpOffset = 0.5f;

        [Tooltip("Minimum seconds between re-fires, so landing back in / re-entering the volume doesn't warp every frame.")]
        public float Cooldown = 2f;

        [Tooltip("One-shot entry cue, built + wired by the importer from the SSF MainType-8 SoundPlay on the teleport " +
                 "(a level plays e.g. course-bank 122). null = silent.")]
        public AudioSource chime;

        [Tooltip("Volume scale for the entry cue (0..1).")]
        [Range(0f, 1f)] public float chimeVolume = 1f;

        [Tooltip("The SSX EffectSlotIndex the start volume carried. Reference/debug only.")]
        public int EffectSlotIndex = -1;

        private float _last = -999f;

        // Walking player crosses the volume: cosmetic-free warp of the local player to the destination.
        public override void OnPlayerTriggerEnter(VRCPlayerApi player)
        {
            if (player == null || !player.isLocal) return;
            Warp(null);
        }

        // The RIDEABLE BOARD: a VRCStation passenger reports no walking-capsule trigger, so the board sweeps an
        // invisible RiderProbe capsule through us. Warp only while it's actually ridden (IsRiding is forced false on
        // remote boards, so only the owner's local crossing fires).
        public void OnTriggerEnter(Collider other)
        {
            if (other == null) return;
            RideableBoard board = other.GetComponentInParent<RideableBoard>();
            if (board == null || !board.IsRiding) return;
            Warp(board);
        }

        // Carry the rider to the destination. `board` is null for a walking player. A Cooldown stops the volume
        // re-firing if you land back inside it. Facing is derived along start->exit (the exit instance authors no
        // meaningful heading), horizontal; a board keeps riding out of the exit, a walking player faces that way.
        private void Warp(RideableBoard board)
        {
            if (destination == null) return;
            if (Time.time - _last < Cooldown) return;
            _last = Time.time;

            Vector3 pos = destination.position + Vector3.up * UpOffset;
            Vector3 face = Vector3.ProjectOnPlane(destination.position - transform.position, Vector3.up);
            face = face.sqrMagnitude > 1e-4f ? face.normalized : Vector3.forward;

            if (board != null)
            {
                board.RespawnAt(pos, face);   // station carry, no dismount - the rider warps still aboard, stopped, on the ground
            }
            else
            {
                VRCPlayerApi lp = Networking.LocalPlayer;
                if (lp != null) lp.TeleportTo(pos, Quaternion.LookRotation(face, Vector3.up));
            }

            if (chime != null && chime.clip != null) chime.PlayOneShot(chime.clip, chimeVolume);
        }
    }
}
