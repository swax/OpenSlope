using System.Buffers.Binary;
using Snowknife.Services;

namespace Snowknife.Tests.Services;

public class SoundIndexServiceTests
{
    [Fact]
    public void BanksInfSuppliesGroupsAndTruncatedCourseNames()
    {
        // repo-hygiene: allow[config-listing] -- project-authored parser fixture with synthetic bank names
        const string inf = """
            [GARI]
              MAIN = "fixture-main.bnk"
              BOARD = "fixture-board.bnk"
              BANK = "fixture-course-a.bnk"
              CROWD = "fixture-crowd.bnk"
              TRICKY = "fixture-special.bnk"
              SWAP = "fixture-swap.bnk"
            [MEGAPLEX]
              BANK = "fixture-course-b.bnk"
            """;

        DiscSoundBanks banks = SoundIndexService.ParseBanksInf(inf, "MEGAPLE");

        Assert.Equal("fixture-course-b", banks.LevelBanks[2]);
        Assert.Equal(new[] { "fixture-course-a", "fixture-course-b" }, banks.CourseBanks);
    }

    [Fact]
    public void ResolverIsInterpretedFromElfInstructionsAndHandlers()
    {
        byte[] elf = BuildElf();

        Dictionary<int, (int Group, int Slot)> events = SoundIndexService.ExtractCollisionEvents(elf);

        Assert.Equal((2, 7), events[2]);
        Assert.Equal((3, 4), events[3]);
        Assert.False(events.ContainsKey(4));
    }

    [Fact]
    public void BoardSurfaceGroupsAreInterpretedFromTheElfSwitch()
    {
        byte[] elf = BuildElf();

        List<int> groups = SoundIndexService.ExtractBoardSurfaceGroups(elf);

        Assert.Equal(20, groups.Count);
        Assert.Equal(Enumerable.Range(1, 20).Select(index => index % 4), groups);
    }

