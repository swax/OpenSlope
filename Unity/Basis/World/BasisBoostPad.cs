using System.Collections;
using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Basis behaviour for SSX speed/trick BOOST PADS (docs/040) - the Basis analogue of the VRChat BoostPad. A trigger
    // box over the pad decal: a GOLD SPEED pad runs the board's timed boost for a window (raise the top-speed cap +
    // lean-gated forward thrust - the game's pad mechanic, an accel not a velocity write, so it can't fling a stopped
    // rider); a red/green TRICK pad has no free-roam mechanic to consume, so it's cosmetic here. Realized from an
    // BoostPadMarker by BasisWiring (Trick / BoostSeconds / Cooldown / MinRideSpeed / sparkle / chime / chimeVolume
    // / padVisual / popHoldDelay / growBackDuration copied across by name).
    //
    // The contact burst is the pad's OWN authored MainType-2 emitters, rendered by the shared P6 path. The pad also POPS
    // on a cross - snaps to nothing, holds, then grows back, like a gem (BasisGemPickup) - a DELIBERATE DIVERGENCE
    // from the game, whose pads never disappear. Needs the decal diverted out of the merged static mesh (divert kind
    // "boostpad"); with no padVisual the pad simply bursts + chimes as before.
    //
    // Detection is the FX-trigger poll (Basis has no OnPlayerTriggerEnter; a physics trigger misses a seated rider): it
    // POLLS the local player against the volume each frame and fires on the rising edge. The BOOST is LOCAL - only the
    // crossing rider's board speeds up (BasisBoard.LocalRider.ApplyPadSpeedBoost); a remote shouldn't be sped up because
    // someone far away crossed a pad. The COSMETIC (sparkle + chime) is a SHARED event (BasisNetEvent), so every player
    // sees/hears a pad was hit. A walking player or a trick pad fires the cosmetic only.
    [RequireComponent(typeof(BoxCollider))]
    public class BasisBoostPad : BasisNetEvent
    {
        public bool Trick;                 // true = cosmetic trick pad; false = timed speed boost
        public float BoostSeconds = 2.5f;  // speed-boost window (0 on a trick pad)
        public float Cooldown = 2f;        // minimum seconds between re-fires
        public float MinRideSpeed = 0f;    // minimum board speed (m/s) to fire while riding; 0 = any contact
        public ParticleSystem sparkle;     // the pad's authored P6 contact burst; null = none
        public AudioSource chime;          // contact chime (one-shot); null = silent
        [Range(0f, 1f)] public float chimeVolume = 1f;
        public int EffectSlotIndex = -1;   // reference/debug
        public Transform padVisual;        // the diverted arrow decal to pop; null = the pad never disappears
        public float popHoldDelay = 0.5f;  // seconds gone before regrow begins
        public float growBackDuration = 1.2f; // seconds to ease back to full size

        BoxCollider _volume;
        bool _inside;
        float _last = -999f;
        Vector3 _baseScale = Vector3.one;   // the decal's authored scale; we only ever scale, never hide/destroy
        Coroutine _grow;

        public override void Start()
        {
            base.Start();
            _volume = GetComponent<BoxCollider>();
            if (padVisual != null)
            {
                _baseScale = padVisual.localScale;
                if (_baseScale.sqrMagnitude < 1e-9f) _baseScale = Vector3.one;   // guard a zero authored scale
            }
        }

        void Update()
        {
            bool now = BasisLocalPlayerProbe.InsideBox(_volume);
            if (now && !_inside) Fire();
            _inside = now;
        }

        // A local crossing: boost this rider's board (gold pad, above the speed gate), play the cosmetic locally, and
        // broadcast the cosmetic so others see/hear it. The Cooldown debounces re-entry / sitting in the volume.
        void Fire()
        {
            if (Time.time - _last < Cooldown) return;
            _last = Time.time;
            var board = BasisBoard.LocalRider;
            bool riding = board != null && (MinRideSpeed <= 0f || board.RiderSpeed >= MinRideSpeed);
            if (!Trick && riding && BoostSeconds > 0f) board.ApplyPadSpeedBoost(BoostSeconds); // local physics only
            PlayFx();       // local cosmetic
            Broadcast();    // every other client sees/hears it (no-op offline)
        }

        // A remote player crossed the pad: replay the cosmetic only. NOT gated on the local cooldown - that gate is for
        // local re-entry, and a remote's cosmetic echo must never suppress OUR own boost/cross (each crossing is its own
        // event; Basis excludes the sender, so there's no self-echo to dedupe).
        protected override void OnRemoteEvent() { PlayFx(); }

        void PlayFx()
        {
            if (sparkle != null) sparkle.Play();
            if (chime != null && chime.clip != null) chime.PlayOneShot(chime.clip, chimeVolume);
            Pop();
        }

        // Snap the decal to nothing, hold, then grow it back. Restarts cleanly if a second cross (or a remote's echo)
        // lands mid-cycle. StopCoroutine on the tracked handle, NOT StopAllCoroutines - the net base class runs its own.
        void Pop()
        {
            if (padVisual == null) return;
            if (_grow != null) StopCoroutine(_grow);
            _grow = StartCoroutine(PopAndGrow());
        }

        // The VRChat side self-steps with delayed events because Udon has no coroutines; here a coroutine says it plainly.
        IEnumerator PopAndGrow()
        {
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
            _grow = null;
        }

        void ApplyScale(float k) { padVisual.localScale = _baseScale * k; }
    }
}
