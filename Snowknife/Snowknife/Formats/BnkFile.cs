namespace Snowknife.Formats;

/// <summary>
/// BNKl bank reader/writer for course-bank slot injection [Trailmap: 260-audio-files]. The library's
/// BnkHandler decodes banks to PCM; this class instead keeps every sound's patch-tag header records and raw
/// codec bytes VERBATIM, so a rebuilt bank is faithful for untouched slots: unknown header bytes (8..19),
/// unknown tags (0x06/0x11/0x8A…) and each sound's platform dword are preserved as read, and only the
/// 0x88/0x89 channel-offset values are rewritten to the sound's new absolute position. Written layout
/// mirrors the shipped banks (verified on mesabanca1.bnk): header block, slot table of self-relative u32 LE
/// entries (0 = empty slot), 4-aligned patch headers, then the 16-aligned sample data region.
/// </summary>
internal sealed class BnkFile
{
    internal sealed class TagRecord
    {
        public byte Tag;
        /// <summary>Payload bytes (big-endian value), empty for the payload-less 0xFC/0xFD info markers.</summary>
        public byte[] Value = Array.Empty<byte>();
        public bool Marker;
    }

    internal sealed class Sound
    {
        public byte[] PlatformDword = { 0x50, 0x54, 0x05, 0x00 };   // "PT" + platform 5 (PS2)
        public byte Terminator = 0xFF;
        public List<TagRecord> Tags = new();
        /// <summary>Raw codec bytes per channel (PS-ADPCM 16-byte frames for the default codec).</summary>
        public List<byte[]> ChannelData = new();
        public int SampleCount, SampleRate = 22050, Channels = 1, Codec = 0x05;
    }

    /// <summary>Bytes 0..tableOffset verbatim — magic, version, count (patched on write), unknowns 8..19.</summary>
    public byte[] HeaderBytes = Array.Empty<byte>();
    public int Version;
    public List<Sound?> Slots = new();

    private static int BigEndian(byte[] v)
    {
        int result = 0;
        foreach (byte b in v) result = (result << 8) | b;
        return result;
    }

    private static byte[] BigEndianBytes(int value, int size)
    {
        var outBytes = new byte[size];
        for (int i = size - 1; i >= 0; i--) { outBytes[i] = (byte)(value & 0xFF); value >>= 8; }
        return outBytes;
    }

    private static int MinimalSize(int value) => value <= 0xFF ? 1 : value <= 0xFFFF ? 2 : value <= 0xFFFFFF ? 3 : 4;

    public static BnkFile Load(byte[] d)
    {
        if (d.Length < 8 || d[0] != 'B' || d[1] != 'N' || d[2] != 'K') throw new InvalidDataException("not a BNKl bank");
        var bnk = new BnkFile { Version = d[4] };
        int count = d[6] | (d[7] << 8);
        int tableOffset = bnk.Version == 2 ? 0x0C : 0x14;
        // A count and a version are numbers the FILE supplies, so neither is allowed to index past the buffer
        // on its own word. A truncated bank should say which structure ran out and where, rather than raising
        // an IndexOutOfRangeException that names no file and no offset.
        if (d.Length < tableOffset)
            throw new InvalidDataException($"BNKl v{bnk.Version}: the header needs {tableOffset} bytes and the "
                + $"bank is {d.Length}");
        if (tableOffset + 4L * count > d.Length)
            throw new InvalidDataException($"BNKl: the slot table claims {count} slots, which runs to "
                + $"{tableOffset + 4L * count:N0} bytes past the end of a {d.Length:N0}-byte bank");
        bnk.HeaderBytes = d[..tableOffset];
        for (int i = 0; i < count; i++)
        {
            int entryPos = tableOffset + 4 * i;
            uint rel = (uint)(d[entryPos] | (d[entryPos + 1] << 8) | (d[entryPos + 2] << 16) | (d[entryPos + 3] << 24));
            if (rel == 0) { bnk.Slots.Add(null); continue; }
            long headerOffset = entryPos + rel;
            if (headerOffset < 0 || headerOffset + 4 > d.Length) { bnk.Slots.Add(null); continue; }
            bnk.Slots.Add(ParseSound(d, (int)headerOffset));
        }
        return bnk;
    }

