namespace Snowknife.Formats;

/// <summary>
/// Minimal SHPS (PS2 old-variant) reader + <b>verbatim</b> page installer. Works purely at the byte level:
/// a borrowed page is the donor image's exact on-disc chunk chain (image chunk + palette + long-name +
/// <c>Buy ERTS</c> terminator), copied unchanged. No decode / re-encode — that is the whole point, since
/// earlier re-encoded 8-bit pages were not displayed by the PS2 uploader (Slopesmith docs/011 Phase 2,
/// [Trailmap: 210-textures-ssh]). Borrowed pages therefore always use this verbatim path; custom pages can use
/// either the type-5 or retail-shaped type-2 encoder before installation.
///
/// Container (little-endian): [magic "SHPS"@0][u32 fileSize@4][u32 imageCount@8][4-char creator@12], then
/// imageCount × 8-byte directory entries (4-char shortname + u32 absolute offset to the image's chunk list),
/// then the image data region. An image's byte extent is the gap to the next entry's offset (or EOF for the
/// last), which spans its whole chunk chain incl. the trailing marker — exactly what a verbatim copy wants.
/// Every image on the baseline disc starts 16-byte aligned; the splice preserves that.
/// </summary>
public sealed class SshBank
{
    public const string Magic = "SHPS";
    public byte[] Bytes { get; private init; } = System.Array.Empty<byte>();
    public int Count { get; private init; }
    /// <summary>Directory: 4-char shortname + absolute byte offset of each image's chunk chain, in order.</summary>
    public IReadOnlyList<(string Name, int Off)> Dir { get; private init; } = System.Array.Empty<(string, int)>();

