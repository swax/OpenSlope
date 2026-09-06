using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for SSX's listener-proximity external-sound gate. AudioBuilder collects native crowd and
    // environmental AudioSources under one marker; platform wiring realizes one throttled local manager that starts
    // only sources whose authored maxDistance contains the listener. This keeps the retail emitter set cheap on Quest.
    public sealed class ProximityAudioMarker : Marker
    {
        public AudioSource[] sources;
        public float pollSeconds = 0.5f;
    }
}
