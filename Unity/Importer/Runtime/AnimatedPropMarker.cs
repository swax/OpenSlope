using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for an animated prop (docs/038): a prop whose segments sample a baked model clip (free-run,
    // triggered, or delta-gated kicker). The importer (PropBuilder) builds the segment transforms + flattened curve data
    // and tags the prop pivot; the platform wiring pass realizes the runtime animated-prop behaviour. Field names mirror
    // the behaviour's (the behaviour's activateRange/deactivateRange are left at their defaults - not set here).
    public sealed class AnimatedPropMarker : Marker
    {
        public float clipLength;
        public int loopMode;
        public float rate;
        public bool reverse;
        public bool triggered;
        public float autoResetDelay;
        public bool deltaGated;
        public float pokeSeconds;
        public bool activatePulse;
        public bool combo;
        public float comboStart;
        public float comboEnd;
        public float comboRate;
        public int comboEndMode;
        public float phaseOffset;
        public Transform[] segTransforms;
        public Vector3[] segRestPos;
        public Vector3[] segRestEuler;
        public int[] curveSegment;
        public int[] curveTarget;
        public int[] curveStart;
        public int[] curveCount;
        public float[] curveData;
    }
}
