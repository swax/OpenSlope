using System.Buffers.Binary;
using Newtonsoft.Json.Linq;
using Snowknife.Services;

namespace Snowknife.Tests.Services;

public class ElfPatchServiceTests
{
    // A patch region's payload is this project's own hook code, with one exception: a trampoline has to
    // re-execute whatever its branch displaced, and those instructions belong to the game. The patch file
    // names where to copy each one from instead of carrying it, and the window reads as `break` until then.
    // Every executable byte below is invented for this test - the point is the substitution, not any build.
    private const uint Break = 0x0000000D;

    private static JObject GraftDoc(int at, long fromFileOffset, int length, uint[] payload) => new()
    {
        ["formatVersion"] = 3,
        ["regions"] = new JArray
        {
            new JObject
            {
                ["fileOffset"] = 0x100,
                ["length"] = payload.Length * sizeof(uint),
                ["originalSha256"] = new string('0', 64),
                ["patched"] = Hex(payload),
                ["graft"] = new JArray
                {
                    new JObject { ["at"] = at, ["fromFileOffset"] = fromFileOffset, ["length"] = length },
                },
            },
        },
    };

    [Fact]
    public void AGraftWindowIsFilledFromTheExecutableBeingPatched()
    {
        // Payload: two words of our own, then a `break` standing in for one displaced instruction.
        var doc = GraftDoc(at: 8, fromFileOffset: 0x40, length: 4, [0x11111111, 0x22222222, Break]);
        var region = Assert.Single(ElfPatchService.ParseRegions(doc, "test"));

        byte[] image = new byte[0x80];
        BinaryPrimitives.WriteUInt32LittleEndian(image.AsSpan(0x40), 0xDEADBEEF);

        byte[] resolved = ElfPatchService.ResolveGrafts(region, (offset, length) =>
            image.AsSpan((int)offset, length).ToArray());

        Assert.Equal(Bytes([0x11111111, 0x22222222, 0xDEADBEEF]), resolved);
        // The published payload is untouched: the graft is resolved into a copy, so the file on disk never
        // gains the word it deliberately does not carry.
        Assert.Equal(Bytes([0x11111111, 0x22222222, Break]), region.Patched);
    }

    [Fact]
    public void AnAppliedRegionIsRecognisedThroughItsGraftWindow()
    {
        var doc = GraftDoc(at: 8, fromFileOffset: 0x40, length: 4, [0x11111111, 0x22222222, Break]);
        var region = Assert.Single(ElfPatchService.ParseRegions(doc, "test"));

        // What apply actually wrote: our two words, plus whatever this executable's displaced word was. The
        // graft window is the one part of the payload the patch file does not fix, so it cannot be compared.
        Assert.True(ElfPatchService.MatchesOutsideGrafts(Bytes([0x11111111, 0x22222222, 0xDEADBEEF]), region));
        Assert.True(ElfPatchService.MatchesOutsideGrafts(Bytes([0x11111111, 0x22222222, 0xCAFEF00D]), region));
        // Everything outside it still has to match exactly.
        Assert.False(ElfPatchService.MatchesOutsideGrafts(Bytes([0x11111111, 0x99999999, 0xDEADBEEF]), region));
    }

    [Fact]
    public void AGraftWindowOutsideItsPayloadIsRefused()
    {
        var doc = GraftDoc(at: 8, fromFileOffset: 0x40, length: 8, [0x11111111, 0x22222222, Break]);
        var error = Assert.Throws<InvalidDataException>(() => ElfPatchService.ParseRegions(doc, "test"));
        Assert.Contains("outside its 12 B payload", error.Message);
    }

    [Fact]
    public void AGraftInAFormatThatDoesNotDefineOneIsRefused()
    {
        var doc = GraftDoc(at: 8, fromFileOffset: 0x40, length: 4, [0x11111111, 0x22222222, Break]);
        doc["formatVersion"] = 2;
        var error = Assert.Throws<InvalidDataException>(() => ElfPatchService.ParseRegions(doc, "test"));
        Assert.Contains("formatVersion 2 does not define", error.Message);
    }

    [Fact]
    public void AnUnknownFormatVersionIsRefusedRatherThanGuessed()
    {
        var doc = GraftDoc(at: 8, fromFileOffset: 0x40, length: 4, [0x11111111, 0x22222222, Break]);
        doc["formatVersion"] = 4;
        var error = Assert.Throws<InvalidDataException>(() => ElfPatchService.ParseRegions(doc, "test"));
        Assert.Contains("is not supported by this build", error.Message);
    }

    // A patch file can come from anywhere, so the reader re-checks every invariant the authoring
    // scanner enforces. Each case below is a manifest that is malformed in exactly one way.

    [Fact]
    public void AnUnalignedGraftWindowIsRefused()
    {
        var doc = GraftDoc(at: 6, fromFileOffset: 0x40, length: 4, [0x11111111, Break, 0x33333333]);
        var error = Assert.Throws<InvalidDataException>(() => ElfPatchService.ParseRegions(doc, "test"));
        Assert.Contains("not instruction-aligned", error.Message);
    }

    [Fact]
    public void ANegativeGraftSourceIsRefused()
    {
        var doc = GraftDoc(at: 8, fromFileOffset: -4, length: 4, [0x11111111, 0x22222222, Break]);
        var error = Assert.Throws<InvalidDataException>(() => ElfPatchService.ParseRegions(doc, "test"));
        Assert.Contains("negative file offset", error.Message);
    }

