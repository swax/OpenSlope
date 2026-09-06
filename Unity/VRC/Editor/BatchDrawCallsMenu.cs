#if UNITY_EDITOR
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UdonSharpEditor;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    // Fast apply path for the draw-call batching (TextureArrayPacker) on an ALREADY-imported scene, so you can
    // test the FPS win on Quest without a full re-import. Collapses the combined "Terrain" + "Props" meshes to
    // Texture2DArray draws in place, and remaps the live FlipbookAnimator's per-slot submesh indices for the
    // Props renderer (in place - the Flipbooks object and every live ref into it stay intact).
    // A full OpenSlope/Load import does the same thing (PropBuilder/TerrainBuilder are wired for it); this is the no-reimport
    // shortcut. Idempotent: a renderer already carrying a _TEXARRAY material is skipped.
    public static class BatchDrawCallsMenu
    {
        [MenuItem("OpenSlope/Optimize/Batch Draw Calls (live scene)", false, 502)]
        public static void Run()
        {
            var cfg = ImportConfig.Current();
            string outDir = cfg.MatFolder + "/TexArrays";
            int before = 0, after = 0, did = 0;

            // One shared cache across the renderers so Terrain + TerrainHD reuse one set of arrays (identical
            // texture groups). Only helps when both collapse in the SAME pass - an already-batched one is skipped,
            // so a later solo collapse builds its own (namespaced) arrays; a full re-import shares them again.
            var texArrShared = new TextureArrayPacker.SharedGroups();
            foreach (var r in Object.FindObjectsOfType<MeshRenderer>(true).Where(r => r.name == "Terrain" || r.name == "TerrainHD" || r.name == "Props"))
            {
                if (r.sharedMaterials.Any(m => m != null && m.IsKeywordEnabled("_TEXARRAY")))
                { Debug.Log("OpenSlope: " + r.name + " already batched - skipping."); continue; }
                var res = TextureArrayPacker.Collapse(r, outDir, markBatchingStatic: false, texArrShared);
                before += res.subBefore; after += res.subAfter; did++;
                Debug.Log($"OpenSlope: batched {r.name} {res.subBefore}->{res.subAfter} submeshes ({res.arraysBuilt} array(s)).");
                if (r.name == "Props") RemapFlipbook(r, res.oldToNew);
            }

            // Camera-range cull of the placed objects (gems/balloons/crash-bags/animated props). Run it whether or not
            // anything batched this pass.
            int culled = 0;
            var level = GameObject.Find(cfg.RootName);
            var levelT = level != null ? level.transform.Find(cfg.LevelName) : null;
            if (levelT != null) { culled = ObjectCullerSetup.Build(levelT, cfg.ObjectCullRangeQuest, cfg.ObjectCullRangePC); VrcWiring.Wire(); }

            if (did == 0 && culled == 0) { Debug.Log("OpenSlope: nothing to batch / cull found."); return; }
            AssetDatabase.SaveAssets();
            EditorSceneManager.MarkSceneDirty(EditorSceneManager.GetActiveScene());
            Debug.Log($"OpenSlope: Perf pass done - batched {did} renderer(s) (submeshes {before}->{after}), range-culling {culled} placed-object renderers @ {cfg.ObjectCullRangeQuest}m Quest / {cfg.ObjectCullRangePC}m PC. SAVE the scene, then build/upload.");
        }

        // Re-point the flipbook animator's slot indices for the Props renderer after the collapse reordered its
        // submeshes. In place (no GameObject recreation) so cross-references hold.
        static void RemapFlipbook(MeshRenderer props, int[] oldToNew)
        {
            if (oldToNew == null) return;
            foreach (var anim in Object.FindObjectsOfType<FlipbookAnimator>(true))
            {
                if (anim.Renderers == null || anim.Slots == null) continue;
                bool changed = false;
                int n = Mathf.Min(anim.Renderers.Length, anim.Slots.Length);
                for (int i = 0; i < n; i++)
                {
                    if (anim.Renderers[i] != props) continue;
                    int old = anim.Slots[i];
                    if (old >= 0 && old < oldToNew.Length && oldToNew[old] >= 0) { anim.Slots[i] = oldToNew[old]; changed = true; }
                }
                if (changed)
                {
                    UdonSharpEditorUtility.CopyProxyToUdon(anim);   // push the edited Slots into the Udon heap
                    EditorUtility.SetDirty(anim);
                    Debug.Log("OpenSlope: remapped flipbook slots for Props.");
                }
            }
        }

        [MenuItem("OpenSlope/Optimize/Batch Draw Calls (live scene)", true)]
        public static bool Validate() => GameObject.Find("OpenSlope_Map") != null;
    }
}
#endif
