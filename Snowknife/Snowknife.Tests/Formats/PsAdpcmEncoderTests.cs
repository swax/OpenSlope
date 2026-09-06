using SSXLibrary.FileHandlers.Audio;
using Snowknife.Formats;

namespace Snowknife.Tests.Formats;

/// <summary>
/// The PS-ADPCM encoder for course-bank one-shots. Its whole contract is being the exact inverse of the
/// library decoder — same 16-byte frames, same low-nibble-first order, same UN-clamped history feedback —
/// so every test here encodes and then decodes with <see cref="PsAdpcmCodec"/> rather than comparing to a
/// stored blob. <c>bank-verify</c> makes the same claim, but only against a disc someone has to supply.
/// </summary>
public class PsAdpcmEncoderTests
{
    static short[] Decode(byte[] frames, int sampleCount)
    {
        var samples = new List<short>(sampleCount);
        int position = 0, history1 = 0, history2 = 0;
        PsAdpcmCodec.DecodeChannel(frames, ref position, sampleCount, samples, ref history1, ref history2);
        return samples.ToArray();
    }

    static double RootMeanSquareError(short[] wanted, short[] got)
    {
        double sum = 0;
        for (int i = 0; i < wanted.Length; i++)
        {
            double d = wanted[i] - got[i];
            sum += d * d;
        }
        return Math.Sqrt(sum / wanted.Length);
    }

    static short[] Sine(int count, double cyclesPerSample, double amplitude) =>
        Enumerable.Range(0, count)
            .Select(i => (short)Math.Round(amplitude * Math.Sin(2 * Math.PI * cyclesPerSample * i)))
            .ToArray();

    [Fact]
    public void OutputIsOneSixteenByteFramePerTwentyEightSamples()
    {
        Assert.Equal(16, PsAdpcmEncoder.Encode(new short[1]).Length);
        Assert.Equal(16, PsAdpcmEncoder.Encode(new short[28]).Length);
        Assert.Equal(32, PsAdpcmEncoder.Encode(new short[29]).Length);
        Assert.Equal(160, PsAdpcmEncoder.Encode(new short[28 * 10]).Length);
    }

    [Fact]
    public void EmptyInputProducesNoFrames()
    {
        Assert.Empty(PsAdpcmEncoder.Encode(Array.Empty<short>()));
    }

    [Fact]
    public void OnlyTheFinalFrameCarriesTheEndMarker()
    {
        byte[] encoded = PsAdpcmEncoder.Encode(Sine(28 * 4, 0.01, 8000));

        for (int frame = 0; frame < 4; frame++)
            Assert.Equal(frame == 3 ? 0x01 : 0x00, encoded[frame * 16 + 1]);
    }

    [Fact]
    public void EveryFrameHeaderStaysInsideTheDecodersPredictorAndShiftRange()
    {
        // A predictor above 4 makes the decoder silently fall back to 0, which would decode as something
        // other than what the encoder searched for.
        byte[] encoded = PsAdpcmEncoder.Encode(Sine(28 * 20, 0.03, 30000));

        for (int at = 0; at < encoded.Length; at += 16)
        {
            Assert.InRange((encoded[at] >> 4) & 0x0F, 0, 4);
            Assert.InRange(encoded[at] & 0x0F, 0, 12);
        }
    }

    [Fact]
    public void SilenceRoundTripsExactly()
    {
        var silence = new short[28 * 3];

        Assert.Equal(silence, Decode(PsAdpcmEncoder.Encode(silence), silence.Length));
    }

    [Fact]
    public void ASineRoundTripsWithinAdpcmQuantizationError()
    {
        short[] wanted = Sine(28 * 40, 0.02, 20000);

        short[] got = Decode(PsAdpcmEncoder.Encode(wanted), wanted.Length);

        Assert.Equal(wanted.Length, got.Length);
        // 4-bit ADPCM cannot be lossless; the bar is that the per-frame predictor/shift search is actually
        // tracking the signal rather than falling back to a fixed rung. Measured error on this waveform is
        // 0.086% of full scale, so the bound is a little over 2x that — loose enough to survive an encoder
        // that improves, tight enough that losing the search would blow straight through it.
        Assert.True(RootMeanSquareError(wanted, got) < 0.002 * 32768,
            $"RMS error {RootMeanSquareError(wanted, got):F1} exceeds 0.2% of full scale");
    }

