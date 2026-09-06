using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.Udon.Common.Interfaces;

namespace OpenSlope.VrcPlugin
{

    // VRChat/Udon component for SSX's COLLISION-triggered AMBIENT emitters (docs/052): the dust/spark/fire/water
    // bursts a rider sets off by crossing a trigger volume - e.g. tree-break spark+fire, sewer-dust puffs,
    // its highway-barrier smash, and its 25 fire hydrants. Unlike a firework (a lit volley with a report -> the pyro
    // path) these are silent environmental puffs; unlike the always-on snow-cannon/flare emitters they only play on
    // contact. The importer (AmbientEmitterBuilder) bakes each one's ParticleSystem layers (one-shot bursts, playOnAwake
    // off) + this trigger; crossing the box Play()s them.
    //
    // Shared across the instance (docs/vrchat/043, Tier 1): a burst is a transient one-shot, so the one client that crosses
    // the volume broadcasts it to EVERYONE rather than each client firing only its own. Ordinary bursts use a network
    // event; contact-driven SubType-2 bursts manually sync the point/normal/sequence so every peer sees the same frame.
    // Detection is single-source: only the local walking player raises OnPlayerTriggerEnter, and a board's
    // RiderProbe path is gated on IsRiding (forced false on remotes), so exactly one client ever broadcasts.
    // A timestamp prevents the last synced contact from replaying for a late joiner. The behaviour must NOT be None.
    // A repeatable emitter (the fire hydrants) re-fires after MinInterval; a one-shot uses the same gate as a re-entry
    // cooldown. The importer attaches + configures this directly (UdonTools.AddConfigured). See docs/vrchat/013, docs/052.
    [UdonBehaviourSyncMode(BehaviourSyncMode.Manual)]
    public class AmbientEmitter : UdonSharpBehaviour
    {
        [Tooltip("The burst ParticleSystems this trigger sets off (one per SSX emitter layer).")]
        public ParticleSystem[] Systems;

        [Tooltip("Minimum seconds between re-fires. The fire hydrants use SSX's ~7s debounce; one-shots use it as a re-entry cooldown.")]
        public float MinInterval = 4f;

        [Tooltip("Broadcast the burst to every player (docs/vrchat/043) so a rider's dust/water is seen by all, not just themselves.")]
        public bool networked = true;

        [Tooltip("The SSX emit instance index this trigger drives. Reference/debug only.")]
        public int EffectSlotIndex = -1;

        [Tooltip("Dedicated Type2/Sub2: replace the stored P6 origin and base direction with this hit's contact frame.")]
        public bool ContactDriven;
        [HideInInspector] public ParticleSystemRenderer[] ContactRenderers;
        [HideInInspector] public float[] ContactSpeeds;

        [HideInInspector] public int AutoTestFireCount;

        [Tooltip("Roller pop-off props (fire-hydrant TopLids) this trigger launches when it fires (docs/052).")]
        public PhysicsProp[] RollerLids;

        [Tooltip("Launch speed (m/s) for a Roller pop-off - the hydrant lid pops straight up.")]
        public float PopSpeed = 4f;

        [Tooltip("The owning instance's hit-gated ambient loop (the hydrant's spray sound): retail enables it when the " +
                 "prop's impact plays and never stops it; we tie it to the burst + lid re-arm cycle instead. [Trailmap: 420-audio-runtime]")]
        public GameObject GatedLoop;

        private float _last = -999f;
        private float _rearmAt = -1f;
        private BoxCollider _volume;
        private Vector3 _contactPoint;
        private Vector3 _contactNormal;
        private bool _hasLocalContact;
        [UdonSynced] public Vector3 SyncedContactPoint;
        [UdonSynced] public Vector3 SyncedContactNormal;
        [UdonSynced] public int SyncedContactSequence;
        [UdonSynced] public int SyncedContactServerMs;
        private int _seenContactSequence;

        void Start() { _volume = GetComponent<BoxCollider>(); }

