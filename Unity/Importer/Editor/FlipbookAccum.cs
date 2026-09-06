#if UNITY_EDITOR
using System.Collections.Generic;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Accumulates flipbook animation targets during the prop build, already flattened into the parallel arrays
    // the flipbook animator wants (UdonSharp can't serialise a List of a custom class). LevelImporter creates
    // one, PropBuilder fills it via Add() as it resolves animated material slots (crowd / signs / LCD / start
    // gate), and the importer then attaches a configured flipbook animator on OpenSlope_Flipbooks iff it's
    // non-empty. See docs/vrchat/013-udon-components.md and docs/008-texture-animation.md.
    public class FlipbookAccum
    {
        public readonly List<Renderer> Renderers = new List<Renderer>();
        public readonly List<int> Slots = new List<int>();          // material-slot (submesh) index per target
        public readonly List<float> Fps = new List<float>();        // per-slot playback rate (always > 0)
        public readonly List<int> FrameCounts = new List<int>();    // frames per target; slices the flat Frames list
        public readonly List<Texture2D> Frames = new List<Texture2D>();  // every target's frames, concatenated
        public readonly List<float> DwellBase = new List<float>();  // U4 pause screens: base hold seconds (0 = uniform fps)
        public readonly List<float> DwellFlash = new List<float>(); // U4 pause screens: frame-B flash seconds

        public int Count => Renderers.Count;

        // Register one animated material slot. Skip a null renderer or fewer than 2 frames (neither would animate).
        // dwell = the U4 pause law (dwellBaseSeconds, flashSeconds), or null for uniform fps playback.
        public void Add(Renderer renderer, int slot, Texture2D[] frames, float fps, Vector2? dwell = null)
        {
            if (renderer == null || frames == null || frames.Length < 2) return;
            Renderers.Add(renderer);
            Slots.Add(slot);
            Fps.Add(fps);
            FrameCounts.Add(frames.Length);
            Frames.AddRange(frames);
            DwellBase.Add(dwell.HasValue ? dwell.Value.x : 0f);
            DwellFlash.Add(dwell.HasValue ? dwell.Value.y : 0f);
        }
    }
}
#endif
