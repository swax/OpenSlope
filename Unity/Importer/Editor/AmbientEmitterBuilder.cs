#if UNITY_EDITOR
using System.Collections.Generic;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Collision-triggered particle graphs (including dedicated Type2Sub2 snow-tree CollideEmitters) use the same
    // native P6 realization as persistent emitters and fireworks.
    // The marker remains platform-neutral: VRChat/Basis wiring decides how a rider crossing broadcasts Play().
    public class AmbientEmitterBuilder
    {
        readonly ImportConfig _cfg;

        public AmbientEmitterBuilder(ImportConfig cfg) { _cfg = cfg; }

        public void Build(Transform root)
        {
            if (!_cfg.BuildAmbientEmitters) return;
            var old = root.Find("AmbientEmitters");
            if (old != null) Object.DestroyImmediate(old.gameObject);

            var bundle = new BundleManifestReader(_cfg);
            if (!bundle.Exists || !bundle.HasAmbientEmitters) return;

            var ambientRoot = new GameObject("AmbientEmitters");
            ambientRoot.transform.SetParent(root, false);
            var p6 = new P6EmitterBuilder(_cfg);

            int made = 0, layers = 0, repeatable = 0;
            foreach (var emitter in bundle.AmbientEmitters)
            {
                if (emitter.Layers == null || emitter.Layers.Count == 0) continue;

                var trigger = new GameObject($"Ambient_{emitter.Index}_{emitter.Name}");
                trigger.transform.SetParent(ambientRoot.transform, false);
                trigger.transform.localPosition = emitter.TriggerCenter;

                bool authoredTrigger = emitter.Name != null &&
                    emitter.Name.StartsWith("EffectTrigger_", System.StringComparison.Ordinal);
                Vector3 triggerSize = authoredTrigger
                    ? emitter.TriggerSize
                    : emitter.TriggerSize + Vector3.one * _cfg.AmbientTriggerInflate;
                NativeCollision.AddPassThroughBox(trigger, Vector3.zero, triggerSize,
                    authoredTrigger ? NativeCollision.TriangleProxy : NativeCollision.BoundingBox);

                // P6 layer origins are level-root-local, so the visual hierarchy stays beside (not under) the
                // independently positioned trigger volume.
                var system = p6.BuildGroup(ambientRoot.transform, $"Effect_{emitter.Index}", emitter.Layers,
                    continuous: false, interactive: true);
                if (system == null) { Object.DestroyImmediate(trigger); continue; }

                float interval = emitter.Repeatable ? Mathf.Max(0.25f, emitter.MinInterval) : _cfg.AmbientCooldown;
                if (emitter.Repeatable) repeatable++;
                var marker = trigger.AddComponent<AmbientEmitterMarker>();
                marker.Systems = new[] { system };
                marker.MinInterval = interval;
                marker.EffectSlotIndex = emitter.Index;
                marker.ContactDriven = emitter.ContactDriven;
                if (emitter.ContactDriven)
                {
                    marker.ContactRenderers = system.GetComponentsInChildren<ParticleSystemRenderer>(true);
                    marker.ContactSpeeds = new float[marker.ContactRenderers.Length];
                    for (int i = 0; i < marker.ContactRenderers.Length; i++)
                    {
                        var material = marker.ContactRenderers[i].sharedMaterial;
                        marker.ContactSpeeds[i] = material != null && material.HasProperty("_P6VelocityBase")
                            ? material.GetVector("_P6VelocityBase").magnitude : 0f;
                    }
                }
                marker.rollerLidObjects = ResolveRollerLids(root, emitter.RollerTargets);
                marker.PopSpeed = _cfg.AmbientRollerPopSpeed;
                made++;
                layers += emitter.Layers.Count;
            }

            if (made == 0) { Object.DestroyImmediate(ambientRoot); return; }
            Debug.Log($"OpenSlope: built {made} collision-triggered P6 emitter(s) ({repeatable} repeatable), " +
                      $"{layers} authored layer(s) under AmbientEmitters.");
        }

        static GameObject[] ResolveRollerLids(Transform root, int[] targets)
        {
            if (targets == null || targets.Length == 0) return new GameObject[0];
            var physics = root.Find("Physics");
            if (physics == null) return new GameObject[0];
            var result = new List<GameObject>(targets.Length);
            foreach (int index in targets)
            {
                string prefix = "Phys_" + index + "_";
                for (int i = 0; i < physics.childCount; i++)
                {
                    var child = physics.GetChild(i);
                    if (!child.name.StartsWith(prefix, System.StringComparison.Ordinal)) continue;
                    result.Add(child.gameObject);
                    break;
                }
            }
            return result.ToArray();
        }
    }
}
#endif
