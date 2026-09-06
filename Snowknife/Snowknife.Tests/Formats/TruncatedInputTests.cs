using Snowknife.Formats;
using Snowknife.Services;

namespace Snowknife.Tests.Formats;

/// <summary>
/// What the container parsers do with input that lies about itself.
///
/// These formats are read from a user's own disc and WRITTEN by this tool, so a truncated or malformed one is
/// most often our own writer caught in the act. That makes the diagnosis the product: an
/// `IndexOutOfRangeException` from inside a slice names neither the archive nor the member nor the offset,
/// and the same bug then costs an afternoon of bisecting discs instead of a minute of reading a message.
///
/// So what is asserted here is not that the parsers refuse — that part is easy — but that they refuse with
/// the numbers a reader needs in the message.
/// </summary>
public class TruncatedInputTests
{
    static byte[] BigfHeader(uint count) =>
        [(byte)'B', (byte)'I', (byte)'G', (byte)'F', 0, 0, 0, 0,
         (byte)(count >> 24), (byte)(count >> 16), (byte)(count >> 8), (byte)count, 0, 0, 0, 0];

    [Fact]
    public void ABigfWhoseEntryTableIsCutShortSaysWhichMember()
    {
        // Claims two members and carries not even one entry.
        var truncated = BigfHeader(2).Concat(new byte[] { 0, 0, 0, 0 }).ToArray();

        var error = Assert.Throws<InvalidDataException>(() => BigfArchive.Load(truncated));
        Assert.Contains("entry table", error.Message);
        Assert.Contains("of 2", error.Message);
    }

    [Fact]
    public void ABigfMemberNameThatNeverTerminatesIsRefused()
    {
        var unterminated = BigfHeader(1)
            .Concat(new byte[] { 0, 0, 0, 0, 0, 0, 0, 0 })            // offset 0, size 0
            .Concat("NAME"u8.ToArray())                               // ...and no NUL after it
            .ToArray();

        Assert.Contains("unterminated", Assert.Throws<InvalidDataException>(
            () => BigfArchive.Load(unterminated)).Message);
    }

    [Fact]
    public void ABigfMemberReachingPastTheArchiveNamesItselfAndBothNumbers()
    {
        var overrun = BigfHeader(1)
            .Concat(new byte[] { 0, 0, 0, 0x40, 0, 0, 0x10, 0 })      // 4 KB at offset 64
            .Concat("AUDIO.BIG\0"u8.ToArray())
            .ToArray();

        var error = Assert.Throws<InvalidDataException>(() => BigfArchive.Load(overrun));
        Assert.Contains("AUDIO.BIG", error.Message);
        Assert.Contains("4,096", error.Message);
    }

    /// <summary>A u32 offset near the top of the range casts to a NEGATIVE int and would fail somewhere
    /// else entirely; the check is unsigned so it is caught as what it is.</summary>
    [Fact]
    public void ABigfOffsetPastIntMaxIsCaughtAsAnOverrunRatherThanCastNegative()
    {
        var absurd = BigfHeader(1)
            .Concat(new byte[] { 0xFF, 0xFF, 0xFF, 0xF0, 0, 0, 0, 4 })
            .Concat("X\0"u8.ToArray())
            .ToArray();

        Assert.Contains("past the end", Assert.Throws<InvalidDataException>(
            () => BigfArchive.Load(absurd)).Message);
    }

    static byte[] BnkHeader(int count, byte version = 3)
    {
        var head = new byte[version == 2 ? 0x0C : 0x14];
        head[0] = (byte)'B'; head[1] = (byte)'N'; head[2] = (byte)'K'; head[3] = (byte)'l';
        head[4] = version;
        head[6] = (byte)count; head[7] = (byte)(count >> 8);
        return head;
    }

    [Fact]
    public void ABankHeaderShorterThanItsOwnVersionRequiresIsRefused()
    {
        var stub = BnkHeader(0)[..10];   // a v3 bank needs 0x14 bytes of header and has 10

        Assert.Contains("header needs", Assert.Throws<InvalidDataException>(
            () => BnkFile.Load(stub)).Message);
    }

    [Fact]
    public void ABankClaimingMoreSlotsThanItHasTableForSaysHowMany()
    {
        var overclaimed = BnkHeader(400).Concat(new byte[16]).ToArray();

        var error = Assert.Throws<InvalidDataException>(() => BnkFile.Load(overclaimed));
        Assert.Contains("400 slots", error.Message);
    }

    [Fact]
    public void ATagRunningOffTheEndOfTheBankNamesTheTagAndWhatWasLeft()
    {
        // One slot, pointing at a patch header whose 0x84 tag claims four bytes with one left in the bank.
        var bank = BnkHeader(1).ToList();
        bank.AddRange(new byte[] { 0x04, 0, 0, 0 });        // slot 0 -> +4 from the entry
        bank.AddRange(new byte[] { 0, 0, 0, 0 });           // the "PT" platform dword
        bank.AddRange(new byte[] { 0x84, 0x04, 0x00 });     // tag 0x84, size 4, and then the bank ends

        var error = Assert.Throws<InvalidDataException>(() => BnkFile.Load(bank.ToArray()));
        Assert.Contains("0x84", error.Message);
        Assert.Contains("4 byte", error.Message);
    }

    [Fact]
    public void RawExtractRefusesAMemberPathThatWalksOutOfTheFolder()
    {
        using var dir = new TempDir();
        string archive = Path.Combine(dir.Path, "evil.big");
        var big = new List<byte> { 0xC0, 0xFB, 0, 0, 0, 1 };
        var name = "..\\..\\escaped.txt\0"u8.ToArray();
        int payload = 6 + 6 + name.Length;
        big.AddRange([(byte)(payload >> 16), (byte)(payload >> 8), (byte)payload]);   // offset
        big.AddRange([0, 0, 4]);                                                      // size
        big.AddRange(name);
        big.AddRange("DATA"u8.ToArray());
        File.WriteAllBytes(archive, big.ToArray());

        string into = Path.Combine(dir.Path, "out");
        Directory.CreateDirectory(into);

        var error = Assert.Throws<InvalidDataException>(
            () => new BigArchiveService().RawExtractC0fb(archive, into));
        Assert.Contains("outside the extraction folder", error.Message);
        Assert.False(File.Exists(Path.Combine(dir.Path, "..", "escaped.txt")));
    }
}
