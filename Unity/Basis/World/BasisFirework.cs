using System.Collections;
using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Basis runtime behaviour for SSX's firework triggers (docs/019) - the Basis analogue of the VRChat FireworkTrigger.
    // SSX's Mdl_FWTrigger volumes are invisible boxes the rider passes through; the importer (TriggerBuilder) rebuilt the
    // nearby launcher graphs as P6 ParticleSystem hierarchies (playOnAwake off) and tags this volume with an
    // FireworkMarker naming them + the volley timing. The Basis wiring pass (BasisWiring) realizes this behaviour and
    // copies the marker's fields across by name; crossing the volume fires the launchers as a staggered volley, each with
    // its own firing sound.
    //
    // Detection: Basis has no OnPlayerTriggerEnter, and a physics trigger would miss a seated rider (the seat disables the
    // CharacterController) - so this POLLS the local player against the volume each frame (BasisLocalPlayerProbe.InsideBox)
    // and fires on the rising edge (outside -> inside). That catches a walking player and a board rider identically. The
    // Cooldown stops re-entering the volume from spamming the volley.
    //
    // Shared across the instance (BasisNetEvent): a firework is a transient one-shot, so the client that crosses the
    // volume fires the volley locally AND Broadcast()s it so every other player sees it too. The cooldown gates both the
    // local trigger and the received broadcast, so a local crossing + a remote's echo (or two riders crossing at once)
    // collapse to one volley instead of double-firing. Offline the broadcast no-ops and it's the classic local volley.
    [RequireComponent(typeof(BoxCollider))]
    public class BasisFirework : BasisNetEvent
    {
        public ParticleSystem[] Fireworks;   // the launcher bursts this volume sets off, fired as a volley
        public float VolleyStagger = 0.12f;  // seconds between each rocket (0 = all at once)
        public float Cooldown = 4f;          // minimum seconds between re-fires
        public int EffectSlotIndex = -1;     // the SSX EffectSlotIndex this volume carried (reference/debug)

        BoxCollider _volume;
        bool _inside;
        float _last = -999f;
        Coroutine _volley;

        public override void Start() { base.Start(); _volume = GetComponent<BoxCollider>(); }

        void Update()
        {
            bool now = BasisLocalPlayerProbe.InsideBox(_volume);
            if (now && !_inside) TriggerVolley();
            _inside = now;
        }

        // A LOCAL crossing: fire the volley here and broadcast it to everyone else.
        void TriggerVolley()
        {
            if (Time.time - _last < Cooldown) return;
            PlayVolley();
            Broadcast();
        }

        // A remote player crossed the volume: replay the volley (gated by the same cooldown, so it can't double up with a
        // near-simultaneous local crossing).
        protected override void OnRemoteEvent()
        {
            if (Time.time - _last < Cooldown) return;
            PlayVolley();
        }

        void PlayVolley()
        {
            _last = Time.time;
            if (_volley != null) StopCoroutine(_volley);
            _volley = StartCoroutine(FireVolley());
        }

        // Fire one launcher, wait VolleyStagger, fire the next (a coroutine replaces the VRChat delayed-event chain, which
        // existed only because Udon has no coroutines). Each launcher plays its own firing sound - the importer hung an
        // AudioSource carrying the SSF SoundPlay clip on the ParticleSystem object - so the bangs spread across the
        // launchers and stagger with the pyro, like the original.
        IEnumerator FireVolley()
        {
            if (Fireworks != null)
            {
                for (int i = 0; i < Fireworks.Length; i++)
                {
                    ParticleSystem ps = Fireworks[i];
                    if (ps != null)
                    {
                        ps.Play();
                        AudioSource snd = ps.GetComponent<AudioSource>();
                        if (snd != null && snd.clip != null) snd.PlayOneShot(snd.clip);
                    }
                    if (VolleyStagger > 0f && i < Fireworks.Length - 1)
                        yield return new WaitForSeconds(VolleyStagger);
                }
            }
            _volley = null;
        }
    }
}
