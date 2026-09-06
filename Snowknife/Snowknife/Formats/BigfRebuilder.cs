namespace Snowknife.Formats;

/// <summary>
/// Streaming BIGF member replacer. MUSIC.BIG is roughly 451 MB, so rebuilding it by materializing every
/// member plus the input and output archives at once is needlessly expensive. This reader keeps only the
/// table in memory and copies untouched member ranges directly between files.
/// </summary>
internal static class BigfRebuilder
{
    internal sealed record Entry(string Path, uint Offset, uint Size);

    public static (string Path, byte[] Data) ReadMember(string archivePath, string memberName)
    {
        using var input = File.OpenRead(archivePath);
        var entries = ReadTable(input);
        var hit = entries.FirstOrDefault(e =>
            e.Path.Equals(memberName, StringComparison.OrdinalIgnoreCase) ||
            BigfPaths.FileName(e.Path).Equals(memberName, StringComparison.OrdinalIgnoreCase));
        if (hit == null) throw new FileNotFoundException($"{memberName} not found in {archivePath}");
        input.Position = hit.Offset;
        var data = new byte[hit.Size];
        input.ReadExactly(data);
        return (hit.Path, data);
    }

    /// <summary>Rebuild <paramref name="sourcePath"/> with the named members replaced. Replacement keys may
    /// be full BIG paths or unique basenames. Member order and untouched bytes are preserved.</summary>
    public static void ReplaceMembers(string sourcePath, string outputPath,
                                      IReadOnlyDictionary<string, byte[]> replacements)
    {
        using var input = File.OpenRead(sourcePath);
        var entries = ReadTable(input);
        var resolved = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
        foreach (var (name, data) in replacements)
        {
            var hits = entries.Where(e =>
                e.Path.Equals(name, StringComparison.OrdinalIgnoreCase) ||
                BigfPaths.FileName(e.Path).Equals(name, StringComparison.OrdinalIgnoreCase)).ToList();
            if (hits.Count != 1)
                throw new InvalidDataException(hits.Count == 0
                    ? $"replacement member {name} is absent from MUSIC.BIG"
                    : $"replacement member {name} is ambiguous in MUSIC.BIG");
            resolved[hits[0].Path] = data;
        }

        int headerSize = 16 + entries.Sum(e => 8 + System.Text.Encoding.ASCII.GetByteCount(e.Path) + 1);
        var offsets = new long[entries.Count];
        long cursor = headerSize;
        ulong memberBytes = 0;
        for (int i = 0; i < entries.Count; i++)
        {
            cursor = Align(cursor, 128);
            offsets[i] = cursor;
            long size = resolved.TryGetValue(entries[i].Path, out var replacement)
                ? replacement.LongLength : entries[i].Size;
            cursor += size;
            memberBytes += (ulong)size;
        }
        if (cursor > uint.MaxValue || memberBytes + (ulong)headerSize > uint.MaxValue)
            throw new InvalidDataException("BIGF output exceeds the 32-bit container limit");

        using var output = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.None);
        WriteAscii(output, "BIGF");
        WriteBE32(output, (uint)(memberBytes + (ulong)headerSize));
        WriteBE32(output, (uint)entries.Count);
        WriteBE32(output, (uint)headerSize);
        for (int i = 0; i < entries.Count; i++)
        {
            byte[]? replacement = resolved.GetValueOrDefault(entries[i].Path);
            uint size = checked((uint)(replacement?.LongLength ?? entries[i].Size));
            WriteBE32(output, checked((uint)offsets[i]));
            WriteBE32(output, size);
            WriteAscii(output, entries[i].Path);
            output.WriteByte(0);
        }

        var buffer = new byte[1024 * 1024];
        for (int i = 0; i < entries.Count; i++)
        {
            output.Position = offsets[i];
            if (resolved.TryGetValue(entries[i].Path, out var replacement))
            {
                output.Write(replacement);
                continue;
            }

            input.Position = entries[i].Offset;
            long left = entries[i].Size;
            while (left > 0)
            {
                int take = (int)Math.Min(left, buffer.Length);
                int read = input.Read(buffer, 0, take);
                if (read != take) throw new EndOfStreamException($"truncated BIGF member {entries[i].Path}");
                output.Write(buffer, 0, read);
                left -= read;
            }
        }
        output.SetLength(cursor);
    }

    private static List<Entry> ReadTable(Stream input)
    {
        Span<byte> magic = stackalloc byte[4];
        input.ReadExactly(magic);
        if (!magic.SequenceEqual("BIGF"u8)) throw new InvalidDataException("not a BIGF archive");
        _ = ReadBE32(input); // logical archive size
        uint count = ReadBE32(input);
        _ = ReadBE32(input); // header size
        var entries = new List<Entry>(checked((int)count));
        for (uint i = 0; i < count; i++)
        {
            uint offset = ReadBE32(input);
            uint size = ReadBE32(input);
            var name = new List<byte>();
            int b;
            while ((b = input.ReadByte()) > 0) name.Add((byte)b);
            if (b < 0) throw new EndOfStreamException("truncated BIGF member table");
            entries.Add(new Entry(System.Text.Encoding.ASCII.GetString(name.ToArray()), offset, size));
        }
        return entries;
    }

    private static long Align(long value, int alignment) => (value + alignment - 1) / alignment * alignment;

    private static uint ReadBE32(Stream input)
    {
        Span<byte> b = stackalloc byte[4];
        input.ReadExactly(b);
        return ((uint)b[0] << 24) | ((uint)b[1] << 16) | ((uint)b[2] << 8) | b[3];
    }

    private static void WriteBE32(Stream output, uint value)
    {
        Span<byte> b = stackalloc byte[4]
        {
            (byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value,
        };
        output.Write(b);
    }

    private static void WriteAscii(Stream output, string text) =>
        output.Write(System.Text.Encoding.ASCII.GetBytes(text));
}
