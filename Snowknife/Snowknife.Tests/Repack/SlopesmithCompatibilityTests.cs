using System.IO.Compression;
using Newtonsoft.Json.Linq;
using Snowknife.Repack;
using SSX_Library.FileHandlers.LevelFiles.Tricky;

namespace Snowknife.Tests.Repack;

public class SlopesmithCompatibilityTests
{
    private static readonly string Hash = new('a', 64);
    private static readonly string Version = $"asset1:ssx-tricky:TRICKY_GARI:{Hash}";
    private static readonly string PropTile = $"p_asset1ssx-trickyTRICKY_GARI{Hash}_0039.png";
    private static readonly string OtherGameTile = $"p_asset1ssx-3SSX3_PEAK1{Hash}_0099.png";
    private static readonly string LongName = $"prop_asset1ssx-trickyTRICKY_GARI{Hash}_15_scr2";

    [Theory]
    [InlineData(0)] // Original folder.
    [InlineData(1)] // Browser's stored ZIP, with a top-level map directory.
    [InlineData(2)] // A recompressed ZIP, with the map at the archive root.
    public void StandardExportsResolveArtAppendPropsAndWriteMapNamesWithoutChangingTheInput(int inputKind)
    {
        using var temp = new TempDir();
        string folder = CreateExport(temp);
        var originals = Directory.GetFiles(folder, "*", SearchOption.AllDirectories)
            .ToDictionary(path => path, File.ReadAllBytes, StringComparer.Ordinal);
        string inputPath = folder;
        byte[]? archiveBytes = null;
        if (inputKind != 0)
        {
            inputPath = temp.File("MAP.snowknife.zip");
            ZipFile.CreateFromDirectory(folder, inputPath,
                inputKind == 1 ? CompressionLevel.NoCompression : CompressionLevel.Optimal,
                includeBaseDirectory: inputKind == 1);
            archiveBytes = File.ReadAllBytes(inputPath);
        }

        string extracted;
        using (var input = MapArchiveInput.Open(inputPath))
        {
            extracted = input.MapDirectory;
            var manifest = SlopesmithExport.Load(extracted);
            Assert.True(SlopesmithExport.TryResolve(manifest, extracted, "terrain.png", "GARI",
                _ => true, out var terrain));
            Assert.Equal(TextureOrigin.EncodedPage, terrain.Origin); // Even the target's versioned bank uses its staged PNG.
            Assert.Equal("terrain-staged.png", terrain.File);
            Assert.Equal("custom/terrain-staged.png", terrain.Key);
            Assert.Equal("terrain pixels"u8.ToArray(), File.ReadAllBytes(Path.Combine(extracted, "Textures", terrain.File)));

            var source = CanonicalMapProps.Load(extracted)!;
            var foreign = CanonicalMapProps.ForeignTileKeys(source, "GARI").Distinct().ToList();
            Assert.Contains(($"custom/{PropTile}", "custom", PropTile), foreign);
            Assert.Contains(($"custom/{OtherGameTile}", "custom", OtherGameTile), foreign);
            Assert.Contains(("custom/p_Custom_GARI_0009.png", "custom", "p_Custom_GARI_0009.png"), foreign);
            Assert.Contains(("MESA/0050.png", "MESA", "0050.png"), foreign);
            Assert.Equal(new[] { 72 }, CanonicalMapProps.NativeTileSlots(source, "GARI"));

            var installed = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [$"custom/{PropTile}"] = "0011.png",
                [$"custom/{OtherGameTile}"] = "0012.png",
                ["custom/p_Custom_GARI_0009.png"] = "0013.png",
                ["MESA/0050.png"] = "0014.png",
            };
            string work = CreateDonor(temp);
            Assert.Equal(1, CanonicalMapProps.Append(work, extracted, source, "GARI", installed));
            var materials = (JArray)Read(work, "Materials.json")["Materials"]!;
            Assert.Equal("0011.png", (string?)materials[1]["TexturePath"]);
            Assert.Equal(new[] { "0012.png", "0013.png" }, materials[1]["TextureFlipbook"]!.Values<string>());
            Assert.Equal(348168, (long?)materials[1]["UnknownInt18"]);
            Assert.Equal("0014.png", (string?)materials[3]["TexturePath"]);
            Assert.Equal("0072.png", (string?)materials[4]["TexturePath"]);
            string firstName = (string)materials[1]["MaterialName"]!;
            string secondName = (string)materials[2]["MaterialName"]!;
            Assert.True(firstName.Length <= 82);
            Assert.EndsWith("_scr2", firstName, StringComparison.Ordinal);
            Assert.NotEqual(firstName, secondName); // Long labels with the same prefix must remain distinct.
            Assert.Equal(LongName, source.Materials[0].Name);
            Assert.Equal(9, (int?)Read(work, "Instances.json")["Instances"]![1]!["PhysicsIndex"]);

            // Exercise the actual fixed-width writer which crashed on the unmodified browser export.
            var map = new MapHandler();
            for (int i = 0; i < materials.Count; i++)
            {
                string name = (string)materials[i]["MaterialName"]!;
                map.Materials.Add(new LinkerItem { Name = name, UID = i, Ref = 1, Hashvalue = MapHandler.GenerateHash(name) });
            }
            string mapPath = temp.File("built.map");
            map.Save(mapPath);
            var loaded = new MapHandler();
            loaded.Load(mapPath);
            Assert.Equal(map.Materials.Select(item => item.Name), loaded.Materials.Select(item => item.Name));
            Assert.Equal(map.Materials.Select(item => item.Hashvalue), loaded.Materials.Select(item => item.Hashvalue));
        }

