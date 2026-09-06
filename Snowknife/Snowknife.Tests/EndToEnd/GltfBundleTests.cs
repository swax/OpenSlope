using System.Buffers.Binary;
using Newtonsoft.Json.Linq;
using Snowknife.Services;

namespace Snowknife.Tests.EndToEnd;

/// <summary>
/// The engine-neutral bundle, checked as an artefact rather than through its build log.
///
/// The Unity importer REQUIRES this bundle and has no client-side recompute fallback, so anything the
/// manifest gets wrong is a level that loads wrong with no error. Two of the checks here — that the bundle
/// declares version 3, and that it emits the start-marker locator the importer spawns at — are behavioural
/// rather than the source-text greps <see cref="CrossRepoContractTests"/> makes.
/// </summary>
[Trait("Category", "EndToEnd")]
[Collection(LevelPipelineCollection.Name)]
public class GltfBundleTests
{
    readonly LevelPipelineFixture _level;

    public GltfBundleTests(LevelPipelineFixture level) => _level = level;

    JObject Manifest() => JObject.Parse(File.ReadAllText(Path.Combine(_level.BundleDir, "manifest.json")));

    [E2ETheory]
    [InlineData("terrain.glb")]
    [InlineData("props.glb")]
    [InlineData("collision.glb")]
    [InlineData("LightmapAtlas.png")]
    [InlineData("manifest.json")]
    public void TheBundleShipsItsDocumentedFiles(string name)
    {
        var file = new FileInfo(Path.Combine(_level.BundleDir, name));

        Assert.True(file.Exists, $"{name} is missing from the bundle");
        Assert.True(file.Length > 0, $"{name} is empty");
    }

    [E2ETheory]
    [InlineData("terrain.glb")]
    [InlineData("props.glb")]
    [InlineData("collision.glb")]
    public void EveryMeshIsAValidGlbContainer(string name)
    {
        // Blender opens these directly, so the container header has to be right even when the scene inside
        // is unusual. Header: magic "glTF", u32 version, u32 total length.
        byte[] head = new byte[12];
        using (var stream = File.OpenRead(Path.Combine(_level.BundleDir, name)))
            stream.ReadExactly(head);

        Assert.Equal("glTF", System.Text.Encoding.ASCII.GetString(head, 0, 4));
        Assert.Equal(2u, BinaryPrimitives.ReadUInt32LittleEndian(head.AsSpan(4)));
        Assert.Equal(new FileInfo(Path.Combine(_level.BundleDir, name)).Length,
            BinaryPrimitives.ReadUInt32LittleEndian(head.AsSpan(8)));
    }

    [E2EFact]
    public void TheManifestSatisfiesTheBundleSchema()
    {
        new ContractValidationService()
            .RequireFile(Path.Combine(_level.BundleDir, "manifest.json"), ContractKind.BundleManifestV3);
    }

    [E2EFact]
    public void TheManifestDeclaresVersionThreeAndItsLevel()
    {
        var manifest = Manifest();

        Assert.Equal(3, (int)manifest["BundleVersion"]!);
        Assert.Equal(E2E.Slot.ToLowerInvariant(), (string?)manifest["Level"]);
    }

    [E2EFact]
    public void TheSpaceConventionIsTheOneTheImporterAssumes()
    {
        // The importer's level root maps manifest points into world by applying exactly this. A changed
        // convention mirrors or rotates every system against the terrain it sits on.
        var space = Manifest()["Space"]!;

        Assert.True((double)space["Scale"]! > 0, "a non-positive scale would collapse the level");
        Assert.Equal("Y", (string?)space["Up"]);
        Assert.Equal("right", (string?)space["Handed"]);
    }

    [E2EFact]
    public void EveryMeshTheManifestNamesIsInTheBundle()
    {
        var meshes = Manifest()["Meshes"]!;

        Assert.NotEmpty(meshes);
        foreach (var mesh in meshes)
            Assert.True(File.Exists(Path.Combine(_level.BundleDir, (string)mesh["File"]!)),
                $"the manifest names {mesh["File"]}, which is not in the bundle");
    }

