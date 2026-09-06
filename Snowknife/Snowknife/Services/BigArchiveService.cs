using SSX_Library; // BIG, BigType

namespace Snowknife.Services;

/// <summary>
/// EA .BIG archive container operations: list/extract/create. Extraction has two modes - the library's
/// decompressing <see cref="BIG.Extract"/> and the verbatim <see cref="RawExtractC0fb"/> that keeps members
/// RefPack-compressed for a lossless, instant re-container (paired with `big-create --store`).
/// </summary>
internal sealed class BigArchiveService
{
    public int BigLs(string[] args)
    {
        if (args.Length < 2) { Log.Error("big-ls needs <big>"); return 1; }
        string big = args[1];
        Log.Info($"Type: {BIG.GetBigType(big)}");
        foreach (var m in BIG.GetMembersInfo(big))
            Log.Info($"  {m.Size,12:n0}  {m.Path}");
        return 0;
    }

    public int BigExtract(string[] args)
    {
        if (args.Length < 3) { Log.Error("big-extract needs <big> <outDir> [--raw]"); return 1; }
        string big = args[1];
        string outDir = args[2];
        bool raw = args.Contains("--raw");
        Directory.CreateDirectory(outDir);
        Log.Info($"Extracting {big} ({BIG.GetBigType(big)}) -> {outDir}{(raw ? " [raw: members kept compressed]" : "")}");
        if (raw) RawExtractC0fb(big, outDir);
        else BIG.Extract(big, outDir);
        Log.Info("Done.");
        return 0;
    }

    // Pack a folder of members back into a .BIG (the inverse of big-extract). Level archives are C0FB with
    // forward-slash member paths and RefPack-compressed members; BIG.Create handles the container + RefPack.
    public int BigCreate(string[] args)
    {
        if (args.Length < 3) { Log.Error("big-create needs <memberFolder> <out.big> [c0fb|bigf] [--store]"); return 1; }
        string folder = args[1];
        string outBig = args[2];
        bool store = args.Contains("--store"); // store members verbatim (no RefPack pass); for already-compressed input
        BigType type = args.Any(a => a.Equals("bigf", StringComparison.OrdinalIgnoreCase)) ? BigType.BIGF : BigType.C0FB;
        if (!Directory.Exists(folder)) { Log.Error($"Member folder not found: {folder}"); return 1; }

        int members = Directory.GetFiles(folder, "*", SearchOption.AllDirectories).Length;
        BIG.Create(type, folder, outBig, useCompression: !store, useBackslashes: false);
        long size = new FileInfo(outBig).Length;
        Log.Info($"Packed {members} members -> {outBig} ({size:n0} bytes, {type}, {(store ? "stored verbatim" : "RefPack")})");
        return 0;
    }

    // Extract C0FB members WITHOUT decompressing - the stored (RefPack) bytes verbatim. Pairs with
    // `big-create --store` to re-container an archive losslessly and instantly (no RefPack pass), so a
    // repack that changes only one member never pays to recompress the other ten.
    public void RawExtractC0fb(string bigPath, string folder)
    {
        byte[] big = File.ReadAllBytes(bigPath);
        if (big.Length < 6 || big[0] != 0xC0 || big[1] != 0xFB)
            throw new InvalidDataException("Raw extract supports C0FB archives only.");
        int count = (big[4] << 8) | big[5];
        // Where extraction is allowed to write, resolved once. Every member path is checked against this
        // rather than trusted: the names come out of the ARCHIVE, and `Path.Combine` with a name that walks
        // up ("..\..\x") silently produces a path outside the folder the caller named. Retail archives never
        // do that, which is exactly why nothing would notice one that did.
        string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(folder)) + Path.DirectorySeparatorChar;
        int pos = 6;
        for (int i = 0; i < count; i++)
        {
            if (pos + 6 > big.Length)
                throw new InvalidDataException($"C0FB: the entry table ends mid-record at member {i} of {count}");
            long offset = (big[pos] << 16) | (big[pos + 1] << 8) | big[pos + 2]; pos += 3;
            long size = (big[pos] << 16) | (big[pos + 1] << 8) | big[pos + 2]; pos += 3;
            int nameStart = pos;
            while (pos < big.Length && big[pos] != 0) pos++;
            if (pos >= big.Length)
                throw new InvalidDataException($"C0FB: member {i} of {count} has an unterminated name");
            string path = System.Text.Encoding.ASCII.GetString(big, nameStart, pos - nameStart);
            pos++; // NUL terminator
            if (offset == 0 || path.Contains('*')) continue; // placeholder entry
            if (offset + size > big.Length)
                throw new InvalidDataException($"C0FB: member \"{path}\" claims {size:N0} bytes at offset "
                    + $"{offset:N0}, past the end of a {big.Length:N0}-byte archive");
            string outPath = Path.GetFullPath(Path.Combine(folder,
                path.Replace('/', Path.DirectorySeparatorChar).Replace('\\', Path.DirectorySeparatorChar)));
            if (!outPath.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                throw new InvalidDataException($"C0FB: member \"{path}\" resolves to {outPath}, outside the "
                    + "extraction folder — refusing to write it");
            Directory.CreateDirectory(Path.GetDirectoryName(outPath)!);
            using var fsOut = File.Create(outPath);
            fsOut.Write(big, (int)offset, (int)size);
        }
    }
}
