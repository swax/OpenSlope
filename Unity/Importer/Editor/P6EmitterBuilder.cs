#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Shared Unity realization of SSX's MainType-2/SubType-0 particle emitter. snowknife has already applied the owning
    // instance transform, so every manifest layer is expressed directly in the level root's mesh space. A stock
    // ParticleSystem supplies emission timing, random lifetime/size, camera-facing quads, and a conservative CPU-side
    // culling envelope; the P6 shader discards that envelope position and moves the quads with the recovered native
    // trajectory. This remains VRChat-safe: no runtime MonoBehaviour is required.
    public sealed class P6EmitterBuilder
    {
        const float PersistentLifetime = 3f;
        const float MaxPersistentRate = 200f;
        // Authored size is a HALF-extent in native units, so a drawn sprite is twice as wide: P6 emits each
        // billboard's corners at `center -/+ extent`, and the engine hands it the authored pair unscaled
        // ([Trailmap: 400-sprites] — the size field is a half-extent; confirmed against live emitter records).
        const float NativeSizeToWidth = 2f;
        // A one-shot event and a continuous plume both draw at their authored width; only opacity separates them.
        const float EventSizeScale = 1f;
        const float InteractiveAlphaFloor = 0.45f;
        const int MaxHeads = 2000;
        const int MaxTrailCopies = 10;

        static readonly string[] SpriteNames = {
            "part", "snfl", "clod", "spry", "halo", "brk1", "brk2", "brk3",
            "ndl1", "ndl2", "swd1", "swd2", "swp1", "swp2", "cnf1", "cnf2",
            "blb1", "blb2", "str1", "str2", "str3", "nois", "strk", "tral",
            "ex06", "ex07", "ex08", "ex09", "lens", "blnk", "mip1", "mip1",
            "mip2", "beam", "fog0", "spec", "envr", "exlm",
        };

        readonly ImportConfig _cfg;
        readonly Shader _additive;
        readonly Shader _alpha;
        readonly Dictionary<string, Material> _materials = new Dictionary<string, Material>(StringComparer.Ordinal);
        bool _warnedShader;

        public P6EmitterBuilder(ImportConfig cfg)
        {
            _cfg = cfg;
            _additive = Shader.Find("OpenSlope/P6ParticleAdditive");
            _alpha = Shader.Find("OpenSlope/P6ParticleAlpha");
        }

        // The full importer creates P6 systems while the level root is still at its authored origin, then translates
        // that root to recenter the mountain. Custom1 is serialized world-space data rather than a transform-relative
        // value, so rewrite it after every hierarchy transform is final. Detect both the intended P6 shaders and the
        // P6 vertex-stream contract so the pass also repairs systems whose material reference is temporarily missing.
        public static int FinalizeWorldOrigins(Transform root)
        {
            if (root == null) return 0;

            int updated = 0;
            var streams = new List<ParticleSystemVertexStream>();
            foreach (var ps in root.GetComponentsInChildren<ParticleSystem>(true))
            {
                var renderer = ps.GetComponent<ParticleSystemRenderer>();
                if (renderer == null || !IsP6(renderer, streams)) continue;

                SetWorldOrigin(ps, ps.transform.position);
                EditorUtility.SetDirty(ps);
                updated++;
            }
            return updated;
        }

        // Build all authored layers under one playable ParticleSystem hierarchy. Play() on the returned root also plays
        // every child layer and trail copy, which preserves the existing firework/ambient marker seam.
        public ParticleSystem BuildGroup(Transform parent, string name,
            IList<BundleManifestReader.EmitterLayer> layers, bool continuous, bool interactive)
        {
            if (layers == null || layers.Count == 0) return null;

            Vector3 groupOrigin = layers[0].Origin;
            var group = new GameObject(name);
            group.transform.SetParent(parent, false);
            group.transform.localPosition = groupOrigin;

            ParticleSystem root = null;
            for (int layerIndex = 0; layerIndex < layers.Count; layerIndex++)
            {
                var layer = layers[layerIndex];
                GameObject layerObject;
                if (layerIndex == 0) layerObject = group;
                else
                {
                    layerObject = new GameObject("L" + layerIndex);
                    layerObject.transform.SetParent(group.transform, false);
                    layerObject.transform.localPosition = layer.Origin - groupOrigin;
                }

                int copies = Mathf.Clamp(layer.TrailCopies, 1, MaxTrailCopies);
                uint seed = StableHash(LawSignature(layer, 0f));
                for (int trail = 0; trail < copies; trail++)
                {
                    GameObject target;
                    if (trail == 0) target = layerObject;
                    else
                    {
                        target = new GameObject("Trail" + trail);
                        target.transform.SetParent(layerObject.transform, false);
                    }
                    float ageOffset = Mathf.Max(0f, layer.TrailSpacing) * trail;
                    var ps = Configure(target, layer, continuous, interactive, ageOffset,
                        1f - trail / (float)copies, seed);
                    if (root == null) root = ps;
                }
            }

            if (continuous && root != null) root.Play(true);
            return root;
        }

        ParticleSystem Configure(GameObject go, BundleManifestReader.EmitterLayer layer, bool continuous,
            bool interactive, float trailAgeOffset, float trailFade, uint seed)
        {
            var ps = go.AddComponent<ParticleSystem>();
            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
            ps.useAutoRandomSeed = false;
            ps.randomSeed = seed == 0 ? 1u : seed;

            float lifeMin, lifeMax;
            if (continuous && layer.ParticleLifeCenter <= 0f && layer.ParticleLifeSpan <= 0f)
            {
                lifeMin = PersistentLifetime * 0.8f;
                lifeMax = PersistentLifetime * 1.2f;
            }
            else
            {
                lifeMin = Mathf.Clamp(layer.ParticleLifeCenter - layer.ParticleLifeSpan * 0.5f, 0.05f, 10f);
                lifeMax = Mathf.Clamp(layer.ParticleLifeCenter + layer.ParticleLifeSpan * 0.5f, lifeMin, 10f);
            }

            float visibility = interactive ? EventSizeScale : 1f;
            float sizeMin = Mathf.Max(3f, (layer.SizeCenter - layer.SizeSpan * 0.5f) * NativeSizeToWidth) * visibility;
            float sizeMax = Mathf.Max(sizeMin, (layer.SizeCenter + layer.SizeSpan * 0.5f) * NativeSizeToWidth * visibility);
            int count = Mathf.Clamp(layer.ParticleCount, 1, MaxHeads);

            var main = ps.main;
            main.loop = continuous;
            main.playOnAwake = continuous;
            main.startLifetime = new ParticleSystem.MinMaxCurve(lifeMin, lifeMax);
            main.startSize = new ParticleSystem.MinMaxCurve(sizeMin, sizeMax);
            main.startSpeed = 0f;
            main.startColor = Color.white;
            main.gravityModifier = 0f;
            main.simulationSpace = ParticleSystemSimulationSpace.Local;
            main.scalingMode = ParticleSystemScalingMode.Hierarchy;
            // A stopped ParticleSystemRenderer reports zero bounds, and Renderer.localBounds overrides are deliberately
            // not serialized by Unity. Always advance the system long enough to emit its CPU-side envelope particles;
            // the populated envelope then supplies conservative, serializable runtime culling bounds.
            main.cullingMode = ParticleSystemCullingMode.AlwaysSimulate;

            var shape = ps.shape;
            // The native P6 trajectory is evaluated in the shader, so the CPU otherwise sees every particle sitting at
            // the launcher and culls long-range sparks. Spawn the zero-speed CPU particles over a conservative sphere.
            // The Center vertex stream lets the shader subtract this synthetic center before applying the real law, so
            // it affects culling only and cannot perturb the authored particle positions.
            Bounds trajectoryBounds = BoundsFor(layer, lifeMax, sizeMax);
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Sphere;
            shape.radius = BoundsRadius(trajectoryBounds) * 1.1f;
            shape.radiusThickness = 1f;

            var emission = ps.emission;
            emission.enabled = true;
            emission.SetBursts(Array.Empty<ParticleSystem.Burst>());
            float occupancy = Mathf.Max(0.05f, layer.ParticleLifeCenter + layer.ParticleLifeSpan * 0.5f);
            if (continuous)
            {
                float rate = Mathf.Clamp(count / occupancy, 2f, MaxPersistentRate);
                main.duration = Mathf.Max(0.1f, occupancy);
                main.maxParticles = Mathf.CeilToInt(rate * lifeMax) + 8;
                emission.rateOverTime = rate;
            }
            else if (layer.EmissionWindow > 0.001f)
            {
                main.duration = Mathf.Max(0.05f, layer.EmissionWindow);
                main.maxParticles = count + 8;
                emission.rateOverTime = count / main.duration;
            }
            else
            {
                main.duration = Mathf.Max(0.05f, lifeMax);
                main.maxParticles = count + 8;
                emission.rateOverTime = 0f;
                emission.SetBursts(new[] { new ParticleSystem.Burst(0f, (short)count) });
            }

            var renderer = go.GetComponent<ParticleSystemRenderer>();
            renderer.renderMode = ParticleSystemRenderMode.Billboard;
            renderer.alignment = ParticleSystemRenderSpace.View;
            renderer.allowRoll = false;
            // Particle billboard POSITION/Center streams arrive at the shader in world space. Persist this emitter's
            // world origin in Custom1 (unlike a material property, it remains per-system even when materials are shared),
            // and author the shared law vectors in the same world-space basis.
            SetWorldOrigin(ps, go.transform.position);

            renderer.sharedMaterial = MaterialFor(go.transform, layer, interactive, trailAgeOffset, trailFade);
            renderer.SetActiveVertexStreams(new List<ParticleSystemVertexStream> {
                ParticleSystemVertexStream.Position,
                ParticleSystemVertexStream.Color,
                ParticleSystemVertexStream.UV,
                ParticleSystemVertexStream.AgePercent,
                ParticleSystemVertexStream.InvStartLifetime,
                ParticleSystemVertexStream.StableRandomXYZW,
                // Keep the full-width Custom1 stream before Center so Unity cannot pack origin.x into Center.w.
                ParticleSystemVertexStream.Custom1XYZW,
                ParticleSystemVertexStream.Center,
            });
            return ps;
        }

        static bool IsP6(ParticleSystemRenderer renderer, List<ParticleSystemVertexStream> streams)
        {
            var material = renderer.sharedMaterial;
            var shader = material != null ? material.shader : null;
            if (shader != null && shader.name.StartsWith("OpenSlope/P6Particle", StringComparison.Ordinal)) return true;

            streams.Clear();
            renderer.GetActiveVertexStreams(streams);
            return streams.Contains(ParticleSystemVertexStream.Custom1XYZW)
                && streams.Contains(ParticleSystemVertexStream.Center);
        }

        static void SetWorldOrigin(ParticleSystem ps, Vector3 worldOrigin)
        {
            var customData = ps.customData;
            customData.enabled = true;
            customData.SetMode(ParticleSystemCustomData.Custom1, ParticleSystemCustomDataMode.Vector);
            customData.SetVectorComponentCount(ParticleSystemCustomData.Custom1, 4);
            customData.SetVector(ParticleSystemCustomData.Custom1, 0, new ParticleSystem.MinMaxCurve(worldOrigin.x));
            customData.SetVector(ParticleSystemCustomData.Custom1, 1, new ParticleSystem.MinMaxCurve(worldOrigin.y));
            customData.SetVector(ParticleSystemCustomData.Custom1, 2, new ParticleSystem.MinMaxCurve(worldOrigin.z));
            customData.SetVector(ParticleSystemCustomData.Custom1, 3, new ParticleSystem.MinMaxCurve(1f));
        }

        Material MaterialFor(Transform emitterTransform, BundleManifestReader.EmitterLayer layer, bool interactive,
            float trailAgeOffset, float trailFade)
        {
            string signature = LawSignature(layer, trailAgeOffset) + "|" + interactive + "|" + trailFade.ToString("R", CultureInfo.InvariantCulture);
            if (_materials.TryGetValue(signature, out var found)) return found;

            bool alphaBlend = layer.BlendMode == 3 || layer.BlendMode == 4;
            Shader shader = alphaBlend ? _alpha : _additive;
            if (shader == null)
            {
                if (!_warnedShader)
                {
                    Debug.LogError("OpenSlope: P6 particle shader missing. Sync the platform shader folder before importing the level.");
                    _warnedShader = true;
                }
                _materials[signature] = null;
                return null;
            }

            string sprite = SpriteFile(layer.SpriteIndex);
            string suffix = alphaBlend ? "alpha" : "add";
            string matName = "p6_" + Path.GetFileNameWithoutExtension(sprite) + "_" + suffix + "_" + StableHash(signature).ToString("x8");
            string path = _cfg.MatFolder + "/" + matName + ".mat";
            var material = AssetDatabase.LoadAssetAtPath<Material>(path);
            bool create = material == null;
            if (create) material = new Material(shader) { name = matName };
            else if (material.shader != shader) material.shader = shader;
            var texture = LoadParticleTexture(sprite);
            if (texture != null) material.mainTexture = texture;
            else Debug.LogWarning("OpenSlope: P6 particle sprite not found " + sprite + " under the level or shared map folder" +
                " - run `snowknife particles` (or `snowknife shared`) to decode PARTICLE.SSH.");

            material.SetFloat("_P6TimeScale", Mathf.Abs(layer.TimeScale) < 1e-6f ? 1f : layer.TimeScale);
            material.SetVector("_P6SpawnAxisA", emitterTransform.TransformVector(layer.SpawnAxisA));
            material.SetVector("_P6SpawnAxisB", emitterTransform.TransformVector(layer.SpawnAxisB));
            material.SetVector("_P6VelocityBase", emitterTransform.TransformVector(layer.VelocityBase));
            material.SetVector("_P6VelocityAxisA", emitterTransform.TransformVector(layer.VelocityAxisA));
            material.SetVector("_P6VelocityAxisB", emitterTransform.TransformVector(layer.VelocityAxisB));
            material.SetVector("_P6VelocityAxisC", emitterTransform.TransformVector(layer.VelocityAxisC));
            material.SetVector("_P6Gravity", emitterTransform.TransformVector(layer.Gravity));
            material.SetFloat("_P6TrailAgeOffset", trailAgeOffset);
            material.SetFloat("_P6TrailFade", trailFade);
            SetColors(material, layer, interactive);

            if (create) AssetDatabase.CreateAsset(material, path);
            else EditorUtility.SetDirty(material);
            _materials[signature] = material;
            return material;
        }

        // Per [Trailmap: 180-particles-data], extracted levels source sprites from PARTICLE.SSH; a Slopesmith-authored level has no disc bank
        // of its own. `snowknife unity` already stages the decoded bank once under the sibling Maps/Shared folder, so
        // prefer a level-local override and then share that canonical sprite set. Without the fallback Unity renders
        // the shader's default white texture: correctly coloured, moving square quads.
        Texture2D LoadParticleTexture(string sprite)
        {
            string level = _cfg.LevelFolder.Replace('\\', '/').TrimEnd('/');
            string path = level + "/Textures/Particles/" + sprite;
            var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(path);
            if (texture != null) return texture;

            int slash = level.LastIndexOf('/');
            if (slash < 0) return null;
            path = level.Substring(0, slash) + "/Shared/Textures/Particles/" + sprite;
            return AssetDatabase.LoadAssetAtPath<Texture2D>(path);
        }

        static void SetColors(Material material, BundleManifestReader.EmitterLayer layer, bool interactive)
        {
            Color[] stops = layer.ColorStops;
            for (int i = 0; i < 4; i++)
            {
                Color color = stops != null && i < stops.Length ? stops[i] : Color.white;
                if (layer.Darkens) color = new Color(0f, 0f, 0f, color.a);
                if (interactive) color.a = Mathf.Max(InteractiveAlphaFloor, color.a);
                material.SetColor("_P6Color" + i, color);
            }
        }

        static string SpriteFile(int index)
        {
            index = Mathf.Clamp(index, 0, SpriteNames.Length - 1);
            return SpriteNames[index] + ".png";
        }

        static Bounds BoundsFor(BundleManifestReader.EmitterLayer layer, float maxLife, float maxSize)
        {
            Bounds bounds = new Bounds(Vector3.zero, Vector3.zero);
            bool started = false;
            for (int spawnMask = 0; spawnMask < 4; spawnMask++)
            {
                Vector3 spawn = layer.SpawnAxisA * ((spawnMask & 1) == 0 ? -0.5f : 0.5f)
                    + layer.SpawnAxisB * ((spawnMask & 2) == 0 ? -0.5f : 0.5f);
                for (int velocityMask = 0; velocityMask < 8; velocityMask++)
                {
                    Vector3 velocity = layer.VelocityBase
                        + layer.VelocityAxisA * ((velocityMask & 1) == 0 ? -0.5f : 0.5f)
                        + layer.VelocityAxisB * ((velocityMask & 2) == 0 ? -0.5f : 0.5f)
                        + layer.VelocityAxisC * ((velocityMask & 4) == 0 ? -0.5f : 0.5f);
                    for (int step = 0; step <= 32; step++)
                    {
                        Vector3 point = spawn + Trajectory(layer, velocity, maxLife * step / 32f);
                        if (!started) { bounds = new Bounds(point, Vector3.zero); started = true; }
                        else bounds.Encapsulate(point);
                    }
                }
            }
            bounds.Expand(Mathf.Max(1f, maxSize) * 2f);
            return bounds;
        }

        static float BoundsRadius(Bounds bounds)
        {
            Vector3 min = bounds.min;
            Vector3 max = bounds.max;
            var furthest = new Vector3(
                Mathf.Max(Mathf.Abs(min.x), Mathf.Abs(max.x)),
                Mathf.Max(Mathf.Abs(min.y), Mathf.Abs(max.y)),
                Mathf.Max(Mathf.Abs(min.z), Mathf.Abs(max.z)));
            return Mathf.Max(1f, furthest.magnitude);
        }

        static Vector3 Trajectory(BundleManifestReader.EmitterLayer layer, Vector3 velocity, float ageSeconds)
        {
            float timeScale = Mathf.Abs(layer.TimeScale) < 1e-6f ? 1f : layer.TimeScale;
            float age = Mathf.Max(0f, ageSeconds) * timeScale;
            float curvedAge = Mathf.Min(2.7f, age);
            float curve = -0.73f * curvedAge + 0.113f * curvedAge * curvedAge;
            Vector3 gravity = layer.Gravity / (timeScale * timeScale);
            return gravity * age + (gravity - velocity / timeScale) * curve;
        }

        static string LawSignature(BundleManifestReader.EmitterLayer layer, float trailAgeOffset)
        {
            var b = new StringBuilder(320);
            void F(float v) => b.Append(v.ToString("R", CultureInfo.InvariantCulture)).Append('|');
            void V(Vector3 v) { F(v.x); F(v.y); F(v.z); }
            b.Append(layer.ParticleCount).Append('|').Append(layer.SpriteIndex).Append('|').Append(layer.BlendMode).Append('|');
            F(layer.EmissionWindow); F(layer.TimeScale); F(layer.SizeCenter); F(layer.ParticleLifeCenter);
            F(layer.SizeSpan); F(layer.ParticleLifeSpan); F(trailAgeOffset);
            V(layer.SpawnAxisA); V(layer.SpawnAxisB); V(layer.VelocityBase);
            V(layer.VelocityAxisA); V(layer.VelocityAxisB); V(layer.VelocityAxisC); V(layer.Gravity);
            if (layer.ColorStops != null) foreach (Color color in layer.ColorStops) { F(color.r); F(color.g); F(color.b); F(color.a); }
            return b.ToString();
        }

        static uint StableHash(string text)
        {
            uint hash = 2166136261u;
            for (int i = 0; i < text.Length; i++) { hash ^= text[i]; hash *= 16777619u; }
            return hash;
        }
    }
}
#endif
