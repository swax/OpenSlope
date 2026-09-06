#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Builds every persistent MainType-2/SubType-0 graph through the shared P6 realization. snowknife has already baked
    // each layer's owning instance pose into root-local mesh space, so snow cannons, road flares, and lantern flames all
    // use the same authored origin, spawn basis, velocity envelope, trajectory, lifetime, color, sprite, and blend law.
    public class EmitterBuilder
    {
        readonly ImportConfig _cfg;

        public EmitterBuilder(ImportConfig cfg) { _cfg = cfg; }

        public void Build(Transform root)
        {
            if (!_cfg.BuildEmitters) return;
            var old = root.Find("Emitters");
            if (old != null) Object.DestroyImmediate(old.gameObject);

            var bundle = new BundleManifestReader(_cfg);
            if (!bundle.Exists || !bundle.HasEmitters) return;

            var emRoot = new GameObject("Emitters");
            emRoot.transform.SetParent(root, false);
            var cannons = new GameObject("Cannons"); cannons.transform.SetParent(emRoot.transform, false);
            var flares = new GameObject("Flares"); flares.transform.SetParent(emRoot.transform, false);
            var p6 = new P6EmitterBuilder(_cfg);

            int emitters = 0, layers = 0, skipped = 0;
            foreach (var emitter in bundle.Emitters)
            {
                if (emitter.Layers == null || emitter.Layers.Count == 0) continue;
                if (_cfg.EmitterMinSize > 0f)
                {
                    float biggest = 0f;
                    foreach (var layer in emitter.Layers) biggest = Mathf.Max(biggest, layer.SizeCenter);
                    if (biggest < _cfg.EmitterMinSize) { skipped++; continue; }
                }

                Transform parent = IsCannon(emitter.Name) ? cannons.transform : flares.transform;
                if (p6.BuildGroup(parent, $"Emit_{emitter.Index}_{emitter.Name}", emitter.Layers,
                    continuous: true, interactive: false) == null) continue;
                emitters++;
                layers += emitter.Layers.Count;
            }

            if (emitters == 0) { Object.DestroyImmediate(emRoot); return; }
            if (cannons.transform.childCount == 0) Object.DestroyImmediate(cannons);
            if (flares.transform.childCount == 0) Object.DestroyImmediate(flares);
            Debug.Log($"OpenSlope: built {emitters} persistent P6 emitter(s), {layers} authored layer(s)" +
                      (skipped > 0 ? $", {skipped} skipped below EmitterMinSize {_cfg.EmitterMinSize}" : "") + ".");
        }

        static bool IsCannon(string name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            string value = name.ToLowerInvariant();
            return value.Contains("blower") || value.Contains("cannon") || value.Contains("snowblow");
        }

        [MenuItem("OpenSlope/Refresh/Prop Emitters", false, 324)]
        public static void RefreshEmitters()
        {
            var cfg = ImportConfig.Current();
            var root = GameObject.Find(cfg.RootName);
            if (root == null) { Debug.LogError("OpenSlope: import a map first (OpenSlope/Load)."); return; }
            var level = root.transform.Find(cfg.LevelName) ?? root.transform;
            new EmitterBuilder(cfg).Build(level);
            AssetDatabase.SaveAssets();
            Debug.Log("OpenSlope: re-imported persistent P6 emitters.");
        }

        [MenuItem("OpenSlope/Refresh/Prop Emitters", true)]
        static bool RefreshEmittersEnabled() => GameObject.Find(ImportConfig.Current().RootName) != null;
    }
}
#endif
