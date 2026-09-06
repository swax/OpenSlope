using UnityEngine;

namespace OpenSlope.Importer
{

    // Marks an AudioSource that wants its platform's spatial-audio pairing. The importer builds bare Unity AudioSources
    // with their own 3D curve already set (spatialBlend, min/maxDistance, Linear rolloff); this tag says "give the
    // AudioSource on this object the platform's spatial component so that curve is honoured on upload".
    //
    // It carries NO fields: everything the pairing needs is already on the sibling AudioSource. The VRChat wiring pass
    // realizes it as a VRCSpatialAudioSource whose EnableSpatialization = (spatialBlend > 0) and Near/Far read from the
    // AudioSource's min/maxDistance - which reproduces every case the importer builds (positional impacts / gem chimes
    // / firework bangs / boost cues / crowd + wind beds, and the deliberately-2D teleport chime at spatialBlend 0).
    // Without the pairing VRChat force-spatializes the bare source with a 40 m default that discards the authored range.
    public sealed class SpatialAudio : Marker
    {
    }
}
