using Snowknife.Services;

namespace Snowknife.Tests.Services;

public sealed class PublicUnityStagingTests
{
    [Fact]
    public void PublicStagingCopiesAnAllowedMapIntoAFreshDestinationWithoutShared()
    {
        using var temp = new TempDir();
        string source = AuthoredSource(temp);
        string destination = Path.Combine(temp.Path, "Project", "Assets", "Maps", "MYMAP");

        int result = Service().Unity(["unity", source, destination, "--public"]);

        Assert.Equal(0, result);
        Assert.True(File.Exists(Path.Combine(destination, "Patches.json")));
        Assert.True(File.Exists(Path.Combine(destination, "gltf", "manifest.json")));
        Assert.False(Directory.Exists(Path.Combine(temp.Path, "Project", "Assets", "Maps", "Shared")));
    }

    [Fact]
    public void PublicStagingRefusesANonemptyDestinationBeforeCopying()
    {
        using var temp = new TempDir();
        string source = AuthoredSource(temp);
        string destination = temp.Write("Project/Assets/OpenSlope/Maps/MYMAP/stale-retail.wav", "stale");
        destination = Path.GetDirectoryName(destination)!;

        int result = Service().Unity(["unity", source, destination, "--public"]);

        Assert.Equal(1, result);
        Assert.False(File.Exists(Path.Combine(destination, "Patches.json")));
    }

    [Fact]
    public void PublicStagingRefusesAPopulatedSharedSiblingBeforeCopying()
    {
        using var temp = new TempDir();
        string source = AuthoredSource(temp);
        string destination = temp.File("Project/Assets/OpenSlope/Maps/MYMAP/.keep");
        destination = Path.GetDirectoryName(destination)!;
        File.Delete(Path.Combine(destination, ".keep"));
        temp.Write("Project/Assets/OpenSlope/Maps/Shared/board.wav", "retail");

        int result = Service().Unity(["unity", source, destination, "--public"]);

        Assert.Equal(1, result);
        Assert.False(File.Exists(Path.Combine(destination, "Patches.json")));
    }

    private static string AuthoredSource(TempDir temp)
    {
        string source = Path.Combine(temp.Path, "Source");
        temp.Write("Source/Patches.json", """{ "Patches": [] }""");
        temp.Write("Source/gltf/manifest.json", """
            {
              "BundleVersion": 3,
              "Level": "MYMAP",
              "Provenance": {
                "Source": "slopesmith-authored",
                "PublicDistribution": "allowed",
                "RetailDerived": false,
                "UserSupplied": false,
                "Reasons": []
              },
              "Space": { "Scale": 1.0, "RootEuler": [0, 0, 0], "Up": "Y", "Handed": "left", "Units": "m" },
              "Recenter": { "ToOrigin": false, "AxisMask": [0, 0, 0] },
              "Meshes": []
            }
            """);
        return source;
    }

    private static LevelPipelineService Service()
    {
        var iso = new IsoService();
        var contracts = new ContractValidationService();
        return new LevelPipelineService(iso, new AudioService(iso), new ParticleService(iso),
            new EffectsDocumentService(contracts), contracts, new ElfPatchService(iso));
    }
}
