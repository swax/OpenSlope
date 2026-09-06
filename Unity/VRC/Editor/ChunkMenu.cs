#if UNITY_EDITOR
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    // OpenSlope/Optimize/Chunk Static Geometry - splits the merged Props/Terrain renderers into a spatial grid of
    // frustum/range-cullable chunks (StaticChunker), then rebuilds the range-culler to gate distant chunks. This is
    // the FPS fix for the "draws the whole course every frame" problem: the merged meshes span
    // the map so Unity can never frustum-cull them; chunking restores the engine's per-cell visibility model.
    //
    // Operates on the CURRENTLY LOADED scene (no re-import needed) and is re-runnable - it reads the canonical merged
    // mesh each time, so you can retune the cell size and run again.
    public static class ChunkMenu
    {
        const float CellSize = 200f;   // XZ grid cell (m). Smaller = tighter culling but more draw calls; tune by eye.

        [MenuItem("OpenSlope/Optimize/Chunk Static Geometry", false, 500)]
        public static void Run()
        {
            var level = GameObject.Find("OpenSlope_Map/Level");
            if (level == null) { Debug.LogError("OpenSlope: OpenSlope_Map/Level not found - load the level scene first."); return; }

            var allChunks = new List<MeshRenderer>();
            int totalChunks = 0; long movedTris = 0; int worstDraws = 0;
            // PropsShowoff / PropsRace (docs/026) are the mode-specific models in separate map-spanning merged meshes.
            // Chunk them like Props so they frustum/range-cull too; the loop skips them gracefully when a level has no
            // props for that mode. TerrainHD is the render-only
            // high-detail terrain swap - chunked like Terrain so the swap stays frustum/range-cullable rather than one
            // 500k-tri map-spanning renderer. NOTE it is imported INACTIVE and nothing switches it on at runtime:
            // activate the root by hand to look at it.
            foreach (var host in new[] { "Props", "PropsShowoff", "PropsRace", "Terrain", "TerrainHD" })
            {
                var t = level.transform.Find(host);
                var mr = t != null ? t.GetComponent<MeshRenderer>() : null;
                if (mr == null)
                {
                    // The mode-specific prop hosts are optional, as is TerrainHD (a bundle baked without the HD pass);
                    // their absence is normal, not a problem.
                    if (host != "PropsShowoff" && host != "PropsRace" && host != "TerrainHD") Debug.LogWarning($"OpenSlope: no '{host}' MeshRenderer under OpenSlope_Map/Level - skipping.");
                    continue;
                }

                var res = StaticChunker.Chunk(mr, CellSize, out var chunks);
                if (res.note != "ok") { Debug.LogWarning($"OpenSlope: chunking '{host}' skipped ({res.note})."); continue; }
                allChunks.AddRange(chunks);
                totalChunks += res.chunks; movedTris += res.staticTris;
                if (res.maxMatsPerChunk > worstDraws) worstDraws = res.maxMatsPerChunk;
                Debug.Log($"OpenSlope: chunked '{host}' -> {res.chunks} chunk(s) @ {CellSize}m, {res.staticTris:n0} static tris " +
                          $"({res.culledStatic} static submesh(es) split, {res.keptAnimated} animated kept), " +
                          $"worst chunk = {res.maxMatsPerChunk} submesh(es).");
            }

            // Range-cull the new chunks too (rebuilds OpenSlope_ObjectCuller, which now also gathers the *_chunk_* renderers).
            // Per-platform ranges (Quest / PC); carry forward whatever an existing culler used so re-runs don't reset them.
            // These defaults only apply when the scene has no culler yet, and they must match ObjectCuller's own —
            // chunking a fresh scene should not silently gate at a different range than importing one.
            float rangeQuest = 600f, rangePC = 1200f;
            var existing = Object.FindObjectOfType<ObjectCuller>(true);
            if (existing != null) { rangeQuest = existing.rangeQuest; rangePC = existing.rangePC; }
            int culled = ObjectCullerSetup.Build(level.transform, rangeQuest, rangePC);
            VrcWiring.Wire();   // realize the fresh ObjectCullerMarker (with the new chunk renderers) into the culler
            // The video screens sit outside the culler's roots (OpenSlope_Map/VideoBillboards, not Level), so the rebuild above
            // drops them. Re-register: a screen must gate at the same range as the chunk its billboard sits in (docs/vrchat/041).
            culled += VideoBillboardsSetup.RegisterScreensWithCuller();

            UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(level.scene);
            Debug.Log($"OpenSlope: Chunk Static Geometry done - {totalChunks} chunk(s), {movedTris:n0} tris now frustum/range-cullable; " +
                      $"worst single chunk draws {worstDraws} submesh(es). Range-culler now gates {culled} renderer(s) @ {rangeQuest}m Quest / {rangePC}m PC. " +
                      "Frustum + range culling now drop off-screen / distant course geometry. Save the scene, then build to test.");
        }

        // Is the loaded level's static geometry already split into chunks? Setup All checks this so a repeated pass
        // skips the (re-runnable) ~10 s re-split; run OpenSlope/Optimize/Chunk Static Geometry by hand to retune the cell
        // size on an already-chunked scene.
        public static bool IsChunked()
        {
            var level = GameObject.Find("OpenSlope_Map/Level");
            if (level == null) return false;
            foreach (var host in new[] { "Props", "PropsShowoff", "PropsRace", "Terrain", "TerrainHD" })
            {
                var t = level.transform.Find(host);
                if (t == null) continue;
                for (int i = 0; i < t.childCount; i++)
                    if (t.GetChild(i).name.Contains("_chunk_")) return true;
            }
            return false;
        }

        [MenuItem("OpenSlope/Optimize/Chunk Static Geometry", true)]
        static bool Enabled() => GameObject.Find("OpenSlope_Map/Level") != null;
    }
}
#endif
