using System.Linq;
using SSXLibrary.FileHandlers.Audio;

namespace Snowknife.Export;

/// <summary>
/// Decodes EA SCHl audio streams (SSX Tricky PS2 = EA-XA ADPCM) to WAV.
///
/// The library's <see cref="EAAudioHandler"/> parses the SCHl/SCCl/SCDl container and
/// decodes the EA-XA blocks to PCM; this exporter is the orchestration layer (drive the
/// handler, write a .wav) the same way <c>LightmapExporter</c>/<c>CharExporter</c> wrap the
/// library's format handlers. Decode lives in the library (reusable); file layout lives here.
/// </summary>
internal static class AudioExporter
{
    /// <summary>
    /// Decode every SCHl music stem found under <paramref name="membersDir"/> (the unpacked
    /// DATA\AUDIO\&lt;level&gt;.BIG) into <paramref name="outDir"/>/Audio/Music/*.wav. The level
    /// music bank holds the game's dynamic layers (e.g. A1..C8 + end) as separate
    /// SCHl streams; names are preserved so the layer structure is obvious. Returns the count.
    /// </summary>
    public static int ExportMusic(string membersDir, string outDir)
    {
        string musicDir = Path.Combine(outDir, "Audio", "Music");
        Directory.CreateDirectory(musicDir);

        int count = 0;
        foreach (string file in Directory.GetFiles(membersDir, "*", SearchOption.AllDirectories)
                                         .OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
        {
            if (!IsSchl(file)) continue;
            string outWav = Path.Combine(musicDir, Path.GetFileName(file) + ".wav");
            try { DecodeFileToWav(file, outWav); count++; }
            catch (Exception ex) { Log.Warn($"  ! {Path.GetFileName(file)}: {ex.Message}"); }
        }
        Log.Info($"  Audio: {count} music stem(s) -> {musicDir}");
        return count;
    }

    /// <summary>
    /// Decode every sound in a BNKl bank to <paramref name="outDir"/>/&lt;bankname&gt;/NNN.wav.
    /// With <paramref name="verbose"/>, prints each sound's parsed patch tags (for format work).
    /// </summary>
    public static int ExportBank(string bnkPath, string outDir, bool verbose = false, string? folderName = null)
    {
        var bank = new BnkHandler();
        bank.Load(bnkPath);
        // Folder = the caller's canonical BANKS.INF name when given (preserve the casing explicit clip paths use; Unity
        // importer's clip paths match, e.g. "zbxsfx"), else the .bnk file's own name. AUDIO.BIG stores some banks with
        // odd casing (zBxsfx.bnk) that wouldn't match the importer's "SFX/zbxsfx/..." paths on a case-sensitive lookup.
        string bankName = folderName ?? Path.GetFileNameWithoutExtension(bnkPath);
        string dir = Path.Combine(outDir, bankName);
        Directory.CreateDirectory(dir);

        Log.Info($"  {bankName}: BNKl v{bank.Version}, {bank.SoundCount} slots, {bank.Sounds.Count} sounds");
        int written = 0;
        foreach (var s in bank.Sounds)
        {
            if (verbose)
            {
                string patches = string.Join(" ", s.Patches.Select(kv => $"{kv.Key:X2}={kv.Value}"));
                Log.Info($"    [{s.Index}] @0x{s.HeaderOffset:X} ch={s.Channels} {s.SampleRate}Hz "
                                  + $"n={s.SampleCount} codec=0x{s.Codec:X} offs=[{string.Join(",", s.ChannelOffsets)}]  patches: {patches}");
            }
            short[]? pcm = bank.DecodeSound(bank.Sounds.IndexOf(s));
            if (pcm == null) continue;
            string outWav = Path.Combine(dir, $"{s.Index:D3}.wav");
            WriteWav(outWav, pcm, s.SampleRate, s.Channels);
            WriteLoopRegionVariant(outWav, pcm, s);
            written++;
        }
        Log.Info($"  {bankName}: wrote {written}/{bank.Sounds.Count} sound(s) -> {dir}");
        return written;
    }

    // BNKl patches 0x86/0x87 are the SPU loop start/end in samples [Trailmap: 420-audio-runtime]. When the
    // loop region is a proper suffix (start > 0), the retail voice plays the attack ONCE and then sustains
    // only the region - e.g. the Merqury hydrant hiss (slot 24) sustains 0.27s of its 1.13s clip. A player
    // that loops the whole wav re-fires the attack every wrap, so alongside NNN.wav we emit NNN.loop.wav
    // holding just the sustain region; placed-loop consumers prefer it when present. Whole-clip loops
    // (start == 0) need no variant.
    static void WriteLoopRegionVariant(string fullWavPath, short[] pcm, BnkHandler.BnkSound s)
    {
        if (!s.Patches.TryGetValue(0x86, out long start) || start <= 0) return;
        if (!s.Patches.TryGetValue(0x87, out long end)) return;
        long n = Math.Min(s.SampleCount, pcm.Length / Math.Max(1, s.Channels));
        if (end > n) end = n;
        if (start >= end) return;
        int ch = Math.Max(1, s.Channels);
        var region = new short[(end - start) * ch];
        Array.Copy(pcm, start * ch, region, 0, region.Length);
        string loopPath = Path.Combine(Path.GetDirectoryName(fullWavPath)!,
            Path.GetFileNameWithoutExtension(fullWavPath) + ".loop.wav");
        WriteWav(loopPath, region, s.SampleRate, s.Channels);
    }

    /// <summary>
    /// Decode ONE slot of a BNKl bank to <paramref name="outWav"/>. Returns false (writes nothing) when the
    /// bank doesn't ship that slot or its codec is unsupported. Used to fill a level course bank's
    /// referenced-but-empty slots from a sibling course bank (the slot layout is shared across courses).
    /// </summary>
    public static bool ExportBankSlot(string bnkPath, int slot, string outWav)
    {
        var bank = new BnkHandler();
        bank.Load(bnkPath);
        for (int i = 0; i < bank.Sounds.Count; i++)
        {
            var s = bank.Sounds[i];
            if (s.Index != slot) continue;
            short[]? pcm = bank.DecodeSound(i);
            if (pcm == null) return false;
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outWav))!);
            WriteWav(outWav, pcm, s.SampleRate, s.Channels);
            WriteLoopRegionVariant(outWav, pcm, s);
            return true;
        }
        return false;
    }

    /// <summary>
    /// Decode a SPEECH.BIG voice bank (.dat = many SCHl MicroTalk streams back to back; one per
    /// voice-line variant - the MC announcer's banks are named per race event: Big_Air, Land,
    /// Knockdown, Pass...) into <paramref name="outDir"/>/&lt;bankname&gt;/NNN.wav. Returns lines written.
    /// </summary>
    public static int ExportSpeechDat(string datPath, string outDir)
    {
        string bankName = Path.GetFileNameWithoutExtension(datPath);
        string dir = Path.Combine(outDir, bankName);
        Directory.CreateDirectory(dir);

        using var fs = File.OpenRead(datPath);
        int written = 0;
        Span<byte> head = stackalloc byte[8];
        while (fs.Position + 8 <= fs.Length)
        {
            long pos = fs.Position;
            fs.ReadExactly(head);
            string magic = System.Text.Encoding.ASCII.GetString(head[..4]);
            int size = BitConverter.ToInt32(head[4..8]);

            if (magic == "SCHl")
            {
                fs.Position = pos;
                var h = new EAAudioHandler();
                h.Load(fs);
                short[] pcm = h.DecodeAudio();
                WriteWav(Path.Combine(dir, $"{written:D3}.wav"), pcm, h.SampleRate, h.Channels);
                written++;
            }
            else if (size > 8 && pos + size <= fs.Length)
            {
                fs.Position = pos + size;   // skip SCEl etc.
            }
            else
            {
                fs.Position = pos + 4;      // resync (shouldn't happen on a well-formed bank)
            }
        }
        Log.Info($"  {bankName}: {written} voice line(s) -> {dir}");
        return written;
    }

    /// <summary>True if the file begins with the EA "SCHl" stream magic.</summary>
    static bool IsSchl(string path)
    {
        using var fs = File.OpenRead(path);
        if (fs.Length < 4) return false;
        Span<byte> b = stackalloc byte[4];
        fs.ReadExactly(b);
        return b[0] == (byte)'S' && b[1] == (byte)'C' && b[2] == (byte)'H' && b[3] == (byte)'l';
    }

    /// <summary>Decode a single SCHl stream file (e.g. a level .BIG member) to a .wav.</summary>
    public static int DecodeFileToWav(string inPath, string outWav)
    {
        var h = new EAAudioHandler();
        h.Load(inPath);
        short[] pcm = h.DecodeAudio();

        int ch = h.Channels;
        int rate = h.SampleRate;
        int frames = ch > 0 ? pcm.Length / ch : pcm.Length;

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outWav))!);
        WriteWav(outWav, pcm, rate, ch);

        Log.Info($"  {Path.GetFileName(inPath),-24} -> {Path.GetFileName(outWav)}  "
                          + $"{ch}ch {rate}Hz  {frames} samples ({(rate > 0 ? frames / (double)rate : 0):F2}s)  "
                          + $"[header said {h.SampleCount}]");
        return 0;
    }

    /// <summary>Write interleaved PCM16 as a canonical 44-byte-header WAV file.</summary>
    public static void WriteWav(string path, short[] interleaved, int sampleRate, int channels)
    {
        if (channels < 1) channels = 1;
        if (sampleRate <= 0) sampleRate = 22050;

        int bytesPerSample = 2;
        int dataBytes = interleaved.Length * bytesPerSample;
        int byteRate = sampleRate * channels * bytesPerSample;
        short blockAlign = (short)(channels * bytesPerSample);

        using var fs = File.Create(path);
        using var w = new BinaryWriter(fs);
        w.Write("RIFF"u8);
        w.Write(36 + dataBytes);
        w.Write("WAVE"u8);
        w.Write("fmt "u8);
        w.Write(16);                 // fmt chunk size
        w.Write((short)1);           // PCM
        w.Write((short)channels);
        w.Write(sampleRate);
        w.Write(byteRate);
        w.Write(blockAlign);
        w.Write((short)16);          // bits per sample
        w.Write("data"u8);
        w.Write(dataBytes);
        foreach (short s in interleaved) w.Write(s);
    }
}
