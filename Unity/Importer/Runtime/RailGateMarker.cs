using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for an SSX MainType-25 rail TOGGLE volume (spec 350-rails, docs/026): a trigger box that makes a
    // set of start-disabled grind rails grindable when crossed. The importer (RailGateBuilder) builds the trigger
    // collider and tags it with this marker; the platform wiring pass realizes the runtime gate behaviour.
    //
    // The gate points at the grind rail network - a cross-reference to ANOTHER realized behaviour, which a neutral
    // marker can't type, so it stores the network's GameObject and the wiring pass resolves it to that platform's
    // rail-network component in its second pass (after every network exists). `networked` is left to the behaviour default.
    public sealed class RailGateMarker : Marker
    {
        public GameObject railNetworkObject;   // the grind-rail network object; PASS 2 resolves it to the rail behaviour
        public int[] rails;                    // rail indices this gate makes grindable on cross
        public float Cooldown;                 // minimum seconds between re-fires
    }
}
