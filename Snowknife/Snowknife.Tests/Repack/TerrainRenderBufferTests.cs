using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;
using DiscUtils.Iso9660;
using Newtonsoft.Json.Linq;
using Snowknife.Repack;
using Snowknife.Services;

namespace Snowknife.Tests.Repack;

public class TerrainRenderBufferTests
{
    [Theory]
    [InlineData(0, 0)]
    [InlineData(2048, 0)]
    [InlineData(2049, 1)]
    [InlineData(2730, 1)]
    [InlineData(2731, 2)]
    [InlineData(13689, 6)]
    public void CapacityCoversTheWholeCourseAndPreservesSmallMaps(int patches, int pages) =>
        Assert.Equal(pages, TerrainRenderBuffer.RequiredPages(patches));

    [Fact]
    public void ExcessiveOrNegativeCountsFailBeforeAllocation()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => TerrainRenderBuffer.RequiredPages(-1));
        Assert.Throws<InvalidDataException>(() => TerrainRenderBuffer.RequiredPages(int.MaxValue));
    }

    [Fact]
    public void InstalledAllocationMustMatchItsInitializationAndOpcode()
    {
        ElfPatchService.Region[] regions = [Region(0, 5), Region(4, 6)];
        byte[][] valid = regions.Select(region => TerrainRenderBuffer.Instruction(region, 6)).ToArray();
        Assert.Equal(6, TerrainRenderBuffer.InstalledPages(valid, regions));
        Assert.Throws<InvalidDataException>(() => TerrainRenderBuffer.InstalledPages([valid[0], Word(123)], regions));
        Assert.Throws<InvalidDataException>(() => TerrainRenderBuffer.InstalledPages(
            [valid[0], TerrainRenderBuffer.Instruction(regions[1], 7)], regions));
        Assert.Throws<InvalidDataException>(() => TerrainRenderBuffer.InstalledPages([valid[0]], regions));
    }

    [Fact]
    public void IsoAndManagerUseIdenticalInstructionsWithoutShippingTheExecutable()
    {
        using var temp = new TempDir();
        const string target = "SLUS_TEST.00";
        byte[] exe = new byte[256];
        Word(123456).CopyTo(exe, 32);
        Word(654321).CopyTo(exe, 64);
        var doc = new JObject
        {
            ["target"] = target, ["targetSize"] = exe.Length, ["formatVersion"] = 2,
            ["runtimeAddresses"] = new JArray(4096, 4160),
            ["regions"] = new JArray(new[] { (Offset: 32, Register: 5), (Offset: 64, Register: 6) }.Select(site => new JObject
            {
                ["fileOffset"] = site.Offset, ["length"] = 4,
                ["originalSha256"] = Convert.ToHexString(SHA256.HashData(exe.AsSpan(site.Offset, 4))).ToLowerInvariant(),
                ["patched"] = Convert.ToHexString(Region(site.Offset, site.Register).Patched).ToLowerInvariant(),
            })),
        };
        // Use the normal working-directory patch lookup without changing the process-wide working directory.
        string definition = Path.Combine(AppContext.BaseDirectory, "Patches", $"terrain-buffer.{target}.json");
        Directory.CreateDirectory(Path.GetDirectoryName(definition)!);
        File.WriteAllText(definition, doc.ToString());
        try
        {
            var builder = new CDBuilder { UseJoliet = false };
            builder.AddFile("SYSTEM.CNF", System.Text.Encoding.ASCII.GetBytes($"BOOT2 = cdrom0:\\{target};1\r\n"));
            builder.AddFile(target, exe);
            string source = temp.File("source.iso"), image = temp.File("built.iso");
            builder.Build(source);
            File.Copy(source, image);
            var iso = new IsoService();
            var patcher = new ElfPatchService(iso);
            Assert.Equal(0, patcher.EnsureTerrainCapacity(image, 13689, null, dryRun: true));
            Assert.Equal(File.ReadAllBytes(source), File.ReadAllBytes(image));
            Assert.Equal(0, patcher.EnsureTerrainCapacity(image, 13689, null, dryRun: false));
            Assert.Equal(0, patcher.EnsureTerrainCapacity(image, 3000, null, dryRun: false)); // Never shrink a prior slot's pool.
            iso.ExtractFile(image, target, temp.File("patched.elf"));
            byte[] patched = File.ReadAllBytes(temp.File("patched.elf"));
            Assert.Equal(6, BinaryPrimitives.ReadUInt16LittleEndian(patched.AsSpan(32)));
            Assert.Equal(6, BinaryPrimitives.ReadUInt16LittleEndian(patched.AsSpan(64)));
            Assert.True(File.Exists(image + ".snowknife-restore.json"));
            var package = new ModManagerPackage(temp.File("mod"), new("Dense course", "Author", "1"), "GARI");
            Assert.Equal(0, patcher.EnsureTerrainCapacity(source, 13689, package, dryRun: false));
            package.Write(temp.File("mod.zip"));
            using var zip = ZipFile.OpenRead(temp.File("mod.zip"));
            using var reader = new StreamReader(zip.GetEntry("PCSX2Patch.txt")!.Open());
            string text = reader.ReadToEnd();
            Assert.Contains($"patch=0,EE,00001000,word,{BinaryPrimitives.ReadUInt32LittleEndian(patched.AsSpan(32)):X8}", text, StringComparison.Ordinal);
            Assert.Contains($"patch=0,EE,00001040,word,{BinaryPrimitives.ReadUInt32LittleEndian(patched.AsSpan(64)):X8}", text, StringComparison.Ordinal);
            Assert.DoesNotContain(zip.Entries, entry => entry.FullName.EndsWith(".elf", StringComparison.OrdinalIgnoreCase));
            iso.ExtractFile(source, target, temp.File("unchanged.elf"));
            Assert.Equal(exe, File.ReadAllBytes(temp.File("unchanged.elf")));
            // Unknown instructions cannot produce a partially applied ISO or a package.
            File.WriteAllBytes(temp.File("bad.elf"), new byte[256]);
            iso.ReplaceFile(image, target, temp.File("bad.elf"));
            byte[] before = File.ReadAllBytes(image);
            Assert.Throws<InvalidDataException>(() => patcher.EnsureTerrainCapacity(image, 13689, null, false));
            Assert.Equal(before, File.ReadAllBytes(image));
        }
        finally { File.Delete(definition); }
    }

    private static ElfPatchService.Region Region(int offset, int register) =>
        new(offset, 4, "", Word((uint)(60 << 24 | register << 16 | 6)), []);

    private static byte[] Word(uint word)
    {
        byte[] bytes = new byte[4];
        BinaryPrimitives.WriteUInt32LittleEndian(bytes, word);
        return bytes;
    }
}
