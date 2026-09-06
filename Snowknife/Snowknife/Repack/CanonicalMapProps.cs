using System.Globalization;
using Newtonsoft.Json.Linq;

namespace Snowknife.Repack;

/// <summary>
/// Appends a canonical map folder's prop tables to the retail donor selected by <c>repack</c>.
/// Geometry, hierarchy, animation, lighting, collision and audio are already expressed through the ordinary
/// Models/Instances/Meshes contract. This adapter performs only target-relative joins: texture-bank slots,
/// compiled effect-slot indexes and compatible physics-body references.
/// </summary>
internal static class CanonicalMapProps
{
    /// <summary>
    /// One canonical material. <c>Frames</c> is the flipbook state list — the same tile refs
    /// <c>TexturePath</c> takes, with frame 0 the resting surface the loader stamps. Every frame needs its
    /// own installed page, because a native flipbook indexes the bank per frame
    /// ([Trailmap: 170-materials, 410-texture-animation]).
    /// </summary>
    internal sealed record Material(string Name, string TexturePath, long Int18, IReadOnlyList<string> Frames);

    internal sealed class Source
    {
        public List<Material> Materials { get; } = new();
        public Dictionary<string, string> PhysicsSourceLevels { get; } = new(StringComparer.Ordinal);
        public bool AnyUntextured { get; set; }
    }

    /// <summary>The SSH-install key for the one flat page used by canonical -1 material slots.</summary>
    public const string UntexturedKey = "custom/__slopesmith_untextured__";

    /// <summary>Read the canonical prop/material contract. Null means this map contributes no prop models.</summary>
    public static Source? Load(string mapDir)
    {
        string materialsPath = Path.Combine(mapDir, "Materials.json");
        string modelsPath = Path.Combine(mapDir, "Models.json");
        string instancesPath = Path.Combine(mapDir, "Instances.json");
        string meshesDir = Path.Combine(mapDir, "Meshes");
        if (!File.Exists(materialsPath) || !File.Exists(modelsPath) || !File.Exists(instancesPath)
            || !Directory.Exists(meshesDir)) return null;

        var source = new Source();
        var materials = JObject.Parse(File.ReadAllText(materialsPath))["Materials"] as JArray ?? new JArray();
        foreach (var material in materials)
            source.Materials.Add(new Material(
                (string?)material["MaterialName"] ?? "",
                (string?)material["TexturePath"] ?? "",
                (long?)material["UnknownInt18"] ?? 0,
                (material["TextureFlipbook"] as JArray ?? new JArray())
                    .Select(frame => (string?)frame ?? "").Where(frame => frame.Length > 0).ToList()));

        var models = JObject.Parse(File.ReadAllText(modelsPath))["Models"] as JArray ?? new JArray();
        source.AnyUntextured = models.OfType<JObject>()
            .SelectMany(model => (model["ModelObjects"] as JArray ?? new JArray()).OfType<JObject>())
            .SelectMany(obj => (obj["MeshData"] as JArray ?? new JArray()).OfType<JObject>())
            .Any(mesh => (int?)mesh["MaterialID"] < 0);

        // PhysicsIndex is native-shaped but only meaningful inside the level that donated the body. Preserve
        // that one target-relative provenance fact from SlopeSmith's authoring extension; all collision shape,
        // response and placement semantics already live on the canonical instance itself.
        string effectsPath = Path.Combine(mapDir, "Effects.json");
        if (File.Exists(effectsPath)) try
        {
            var ext = JObject.Parse(File.ReadAllText(effectsPath))["extensions"]?["slopesmith"] as JObject;
            if (ext?["nativeCollisions"] is JObject native && ext["bakedGroups"] is JObject baked)
                foreach (var property in native.Properties())
                {
                    string? level = (string?)property.Value["physicsSource"]?["level"];
                    if (string.IsNullOrEmpty(level) || baked[property.Name] is not JArray groups) continue;
                    foreach (var token in groups)
                        if ((string?)token is { Length: > 0 } group)
                            source.PhysicsSourceLevels[AuthoredEffects.SanitizeGroupName(group)] = level;
                }
        }
        catch { /* Effects validation reports malformed authoring metadata; canonical props still load. */ }
        return models.Count > 0 ? source : null;
    }

    /// <summary>Every tile ref a material draws through: the resting page and each flipbook frame.</summary>
    private static IEnumerable<string> TileRefs(Material material)
    {
        yield return material.TexturePath;
        foreach (string frame in material.Frames) yield return frame;
    }

    public static IEnumerable<(string Key, string Donor, string Name)> ForeignTileKeys(Source source,
                                                                                       string targetLevel)
    {
        foreach (var texture in source.Materials.SelectMany(TileRefs))
        {
            if (TryParseTile(texture, out string level, out string slot))
            {
                if (!string.Equals(level, targetLevel, StringComparison.OrdinalIgnoreCase))
                    yield return ($"{level}/{slot}.png", level, $"{slot}.png");
            }
            else if (!string.IsNullOrEmpty(texture))
                yield return ($"custom/{texture}", "custom", texture);
        }
    }

