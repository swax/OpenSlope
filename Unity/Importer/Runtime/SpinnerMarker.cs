using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for the spinning-pickup manager (docs/012): one manager drives every trick gem's idle spin from a
    // single update. The importer (PropBuilder) builds the gems and tags their shared root with this marker; the platform
    // wiring pass realizes the runtime spinner-manager behaviour. Field names mirror the behaviour's.
    public sealed class SpinnerMarker : Marker
    {
        public Transform[] Targets;        // the gem transforms to spin
        public Vector3[] Axes;             // per-gem spin axis
        public float[] DegreesPerSecond;   // per-gem spin rate
        public float[] PhaseDegrees;       // per-gem starting phase (golden-angle spread)
        // GPU-instanced gems (docs/012): the per-gem SSX light the manager re-applies at runtime via a MaterialPropertyBlock
        // (an edit-time block is not serialized, so it's lost entering play/build -> the shared-mesh gems draw black).
        public Color[] InstAmbient;        // per-gem ambient floor (shader _InstAmbient)
        public Color[] InstKey1;
        public Color[] InstKey2;
        public Color[] InstKey3;
        public Vector3[] InstDir1;
        public Vector3[] InstDir2;
        public Vector3[] InstDir3;
    }
}