    private static Sound ParseSound(byte[] d, int pos)
    {
        var sound = new Sound { PlatformDword = d[pos..(pos + 4)] };
        pos += 4;
        var channelOffsets = new List<int>();
        while (pos < d.Length)
        {
            byte tag = d[pos++];
            if (tag is 0xFF or 0xFE) { sound.Terminator = tag; break; }
            if (tag is 0xFC or 0xFD) { sound.Tags.Add(new TagRecord { Tag = tag, Marker = true }); continue; }
            if (pos >= d.Length)
                throw new InvalidDataException($"BNKl: tag 0x{tag:X2} at {pos - 1:N0} has no length byte — the "
                    + "bank ends mid-tag");
            byte size = d[pos++];
            if (pos + size > d.Length)
                throw new InvalidDataException($"BNKl: tag 0x{tag:X2} at {pos - 2:N0} declares {size} byte(s) "
                    + $"and only {d.Length - pos} remain");
            var value = d[pos..(pos + size)];
            pos += size;
            sound.Tags.Add(new TagRecord { Tag = tag, Value = value });
            switch (tag)
            {
                case 0x82: sound.Channels = BigEndian(value); break;
                case 0x84: sound.SampleRate = BigEndian(value); break;
                case 0x85: sound.SampleCount = BigEndian(value); break;
                case 0xA0: sound.Codec = BigEndian(value); break;
                case 0x88: channelOffsets.Insert(0, BigEndian(value)); break;
                case 0x89: channelOffsets.Add(BigEndian(value)); break;
            }
        }
        // The sample count is file-supplied and the frame maths multiplies it, so the length is computed in
        // LONG and range-checked before it is ever an int: in int it overflows to a negative length, which
        // slips past an `offset + length > Length` test and fails later as an unexplained slice error.
        if (sound.SampleCount < 0)
            throw new InvalidDataException($"BNKl: a sound declares {sound.SampleCount:N0} samples");
        long frames = ((long)sound.SampleCount + 27) / 28;
        long channelBytes = sound.Codec switch
        {
            0x05 => frames * 16,
            0x0A => frames * 15,
            0x09 => sound.SampleCount,
            _ => throw new InvalidDataException($"bank sound carries unsupported codec 0x{sound.Codec:X2}"),
        };
        foreach (int offset in channelOffsets)
        {
            if (offset < 0 || offset + channelBytes > d.Length)
                throw new InvalidDataException($"BNKl: a sound's channel data is {channelBytes:N0} bytes at "
                    + $"offset {offset:N0}, past the end of a {d.Length:N0}-byte bank");
            sound.ChannelData.Add(d[offset..(int)(offset + channelBytes)]);
        }
        return sound;
    }

    /// <summary>A fresh mono PS-ADPCM sound in the shipped banks' own tag layout (mesabanca1 exemplar:
    /// 06, 11, FD, 80, 85, 84, 88, FC, 8A, FF — no 0x82/0xA0, so the engine's mono/PS-ADPCM defaults apply).
    ///
    /// A sustaining sound additionally carries the SPU loop region as 0x86/0x87 (loop start/end in samples),
    /// which is what every retail slot driving a continuing emitter has and no retail one-shot does — the
    /// exemplar is merqurycity1 slot 24, `06 80 85 84 86 87 88 8A`, so the pair sits after 0x84 and before
    /// 0x88. The frame flags PsAdpcmEncoder writes have to describe the same region; pass both the same
    /// numbers.</summary>
    public static Sound BuildPsAdpcm(byte[] frames, int sampleCount, int sampleRate,
                                     int loopStartSample = -1, int loopEndSample = -1)
    {
        var sound = new Sound
        {
            SampleCount = sampleCount,
            SampleRate = sampleRate,
            ChannelData = { frames },
            Tags =
            {
                new TagRecord { Tag = 0x06, Value = new byte[] { 0x5A } },
                new TagRecord { Tag = 0x11, Value = new byte[] { 0x00, 0xC8 } },
                new TagRecord { Tag = 0xFD, Marker = true },
                new TagRecord { Tag = 0x80, Value = new byte[] { 0x02 } },
                new TagRecord { Tag = 0x85, Value = BigEndianBytes(sampleCount, MinimalSize(sampleCount)) },
                new TagRecord { Tag = 0x84, Value = BigEndianBytes(sampleRate, MinimalSize(sampleRate)) },
            },
        };
        if (loopStartSample >= 0 && loopEndSample > loopStartSample)
        {
            sound.Tags.Add(new TagRecord { Tag = 0x86, Value = BigEndianBytes(loopStartSample, MinimalSize(loopStartSample)) });
            sound.Tags.Add(new TagRecord { Tag = 0x87, Value = BigEndianBytes(loopEndSample, MinimalSize(loopEndSample)) });
        }
        sound.Tags.Add(new TagRecord { Tag = 0x88, Value = new byte[4] });
        sound.Tags.Add(new TagRecord { Tag = 0xFC, Marker = true });
        sound.Tags.Add(new TagRecord { Tag = 0x8A, Value = new byte[4] });
        return sound;
    }