    [E2EFact]
    public void EveryTextureResolvesFromTheLevelsOwnTexturesFolder()
    {
        // The bundle deliberately copies no textures - materials reference PNGs by NAME and every consumer
        // resolves them from Textures/ one folder up. A name with no file behind it is an untextured level.
        var textures = Manifest()["Textures"]!;
        string folder = Path.Combine(_level.LevelDir, "Textures");

        Assert.NotEmpty(textures);
        foreach (var texture in textures)
            Assert.True(File.Exists(Path.Combine(folder, (string)texture["File"]!)),
                $"the manifest references {texture["File"]}, which is not in Textures/");
    }

    [E2EFact]
    public void TheStartMarkerLocatorIsEmitted()
    {
        // The importer spawns at whichever locator carries this key; without it the spawn falls back to a
        // course-top endpoint scan, which is 447 m out on a lap course ([Trailmap: 120-objects]). The key is
        // matched exactly, the way LevelImporter.StartMarkerKey matches it.
        var locators = Manifest()["Props"]!["Locators"]!;

        var start = Assert.Single(locators, l => (string?)l["Key"] == "Mdl_StageArea_Start");
        Assert.Equal(3, start["Center"]!.Count());
    }

    [E2EFact]
    public void TheCollisionAndPathSectionsAreActuallyPopulated()
    {
        // A schema-valid manifest with empty systems is the failure mode a shape check cannot see: the level
        // loads, and the rider falls through it.
        var manifest = Manifest();

        Assert.NotEmpty(manifest["Collision"]!["Buckets"]!);
        Assert.NotEmpty(manifest["Materials"]!);
        Assert.NotEmpty(manifest["Props"]!["Diverted"]!);
    }

    [E2EFact]
    public void EveryPlacedNativeLoopCarriesAnExplicitClipPath()
    {
        // Unity deliberately has no retail event table. The bundle boundary must finish the map-local
        // SoundIndex join so its audio builder can consume a path without reinterpreting an event id.
        var loops = (JArray?)Manifest()["Audio"]?["PlacedLoops"];

        Assert.NotNull(loops);
        Assert.NotEmpty(loops!);
        foreach (JToken loop in loops!)
        {
            string? clip = (string?)loop["SoundClip"];
            Assert.False(string.IsNullOrWhiteSpace(clip), $"placed loop {loop["Name"]} has no explicit clip");
            Assert.StartsWith("Audio/SFX/", clip, StringComparison.Ordinal);
        }
    }

    [E2EFact]
    public void NoEmittedNumberIsNaNOrInfinite()
    {
        // Every point in here is consumed as a float by two engines. One NaN from a degenerate patch or a
        // zero-length normal propagates into a mesh that renders as nothing at all.
        var bad = Manifest().Descendants()
            .OfType<JValue>()
            .Where(v => v.Type == JTokenType.Float)
            .Select(v => (double)v.Value!)
            .Where(d => double.IsNaN(d) || double.IsInfinity(d))
            .Take(5)
            .ToArray();

        Assert.True(bad.Length == 0, $"the manifest carries non-finite numbers: {string.Join(", ", bad)}");
    }

    [E2EFact]
    public void RebuildingTheBundleProducesTheSameManifest()
    {
        // gltf owns its output directory and rebuilds it from scratch, so a second run over an unchanged
        // extract has to land on the same bundle. Anything order-dependent in the bundlers shows up here.
        string first = File.ReadAllText(Path.Combine(_level.BundleDir, "manifest.json"));

        var (exitCode, _) = E2E.Gltf(_level.LevelDir);

        Assert.Equal(0, exitCode);
        Assert.Equal(first, File.ReadAllText(Path.Combine(_level.BundleDir, "manifest.json")));
    }
}
