using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for an SSX MainType-24 teleport portal (spec 390, docs/051): a trigger box at the start volume
    // with a destination anchor at the exit pivot. Crossing it warps the local rider. The importer (TeleportBuilder)
    // builds the trigger + destination anchor + entry chime and tags it; the platform wiring pass realizes the runtime
    // teleport behaviour. `destination` is a plain scene Transform (the anchor object), so it copies by name in PASS 1 -
    // not a behaviour cross-reference. Field names mirror the behaviour's.
    public sealed class TeleportMarker : Marker
    {
        public Transform destination;      // the exit-pivot anchor the behaviour reads at cross time
        public float UpOffset;             // lift above the destination so the rider doesn't clip the ground
        public float Cooldown;             // minimum seconds between re-fires
        public AudioSource chime;          // entry cue the behaviour plays (2D)
        public float chimeVolume;          // chime one-shot volume
        public int EffectSlotIndex = -1;   // the SSX EffectSlotIndex this portal carried (reference/debug)
    }
}
