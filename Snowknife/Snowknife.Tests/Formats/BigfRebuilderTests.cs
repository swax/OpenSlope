using Snowknife.Formats;

namespace Snowknife.Tests.Formats;

/// <summary>
/// The streaming member replacer behind custom-music injection. It never materializes MUSIC.BIG, so its
/// table maths and its copy loop are the only things standing between a 451 MB archive and a corrupt disc.
/// The fixtures here are built by <see cref="BigfArchive"/>, which pins the two writers to one layout.
/// </summary>
public class BigfRebuilderTests
{
    static byte[] Bigf(params (string Path, byte[] Data)[] members)
    {
        var archive = new BigfArchive();
        foreach (var (path, data) in members)
            archive.Members.Add(new BigfArchive.Member { Path = path, Data = data });
        return archive.Write();
    }

    static byte[] Pattern(int length, int seed) =>
        Enumerable.Range(0, length).Select(i => (byte)((i * 31 + seed) & 0xFF)).ToArray();

    [Fact]
    public void ReplacingNothingReproducesTheArchiveByteForByte()
    {
        using var temp = new TempDir();
        byte[] original = Bigf((@"mus\a.mus", Pattern(200, 1)), (@"mus\b.mus", Pattern(50, 2)));
        string source = temp.Write("source.big", original);
        string output = temp.File("output.big");

        BigfRebuilder.ReplaceMembers(source, output, new Dictionary<string, byte[]>());

        Assert.Equal(original, File.ReadAllBytes(output));
    }

    [Fact]
    public void AReplacedMemberCarriesItsNewBytesAndTheRestAreUntouched()
    {
        using var temp = new TempDir();
        string source = temp.Write("source.big", Bigf(
            (@"mus\a.mus", Pattern(200, 1)),
            (@"mus\b.mus", Pattern(50, 2)),
            (@"mus\c.mus", Pattern(90, 3))));
        string output = temp.File("output.big");
        byte[] replacement = Pattern(777, 9);

        BigfRebuilder.ReplaceMembers(source, output,
            new Dictionary<string, byte[]> { [@"mus\b.mus"] = replacement });

        var rebuilt = BigfArchive.Load(File.ReadAllBytes(output));
        Assert.Equal(new[] { @"mus\a.mus", @"mus\b.mus", @"mus\c.mus" }, rebuilt.Members.Select(m => m.Path));
        Assert.Equal(Pattern(200, 1), rebuilt.Members[0].Data);
        Assert.Equal(replacement, rebuilt.Members[1].Data);
        Assert.Equal(Pattern(90, 3), rebuilt.Members[2].Data);
    }

    [Fact]
    public void AMemberCanBeNamedByItsBasename()
    {
        using var temp = new TempDir();
        string source = temp.Write("source.big", Bigf((@"deep\path\song.mus", Pattern(40, 1))));
        string output = temp.File("output.big");
        byte[] replacement = Pattern(64, 5);

        BigfRebuilder.ReplaceMembers(source, output,
            new Dictionary<string, byte[]> { ["song.mus"] = replacement });

        var rebuilt = BigfArchive.Load(File.ReadAllBytes(output));
        Assert.Equal(@"deep\path\song.mus", rebuilt.Members[0].Path);   // the table keeps the full path
        Assert.Equal(replacement, rebuilt.Members[0].Data);
    }

    [Fact]
    public void ShrinkingAMemberStillLeavesEveryLaterMemberIntact()
    {
        // The output is rebuilt from the table rather than patched in place, so a member that gets smaller
        // pulls every later member back down the file. Their bytes must survive the move.
        using var temp = new TempDir();
        string source = temp.Write("source.big", Bigf(
            (@"a.mus", Pattern(1000, 1)),
            (@"b.mus", Pattern(300, 2)),
            (@"c.mus", Pattern(20, 3))));
        string output = temp.File("output.big");

        BigfRebuilder.ReplaceMembers(source, output,
            new Dictionary<string, byte[]> { ["a.mus"] = Pattern(4, 7) });

        var rebuilt = BigfArchive.Load(File.ReadAllBytes(output));
        Assert.Equal(Pattern(4, 7), rebuilt.Members[0].Data);
        Assert.Equal(Pattern(300, 2), rebuilt.Members[1].Data);
        Assert.Equal(Pattern(20, 3), rebuilt.Members[2].Data);
    }

