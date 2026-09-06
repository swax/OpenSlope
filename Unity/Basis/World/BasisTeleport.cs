using UnityEngine;
using Basis.Scripts.BasisSdk.Players;

namespace OpenSlope.BasisPlugin
{

    // Basis behaviour for SSX MainType-24 TELEPORT portals (docs/051) - the Basis analogue of the VRChat Teleport. An
    // invisible START box paired with a DESTINATION anchor at the exit pivot; crossing the box warps the local player
    // (walking OR riding) to the anchor, facing along start->exit. Realized from a TeleportMarker by BasisWiring
    // (destination / UpOffset / Cooldown / chime / chimeVolume copied across by name).
    //
    // Detection is the FX-trigger poll (Basis has no OnPlayerTriggerEnter; a physics trigger misses a seated rider): it
    // POLLS the local player against the volume each frame and warps on the rising edge. Riding -> the board's RespawnAt
    // carries the rider (still aboard, stopped, riding out of the exit); walking -> BasisLocalPlayer.Teleport. Purely local
    // - each client only ever warps itself; the moved player (avatar sync) and board (BasisBoardSync) carry to others. A
    // Cooldown stops the volume re-firing if you land back inside it.
    [RequireComponent(typeof(BoxCollider))]
    public class BasisTeleport : MonoBehaviour
    {
        public Transform destination;      // the exit-pivot anchor (a plain scene Transform, copied by name)
        public float UpOffset = 0.5f;      // lift on landing so a walking player doesn't clip the ground
        public float Cooldown = 2f;        // minimum seconds between re-fires
        public AudioSource chime;          // entry cue (2D one-shot); null = silent
        [Range(0f, 1f)] public float chimeVolume = 1f;
        public int EffectSlotIndex = -1;   // reference/debug

        BoxCollider _volume;
        bool _inside;
        float _last = -999f;

        void Start() { _volume = GetComponent<BoxCollider>(); }

        void Update()
        {
            bool now = BasisLocalPlayerProbe.InsideBox(_volume);
            if (now && !_inside) Warp();
            _inside = now;
        }

        // Carry the local player to the destination. Facing is derived along start->exit, horizontal.
        void Warp()
        {
            if (destination == null) return;
            if (Time.time - _last < Cooldown) return;
            _last = Time.time;

            Vector3 pos = destination.position + Vector3.up * UpOffset;
            Vector3 face = Vector3.ProjectOnPlane(destination.position - transform.position, Vector3.up);
            face = face.sqrMagnitude > 1e-4f ? face.normalized : Vector3.forward;

            var board = BasisBoard.LocalRider;
            if (board != null)
            {
                board.RespawnAt(pos, face);   // station carry, no dismount - warps still aboard, stopped, on the ground
            }
            else
            {
                var lp = BasisLocalPlayer.Instance;
                if (lp != null) lp.Teleport(pos, Quaternion.LookRotation(face, Vector3.up));
            }

            if (chime != null && chime.clip != null) chime.PlayOneShot(chime.clip, chimeVolume);
        }
    }
}
