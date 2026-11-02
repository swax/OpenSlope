using System.IO.Compression;
using System.Security.Cryptography;
using Snowknife.Cli;
using Snowknife.Repack;

namespace Snowknife.Tests.Repack;

public class MapArchiveInputTests
{
    [Theory]
    [InlineData("", CompressionLevel.NoCompression)]
    [InlineData("MOUNTAIN/", CompressionLevel.NoCompression)]
    [InlineData("", CompressionLevel.Optimal)]
    [InlineData("MOUNTAIN/", CompressionLevel.Optimal)]
    public void StoredAndDeflatedSnapshotsOpenAndCleanUpWithoutChangingTheArchive(string prefix, CompressionLevel compression)
    {
        using var temp = new TempDir();
        string source = temp.File("MOUNTAIN.snowknife.zip");
        using (var zip = ZipFile.Open(source, ZipArchiveMode.Create))
        {
            Add(zip, prefix + "Patches.json", "{\"Patches\":[]}", compression);
            Add(zip, prefix + "Textures/tile.png", "texture bytes", compression);
        }
        byte[] original = SHA256.HashData(File.ReadAllBytes(source));
        string extracted;
        using (var input = MapArchiveInput.Open(source))
        {
            extracted = input.MapDirectory;
            Assert.Equal("{\"Patches\":[]}", File.ReadAllText(Path.Combine(extracted, "Patches.json")));
            Assert.Equal("texture bytes", File.ReadAllText(Path.Combine(extracted, "Textures", "tile.png")));
        }
        Assert.False(Directory.Exists(extracted));
        Assert.Equal(original, SHA256.HashData(File.ReadAllBytes(source)));
        Assert.Equal("MOUNTAIN", MapArchiveInput.DisplayName(source));
    }

    [Fact]
    public void DirectoryInputsRemainInPlaceAfterDisposal()
    {
        using var temp = new TempDir();
        temp.Write("Patches.json", "{\"Patches\":[]}");
        using (var input = MapArchiveInput.Open(temp.Path)) Assert.Equal(temp.Path, input.MapDirectory);
        Assert.True(File.Exists(Path.Combine(temp.Path, "Patches.json")));
    }

    [Theory]
    [InlineData("../escape.txt")]
    [InlineData("MOUNTAIN/../../escape.txt")]
    [InlineData("MOUNTAIN\\..\\..\\escape.txt")]
    [InlineData("/absolute.txt")]
    [InlineData("C:/absolute.txt")]
    [InlineData("MOUNTAIN/patches.JSON")]
    public void UnsafeOrCaseAmbiguousNamesAreRejectedBeforeExtraction(string name)
    {
        using var temp = new TempDir();
        string source = temp.File("unsafe.snowknife.zip");
        using (var zip = ZipFile.Open(source, ZipArchiveMode.Create))
        {
            Add(zip, "MOUNTAIN/Patches.json", "{\"Patches\":[]}");
            Add(zip, name, "untrusted");
        }
        Assert.Throws<InvalidDataException>(() => MapArchiveInput.Open(source));
    }

    [Fact]
    public void SymbolicLinksCannotEnterTheBuildTree()
    {
        using var temp = new TempDir();
        string source = temp.File("symlink.snowknife.zip");
        using (var zip = ZipFile.Open(source, ZipArchiveMode.Create))
        {
            Add(zip, "Patches.json", "{\"Patches\":[]}");
            var link = zip.CreateEntry("Textures");
            link.ExternalAttributes = unchecked((int)0xA1FF0000);
        }
        Assert.Throws<InvalidDataException>(() => MapArchiveInput.Open(source));
    }

    [Theory]
    [InlineData("manifest.json")]
    [InlineData("outer/inner/Patches.json")]
    public void AnArchiveMustIdentifyOneMapRoot(string entry)
    {
        using var temp = new TempDir();
        string source = temp.File("missing.snowknife.zip");
        using (var zip = ZipFile.Open(source, ZipArchiveMode.Create)) Add(zip, entry, "{}");
        Assert.Throws<InvalidDataException>(() => MapArchiveInput.Open(source));
    }

    [Fact]
    public void MultipleMapRootsAreRejected()
    {
        using var temp = new TempDir();
        string source = temp.File("ambiguous.snowknife.zip");
        using (var zip = ZipFile.Open(source, ZipArchiveMode.Create))
        {
            Add(zip, "FIRST/Patches.json", "{}");
            Add(zip, "SECOND/Patches.json", "{}");
        }
        Assert.Throws<InvalidDataException>(() => MapArchiveInput.Open(source));
    }

    [Fact]
    public void EditableMountainArchivesExplainWhichExportToChoose()
    {
        var error = Assert.Throws<InvalidDataException>(() => MapArchiveInput.Open("MOUNTAIN.slopesmith.zip"));
        Assert.Contains("Export for Snowknife", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TexturePlanReadsTheArchiveDirectly()
    {
        using var temp = new TempDir();
        string source = temp.File("MOUNTAIN.snowknife.zip");
        using (var zip = ZipFile.Open(source, ZipArchiveMode.Create)) Add(zip, "MOUNTAIN/Patches.json", "{\"Patches\":[]}");
        Assert.Equal(0, SlopesmithExport.TexturePlanCommand(["texture-plan", source, "GARI"]));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void RepackCannotOverwriteItsInputArchive(bool modManager)
    {
        var command = Commands.Build().SelectMany(group => group.Commands).Single(c => c.Name == "repack");
        string[] flags = modManager ? ["--mod-manager"] : [];
        Assert.Equal(1, command.Run(["repack", "missing.iso", "GARI", "missing-map", "map.snowknife.zip", "map.snowknife.zip", .. flags]));
    }

    [Fact]
    public void RepackManyCannotOverwriteAnInputArchive()
    {
        using var temp = new TempDir();
        string manifest = temp.Write("build.json", """
            {"InputIso":"missing.iso","OutputIso":"map.snowknife.zip",
             "Levels":[{"Slot":"GARI","LevelData":"map","Export":"map.snowknife.zip"}]}
            """);
        var command = Commands.Build().SelectMany(group => group.Commands).Single(c => c.Name == "repack-many");
        var error = Assert.Throws<InvalidDataException>(() => command.Run(["repack-many", manifest]));
        Assert.Contains("must differ", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TheGeneratedZipBuildSettingsPassManifestValidation()
    {
        const string manifest = """
            {"InputIso":"source.iso","OutputIso":"out.iso","TextureType2":true,"BareSlot":true,"SkyColors":false,
             "Levels":[{"Slot":"GARI","LevelData":"Maps/TRICKY_GARI","Export":"MOUNTAIN.snowknife.zip"}]}
            """;
        new Snowknife.Services.ContractValidationService().RequireJson(manifest,
            Snowknife.Services.ContractKind.RepackManifestV1, "Slopesmith ZIP build recipe");
    }

    private static void Add(ZipArchive zip, string name, string value, CompressionLevel compression = CompressionLevel.Optimal)
    {
        using var writer = new StreamWriter(zip.CreateEntry(name, compression).Open());
        writer.Write(value);
    }
}
