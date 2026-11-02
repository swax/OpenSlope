using System.IO.Compression;
using System.Text;
using DiscUtils.Iso9660;
using Newtonsoft.Json.Linq;
using Snowknife.Cli;
using Snowknife.Formats;
using Snowknife.Repack;
using Snowknife.Services;
using SSX_Library;

namespace Snowknife.Tests.Repack;

public class ModManagerPackageTests
{
    private static ModManagerPackage Package(TempDir temp) =>
        new(temp.File("package"), new("Snow Park", "Map Author", "2.1"), "GARI");

    [Fact]
    public void CoursePackageContainsRootMetadataAndDecompressedLevelFiles()
    {
        using var temp = new TempDir();
        byte[] pbd = Encoding.ASCII.GetBytes("PBD fixture " + new string('x', 2048));
        byte[] ssh = "SHPS texture fixture"u8.ToArray();
        File.WriteAllBytes(temp.File("course/data/models/gari.pbd"), pbd);
        File.WriteAllBytes(temp.File("course/data/models/gari.ssh"), ssh);
        string big = temp.File("gari.big");
        BIG.Create(BigType.C0FB, temp.File("course"), big, useCompression: true);

        var package = Package(temp);
        package.AddCourse(big);
        string output = temp.File("mountain.zip");
        package.Write(output);
        using var zip = ZipFile.OpenRead(output);
        using var metadataReader = new StreamReader(zip.GetEntry("ModInfo.json")!.Open());
        var metadata = JObject.Parse(metadataReader.ReadToEnd());
        Assert.Equal(3, (int)metadata["ModPackVersion"]!);
        Assert.Equal(2, (int)metadata["Game"]!);
        Assert.Equal("Snow Park", (string?)metadata["Name"]);
        Assert.Equal("Map Author", (string?)metadata["Author"]);
        Assert.Equal("2.1", (string?)metadata["Version"]);
        Assert.Equal(pbd, ReadEntry(zip, "payload/course/data/models/gari.pbd"));
        Assert.Equal(ssh, ReadEntry(zip, "payload/course/data/models/gari.ssh"));
        Assert.Equal("copy,mod\\payload\\course,game\\", Encoding.UTF8.GetString(ReadEntry(zip, "ModInstructions.txt")));
        Assert.DoesNotContain(zip.Entries, entry => entry.FullName.EndsWith(".iso", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void ManagerInstructionsMergeAudioMembersAndCopyConfigWithoutAffectingOtherMembers()
    {
        using var temp = new TempDir();
        var source = new BigfArchive();
        source.Members.Add(new() { Path = @"data\audio\gari.bnk", Data = "old bank"u8.ToArray() });
        source.Members.Add(new() { Path = @"data\audio\other.bnk", Data = "another enabled mod"u8.ToArray() });
        string archive = temp.File("game/data/audio/audio.big");
        File.WriteAllBytes(archive, source.Write());
        string config = temp.Write("game/data/config/musicmap.inf", "old playlist");
        string authoredConfig = temp.Write("new-musicmap.inf", "new playlist");
        var package = Package(temp);
        package.AddArchiveMembers(@"DATA\AUDIO\AUDIO.BIG", new Dictionary<string, byte[]>
        {
            [@"DATA\AUDIO\GARI.BNK"] = "authored bank"u8.ToArray(),
        });
        package.AddFile(@"DATA\CONFIG\MUSICMAP.INF", authoredConfig);
        string output = temp.File("mountain.zip");
        package.Write(output);
        string mod = temp.File("extracted");
        ZipFile.ExtractToDirectory(output, mod);
        string instructions = File.ReadAllText(Path.Combine(mod, "ModInstructions.txt"));

        // Exercise the manager's published instruction contract independently of the package writer:
        // lower-case three-field lines, directory big insert, and file copy. A trailing newline produces
        // an invalid instruction in its LoadText parser, so Split deliberately keeps empty entries here.
        foreach (string line in instructions.Replace("\r", "", StringComparison.Ordinal).Split('\n'))
        {
            string[] fields = line.ToLowerInvariant().Split(',');
            Assert.Equal(3, fields.Length);
            string from = Resolve(fields[1]), to = Resolve(fields[2]);
            if (fields[0] == "big insert")
            {
                var type = BIG.GetBigType(to);
                bool backslashes = BIG.GetMembersInfo(to)[0].Path.Contains('\\');
                string tree = temp.File("merge");
                BIG.Extract(to, tree);
                foreach (string file in Directory.GetFiles(from, "*", SearchOption.AllDirectories))
                {
                    string destination = Path.Combine(tree, Path.GetRelativePath(from, file));
                    Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                    File.Copy(file, destination, overwrite: true);
                }
                BIG.Create(type, tree, to, useCompression: false, useBackslashes: backslashes);
            }
            else
            {
                Assert.Equal("copy", fields[0]);
                File.Copy(from, to, overwrite: true);
            }
        }
        Assert.Equal("authored bank"u8.ToArray(), BigfRebuilder.ReadMember(archive, "gari.bnk").Data);
        Assert.Equal("another enabled mod"u8.ToArray(), BigfRebuilder.ReadMember(archive, "other.bnk").Data);
        Assert.Equal("new playlist", File.ReadAllText(config));
        using var zip = ZipFile.OpenRead(output);
        Assert.DoesNotContain(zip.Entries, entry => entry.FullName.EndsWith(".big", StringComparison.OrdinalIgnoreCase));

        string Resolve(string value)
        {
            string[] parts = value.Split('\\');
            string root = parts[0] == "mod" ? mod : temp.File("game");
            return Path.Combine([root, .. parts.Skip(1)]);
        }
    }

    [Theory]
    [InlineData("../escape.bnk")]
    [InlineData("/absolute.bnk")]
    [InlineData("C:\\absolute.bnk")]
    [InlineData("data/../../escape.bnk")]
    [InlineData("data/bad,name.bnk")]
    public void PackageRejectsPathsOutsideItsPayloadOrInstructionGrammar(string member)
    {
        using var temp = new TempDir();
        var package = Package(temp);
        Assert.Throws<InvalidDataException>(() => package.AddArchiveMembers("data/audio/audio.big",
            new Dictionary<string, byte[]> { [member] = [1, 2, 3] }));
    }

    [Fact]
    public void MetadataDefaultsAndExplicitNamesPreserveSpacesAndCase()
    {
        string[] prefix = ["repack", "source.iso", "GARI", "map", "export", "out.zip", "--mod-manager"];
        Assert.Equal(new("MOUNTAIN", "Unknown", "1.0.0"), ModManagerPackage.ParseMetadata(prefix, "MOUNTAIN"));
        Assert.Equal(new("My Mountain", "Jane Doe", "v2"), ModManagerPackage.ParseMetadata(
            [.. prefix, "--mod-name", "My Mountain", "--mod-author=Jane Doe", "--mod-version", "v2"], "MOUNTAIN"));
        Assert.Throws<ArgumentException>(() => ModManagerPackage.ParseMetadata([.. prefix, "--mod-author"], "MOUNTAIN"));
        Assert.Throws<ArgumentException>(() => ModManagerPackage.ParseMetadata([.. prefix, "--mod-name="], "MOUNTAIN"));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void OnlyTheManagersTrickyRegionIsAccepted(bool supported)
    {
        using var temp = new TempDir();
        string executable = supported ? ModManagerPackage.SupportedExecutable : "OTHER.EXE";
        var builder = new CDBuilder { UseJoliet = false };
        builder.AddFile("SYSTEM.CNF", Encoding.ASCII.GetBytes($"BOOT2 = cdrom0:\\{executable};1\r\n"));
        builder.AddFile(executable, new byte[16]);
        string image = temp.File("source.iso");
        builder.Build(image);
        if (supported) ModManagerPackage.RequireCompatibleSource(new IsoService(), image);
        else Assert.Throws<InvalidDataException>(() => ModManagerPackage.RequireCompatibleSource(new IsoService(), image));
    }

    [Theory]
    [InlineData("out.iso", "--mod-manager")]
    [InlineData("out.zip", "--mod-manager", "--patches", "noclip")]
    [InlineData("out.zip", "--mod-manager", "--patches", "hud-text")]
    [InlineData("out.zip", "--mod-manager", "--in-place")]
    [InlineData("out.iso", "--mod-name", "Name")]
    public void IncompatibleOutputOptionsAreRejectedBeforeReadingInputs(string output, params string[] flags)
    {
        var command = Commands.Build().SelectMany(group => group.Commands).Single(c => c.Name == "repack");
        Assert.Equal(1, command.Run(["repack", "missing.iso", "GARI", "missing-map", "missing-export", output, .. flags]));
    }

    private static byte[] ReadEntry(ZipArchive zip, string name)
    {
        using var stream = zip.GetEntry(name)!.Open();
        using var bytes = new MemoryStream();
        stream.CopyTo(bytes);
        return bytes.ToArray();
    }
}