        if (inputKind != 0)
        {
            Assert.False(Directory.Exists(extracted));
            Assert.Equal(archiveBytes, File.ReadAllBytes(inputPath));
        }
        Assert.All(originals, pair => Assert.Equal(pair.Value, File.ReadAllBytes(pair.Key)));
    }

    [Theory]
    [InlineData("GARI", true)]
    [InlineData("TRICKY_GARI", true)]
    [InlineData("gari", true)]
    [InlineData("versioned", true)]
    [InlineData("individual-body", true)]
    [InlineData("individual-prop", true)]
    [InlineData("MESA", false)]
    [InlineData("other-game", false)]
    [InlineData("bad-version", false)]
    public void PhysicsBodiesAreKeptOnlyForTheTargetTrickyCourse(string identity, bool keepBody)
    {
        using var temp = new TempDir();
        string folder = CreateExport(temp);
        string sourceLevel = identity switch
        {
            "versioned" => Version,
            "individual-body" => $"asset2:ssx-tricky:TRICKY_GARI:body:9:{Hash}",
            "individual-prop" => $"asset2:ssx-tricky:TRICKY_GARI:prop:0:{Hash}",
            "other-game" => $"asset1:ssx-3:TRICKY_GARI:{Hash}",
            "bad-version" => "asset1:ssx-tricky:TRICKY_GARI:invalid",
            _ => identity,
        };
        var effects = Read(folder, "Effects.json");
        effects["extensions"]!["slopesmith"]!["nativeCollisions"]!["prop"]!["physicsSource"]!["level"] = sourceLevel;
        File.WriteAllText(Path.Combine(folder, "Effects.json"), effects.ToString());
        var source = CanonicalMapProps.Load(folder)!;
        string work = CreateDonor(temp);
        Assert.Equal(1, CanonicalMapProps.Append(work, folder, source, "GARI", new Dictionary<string, string>()));
        Assert.Equal(keepBody ? 9 : -1, (int?)Read(work, "Instances.json")["Instances"]![1]!["PhysicsIndex"]);
    }

    [Theory]
    [InlineData("GARI", TextureOrigin.TargetPage, "GARI")]
    [InlineData("TRICKY_GARI", TextureOrigin.TargetPage, "GARI")]
    [InlineData("MESA", TextureOrigin.DonorPage, "MESA")]
    [InlineData("TRICKY_MESA", TextureOrigin.DonorPage, "MESA")]
    [InlineData("Custom", TextureOrigin.EncodedPage, "Custom")]
    [InlineData("versioned", TextureOrigin.EncodedPage, "Custom")]
    [InlineData("SSX3_PEAK1", TextureOrigin.EncodedPage, "Custom")]
    public void TerrainProvenanceKeepsLegacyDiscPagesAndUsesExportedBytesForOtherBanks(
        string identity, object expectedOrigin, string expectedDonor)
    {
        using var temp = new TempDir();
        string folder = CreateExport(temp);
        var document = Read(folder, "Slopesmith.json");
        document["textures"]!["terrain.png"]!["level"] = identity == "versioned" ? Version : identity;
        File.WriteAllText(Path.Combine(folder, "Slopesmith.json"), document.ToString());
        Assert.True(SlopesmithExport.TryResolve(SlopesmithExport.Load(folder), folder, "terrain.png", "GARI",
            name => name == "0039.png", out var plan));
        Assert.Equal((TextureOrigin)expectedOrigin, plan.Origin);
        Assert.Equal(expectedDonor, plan.Donor);
        Assert.Equal("terrain-staged.png", plan.File);
    }

    private static string CreateExport(TempDir temp)
    {
        string path = Path.Combine(temp.Path, "MAP");
        Directory.CreateDirectory(Path.Combine(path, "Meshes"));
        Directory.CreateDirectory(Path.Combine(path, "Textures"));
        Write(path, "Patches.json", """{"Patches":[{"TexturePath":"terrain.png"}]}""");
        Write(path, "Slopesmith.json", new JObject
        {
            ["schema"] = 1,
            ["kind"] = "slopesmith-export",
            ["textures"] = new JObject
            {
                ["terrain.png"] = new JObject
                {
                    ["level"] = Version,
                    ["name"] = "0039.png",
                    ["staged"] = "terrain-staged.png",
                }
            },
        }.ToString());
        Write(path, "Materials.json", new JObject
        {
            ["Materials"] = new JArray(
            new JObject
            {
                ["MaterialName"] = LongName,
                ["TexturePath"] = PropTile,
                ["UnknownInt18"] = 348168,
                ["TextureFlipbook"] = new JArray(OtherGameTile, "p_Custom_GARI_0009.png")
            },
            new JObject { ["MaterialName"] = LongName.Replace("_15_scr2", "_16_scr2", StringComparison.Ordinal), ["TexturePath"] = PropTile },
            new JObject { ["MaterialName"] = "borrowed", ["TexturePath"] = "p_MESA_0050.png" },
            new JObject { ["MaterialName"] = "native", ["TexturePath"] = "p_TRICKY_GARI_0072.png" })
        }.ToString());
        Write(path, "Models.json", """{"Models":[{"ModelName":"Prop_0","ModelObjects":[]}]}""");
        Write(path, "Instances.json", """{"Instances":[{"InstanceName":"Prop_0","ModelID":0,"PhysicsIndex":9,"CollsionModelPaths":[]}]}""");
        Write(path, "Effects.json", new JObject
        {
            ["extensions"] = new JObject
            {
                ["slopesmith"] = new JObject
                {
                    ["bakedGroups"] = new JObject { ["prop"] = new JArray("Prop_0") },
                    ["nativeCollisions"] = new JObject
                    {
                        ["prop"] = new JObject
                        {
                            ["physicsSource"] = new JObject { ["level"] = Version },
                        }
                    },
                }
            }
        }.ToString());
        foreach (string file in new[] { "terrain-staged.png", PropTile, OtherGameTile, "p_Custom_GARI_0009.png" })
            Write(path, "Textures/" + file, "terrain pixels");
        return path;
    }

    private static string CreateDonor(TempDir temp)
    {
        string path = Path.Combine(temp.Path, "work");
        Directory.CreateDirectory(path);
        Write(path, "Materials.json", """{"Materials":[{"MaterialName":"donor","TexturePath":"0000.png"}]}""");
        Write(path, "Models.json", """{"Models":[]}""");
        Write(path, "Instances.json", """{"Instances":[{"ModelID":0,"PhysicsIndex":-1,"EffectSlotIndex":-1,"LTGState":0,"Visable":true}]}""");
        return path;
    }

    private static JObject Read(string path, string file) => JObject.Parse(File.ReadAllText(Path.Combine(path, file)));
    private static void Write(string path, string file, string value) => File.WriteAllText(Path.Combine(path, file), value);
}
