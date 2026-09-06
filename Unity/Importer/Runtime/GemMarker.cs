using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for a collectible trick gem (docs/023): pops + plays a chime on rider contact, respawns. The
    // importer (PropBuilder) builds the gem trigger + chime + sparkle and tags it; the platform wiring pass realizes the
    // runtime gem-pickup behaviour. Field names mirror the behaviour's; the pop/grow-back timing takes behaviour defaults.
    public sealed class GemMarker : Marker
    {
        public int Multiplier = 2;       // trick multiplier this gem awards (tier)
        public AudioSource pickupSound;  // per-tier chime the behaviour plays on collect
        public ParticleSystem sparkle;   // optional sparkle
        public float minRideSpeed;       // minimum board speed to collect
        public float pickupVolume = 1f;  // chime one-shot volume
    }
}