        public override void OnPlayerTriggerEnter(VRCPlayerApi player)
        {
            if (player == null || !player.isLocal) return;
            SetContactFromProbe(player.GetPosition(), player.GetVelocity());
            Trigger();
        }

        // The RIDEABLE BOARD path: a VRCStation passenger doesn't raise OnPlayerTriggerEnter (the station carries you),
        // so the board sweeps its RiderProbe capsule through here. Only a board with a rider aboard counts (IsRiding is
        // forced false on remote boards, so only the owner's local crossing fires - no double-broadcast).
        public void OnTriggerEnter(Collider other)
        {
            if (other == null) return;
            RideableBoard board = other.GetComponentInParent<RideableBoard>();
            if (board != null && board.IsRiding)
            {
                SetContactFromProbe(other.transform.position, board.RiderVelocity);
                Trigger();
            }
        }

        // The imported trigger is the owning prop's native bounds. Walk backward from the just-inside probe along
        // its travel vector to the entry face; this supplies a stable collider-surface point and outward face normal.
        // The retail game uses its exact model collision point, while this is the closest fact Unity's trigger seam has.
        void SetContactFromProbe(Vector3 probeWorld, Vector3 travelWorld)
        {
            if (!ContactDriven || _volume == null) return;
            Vector3 p = _volume.transform.InverseTransformPoint(probeWorld) - _volume.center;
            Vector3 v = _volume.transform.InverseTransformVector(travelWorld);
            Vector3 h = _volume.size * 0.5f;
            float best = 1000000f;
            int axis = -1;
            if (Mathf.Abs(v.x) > 0.0001f) { float t = (p.x - (v.x > 0f ? -h.x : h.x)) / v.x; if (t >= 0f && t < best) { best = t; axis = 0; } }
            if (Mathf.Abs(v.y) > 0.0001f) { float t = (p.y - (v.y > 0f ? -h.y : h.y)) / v.y; if (t >= 0f && t < best) { best = t; axis = 1; } }
            if (Mathf.Abs(v.z) > 0.0001f) { float t = (p.z - (v.z > 0f ? -h.z : h.z)) / v.z; if (t >= 0f && t < best) { best = t; axis = 2; } }
            if (axis < 0)
            {
                float dx = h.x - Mathf.Abs(p.x), dy = h.y - Mathf.Abs(p.y), dz = h.z - Mathf.Abs(p.z);
                axis = dx <= dy && dx <= dz ? 0 : (dy <= dz ? 1 : 2);
                best = 0f;
            }
            Vector3 hit = p - v * best;
            hit.x = Mathf.Clamp(hit.x, -h.x, h.x); hit.y = Mathf.Clamp(hit.y, -h.y, h.y); hit.z = Mathf.Clamp(hit.z, -h.z, h.z);
            Vector3 normal = Vector3.zero;
            if (axis == 0) { hit.x = Mathf.Abs(v.x) > 0.0001f ? (v.x > 0f ? -h.x : h.x) : (p.x >= 0f ? h.x : -h.x); normal.x = hit.x >= 0f ? 1f : -1f; }
            else if (axis == 1) { hit.y = Mathf.Abs(v.y) > 0.0001f ? (v.y > 0f ? -h.y : h.y) : (p.y >= 0f ? h.y : -h.y); normal.y = hit.y >= 0f ? 1f : -1f; }
            else { hit.z = Mathf.Abs(v.z) > 0.0001f ? (v.z > 0f ? -h.z : h.z) : (p.z >= 0f ? h.z : -h.z); normal.z = hit.z >= 0f ? 1f : -1f; }
            _contactPoint = _volume.transform.TransformPoint(_volume.center + hit);
            _contactNormal = _volume.transform.TransformDirection(normal).normalized;
            _hasLocalContact = true;
        }

