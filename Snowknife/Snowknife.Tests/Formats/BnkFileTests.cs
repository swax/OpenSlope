using Snowknife.Formats;

namespace Snowknife.Tests.Formats;

/// <summary>
/// The BNKl bank rebuilder behind course-bank slot injection. Unlike the library's decoding reader, this one
/// promises every untouched slot survives VERBATIM — unknown header bytes, unknown tags and each sound's
/// platform dword included — with only the 0x88/0x89 channel-offset values rewritten. These fixtures build a
/// bank from scratch so that promise is checked without a disc.
/// </summary>
public class BnkFileTests
{
    /// <summary>A version-4 bank header: "BNKl", version, count (patched on write), then 12 unknown bytes
    /// that a faithful rebuild has to carry through untouched.</summary>
    static byte[] Header()
    {
        var header = new byte[0x14];
        "BNKl"u8.CopyTo(header);
        header[4] = 4;
        header[5] = 0x11;
        for (int i = 8; i < 0x14; i++) header[i] = (byte)(0xA0 + i);   // the unknown 8..19 run
        return header;
    }

    static byte[] Frames(int sampleCount, int seed)
    {
        int frames = (sampleCount + 27) / 28;
        return Enumerable.Range(0, frames * 16).Select(i => (byte)((i * 13 + seed) & 0xFF)).ToArray();
    }

    static BnkFile Bank(params BnkFile.Sound?[] slots)
    {
        var bank = new BnkFile { HeaderBytes = Header(), Version = 4 };
        bank.Slots.AddRange(slots);
        return bank;
    }

