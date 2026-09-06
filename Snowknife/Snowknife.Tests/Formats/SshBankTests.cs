using Snowknife.Formats;

namespace Snowknife.Tests.Formats;

/// <summary>
/// The SHPS texture-bank splicer. Its whole reason for existing is that a re-encoded page is not displayed
/// by the PS2 uploader, so pages must move as verbatim byte runs — which makes "the bytes I put in are the
/// bytes that come out, and every page still starts 16-aligned" the entire contract.
/// </summary>
public class SshBankTests
{
    static readonly byte[] Creator = "G278"u8.ToArray();

    static byte[] Page(int length, int seed) =>
        Enumerable.Range(0, length).Select(i => (byte)((i * 7 + seed) & 0xFF)).ToArray();

    static int U32(byte[] b, int at) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24);

    static byte[] Padded(byte[] page)
    {
        int size = (page.Length + 15) & ~15;
        var buffer = new byte[size];
        page.CopyTo(buffer, 0);
        return buffer;
    }

    [Fact]
    public void CreateThenLoadRoundTripsEveryPage()
    {
        byte[] bank = SshBank.Create(new[] { Page(48, 1), Page(32, 2), Page(64, 3) }, Creator);

        var loaded = SshBank.Load(bank);

        Assert.Equal(3, loaded.Count);
        Assert.Equal(Page(48, 1), loaded.PageBytes(0));
        Assert.Equal(Page(32, 2), loaded.PageBytes(1));
        Assert.Equal(Page(64, 3), loaded.PageBytes(2));
    }

    [Fact]
    public void CreateNamesSlotsInMeshOrderAndKeepsTheCreatorCode()
    {
        // A material's TextureID indexes this directory, so slot order is load-bearing, not cosmetic.
        byte[] bank = SshBank.Create(new[] { Page(16, 1), Page(16, 2), Page(16, 3) }, Creator);

        var loaded = SshBank.Load(bank);

        Assert.Equal(new[] { "0000", "0001", "0002" }, loaded.Dir.Select(d => d.Name));
        Assert.Equal("G278", System.Text.Encoding.ASCII.GetString(bank, 12, 4));
    }

    [Fact]
    public void EveryPageStarts16Aligned()
    {
        // Odd page sizes on purpose: each gets padded up so the next one still lands on a boundary.
        byte[] bank = SshBank.Create(new[] { Page(3, 1), Page(17, 2), Page(33, 3), Page(1, 4) }, Creator);

        var loaded = SshBank.Load(bank);

        foreach (var (_, offset) in loaded.Dir) Assert.Equal(0, offset % 16);
    }

    [Fact]
    public void ShortPagesArePaddedRatherThanTruncated()
    {
        byte[] bank = SshBank.Create(new[] { Page(3, 1), Page(20, 2) }, Creator);

        var loaded = SshBank.Load(bank);

        Assert.Equal(16, loaded.Extent(0).len);
        Assert.Equal(32, loaded.Extent(1).len);
        Assert.Equal(Padded(Page(3, 1)), loaded.PageBytes(0));
    }

    [Fact]
    public void TheFileSizeFieldMatchesTheActualLength()
    {
        byte[] bank = SshBank.Create(new[] { Page(48, 1), Page(5, 2) }, Creator);

        Assert.Equal(bank.Length, U32(bank, 4));
    }

    [Fact]
    public void AppendingNoPagesReproducesTheBankByteForByte()
    {
        byte[] bank = SshBank.Create(new[] { Page(48, 1), Page(32, 2) }, Creator);

        var (grown, slots) = SshBank.Append(bank, Array.Empty<byte[]>());

        Assert.Equal(bank, grown);
        Assert.Empty(slots);
    }

    [Fact]
    public void ReplacingNoPagesReproducesTheBankByteForByte()
    {
        byte[] bank = SshBank.Create(new[] { Page(48, 1), Page(32, 2) }, Creator);

        Assert.Equal(bank, SshBank.ReplacePages(bank, new Dictionary<int, byte[]>()));
    }

    [Fact]
    public void AppendedPagesTakeTheNextSlotNumbersAndLeaveTheOriginalsIntact()
    {
        byte[] bank = SshBank.Create(new[] { Page(48, 1), Page(32, 2) }, Creator);

        var (grown, slots) = SshBank.Append(bank, new[] { Page(64, 8), Page(16, 9) });

        Assert.Equal(new[] { "0002", "0003" }, slots);
        var loaded = SshBank.Load(grown);
        Assert.Equal(4, loaded.Count);
        Assert.Equal(Page(48, 1), loaded.PageBytes(0));
        Assert.Equal(Page(32, 2), loaded.PageBytes(1));
        Assert.Equal(Page(64, 8), loaded.PageBytes(2));
        Assert.Equal(Page(16, 9), loaded.PageBytes(3));
        foreach (var (_, offset) in loaded.Dir) Assert.Equal(0, offset % 16);
    }

    [Fact]
    public void AppendingAnOddNumberOfSlotsKeepsTheBodyShift16Aligned()
    {
        // The directory grows by 8 bytes per page, so an odd count needs 8 bytes of pad to keep every
        // relocated page on its boundary. This is the case that catches a missing pad.
        byte[] bank = SshBank.Create(new[] { Page(48, 1), Page(32, 2) }, Creator);

        var (grown, _) = SshBank.Append(bank, new[] { Page(48, 7) });

        var loaded = SshBank.Load(grown);
        Assert.Equal(3, loaded.Count);
        foreach (var (_, offset) in loaded.Dir) Assert.Equal(0, offset % 16);
        Assert.Equal(Page(48, 1), loaded.PageBytes(0));
        Assert.Equal(Page(32, 2), loaded.PageBytes(1));
    }

    [Fact]
    public void AReplacedPageOfADifferentSizeRelocatesTheRest()
    {
        byte[] bank = SshBank.Create(new[] { Page(48, 1), Page(32, 2), Page(16, 3) }, Creator);

        byte[] spliced = SshBank.ReplacePages(bank, new Dictionary<int, byte[]> { [1] = Page(128, 9) });

        var loaded = SshBank.Load(spliced);
        Assert.Equal(3, loaded.Count);
        Assert.Equal(Page(48, 1), loaded.PageBytes(0));
        Assert.Equal(Page(128, 9), loaded.PageBytes(1));
        Assert.Equal(Page(16, 3), loaded.PageBytes(2));
        foreach (var (_, offset) in loaded.Dir) Assert.Equal(0, offset % 16);
        Assert.Equal(spliced.Length, U32(spliced, 4));
    }

    [Fact]
    public void ReplacingKeepsTheDirectoryShortnamesUnchanged()
    {
        byte[] bank = SshBank.Create(new[] { Page(48, 1), Page(32, 2) }, Creator);

        byte[] spliced = SshBank.ReplacePages(bank, new Dictionary<int, byte[]> { [0] = Page(80, 5) });

        Assert.Equal(new[] { "0000", "0001" }, SshBank.Load(spliced).Dir.Select(d => d.Name));
    }

    [Fact]
    public void ReplacingASlotOutsideTheDirectoryIsRejected()
    {
        byte[] bank = SshBank.Create(new[] { Page(16, 1) }, Creator);

        Assert.Throws<ArgumentOutOfRangeException>(() =>
            SshBank.ReplacePages(bank, new Dictionary<int, byte[]> { [1] = Page(16, 2) }));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            SshBank.ReplacePages(bank, new Dictionary<int, byte[]> { [-1] = Page(16, 2) }));
    }

    [Fact]
    public void IndexOfNameFindsAPageAndPadsAShortNameToFourDigits()
    {
        byte[] bank = SshBank.Create(Enumerable.Range(0, 12).Select(i => Page(16, i)).ToList(), Creator);

        var loaded = SshBank.Load(bank);

        Assert.Equal(7, loaded.IndexOfName("0007"));
        Assert.Equal(7, loaded.IndexOfName("7"));
        Assert.Equal(11, loaded.IndexOfName("11"));
        Assert.Equal(-1, loaded.IndexOfName("0099"));
    }

    [Fact]
    public void LoadRejectsBytesThatAreNotShps()
    {
        var notABank = new byte[64];
        "SHPX"u8.CopyTo(notABank);

        Assert.Throws<InvalidDataException>(() => SshBank.Load(notABank));
        Assert.Throws<InvalidDataException>(() => SshBank.Load(new byte[4]));
    }

    [Fact]
    public void AnEmptyBankIsStillAValidContainer()
    {
        byte[] bank = SshBank.Create(Array.Empty<byte[]>(), Creator);

        var loaded = SshBank.Load(bank);

        Assert.Equal(0, loaded.Count);
        Assert.Equal(bank.Length, U32(bank, 4));
    }
}
