using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for an SSX collision-triggered AMBIENT emitter (docs/052): a trigger box that fires burst
    // ParticleSystems (dust/spark/fire/water) when a rider crosses it, and optionally pops a fire hydrant's TopLid. The
    // importer (AmbientEmitterBuilder) builds the trigger + burst layers and tags it; the platform wiring pass realizes
    // the runtime emitter behaviour. The hydrant lids are physics-prop objects this emitter pops - a cross-reference to
    // ANOTHER realized behaviour, stored as GameObjects and resolved in the wiring pass's second pass. Other field names
    // mirror the behaviour's.
    public sealed class AmbientEmitterMarker : Marker
    {
        public ParticleSystem[] Systems;      // the burst layers this trigger plays on contact
        public float MinInterval;             // seconds between re-fires (repeatable emitters)
        public int EffectSlotIndex = -1;      // the SSX EffectSlotIndex this emitter carried
        public bool ContactDriven;            // dedicated SubType-2: live hit point + normal override the stored P6 seed
        public ParticleSystemRenderer[] ContactRenderers;
        public float[] ContactSpeeds;         // authored base-vector magnitudes after the level transform (world m/s)
        public GameObject[] rollerLidObjects; // fire-hydrant lid objects to pop; PASS 2 resolves them to physics-prop behaviours
        public float PopSpeed;                // launch speed for a popped lid
        public GameObject GatedLoop;          // the owning instance's hit-gated ambient loop (hydrant spray sound), paired by AudioBuilder
    }
}
