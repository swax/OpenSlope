using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for a firework trigger volume (docs/019-fireworks.md). The importer (TriggerBuilder) builds the
    // invisible trigger BoxCollider and the launcher ParticleSystems, then tags the volume with this marker carrying the
    // launchers it fires + the volley timing. Each platform's wiring pass realizes it into that platform's runtime
    // trigger behaviour. Field names mirror the behaviour's, so the wiring pass copies them across by name; a
    // behaviour-only default (e.g. "broadcast this volley to everyone") is intentionally absent here and left to the
    // behaviour.
    public sealed class FireworkMarker : Marker
    {
        public ParticleSystem[] Fireworks;   // the launcher bursts this volume sets off, fired as a volley
        public float VolleyStagger;          // seconds between each rocket (0 = all at once)
        public float Cooldown;               // minimum seconds between re-fires
        public int EffectSlotIndex = -1;     // the SSX EffectSlotIndex this volume carried (reference/debug)
    }
}