    [Fact]
    public void AFullScaleSignalDoesNotDiverge()
    {
        // The decoder feeds back the UN-clamped prediction, so an encoder that fed back the clamped output
        // instead would drift apart from it exactly here, where clamping actually happens.
        short[] wanted = Sine(28 * 30, 0.01, 32767);

        short[] got = Decode(PsAdpcmEncoder.Encode(wanted), wanted.Length);

        Assert.True(RootMeanSquareError(wanted, got) < 0.0025 * 32768,
            $"RMS error {RootMeanSquareError(wanted, got):F1} exceeds 0.25% of full scale at full amplitude");
    }

    [Fact]
    public void TheTailOfAPartialFrameIsZeroPaddedRatherThanRepeated()
    {
        // 30 samples = 2 frames; samples 30..55 are padding the caller never asked for. They must not be
        // garbage, because the bank's sample count is what stops playback and it is allowed to be exact.
        short[] wanted = Sine(30, 0.02, 12000);

        short[] got = Decode(PsAdpcmEncoder.Encode(wanted), 56);

        Assert.Equal(56, got.Length);
        // Measured: exactly zero. The bound is against a 12000-amplitude signal, so it still proves the tail
        // is silence rather than a repeat of the last frame without pinning an exact search result.
        Assert.True(got.Skip(30).All(s => Math.Abs(s) < 100),
            $"padding after the final real sample reached {got.Skip(30).Max(s => Math.Abs(s))}");
    }

    [Fact]
    public void EncodingIsDeterministic()
    {
        short[] wanted = Sine(28 * 5, 0.017, 15000);

        Assert.Equal(PsAdpcmEncoder.Encode(wanted), PsAdpcmEncoder.Encode(wanted));
    }

    // ---- the loop shape, which is the difference between a placed emitter and silence ----
    //
    // A sustaining sound encoded with the one-shot marker is released the moment its samples run out, so an
    // authored ambient emitter built on one never sounds at all — every other part of the build looks right.
    // Shipped banks mark it the way asserted below (merqurycity1 slot 24) [Trailmap: 260-audio-files].

    static byte[] Flags(byte[] encoded) =>
        Enumerable.Range(0, encoded.Length / 16).Select(frame => encoded[frame * 16 + 1]).ToArray();

    [Fact]
    public void ASustainingSoundNeverCarriesTheOneShotEndMarker()
    {
        // 0x01 is "end, do NOT repeat" — the one byte that makes a loop impossible.
        byte[] flags = Flags(PsAdpcmEncoder.Encode(Sine(28 * 10, 0.02, 12000), 0, 28 * 9 - 1));

        Assert.DoesNotContain((byte)0x01, flags);
    }

    [Fact]
    public void TheLoopRegionIsMarkedTheWayShippedBanksMarkIt()
    {
        // Loop from frame 3 to frame 7 of a 10-frame sound.
        byte[] flags = Flags(PsAdpcmEncoder.Encode(Sine(28 * 10, 0.02, 12000), 3 * 28, 8 * 28 - 1));

        Assert.Equal(0x00, flags[0]);                                     // frame 0 opens clear
        Assert.Equal(0x02, flags[1]);                                     // body sustains
        Assert.Equal(0x06, flags[4]);                                     // one frame PAST the start sample
        Assert.Equal(0x02, flags[3]);
        Assert.Equal(0x02, flags[5]);
        Assert.Equal(0x02, flags[7]);                                     // still inside the region
        Assert.Equal(new byte[] { 0x03, 0x03 }, flags[8..]);              // past it: end + repeat
    }

    [Fact]
    public void ALoopStartingOneFrameInMarksThatFrameRatherThanTheFirst()
    {
        // 28 is the smallest loop start retail uses (merqurycity1 slot 36), and the injector picks it for a
        // whole-clip loop: a region written from sample 0 played ONCE on hardware and stopped, which is what
        // a zero start being read as "no loop region" looks like.
        byte[] flags = Flags(PsAdpcmEncoder.Encode(Sine(28 * 5, 0.02, 12000), 28, 28 * 4 - 1));

        // The region is asked to run to the end and is pulled back so TWO frames are left to wrap on, which
        // is what retail leaves. A single wrap frame is the shape that plays once and stops.
        Assert.Equal(new byte[] { 0x00, 0x02, 0x06, 0x03, 0x03 }, flags);
    }

