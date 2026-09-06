using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for the world's hit-gated ambient loop set (retail interactive class, events 16 cars /
    // 28 fire hydrants / 57 police cars) [Trailmap: 420-audio-runtime]. AudioBuilder parks each loop on an
    // INACTIVE play-on-awake GameObject and lists them here; platform wiring realizes one manager the rideable
    // board notifies on a wall impact, activating the nearest still-inactive loop within range - retail enables a
    // prop's loop whenever its collision one-shot plays. Fire hydrants are ALSO paired directly with their
    // collision-triggered ambient emitter (AmbientEmitterMarker.GatedLoop), which owns their re-arm cycle.
    public sealed class HitGatedLoopsMarker : Marker
    {
        public GameObject[] loops;      // the inactive placed-loop objects
        public float activateRadius;    // metres: a wall impact activates the nearest inactive loop within this
        public float activeSeconds;     // global wind-down for retail-infinite loops (0 = retail-faithful, never stop)
    }
}
