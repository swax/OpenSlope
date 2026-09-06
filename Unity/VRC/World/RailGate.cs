using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.Udon.Common.Interfaces;

namespace OpenSlope.VrcPlugin
{

    // VRChat/Udon component for SSX's MainType-25 rail TOGGLE (spec 350-rails, docs/026) - the trigger that makes a
    // gated grind rail become grindable at runtime. SSX can promote a non-rail spline to a rail candidate when an
    // effect chain runs; a level does it once, enabling e.g. the two Spline_FallenTree_*
    // rails after the tree's fall sequence in effect header 221. Those rails are baked into RailNetwork but start
    // DISABLED (StartDisabledRails); this behaviour turns them on when the rider crosses the same trigger volume that
    // fells the tree, so you can't grind the log before it has dropped.
    //
    // Detection + sharing mirror AnimTriggerU / FireworkTrigger:
    //   - WALKING player: OnPlayerTriggerEnter from the local capsule.
    //   - RIDING the board: a VRCStation passenger stops raising OnPlayerTriggerEnter, so the board sweeps its
    //     invisible RiderProbe through here (gated on IsRiding, true on the owner alone).
    // Rail grindability is LOCAL to each client's own RailNetwork, so the crossing client broadcasts EnableRails to
    // EVERYONE (SendCustomNetworkEvent All) and each client enables the rails on its own network - the board next to
    // the log grinds it for all players, not just the one who crossed. Detection is single-source, so exactly one
    // client broadcasts. Idempotent (enabling an already-on rail is a no-op), so a re-cross / late re-fire is harmless.
    // Manual sync (zero synced vars) - NOT None, which would block SendCustomNetworkEvent.
    //
    // A late joiner who missed the cross keeps the rail disabled until they cross it themselves - the same
    // transient-event property the tree-fall anim (AnimTriggerU) has, so the two stay consistent.
    //
    // You don't add this by hand: the importer (RailGateBuilder) attaches + configures it via UdonTools.AddConfigured.
    [UdonBehaviourSyncMode(BehaviourSyncMode.Manual)] // Manual, NOT None: None BLOCKS SendCustomNetworkEvent (EnableRails). No synced vars, so no traffic.
    public class RailGate : UdonSharpBehaviour
    {
        [Tooltip("The rail network holding the gated rails. Wired by the importer.")]
        public RailNetwork railNetwork;

        [Tooltip("Indices into the rail network of the rails this gate makes grindable on cross (the fallen-tree rails). " +
                 "Set by the importer from the SSX MainType-25 nodes in this trigger's effect.")]
        public int[] rails;

        [Tooltip("Broadcast the enable to every player so the rail becomes grindable for all, not just the crossing " +
                 "rider. Off = local-only. The importer pushes this default.")]
        public bool networked = true;

        [Tooltip("Minimum seconds between re-fires (a cheap re-entry guard; enabling is idempotent anyway).")]
        public float Cooldown = 1f;

        private float _last = -999f;

        public override void OnPlayerTriggerEnter(VRCPlayerApi player)
        {
            if (player == null || !player.isLocal) return;
            FireGate();
        }

        // The RIDEABLE BOARD sweeps its RiderProbe through here while ridden (a seated station passenger doesn't raise
        // OnPlayerTriggerEnter). Only a board with a rider aboard counts (IsRiding is forced false on remotes).
        public void OnTriggerEnter(Collider other)
        {
            if (other == null) return;
            RideableBoard board = other.GetComponentInParent<RideableBoard>();
            if (board != null && board.IsRiding) FireGate();
        }

        // A local cross: cooldown-gate, then enable the rails for EVERYONE (or just locally when not networked).
        void FireGate()
        {
            if (Time.time - _last < Cooldown) return;
            _last = Time.time;
            if (networked) SendCustomNetworkEvent(NetworkEventTarget.All, nameof(EnableRails));
            else EnableRails();
        }

        // Turn the gated rails on. Public + param-less so it doubles as the network-event target (runs on every client,
        // including the sender, when FireGate broadcasts). Idempotent.
        public void EnableRails()
        {
            if (railNetwork == null || rails == null) return;
            for (int i = 0; i < rails.Length; i++) railNetwork.SetRailEnabled(rails[i], true);
        }
    }
}
