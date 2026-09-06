// Neutral hand-off for an SSX MainType-13 out-of-bounds / reset volume (docs/053): a trigger box that snaps a board
// rider back onto the course. The importer (VolumeBuilder) builds the trigger collider and tags it; the platform
// wiring pass realizes the runtime reset-zone behaviour. Carries no fields - the behaviour needs none.

namespace OpenSlope.Importer
{
    public sealed class ResetZoneMarker : Marker
    {
    }
}
