using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.Udon.Common.Interfaces;

namespace OpenSlope.VrcPlugin
{

    // VRChat/Udon component for an SSX animated-prop TRIGGER VOLUME - the invisible box a rider crosses to fire a
    // TRIGGERED animated prop's one-shot. In the game such a prop carries no persistent effect, so it sits at rest;
    // an EffectSlotIndex's collision trigger plays the prop's AnimObject (SSFLogic.json: CollisionEffectSlot header
    // -> MainType-7 -> play the effect on the target instance) when a player skis through. The importer rebuilds each
    // volume as a BoxCollider(isTrigger) carrying this behaviour, wired to the prop's AnimatedPropU; crossing it
    // calls Trigger(), which plays the prop's clip + its moving colliders (so the change is real - e.g. an
    // iris door slides open a real gap) [Trailmap: 370-world-interaction]. docs/038-animated-props.md.
    //
    // Shared across the instance (docs/vrchat/043, Tier 1): the door opening is a transient one-shot with a self-resetting
    // clip, so the one client that crosses broadcasts the trigger to EVERYONE (SendCustomNetworkEvent All -> Fire),
    // and each client plays the prop's own clip + auto-reset off that shared event - so the door opens ~together and
    // a player never rides into an invisible wall that's open on someone else's screen but shut on theirs. Detection
    // is single-source like FireworkTrigger (only the local walking player, or the OWNER's board whose IsRiding is
    // true on the owner alone), so exactly one client broadcasts. A short Cooldown throttles rapid re-entry / the
    // broadcast. `networked = false` falls back to local-only (solo / demo). The behaviour must NOT be None: None
    // BLOCKS SendCustomNetworkEvent. It's Manual (zero synced variables, so no traffic) - just enough for the event.
    // Two detection paths mirror FireworkTrigger: OnPlayerTriggerEnter for a WALKING
    // player, and OnTriggerEnter against the rideable board's RiderProbe (VRChat stops raising OnPlayerTriggerEnter
    // while you're a VRCStation passenger, so the board sweeps a probe collider through here instead).
    //
    // You don't add this by hand: the importer (PropBuilder.BuildAnimated) attaches and wires it via
    // UdonTools.AddConfigured (which pushes the networked=true default). See docs/vrchat/013-udon-components.md and docs/vrchat/043.
    [UdonBehaviourSyncMode(BehaviourSyncMode.Manual)] // Manual, NOT None: None BLOCKS SendCustomNetworkEvent (Fire). No synced vars, so Manual carries no traffic.
    public class AnimTriggerU : UdonSharpBehaviour
    {
        [Tooltip("The triggered animated prop this volume fires (e.g. the iris door). Wired by the importer.")]
        public AnimatedPropU target;

        [Tooltip("Consolidated routing (OpenSlope/Optimize/Consolidate Animated Props): when set, Fire drives " +
                 "manager.TriggerProp/PokeProp(managerIndex) instead of the per-prop behaviour (which the " +
                 "consolidator disables). `target` stays wired as the consolidation source + fallback.")]
        public AnimatedPropManager manager;
        [Tooltip("This volume's prop index in the manager's arrays. Wired by the consolidator.")]
        public int managerIndex = -1;

        [Tooltip("Poke mode: grant the target's delta-gated budget (Poke - the landing triggers pumping the " +
                 "kicker ramps) instead of playing the one-shot (Trigger - the iris door). Wired by the importer.")]
        public bool poke;

        [Tooltip("Combo mode: play the target's reaction window (TriggerCombo - an Aloha barrier being knocked " +
                 "flat) instead of a one-shot or a poke. For the retail barriers this volume IS the prop: the " +
                 "engine sends the command from the barrier's own collision chain. Wired by the importer.")]
        public bool combo;

        [Tooltip("Broadcast the trigger to every player (docs/vrchat/043) so the door opens for all, not just the rider who " +
                 "crossed. Off = local-only. The importer pushes this default; existing un-pushed instances read false " +
                 "(local) until re-imported.")]
        public bool networked = true;

        [Tooltip("Minimum seconds between re-triggers, so re-entering the volume doesn't spam the broadcast.")]
        public float Cooldown = 1f;

        [HideInInspector] public int AutoTestFireCount;

        private float _last = -999f;

        public override void OnPlayerTriggerEnter(VRCPlayerApi player)
        {
            if (player == null || !player.isLocal || !HasTarget()) return;
            FireTrigger();
        }

        // Somewhere to send the fire: the consolidated manager slot, or the legacy per-prop behaviour.
        bool HasTarget()
        {
            if (manager != null && managerIndex >= 0) return true;
            return target != null;
        }

        // Also fire for the RIDEABLE BOARD: while you're a VRCStation passenger VRChat stops raising
        // OnPlayerTriggerEnter (the station carries you - your capsule isn't walking through the volume), so the
        // board sweeps an invisible RiderProbe collider through here. Only a board with a rider aboard counts
        // (IsRiding is forced false on remote boards, so only the owner's local crossing fires).
        public void OnTriggerEnter(Collider other)
        {
            if (other == null || !HasTarget()) return;
            RideableBoard board = other.GetComponentInParent<RideableBoard>();
            if (board != null && board.IsRiding) FireTrigger();
        }

        // A local cross of the volume: cooldown-gate, then fire the prop for EVERYONE (or just locally when not
        // networked). Shared by the walking + riding detection paths.
        void FireTrigger()
        {
            if (Time.time - _last < Cooldown) return;
            _last = Time.time;
            if (networked) SendCustomNetworkEvent(NetworkEventTarget.All, nameof(Fire));
            else Fire();
        }

        // Play the target prop's one-shot (or grant its poke budget). Public + param-less so it doubles as the
        // network-event target (runs on every client, including the sender, when FireTrigger broadcasts). Routes
        // to the consolidated manager slot when wired, else the legacy per-prop behaviour.
        public void Fire()
        {
            AutoTestFireCount++;
            if (manager != null && managerIndex >= 0)
            {
                if (combo) manager.TriggerPropCombo(managerIndex);
                else if (poke) manager.PokeProp(managerIndex);
                else manager.TriggerProp(managerIndex);
                return;
            }
            if (target == null) return;
            if (combo) target.TriggerCombo();
            else if (poke) target.Poke();
            else target.Trigger();
        }
    }
}