    public static IEnumerable<int> NativeTileSlots(Source source, string targetLevel)
    {
        foreach (var texture in source.Materials.SelectMany(TileRefs))
            if (TryParseTile(texture, out string level, out string page)
                && string.Equals(level, targetLevel, StringComparison.OrdinalIgnoreCase)
                && int.TryParse(page, NumberStyles.None, CultureInfo.InvariantCulture, out int slot))
                yield return slot;
    }

    public static int Append(string work, string sourceDir, Source source, string targetLevel,
                             Dictionary<string, string> foreignSlot,
                             Dictionary<string, AuthoredEffects.Wiring>? effects = null)
    {
        var matRoot = JObject.Parse(File.ReadAllText(Path.Combine(work, "Materials.json")));
        var modelRoot = JObject.Parse(File.ReadAllText(Path.Combine(work, "Models.json")));
        var instRoot = JObject.Parse(File.ReadAllText(Path.Combine(work, "Instances.json")));
        var sourceModelRoot = JObject.Parse(File.ReadAllText(Path.Combine(sourceDir, "Models.json")));
        var sourceInstRoot = JObject.Parse(File.ReadAllText(Path.Combine(sourceDir, "Instances.json")));
        if (matRoot["Materials"] is not JArray materials || materials.Count == 0
            || modelRoot["Models"] is not JArray models
            || instRoot["Instances"] is not JArray instances || instances.Count == 0
            || sourceModelRoot["Models"] is not JArray sourceModels
            || sourceInstRoot["Instances"] is not JArray sourceInstances)
        {
            Log.Warn("  WARN: canonical source or donor JSON tables are unusable - placed props not packed.");
            return 0;
        }

        var materialTemplate = (JObject)materials[0]!;
        int materialBase = materials.Count;
        var materialIndex = new int[source.Materials.Count];
        // A tile ref resolves to an installed bank slot the same way whether the material draws it at rest or
        // steps onto it mid-flip, so both go through here; `what` only shapes the warning.
        string InstalledSlot(string texture, string name, string what)
        {
            if (TryParseTile(texture, out string level, out string page))
            {
                if (string.Equals(level, targetLevel, StringComparison.OrdinalIgnoreCase)) return page + ".png";
                if (foreignSlot.TryGetValue($"{level}/{page}.png", out string? installed)) return installed;
                Log.Warn($"  WARN: prop tile {texture} unresolved - material {name} {what} falls back to slot 0000");
            }
            else if (foreignSlot.TryGetValue($"custom/{texture}", out string? custom)) return custom;
            else Log.Warn($"  WARN: prop material {name} has unrecognised {what} '{texture}' - slot 0000");
            return "0000.png";
        }
        int flipbooks = 0;
        for (int i = 0; i < source.Materials.Count; i++)
        {
            var (name, texture, int18, frames) = source.Materials[i];
            var entry = (JObject)materialTemplate.DeepClone();
            entry["MaterialName"] = name.Length > 0 ? name : $"SlopesmithProp_{i}";
            entry["TexturePath"] = InstalledSlot(texture, name, "TexturePath");
            entry["UnknownInt18"] = int18;
            // The state list ships whole: a flip node steps the material's frames, so dropping them leaves an
            // authored TextureFlip with nothing to advance and the surface frozen on its resting page.
            entry["TextureFlipbook"] = new JArray(frames.Select(frame =>
                (object)InstalledSlot(frame, name, "flipbook frame")));
            // The int16 riding beside TextureFlipbookID moves with it. Measured over every shipped level, it
            // is 0 on each of the 63 flipbook-bearing materials and -1 on all 664 static ones, with no
            // exception — so a frame list arriving under the template's -1 is a byte pattern retail never
            // ships, and the animated material reads as a still one.
            entry["UnknownInt20"] = frames.Count > 0 ? 0 : -1;
            if (frames.Count > 0) flipbooks++;
            materials.Add(entry);
            materialIndex[i] = materialBase + i;
        }
        if (flipbooks > 0) Log.Info($"  prop flipbooks: {flipbooks} material(s) ship a frame list");
        int untexturedMaterial = -1;
        if (source.AnyUntextured)
        {
            var entry = (JObject)materialTemplate.DeepClone();
            entry["MaterialName"] = "SlopesmithUntextured";
            entry["TexturePath"] = foreignSlot.TryGetValue(UntexturedKey, out string? grey) ? grey : "0000.png";
            entry["UnknownInt18"] = 86024;
            entry["TextureFlipbook"] = new JArray();
            entry["UnknownInt20"] = -1;
            untexturedMaterial = materials.Count;
            materials.Add(entry);
        }

        string sourceMeshes = Path.Combine(sourceDir, "Meshes");
        string targetMeshes = Path.Combine(work, "Meshes");
        string sourceCollision = Path.Combine(sourceDir, "Collision");
        string targetCollision = Path.Combine(work, "Collision");
        Directory.CreateDirectory(targetMeshes);
        Directory.CreateDirectory(targetCollision);

        int meshSerial = 0;
        var modelMap = new Dictionary<int, int>();
        for (int sourceModelIndex = 0; sourceModelIndex < sourceModels.Count; sourceModelIndex++)
        {
            if (sourceModels[sourceModelIndex] is not JObject sourceModel) continue;
            var model = (JObject)sourceModel.DeepClone();
            foreach (var obj in (model["ModelObjects"] as JArray ?? new JArray()).OfType<JObject>())
                foreach (var mesh in (obj["MeshData"] as JArray ?? new JArray()).OfType<JObject>())
                {
                    string sourceName = (string?)mesh["MeshPath"] ?? "";
                    string sourcePath = Path.Combine(sourceMeshes, sourceName);
                    if (!File.Exists(sourcePath))
                        throw new FileNotFoundException($"Canonical prop mesh not found: {sourcePath}", sourcePath);
                    string targetName = $"ap{sourceModelIndex}_{meshSerial++}.obj";
                    File.Copy(sourcePath, Path.Combine(targetMeshes, targetName), overwrite: true);
                    mesh["MeshPath"] = targetName;
                    int sourceMaterial = (int?)mesh["MaterialID"] ?? -1;
                    mesh["MaterialID"] = sourceMaterial >= 0 && sourceMaterial < materialIndex.Length
                        ? materialIndex[sourceMaterial]
                        : untexturedMaterial >= 0 ? untexturedMaterial : materialBase;
                }
            modelMap[sourceModelIndex] = models.Count;
            models.Add(model);
        }

        var instanceTemplate = instances.OfType<JObject>().FirstOrDefault(row =>
                (int?)row["LTGState"] == 0 && (bool?)row["Visable"] == true
                && (int?)row["EffectSlotIndex"] == -1 && (int?)row["PhysicsIndex"] == -1)
            ?? (JObject)instances[0]!;
        int added = 0, collisionSerial = 0;
        foreach (var sourceToken in sourceInstances)
        {
            if (sourceToken is not JObject sourceInstance) continue;
            int sourceModel = (int?)sourceInstance["ModelID"] ?? -1;
            if (!modelMap.TryGetValue(sourceModel, out int targetModel)) continue;

            var instance = (JObject)instanceTemplate.DeepClone();
            foreach (var property in sourceInstance.Properties()) instance[property.Name] = property.Value.DeepClone();
            instance["ModelID"] = targetModel;
            instance["PrevInstance"] = -1;
            instance["NextInstance"] = -1;

            string name = (string?)instance["InstanceName"] ?? "";
            source.PhysicsSourceLevels.TryGetValue(name, out string? physicsSourceLevel);
            if (effects != null && effects.TryGetValue(name, out var wiring))
            {
                instance["EffectSlotIndex"] = wiring.SlotIndex;
                instance["UVScroll"] = wiring.UvScroll;
            }
            else instance["EffectSlotIndex"] = -1;

            if ((int?)instance["PhysicsIndex"] >= 0 && !string.IsNullOrEmpty(physicsSourceLevel)
                && !string.Equals(physicsSourceLevel, targetLevel, StringComparison.OrdinalIgnoreCase))
            {
                Log.Warn($"  WARN: {name} cannot reuse its {physicsSourceLevel} physics body in {targetLevel}; Roller/mode-3 collision packs without that body");
                instance["PhysicsIndex"] = -1;
            }

            var targetPaths = new JArray();
            foreach (var value in instance["CollsionModelPaths"] as JArray ?? new JArray())
            {
                string sourceName = (string?)value ?? "";
                if (sourceName.Length == 0) continue;
                string sourcePath = Path.Combine(sourceCollision, sourceName);
                if (!File.Exists(sourcePath))
                    throw new FileNotFoundException($"Canonical prop collision mesh not found: {sourcePath}", sourcePath);
                string targetName = $"apc{added}_{collisionSerial++}.obj";
                File.Copy(sourcePath, Path.Combine(targetCollision, targetName), overwrite: true);
                targetPaths.Add(targetName);
            }
            instance["CollsionModelPaths"] = targetPaths;
            instances.Add(instance);
            added++;
        }

        File.WriteAllText(Path.Combine(work, "Materials.json"), matRoot.ToString(Newtonsoft.Json.Formatting.None));
        File.WriteAllText(Path.Combine(work, "Models.json"), modelRoot.ToString(Newtonsoft.Json.Formatting.None));
        File.WriteAllText(Path.Combine(work, "Instances.json"), instRoot.ToString(Newtonsoft.Json.Formatting.None));
        Log.Info($"  canonical props appended: {added} instance(s), {modelMap.Count} model(s), {meshSerial} mesh(es).");
        return added;
    }

    private static bool TryParseTile(string texturePath, out string level, out string page)
    {
        level = ""; page = "";
        var match = System.Text.RegularExpressions.Regex.Match(texturePath ?? "", @"^p_(.+)_(\d{4})\.png$");
        if (!match.Success) return false;
        level = match.Groups[1].Value;
        page = match.Groups[2].Value;
        return true;
    }
}