    private static int U32(byte[] b, int p) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24);
    private static void PutU32(byte[] b, int p, int v)
    { b[p] = (byte)v; b[p + 1] = (byte)(v >> 8); b[p + 2] = (byte)(v >> 16); b[p + 3] = (byte)(v >> 24); }

    public static SshBank Load(string path) => Load(File.ReadAllBytes(path));

    public static SshBank Load(byte[] b)
    {
        if (b.Length < 16 || System.Text.Encoding.ASCII.GetString(b, 0, 4) != Magic)
            throw new InvalidDataException($"not an SHPS bank (magic '{(b.Length >= 4 ? System.Text.Encoding.ASCII.GetString(b, 0, 4) : "?")}')");
        int count = U32(b, 8);
        var dir = new List<(string, int)>(count);
        for (int i = 0; i < count; i++)
        {
            int p = 16 + i * 8;
            dir.Add((System.Text.Encoding.ASCII.GetString(b, p, 4), U32(b, p + 4)));
        }
        return new SshBank { Bytes = b, Count = count, Dir = dir };
    }

    /// <summary>Byte extent [off, off+len) of image i — its full chunk chain, verbatim.</summary>
    public (int off, int len) Extent(int i)
    {
        int off = Dir[i].Off;
        int end = i + 1 < Count ? Dir[i + 1].Off : Bytes.Length;
        return (off, end - off);
    }

    /// <summary>The verbatim chunk-chain bytes of image i.</summary>
    public byte[] PageBytes(int i)
    {
        var (off, len) = Extent(i);
        return Bytes.AsSpan(off, len).ToArray();
    }

    /// <summary>Directory index of the image with the given 4-char shortname ("0071"), or -1.</summary>
    public int IndexOfName(string name)
    {
        string want = name.Length > 4 ? name[..4] : name.PadLeft(4, '0');
        for (int i = 0; i < Count; i++) if (Dir[i].Name == want) return i;
        return -1;
    }

    private static int Align16(int n) => (n + 15) & ~15;

    private static byte[] Pad16(byte[] blob)
    {
        int padded = Align16(blob.Length);
        if (padded == blob.Length) return blob;
        var buf = new byte[padded];
        System.Array.Copy(blob, buf, blob.Length);
        return buf;
    }

    /// <summary>
    /// Replace selected directory slots with new page chunk chains while keeping the directory count and every
    /// untouched page's bytes unchanged. Page lengths may differ: the directory offsets are rebuilt and each
    /// replacement is padded so all pages remain 16-byte aligned. The header creator, shortnames and the bytes
    /// between the directory and first page are retained verbatim. Replacing zero pages reproduces the input
    /// byte-for-byte.
    /// </summary>
    public static byte[] ReplacePages(byte[] targetBank, IReadOnlyDictionary<int, byte[]> replacements)
    {
        var t = Load(targetBank);
        if (replacements.Count == 0) return targetBank.ToArray();

        foreach (var (slot, blob) in replacements)
        {
            if (slot < 0 || slot >= t.Count)
                throw new ArgumentOutOfRangeException(nameof(replacements), $"SHPS replacement slot {slot} is outside 0..{t.Count - 1}.");
            if (blob == null)
                throw new ArgumentException($"SHPS replacement slot {slot} has no page bytes.", nameof(replacements));
        }

        int dirEnd = 16 + 8 * t.Count;
        int firstPage = t.Count == 0 ? targetBank.Length : t.Dir[0].Off;
        if (firstPage < dirEnd || firstPage > targetBank.Length)
            throw new InvalidDataException($"SHPS first page offset {firstPage} is outside its directory/body bounds.");

        var pages = new List<byte[]>(t.Count);
        int total = firstPage;
        for (int i = 0; i < t.Count; i++)
        {
            byte[] page = replacements.TryGetValue(i, out var replacement) ? Pad16(replacement) : t.PageBytes(i);
            pages.Add(page);
            total += page.Length;
        }

        var outBytes = new byte[total];
        // Header, directory names and pre-page bytes (including the retail Buy ERTS marker/padding) stay exact;
        // only the size field and page offsets need to change.
        System.Array.Copy(targetBank, 0, outBytes, 0, firstPage);
        int cursor = firstPage;
        for (int i = 0; i < t.Count; i++)
        {
            PutU32(outBytes, 16 + i * 8 + 4, cursor);
            System.Array.Copy(pages[i], 0, outBytes, cursor, pages[i].Length);
            cursor += pages[i].Length;
        }
        PutU32(outBytes, 4, total);
        return outBytes;
    }

    /// <summary>
    /// Build a new bank = <paramref name="targetBank"/> with <paramref name="pageBlobs"/> appended verbatim.
    /// Original images are copied unchanged (their directory offsets shift by the directory growth, kept a
    /// multiple of 16 so every image stays 16-aligned); each appended page is renumbered to the next 4-digit
    /// slot ("0121", "0122", …) and 16-padded. Returns the new bank bytes and the assigned slot names, in the
    /// same order as <paramref name="pageBlobs"/>. Appending zero pages reproduces the input byte-for-byte.
    /// </summary>
    public static (byte[] bank, List<string> newSlots) Append(byte[] targetBank, IReadOnlyList<byte[]> pageBlobs)
    {
        var t = Load(targetBank);
        int n = t.Count, m = pageBlobs.Count, newN = n + m;
        int bodyStartOrig = 16 + 8 * n;
        int newDirEnd = 16 + 8 * newN;
        int pad = (8 * m) % 16 == 0 ? 0 : 8;          // keep SHIFT a multiple of 16
        int bodyStartNew = newDirEnd + pad;
        int shift = bodyStartNew - bodyStartOrig;      // == 8*m + pad, 16-aligned
        int bodyLen = targetBank.Length - bodyStartOrig;

        // pad each donor blob to a 16-byte multiple so the chain stays aligned (trailing filler after its marker)
        var blobs = pageBlobs.Select(Pad16).ToList();

        int total = bodyStartNew + bodyLen;
        foreach (var blob in blobs) total += blob.Length;
        var outBytes = new byte[total];

        // header
        System.Text.Encoding.ASCII.GetBytes(Magic).CopyTo(outBytes, 0);
        PutU32(outBytes, 8, newN);
        System.Array.Copy(targetBank, 12, outBytes, 12, 4); // creator code, verbatim

        // directory: originals (offset shifted), then appended pages
        for (int i = 0; i < n; i++)
        {
            int p = 16 + i * 8;
            System.Array.Copy(targetBank, 16 + i * 8, outBytes, p, 4); // shortname verbatim
            PutU32(outBytes, p + 4, t.Dir[i].Off + shift);
        }
        var newSlots = new List<string>(m);
        int cursor = bodyStartNew + bodyLen;
        for (int k = 0; k < m; k++)
        {
            string name = (n + k).ToString("D4");
            int p = 16 + (n + k) * 8;
            System.Text.Encoding.ASCII.GetBytes(name).CopyTo(outBytes, p);
            PutU32(outBytes, p + 4, cursor);
            newSlots.Add(name);
            cursor += blobs[k].Length;
        }

        // body (verbatim, relocated) then the appended blobs
        System.Array.Copy(targetBank, bodyStartOrig, outBytes, bodyStartNew, bodyLen);
        int w = bodyStartNew + bodyLen;
        foreach (var blob in blobs) { System.Array.Copy(blob, 0, outBytes, w, blob.Length); w += blob.Length; }

        PutU32(outBytes, 4, total); // file-size field
        return (outBytes, newSlots);
    }

    /// <summary>
    /// Build a bank from nothing: <paramref name="pageBlobs"/> become slots "0000", "0001", … in order. The
    /// counterpart to <see cref="Append"/> for a bank that is REPLACED outright rather than grown — the
    /// skybox, whose 25 pages are all authored and none of the original's survives (Slopesmith docs/025). A material's
    /// TextureID indexes this directory, so the slot order must be the sky's mesh order.
    /// <paramref name="creator"/> is carried from the bank being replaced (4 bytes, "G278" on every disc).
    /// </summary>
    public static byte[] Create(IReadOnlyList<byte[]> pageBlobs, byte[] creator)
    {
        int n = pageBlobs.Count;
        int bodyStart = Align16(16 + 8 * n);   // every image starts 16-aligned, as on the baseline disc

        var blobs = pageBlobs.Select(Pad16).ToList();

        int total = bodyStart;
        foreach (var blob in blobs) total += blob.Length;
        var outBytes = new byte[total];

        System.Text.Encoding.ASCII.GetBytes(Magic).CopyTo(outBytes, 0);
        PutU32(outBytes, 4, total);
        PutU32(outBytes, 8, n);
        System.Array.Copy(creator, 0, outBytes, 12, 4);

        int cursor = bodyStart;
        for (int i = 0; i < n; i++)
        {
            int p = 16 + i * 8;
            System.Text.Encoding.ASCII.GetBytes(i.ToString("D4")).CopyTo(outBytes, p);
            PutU32(outBytes, p + 4, cursor);
            System.Array.Copy(blobs[i], 0, outBytes, cursor, blobs[i].Length);
            cursor += blobs[i].Length;
        }
        return outBytes;
    }
}
