using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for the idle "race pack" poker (docs/038): with no AI racers, one poker keeps every delta-gated
    // kicker pumping on a random cadence. The importer (PropBuilder) creates the poker object and tags it; the platform
    // wiring pass realizes the runtime poker behaviour and resolves its targets. The gated props are cross-references to
    // other realized behaviours, stored as GameObjects and resolved in the wiring pass's second pass.
    public sealed class AnimPokerMarker : Marker
    {
        public GameObject[] targetObjects;   // the delta-gated props to poke; PASS 2 resolves them to prop behaviours
    }
}
