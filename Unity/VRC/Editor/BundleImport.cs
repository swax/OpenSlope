#if UNITY_EDITOR
using System.IO;
using UnityEditor;
using UnityEngine;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    // Bundle subset menus (OpenSlope/Dev/Load Terrain (gltf test) | Load Props): load just the terrain, or props + collision +
    // paths + particles + fireworks + audio + probes, from the snowknife gltf into OpenSlope_Map/Level. The full
    // OpenSlope/Load is already bundle-driven (it runs these same builders); these are kept as quick partial-load
    // utilities for iterating on one subsystem without a full import.
    public static class BundleImport
    {
        [MenuItem("OpenSlope/Dev/Load Terrain (gltf test)", false, 920)]
        public static void LoadTerrain()
        {
            var cfg = ImportConfig.Current();
            Shader sh = cfg.ResolveShader();
            if (sh == null) { Debug.LogError("OpenSlope: no usable shader."); return; }
            EnsureFolder(cfg.MatFolder);

            var alpha = new AlphaClassifier(cfg);
            var materials = new MaterialFactory(cfg, sh, alpha);

            var root = GameObject.Find(cfg.RootName) ?? new GameObject(cfg.RootName);
            var levelT = root.transform.Find(cfg.LevelName);
            var level = levelT != null ? levelT.gameObject : new GameObject(cfg.LevelName);
            level.transform.SetParent(root.transform, false);
            level.transform.localEulerAngles = cfg.RootEuler;
            level.transform.localScale = Vector3.one * cfg.WorldScale;

            new TerrainBuilder(cfg, materials).Build(level.transform);

            AssetDatabase.SaveAssets();
            Selection.activeGameObject = root;
            Debug.Log("OpenSlope: bundle terrain load complete.");
        }

        [MenuItem("OpenSlope/Dev/Load Props (gltf test)", false, 921)]
        public static void LoadProps()
        {
            var cfg = ImportConfig.Current();
            // Diverted instances (gems/physics/breakable) need the UdonSharp program assets; bootstrap them like
            // the full importer does (two-click on a fresh project).
            if (UdonTools.EnsureAllProgramAssets())
            {
                Debug.Log("OpenSlope: created UdonSharp program assets - run OpenSlope/Dev/Load Props (gltf test) again to build.");
                return;
            }
            Shader sh = cfg.ResolveShader();
            if (sh == null) { Debug.LogError("OpenSlope: no usable shader."); return; }
            EnsureFolder(cfg.MatFolder);

            var alpha = new AlphaClassifier(cfg);
            var materials = new MaterialFactory(cfg, sh, alpha);
            var lighting = new InstanceLighting(cfg);   // ProbeBuilder (probe SH bake) still lights from Instances.json
            var collision = new CollisionBuilder(cfg);
            var props = new PropBuilder(cfg, materials, collision);

            var root = GameObject.Find(cfg.RootName) ?? new GameObject(cfg.RootName);
            var levelT = root.transform.Find(cfg.LevelName);
            var level = levelT != null ? levelT.gameObject : new GameObject(cfg.LevelName);
            level.transform.SetParent(root.transform, false);
            level.transform.localEulerAngles = cfg.RootEuler;
            level.transform.localScale = Vector3.one * cfg.WorldScale;

            props.Build(level.transform, new FlipbookAccum());

            // Prop collision from the bundle (collision.glb + manifest): bounce buckets, computed-bounds boxes, foliage.
            collision.ImportCollision(level.transform);
            collision.ImportComputedBoundsColliders(level.transform);
            collision.ImportBodyColliders(level.transform);
            collision.ImportFoliageSwishTriggers(level.transform);
            collision.ImportContactSoundTriggers(level.transform);

            // Rails + course paths from the bundle (manifest polylines -> RailNetwork).
            new RailBuilder(cfg).Build(level.transform);
            new CoursePathBuilder(cfg).Build(level.transform);

            // Particles (fog billboards) + fireworks (launcher bursts + trigger volumes) from the bundle.
            new ParticleBuilder(cfg, cfg.ResolveParticleShader()).Build(level.transform);
            new TriggerBuilder(cfg).Build(level.transform);

            // Audio crowd centroids + light-probe positions from the bundle (placement only; clip + SH/bake stay engine-side).
            new AudioBuilder(cfg, collision).Build(level.transform);
            new ProbeBuilder(cfg, lighting).Build(level.transform);

            VrcWiring.Wire();   // realize the markers these builders emitted (gems/physics/rails/fireworks/audio/...)

            AssetDatabase.SaveAssets();
            Selection.activeGameObject = root;
            Debug.Log("OpenSlope: bundle props + collision + paths + particles + fireworks + audio + probes load complete.");
        }

        static void EnsureFolder(string assetFolder)
        {
            if (AssetDatabase.IsValidFolder(assetFolder)) return;
            string parent = Path.GetDirectoryName(assetFolder).Replace('\\', '/');
            string leaf = Path.GetFileName(assetFolder);
            if (!AssetDatabase.IsValidFolder(parent)) EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, leaf);
        }
    }
}
#endif
