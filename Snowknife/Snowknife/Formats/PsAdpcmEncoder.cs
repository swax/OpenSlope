namespace Snowknife.Formats;

/// <summary>
/// PS-ADPCM (Sony VAG-family) encoder for course-bank one-shots [Trailmap: 260-audio-files]. Exactly mirrors
/// the library decoder (SSX-Library PsAdpcmCodec.DecodeChannel): 16-byte frames of 28 samples, low nibble
/// first, per-sample <c>s + ((f0·h1 + f1·h2) &gt;&gt; 6)</c> with UN-clamped history feedback (only the PCM
/// output clamps — load-bearing for exactness, per the codec spec). Encoding runs a full predictor × shift
/// search per frame with quantization feedback and picks the least squared error against the clamped output.
/// Flag bytes follow the shipped-bank convention. A ONE-SHOT is 0x00 on every frame with 0x01 (end, do not
/// repeat) on the final one — verified on mesabanca1.bnk slot 1 and merqurycity1 slot 33.
///
/// A SUSTAINING sound needs the other convention, and the difference is the whole of whether a placed emitter
/// is audible: 0x01 tells the SPU to stop the voice at the end, so a continuing emitter encoded as a one-shot
/// has nothing to sustain. Retail's three hit-gated emitter slots (merqurycity1 24/35/36 — hydrant spray, car
/// alarm, police siren) all carry the loop shape instead, exactly as slot 24 does: 0x00 on frame 0, 0x02 on
/// every body frame, 0x06 marking the frame the repeat address points at, and 0x03 (end + repeat) on every
/// frame past the loop region. `loopStartSample`/`loopEndSample` select that shape; -1 keeps the one-shot one.
/// The loop end must leave at least one frame to carry 0x03, or the voice runs off the end of the sample
/// rather than wrapping — see CourseBankInject, which is what computes it.
/// </summary>
internal static class PsAdpcmEncoder
{
    // decoder coefficient pairs ×64 (PsAdpcmCodec F0/F1)
    private static readonly int[] F0 = { 0, 60, 115, 98, 122 };
    private static readonly int[] F1 = { 0, 0, -52, -55, -60 };

    public static byte[] Encode(short[] samples, int loopStartSample = -1, int loopEndSample = -1)
    {
        int frames = (samples.Length + 27) / 28;
        bool wantsLoop = loopStartSample >= 0 && loopEndSample > loopStartSample && frames >= 2;
        // The repeat marker sits one frame PAST the frame the loop-start sample falls in, which is what all
        // three of retail's looping slots do without exception: merqurycity1 24 points at sample 13580
        // (frame 485) and marks frame 486, slot 35 points at 84 (frame 3) and marks 4, slot 36 points at 28
        // (frame 1) and marks 2. Marking the frame itself is an off-by-one against every shipped example.
        int loopStartFrame = wantsLoop ? Math.Min(loopStartSample / 28 + 1, frames - 1) : -1;
        // TWO frames past the region carry the wrap, not one. Every sustaining slot retail ships does this
        // without exception — merqurycity1 24 is 643 frames with 641 and 642 both 0x03, slot 35 is 118 with
        // 116 and 117, slot 36 is 163 with 161 and 162. Writing only one gives a bed that plays once and
        // stops, which is indistinguishable by ear from a missing loop region.
        int loopEndFrame = wantsLoop ? Math.Min(loopEndSample / 28, frames - 3) : -1;
        // A region whose marker would land past its own end cannot be spelled at all: `Flag` answers 0x03 for
        // every frame beyond loopEndFrame and tests that before the marker, so the 0x06 the SPU wraps to never
        // gets written and the voice runs off the end instead of repeating. Four frames is the smallest clip
        // that fits the shape — one to open, one to sustain, one to carry the marker, one to close — so a
        // three-frame request is refused here rather than encoded into something that looks looped and is not.
        bool looping = wantsLoop && loopStartFrame <= loopEndFrame;

        byte Flag(int frame)
        {
            if (!looping) return (byte)(frame == frames - 1 ? 0x01 : 0x00);
            if (frame > loopEndFrame) return 0x03;          // end of the loop region: wrap to the repeat address
            if (frame == loopStartFrame) return 0x06;       // this frame IS the repeat address
            return frame == 0 ? (byte)0x00 : (byte)0x02;    // sustain
        }

        var output = new byte[frames * 16];
        int h1 = 0, h2 = 0;                    // committed running history (un-clamped, as the decoder keeps it)
        var nibbles = new int[28];
        var best = new int[28];
        for (int f = 0; f < frames; f++)
        {
            long bestErr = long.MaxValue;
            int bestPred = 0, bestShift = 0, bestH1 = h1, bestH2 = h2;
            for (int pred = 0; pred < 5; pred++)
            {
                for (int shift = 0; shift <= 12; shift++)
                {
                    long err = 0;
                    int th1 = h1, th2 = h2;
                    int step = 1 << (12 - shift);
                    bool pruned = false;
                    for (int i = 0; i < 28; i++)
                    {
                        int idx = f * 28 + i;
                        int x = idx < samples.Length ? samples[idx] : 0;
                        int p = (F0[pred] * th1 + F1[pred] * th2) >> 6;
                        // the decoder reconstructs s = (short)(nibble<<12) >> shift = n·2^(12−shift) exactly,
                        // so quantization is a straight rounded division of the prediction residual
                        int n = (int)Math.Round((double)(x - p) / step, MidpointRounding.AwayFromZero);
                        if (n < -8) n = -8; else if (n > 7) n = 7;
                        int recon = p + (n << (12 - shift));
                        int outSample = recon < short.MinValue ? short.MinValue : recon > short.MaxValue ? short.MaxValue : recon;
                        long d = x - outSample;
                        err += d * d;
                        th2 = th1; th1 = recon;
                        nibbles[i] = n & 0xF;
                        if (err >= bestErr) { pruned = true; break; }
                    }
                    if (!pruned && err < bestErr)
                    {
                        bestErr = err; bestPred = pred; bestShift = shift; bestH1 = th1; bestH2 = th2;
                        Array.Copy(nibbles, best, 28);
                    }
                }
            }
            h1 = bestH1; h2 = bestH2;
            int at = f * 16;
            output[at] = (byte)((bestPred << 4) | bestShift);
            output[at + 1] = Flag(f);
            for (int i = 0; i < 14; i++)
                output[at + 2 + i] = (byte)(best[i * 2] | (best[i * 2 + 1] << 4));
        }
        return output;
    }
}
