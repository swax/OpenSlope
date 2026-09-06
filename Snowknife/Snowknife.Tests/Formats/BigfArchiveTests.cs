using Snowknife.Formats;

namespace Snowknife.Tests.Formats;

/// <summary>
/// The BIGF container layout Snowknife writes back to a disc. <c>bank-verify</c> proves this round-trip on a
/// real AUDIO.BIG, but only when someone runs it with a disc to hand; these pin the layout rules the class
/// documents — 128-aligned member data in table order, zero gap fill, and a size field that counts payload
/// rather than file length — against synthetic archives that need no retail bytes.
/// </summary>
public class BigfArchiveTests
{
    static BigfArchive Archive(params (string Path, byte[] Data)[] members)
    {
        var archive = new BigfArchive();
        foreach (var (path, data) in members)
            archive.Members.Add(new BigfArchive.Member { Path = path, Data = data });
        return archive;
    }

    static byte[] Bytes(params int[] values) => values.Select(v => (byte)v).ToArray();

    static uint ReadBE(byte[] d, int at) => (uint)((d[at] << 24) | (d[at + 1] << 16) | (d[at + 2] << 8) | d[at + 3]);

    [Fact]
    public void WriteThenLoadPreservesEveryMemberPathAndPayload()
    {
        var source = Archive(
            (@"sfx\alpha.bnk", Bytes(1, 2, 3)),
            (@"sfx\beta.bnk", Bytes(9, 8, 7, 6, 5)),
            (@"deep\nested\gamma.bnk", Enumerable.Range(0, 300).Select(i => (byte)i).ToArray()));

        var reloaded = BigfArchive.Load(source.Write());

        Assert.Equal(source.Members.Count, reloaded.Members.Count);
        for (int i = 0; i < source.Members.Count; i++)
        {
            Assert.Equal(source.Members[i].Path, reloaded.Members[i].Path);
            Assert.Equal(source.Members[i].Data, reloaded.Members[i].Data);
        }
    }

    [Fact]
    public void RewritingALoadedArchiveIsByteIdentical()
    {
        // The no-op Load -> Write the repack path relies on: nothing about a member changed, so nothing about
        // the container may either.
        byte[] first = Archive((@"a\one.bnk", Bytes(4, 5, 6)), (@"a\two.bnk", Bytes(7))).Write();

        Assert.Equal(first, BigfArchive.Load(first).Write());
    }

    [Fact]
    public void MemberDataIsAlignedTo128BytesInTableOrder()
    {
        byte[] written = Archive(
            ("one", Bytes(1)),
            ("two", Bytes(2, 2)),
            ("three", new byte[200])).Write();

        uint count = ReadBE(written, 8);
        int at = 16;
        uint previousEnd = ReadBE(written, 12);   // header size: the first member cannot start inside the table
        for (uint i = 0; i < count; i++)
        {
            uint offset = ReadBE(written, at), size = ReadBE(written, at + 4);
            Assert.Equal(0u, offset % 128);
            Assert.True(offset >= previousEnd, $"member {i} at {offset} overlaps the previous member ending at {previousEnd}");
            previousEnd = offset + size;
            while (written[at + 8] != 0) at++;
            at += 9;
        }
    }

    [Fact]
    public void HeaderSizeFieldIsWhereTheMemberTableEnds()
    {
        var archive = Archive((@"x\one.bnk", Bytes(1)), (@"xx\two.bnk", Bytes(2)));

        byte[] written = archive.Write();

        int expected = 16 + archive.Members.Sum(m => 8 + m.Path.Length + 1);
        Assert.Equal((uint)expected, ReadBE(written, 12));
    }

    [Fact]
    public void SizeFieldCountsPayloadRatherThanFileLength()
    {
        // Documented retail layout: size = headerSize + the member sizes. Alignment padding is real bytes in
        // the file but is deliberately NOT counted, so this field is smaller than the file whenever a member
        // does not land on a 128 boundary.
        var archive = Archive(("one", Bytes(1)), ("two", Bytes(2)));

        byte[] written = archive.Write();

        int headerSize = 16 + archive.Members.Sum(m => 8 + m.Path.Length + 1);
        Assert.Equal((uint)(headerSize + 2), ReadBE(written, 4));
        Assert.True(written.Length > ReadBE(written, 4), "the padded file should be longer than the payload it declares");
    }

    [Fact]
    public void FileEndsAtTheLastMembersFinalByte()
    {
        byte[] written = Archive(("one", new byte[300]), ("two", new byte[7])).Write();

        uint count = ReadBE(written, 8);
        int at = 16;
        uint lastOffset = 0, lastSize = 0;
        for (uint i = 0; i < count; i++)
        {
            lastOffset = ReadBE(written, at);
            lastSize = ReadBE(written, at + 4);
            while (written[at + 8] != 0) at++;
            at += 9;
        }
        Assert.Equal(written.Length, (int)(lastOffset + lastSize));
    }

    [Fact]
    public void GapsBetweenMembersAreZeroFilled()
    {
        // A one-byte member leaves 127 bytes of gap before the next 128 boundary. Retail fills that with
        // zeros, and a repacked archive has to look the same.
        byte[] written = Archive(("one", Bytes(0xAA)), ("two", Bytes(0xBB))).Write();

        uint firstOffset = ReadBE(written, 16);
        uint secondOffset = ReadBE(written, 16 + 8 + "one".Length + 1);
        Assert.Equal(0xAA, written[firstOffset]);
        for (uint i = firstOffset + 1; i < secondOffset; i++)
            Assert.Equal(0, written[i]);
    }

    [Fact]
    public void AZeroLengthMemberKeepsItsTableRow()
    {
        var reloaded = BigfArchive.Load(Archive(("empty", Array.Empty<byte>()), ("after", Bytes(1))).Write());

        Assert.Equal(2, reloaded.Members.Count);
        Assert.Equal("empty", reloaded.Members[0].Path);
        Assert.Empty(reloaded.Members[0].Data);
        Assert.Equal(Bytes(1), reloaded.Members[1].Data);
    }

    [Fact]
    public void AnArchiveWithNoMembersIsStillAValidContainer()
    {
        var reloaded = BigfArchive.Load(new BigfArchive().Write());

        Assert.Empty(reloaded.Members);
    }

    [Fact]
    public void LoadRejectsBytesThatAreNotBigf()
    {
        var notAnArchive = new byte[64];
        "BIGX"u8.CopyTo(notAnArchive);

        Assert.Throws<InvalidDataException>(() => BigfArchive.Load(notAnArchive));
    }

    [Fact]
    public void LoadRejectsATruncatedHeader()
    {
        Assert.Throws<InvalidDataException>(() => BigfArchive.Load("BIGF"u8.ToArray()));
    }
}
