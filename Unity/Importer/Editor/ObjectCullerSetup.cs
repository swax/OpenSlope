#if UNITY_EDITOR
using System.Collections.Generic;
using UnityEngine;
using UnityEditor;

namespace OpenSlope.Importer
{

    // Gathers every placed-object renderer under the movable-prop roots (gems / balloons / crash-bags / animated props)
    // and tags a holder with an ObjectCullerMarker; the platform wiring pass realizes the camera-range culler that
    // reproduces SSX's ~300 m placed-object range gather (see Trailmap/specs/400-rendering). Called from PropBuilder at import and
    // from the OpenSlope/Optimize menu for a live scene. Idempotent: replaces any prior OpenSlope_ObjectCuller.
    public static class ObjectCullerSetup
    {
        // Emitters (the continuous snow cannons + flares, ParticleSystemRenderers) are STATIC in place, so they range-cull
        // safely like the other placed objects - and they're the biggest uncovered draw group otherwise (docs/053). NB the
        // spline movers (the subway) are deliberately NOT here: the culler caches positions at Start, so a moving prop would
        // gate against a stale position.
        static readonly string[] Roots = { "Spinners", "BreakableLogos", "Physics", "AnimatedProps", "Emitters" };

        // Returns the renderer count wired (0 if nothing to cull / the program asset isn't ready yet). The OFF ranges +
        // fog params (docs/unity/006) drive the two-tier cull toggle + the cull-range-tracking distance fog on the realized
        // culler; the menu callers keep the defaults (Quest off widens to the PC on-range, PC off to full draw).
        public static int Build(Transform parent, float rangeQuest, float rangePC,
                                float rangeQuestOff = 1200f, float rangePCOff = 3000f,
                                bool controlFog = true, float fogStart = 300f)
        {
            var renderers = new List<Renderer>();
            foreach (var name in Roots)
            {
                var root = parent.Find(name);
                if (root == null) continue;
                // currently-drawn renderers only (intact balloons, not their inactive shards); includes the props'
                // own effect renderers so those gate at distance too. GetComponentsInChildren(false) skips inactive
                // GAMEOBJECTS but still returns renderer-DISABLED ones (the breakable shard twins sit on active objects
                // with their Renderer turned off until the prop smashes) - so filter on r.enabled too, or the cull set
                // bloats with thousands of never-drawn shards (e.g. a dense city map: thousands of shards) we'd distance-test
                // every pass for nothing. A shard that re-enables on break is transient debris near the player anyway.
                foreach (var r in root.GetComponentsInChildren<Renderer>(false))
                    if (r != null && r.enabled && r.gameObject.activeInHierarchy) renderers.Add(r);
            }

            // Static geometry CHUNKS (StaticChunker split the merged Props/Terrain into per-cell child renderers):
            // range-cull them too, so the long fall-line view drops distant chunks even though they sit inside the
            // frustum - the engine bound that frustum culling alone can't provide (Trailmap/specs/400-rendering).
            var level = parent.Find("Level") ?? parent;
            foreach (var hostName in new[] { "Props", "PropsShowoff", "PropsRace", "Terrain", "TerrainHD" })   // mode-only prop nodes + TerrainHD are chunked/cull-hosted like Props
            {
                var host = level.Find(hostName);
                if (host == null) continue;
                for (int i = 0; i < host.childCount; i++)
                {
                    var ch = host.GetChild(i);
                    if (!ch.name.Contains("_chunk_")) continue;
                    var r = ch.GetComponent<Renderer>();
                    if (r != null) renderers.Add(r);
                }
            }

            var prev = parent.Find("OpenSlope_ObjectCuller");
            if (prev != null) Object.DestroyImmediate(prev.gameObject);
            if (renderers.Count == 0) return 0;

            var go = new GameObject("OpenSlope_ObjectCuller");
            go.transform.SetParent(parent, false);
            var mk = go.AddComponent<ObjectCullerMarker>();
            mk.renderers = renderers.ToArray();
            mk.rangeQuest = rangeQuest;
            mk.rangePC = rangePC;   // the active range is chosen per build target in the realized culler's Start
            mk.rangeQuestOff = rangeQuestOff;   // two-tier cull: 'off' widens to these instead of switching the culler off (docs/unity/006)
            mk.rangePCOff = rangePCOff;
            mk.controlFog = controlFog;         // drive RenderSettings distance fog end from the active cull range
            mk.fogStart = fogStart;
            return renderers.Count;
        }
    }
}
#endif
