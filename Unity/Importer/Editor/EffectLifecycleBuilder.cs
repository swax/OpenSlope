#if UNITY_EDITOR
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{
    public sealed class EffectLifecycleBuilder
    {
        readonly ImportConfig _cfg;
        public EffectLifecycleBuilder(ImportConfig cfg) { _cfg = cfg; }

        public static void Tag(GameObject go, int index, bool detached = false)
        {
            if (go == null || index < 0) return;
            var identity = go.GetComponent<EffectIdentityMarker>();
            if (identity == null) identity = go.AddComponent<EffectIdentityMarker>();
            identity.index = index; identity.detached = detached;
        }

        public void Build(Transform root, FlipbookAccum flip, BundleManifestReader reader = null)
        {
            if (reader == null) reader = new BundleManifestReader(_cfg);
            var previous = root.Find("EffectLifecycle");
            if (previous != null) Object.DestroyImmediate(previous.gameObject);
            if (reader.EffectTriggers.Count == 0) return;
            var holder = new GameObject("EffectLifecycle"); holder.transform.SetParent(root, false);
            var identities = root.GetComponentsInChildren<EffectIdentityMarker>(true);
            var targets = new Dictionary<int, GameObject>();
            foreach (var target in reader.EffectTargets)
            {
                var go = new GameObject($"Target_{target.Index}_{target.Name}");
                go.transform.SetParent(holder.transform, false); targets[target.Index] = go;
                var owned = identities.Where(i => i.index == target.Index).ToArray();
                var installed = owned.Where(i => !i.detached).Select(i => i.gameObject).ToList();
                var detached = owned.Where(i => i.detached).Select(i => i.gameObject).ToArray();
                var marker = go.AddComponent<EffectTargetMarker>();
                marker.targetRenderers = installed.SelectMany(o => o.GetComponentsInChildren<Renderer>(true)).Distinct().ToArray();
                marker.targetColliders = installed.SelectMany(o => o.GetComponentsInChildren<Collider>(true)).Distinct().ToArray();
                marker.detachedParticles = detached.SelectMany(o => o.GetComponentsInChildren<ParticleSystem>(true)).Distinct().ToArray();
                marker.detachedObjects = detached;
                // Each stoppable receiver owns its material clocks. Do not freeze a shared sign/UV/wind material.
                int materialIndex = 0;
                foreach (var renderer in marker.targetRenderers)
                {
                    var materials = renderer.sharedMaterials;
                    for (int s = 0; s < materials.Length; s++)
                    {
                        if (materials[s] == null) continue;
                        var copy = new Material(materials[s]);
                        string path = $"{_cfg.MatFolder}/Effect_{target.Index}_{materialIndex++}.mat";
                        AssetDatabase.DeleteAsset(path); AssetDatabase.CreateAsset(copy, path);
                        materials[s] = copy;
                    }
                    renderer.sharedMaterials = materials;
                }
                SplitFlipbooks(go, marker.targetRenderers, flip);
                installed.Add(go);
                marker.installedObjects = installed.ToArray();
            }
            foreach (var trigger in reader.EffectTriggers)
            {
                var go = new GameObject($"Trigger_{trigger.Index}_{trigger.Name}");
                go.transform.SetParent(holder.transform, false); go.transform.localPosition = trigger.Center;
                var box = go.AddComponent<BoxCollider>(); box.isTrigger = true;
                box.size = Vector3.Max(trigger.Size, Vector3.one);
                var marker = go.AddComponent<EffectTriggerMarker>();
                marker.targetObjects = trigger.Actions.Select(a => targets[a.Target]).ToArray();
                marker.modes = trigger.Actions.Select(a => a.Mode).ToArray();
                marker.delays = trigger.Actions.Select(a => a.Delay).ToArray();
                marker.oneShot = trigger.OneShot;
            }
        }

        static void SplitFlipbooks(GameObject owner, Renderer[] renderers, FlipbookAccum source)
        {
            var owned = new HashSet<Renderer>(renderers);
            var local = new FlipbookAccum(); var remaining = new FlipbookAccum();
            int offset = 0;
            for (int i = 0; i < source.Count; i++)
            {
                int count = source.FrameCounts[i];
                (owned.Contains(source.Renderers[i]) ? local : remaining).Add(source.Renderers[i], source.Slots[i],
                    source.Frames.GetRange(offset, count).ToArray(), source.Fps[i], new Vector2(source.DwellBase[i], source.DwellFlash[i]));
                offset += count;
            }
            if (local.Count == 0) return;
            var marker = owner.AddComponent<FlipbookMarker>();
            marker.Renderers = local.Renderers.ToArray(); marker.Slots = local.Slots.ToArray(); marker.Fps = local.Fps.ToArray();
            marker.FrameCounts = local.FrameCounts.ToArray(); marker.Frames = local.Frames.ToArray();
            marker.DwellBase = local.DwellBase.ToArray(); marker.DwellFlash = local.DwellFlash.ToArray();
            source.Renderers.Clear(); source.Renderers.AddRange(remaining.Renderers);
            source.Slots.Clear(); source.Slots.AddRange(remaining.Slots);
            source.Fps.Clear(); source.Fps.AddRange(remaining.Fps);
            source.FrameCounts.Clear(); source.FrameCounts.AddRange(remaining.FrameCounts);
            source.Frames.Clear(); source.Frames.AddRange(remaining.Frames);
            source.DwellBase.Clear(); source.DwellBase.AddRange(remaining.DwellBase);
            source.DwellFlash.Clear(); source.DwellFlash.AddRange(remaining.DwellFlash);
        }
    }
}
#endif
