using SSXLibrary.FileHandlers.Audio;

namespace Snowknife.Formats;

/// <summary>
/// Encoder for the PS2 EA-XA v1 stream shape used by SSX Tricky race music
/// [Trailmap: 260-audio-files]. Each mono codec frame is 28 PCM samples in
/// 15 bytes; SCHl wraps stereo frames in streaming SCDl blocks and carries
/// predictor history continuously across those blocks.
/// </summary>
internal static class EaXaStreamEncoder
{
    private static readonly int[] C1 = { 0, 240, 460, 392 };
    private static readonly int[] C2 = { 0, 0, -208, -220 };

    public static byte[] EncodeSchl(short[] interleaved, int channels, int sampleRate)
    {
        if (channels is < 1 or > 2) throw new ArgumentOutOfRangeException(nameof(channels));
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(sampleRate);
        if (interleaved.Length == 0 || interleaved.Length % channels != 0)
            throw new InvalidDataException("EA-XA input must contain complete, non-empty PCM frames");

        int sampleCount = interleaved.Length / channels;
        var pcm = new short[channels][];
        var encoded = new byte[channels][];
        for (int c = 0; c < channels; c++)
        {
            pcm[c] = new short[sampleCount];
            for (int i = 0; i < sampleCount; i++) pcm[c][i] = interleaved[i * channels + c];
            encoded[c] = EncodeChannel(pcm[c]);
        }

        const int samplesPerBlock = 2408; // 86 codec frames; the common retail PS2 block size.
        int blockCount = (sampleCount + samplesPerBlock - 1) / samplesPerBlock;
        using var output = new MemoryStream();
        byte[] header = BuildHeader(sampleCount, channels, sampleRate);
        output.Write(header);
        WriteAscii(output, "SCCl");
        WriteU32(output, 12);
        WriteU32(output, (uint)blockCount);

        int frameCursor = 0;
        for (int first = 0; first < sampleCount; first += samplesPerBlock)
        {
            int blockSamples = Math.Min(samplesPerBlock, sampleCount - first);
            int frames = (blockSamples + 27) / 28;
            int channelBytes = frames * 15;

            // Retail SCDl blocks are 16-byte sized. With stereo, any alignment bytes sit between
            // the channel runs and are included in channel 1's relative offset.
            int fixedBytes = 8 + (8 + 4 * channels); // SCDl header + count/offsets/unknown payload prefix
            int gap = channels == 2 ? (16 - ((fixedBytes + channelBytes * channels) & 15)) & 15 : 0;
            int payloadBytes = 8 + 4 * channels + channelBytes * channels + gap;

            WriteAscii(output, "SCDl");
            WriteU32(output, (uint)(8 + payloadBytes));
            WriteU32(output, (uint)blockSamples);
            for (int c = 0; c < channels; c++)
                WriteU32(output, (uint)(c == 0 ? 0 : channelBytes + gap));
            WriteU32(output, 0); // observed extra EA-XA payload word; zero in shipped streams.

            output.Write(encoded[0], frameCursor * 15, channelBytes);
            if (channels == 2)
            {
                if (gap > 0) output.Write(new byte[gap]);
                output.Write(encoded[1], frameCursor * 15, channelBytes);
            }
            frameCursor += frames;
        }

        WriteAscii(output, "SCEl");
        WriteU32(output, 8);
        while ((output.Length & 127) != 0) output.WriteByte(0); // .mus sample offsets are 128-aligned.
        return output.ToArray();
    }

