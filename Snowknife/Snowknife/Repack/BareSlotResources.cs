using System.Globalization;
using Newtonsoft.Json.Linq;
using Snowknife.Formats;

namespace Snowknife.Repack;

/// <summary>Release donor resources that no surviving instance or surface can use.</summary>
internal static class BareSlotResources
{
    public static int PruneModels(string work, int donorInstances, int donorModels)
    {
        string path = Path.Combine(work, "Models.json");
        var root = JObject.Parse(File.ReadAllText(path));
        var models = (JArray)root["Models"]!;
        var instances = (JArray)JObject.Parse(File.ReadAllText(Path.Combine(work, "Instances.json")))["Instances"]!;
        var retained = new HashSet<int>();
        for (int i = 0; i < instances.Count; i++)
        {
            var instance = instances[i];
            if (i >= donorInstances || (bool?)instance["Visable"] != false
                || (bool?)instance["PlayerCollision"] == true || (bool?)instance["IncludeSound"] == true)
                retained.Add((int)instance["ModelID"]!);
        }
        int pruned = 0;
        for (int i = 0; i < Math.Min(donorModels, models.Count); i++)
        {
            if (retained.Contains(i) || models[i]?["ModelObjects"] is not JArray { Count: > 0 }) continue;
            // Keep the model row and name/hash identity; only its unreachable payload is emptied.
            models[i]!["ModelObjects"] = new JArray();
            pruned++;
        }
        File.WriteAllText(path, root.ToString(Newtonsoft.Json.Formatting.None));
        return pruned;
    }

    public static (HashSet<int> Textures, HashSet<int> Lightmaps) UsedPages(string work)
    {
        var textures = new HashSet<int> { 0 }; // Unresolved-material fallback.
        var lightmaps = new HashSet<int>();
        var patches = (JArray)JObject.Parse(File.ReadAllText(Path.Combine(work, "Patches.json")))["Patches"]!;
        foreach (var patch in patches)
        {
            KeepTexture((string?)patch["TexturePath"]);
            if ((int?)patch["LightmapID"] is >= 0 and var lightmap) lightmaps.Add(lightmap);
        }
        var models = (JArray)JObject.Parse(File.ReadAllText(Path.Combine(work, "Models.json")))["Models"]!;
        var materials = (JArray)JObject.Parse(File.ReadAllText(Path.Combine(work, "Materials.json")))["Materials"]!;
        var usedMaterials = models.OfType<JObject>()
            .SelectMany(model => (model["ModelObjects"] as JArray ?? new JArray()).OfType<JObject>())
            .SelectMany(obj => (obj["MeshData"] as JArray ?? new JArray()).OfType<JObject>())
            .Select(mesh => (int)mesh["MaterialID"]!).Distinct();
        foreach (int id in usedMaterials)
        {
            if (id < 0 || id >= materials.Count) throw new InvalidDataException("Retained model has an invalid material index.");
            KeepTexture((string?)materials[id]["TexturePath"]);
            foreach (var frame in materials[id]["TextureFlipbook"] as JArray ?? new JArray())
                KeepTexture((string?)frame);
        }
        return (textures, lightmaps);

        void KeepTexture(string? name)
        {
            if (string.IsNullOrEmpty(name)) return;
            if (!name.EndsWith(".png", StringComparison.OrdinalIgnoreCase)
                || !int.TryParse(name.AsSpan(0, name.Length - 4), NumberStyles.None, CultureInfo.InvariantCulture, out int slot))
                throw new InvalidDataException($"Cannot prune a bank with unresolved texture reference '{name}'.");
            textures.Add(slot);
        }
    }

    public static byte[] TrimBank(byte[] source, IReadOnlySet<int> retained, byte[] placeholder)
    {
        var bank = SshBank.Load(source);
        if (retained.Any(slot => slot < 0 || slot >= bank.Count))
            throw new InvalidDataException("Retained texture index lies outside its bank.");
        var replacements = new Dictionary<int, byte[]>();
        for (int i = 0; i < bank.Count; i++)
            if (!retained.Contains(i) && bank.Extent(i).len > placeholder.Length)
                replacements.Add(i, placeholder);
        return SshBank.ReplacePages(source, replacements);
    }
}
