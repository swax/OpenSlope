using System.Text;
using Newtonsoft.Json;
using SSXLibrary.FileHandlers.Audio;

namespace Snowknife.Export;

/// <summary>
/// EA PathFinder interactive race music (MPF v3.1 graph + MUS chunk stream), the system SSX Tricky
/// plays DURING a race. Per song: data\audio\&lt;name&gt;.mpf is a node graph (each node = one short
/// EA-XA SCHl chunk in the .mus plus links to the nodes that may follow it), and the runtime walks
/// the graph chunk-by-chunk, choosing links from game state - that's how the music follows the
/// riding. data/config/musicmap.inf lists each track's songs (a track name -> its song list);
/// data/config/music.inf carries per-song BPM/levels and the .mpf/.mus member names.
/// The per-level &lt;LEVEL&gt;.BIG A/B/C stems are the START-GATE INTRO music (intromus.inf), not this.
///
/// MPF v3.1 layout (validated against vgmstream's ea_schl_map_mpf_mus parser and topbomb/hiphop/
/// bassinvader: every sample offset lands on an SCHl header):
///   0x00 'PFDx', 0x04 ver=3, 0x05 sub=1, 0x0d tracks, 0x0e sections, 0x0f events, 0x10 routers,
///   0x11 vars, 0x12 u16 nodes; node-offset table (u16 x nodes, each *4) at 0x24. Node entry =
///   12-byte header (+0x00 u16 sample index, 0xffff = logic node; +0x0b u8 link count) + links
///   (u32 each, next-node id in the high u16). After the last node: the event table
///   (events*tracks*sections bytes, 4-aligned), routers (u32 x routers), vars (u32 x vars), then a
///   u32 pointer (*4) to the track table; the samples table (u32 mus-offset*4 + u32 meta per
///   stream) runs from there to EOF.
/// </summary>
internal static class MusicExporter
{
    // ------------------------------------------------------------------ MPF ----

    internal sealed class MpfNode
    {
        public int Index;
        public int Offset;               // byte offset of this variable-length node record in the MPF
        public int Sample = -1;          // samples-table index this node plays (-1 = logic node)
        public int Flags;                // header byte +0x03 (0x81 observed on the entry node)
        public uint Word1;               // header u32 +0x04 (track/section bytes; see [Trailmap: 270-music-graph])
        public uint Word2;               // header u32 +0x08 (byte 3 = link count)
        public List<int> Links = new();  // next-node candidates (subentry high u16)
        public List<uint> LinkRaw = new();
    }

    internal sealed class MpfFile
    {
        public int Version, SubVersion, NumTracks, NumSections, NumEvents, NumRouters, NumVars;
        public int EventTableOffset, RoutersOffset;
        public List<MpfNode> Nodes = new();
        public byte[] EventTable = Array.Empty<byte>();
        public List<uint> Routers = new();
        public List<uint> Vars = new();
        public List<(long Offset, uint Meta)> Samples = new();

