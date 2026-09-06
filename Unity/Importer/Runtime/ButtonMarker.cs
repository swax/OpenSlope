using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for a ride-over BUTTON's trigger volume (docs/008): the box whose crossing PULSES a button's
    // material through a short sequence of its other frames and back - the megaplex buttons that read green until a
    // rider crosses them, flash red for about a third of a second, and settle again.
    //
    // The marker sits on the TRIGGER BOX, not the button, because the box is what detects the crossing; it points
    // straight at the button's Renderer, so no cross-reference resolution is needed in the wiring pass's second pass.
    // The pulse itself is already replayed from the engine's finite flip node by snowknife - this carries the result,
    // not the flip parameters, so the runtime never re-derives an engine law.
    //
    // The importer (PropBuilder.BuildButtons) builds the button object, the box and this tag; the platform wiring pass
    // realizes the runtime behaviour. Field names mirror the behaviour's.
    public sealed class ButtonMarker : Marker
    {
        public Renderer target;        // the button's renderer (its own diverted object, out of the merged mesh)
        public int slot;               // material-slot (submesh) index on that renderer
        public Texture2D[] frames;     // the material's ordered state frames (>= 2)
        public int[] pulseFrames;      // frame index per pulse segment, in order, starting at the crossing
        public float[] pulseHolds;     // how long each segment holds, seconds (parallel to pulseFrames)
        public AudioSource sound;      // the crossing's ping on this trigger box (the VOLUME instance's CollisonSound,
                                       // resolved to its course-bank clip by the importer); null = authored-silent
    }
}
