using UnityEngine;
using Basis.Scripts.Networking.Sync;

namespace OpenSlope.BasisPlugin
{

    // Networks the rideable board's POSE. A companion component on the board root, built by BasisBoardSetup beside the
    // BasisBoard (BasisSeat) + a BasisSeatSync - the same three-part recipe Basis's own networked vehicle uses
    // (BasisNetworkedVehicle = body sync, BasisVehiclePilotSeat = seat, BasisSeatSync = occupancy). Basis already solves
    // owner-authoritative dead reckoning generically in BasisSyncedTransform (interpolation, extrapolation, a jitter
    // buffer, teleport-snap), so the board reuses that instead of hand-porting the VRChat transport (RideableBoard.Net):
    //   - BasisSeatSync broadcasts WHO is sitting and drives each remote rider's avatar onto this (moving) seat transform.
    //   - This BasisBoardSync streams the board root's world pose (owner -> remotes) plus one extra field: the visible
    //     deck (Heading) pivot's rotation RELATIVE to the root, so a remote viewer sees the deck bank/turn, not a flat plank.
    //
    // The local rider takes ownership on mount (BasisBoard.HandleMount -> OnLocalMount), so only the rider's client
    // streams; every other client interpolates the root here and the board's own ride Update early-returns (it only runs
    // for the local rider - _riding is false on a remote copy), so there's no fight. Offline the behaviour never gets a
    // NetworkID and stays inert, so single-client riding is unchanged.
    public class BasisBoardSync : BasisSyncedTransform
    {
        [Tooltip("The board's visible deck pivot (its Heading child). Synced RELATIVE to the root so remotes see the deck bank/turn. Auto-found from the board if empty.")]
        public Transform deckPivot;

        BasisSyncHandle _deck;      // extra synced field: deck-pivot rotation relative to the root
        BasisBoard _board;

        protected override void Awake()
        {
            // Stream the board root's world pose. Set the transform config BEFORE base.Awake() (it registers the fields),
            // matching BasisNetworkedVehicle.
            Target = transform;
            WorldSpace = true;
            SyncPosition = true;
            SyncRotation = true;
            SyncScale = false;
            UseTeleportThreshold = true;   // a respawn / OOB reset jumps the board far -> remotes SNAP instead of sliding across the map
            TeleportThreshold = 5f;
            base.Awake();

            _deck = RegisterRotation();    // one extra field beyond the root pose: the deck-local rotation
        }

        public override void Start()
        {
            base.Start();
            _board = GetComponent<BasisBoard>();
            if (deckPivot == null && _board != null) deckPivot = _board.headingPivot;
        }

        // The local rider mounted: grab authority so our board's pose streams to everyone, and force a keyframe so late
        // state lands promptly. Called by BasisBoard.HandleMount.
        public void OnLocalMount()
        {
            TakeOwnership();
            ForceKeyframe();
        }

        // The owner teleported the board (OOB / hard-landing respawn): force a full keyframe so the jump is delivered
        // reliably; the teleport threshold makes remotes snap onto it rather than glide. Called by RespawnToSpawn.
        public void OnLocalTeleport()
        {
            if (IsOwnedLocallyOnClient) ForceKeyframe();
        }

        // Owner send: stream the root pose (base) plus the deck pivot's rotation relative to the root.
        protected override void OnBeforeTransmit()
        {
            base.OnBeforeTransmit();
            if (deckPivot != null) LocalSet(_deck, Quaternion.Inverse(transform.rotation) * deckPivot.rotation);
        }

        // Remote apply: drive the root pose (base), then recompose the visible deck onto it from the synced deck-local
        // rotation, so a rider you watch banks and turns their board like their own client sees it.
        protected override void ApplyInterpolated()
        {
            base.ApplyInterpolated();
            if (deckPivot != null)
                deckPivot.SetPositionAndRotation(transform.position, transform.rotation * GetQuaternion(_deck));
        }
    }
}
