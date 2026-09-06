#if UNITY_EDITOR
using System.IO;
using UnityEditor;
using UnityEngine;
using OpenSlope.Importer;

namespace OpenSlope.BasisPlugin
{

    // The Basis "Import All" entry point - the Basis analogue of VRC's ImportAll. It drives the SAME neutral
    // LevelImporter (Assets/OpenSlope/Importer), then runs the Basis wiring pass over the markers it left and the Basis scene
    // finalization. There is NO UdonSharp bootstrap (Basis has no Udon); finalization points the BasisScene spawn instead
    // of the VRChat world descriptor. So both platforms share one importer with zero platform code inside it.
    //
    // Flow (OpenSlope Basis/Load/Map...): pick the exported level folder (the one holding gltf/) -> build the level (neutral
    // geometry + *Markers + skybox) -> BasisWiring realizes/reports the markers -> BasisSetupAll finalizes the
    // Basis scene (spawn + environment). See docs/basis/061.
    public static class BasisImportAll
    {
        // Basis-specific refresh because the neutral importer cannot realize the proximity marker on its own.
        [MenuItem("OpenSlope Basis/Refresh/Audio", false, 340)]
        public static void RefreshAudio()
        {
            LevelImporterMenu.ImportAudio();
            BasisWiring.Wire();
        }
        [MenuItem("OpenSlope Basis/Refresh/Audio", true)]
        static bool RefreshAudioEnabled() => GameObject.Find(ImportConfig.Current().RootName) != null;

        // Generic level import: pick the exported level folder (the one snowknife wrote, containing gltf/). The folder MUST
        // be inside the project's Assets (textures/meshes load via AssetDatabase, which requires them imported as Unity
        // assets), so we validate that + the bundle before touching the scene. Mirrors ImportAll.ImportMapDialog.
        [MenuItem("OpenSlope Basis/Load/Map...", false, 0)]
        public static void ImportMapDialog()
        {
            string projRoot = Path.GetDirectoryName(Application.dataPath).Replace('\\', '/');
            string lastRel  = EditorPrefs.GetString(ImportConfig.LastFolderPrefKey, ImportConfig.DefaultLevelFolder);
            string startAbs = Directory.Exists(Path.Combine(projRoot, lastRel)) ? Path.Combine(projRoot, lastRel)
                                                                                : Path.Combine(projRoot, "Assets");

            string abs = EditorUtility.OpenFolderPanel("Select an SSX level folder (the one containing gltf/)", startAbs, "");
            if (string.IsNullOrEmpty(abs)) return;
            abs = abs.Replace('\\', '/');

            string assets = Application.dataPath.Replace('\\', '/');
            if (!abs.StartsWith(assets + "/") && abs != assets)
            {
                EditorUtility.DisplayDialog("Basis: folder must be in the project",
                    "Pick a level folder INSIDE this project's Assets (e.g. Assets/OpenSlope/Maps/MyLevel). The importer loads " +
                    "textures/meshes through Unity's AssetDatabase, so the data has to live under Assets.\n\nYou picked:\n" + abs, "OK");
                return;
            }
            string rel = "Assets" + abs.Substring(assets.Length);

            if (!File.Exists(Path.Combine(projRoot, rel + "/gltf/manifest.json")))
            {
                EditorUtility.DisplayDialog("Basis: no bundle in that folder",
                    $"No gltf/manifest.json under:\n{rel}\n\nRun `snowknife import` then `snowknife gltf {rel} {Path.GetFileName(rel)}` first.", "OK");
                return;
            }
            ImportFolder(rel);
        }

        // Programmatic import of an exported level folder (project-relative, e.g. "Assets/OpenSlope/Maps/MyLevel"). The menu dialog
        // validates + calls this; it's also the entry point a Unity-MCP driver invokes directly. Records the folder as
        // "current" so any Refresh/Setup follows the loaded map.
        public static void ImportFolder(string levelFolder)
        {
            levelFolder = levelFolder.Replace('\\', '/').TrimEnd('/');
            EditorPrefs.SetString(ImportConfig.LastFolderPrefKey, levelFolder);

            var cfg = ImportConfig.For(levelFolder);

            // Basis scope: geometry + textures + skybox + the FX/audio pass, plus the gem pickups and grind-rail network.
            // The particle effects have URP shaders (OpenSlope/Particle, OpenSlope/FlareHalo, OpenSlope/ParticleAdditive|Alpha); the
            // collision-triggered emitters + fireworks have Basis behaviours (BasisAmbientEmitter / BasisFirework);
            // the spinning gems get the spin manager + a pop/chime/regrow collect behaviour; the authored rails get an
            // BasisRailNetwork the rideable board grinds; and the course-flow triggers get their behaviours (reset zones
            // snap a rider back, teleport portals warp player/board, speed pads run a timed board boost) - all realized by
            // BasisWiring. Audio is stock Unity AudioSources (Basis's Steam Audio spatializes them natively). Only avatar
            // light probes stay off - a VRChat-shade feature. (Gems / rails / reset zones / teleports / boost pads all
            // ride the default builders + emit flags, so there are no extra build flags to flip here - the wiring pass
            // is what turns their markers into behaviours.)
            cfg.BuildParticles       = true;    // fog billboards (OpenSlope/Particle URP)
            cfg.BuildEmitters        = true;    // continuous snow cannons / flares (URP particle mats + OpenSlope/FlareHalo)
            cfg.BuildAmbientEmitters = true;    // collision dust/spark/fire bursts (BasisAmbientEmitter)
            cfg.EmitTriggers         = true;    // fireworks (BasisFirework) + firing sounds
            cfg.BuildAudio           = true;    // crowd + ambient beds (stock AudioSource; Steam Audio spatializes)
            cfg.BuildProbes          = false;   // avatar light probes are a VRChat-shade feature

            // Drop any interim hand-built root (named after the level folder's leaf), so the scene keeps only the
            // importer's OpenSlope_Map. No-op once imports run through here from a clean scene.
            var stray = GameObject.Find(Path.GetFileName(levelFolder));
            if (stray != null && stray.transform.parent == null && stray.name != cfg.RootName) Object.DestroyImmediate(stray);

            new LevelImporter(cfg).Import();   // neutral build: geometry + *Markers + skybox/fog/sun
            BasisWiring.Wire();             // realize/report the markers (scaffold reports until behaviours are ported)
            BasisSetupAll.FinalizeScene(cfg); // Basis scene finalization: point the spawn + pin the environment

            Debug.Log("Basis: load complete for " + levelFolder + " (geometry + textures + skybox + FX/audio: " +
                      "particles, emitters, ambient bursts, fireworks, crowd/ambient audio; gems spin + collect; rails " +
                      "grindable; reset zones + teleports + boost pads live; avatar probes disabled until ported).");
        }
    }
}
#endif
