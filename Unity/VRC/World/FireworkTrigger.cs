using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.Udon.Common.Interfaces;

namespace OpenSlope.VrcPlugin
{

    // VRChat/Udon component for SSX's firework triggers (docs/011, docs/019) - the one that actually fires in-world.
    // SSX's Mdl_FWTrigger volumes are invisible boxes the rider passes through; in the original each one fired a
    // scripted pyro effect at the nearby Mdl_FireworkCylindar_Red launchers. The importer rebuilt those
    // launchers' native P6 layers as Unity ParticleSystem hierarchies (authored sprite/blend, playOnAwake off);
    // this behaviour Play()s them when a player skis through the volume.
    //
    // Shared across the instance (docs/vrchat/043, Tier 1): a firework is a TRANSIENT one-shot, so the one client that
    // crosses the volume broadcasts the volley to EVERYONE (SendCustomNetworkEvent All -> Fire) rather than each
    // client firing only its own. Detection is single-source - only the local walking player raises
    // OnPlayerTriggerEnter, and a board's RiderProbe path is gated on IsRiding, which the board forces false on
    // remotes - so exactly one client ever broadcasts (no double-fire). A late joiner doesn't need the history, so
    // there's no synced state to carry - but the behaviour must NOT be None: None BLOCKS SendCustomNetworkEvent
    // ("Unable to send network event ... with SyncType 'None'"). It's Manual (with zero synced variables, so it adds
    // no traffic) - just enough to let the fire-and-forget event through.
    // `networked = false` falls back to a local-only volley (solo / demo). Rockets go off as a staggered volley:
    // UdonSharp has no coroutines, so FireNext() plays one launcher then re-schedules itself VolleyStagger seconds
    // later via SendCustomEventDelayedSeconds. A Cooldown stops re-entering the volume from spamming the volley (and
    // throttles the broadcast).
    //
    // You don't add this by hand: the importer (TriggerBuilder) attaches and configures it directly via
    // UdonTools.AddConfigured (which pushes the networked=true default), so a re-import turns sharing on. See
    // docs/vrchat/013-udon-components.md, docs/019-fireworks.md and docs/vrchat/043.
    [UdonBehaviourSyncMode(BehaviourSyncMode.Manual)] // Manual, NOT None: None BLOCKS SendCustomNetworkEvent (Fire). No synced vars, so Manual carries no traffic.
    public class FireworkTrigger : UdonSharpBehaviour
    {
        [Tooltip("Firework ParticleSystems this trigger sets off (the launchers near it). Played as a volley.")]
        public ParticleSystem[] Fireworks;

        [Tooltip("Seconds between each rocket in the volley (0 = all at once).")]
        public float VolleyStagger = 0.12f;

        [Tooltip("Minimum seconds between re-fires, so re-entering the volume doesn't spam the volley.")]
        public float Cooldown = 4f;

        [Tooltip("Broadcast the volley to every player (docs/vrchat/043) so a rider's fireworks are seen by all, not just " +
                 "themselves. Off = the classic local-only fire (each client only sees its own). On a re-import the " +
                 "importer pushes this default; existing un-pushed instances read it as false (local) until re-imported.")]
        public bool networked = true;

        [Tooltip("The SSX EffectSlotIndex this volume carried (e.g. 55..77). Reference/debug only.")]
        public int EffectSlotIndex = -1;

        [HideInInspector] public int AutoTestFireCount;

        private float _last = -999f;
        private int _next;

        public override void OnPlayerTriggerEnter(VRCPlayerApi player)
        {
            if (player == null || !player.isLocal) return;
            TriggerVolley();
        }

        // Also fire for the RIDEABLE BOARD. While you're a VRCStation passenger VRChat stops raising
        // OnPlayerTriggerEnter (the station carries you - you aren't walking the capsule through the volume), so the
        // board sweeps an invisible RiderProbe capsule through here instead. Only a board with a rider aboard counts
        // (IsRiding is forced false on remote boards, so only the owner's local crossing fires - no double-broadcast).
        public void OnTriggerEnter(Collider other)
        {
            if (other == null) return;
            RideableBoard board = other.GetComponentInParent<RideableBoard>();
            if (board != null && board.IsRiding) TriggerVolley();
        }

        // A local cross of the volume: gate on the re-entry cooldown, then fire the volley for EVERYONE (the shared
        // instance) - or just locally when not networked. Shared by the walking + riding detection paths.
        void TriggerVolley()
        {
            if (Time.time - _last < Cooldown) return;
            _last = Time.time;
            if (networked) SendCustomNetworkEvent(NetworkEventTarget.All, nameof(Fire));
            else Fire();
        }

        // Start the staggered volley. Public + param-less so it doubles as the network-event target (runs on every
        // client, including the sender, when TriggerVolley broadcasts). The cooldown lives in TriggerVolley.
        public void Fire()
        {
            AutoTestFireCount++;
            _next = 0;
            FireNext();
        }

        // Fire one launcher, then walk to the next: with a stagger, re-schedule via a delayed custom event (no
        // coroutines in Udon); with no stagger, fire the rest in this frame. Public so the delayed event resolves
        // it by name.
        public void FireNext()
        {
            if (Fireworks == null) return;
            while (_next >= 0 && _next < Fireworks.Length)
            {
                ParticleSystem ps = Fireworks[_next];
                _next++;
                if (ps != null)
                {
                    ps.Play();
                    // Play this launcher's real firing sound (the importer hung an AudioSource carrying the course-bank slot 082
                    // - the game's SSF SoundPlay 82 - on the ParticleSystem object). Positional one-shot per rocket, so
                    // the volley's bangs spread across the launchers and stagger with the pyro, like the original.
                    AudioSource snd = ps.GetComponent<AudioSource>();
                    if (snd != null && snd.clip != null) snd.PlayOneShot(snd.clip);
                }

                if (_next >= Fireworks.Length) return;
                if (VolleyStagger > 0f)
                {
                    SendCustomEventDelayedSeconds(nameof(FireNext), VolleyStagger);
                    return;
                }
                // VolleyStagger == 0: loop on to the next launcher in this same frame.
            }
        }
    }
}