    [Fact]
    public void OverlappingGraftWindowsAreRefused()
    {
        var doc = GraftDoc(at: 4, fromFileOffset: 0x40, length: 8, [0x11111111, Break, Break]);
        ((JArray)doc["regions"]![0]!["graft"]!).Add(
            new JObject { ["at"] = 8, ["fromFileOffset"] = 0x50, ["length"] = 4 });
        var error = Assert.Throws<InvalidDataException>(() => ElfPatchService.ParseRegions(doc, "test"));
        Assert.Contains("overlapping graft windows", error.Message);
    }

    [Fact]
    public void ARegionThatIsEntirelyGraftIsRefused()
    {
        // Nothing left to distinguish applied from pristine, so it would read as already done.
        var doc = GraftDoc(at: 0, fromFileOffset: 0x40, length: 8, [Break, Break]);
        var error = Assert.Throws<InvalidDataException>(() => ElfPatchService.ParseRegions(doc, "test"));
        Assert.Contains("entirely graft windows", error.Message);
    }

    [Fact]
    public void AGraftWindowCarryingARealInstructionIsRefused()
    {
        // The regression the whole format exists to prevent: a displaced instruction written into
        // the window instead of a copy directive. Any non-`break` word stands in for it; this one is
        // as invented as the rest of the file.
        var doc = GraftDoc(at: 8, fromFileOffset: 0x40, length: 4, [0x11111111, 0x22222222, 0x33333333]);
        var error = Assert.Throws<InvalidDataException>(() => ElfPatchService.ParseRegions(doc, "test"));
        Assert.Contains("is not `break`", error.Message);
    }

    [Fact]
    public void ABreakOutsideEveryGraftWindowIsRefused()
    {
        var doc = GraftDoc(at: 8, fromFileOffset: 0x40, length: 4, [0x11111111, Break, Break]);
        var error = Assert.Throws<InvalidDataException>(() => ElfPatchService.ParseRegions(doc, "test"));
        Assert.Contains("which no graft window covers", error.Message);
    }

    private static byte[] Bytes(uint[] words)
    {
        byte[] result = new byte[words.Length * sizeof(uint)];
        for (int i = 0; i < words.Length; i++)
            BinaryPrimitives.WriteUInt32LittleEndian(result.AsSpan(i * sizeof(uint)), words[i]);
        return result;
    }

    private static string Hex(uint[] words) => Convert.ToHexString(Bytes(words)).ToLowerInvariant();

    [Fact]
    public void WorldConfigSeedIsRecoveredFromConstantStoresWithoutADataFixture()
    {
        const int T0 = 8, T1 = 9, Fp = 30;
        uint[] words =
        [
            Addiu(T0, 0, 0x12),
            Sw(T0, Fp, 0x48),
            Addiu(T1, 0, 0x34),
            Sw(T1, Fp, 0x50),
            Addiu(T0, 0, 0x56),
            Sw(T0, Fp, 0x94 + 0x48),
            Addiu(T1, 0, 0x78),
            Sw(T1, Fp, 0x94 + 0x4c),
            Addiu(T0, 0, 0x9a),
            Sw(T0, Fp, 0x94 + 0x50),
        ];
        byte[] instructions = new byte[words.Length * sizeof(uint)];
        for (int i = 0; i < words.Length; i++)
            BinaryPrimitives.WriteUInt32LittleEndian(instructions.AsSpan(i * sizeof(uint)), words[i]);

        byte[] table = ElfPatchService.ExtractMipsWorldConfigTable(
            instructions, slotCount: 2, recordStride: 0x94, channelOffsets: [0x48, 0x4c, 0x50]);

        Assert.Equal(new byte[] { 0x12, 0x00, 0x34, 0x56, 0x78, 0x9a }, table);
    }

    [Fact]
    public void WorldConfigDecodesTheTwoGlareIntensityFields()
    {
        // Invented values: the decoder's job is the two field offsets, not any build's numbers.
        var frame = new Dictionary<int, uint>
        {
            [0x10] = 0x3e800000, // fan intensity = 0.25f
            [0x24] = 0x3f000000, // corona (sprite) intensity = 0.5f
        };

        var glare = WorldConfig.DecodeGlare(frame, slot: 0, recordStride: 0x94);

        Assert.Equal(0.25f, glare.FanIntensity);
        Assert.Equal(0.5f, glare.SpriteIntensity);
    }

    [Fact]
    public void ALoadInvalidatesAnEarlierConstantBeforeAStore()
    {
        const int T0 = 8, Fp = 30;
        uint[] words = [Addiu(T0, 0, 0x7f), Lw(T0, Fp, 0), Sw(T0, Fp, 0x48)];
        byte[] instructions = new byte[words.Length * sizeof(uint)];
        for (int i = 0; i < words.Length; i++)
            BinaryPrimitives.WriteUInt32LittleEndian(instructions.AsSpan(i * sizeof(uint)), words[i]);

        byte[] table = ElfPatchService.ExtractMipsWorldConfigTable(
            instructions, slotCount: 1, recordStride: 0x94, channelOffsets: [0x48]);

        Assert.Equal(new byte[] { 0 }, table);
    }

    private static uint Addiu(int rt, int rs, int immediate) =>
        9u << 26 | (uint)rs << 21 | (uint)rt << 16 | (ushort)immediate;

    private static uint Lw(int rt, int rs, int immediate) =>
        35u << 26 | (uint)rs << 21 | (uint)rt << 16 | (ushort)immediate;

    private static uint Sw(int rt, int rs, int immediate) =>
        43u << 26 | (uint)rs << 21 | (uint)rt << 16 | (ushort)immediate;
}
