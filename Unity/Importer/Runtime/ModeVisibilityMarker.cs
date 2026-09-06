using UnityEngine;

namespace OpenSlope.Importer
{
    // Neutral hand-off for an object whose presence is authored by the level's RaceMode/ShowoffMode/FreerideMode
    // effects. Bitset: race=1, show-off=2, freeride=4. Platform wiring realizes this into its runtime component.
    public sealed class ModeVisibilityMarker : Marker
    {
        public int ModeMask = 7;
    }
}