        void ApplyContactFrame()
        {
            if (!ContactDriven || !_hasLocalContact || ContactRenderers == null) return;
            for (int i = 0; i < ContactRenderers.Length; i++)
            {
                ParticleSystemRenderer renderer = ContactRenderers[i];
                if (renderer == null) continue;
                float speed = ContactSpeeds != null && i < ContactSpeeds.Length ? ContactSpeeds[i] : 0f;
                Material material = renderer.material; // per-renderer instance: one tree hit must not redirect all 34 trees
                material.SetFloat("_P6ContactEnabled", 1f);
                material.SetVector("_P6ContactOrigin", _contactPoint);
                material.SetVector("_P6ContactVelocity", _contactNormal * speed);
            }
        }

        void Trigger()
        {
            if (Time.time - _last < MinInterval) return;
            _last = Time.time;
            if (networked && ContactDriven && _hasLocalContact)
            {
                VRCPlayerApi local = Networking.LocalPlayer;
                if (local != null) Networking.SetOwner(local, gameObject);
                SyncedContactPoint = _contactPoint;
                SyncedContactNormal = _contactNormal;
                SyncedContactSequence++;
                SyncedContactServerMs = Networking.GetServerTimeInMilliseconds();
                _seenContactSequence = SyncedContactSequence;
                RequestSerialization();
                Play(); // local response stays immediate; remotes replay from OnDeserialization with the same frame
            }
            else if (networked) SendCustomNetworkEvent(NetworkEventTarget.All, nameof(Play));
            else Play();
        }

        public override void OnDeserialization()
        {
            if (!ContactDriven || SyncedContactSequence == _seenContactSequence) return;
            _seenContactSequence = SyncedContactSequence;
            int age = Networking.GetServerTimeInMilliseconds() - SyncedContactServerMs;
            if (age < -3000 || age > 3000) return; // do not replay a stale burst for a late joiner
            _contactPoint = SyncedContactPoint;
            _contactNormal = SyncedContactNormal.normalized;
            _hasLocalContact = _contactNormal.sqrMagnitude > 0.5f;
            Play();
        }

        // Public + param-less so it doubles as the network-event target (runs on every client, including the sender).
        // The re-fire gate lives in Trigger.
        public void Play()
        {
            AutoTestFireCount++;
            ApplyContactFrame();
            if (Systems != null)
                for (int i = 0; i < Systems.Length; i++) if (Systems[i] != null) Systems[i].Play();
            _hasLocalContact = false;
            // Retail interactive-ambient gate: the hydrant's spray LOOP is silent until the prop is first hit, then
            // audible (retail: forever; here: until the lid re-arms) [Trailmap: 420-audio-runtime]. The loop object
            // is play-on-awake, so activation alone starts it; runs on every client (this is the network target).
            if (GatedLoop != null) GatedLoop.SetActive(true);
            // Pop off any Roller lids (fire-hydrant TopLids) from the same trigger - straight up (docs/052) - then re-arm
            // them (teleport back onto the hydrant) AFTER the cooldown, so they're ready BEFORE the next hit rather than
            // snapping back at the moment of the hit. A newer hit pushes _rearmAt later, so an older delayed re-arm no-ops.
            bool lids = RollerLids != null && RollerLids.Length > 0;
            if (lids)
                for (int i = 0; i < RollerLids.Length; i++) if (RollerLids[i] != null) RollerLids[i].Pop(Vector3.up, PopSpeed);
            if (lids || GatedLoop != null)
            {
                float d = Mathf.Max(1f, MinInterval);
                _rearmAt = Time.time + d;
                SendCustomEventDelayedSeconds(nameof(RearmLids), d + 0.1f);
            }
        }

        // Re-arm (return home) the lids for the MOST RECENT pop only: a re-hit reschedules _rearmAt later, so this stale
        // delayed call finds Time.time short of it and skips. The spray loop stops on the same cycle - the deliberate
        // deviation from retail's spray-forever.
        public void RearmLids()
        {
            if (_rearmAt < 0f || Time.time < _rearmAt - 0.2f) return;
            _rearmAt = -1f;
            if (GatedLoop != null) GatedLoop.SetActive(false);
            if (RollerLids == null) return;
            for (int i = 0; i < RollerLids.Length; i++) if (RollerLids[i] != null) RollerLids[i].Rearm();
        }
    }
}