    /// <summary>
    /// A synthetic executable: an invented segment layout whose every instruction is assembled from its
    /// fields by the helpers below, in the shape the reader searches for. Nothing here is copied from a
    /// build, so the fixture proves the matcher's rules and not any game's bytes.
    /// </summary>
    private static byte[] BuildElf()
    {
        const int segmentFile = 0x100;
        const uint segmentVirtual = 0x1000;
        byte[] elf = new byte[0x1000];
        elf[0] = 0x7f; elf[1] = (byte)'E'; elf[2] = (byte)'L'; elf[3] = (byte)'F';
        elf[4] = 1; elf[5] = 1;
        Put(elf, 28, 0x34); // e_phoff
        Put16(elf, 42, 32); Put16(elf, 44, 1);
        Put(elf, 0x34, 1);                  // PT_LOAD
        Put(elf, 0x38, segmentFile);
        Put(elf, 0x3c, segmentVirtual);
        Put(elf, 0x44, 0xf00);

        int resolver = segmentFile + 0x80;
        Put(elf, resolver + 0, Addiu(5, 18, -2));
        Put(elf, resolver + 4, Addiu(2, 0, 2));
        Put(elf, resolver + 8, Sltiu(3, 5, 3));
        Put(elf, resolver + 12, Beq(3, 0, 1));
        Put(elf, resolver + 16, Sw(2, 17, 0));
        Put(elf, resolver + 20, Lui(2, 0));
        Put(elf, resolver + 24, Sll(3, 5, 2));         // sll v1,a1,2
        Put(elf, resolver + 28, Addiu(2, 2, 0x1400));

        int course = segmentFile + 0x200;
        Put(elf, course, Addiu(2, 0, 7));
        Put(elf, course + 4, Sw(2, 16, 0));
        int crowd = segmentFile + 0x220;
        Put(elf, crowd, Addiu(2, 0, 3));
        Put(elf, crowd + 4, Sw(2, 17, 0));
        Put(elf, crowd + 8, Addiu(3, 0, 4));
        Put(elf, crowd + 12, Sw(3, 16, 0));

        int table = segmentFile + 0x400;
        Put(elf, table, segmentVirtual + 0x200);
        Put(elf, table + 4, segmentVirtual + 0x220);
        Put(elf, table + 8, segmentVirtual + 0x300); // zero-filled silent handler

        int mapper = segmentFile + 0x480;
        Put(elf, mapper + 20, Addiu(3, 2, 1));
        Put(elf, mapper + 24, Sltiu(2, 3, 22));
        Put(elf, mapper + 28, Beq(2, 0, 9));
        Put(elf, mapper + 32, Lui(2, 0));
        Put(elf, mapper + 36, Sll(3, 3, 2));           // sll v1,v1,2
        Put(elf, mapper + 40, Addiu(2, 2, 0x1500));
        Put(elf, mapper + 44, Addu(3, 3, 2));          // addu v1,v1,v0
        Put(elf, mapper + 48, Lw(4, 3, 0));            // lw a0,0(v1)
        Put(elf, mapper + 52, Jr(4));                  // jr a0
        Put(elf, mapper + 56, 0);

        int switchTable = segmentFile + 0x500;
        uint zeroHandler = segmentVirtual + 0x700;
        uint oneHandler = segmentVirtual + 0x708;
        uint twoHandler = segmentVirtual + 0x710;
        uint threeHandler = segmentVirtual + 0x718;
        uint[] handlers = { zeroHandler, oneHandler, twoHandler, threeHandler };
        for (int index = 0; index < 22; index++)
        {
            int value = index is 0 or 21 ? 0 : index % 4;
            Put(elf, switchTable + index * 4, handlers[value]);
        }
        int returns = segmentFile + 0x700;
        Put(elf, returns, Jr(31)); Put(elf, returns + 4, Daddu(2, 0, 0));   // jr ra; daddu v0,zero,zero
        for (int value = 1; value <= 3; value++)
        {
            int handler = returns + value * 8;
            Put(elf, handler, Jr(31));
            Put(elf, handler + 4, Addiu(2, 0, value));
        }
        return elf;
    }

    // MIPS field assemblers. Register numbers follow the ABI order (2 = v0, 3 = v1, 4 = a0, 5 = a1, 31 = ra).
    private static uint Addiu(int rt, int rs, int immediate) =>
        9u << 26 | (uint)rs << 21 | (uint)rt << 16 | (ushort)immediate;
    private static uint Sll(int rd, int rt, int shift) =>
        (uint)rt << 16 | (uint)rd << 11 | (uint)shift << 6;
    private static uint Addu(int rd, int rs, int rt) =>
        (uint)rs << 21 | (uint)rt << 16 | (uint)rd << 11 | 0x21u;
    private static uint Daddu(int rd, int rs, int rt) =>
        (uint)rs << 21 | (uint)rt << 16 | (uint)rd << 11 | 0x2du;
    private static uint Lw(int rt, int rs, int immediate) =>
        35u << 26 | (uint)rs << 21 | (uint)rt << 16 | (ushort)immediate;
    private static uint Jr(int rs) => (uint)rs << 21 | 0x08u;
    private static uint Sltiu(int rt, int rs, int immediate) =>
        11u << 26 | (uint)rs << 21 | (uint)rt << 16 | (ushort)immediate;
    private static uint Beq(int rs, int rt, int immediate) =>
        4u << 26 | (uint)rs << 21 | (uint)rt << 16 | (ushort)immediate;
    private static uint Sw(int rt, int rs, int immediate) =>
        43u << 26 | (uint)rs << 21 | (uint)rt << 16 | (ushort)immediate;
    private static uint Lui(int rt, int immediate) => 15u << 26 | (uint)rt << 16 | (ushort)immediate;
    private static void Put(byte[] bytes, int offset, uint value) =>
        BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(offset, 4), value);
    private static void Put16(byte[] bytes, int offset, ushort value) =>
        BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(offset, 2), value);
}