    public byte[] Write()
    {
        static int Align(int at, int to) => (at + to - 1) / to * to;
        int tableStart = HeaderBytes.Length;
        // header sizes with 0x88/0x89 re-emitted as 4-byte values (offsets into the rebuilt file)
        int HeaderSize(Sound s) => 4
            + s.Tags.Sum(t => t.Marker ? 1 : 2 + (t.Tag is 0x88 or 0x89 ? 4 : t.Value.Length)) + 1;

        var headerPos = new int[Slots.Count];
        int cursor = Align(tableStart + 4 * Slots.Count, 4);
        for (int i = 0; i < Slots.Count; i++)
        {
            if (Slots[i] == null) continue;
            headerPos[i] = cursor;
            cursor = Align(cursor + HeaderSize(Slots[i]!), 4);
        }
        // Shipped banks SHARE sample data between slots: garibaldi1's slots 50 and 51 are two headers over one
        // 17,856-byte run, and they are not the only pair on the disc. Writing a private copy per slot is
        // semantically identical and structurally not — it grows a no-op rebuild of that bank by exactly those
        // 17,856 bytes. Emit each distinct run once and let the headers point at it, so a rebuilt bank keeps
        // the shipped layout rather than merely the shipped meaning.
        var written = new Dictionary<string, int>(StringComparer.Ordinal);
        var channelPos = new int[Slots.Count][];
        cursor = Align(cursor, 16);
        for (int i = 0; i < Slots.Count; i++)
        {
            var sound = Slots[i];
            if (sound == null) continue;
            channelPos[i] = new int[sound.ChannelData.Count];
            for (int c = 0; c < sound.ChannelData.Count; c++)
            {
                string key = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(sound.ChannelData[c]));
                if (written.TryGetValue(key, out int shared))
                {
                    channelPos[i][c] = shared;
                    continue;
                }
                written[key] = channelPos[i][c] = cursor;
                cursor = Align(cursor + sound.ChannelData[c].Length, 16);
            }
        }

        var output = new byte[cursor];
        HeaderBytes.CopyTo(output, 0);
        output[6] = (byte)(Slots.Count & 0xFF);
        output[7] = (byte)((Slots.Count >> 8) & 0xFF);
        for (int i = 0; i < Slots.Count; i++)
        {
            int entryPos = tableStart + 4 * i;
            uint rel = Slots[i] == null ? 0 : (uint)(headerPos[i] - entryPos);
            output[entryPos] = (byte)rel;
            output[entryPos + 1] = (byte)(rel >> 8);
            output[entryPos + 2] = (byte)(rel >> 16);
            output[entryPos + 3] = (byte)(rel >> 24);
        }
        for (int i = 0; i < Slots.Count; i++)
        {
            var sound = Slots[i];
            if (sound == null) continue;
            int at = headerPos[i];
            sound.PlatformDword.CopyTo(output, at);
            at += 4;
            foreach (var record in sound.Tags)
            {
                output[at++] = record.Tag;
                if (record.Marker) continue;
                // 0x88 = channel-0 data offset, 0x89 = channel-1 [Trailmap: 260-audio-files]
                byte[] value = record.Tag is 0x88 or 0x89
                    ? BigEndianBytes(channelPos[i][record.Tag == 0x88 ? 0 : 1], 4)
                    : record.Value;
                output[at++] = (byte)value.Length;
                value.CopyTo(output, at);
                at += value.Length;
            }
            output[at] = sound.Terminator;
            for (int c = 0; c < sound.ChannelData.Count; c++)
                sound.ChannelData[c].CopyTo(output, channelPos[i][c]);
        }
        return output;
    }
}
