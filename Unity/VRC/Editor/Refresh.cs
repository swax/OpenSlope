#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    // Per-subsystem "re-run ONE subsystem in a loaded map" menus that need the VRChat wiring pass. The neutral importer
    // builds each subsystem as *Markers; realizing them into UdonSharp behaviours is platform work, so a Refresh that
    // rebuilds a subsystem has to call VrcWiring.Wire() after - which can't live in the importer. Each menu rebuilds
    // its subsystem under OpenSlope_Map/Level, re-exposes the board-facing nodes at the OpenSlope_Map top (matching the full import),
    // then runs the wiring pass to realize the fresh markers. Greyed out until a map is loaded.
    public static class Refresh
    {
        // Rebuild native crowd/ambient sources, then realize the shared proximity marker into its Udon behaviour.
        [MenuItem("OpenSlope/Refresh/Audio", false, 340)]
        public static void Audio()
        {
            // A newly-synced runtime behaviour has no UdonSharpProgramAsset yet. Bootstrap it before rebuilding;
            // UdonSharp finalizes a new asset on the next editor tick, so automatically resume then.
            if (UdonTools.EnsureAllProgramAssets())
            {
                EditorApplication.delayCall += Audio;
                return;
            }
            LevelImporterMenu.ImportAudio();
            VrcWiring.Wire();
        }
        [MenuItem("OpenSlope/Refresh/Audio", true)]
        static bool AudioEnabled() => GameObject.Find(ImportConfig.Current().RootName) != null;

        // Rebuild the grind rail network + the MainType-25 rail gates from the bundle (so a regenerated manifest's cubic
        // data lands on the live boards) without touching terrain/props. NOTE: this recreates the OpenSlope_Map/Rails object; a
        // board that still has a serialized railNetwork pointing at the OLD one re-finds it by name at Start() only when
        // the field is null - if needed, null it so it re-binds.
        [MenuItem("OpenSlope/Refresh/Rails", false, 302)]
        public static void Rails()
        {
            var cfg = ImportConfig.Current();
            var rootGo = GameObject.Find(cfg.RootName);
            if (rootGo == null) { Debug.LogError("OpenSlope: no " + cfg.RootName + " in the scene - import a map first (OpenSlope/Load)."); return; }
            Transform level = rootGo.transform.Find(cfg.LevelName) ?? rootGo.transform;
            var topExisting = rootGo.transform.Find(Map.Rails);               // drop a previously-exposed one
            if (topExisting != null) Object.DestroyImmediate(topExisting.gameObject);
            new RailBuilder(cfg).Build(level);
            var built = level.Find("Rails");                                     // re-expose at the identity top
            if (built != null) { built.SetParent(rootGo.transform, true); built.name = Map.Rails; }
            new RailGateBuilder(cfg).Build(level);                               // gates reference the re-exposed Rails object
            VrcWiring.Wire();                                                 // realize the fresh RailMarker + gate markers
            UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(rootGo.scene);
        }
        [MenuItem("OpenSlope/Refresh/Rails", true)]
        static bool RailsEnabled() => GameObject.Find(ImportConfig.Current().RootName) != null;

        // Rebuild the out-of-bounds course path from the bundle and realize it. This IS the course-progress re-bake too: in
        // the neutral pipeline the authored distance-to-finish is stamped onto the course marker as it's built, so re-baking
        // progress is just a course-path rebuild + realize (the polyline is cheap to rebuild) - hence one menu item, not two.
        [MenuItem("OpenSlope/Refresh/Course Path", false, 301)]
        public static void CoursePath()
        {
            RebuildCoursePath();
        }
        [MenuItem("OpenSlope/Refresh/Course Path", true)]
        static bool CoursePathEnabled() => GameObject.Find(ImportConfig.Current().RootName) != null;

        // Rebuild the reset zones + directional boost volumes and realize them.
        [MenuItem("OpenSlope/Refresh/Reset & Boost Volumes", false, 304)]
        public static void Volumes()
        {
            var cfg = ImportConfig.Current();
            var root = GameObject.Find(cfg.RootName);
            if (root == null) { Debug.LogError("OpenSlope: import a map first (OpenSlope/Load)."); return; }
            var level = root.transform.Find(cfg.LevelName) ?? root.transform;
            new VolumeBuilder(cfg).Build(level);
            VrcWiring.Wire();
            Debug.Log("OpenSlope: re-built reset zones + boost volumes.");
        }
        [MenuItem("OpenSlope/Refresh/Reset & Boost Volumes", true)]
        static bool VolumesEnabled() => GameObject.Find(ImportConfig.Current().RootName) != null;

        // Rebuild the spline movers (the subway) and realize them.
        [MenuItem("OpenSlope/Refresh/Spline Movers", false, 307)]
        public static void SplineMovers()
        {
            var cfg = ImportConfig.Current();
            var root = GameObject.Find(cfg.RootName);
            if (root == null) { Debug.LogError("OpenSlope: import a map first (OpenSlope/Load)."); return; }
            var level = root.transform.Find(cfg.LevelName) ?? root.transform;
            new SplineMoverBuilder(cfg).Build(level);
            VrcWiring.Wire();
            Debug.Log("OpenSlope: re-wired spline movers.");
        }
        [MenuItem("OpenSlope/Refresh/Spline Movers", true)]
        static bool SplineMoversEnabled() => GameObject.Find(ImportConfig.Current().RootName) != null;

        // Rebuild the boost pads and realize them.
        [MenuItem("OpenSlope/Refresh/Boost Pads", false, 305)]
        public static void BoostPads()
        {
            if (!Loaded(out var cfg, out var level)) return;
            new BoostPadBuilder(cfg).Build(level);
            VrcWiring.Wire();
        }
        [MenuItem("OpenSlope/Refresh/Boost Pads", true)]
        static bool BoostPadsEnabled() => GameObject.Find(ImportConfig.Current().RootName) != null;

        // Rebuild the teleport portals and realize them.
        [MenuItem("OpenSlope/Refresh/Teleports", false, 306)]
        public static void Teleports()
        {
            if (!Loaded(out var cfg, out var level)) return;
            new TeleportBuilder(cfg).Build(level);
            VrcWiring.Wire();
        }
        [MenuItem("OpenSlope/Refresh/Teleports", true)]
        static bool TeleportsEnabled() => GameObject.Find(ImportConfig.Current().RootName) != null;

        // Rebuild the collision-triggered ambient emitters (dust/spark/fire/water) and realize them.
        [MenuItem("OpenSlope/Refresh/Ambient Emitters", false, 341)]
        public static void AmbientEmitters()
        {
            if (!Loaded(out var cfg, out var level)) return;
            new AmbientEmitterBuilder(cfg).Build(level);
            VrcWiring.Wire();
        }
        [MenuItem("OpenSlope/Refresh/Ambient Emitters", true)]
        static bool AmbientEmittersEnabled() => GameObject.Find(ImportConfig.Current().RootName) != null;

        // Re-catalog the billboard screens from the bundle and hand them to the video system. The quads carry no Udon of
        // their own (a screen is a plain renderer the VideoBillboards object drives), so there is nothing to wire - but
        // the catalog has to be re-exposed at the map top the way the import leaves it, and the previously-consumed
        // screens replaced, or the video object would keep driving the old set. Reach for this after re-running
        // `snowknife billboards` + `gltf`, or after hand-editing screens you want thrown away (docs/vrchat/041).
        [MenuItem("OpenSlope/Refresh/Billboard Screens", false, 308)]
        public static void BillboardScreens()
        {
            if (!Loaded(out var cfg, out var level)) return;
            var root = GameObject.Find(cfg.RootName).transform;
            var exposed = root.Find(MapLayout.Billboards);                      // drop a previously-exposed catalog
            if (exposed != null) Object.DestroyImmediate(exposed.gameObject);
            new BillboardScreenBuilder(cfg).Build(level);
            var built = level.Find(BillboardScreenBuilder.RootObjectName);      // re-expose at the identity top
            if (built != null) { built.SetParent(root, true); built.name = MapLayout.Billboards; }
            int moved = VideoBillboardsSetup.MoveCatalogIntoScreens();
            Debug.Log($"OpenSlope: re-cataloged the billboard screens ({moved} now under VideoBillboards/Screens).");
            UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(root.gameObject.scene);
        }
        [MenuItem("OpenSlope/Refresh/Billboard Screens", true)]
        static bool BillboardScreensEnabled() => GameObject.Find(ImportConfig.Current().RootName) != null;

        // Re-bake the analytic terrain-contact patches (docs/021) and realize + wire them onto the boards.
        [MenuItem("OpenSlope/Refresh/Terrain Patches", false, 300)]
        public static void TerrainPatches()
        {
            var cfg = ImportConfig.Current();
            if (GameObject.Find(cfg.RootName) == null) { Debug.LogError("OpenSlope: import a map first (OpenSlope/Load)."); return; }
            string result = TerrainPatchBuilder.Bake(cfg.RootName, cfg.LevelFolder + "/Patches.json", cfg.NoCollisionSurfaceType, cfg.TerrainRes);
            if (result.StartsWith("ERROR")) { Debug.LogError("OpenSlope: " + result); return; }
            VrcWiring.Wire();
            if (result.StartsWith("WARN")) Debug.LogWarning("OpenSlope: " + result);
            else Debug.Log("OpenSlope: " + result);
        }
        [MenuItem("OpenSlope/Refresh/Terrain Patches", true)]
        static bool TerrainPatchesEnabled() => GameObject.Find(ImportConfig.Current().RootName) != null;

        // Resolve the current config + the loaded map's Level transform; false (with an error) if no map is loaded.
        static bool Loaded(out ImportConfig cfg, out Transform level)
        {
            cfg = ImportConfig.Current();
            var root = GameObject.Find(cfg.RootName);
            if (root == null) { Debug.LogError("OpenSlope: import a map first (OpenSlope/Load)."); level = null; return false; }
            level = root.transform.Find(cfg.LevelName) ?? root.transform;
            return true;
        }

        static void RebuildCoursePath()
        {
            var cfg = ImportConfig.Current();
            var rootGo = GameObject.Find(cfg.RootName);
            if (rootGo == null) { Debug.LogError("OpenSlope: no " + cfg.RootName + " in the scene - import a map first (OpenSlope/Load)."); return; }
            Transform level = rootGo.transform.Find(cfg.LevelName) ?? rootGo.transform;
            var topExisting = rootGo.transform.Find(Map.CoursePath);          // drop a previously-exposed one
            if (topExisting != null) Object.DestroyImmediate(topExisting.gameObject);
            new CoursePathBuilder(cfg).Build(level);
            var built = level.Find("CoursePath");                               // re-expose at the identity top
            if (built != null) { built.SetParent(rootGo.transform, true); built.name = Map.CoursePath; }
            VrcWiring.Wire();                                                 // realize the fresh RailMarker (with its DTF)
            UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(rootGo.scene);
        }
    }
}
#endif
