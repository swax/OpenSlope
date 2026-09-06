using Newtonsoft.Json.Linq;
using Snowknife.Export;
using Snowknife.Services;

namespace Snowknife.Tests.EndToEnd;

/// <summary>
/// A real <c>map</c> extract of GARI, checked as an artefact.
///
/// The most valuable assertion here is that fresh extractor output validates against the schemas snowknife
/// embeds. Those schemas are the contract Slopesmith, Blender and the Unity importer implement against, and
/// nothing was proving that the extractor still satisfies them — `validate` does exactly this check, but
/// only when a human runs it on a folder they happen to have.
/// </summary>
[Trait("Category", "EndToEnd")]
[Collection(LevelPipelineCollection.Name)]
public class MapExtractTests
{
    readonly LevelPipelineFixture _level;

    public MapExtractTests(LevelPipelineFixture level) => _level = level;

    string Path_(string relative) => Path.Combine(_level.LevelDir, relative);

    [E2ETheory]
    [InlineData("Instances.json")]
    [InlineData("Patches.json")]
    [InlineData("Materials.json")]
    [InlineData("Models.json")]
    [InlineData("Effects.json")]
    [InlineData("Props.obj")]
    [InlineData("PropsCollision.obj")]
    [InlineData("Skybox.obj")]
    [InlineData("Skybox/Ring.json")]
    public void TheDocumentedOutputsAreWritten(string name)
    {
        var file = new FileInfo(Path_(name));

        Assert.True(file.Exists, $"{name} was not written");
        Assert.True(file.Length > 0, $"{name} is empty");
    }

    [E2ETheory]
    [InlineData("Textures")]
    [InlineData("Lightmaps")]
    [InlineData("Meshes")]
    [InlineData("Audio")]
    public void TheDocumentedOutputDirectoriesHaveContent(string name)
    {
        string dir = Path_(name);

        Assert.True(Directory.Exists(dir), $"{name}/ was not written");
        Assert.NotEmpty(Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories));
    }

    [E2EFact]
    public void TheExtractIsNotTrivial()
    {
        // A course that extracted structurally but produced nothing would pass every file-exists check above.
        var instances = JObject.Parse(File.ReadAllText(Path_("Instances.json")))["Instances"]!;
        var patches = JObject.Parse(File.ReadAllText(Path_("Patches.json")))["Patches"]!;

        Assert.True(instances.Count() > 100, $"only {instances.Count()} instances extracted");
        Assert.True(patches.Count() > 100, $"only {patches.Count()} terrain patches extracted");
        Assert.True(Directory.GetFiles(Path_("Textures"), "*.png").Length > 50, "suspiciously few textures");
        Assert.NotEmpty(Directory.GetFiles(Path_("Lightmaps"), "*.png"));
    }

    [E2EFact]
    public void FreshExtractorOutputSatisfiesTheEmbeddedSchemas()
    {
        // The extractor and the portable contracts are versioned separately; this is what stops them drifting.
        var contracts = new ContractValidationService();

        contracts.RequireFile(Path_("Patches.json"), ContractKind.PatchesV1);
        contracts.RequireFile(Path_("Effects.json"), ContractKind.EffectsV1);
        contracts.RequireIfPresent(Path_("Splines.json"), ContractKind.SplinesV1);
        contracts.RequireFile(Path_(Path.Combine("Audio", SoundIndexDocument.FileName)), ContractKind.SoundIndexV1);
        contracts.RequireFile(Path_(Path.Combine("Audio", EnvironmentAudioDocument.FileName)), ContractKind.EnvironmentAudioV1);
        contracts.RequireFile(Path_(Path.Combine("Skybox", SkyRingDocument.FileName)), ContractKind.SkyRingV1);
    }

    [E2EFact]
    public void EveryMaterialsTexturePathResolvesToAFileThatWasWritten()
    {
        // Materials reference textures by name and every consumer resolves them from the level's own
        // Textures/. A name with no file behind it is a missing texture in Blender and in Unity.
        var materials = JObject.Parse(File.ReadAllText(Path_("Materials.json")));
        var names = materials.Descendants()
            .OfType<JProperty>()
            .Where(p => p.Name.Contains("TexturePath", StringComparison.OrdinalIgnoreCase))
            .Select(p => (string?)p.Value)
            .Where(v => !string.IsNullOrWhiteSpace(v))
            .Select(v => Path.GetFileName(v!))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();

        Assert.NotEmpty(names);
        foreach (string name in names)
            Assert.True(File.Exists(Path.Combine(Path_("Textures"), name)),
                $"Materials.json references {name}, which is not in Textures/");
    }

    [E2EFact]
    public void TheEffectsDocumentIsSelfConsistent()
    {
        // Stable IDs are the whole point of the document: every reference has to name a row that exists, or
        // the bundlers silently resolve it to -1 and the effect quietly stops happening.
        var doc = JObject.Parse(File.ReadAllText(Path_("Effects.json")));
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (string table in new[]
                 {
                     "graphs", "functions", "instances", "splines",
                     "slots", "physics", "objectProperties", "collisionModels",
                 })
            foreach (var row in doc[table]?.OfType<JObject>() ?? [])
                if ((string?)row["id"] is { Length: > 0 } id)
                    Assert.True(ids.Add(id), $"duplicate stable id '{id}' in {table}");

        var dangling = doc.Descendants()
            .OfType<JProperty>()
            .Where(p => p.Parent?.Parent is JProperty { Name: "references" or "circumstances" })
            .Select(p => (string?)p.Value)
            .Where(v => !string.IsNullOrEmpty(v) && !ids.Contains(v!))
            .Distinct(StringComparer.Ordinal)
            .ToArray();

        Assert.True(dangling.Length == 0,
            $"Effects.json references ids that do not exist: {string.Join(", ", dangling.Take(5))}");
    }
}