    [Fact]
    public void ALoopEndPastTheDataStillLeavesAFrameToWrapOn()
    {
        // Asking to loop the whole clip is the ordinary case for an authored bed, and the last frame has to
        // carry the wrap: without it the voice reaches the end of the sample with nothing telling it to
        // repeat, which is the one-shot failure wearing a loop's tags.
        byte[] flags = Flags(PsAdpcmEncoder.Encode(Sine(28 * 5, 0.02, 12000), 0, 28 * 5 - 1));

        Assert.Equal(0x03, flags[^1]);
        Assert.DoesNotContain((byte)0x01, flags);
    }

    [Fact]
    public void ASoundTooShortToHoldALoopStaysAOneShot()
    {
        // One frame cannot be both the loop body and the frame that wraps, so the request is refused rather
        // than producing a voice that wraps onto itself forever with no audio in between.
        byte[] flags = Flags(PsAdpcmEncoder.Encode(Sine(20, 0.02, 12000), 0, 19));

        Assert.Equal(new byte[] { 0x01 }, flags);
    }

    /// <summary>
    /// FOUR frames is the floor, and three is the case that sits between the two the other tests cover.
    ///
    /// The shape needs one frame to open, one to sustain, one to carry the repeat address and one to close.
    /// At three, the injector's own region — starting one frame in, ending one frame short — puts the marker
    /// PAST the region's end, and `Flag` answers 0x03 for everything past the end before it ever checks for
    /// the marker. What comes out is a sound with no 0x06 at all: a one-shot in every way that matters, tagged
    /// and reported as a loop, which is exactly the failure the loop shape exists to prevent.
    /// </summary>
    [Fact]
    public void TooShortToCarryTheMarkerIsRefusedRatherThanMisEncoded()
    {
        byte[] four = Flags(PsAdpcmEncoder.Encode(Sine(28 * 4, 0.02, 12000), 28, 28 * 2 - 1));

        Assert.DoesNotContain((byte)0x06, four);           // no repeat address could be written...
        Assert.Equal(new byte[] { 0x00, 0x00, 0x00, 0x01 }, four);   // ...so it is honestly a one-shot
    }

    /// <summary>
    /// Five frames: one to open, one before the marker, the marker, and the TWO past the region that carry
    /// the wrap. Retail leaves two without exception — merqurycity1 24 is 643 frames with 641 and 642 both
    /// 0x03, slot 35 is 118 with 116 and 117, slot 36 is 163 with 161 and 162 — and this wrote ONE for as
    /// long as the emitter feature existed. A bed encoded that way plays once and stops on the console, and
    /// read back as a healthy loop by every tool we had.
    /// </summary>
    [Fact]
    public void FiveFramesIsTheShortestSoundThatCanActuallyLoop()
    {
        byte[] five = Flags(PsAdpcmEncoder.Encode(Sine(28 * 5, 0.02, 12000), 28, 28 * 3 - 1));

        Assert.Equal(new byte[] { 0x00, 0x02, 0x06, 0x03, 0x03 }, five);
        Assert.DoesNotContain((byte)0x01, five);
    }

    /// <summary>The retail exemplar reproduced end to end: merqurycity1 slot 36 is 163 frames with the loop
    /// starting at sample 28, and its flags are exactly this.</summary>
    [Fact]
    public void TheShapeMatchesRetailsOwnSustainingSlotFrameForFrame()
    {
        byte[] flags = Flags(PsAdpcmEncoder.Encode(Sine(28 * 163, 0.02, 12000), 28, 4485));

        Assert.Equal(0x00, flags[0]);
        Assert.Equal(0x02, flags[1]);
        Assert.Equal(0x06, flags[2]);                                   // one frame past sample 28
        Assert.All(flags[3..160], flag => Assert.Equal(0x02, flag));
        Assert.Equal(new byte[] { 0x03, 0x03 }, flags[161..]);          // the two retail leaves
    }

    [Fact]
    public void LoopMarkersDoNotDisturbTheAudio()
    {
        // The flag byte is not read by PCM decode, so turning a sound into a loop must change byte 1 of each
        // frame and nothing else — a loop that also re-quantized would make every A/B against it worthless.
        short[] wanted = Sine(28 * 12, 0.02, 20000);

        byte[] plain = PsAdpcmEncoder.Encode(wanted);
        byte[] looped = PsAdpcmEncoder.Encode(wanted, 0, 28 * 11 - 1);

        Assert.Equal(plain.Length, looped.Length);
        for (int at = 0; at < plain.Length; at++)
            if (at % 16 != 1)
                Assert.Equal(plain[at], looped[at]);
        Assert.Equal(Decode(plain, wanted.Length), Decode(looped, wanted.Length));
    }
}
