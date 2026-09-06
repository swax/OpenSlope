#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Builds SSF firework trigger volumes and their graph-linked launchers. The launcher visual is the authored
    // effect itself: each extracted MainType-2/SubType-0 layer runs through the shared native P6 realization.
    public class TriggerBuilder
    {
        readonly ImportConfig _cfg;
        readonly Dictionary<string, AudioClip> _clips = new Dictionary<string, AudioClip>(StringComparer.Ordinal);
        int _soundCount;

        public TriggerBuilder(ImportConfig cfg) { _cfg = cfg; }

        public void Build(Transform root)
        {
            if (!_cfg.EmitTriggers) return;
            var oldTriggers = root.Find("Triggers");
            if (oldTriggers != null) UnityEngine.Object.DestroyImmediate(oldTriggers.gameObject);
            var oldFireworks = root.Find("Fireworks");
            if (oldFireworks != null) UnityEngine.Object.DestroyImmediate(oldFireworks.gameObject);

            var fireworkRoot = new GameObject("Fireworks");
            fireworkRoot.transform.SetParent(root, false);
            var triggerRoot = new GameObject("Triggers");
            triggerRoot.transform.SetParent(root, false);

            _clips.Clear();
            _soundCount = 0;
            GatherData(out var launcherData, out var triggerData, out bool hasRealMap);
            var p6 = new P6EmitterBuilder(_cfg);
            var launchers = new List<KeyValuePair<Vector3, ParticleSystem>>();
            var launchersByIndex = new Dictionary<int, ParticleSystem>();
            int layerCount = 0;
            foreach (var launcher in launcherData)
            {
                var system = p6.BuildGroup(fireworkRoot.transform, "FW_" + launcher.Index, launcher.Layers,
                    continuous: false, interactive: true);
                if (system == null) continue;
                AttachFireworkSound(system.gameObject, launcher.Sound);
                launchers.Add(new KeyValuePair<Vector3, ParticleSystem>(launcher.Muzzle, system));
                launchersByIndex[launcher.Index] = system;
                layerCount += launcher.Layers.Count;
            }

            int made = 0, links = 0, empty = 0, realMapped = 0, radiusMapped = 0;
            float radiusSquared = _cfg.FireworkFireRadius * _cfg.FireworkFireRadius;
            foreach (var trigger in triggerData)
            {
                var go = new GameObject($"Trig_{trigger.Index}_{trigger.Name}");
                go.transform.SetParent(triggerRoot.transform, false);
                go.transform.localPosition = trigger.Center;
                NativeCollision.AddPassThroughBox(go, Vector3.zero, trigger.Size,
                    NativeCollision.BoundingBox);

                ParticleSystem[] systems = null;
                if (trigger.Launchers != null && trigger.Launchers.Length > 0)
                {
                    var mapped = new List<ParticleSystem>(trigger.Launchers.Length);
                    foreach (int index in trigger.Launchers)
                        if (launchersByIndex.TryGetValue(index, out var system) && system != null) mapped.Add(system);
                    if (mapped.Count > 0) { systems = mapped.ToArray(); realMapped++; }
                }
                if (systems == null)
                {
                    var nearby = new List<KeyValuePair<float, ParticleSystem>>();
                    foreach (var launcher in launchers)
                    {
                        float distance = (launcher.Key - trigger.Center).sqrMagnitude;
                        if (distance <= radiusSquared) nearby.Add(new KeyValuePair<float, ParticleSystem>(distance, launcher.Value));
                    }
                    nearby.Sort((a, b) => a.Key.CompareTo(b.Key));
                    int count = Mathf.Min(nearby.Count, _cfg.FireworkMaxPerTrigger);
                    systems = new ParticleSystem[count];
                    for (int i = 0; i < count; i++) systems[i] = nearby[i].Value;
                    if (count > 0) radiusMapped++;
                }
                if (systems.Length == 0) empty++;

                var marker = go.AddComponent<FireworkMarker>();
                marker.Fireworks = systems;
                marker.VolleyStagger = _cfg.FireworkVolleyStagger;
                marker.Cooldown = _cfg.FireworkCooldown;
                marker.EffectSlotIndex = trigger.Slot;
                made++;
                links += systems.Length;
            }

            if (made == 0 && launchers.Count == 0)
            {
                UnityEngine.Object.DestroyImmediate(triggerRoot);
                UnityEngine.Object.DestroyImmediate(fireworkRoot);
                return;
            }

            string map = hasRealMap
                ? $"{realMapped} graph-mapped" + (radiusMapped > 0 ? $", {radiusMapped} radius-mapped" : "")
                : $"{radiusMapped} radius-mapped";
            Debug.Log($"OpenSlope: built {launchers.Count} P6 firework launcher(s), {layerCount} authored layer(s), " +
                      $"{made} trigger(s), {links} links ({map}), {_soundCount} firing sound(s)" +
                      (empty > 0 ? $", {empty} empty trigger(s)" : "") + ".");
        }

        struct LauncherData
        {
            public int Index;
            public Vector3 Muzzle;
            public List<BundleManifestReader.EmitterLayer> Layers;
            public int Sound;
        }

        struct TriggerData
        {
            public int Index;
            public string Name;
            public int Slot;
            public Vector3 Center;
            public Vector3 Size;
            public int[] Launchers;
        }

        void GatherData(out List<LauncherData> launchers, out List<TriggerData> triggers, out bool hasRealMap)
        {
            launchers = new List<LauncherData>();
            triggers = new List<TriggerData>();
            hasRealMap = false;
            var bundle = new BundleManifestReader(_cfg);
            if (!bundle.Exists || !bundle.HasFireworks) return;

            foreach (var launcher in bundle.FwLaunchers)
                launchers.Add(new LauncherData {
                    Index = launcher.Index, Muzzle = launcher.Muzzle, Layers = launcher.Layers, Sound = launcher.Sound,
                });
            foreach (var trigger in bundle.FwTriggers)
            {
                int[] mapped = _cfg.FireworkUseRealMapping && trigger.Launchers != null
                    ? trigger.Launchers : new int[0];
                if (mapped.Length > 0) hasRealMap = true;
                triggers.Add(new TriggerData {
                    Index = trigger.Index, Name = trigger.Name, Slot = trigger.Slot,
                    Center = trigger.Center, Size = trigger.Size, Launchers = mapped,
                });
            }
        }

        void AttachFireworkSound(GameObject go, int sound)
        {
            AudioClip clip = ClipForSound(sound);
            if (clip == null) return;
            var source = go.AddComponent<AudioSource>();
            source.clip = clip;
            source.playOnAwake = false;
            source.loop = false;
            source.volume = Mathf.Clamp01(_cfg.FireworkSoundVolume);
            source.spatialBlend = 1f;
            source.dopplerLevel = 0f;
            source.rolloffMode = AudioRolloffMode.Linear;
            source.minDistance = _cfg.FireworkSoundMinDistance;
            source.maxDistance = Mathf.Max(_cfg.FireworkSoundMinDistance, _cfg.FireworkSoundMaxDistance);
            go.AddComponent<SpatialAudio>();
            _soundCount++;
        }

        AudioClip ClipForSound(int sound)
        {
            string slot = sound >= 0 ? sound.ToString("000") : _cfg.FireworkSoundSlot;
            if (string.IsNullOrEmpty(slot) || string.IsNullOrEmpty(_cfg.LevelSfxBank)) return null;
            if (_clips.TryGetValue(slot, out var cached)) return cached;
            string path = _cfg.LevelFolder + "/Audio/SFX/" + _cfg.LevelSfxBank + "/" + slot + ".wav";
            var clip = AssetDatabase.LoadAssetAtPath<AudioClip>(path);
            if (clip == null)
                Debug.LogWarning("OpenSlope: firework sound not found - " + path + ". Run `snowknife import` to decode the bank.");
            _clips[slot] = clip;
            return clip;
        }
    }
}
#endif
