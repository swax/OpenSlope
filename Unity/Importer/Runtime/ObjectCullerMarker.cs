using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for the placed-object range culler (Trailmap/specs/400-rendering): gates every placed-object + static-chunk
    // renderer at a camera range, reproducing SSX's ~300 m placed-object gather (the mountain-top fall-line draw fix). The
    // importer (ObjectCullerSetup) gathers the renderers and tags a holder; the platform wiring pass realizes the
    // runtime culler behaviour. Field names mirror the behaviour's; the active range is chosen per build target at runtime.
    public sealed class ObjectCullerMarker : Marker
    {
        public Renderer[] renderers;   // every placed-object / static-chunk renderer to range-gate
        public float rangeQuest;       // Android (Quest) cull range - ON/tight
        public float rangePC;          // Standalone (PC) cull range - ON/tight
        // Two-tier cull (docs/unity/006): the Diagnostics Board's "cull" toggle swaps the tight ON range for a WIDER OFF range -
        // the culler stays ACTIVE, so 'off' bounds the draw at the wide range (Quest can't afford unbounded), not off. Quest
        // OFF = the PC on-range; PC OFF = full draw. Distance fog END follows the ACTIVE range (props hazed exactly where
        // they cull). Copied by name onto the realized culler; it sets only RenderSettings fog DISTANCES (colour + enable
        // stay per-level from the baked sky). controlFog off = leave the static fog the importer baked.
        public float rangeQuestOff;    // Quest OFF/wide cull range (= the PC on-range)
        public float rangePCOff;       // PC OFF/wide cull range (full draw)
        public bool controlFog;        // drive RenderSettings fog end from the active cull range
        public float fogStart;         // fog begin distance (m), constant across both tiers
    }
}
