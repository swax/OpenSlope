namespace Snowknife.Formats;

/// <summary>
/// Verbatim BIGF round-tripper for AUDIO.BIG. Retail layout (measured on the shipped archive): "BIGF",
/// u32 BE size field = headerSize + Σ member sizes, u32 BE member count, u32 BE headerSize (= table end),
/// then per member {u32 BE offset, u32 BE size, ASCIIZ path with backslashes}; member data 128-aligned in
/// table order, zero gap fill, file ends at the last member's final byte. Members are stored RAW (the .bnk
/// bytes directly, no RefPack). A no-change Load→Write reproduces the shipped archive byte-for-byte.
///
/// <see cref="BigfRebuilder"/> is the streaming counterpart for archives too large to materialize (MUSIC.BIG).
/// </summary>
internal sealed class BigfArchive
{
    internal sealed class Member
    {
        public string Path = "";
        public byte[] Data = Array.Empty<byte>();
    }

    public List<Member> Members = new();

    private static uint ReadBE(byte[] d, int at) =>
        (uint)((d[at] << 24) | (d[at + 1] << 16) | (d[at + 2] << 8) | d[at + 3]);

    private static void WriteBE(byte[] d, int at, uint value)
    {
        d[at] = (byte)(value >> 24); d[at + 1] = (byte)(value >> 16);
        d[at + 2] = (byte)(value >> 8); d[at + 3] = (byte)value;
    }

    public static BigfArchive Load(byte[] d)
    {
        if (d.Length < 16 || d[0] != 'B' || d[1] != 'I' || d[2] != 'G' || d[3] != 'F')
            throw new InvalidDataException("not a BIGF archive");
        var archive = new BigfArchive();
        uint count = ReadBE(d, 8);
        int at = 16;
        for (uint i = 0; i < count; i++)
        {
            // Count, offset, size and the name's terminator are all numbers the FILE supplies. Untrusted, a
            // truncated archive surfaces as an IndexOutOfRangeException or a slice error naming neither the
            // archive nor the member — and AUDIO.BIG is rebuilt by this tool, so a bug in the WRITER lands
            // here first and wants to be legible.
            if (at + 8 > d.Length)
                throw new InvalidDataException($"BIGF: the entry table ends mid-record at member {i} of "
                    + $"{count}, {d.Length:N0} bytes in");
            uint offset = ReadBE(d, at), size = ReadBE(d, at + 4);
            int end = at + 8;
            while (end < d.Length && d[end] != 0) end++;
            if (end >= d.Length)
                throw new InvalidDataException($"BIGF: member {i} of {count} has an unterminated name");
            string path = System.Text.Encoding.ASCII.GetString(d, at + 8, end - (at + 8));
            if (offset > (uint)d.Length || size > (uint)d.Length - offset)
                throw new InvalidDataException($"BIGF: member \"{path}\" claims {size:N0} bytes at offset "
                    + $"{offset:N0}, past the end of a {d.Length:N0}-byte archive");
            archive.Members.Add(new Member
            {
                Path = path,
                Data = d[(int)offset..(int)(offset + size)],
            });
            at = end + 1;
        }
        return archive;
    }

    public byte[] Write()
    {
        int headerSize = 16 + Members.Sum(m => 8 + m.Path.Length + 1);
        var offsets = new int[Members.Count];
        int cursor = headerSize;
        for (int i = 0; i < Members.Count; i++)
        {
            cursor = (cursor + 127) / 128 * 128;
            offsets[i] = cursor;
            cursor += Members[i].Data.Length;
        }
        var output = new byte[cursor];
        output[0] = (byte)'B'; output[1] = (byte)'I'; output[2] = (byte)'G'; output[3] = (byte)'F';
        WriteBE(output, 4, (uint)(headerSize + Members.Sum(m => m.Data.Length)));
        WriteBE(output, 8, (uint)Members.Count);
        WriteBE(output, 12, (uint)headerSize);
        int at = 16;
        for (int i = 0; i < Members.Count; i++)
        {
            WriteBE(output, at, (uint)offsets[i]);
            WriteBE(output, at + 4, (uint)Members[i].Data.Length);
            at += 8;
            foreach (char c in Members[i].Path) output[at++] = (byte)c;
            output[at++] = 0;
            Members[i].Data.CopyTo(output, offsets[i]);
        }
        return output;
    }
}
