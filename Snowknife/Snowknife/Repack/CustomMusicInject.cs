using System.Globalization;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using SSXLibrary.FileHandlers.Audio;
using Snowknife.Export;
using Snowknife.Services;
using Snowknife.Formats;

namespace Snowknife.Repack;

/// <summary>
/// Custom race-track packer for Slopesmith exports. A <c>Music/track.wav</c> replaces the target course's
/// first retail PathFinder song, divided across its short independently buffered SCHl slots. The optional
/// <c>arrangement.json</c> selects either the proven unchanged retail graph or a donor-shaped linear loop:
/// the latter rewrites only existing link targets/event-table bytes, retaining node sizes, sample metadata,
/// fixed MUS offsets and streaming cadence instead of asking the PS2 runtime to accept a novel container.
/// </summary>
internal static class CustomMusicInject
{
    private const int TargetRate = 36000;

    private sealed class Arrangement
    {
        public int Version { get; set; } = 1;
        public string Mode { get; set; } = "retail-graph";
        public double Bpm { get; set; } = 120;
        public double LoopStartSeconds { get; set; }
        public double LoopEndSeconds { get; set; }

        public bool Linear => Mode.Equals("linear-loop", StringComparison.OrdinalIgnoreCase);
    }

    private static Arrangement ReadArrangement(string customDir)
    {
        string path = Path.Combine(customDir, "Music", "arrangement.json");
        if (!File.Exists(path)) return new Arrangement(); // The default preserves the donor's retail graph.
        var arrangement = JsonConvert.DeserializeObject<Arrangement>(File.ReadAllText(path))
            ?? throw new InvalidDataException("Music/arrangement.json is empty");
        if (arrangement.Version != 1) throw new InvalidDataException($"unsupported music arrangement v{arrangement.Version}");
        if (string.IsNullOrWhiteSpace(arrangement.Mode) ||
            (!arrangement.Mode.Equals("retail-graph", StringComparison.OrdinalIgnoreCase) && !arrangement.Linear))
            throw new InvalidDataException($"unsupported music arrangement mode {arrangement.Mode}");
        if (!double.IsFinite(arrangement.Bpm) || arrangement.Bpm is < 40 or > 300)
            throw new InvalidDataException("music arrangement BPM must be 40..300");
        if (!double.IsFinite(arrangement.LoopStartSeconds) || arrangement.LoopStartSeconds < 0 ||
            !double.IsFinite(arrangement.LoopEndSeconds) || arrangement.LoopEndSeconds < 0)
            throw new InvalidDataException("music loop times must be finite and non-negative");
        return arrangement;
    }

    public static void Apply(IsoService iso, string outIso, string level, string customDir, string tmp)
    {
        string wav = Path.Combine(customDir, "Music", "track.wav");
        if (!File.Exists(wav)) return;
        ApplyWav(iso, outIso, level, wav, ReadArrangement(customDir), Path.Combine(tmp, "custom_music"));
    }

