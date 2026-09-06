using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for the light-glint SOURCE-VISIBILITY fade ([Trailmap: 160-lighting-data], the runtime glint
    // section): on console a glint fades in/out gracefully with its light's visibility - a prop right next to a flare
    // hides the sparkle - while the sprite itself draws PULLED toward the camera (in front of nearby terrain), so the
    // depth test alone cannot be the occlusion. The importer tags the LightGlows root with this marker; the platform
    // wiring pass realizes the runtime fader, which round-robins line-of-sight tests from the viewer's head to each
    // glint's light and eases the shader's _Visibility per renderer. Field names mirror the behaviour's.
    public sealed class GlintFadeMarker : Marker
    {
        public float fadePerSecond;   // easing rate for _Visibility (~2.5 = a graceful third-of-a-second swing)
        public int testsPerFrame;     // glints line-of-sight-tested per frame (round-robin; 5 rays each)
        public float sampleRadius;    // metres around the light the 5-ray kernel samples (partial visibility = partial fade)
        public float maxRange;        // metres beyond which a glint is not tested (the shader's range fade owns it)
        public int occluderMask;      // layers that count as occluders (players/UI/foliage etc. excluded)
    }
}
