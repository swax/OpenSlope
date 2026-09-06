using SSXLibrary.FileHandlers.Audio;
using Snowknife.Formats;

namespace Snowknife.Tests.Formats;

/// <summary>
/// The EA-XA v1 SCHl writer behind custom race music. Every test round-trips through the library's own
/// <see cref="EAAudioHandler"/>, so what is being proven is that a stream this encoder writes is one the
/// decoder that reads retail discs will accept — container shape and audio both.
/// </summary>
public class EaXaStreamEncoderTests
{
    const int SamplesPerBlock = 2408;

    static EAAudioHandler Read(byte[] stream)
    {
        var handler = new EAAudioHandler();
        using var memory = new MemoryStream(stream);
        handler.Load(memory);
        return handler;
    }

    static short[] Interleave(int samplesPerChannel, int channels, Func<int, int, short> sample)
    {
        var pcm = new short[samplesPerChannel * channels];
        for (int i = 0; i < samplesPerChannel; i++)
            for (int c = 0; c < channels; c++)
                pcm[i * channels + c] = sample(i, c);
        return pcm;
    }

    static short Tone(int i, double cyclesPerSample, double amplitude) =>
        (short)Math.Round(amplitude * Math.Sin(2 * Math.PI * cyclesPerSample * i));

    static double RootMeanSquareError(short[] wanted, short[] got)
    {
        double sum = 0;
        int n = Math.Min(wanted.Length, got.Length);
        for (int i = 0; i < n; i++)
        {
            double d = wanted[i] - got[i];
            sum += d * d;
        }
        return Math.Sqrt(sum / n);
    }

    static int IndexOfTag(byte[] data, string tag, int from = 0)
    {
        byte[] needle = System.Text.Encoding.ASCII.GetBytes(tag);
        for (int i = from; i + needle.Length <= data.Length; i++)
        {
            bool hit = true;
            for (int j = 0; j < needle.Length && hit; j++) hit = data[i + j] == needle[j];
            if (hit) return i;
        }
        return -1;
    }

