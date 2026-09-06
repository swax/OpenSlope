namespace Snowknife.Formats;

/// <summary>
/// Band-limited rate conversion for the PCM16 mono clips that go into a course bank.
///
/// Downsampling is the case this exists for, and it is the case a naive resampler gets wrong in a way that
/// only shows up on the console: dropping a 48 kHz clip to 22 kHz by interpolating between neighbours folds
/// everything above the new Nyquist back down as inharmonic hash, and 4-bit ADPCM then spends its very
/// limited precision encoding that hash. So the kernel is a windowed sinc whose cutoff follows the LOWER of
/// the two rates, which is what removes that content before it can alias rather than after.
///
/// Taps are normalised to sum to one, so DC gain is exactly unity and the clip does not change level. Reads
/// past either end clamp to the edge sample rather than to zero — a bed is usually looped, and zero-padding
/// would put a click at the wrap.
/// </summary>
internal static class PcmResampler
{
    /// <summary>Sinc lobes either side. Sixteen is well past the point where more stops being audible under
    /// PS-ADPCM; the cost is linear in it and the whole conversion is milliseconds.</summary>
    private const int Lobes = 16;

    public static short[] Resample(short[] samples, int fromRate, int toRate)
    {
        if (fromRate <= 0 || toRate <= 0) throw new ArgumentOutOfRangeException(nameof(toRate), "sample rates must be positive");
        if (fromRate == toRate || samples.Length == 0) return samples;

        double ratio = toRate / (double)fromRate;
        // Cutoff relative to the INPUT Nyquist: unchanged when upsampling, the output's own Nyquist when down.
        double cutoff = Math.Min(1.0, ratio);
        int halfWidth = (int)Math.Ceiling(Lobes / cutoff);
        int outputLength = Math.Max(1, (int)Math.Round(samples.Length * ratio));
        var output = new short[outputLength];

        for (int i = 0; i < outputLength; i++)
        {
            double centre = i / ratio;
            int first = (int)Math.Floor(centre) - halfWidth + 1;
            double acc = 0, weight = 0;
            for (int j = first; j < first + 2 * halfWidth; j++)
            {
                double x = centre - j;
                double tap = cutoff * Sinc(cutoff * x) * Blackman(x, halfWidth);
                if (tap == 0) continue;
                acc += tap * samples[Math.Clamp(j, 0, samples.Length - 1)];
                weight += tap;
            }
            double value = weight == 0 ? 0 : acc / weight;
            output[i] = (short)Math.Clamp(Math.Round(value), short.MinValue, short.MaxValue);
        }
        return output;
    }

    private static double Sinc(double x) =>
        Math.Abs(x) < 1e-9 ? 1.0 : Math.Sin(Math.PI * x) / (Math.PI * x);

    private static double Blackman(double x, int halfWidth)
    {
        if (Math.Abs(x) > halfWidth) return 0;
        double t = Math.PI * x / halfWidth;
        return 0.42 + 0.5 * Math.Cos(t) + 0.08 * Math.Cos(2 * t);
    }
}
