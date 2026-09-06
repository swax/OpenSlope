using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for the texture-flipbook animator (docs/008): drives the animated material slots (crowd, signs,
    // start gate) on the merged Props renderer by swapping their textures per frame. The importer (PropBuilder fills a
    // FlipbookAccum, LevelImporter tags the Flipbooks object) hands the platform wiring pass the flattened per-slot
    // arrays; it realizes the runtime flipbook behaviour. Field names mirror the behaviour's.
    public sealed class FlipbookMarker : Marker
    {
        public Renderer[] Renderers;     // per-slot target renderer (the merged Props mesh)
        public int[] Slots;              // per-slot submesh index into that renderer
        public float[] Fps;              // per-slot frame rate (always > 0: only an animated material reaches here)
        public int[] FrameCounts;        // per-slot frame count
        public Texture2D[] Frames;       // all frames, flattened (indexed by per-slot start + frame)
        public float[] DwellBase;        // per-slot LCD-flip dwell base
        public float[] DwellFlash;       // per-slot LCD-flip flash duration
    }
}