    [Theory]
    [InlineData(0)]
    [InlineData(3)]
    [InlineData(-1)]
    public void AChannelCountOtherThanMonoOrStereoIsRejected(int channels)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => EaXaStreamEncoder.EncodeSchl(new short[28], channels, 22050));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-22050)]
    public void ANonPositiveSampleRateIsRejected(int sampleRate)
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => EaXaStreamEncoder.EncodeSchl(new short[28], 1, sampleRate));
    }

    [Fact]
    public void EmptyOrRaggedPcmIsRejected()
    {
        Assert.Throws<InvalidDataException>(() => EaXaStreamEncoder.EncodeSchl(Array.Empty<short>(), 1, 22050));
        Assert.Throws<InvalidDataException>(() => EaXaStreamEncoder.EncodeSchl(new short[9], 2, 22050));
    }

    [Fact]
    public void TheStreamOpensWithSchlAndClosesWithScel()
    {
        byte[] stream = EaXaStreamEncoder.EncodeSchl(new short[28 * 4], 1, 22050);

        Assert.Equal("SCHl", System.Text.Encoding.ASCII.GetString(stream, 0, 4));
        Assert.True(IndexOfTag(stream, "SCCl") > 0, "the block-count chunk is missing");
        Assert.True(IndexOfTag(stream, "SCDl") > 0, "no data block was written");
        Assert.True(IndexOfTag(stream, "SCEl") > 0, "the end chunk is missing");
    }

    [Fact]
    public void TheStreamIsPaddedTo128Bytes()
    {
        // .mus sample offsets are 128-aligned, so a chunk that is not is one the PathFinder graph cannot
        // point at.
        foreach (int samples in new[] { 28, 1000, SamplesPerBlock, SamplesPerBlock + 1 })
            Assert.Equal(0, EaXaStreamEncoder.EncodeSchl(new short[samples], 1, 22050).Length % 128);
    }

    [Fact]
    public void TheBlockCountMatchesTheNumberOfDataBlocksWritten()
    {
        byte[] stream = EaXaStreamEncoder.EncodeSchl(new short[SamplesPerBlock * 2 + 100], 1, 22050);

        int scclAt = IndexOfTag(stream, "SCCl");
        int declared = BitConverter.ToInt32(stream, scclAt + 8);
        int actual = 0;
        for (int at = IndexOfTag(stream, "SCDl"); at >= 0; at = IndexOfTag(stream, "SCDl", at + 4)) actual++;

        Assert.Equal(3, declared);
        Assert.Equal(declared, actual);
    }

    [Fact]
    public void TheHeaderDeclaresTheChannelCountSampleRateAndSampleCountItWasGiven()
    {
        short[] pcm = Interleave(5000, 2, (i, c) => Tone(i, 0.01 + c * 0.005, 12000));

        var handler = Read(EaXaStreamEncoder.EncodeSchl(pcm, 2, 32000));

        Assert.Equal(2, handler.Channels);
        Assert.Equal(32000, handler.SampleRate);
        Assert.Equal(5000, handler.SampleCount);
        Assert.Equal(0x0A, handler.Codec);
    }

    [Fact]
    public void ALargeSampleCountStillFitsItsPatchField()
    {
        // The 0x85 sample-count patch widens from 3 bytes to 4 above 0x00ffffff. A 30-minute race stem at
        // 32 kHz is well under that, but the widening branch is the one nothing else exercises.
        byte[] stream = EaXaStreamEncoder.EncodeSchl(new short[28], 1, 96000);

        Assert.Equal(96000, Read(stream).SampleRate);
    }

    [Fact]
    public void MonoAudioRoundTripsThroughTheLibraryDecoder()
    {
        short[] pcm = Interleave(SamplesPerBlock + 500, 1, (i, _) => Tone(i, 0.013, 18000));

        short[] decoded = Read(EaXaStreamEncoder.EncodeSchl(pcm, 1, 22050)).DecodeAudio();

        Assert.Equal(pcm.Length, decoded.Length);
        // Measured error on this waveform is 0.153% of full scale; the bound sits a little over 2x above it.
        Assert.True(RootMeanSquareError(pcm, decoded) < 0.0035 * 32768,
            $"RMS error {RootMeanSquareError(pcm, decoded):F1} exceeds 0.35% of full scale");
    }

    [Fact]
    public void StereoChannelsSurviveTheirBlockInterleaveWithoutSwapping()
    {
        // Channel 1's data sits after channel 0's plus the block's alignment gap. Getting that offset wrong
        // is not audible as a fault in a mono test — it swaps or shifts a stereo pair.
        short[] pcm = Interleave(SamplesPerBlock + 300, 2,
            (i, c) => c == 0 ? Tone(i, 0.011, 20000) : (short)0);

        short[] decoded = Read(EaXaStreamEncoder.EncodeSchl(pcm, 2, 22050)).DecodeAudio();

        Assert.Equal(pcm.Length, decoded.Length);
        var left = new short[pcm.Length / 2];
        var right = new short[pcm.Length / 2];
        for (int i = 0; i < left.Length; i++) { left[i] = decoded[i * 2]; right[i] = decoded[i * 2 + 1]; }

        // Measured: the left channel averages 12739 and the right decodes to exact silence. A swapped or
        // mis-offset channel run shows up here as either a quiet left or a loud right.
        Assert.True(left.Select(s => (double)Math.Abs(s)).Average() > 10000, "the left tone did not survive");
        Assert.True(right.All(s => Math.Abs(s) < 100),
            $"silence leaked into the right channel, peaking at {right.Max(s => Math.Abs(s))}");
    }

    [Fact]
    public void AudioIsContinuousAcrossABlockBoundary()
    {
        // Predictor history carries across SCDl blocks. If it were reset per block, the first samples of
        // block 2 would jump back toward zero and click.
        short[] pcm = Interleave(SamplesPerBlock * 2, 1, (i, _) => Tone(i, 0.002, 25000));

        short[] decoded = Read(EaXaStreamEncoder.EncodeSchl(pcm, 1, 22050)).DecodeAudio();

        // Measured peak deviation across the seam is 30 on a 25000-amplitude signal. A per-block history
        // reset would show up as a step of thousands, so the bound catches it with room to spare.
        for (int i = SamplesPerBlock - 8; i < SamplesPerBlock + 8; i++)
            Assert.True(Math.Abs(pcm[i] - decoded[i]) < 300,
                $"sample {i} across the block boundary drifted by {Math.Abs(pcm[i] - decoded[i])}");
    }

    [Fact]
    public void EncodingIsDeterministic()
    {
        short[] pcm = Interleave(600, 2, (i, c) => Tone(i, 0.01 + c * 0.002, 9000));

        Assert.Equal(EaXaStreamEncoder.EncodeSchl(pcm, 2, 22050), EaXaStreamEncoder.EncodeSchl(pcm, 2, 22050));
    }
}
