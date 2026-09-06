using System.Collections;
using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Collect feedback for an SSX trick-multiplier "gem" pickup - the Basis analogue of the VRChat GemPickup. The gem
    // spins via BasisSpinnerManager; this sibling gives the HIT effect: ride or walk through it and it POPS (an instant
    // snap to nothing, no shrink) in a sparkle burst + chime, HOLDS gone for popHoldDelay, then GROWS back and re-arms.
    // Realized from a GemMarker by BasisWiring (Multiplier / pickupSound / sparkle / minRideSpeed / pickupVolume
    // copied by name).
    //
    // Detection: Basis has no OnPlayerTriggerEnter and a physics trigger misses a seated board rider, so - like the firework
    // and ambient-emitter volumes - this POLLS the local player each frame against the importer's pickup SPHERE (read off
    // the gem's SphereCollider) via BasisLocalPlayerProbe.NearSphere, and pops on the rising edge (outside -> inside). The
    // player is treated as a body column, so a gem floating at rider height catches a walking player and a board rider
    // identically. While popped the gem can't be re-hit (scale + volume gone), which is the debounce that stops one slow
    // pass double-popping.
    //
    // Networked + scored. Collecting the gem while RIDING raises the local rider's run multiplier (BasisBoard.LocalRider
    // -> ApplyGemMultiplier, MAX-not-stack, consumed by the next banked trick); a walking player collects it cosmetically
    // only. The POP is a shared event (BasisNetEvent): it plays locally the instant you hit it and Broadcast()s so every
    // other player sees the gem you collected pop + regrow. The chime + the multiplier award are LOCAL (each rider's own).
    // Offline the broadcast no-ops and it's a purely local pop.
    public class BasisGemPickup : BasisNetEvent
    {
        [Tooltip("Trick multiplier tier (Yellow=2/Orange=3/Red=5). Awarded to the rider (MAX-not-stack) on collecting it while riding.")]
        public int Multiplier = 2;
        [Tooltip("One-shot source holding the gem's pickup chime, played locally on a hit. Built + wired by the importer; null = silent.")]
        public AudioSource pickupSound;
        [Range(0f, 1f)] public float pickupVolume = 1f;
        [Tooltip("Sparkle burst played at the gem on a hit. Built + wired by the importer; null = no sparkle.")]
        public ParticleSystem sparkle;
        [Tooltip("Min board speed (m/s) to collect while riding. Often authored 0 (any contact pops it); not gated in the poll.")]
        public float minRideSpeed = 0f;

        [Tooltip("Seconds the gem stays popped (invisible, not re-hittable) before it grows back.")]
        public float popHoldDelay = 0.5f;
        [Tooltip("Seconds the gem takes to grow back from nothing once the hold ends.")]
        public float growBackDuration = 1.2f;
        [Tooltip("Height (m) of the player body column tested against the pickup sphere, so a gem at rider height catches a walking player.")]
        public float playerColumnHeight = 2.0f;

        SphereCollider _sphere;
        Vector3 _baseScale = Vector3.one;   // the gem's authored scale; we snap to 0 then grow back to this
        bool _popped;                        // in the pop cycle (hold + grow): gates re-hits so one pass = one pop
        bool _inside;                        // last frame's inside test, for the rising edge
        Coroutine _grow;                     // the running pop/grow coroutine (stopped by name, not StopAllCoroutines - the net base runs its own)

        public override void Start()
        {
            base.Start();                    // BasisNetworkBehaviour: async NetworkID + ownership wiring for the pop broadcast
            _baseScale = transform.localScale;
            if (_baseScale.sqrMagnitude < 1e-9f) _baseScale = Vector3.one; // guard a zero authored scale
            _sphere = GetComponent<SphereCollider>();
        }

        void Update()
        {
            if (_popped) { _inside = true; return; } // not re-hittable mid-cycle; hold the edge so it won't re-pop on re-arm
            bool now = PlayerInPickup();
            if (now && !_inside) Hit();
            _inside = now;
        }

        // Is the local player's column inside the gem's pickup sphere, resolved to world THIS frame? The sphere's centre is
        // local and the gem spins, so transform it live; the collider radius is in the gem's local metres, so scale it by
        // the gem's world scale to a world radius (what Unity physics would use).
        bool PlayerInPickup()
        {
            if (_sphere == null) return false;
            Vector3 c = transform.TransformPoint(_sphere.center);
            Vector3 ls = transform.lossyScale;
            float s = Mathf.Max(Mathf.Abs(ls.x), Mathf.Max(Mathf.Abs(ls.y), Mathf.Abs(ls.z)));
            return BasisLocalPlayerProbe.NearSphere(c, _sphere.radius * s, playerColumnHeight);
        }

        // A LOCAL collect: play our own chime, award the trick multiplier if we hit it while riding (a walking player
        // collects it cosmetically only), pop it locally, then broadcast the pop so every other player sees it too.
        void Hit()
        {
            if (pickupSound != null && pickupSound.clip != null) pickupSound.PlayOneShot(pickupSound.clip, pickupVolume);
            var board = BasisBoard.LocalRider;
            if (board != null && (minRideSpeed <= 0f || board.RiderSpeed >= minRideSpeed))
                board.ApplyGemMultiplier(Multiplier);       // x2/x3/x5 on THIS rider's run (local; max-not-stack)
            Pop();                                           // local + immediate
            Broadcast();                                     // every other client sees this gem pop (no-op offline)
        }

        // The shared pop: sparkle + snap to nothing + regrow. Runs locally in Hit and on every remote via OnRemoteEvent, so
        // the gem you collect pops on everyone's client. Restarts cleanly if it arrives mid-cycle.
        void Pop()
        {
            if (sparkle != null) sparkle.Play();
            if (_grow != null) StopCoroutine(_grow);
            _grow = StartCoroutine(PopAndGrow());
        }

        // A remote player collected this gem: replay the pop (no chime / no multiplier - those are the collector's own).
        protected override void OnRemoteEvent() { Pop(); }

        // Snap to nothing this frame, hold popHoldDelay (the scale - and with it the effective pickup volume - is gone the
        // whole time), then ease the scale from 0 back to the authored size and re-arm. A coroutine replaces the VRChat
        // delayed-event chain, which existed only because Udon has no coroutines.
        IEnumerator PopAndGrow()
        {
            _popped = true;
            ApplyScale(0f);
            float hold = popHoldDelay > 0.001f ? popHoldDelay : 0.5f;
            yield return new WaitForSeconds(hold);
            float gd = growBackDuration > 0.01f ? growBackDuration : 1.2f;
            float e = 0f;
            while (e < gd)
            {
                ApplyScale(Mathf.SmoothStep(0f, 1f, e / gd));
                e += Time.deltaTime;
                yield return null;
            }
            ApplyScale(1f);
            _popped = false;
            _inside = PlayerInPickup(); // if you're still standing in it, require leaving before it can pop again
        }

        void ApplyScale(float k) { transform.localScale = _baseScale * k; }
    }
}