    private static byte[] EncodeChannel(short[] samples)
    {
        int frames = (samples.Length + 27) / 28;
        var output = new byte[frames * 15];
        int h1 = 0, h2 = 0;
        var trial = new int[28];
        var best = new int[28];

        for (int f = 0; f < frames; f++)
        {
            long bestError = long.MaxValue;
            int bestPredictor = 0, bestShift = 0, bestH1 = h1, bestH2 = h2;
            for (int predictor = 0; predictor < 4; predictor++)
            {
                for (int shift = 0; shift <= 12; shift++)
                {
                    long error = 0;
                    int th1 = h1, th2 = h2;
                    bool pruned = false;
                    int step = 1 << (12 - shift);
                    for (int i = 0; i < 28; i++)
                    {
                        int at = f * 28 + i;
                        int wanted = at < samples.Length ? samples[at] : 0;
                        int predicted = (C1[predictor] * th1 + C2[predictor] * th2 + 128) >> 8;
                        int center = (int)Math.Round((wanted - predicted) / (double)step,
                            MidpointRounding.AwayFromZero);
                        center = Math.Clamp(center, -8, 7);

                        int chosen = center;
                        int reconstructed = DecodeNibble(center, predictor, shift, th1, th2);
                        long localBest = (long)(wanted - reconstructed) * (wanted - reconstructed);
                        for (int n = Math.Max(-8, center - 1); n <= Math.Min(7, center + 1); n++)
                        {
                            int candidate = DecodeNibble(n, predictor, shift, th1, th2);
                            long d = wanted - candidate;
                            long local = d * d;
                            if (local < localBest)
                            {
                                localBest = local;
                                chosen = n;
                                reconstructed = candidate;
                            }
                        }

                        error += localBest;
                        trial[i] = chosen & 0x0f;
                        th2 = th1;
                        th1 = reconstructed; // EA-XA feeds the clamped output back into its predictor.
                        if (error >= bestError) { pruned = true; break; }
                    }

                    if (!pruned && error < bestError)
                    {
                        bestError = error;
                        bestPredictor = predictor;
                        bestShift = shift;
                        bestH1 = th1;
                        bestH2 = th2;
                        Array.Copy(trial, best, best.Length);
                    }
                }
            }

            h1 = bestH1;
            h2 = bestH2;
            int dst = f * 15;
            output[dst] = (byte)((bestPredictor << 4) | bestShift);
            for (int i = 0; i < 14; i++)
                output[dst + 1 + i] = (byte)((best[i * 2] << 4) | best[i * 2 + 1]);
        }
        return output;
    }

    private static int DecodeNibble(int nibble, int predictor, int shift, int h1, int h2)
    {
        // Match EaXaCodec.DecodeChannel exactly, including v1 rounding and clamped-history feedback.
        int scaled = (nibble << 28) >> (shift + 8);
        int sample = (scaled + C1[predictor] * h1 + C2[predictor] * h2 + 128) >> 8;
        return EaXaCodec.Clamp16(sample);
    }

    private static byte[] BuildHeader(int samples, int channels, int sampleRate)
    {
        using var h = new MemoryStream();
        WriteAscii(h, "SCHl");
        WriteU32(h, 0); // patched after the tag list is 4-aligned
        h.Write(new byte[] { (byte)'P', (byte)'T', 0x05, 0x00 }); // PlayStation 2 platform dword
        WritePatch(h, 0x06, 0x65, 1); // priority, copied from retail race chunks
        WritePatch(h, 0x0b, (uint)channels, 1);
        h.WriteByte(0xfd);
        WritePatch(h, 0x80, 2, 1); // stream header version
        WritePatch(h, 0x85, (uint)samples, samples <= 0x00ff_ffff ? 3 : 4);
        WritePatch(h, 0x82, (uint)channels, 1);
        WritePatch(h, 0x84, (uint)sampleRate, sampleRate <= 0x00ff_ffff ? 3 : 4);
        WritePatch(h, 0xa0, 0x0a, 1); // EA-XA
        WritePatch(h, 0x8c, 4, 1);
        h.WriteByte(0xff);
        while ((h.Length & 3) != 0) h.WriteByte(0);
        byte[] bytes = h.ToArray();
        BitConverter.GetBytes((uint)bytes.Length).CopyTo(bytes, 4);
        return bytes;
    }

    private static void WritePatch(Stream output, byte tag, uint value, int width)
    {
        output.WriteByte(tag);
        output.WriteByte((byte)width);
        for (int shift = (width - 1) * 8; shift >= 0; shift -= 8)
            output.WriteByte((byte)(value >> shift)); // EA patch values are stored big-endian.
    }

    private static void WriteAscii(Stream output, string text) =>
        output.Write(System.Text.Encoding.ASCII.GetBytes(text));

    private static void WriteU32(Stream output, uint value) => output.Write(BitConverter.GetBytes(value));
}
