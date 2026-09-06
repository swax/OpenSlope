#if UNITY_EDITOR
using System.IO;
using UnityEditor;
using UnityEngine;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    // The VRChat "Import All" entry point. This is the seam the platform owns: it drives the neutral importer, then runs
    // the VRChat wiring pass over the markers it left. The Basis project carries the parallel BasisImportAll, calling
    // the SAME LevelImporter then its own BasisWiring - so both platforms share one importer with zero platform code
    // in it.
    //
    // Flow (OpenSlope/Load/Map...): bootstrap the UdonSharp program assets the wiring pass attaches -> build the level
    // (neutral geometry + *Markers) -> realize the markers into VRChat behaviours. A freshly-created program asset
    // can't be attached until UdonSharp finalizes it on the next editor tick, so the bootstrap bails-with-rerun BEFORE
    // building - a once-per-fresh-project two-click, not per-import. See docs/vrchat/013-udon-components.md.
    public static class ImportAll
    {
        // Generic level import: pick the exported level folder (the one snowknife wrote, containing gltf/). Any level
        // (gari, mesa, ...) imports through here, so adding a level needs no code. The folder MUST be inside the project's
        // Assets (textures/audio/meshes load via AssetDatabase, which requires them imported as Unity assets), so we
        // validate that + the bundle before touching the scene.
        [MenuItem("OpenSlope/Load/Map...", false, 0)]
        public static void ImportMapDialog()
        {
            string projRoot = Path.GetDirectoryName(Application.dataPath).Replace('\\', '/');   // parent of Assets
            string lastRel  = EditorPrefs.GetString(ImportConfig.LastFolderPrefKey, ImportConfig.DefaultLevelFolder);
            string startAbs = Directory.Exists(Path.Combine(projRoot, lastRel)) ? Path.Combine(projRoot, lastRel)
                                                                                : Path.Combine(projRoot, "Assets");

            string abs = EditorUtility.OpenFolderPanel("Select an SSX level folder (the one containing gltf/)", startAbs, "");
            if (string.IsNullOrEmpty(abs)) return;                                              // cancelled
            abs = abs.Replace('\\', '/');

            // Must be inside this project's Assets/.
            string assets = Application.dataPath.Replace('\\', '/');
            if (!abs.StartsWith(assets + "/") && abs != assets)
            {
                EditorUtility.DisplayDialog("OpenSlope: folder must be in the project",
                    "Pick a level folder INSIDE this project's Assets (e.g. Assets/OpenSlope/Maps/MyLevel). The importer loads " +
                    "textures/audio/meshes through Unity's AssetDatabase, so the data has to live under Assets.\n\nYou picked:\n" + abs, "OK");
                return;
            }
            string rel = "Assets" + abs.Substring(assets.Length);

            // Must carry a snowknife gltf.
            if (!File.Exists(Path.Combine(projRoot, rel + "/gltf/manifest.json")))
            {
                EditorUtility.DisplayDialog("OpenSlope: no bundle in that folder",
                    $"No gltf/manifest.json under:\n{rel}\n\nRun `snowknife import` then `snowknife gltf {rel} {Path.GetFileName(rel)}` first.", "OK");
                return;
            }

            // NB: no "replace the loaded map?" confirmation - import deletes + rebuilds OpenSlope_Map directly. Picking a
            // folder is itself the confirmation, and a modal confirm here would block a Unity-MCP-driven import.
            ImportFolder(rel);
        }

        // Programmatic import of an exported level folder (project-relative, e.g. "Assets/OpenSlope/Maps/MyLevel"). The menu dialog
        // above validates + calls this; it's also the entry point the Unity-MCP driver invokes directly (no interactive
        // dialog). Records the folder as "current" so the Refresh/Setup menus follow the loaded map.
        public static void ImportFolder(string levelFolder)
        {
            levelFolder = levelFolder.Replace('\\', '/').TrimEnd('/');
            EditorPrefs.SetString(ImportConfig.LastFolderPrefKey, levelFolder);

            // Bootstrap the UdonSharp program assets the wiring pass attaches. If any had to be created they finalize on
            // the next editor tick, so bail (and ask for a re-run) BEFORE building - nothing is attachable this pass.
            if (UdonTools.EnsureAllProgramAssets())
            {
                Debug.Log("OpenSlope: created UdonSharp program assets - they finalize on the next editor tick. " +
                          "Run OpenSlope/Load/Map... again to build the level.");
                return;
            }

            new LevelImporter(ImportConfig.For(levelFolder)).Import();   // neutral build: geometry + *Markers
            VrcWiring.Wire();                                            // realize the markers into VRChat behaviours

            // VRChat scene finalization (depends on the scene descriptor, so it lives here, not in the neutral importer):
            // lower the respawn floor below the mountain, warn if the VRCWorld lacks world-settings, and point the spawn.
            Map.SetRespawnHeightFromMap();
            Map.WarnIfWorldSettingsMissing();
            Map.PointSceneSpawn();
        }

        // Re-run just the firework triggers in a loaded map (build the volumes + launchers, then realize their markers).
        // The full import already runs this; the Refresh entry skips rebuilding everything else. Greyed out until a map
        // is loaded.
        [MenuItem("OpenSlope/Refresh/Triggers", false, 303)]
        public static void RefreshTriggers()
        {
            var cfg = ImportConfig.Current();
            var root = GameObject.Find(cfg.RootName);
            if (root == null) { Debug.LogError("OpenSlope: import a map first (OpenSlope/Load)."); return; }
            var level = root.transform.Find(cfg.LevelName) ?? root.transform;   // sub-objects live under OpenSlope_Map/Level
            new TriggerBuilder(cfg).Build(level);
            VrcWiring.Wire();
            AssetDatabase.SaveAssets();
            Debug.Log("OpenSlope: re-imported triggers (FireworkMarker realized by the wiring pass).");
        }
        [MenuItem("OpenSlope/Refresh/Triggers", true)]
        static bool RefreshTriggersEnabled() => GameObject.Find(ImportConfig.Current().RootName) != null;
    }
}
#endif
