using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for an SSX speed/trick BOOST PAD (spec 360, docs/040): a trigger box over the pad decal wired to
    // the rideable board - a speed pad runs a timed boost, a trick pad is cosmetic. The importer (BoostPadBuilder) builds
    // the trigger + sparkle + chime and tags it; the platform wiring pass realizes the runtime boost-pad behaviour. Field
    // names mirror the behaviour's; `networked` is left to the behaviour default.
    public sealed class BoostPadMarker : Marker
    {
        public bool Trick;                 // true = cosmetic trick pad, false = timed speed boost
        public float BoostSeconds;         // speed-boost window (0 on a trick pad)
        public float Cooldown;             // minimum seconds between re-fires
        public float MinRideSpeed;         // minimum board speed to trigger
        public ParticleSystem sparkle;     // the pad's authored P6 contact burst the behaviour plays
        public AudioSource chime;          // contact chime the behaviour plays
        public float chimeVolume;          // chime one-shot volume
        public int EffectSlotIndex = -1;   // the SSX EffectSlotIndex this pad carried (reference/debug)
        // Pop + regrow (docs/040), the deliberate divergence from the game, whose pad never vanishes: the diverted pad
        // decal to scale on a cross. Null = the pad stays put (no divert / pop disabled) and only the burst plays.
        // Names match the behaviours' exactly (camelCase, as on the gem): the wiring pass copies marker -> behaviour by
        // case-sensitive field name and warns on any drift.
        public Transform padVisual;
        public float popHoldDelay;         // seconds gone before regrow begins
        public float growBackDuration;     // seconds to ease back to full size
    }
}