        public static MpfFile Parse(byte[] d)
        {
            if (d.Length < 0x24 || d[0] != 'x' || d[1] != 'D' || d[2] != 'F' || d[3] != 'P')
                throw new InvalidDataException("not an MPF (PFDx) file");
            var m = new MpfFile
            {
                Version = d[4], SubVersion = d[5],
                NumTracks = d[0x0d], NumSections = d[0x0e], NumEvents = d[0x0f],
                NumRouters = d[0x10], NumVars = d[0x11],
            };
            if (m.Version != 3)
                throw new InvalidDataException($"MPF v{m.Version}.{m.SubVersion} - only v3 (SSX Tricky) is handled");
            int numNodes = BitConverter.ToUInt16(d, 0x12);

            int nodeTable = 0x24;
            int lastEntry = 0;
            for (int i = 0; i < numNodes; i++)
            {
                int eo = BitConverter.ToUInt16(d, nodeTable + i * 2) * 4;
                var n = new MpfNode
                {
                    Index = i,
                    Offset = eo,
                    Sample = BitConverter.ToUInt16(d, eo),
                    Flags = d[eo + 3],
                    Word1 = BitConverter.ToUInt32(d, eo + 4),
                    Word2 = BitConverter.ToUInt32(d, eo + 8),
                };
                if (n.Sample == 0xffff) n.Sample = -1;
                int linkCount = d[eo + 0x0b];
                for (int k = 0; k < linkCount; k++)
                {
                    uint raw = BitConverter.ToUInt32(d, eo + 0x0c + k * 4);
                    n.LinkRaw.Add(raw);
                    n.Links.Add((int)(raw >> 16));
                }
                m.Nodes.Add(n);
                if (i == numNodes - 1) lastEntry = eo + 0x0c + linkCount * 4;
            }

            int evBytes = m.NumEvents * m.NumTracks * m.NumSections;
            m.EventTableOffset = lastEntry;
            m.EventTable = d.Skip(lastEntry).Take(evBytes).ToArray();
            int p = lastEntry + ((evBytes + 3) & ~3);
            m.RoutersOffset = p;
            for (int i = 0; i < m.NumRouters; i++, p += 4) m.Routers.Add(BitConverter.ToUInt32(d, p));
            for (int i = 0; i < m.NumVars; i++, p += 4) m.Vars.Add(BitConverter.ToUInt32(d, p));

            int tracksTable = (int)BitConverter.ToUInt32(d, p) * 4;
            int samplesTable = tracksTable + m.NumTracks * 4;
            for (int o = samplesTable; o + 8 <= d.Length; o += 8)
                m.Samples.Add((BitConverter.ToUInt32(d, o) * 4L, BitConverter.ToUInt32(d, o + 4)));
            return m;
        }
    }

    // ---------------------------------------------------------------- export ----

    /// <summary>
    /// Decode a level's PathFinder race songs: musicmap.inf names the songs, music.inf names each
    /// song's .mpf/.mus (inside DATA\AUDIO\MUSIC.BIG) - every graph chunk becomes
    /// &lt;outDir&gt;/Audio/Music/&lt;song&gt;/chunk_NNN.wav next to a &lt;song&gt;.graph.json carrying
    /// the full node graph (links, event table, routers) for the engine-side director. Returns the
    /// number of songs exported. <paramref name="musicBigDir"/> = the unpacked MUSIC.BIG members.
    /// </summary>
    public static int ExportSongs(string musicMapInf, string musicInf, string musicBigDir,
                                  string levelKey, string outDir)
    {
        var map = ParseInf(File.ReadAllText(musicMapInf));
        var inf = ParseInf(File.ReadAllText(musicInf));

        // musicmap section for the level (the section name may not exactly match the level key -
        // a prefix match on either side tolerates spelling variants between the two).
        string? mapSection = map.Keys.FirstOrDefault(k =>
            k.StartsWith(levelKey, StringComparison.OrdinalIgnoreCase) ||
            levelKey.StartsWith(k, StringComparison.OrdinalIgnoreCase));
        if (mapSection == null) { Log.Info($"  (musicmap.inf has no section for '{levelKey}')"); return 0; }

        int exported = 0;
        var playlist = new List<string>();   // song folder names in musicmap order (index 0 = the level's lead)
        foreach ((string key, string val) in map[mapSection])
        {
            if (!key.Equals("SONG", StringComparison.OrdinalIgnoreCase)) continue;
            // The short name selects the first music.inf section containing it ("Top" -> [Top Bomb]).
            string? songSection = inf.Keys.FirstOrDefault(k =>
                k.Contains(val, StringComparison.OrdinalIgnoreCase));
            if (songSection == null) { Log.Warn($"  ! no music.inf entry matches song '{val}'"); continue; }

            var entries = inf[songSection];
            string? mpfName = entries.FirstOrDefault(e => e.Key.Equals("PATHDATA", StringComparison.OrdinalIgnoreCase)).Value;
            string? musName = entries.FirstOrDefault(e => e.Key.Equals("MUSDATA", StringComparison.OrdinalIgnoreCase)).Value;
            string bpm = entries.FirstOrDefault(e => e.Key.Equals("BPM", StringComparison.OrdinalIgnoreCase)).Value ?? "120";
            if (mpfName == null || musName == null) { Log.Warn($"  ! [{songSection}] lacks PATHDATA/MUSDATA"); continue; }

            string? mpfPath = Directory.GetFiles(musicBigDir, mpfName, SearchOption.AllDirectories).FirstOrDefault();
            string? musPath = Directory.GetFiles(musicBigDir, musName, SearchOption.AllDirectories).FirstOrDefault();
            if (mpfPath == null || musPath == null) { Log.Warn($"  ! {mpfName}/{musName} not in MUSIC.BIG"); continue; }

            string songDir = Path.Combine(outDir, "Audio", "Music", Path.GetFileNameWithoutExtension(mpfName));
            ExportSong(songSection, val, double.Parse(bpm, System.Globalization.CultureInfo.InvariantCulture),
                       mpfPath, musPath, songDir);
            playlist.Add(Path.GetFileNameWithoutExtension(mpfName)!);
            exported++;
        }

        // playlist.json lets the importer pick the level's lead song generically (musicmap order), no per-level names.
        if (playlist.Count > 0)
            File.WriteAllText(Path.Combine(outDir, "Audio", "Music", "playlist.json"),
                              JsonConvert.SerializeObject(playlist, Formatting.Indented));
        return exported;
    }