    public static int Command(IsoService iso, string[] args)
    {
        if (args.Length < 5)
        {
            Log.Error("music-inject needs <input.iso> <LEVEL> <track.wav> <out.iso>");
            return 1;
        }
        string input = Path.GetFullPath(args[1]);
        string output = Path.GetFullPath(args[4]);
        if (input.Equals(output, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("music-inject requires a distinct output ISO");
        if (!File.Exists(args[3])) throw new FileNotFoundException("custom track WAV not found", args[3]);

        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        File.Copy(input, output, true);
        string work = Path.Combine(Path.GetTempPath(), "snowknife_custom_music_" + Guid.NewGuid().ToString("N"));
        try
        {
            ApplyWav(iso, output, args[2].ToUpperInvariant(), args[3], new Arrangement(), work);
        }
        finally
        {
            if (Directory.Exists(work)) Directory.Delete(work, recursive: true);
        }
        Log.Info($"music-inject: done -> {output}");
        return 0;
    }

    /// <summary>Offline structural check: rewire one donor MPF without touching an ISO or MUS.</summary>
    public static int LinearizeCommand(string[] args)
    {
        if (args.Length < 3)
        {
            Log.Error("music-linearize needs <donor.mpf> <out.mpf>");
            return 1;
        }
        string input = Path.GetFullPath(args[1]), output = Path.GetFullPath(args[2]);
        if (input.Equals(output, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("music-linearize requires a distinct output path");
        byte[] result = BuildLinearMpf(File.ReadAllBytes(input));
        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        File.WriteAllBytes(output, result);
        Log.Info($"music-linearize: {input} -> {output}");
        return 0;
    }

    private static void ApplyWav(IsoService iso, string outIso, string level, string wavPath,
                                 Arrangement arrangement, string work)
    {
        Directory.CreateDirectory(work);
        string mapInfPath = Path.Combine(work, "MUSICMAP.INF");
        string musicInfPath = Path.Combine(work, "MUSIC.INF");
        string musicBigPath = Path.Combine(work, "MUSIC.BIG");
        iso.ExtractFile(outIso, @"DATA\CONFIG\MUSICMAP.INF", mapInfPath);
        iso.ExtractFile(outIso, @"DATA\CONFIG\MUSIC.INF", musicInfPath);
        iso.ExtractFile(outIso, @"DATA\AUDIO\MUSIC.BIG", musicBigPath);

        string mapText = File.ReadAllText(mapInfPath);
        string infText = File.ReadAllText(musicInfPath);
        var map = MusicExporter.ParseInf(mapText);
        var inf = MusicExporter.ParseInf(infText);
        string? mapSection = map.Keys.FirstOrDefault(k =>
            k.StartsWith(level, StringComparison.OrdinalIgnoreCase) ||
            level.StartsWith(k, StringComparison.OrdinalIgnoreCase));
        if (mapSection == null) throw new InvalidDataException($"MUSICMAP.INF has no course section for {level}");
        string? shortName = map[mapSection].FirstOrDefault(e =>
            e.Key.Equals("SONG", StringComparison.OrdinalIgnoreCase)).Value;
        if (string.IsNullOrWhiteSpace(shortName))
            throw new InvalidDataException($"MUSICMAP.INF [{mapSection}] has no SONG");

        string? songSection = inf.Keys.FirstOrDefault(k => k.Contains(shortName, StringComparison.OrdinalIgnoreCase));
        if (songSection == null) throw new InvalidDataException($"MUSIC.INF has no song matching {shortName}");
        var song = inf[songSection];
        string? mpfName = song.FirstOrDefault(e => e.Key.Equals("PATHDATA", StringComparison.OrdinalIgnoreCase)).Value;
        string? musName = song.FirstOrDefault(e => e.Key.Equals("MUSDATA", StringComparison.OrdinalIgnoreCase)).Value;
        if (string.IsNullOrWhiteSpace(mpfName) || string.IsNullOrWhiteSpace(musName))
            throw new InvalidDataException($"MUSIC.INF [{songSection}] lacks PATHDATA/MUSDATA");

        var (_, donorMpf) = BigfRebuilder.ReadMember(musicBigPath, mpfName);
        var (_, donorMus) = BigfRebuilder.ReadMember(musicBigPath, musName);
        var (pcm, sourceRate, sourceChannels) = ReadAndResampleWav(wavPath);
        Log.Info($"  custom race music: {Path.GetFileName(wavPath)} ({pcm.Length / 2.0 / TargetRate:0.0}s; " +
                          $"source {sourceRate} Hz {sourceChannels}ch -> {TargetRate} Hz stereo)");

        byte[] mpf = arrangement.Linear ? BuildLinearMpf(donorMpf) : donorMpf;
        byte[] mus = BuildRetailShapedMus(donorMpf, donorMus, pcm, arrangement);

        string newBig = Path.Combine(work, "MUSIC.new.BIG");
        BigfRebuilder.ReplaceMembers(musicBigPath, newBig, new Dictionary<string, byte[]>
        {
            [mpfName] = mpf,
            [musName] = mus,
        });
        if (!BigfRebuilder.ReadMember(newBig, mpfName).Data.SequenceEqual(mpf) ||
            !BigfRebuilder.ReadMember(newBig, musName).Data.SequenceEqual(mus))
            throw new InvalidDataException("rebuilt MUSIC.BIG failed member verification");

        File.WriteAllText(mapInfPath, RestrictPlaylist(mapText, mapSection, shortName));
        File.WriteAllText(musicInfPath, UpdateMusicSettings(infText, songSection, arrangement));
        iso.ReplaceFile(outIso, @"DATA\AUDIO\MUSIC.BIG", newBig);
        iso.ReplaceFile(outIso, @"DATA\CONFIG\MUSIC.INF", musicInfPath);
        iso.ReplaceFile(outIso, @"DATA\CONFIG\MUSICMAP.INF", mapInfPath);
        Log.Info($"  PathFinder slot: [{songSection}] {mpfName} ({arrangement.Mode}) + {musName}; " +
                          $"{mapSection} playlist narrowed to {shortName}, async/delay mix disabled.");
        Log.Info(arrangement.Linear
            ? "  custom PCM follows sample-table order; mid-race event jumps are neutralized, startup/finish are retained, and the last sample loops to the first."
            : "  custom PCM wraps across the retail graph's adaptive short-stream order.");
    }

    /// <summary>
    /// Turn a retail race graph into one sample-table-order loop without changing its size or any sample
    /// metadata. Every authored range on an audio node points to the next sample node, so path level cannot
    /// branch; the last points back to sample one. The donor's entry node zero routes to sample one.
    /// Mid-race events select an existing non-node-changing router, preventing trick/intensity dispatch from
    /// jumping into the now-unreachable retail control islands. Event zero is the required race-reset/start
    /// dispatcher and the final event is the finish stinger, so both retain their donor routing.
    /// </summary>
    internal static byte[] BuildLinearMpf(byte[] donorMpf)
    {
        MusicExporter.MpfFile graph = MusicExporter.MpfFile.Parse(donorMpf);
        if (graph.Samples.Count == 0) throw new InvalidDataException("donor MPF has no samples");
        var bySample = new MusicExporter.MpfNode?[graph.Samples.Count];
        foreach (MusicExporter.MpfNode node in graph.Nodes.Where(n => n.Sample > 0))
        {
            int sample = node.Sample - 1;
            if (sample < 0 || sample >= bySample.Length)
                throw new InvalidDataException($"node {node.Index} references sample {node.Sample} outside the table");
            if (bySample[sample] != null)
                throw new InvalidDataException($"sample {node.Sample} is referenced by more than one donor node");
            if (node.LinkRaw.Count == 0)
                throw new InvalidDataException($"sample node {node.Index} has no link storage for a linear loop");
            bySample[sample] = node;
        }
        for (int i = 0; i < bySample.Length; i++)
            if (bySample[i] == null) throw new InvalidDataException($"donor MPF has no node for sample {i + 1}");

        var output = (byte[])donorMpf.Clone();
        static void RewriteTargets(byte[] bytes, MusicExporter.MpfNode node, int target)
        {
            if (target is < 0 or > ushort.MaxValue) throw new InvalidDataException($"invalid linear target {target}");
            for (int link = 0; link < node.LinkRaw.Count; link++)
            {
                int at = node.Offset + 0x0c + link * 4 + 2;
                BitConverter.GetBytes((ushort)target).CopyTo(bytes, at);
            }
        }

        int first = bySample[0]!.Index;
        // Retail graphs start at node zero. Flags bit 7 also marks terminal/end nodes, so it is not an entry
        // predicate by itself (System Overload's node 333 is a flagged zero-link terminal).
        foreach (MusicExporter.MpfNode entry in graph.Nodes.Take(1).Where(n => n.Sample <= 0))
        {
            if (entry.LinkRaw.Count == 0) throw new InvalidDataException($"entry node {entry.Index} has no links");
            RewriteTargets(output, entry, first);
        }
        for (int i = 0; i < bySample.Length; i++)
            RewriteTargets(output, bySample[i]!, bySample[(i + 1) % bySample.Length]!.Index);

        int noJumpRouter = graph.Routers.FindIndex(raw => (((raw >> 8) & 0x47) == 0));
        if (noJumpRouter < 0 || noJumpRouter > byte.MaxValue)
            throw new InvalidDataException("donor MPF has no reusable no-jump event router");
        if (graph.NumEvents < 2)
            throw new InvalidDataException("donor MPF lacks distinct startup and finish events");
        int eventStride = graph.NumTracks * graph.NumSections;
        int neutralizedSlots = 0;
        // Event 0 initializes/reset the live song node. Neutralizing it produces a structurally valid MPF that
        // never starts in-game. The final event is the race-finish stinger/end transition and stays native too.
        for (int eventIndex = 1; eventIndex < graph.NumEvents - 1; eventIndex++)
        {
            for (int i = 0; i < eventStride; i++)
            {
                output[graph.EventTableOffset + eventIndex * eventStride + i] = (byte)noJumpRouter;
                neutralizedSlots++;
            }
        }

        MusicExporter.MpfFile check = MusicExporter.MpfFile.Parse(output);
        if (check.Nodes.Count != graph.Nodes.Count || check.Samples.Count != graph.Samples.Count ||
            !check.EventTable.AsSpan(0, eventStride).SequenceEqual(graph.EventTable.AsSpan(0, eventStride)) ||
            !check.EventTable.AsSpan((graph.NumEvents - 1) * eventStride, eventStride)
                .SequenceEqual(graph.EventTable.AsSpan((graph.NumEvents - 1) * eventStride, eventStride)))
            throw new InvalidDataException("linear MPF structural verification failed");
        for (int i = eventStride; i < (graph.NumEvents - 1) * eventStride; i++)
            if (check.EventTable[i] != noJumpRouter)
                throw new InvalidDataException("linear MPF retained a mid-race event jump");
        if (check.Nodes[0].Sample <= 0 &&
            (check.Nodes[0].Links.Count == 0 || check.Nodes[0].Links.Any(target => target != first)))
            throw new InvalidDataException("linear MPF entry node did not route to sample 1");
        for (int i = 0; i < bySample.Length; i++)
        {
            MusicExporter.MpfNode node = check.Nodes[bySample[i]!.Index];
            int wanted = bySample[(i + 1) % bySample.Length]!.Index;
            if (node.Links.Count == 0 || node.Links.Any(target => target != wanted))
                throw new InvalidDataException($"linear MPF sample {i + 1} did not route to sample {(i + 1) % bySample.Length + 1}");
        }
        Log.Info($"  linear MPF: {bySample.Length} sample nodes, {neutralizedSlots} mid-race event slots " +
                          $"-> no-jump router {noJumpRouter}, start/finish retained, sample {bySample.Length} " +
                          $"-> sample 1; byte length unchanged ({output.Length:N0}).");
        return output;
    }

    private static byte[] BuildRetailShapedMus(byte[] donorMpf, byte[] donorMus, short[] source,
                                               Arrangement arrangement)
    {
        MusicExporter.MpfFile graph = MusicExporter.MpfFile.Parse(donorMpf);
        if (graph.Samples.Count == 0) throw new InvalidDataException("donor MPF has no samples");
        if (source.Length < 2 || (source.Length & 1) != 0)
            throw new InvalidDataException("custom track has no complete stereo PCM frames");

        var frameCounts = new int[graph.Samples.Count];
        var slotBytes = new int[graph.Samples.Count];
        using (var input = new MemoryStream(donorMus, writable: false))
        {
            long previous = -1;
            for (int i = 0; i < graph.Samples.Count; i++)
            {
                long offset = graph.Samples[i].Offset;
                long end = i + 1 < graph.Samples.Count ? graph.Samples[i + 1].Offset : donorMus.LongLength;
                if (offset < 0 || offset <= previous || end <= offset || end > donorMus.LongLength ||
                    (offset & 127) != 0 || end - offset > int.MaxValue)
                    throw new InvalidDataException($"donor MPF sample {i} has an invalid MUS slot");
                if (offset + 4 > donorMus.LongLength ||
                    !donorMus.AsSpan((int)offset, 4).SequenceEqual("SCHl"u8))
                    throw new InvalidDataException($"donor MPF sample {i} does not point to an SCHl stream");

                input.Position = offset;
                var audio = new EAAudioHandler();
                audio.Load(input);
                if (audio.Codec != 0x0a || audio.SampleRate != TargetRate || audio.Channels != 2 ||
                    audio.SampleCount <= 0)
                    throw new InvalidDataException($"donor sample {i} is not 36 kHz stereo EA-XA");
                frameCounts[i] = audio.SampleCount;
                slotBytes[i] = checked((int)(end - offset));
                previous = offset;
            }
        }

        int sourceFrames = source.Length / 2;
        int loopStart = checked((int)Math.Round(arrangement.LoopStartSeconds * TargetRate));
        int loopEnd = arrangement.LoopEndSeconds <= 0 ? sourceFrames
            : checked((int)Math.Round(arrangement.LoopEndSeconds * TargetRate));
        if (loopStart < 0 || loopStart >= sourceFrames)
            throw new InvalidDataException($"music loop start {arrangement.LoopStartSeconds:0.###}s is outside the {sourceFrames / (double)TargetRate:0.###}s source");
        if (loopEnd <= loopStart || loopEnd > sourceFrames)
            throw new InvalidDataException($"music loop end {(arrangement.LoopEndSeconds <= 0 ? "source end" : $"{arrangement.LoopEndSeconds:0.###}s")} must be after loop start and within the source");
        var timelineStarts = new long[frameCounts.Length];
        long totalFrames = 0;
        for (int i = 0; i < frameCounts.Length; i++)
        {
            timelineStarts[i] = totalFrames;
            totalFrames += frameCounts[i];
        }

        var chunks = new byte[frameCounts.Length][];
        Parallel.For(0, chunks.Length, i =>
        {
            short[] slice = ArrangementSlice(source, timelineStarts[i], frameCounts[i], loopStart, loopEnd);
            chunks[i] = EaXaStreamEncoder.EncodeSchl(slice, 2, TargetRate);
            if (chunks[i].Length > slotBytes[i])
                throw new InvalidDataException($"encoded sample {i} needs {chunks[i].Length:N0} bytes, " +
                    $"but its retail MUS slot has {slotBytes[i]:N0}");
        });

        // Keep every MPF offset valid by retaining the donor MUS length and placing each independent stream
        // in its original fixed slot. Bytes after SCEl are inert slot padding and are deliberately zeroed.
        var output = new byte[donorMus.Length];
        for (int i = 0; i < chunks.Length; i++)
            chunks[i].CopyTo(output, checked((int)graph.Samples[i].Offset));

        short[] firstSlice = ArrangementSlice(source, timelineStarts[0], frameCounts[0], loopStart, loopEnd);
        VerifyEncodedAudio(chunks[0], firstSlice);
        VerifyRetailShape(output, graph, frameCounts);
        Log.Info($"  retail-shaped stream: {chunks.Length} independent chunks, " +
            $"{totalFrames / (double)TargetRate:0.0}s graph span, {output.Length:N0} bytes; " +
            $"source loop {loopStart / (double)TargetRate:0.###}..{loopEnd / (double)TargetRate:0.###}s.");
        return output;
    }

    private static short[] ArrangementSlice(short[] source, long firstTimelineFrame, int frames,
                                            int loopStart, int loopEnd)
    {
        var output = new short[checked(frames * 2)];
        int loopFrames = loopEnd - loopStart;
        for (int i = 0; i < frames; i++)
        {
            long timelineFrame = firstTimelineFrame + i;
            int sourceFrame = timelineFrame < loopEnd ? (int)timelineFrame
                : loopStart + (int)((timelineFrame - loopEnd) % loopFrames);
            output[i * 2] = source[sourceFrame * 2];
            output[i * 2 + 1] = source[sourceFrame * 2 + 1];
        }
        return output;
    }

    private static void VerifyRetailShape(byte[] mus, MusicExporter.MpfFile graph, int[] wantedFrames)
    {
        using var input = new MemoryStream(mus, writable: false);
        for (int i = 0; i < graph.Samples.Count; i++)
        {
            input.Position = graph.Samples[i].Offset;
            var audio = new EAAudioHandler();
            audio.Load(input);
            if (audio.Codec != 0x0a || audio.SampleRate != TargetRate || audio.Channels != 2 ||
                audio.SampleCount != wantedFrames[i])
                throw new InvalidDataException($"encoded sample {i} failed retail-shape verification");
        }
    }

    private static (short[] Pcm, int SourceRate, int SourceChannels) ReadAndResampleWav(string path)
    {
        byte[] d = File.ReadAllBytes(path);
        if (d.Length < 44 || !d.AsSpan(0, 4).SequenceEqual("RIFF"u8) ||
            !d.AsSpan(8, 4).SequenceEqual("WAVE"u8))
            throw new InvalidDataException("custom track must be a RIFF WAV");
        int at = 12, fmt = -1, fmtSize = 0, data = -1, dataSize = 0;
        while (at + 8 <= d.Length)
        {
            int size = BitConverter.ToInt32(d, at + 4);
            if (size < 0 || at + 8L + size > d.Length) throw new InvalidDataException("WAV chunk is truncated");
            string id = System.Text.Encoding.ASCII.GetString(d, at, 4);
            if (id == "fmt ") { fmt = at + 8; fmtSize = size; }
            if (id == "data") { data = at + 8; dataSize = size; }
            at += 8 + size + (size & 1);
        }
        if (fmt < 0 || fmtSize < 16 || data < 0) throw new InvalidDataException("WAV is missing fmt/data");
        int format = BitConverter.ToUInt16(d, fmt);
        int channels = BitConverter.ToUInt16(d, fmt + 2);
        int rate = BitConverter.ToInt32(d, fmt + 4);
        int bits = BitConverter.ToUInt16(d, fmt + 14);
        if (format != 1 || bits != 16 || channels is < 1 or > 2 || rate <= 0)
            throw new InvalidDataException($"expected PCM16 mono/stereo WAV, got format {format}, {bits}-bit, {channels}ch @ {rate} Hz");
        int frames = Math.Min(dataSize, d.Length - data) / (2 * channels);
        if (frames == 0) throw new InvalidDataException("custom track WAV has no samples");

        int outputFrames = checked((int)Math.Round(frames * (TargetRate / (double)rate)));
        var output = new short[checked(outputFrames * 2)];
        for (int i = 0; i < outputFrames; i++)
        {
            double source = i * (rate / (double)TargetRate);
            int a = Math.Min((int)source, frames - 1);
            int b = Math.Min(a + 1, frames - 1);
            double t = source - a;
            for (int c = 0; c < 2; c++)
            {
                int srcChannel = channels == 1 ? 0 : c;
                short x = BitConverter.ToInt16(d, data + (a * channels + srcChannel) * 2);
                short y = BitConverter.ToInt16(d, data + (b * channels + srcChannel) * 2);
                output[i * 2 + c] = (short)Math.Clamp((int)Math.Round(x + (y - x) * t), short.MinValue, short.MaxValue);
            }
        }
        return (output, rate, channels);
    }

    private static void VerifyEncodedAudio(byte[] encoded, short[] source)
    {
        using var stream = new MemoryStream(encoded, writable: false);
        var decoder = new EAAudioHandler();
        decoder.Load(stream);
        short[] decoded = decoder.DecodeAudio();
        if (decoder.SampleRate != TargetRate || decoder.Channels != 2 || decoded.Length != source.Length)
            throw new InvalidDataException($"EA-XA verification shape mismatch: {decoder.SampleRate} Hz, " +
                $"{decoder.Channels}ch, {decoded.Length} samples (wanted {source.Length})");
        double signal = 0, noise = 0;
        for (int i = 0; i < source.Length; i++)
        {
            signal += (double)source[i] * source[i];
            double delta = source[i] - decoded[i];
            noise += delta * delta;
        }
        double snr = noise == 0 ? double.PositiveInfinity : 10 * Math.Log10(signal / noise);
        Log.Info($"  EA-XA encode verified: {encoded.Length:N0} bytes, {snr:0.0} dB round-trip SNR.");
    }

    private static string RestrictPlaylist(string text, string section, string song)
    {
        string current = "";
        bool wroteSong = false;
        var output = new List<string>();
        foreach (string raw in text.Replace("\r", "").Split('\n'))
        {
            var match = Regex.Match(raw, @"^\s*\[([^]]+)\]");
            if (match.Success) current = match.Groups[1].Value.Trim();
            if (current.Equals(section, StringComparison.OrdinalIgnoreCase) &&
                Regex.IsMatch(raw, @"^\s*SONG\s*=", RegexOptions.IgnoreCase))
            {
                if (!wroteSong) { output.Add($"    SONG = \"{song}\""); wroteSong = true; }
                continue;
            }
            output.Add(raw);
        }
        if (!wroteSong) throw new InvalidDataException($"could not rewrite MUSICMAP.INF [{section}]");
        return string.Join("\r\n", output);
    }

    private static string UpdateMusicSettings(string text, string section, Arrangement arrangement)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["ASYNCLEVEL"] = "0", ["DELAYCOUNT"] = "0", ["DELAYLEVEL"] = "0", ["DELAYFEEDBACK"] = "0",
            ["BPM"] = arrangement.Bpm.ToString("0.###", CultureInfo.InvariantCulture),
        };
        string current = "";
        var output = new List<string>();
        foreach (string raw in text.Replace("\r", "").Split('\n'))
        {
            var match = Regex.Match(raw, @"^\s*\[([^]]+)\]");
            if (match.Success) current = match.Groups[1].Value.Trim();
            if (current.Equals(section, StringComparison.OrdinalIgnoreCase))
            {
                var key = Regex.Match(raw, @"^\s*([A-Za-z]+)\s*=");
                if (key.Success && values.TryGetValue(key.Groups[1].Value, out string? value))
                {
                    output.Add($"     {key.Groups[1].Value.ToUpperInvariant()} = {value}");
                    continue;
                }
            }
            output.Add(raw);
        }
        return string.Join("\r\n", output);
    }

}
