using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for an animated-prop trigger volume (docs/038): a box that plays a triggered prop's one-shot (the
    // iris door) or pokes a delta-gated prop's budget (a kicker's landing zone). The importer (PropBuilder) builds the
    // trigger collider and tags it; the platform wiring pass realizes the runtime trigger behaviour and resolves the
    // target. The target prop is a cross-reference to another realized behaviour, stored as a GameObject and resolved in
    // the wiring pass's second pass.
    public sealed class AnimTriggerMarker : Marker
    {
        public GameObject targetObject;   // the animated prop this trigger drives; PASS 2 resolves it to the prop behaviour
        public bool poke;                 // true = poke a delta-gated budget, false = play a triggered one-shot
        public bool combo;                // true = play a combo prop's reaction window (TriggerCombo); outranks `poke`
    }
}
