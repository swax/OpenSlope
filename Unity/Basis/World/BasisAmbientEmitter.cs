using System;
using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Basis runtime behaviour for SSX's collision-triggered AMBIENT emitters (docs/052) - the Basis analogue of the VRChat
    // AmbientEmitter. The dust/spark/fire/water bursts a rider sets off by crossing a trigger volume (e.g. tree-break
    // spark+fire, sewer-dust puffs, highway-barrier smash, fire hydrants). The importer (AmbientEmitterBuilder)
    // bakes each one's one-shot burst ParticleSystems (playOnAwake off) + this trigger box + an AmbientEmitterMarker;
    // the Basis wiring realizes this behaviour and copies the marker fields by name. Crossing the volume Play()s the bursts.
    //
    // Detection matches BasisFirework: poll the local player against the volume each frame (no OnPlayerTriggerEnter in
    // Basis; a physics trigger would miss a seated rider) and fire on the rising edge. MinInterval debounces re-fires (the
    // fire hydrants' ~7s cadence; a one-shot uses it as a re-entry cooldown).
    //
    // Shared across the instance (BasisNetEvent): a burst is a transient one-shot, so the client that crosses the volume
    // plays it locally AND Broadcast()s it so every other player sees the dust/spark/fire. MinInterval gates both the local
    // trigger and the received broadcast (no double-play). Offline the broadcast no-ops and it's a local burst.
    //
    // The fire-hydrant TopLid pop-off is not wired on the Basis side: BasisPhysicsProp exposes the Pop/Rearm the lid
    // needs, but the emitter -> lid cross-reference is unresolved, so PopSpeed is carried but not acted on (the Basis
    // test level has no hydrants - they're a city-map feature).
    [RequireComponent(typeof(BoxCollider))]
    public class BasisAmbientEmitter : BasisNetEvent
    {
        public ParticleSystem[] Systems;   // the burst layers this trigger plays on contact
        public float MinInterval = 4f;     // seconds between re-fires
        public int EffectSlotIndex = -1;   // the SSX emit instance index (reference/debug)
        public bool ContactDriven;         // Type2/Sub2: live contact replaces stored P6 origin/base direction
        public ParticleSystemRenderer[] ContactRenderers;
        public float[] ContactSpeeds;
        public float PopSpeed = 4f;        // launch speed for a popped hydrant lid (carried, not acted on; see class note)
        public GameObject GatedLoop;       // hit-gated ambient loop (hydrant spray sound); on until the burst cycle ends [Trailmap: 420-audio-runtime]

        BoxCollider _volume;
        bool _inside;
        float _last = -999f;
        Vector3 _contactPoint;
        Vector3 _contactNormal;
        bool _hasLocalContact;

        public override void Start() { base.Start(); _volume = GetComponent<BoxCollider>(); }

        void Update()
        {
            bool now = BasisLocalPlayerProbe.InsideBox(_volume);
            if (now && !_inside)
            {
                Vector3 point, velocity;
                if (BasisLocalPlayerProbe.TryGetPosition(out point))
                {
                    if (!BasisLocalPlayerProbe.TryGetVelocity(out velocity)) velocity = Vector3.zero;
                    SetContactFromProbe(point, velocity);
                }
                Trigger();
            }
            _inside = now;
        }

        void SetContactFromProbe(Vector3 probeWorld, Vector3 travelWorld)
        {
            if (!ContactDriven || _volume == null) return;
            Vector3 p = _volume.transform.InverseTransformPoint(probeWorld) - _volume.center;
            Vector3 v = _volume.transform.InverseTransformVector(travelWorld);
            Vector3 h = _volume.size * 0.5f;
            float best = 1000000f; int axis = -1;
            if (Mathf.Abs(v.x) > 0.0001f) { float t = (p.x - (v.x > 0f ? -h.x : h.x)) / v.x; if (t >= 0f && t < best) { best = t; axis = 0; } }
            if (Mathf.Abs(v.y) > 0.0001f) { float t = (p.y - (v.y > 0f ? -h.y : h.y)) / v.y; if (t >= 0f && t < best) { best = t; axis = 1; } }
            if (Mathf.Abs(v.z) > 0.0001f) { float t = (p.z - (v.z > 0f ? -h.z : h.z)) / v.z; if (t >= 0f && t < best) { best = t; axis = 2; } }
            if (axis < 0)
            {
                float dx = h.x - Mathf.Abs(p.x), dy = h.y - Mathf.Abs(p.y), dz = h.z - Mathf.Abs(p.z);
                axis = dx <= dy && dx <= dz ? 0 : (dy <= dz ? 1 : 2); best = 0f;
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
                Material material = renderer.material;
                material.SetFloat("_P6ContactEnabled", 1f);
                material.SetVector("_P6ContactOrigin", _contactPoint);
                material.SetVector("_P6ContactVelocity", _contactNormal * speed);
            }
        }

        // A LOCAL crossing: play the burst here and broadcast it to everyone else.
        void Trigger()
        {
            if (Time.time - _last < MinInterval) return;
            byte[] contact = ContactDriven && _hasLocalContact ? ContactPayload() : null;
            Play();
            if (contact != null) Broadcast(contact); else Broadcast();
        }

        // A remote player crossed the volume: replay the burst (gated by the same interval, so it can't double up with a
        // near-simultaneous local crossing).
        protected override void OnRemoteEvent()
        {
            if (Time.time - _last < MinInterval) return;
            Play();
        }

        protected override void OnRemoteEvent(byte[] buffer)
        {
            if (ContactDriven && buffer != null && buffer.Length == 25 && buffer[0] == 2)
            {
                _contactPoint = new Vector3(BitConverter.ToSingle(buffer, 1), BitConverter.ToSingle(buffer, 5), BitConverter.ToSingle(buffer, 9));
                _contactNormal = new Vector3(BitConverter.ToSingle(buffer, 13), BitConverter.ToSingle(buffer, 17), BitConverter.ToSingle(buffer, 21)).normalized;
                _hasLocalContact = _contactNormal.sqrMagnitude > 0.5f;
            }
            OnRemoteEvent();
        }

        byte[] ContactPayload()
        {
            byte[] payload = new byte[25]; payload[0] = 2;
            Buffer.BlockCopy(BitConverter.GetBytes(_contactPoint.x), 0, payload, 1, 4);
            Buffer.BlockCopy(BitConverter.GetBytes(_contactPoint.y), 0, payload, 5, 4);
            Buffer.BlockCopy(BitConverter.GetBytes(_contactPoint.z), 0, payload, 9, 4);
            Buffer.BlockCopy(BitConverter.GetBytes(_contactNormal.x), 0, payload, 13, 4);
            Buffer.BlockCopy(BitConverter.GetBytes(_contactNormal.y), 0, payload, 17, 4);
            Buffer.BlockCopy(BitConverter.GetBytes(_contactNormal.z), 0, payload, 21, 4);
            return payload;
        }

        void Play()
        {
            _last = Time.time;
            ApplyContactFrame();
            // Retail interactive-ambient gate: the spray loop is silent until the prop is first hit, then audible
            // until this burst cycle ends [Trailmap: 420-audio-runtime]. Re-fires push the stop later.
            if (GatedLoop != null)
            {
                GatedLoop.SetActive(true);
                CancelInvoke(nameof(DeactivateGatedLoop));
                Invoke(nameof(DeactivateGatedLoop), Mathf.Max(1f, MinInterval) + 0.1f);
            }
            if (Systems != null)
                for (int i = 0; i < Systems.Length; i++) if (Systems[i] != null) Systems[i].Play();
            _hasLocalContact = false;
        }

        void DeactivateGatedLoop()
        {
            if (GatedLoop != null) GatedLoop.SetActive(false);
        }
    }
}