    static int U32(byte[] b, int at) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24);

    [Fact]
    public void WriteThenLoadPreservesSlotCountAndSoundPayloads()
    {
        var bank = Bank(
            BnkFile.BuildPsAdpcm(Frames(1000, 1), 1000, 22050),
            BnkFile.BuildPsAdpcm(Frames(56, 2), 56, 11025));

        var reloaded = BnkFile.Load(bank.Write());

        Assert.Equal(2, reloaded.Slots.Count);
        Assert.Equal(1000, reloaded.Slots[0]!.SampleCount);
        Assert.Equal(22050, reloaded.Slots[0]!.SampleRate);
        Assert.Equal(Frames(1000, 1), reloaded.Slots[0]!.ChannelData[0]);
        Assert.Equal(56, reloaded.Slots[1]!.SampleCount);
        Assert.Equal(11025, reloaded.Slots[1]!.SampleRate);
        Assert.Equal(Frames(56, 2), reloaded.Slots[1]!.ChannelData[0]);
    }

    [Fact]
    public void ARebuiltBankIsStableAcrossASecondRoundTrip()
    {
        // The injection path is load, swap one slot, write. If write-of-a-loaded-bank were not a fixed point,
        // every re-run would drift the untouched slots.
        byte[] first = Bank(
            BnkFile.BuildPsAdpcm(Frames(500, 1), 500, 22050),
            null,
            BnkFile.BuildPsAdpcm(Frames(140, 2), 140, 22050)).Write();

        Assert.Equal(first, BnkFile.Load(first).Write());
    }

    [Fact]
    public void EmptySlotsStayEmptyAndKeepTheirPosition()
    {
        // A zero table entry is an empty slot, not a missing one — collapsing it would renumber every slot
        // after it, and slot numbers are what the effect graph's PlaySound refers to.
        var reloaded = BnkFile.Load(Bank(
            null,
            BnkFile.BuildPsAdpcm(Frames(84, 1), 84, 22050),
            null,
            BnkFile.BuildPsAdpcm(Frames(84, 2), 84, 22050)).Write());

        Assert.Equal(4, reloaded.Slots.Count);
        Assert.Null(reloaded.Slots[0]);
        Assert.NotNull(reloaded.Slots[1]);
        Assert.Null(reloaded.Slots[2]);
        Assert.NotNull(reloaded.Slots[3]);
        Assert.Equal(Frames(84, 2), reloaded.Slots[3]!.ChannelData[0]);
    }

    [Fact]
    public void TheUnknownHeaderBytesAreCarriedThroughUntouched()
    {
        byte[] written = Bank(BnkFile.BuildPsAdpcm(Frames(84, 1), 84, 22050)).Write();

        byte[] source = Header();
        for (int i = 8; i < 0x14; i++) Assert.Equal(source[i], written[i]);
        Assert.Equal("BNKl", System.Text.Encoding.ASCII.GetString(written, 0, 4));
        Assert.Equal(4, written[4]);
    }

    [Fact]
    public void TheSlotCountIsPatchedIntoTheHeader()
    {
        byte[] written = Bank(
            BnkFile.BuildPsAdpcm(Frames(84, 1), 84, 22050),
            null,
            BnkFile.BuildPsAdpcm(Frames(84, 2), 84, 22050)).Write();

        Assert.Equal(3, written[6] | (written[7] << 8));
    }

    [Fact]
    public void UnknownTagsSurviveTheRebuild()
    {
        // 0x06 / 0x11 / 0x8A are carried but not interpreted. A rebuild that dropped what it did not
        // understand would silently change how the engine plays the sound.
        var sound = BnkFile.BuildPsAdpcm(Frames(84, 1), 84, 22050);

        var reloaded = BnkFile.Load(Bank(sound).Write());

        var tags = reloaded.Slots[0]!.Tags;
        Assert.Contains(tags, t => t.Tag == 0x06 && t.Value.SequenceEqual(new byte[] { 0x5A }));
        Assert.Contains(tags, t => t.Tag == 0x11 && t.Value.SequenceEqual(new byte[] { 0x00, 0xC8 }));
        Assert.Contains(tags, t => t.Tag == 0x8A);
        Assert.Contains(tags, t => t.Tag == 0xFD && t.Marker);
        Assert.Contains(tags, t => t.Tag == 0xFC && t.Marker);
        Assert.Equal(0xFF, reloaded.Slots[0]!.Terminator);
    }

    [Fact]
    public void TheChannelOffsetTagIsRewrittenToTheSoundsNewAbsolutePosition()
    {
        // BuildPsAdpcm authors 0x88 as four zero bytes. Write must replace it with where the data actually
        // landed, or the engine reads the bank header as audio.
        var bank = Bank(BnkFile.BuildPsAdpcm(Frames(280, 1), 280, 22050));

        byte[] written = bank.Write();

        var reloaded = BnkFile.Load(written);
        var offsetTag = reloaded.Slots[0]!.Tags.Single(t => t.Tag == 0x88);
        int offset = offsetTag.Value.Aggregate(0, (acc, b) => (acc << 8) | b);
        Assert.True(offset > 0, "the channel offset was left at zero");
        Assert.Equal(0, offset % 16);
        Assert.Equal(Frames(280, 1), written.Skip(offset).Take(Frames(280, 1).Length).ToArray());
    }

    [Fact]
    public void SampleDataIs16AlignedAndHeadersAre4Aligned()
    {
        byte[] written = Bank(
            BnkFile.BuildPsAdpcm(Frames(84, 1), 84, 22050),
            BnkFile.BuildPsAdpcm(Frames(112, 2), 112, 22050)).Write();

        var reloaded = BnkFile.Load(written);
        for (int i = 0; i < reloaded.Slots.Count; i++)
        {
            int entry = 0x14 + 4 * i;
            int headerOffset = entry + U32(written, entry);
            Assert.Equal(0, headerOffset % 4);
            int dataOffset = reloaded.Slots[i]!.Tags.Single(t => t.Tag == 0x88)
                .Value.Aggregate(0, (acc, b) => (acc << 8) | b);
            Assert.Equal(0, dataOffset % 16);
        }
    }

    [Fact]
    public void AnEmptySlotWritesAZeroTableEntry()
    {
        byte[] written = Bank(null, BnkFile.BuildPsAdpcm(Frames(84, 1), 84, 22050)).Write();

        Assert.Equal(0, U32(written, 0x14));
        Assert.NotEqual(0, U32(written, 0x18));
    }

    [Fact]
    public void LoadRejectsBytesThatAreNotABank()
    {
        var notABank = new byte[32];
        "XNKl"u8.CopyTo(notABank);

        Assert.Throws<InvalidDataException>(() => BnkFile.Load(notABank));
        Assert.Throws<InvalidDataException>(() => BnkFile.Load(new byte[4]));
    }

    [Fact]
    public void ASoundCarryingAnUnsupportedCodecIsRejectedRatherThanMisread()
    {
        // Channel length is derived from the codec, so an unknown one cannot be guessed at — it would slice
        // the wrong byte range out of the bank.
        var sound = BnkFile.BuildPsAdpcm(Frames(84, 1), 84, 22050);
        sound.Tags.Add(new BnkFile.TagRecord { Tag = 0xA0, Value = new byte[] { 0x77 } });

        Assert.Throws<InvalidDataException>(() => BnkFile.Load(Bank(sound).Write()));
    }

    static IEnumerable<byte> TagIds(BnkFile.Sound sound) => sound.Tags.Select(tag => tag.Tag);

    [Fact]
    public void AOneShotCarriesNoLoopPointTags()
    {
        // Retail's hit-sound slots carry neither, and the pair is what marks a slot as meant to sustain
        // [Trailmap: 260-audio-files] — writing them onto a one-shot would misdescribe it.
        var sound = BnkFile.BuildPsAdpcm(Frames(840, 1), 840, 22050);

        Assert.DoesNotContain((byte)0x86, TagIds(sound));
        Assert.DoesNotContain((byte)0x87, TagIds(sound));
    }

    [Fact]
    public void ASustainingSoundCarriesItsLoopRegionWhereShippedBanksPutIt()
    {
        // Order matters only insofar as the pair belongs with the other descriptive tags rather than after
        // the channel offset; merqurycity1 slot 24 is the exemplar.
        var sound = BnkFile.BuildPsAdpcm(Frames(840, 1), 840, 22050, 0, 811);

        var ids = TagIds(sound).ToList();
        Assert.Contains((byte)0x86, ids);
        Assert.Contains((byte)0x87, ids);
        Assert.True(ids.IndexOf(0x86) > ids.IndexOf(0x84), "the loop pair follows the sample rate");
        Assert.True(ids.IndexOf(0x87) < ids.IndexOf(0x88), "the loop pair precedes the channel offset");
    }

    [Fact]
    public void ALoopRegionSurvivesTheRoundTrip()
    {
        var reloaded = BnkFile.Load(Bank(BnkFile.BuildPsAdpcm(Frames(840, 1), 840, 22050, 28, 811)).Write());

        var tags = reloaded.Slots[0]!.Tags.ToDictionary(tag => tag.Tag, tag => tag.Value);
        Assert.Equal(28, tags[0x86].Aggregate(0, (value, b) => (value << 8) | b));
        Assert.Equal(811, tags[0x87].Aggregate(0, (value, b) => (value << 8) | b));
    }
}