    [Fact]
    public void ReplacedMembersStayAlignedTo128()
    {
        using var temp = new TempDir();
        string source = temp.Write("source.big", Bigf(("a.mus", Pattern(7, 1)), ("b.mus", Pattern(9, 2))));
        string output = temp.File("output.big");

        BigfRebuilder.ReplaceMembers(source, output,
            new Dictionary<string, byte[]> { ["a.mus"] = Pattern(131, 4) });

        byte[] bytes = File.ReadAllBytes(output);
        uint Read(int at) => (uint)((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]);
        int at = 16;
        for (uint i = 0; i < Read(8); i++)
        {
            Assert.Equal(0u, Read(at) % 128);
            while (bytes[at + 8] != 0) at++;
            at += 9;
        }
    }

    [Fact]
    public void ReplacingAnAbsentMemberIsRejected()
    {
        using var temp = new TempDir();
        string source = temp.Write("source.big", Bigf(("a.mus", Pattern(8, 1))));

        var error = Assert.Throws<InvalidDataException>(() => BigfRebuilder.ReplaceMembers(
            source, temp.File("output.big"), new Dictionary<string, byte[]> { ["nope.mus"] = Pattern(4, 1) }));
        Assert.Contains("absent", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AnAmbiguousBasenameIsRejectedRatherThanGuessed()
    {
        // Two directories, one filename. Picking either would silently inject the song into the wrong slot.
        using var temp = new TempDir();
        string source = temp.Write("source.big", Bigf(
            (@"one\song.mus", Pattern(8, 1)),
            (@"two\song.mus", Pattern(8, 2))));

        var error = Assert.Throws<InvalidDataException>(() => BigfRebuilder.ReplaceMembers(
            source, temp.File("output.big"), new Dictionary<string, byte[]> { ["song.mus"] = Pattern(4, 1) }));
        Assert.Contains("ambiguous", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ReadMemberFindsAMemberByFullPathOrBasenameRegardlessOfCase()
    {
        using var temp = new TempDir();
        string source = temp.Write("source.big", Bigf((@"mus\Song.mus", Pattern(64, 3))));

        Assert.Equal(Pattern(64, 3), BigfRebuilder.ReadMember(source, @"mus\Song.mus").Data);
        Assert.Equal(Pattern(64, 3), BigfRebuilder.ReadMember(source, "song.MUS").Data);
        Assert.Equal(@"mus\Song.mus", BigfRebuilder.ReadMember(source, "song.mus").Path);
    }

    [Fact]
    public void MemberBasenamesSplitOnTheArchiveSeparatorNotTheHostSeparator()
    {
        // BIG paths use backslashes on every host. System.IO.Path treats '\' as an ordinary character on
        // Linux, which is how the three basename lookups above passed on Windows while CI failed them.
        Assert.Equal("Song.mus", BigfPaths.FileName(@"mus\Song.mus"));
        Assert.Equal("Song.mus", BigfPaths.FileName("mus/Song.mus"));
        Assert.Equal("Song.mus", BigfPaths.FileName("Song.mus"));
        Assert.Equal("garibaldi1", BigfPaths.FileNameWithoutExtension(@"banks\garibaldi1.bnk"));
        Assert.Equal("noext", BigfPaths.FileNameWithoutExtension(@"a\b\noext"));
    }

    [Fact]
    public void ReadMemberReportsAMissingMember()
    {
        using var temp = new TempDir();
        string source = temp.Write("source.big", Bigf(("a.mus", Pattern(8, 1))));

        Assert.Throws<FileNotFoundException>(() => BigfRebuilder.ReadMember(source, "b.mus"));
    }

    [Fact]
    public void ReadTableRejectsBytesThatAreNotBigf()
    {
        using var temp = new TempDir();
        string source = temp.Write("source.big", new byte[64]);

        Assert.Throws<InvalidDataException>(() => BigfRebuilder.ReadMember(source, "a.mus"));
    }
}