    static void ExportSong(string title, string shortName, double bpm, string mpfPath, string musPath, string songDir)
    {
        var mpf = MpfFile.Parse(File.ReadAllBytes(mpfPath));
        Directory.CreateDirectory(songDir);

        using var mus = File.OpenRead(musPath);
        var sampleInfos = new List<object>();
        int written = 0;
        for (int i = 0; i < mpf.Samples.Count; i++)
        {
            (long off, uint meta) = mpf.Samples[i];
            mus.Position = off;
            var h = new EAAudioHandler();
            h.Load(mus);
            short[] pcm = h.DecodeAudio();
            string wav = $"chunk_{i:D3}.wav";
            AudioExporter.WriteWav(Path.Combine(songDir, wav), pcm, h.SampleRate, h.Channels);
            int frames = h.Channels > 0 ? pcm.Length / h.Channels : pcm.Length;
            sampleInfos.Add(new
            {
                Index = i, Wav = wav, MusOffset = off, Meta = meta,
                Samples = frames, Rate = h.SampleRate, Channels = h.Channels,
                Seconds = h.SampleRate > 0 ? frames / (double)h.SampleRate : 0,
            });
            written++;
        }

        var graph = new
        {
            Song = title,
            Short = shortName,
            Bpm = bpm,
            Tracks = mpf.NumTracks,
            Sections = mpf.NumSections,
            Events = mpf.NumEvents,
            EventTable = mpf.EventTable,
            Routers = mpf.Routers,
            Vars = mpf.Vars,
            Nodes = mpf.Nodes.Select(n => new
            {
                n.Index, n.Sample, n.Flags, n.Word1, n.Word2, n.Links, n.LinkRaw,
            }),
            Samples = sampleInfos,
        };
        File.WriteAllText(Path.Combine(songDir, "graph.json"),
                          JsonConvert.SerializeObject(graph, Formatting.Indented));
        Log.Info($"  {title,-28} {mpf.Nodes.Count} nodes / {written} chunks -> {songDir}");
    }

    // ------------------------------------------------------------ INF parse ----

    /// <summary>
    /// Minimal parser for the game's .INF config dialect: [SECTION] headers, KEY = "value" /
    /// KEY = number lines, bare switch words (stored with an empty value), # comments. Keys repeat
    /// (SONG = ... lists), so sections hold ordered key/value lists, not dictionaries.
    /// </summary>
    internal static Dictionary<string, List<(string Key, string Value)>> ParseInf(string text)
    {
        var sections = new Dictionary<string, List<(string, string)>>(StringComparer.OrdinalIgnoreCase);
        string current = "";
        foreach (string rawLine in text.Replace("\r", "").Split('\n'))
        {
            string line = rawLine;
            int hash = line.IndexOf('#');
            if (hash >= 0) line = line.Substring(0, hash);
            line = line.Trim();
            if (line.Length == 0) continue;
            if (line.StartsWith('[') && line.EndsWith(']'))
            {
                current = line.Substring(1, line.Length - 2).Trim();
                if (!sections.ContainsKey(current)) sections[current] = new List<(string, string)>();
                continue;
            }
            if (current.Length == 0) continue;
            int eq = line.IndexOf('=');
            if (eq < 0) { sections[current].Add((line, "")); continue; }   // bare switch (EIGHTH etc.)
            string key = line.Substring(0, eq).Trim();
            string val = line.Substring(eq + 1).Trim().Trim('"');
            sections[current].Add((key, val));
        }
        return sections;
    }
}
