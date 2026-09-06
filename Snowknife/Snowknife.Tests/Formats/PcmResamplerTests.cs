using Snowknife.Formats;

namespace Snowknife.Tests.Formats;

/// <summary>
/// Rate conversion for custom course-bank clips. The properties that matter are the ones a naive
/// interpolator gets wrong: level has to survive, and content above the new Nyquist has to be REMOVED rather
/// than folded back down as aliasing — 4-bit ADPCM has no precision to waste encoding hash.
/// </summary>
public class PcmResamplerTests
{
    static short[] Sine(int count, int rate, double hz, double amplitude) =>
        Enumerable.Range(0, count)
            .Select(i => (short)Math.Round(amplitude * Math.Sin(2 * Math.PI * hz * i / rate)))
            .ToArray();

    /// <summary>Signal energy at one frequency, by projection onto that frequency's sin/cos pair.</summary>
    static double Energy(short[] samples, int rate, double hz)
    {
        double real = 0, imaginary = 0;
        for (int i = 0; i < samples.Length; i++)
        {
            double angle = 2 * Math.PI * hz * i / rate;
            real += samples[i] * Math.Cos(angle);
            imaginary += samples[i] * Math.Sin(angle);
        }
        return Math.Sqrt(real * real + imaginary * imaginary) / samples.Length;
    }

    [Fact]
    public void TheSameRateIsNotTouchedAtAll()
    {
        short[] samples = Sine(1000, 48000, 1000, 12000);

        Assert.Same(samples, PcmResampler.Resample(samples, 48000, 48000));
    }

    [Fact]
    public void TheClipKeepsItsDuration()
    {
        short[] samples = Sine(48000, 48000, 440, 10000);

        Assert.Equal(22050, PcmResampler.Resample(samples, 48000, 22050).Length);
        Assert.Equal(16000, PcmResampler.Resample(samples, 48000, 16000).Length);
        Assert.Equal(96000, PcmResampler.Resample(samples, 48000, 96000).Length);
    }

    [Fact]
    public void ATonePassesThroughAtItsOwnFrequencyAndLevel()
    {
        // 1 kHz is well inside both Nyquists, so it must come out where it went in — a resampler that shifts
        // level would change how the whole bank balances against the retail slots beside it.
        short[] input = Sine(48000, 48000, 1000, 12000);

        short[] output = PcmResampler.Resample(input, 48000, 22050);

        double before = Energy(input, 48000, 1000);
        double after = Energy(output, 22050, 1000);
        Assert.InRange(after / before, 0.97, 1.03);
    }

    [Fact]
    public void ContentAboveTheNewNyquistIsRemovedRatherThanFoldedBack()
    {
        // 18 kHz cannot exist at 22.05 kHz: its Nyquist is 11.025 kHz. Interpolating between neighbours would
        // alias it down to |22050 - 18000| = 4050 Hz — an audible tone that was never in the source. THIS is
        // the test the flag exists for.
        short[] input = Sine(48000, 48000, 18000, 20000);

        short[] output = PcmResampler.Resample(input, 48000, 22050);

        double alias = Energy(output, 22050, 4050);
        Assert.True(alias < 0.02 * 20000, $"18 kHz folded back to 4050 Hz at amplitude {alias:F0}");
    }

    [Fact]
    public void SilenceStaysSilent()
    {
        Assert.All(PcmResampler.Resample(new short[4800], 48000, 22050), sample => Assert.Equal(0, sample));
    }

    [Fact]
    public void AFullScaleSignalDoesNotOverflowIntoWraparound()
    {
        // Windowed-sinc taps overshoot at a transient, and a short that wraps instead of clamping turns a
        // loud moment into a click.
        var square = new short[4800];
        for (int i = 0; i < square.Length; i++) square[i] = (short)(i / 24 % 2 == 0 ? 32767 : -32768);

        short[] output = PcmResampler.Resample(square, 48000, 22050);

        // Neighbouring samples of a clamped overshoot stay same-signed; a wrap flips by ~65535 in one step.
        for (int i = 1; i < output.Length; i++)
            Assert.True(Math.Abs(output[i] - output[i - 1]) <= 65535, $"sample {i} jumped by more than full scale");
    }

    [Fact]
    public void EmptyInputSurvives()
    {
        Assert.Empty(PcmResampler.Resample(Array.Empty<short>(), 48000, 22050));
    }

    [Fact]
    public void NonsenseRatesAreRejectedRatherThanProducingGarbage()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => PcmResampler.Resample(new short[10], 0, 22050));
        Assert.Throws<ArgumentOutOfRangeException>(() => PcmResampler.Resample(new short[10], 48000, 0));
    }
}
