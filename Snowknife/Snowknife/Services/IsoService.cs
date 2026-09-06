using DiscUtils.Iso9660;

namespace Snowknife.Services;

/// <summary>
/// ISO9660 access for SSX PS2 discs. DiscUtils-backed listing/extraction, plus the raw-sector
/// in-place file replace and the manual directory walk the repack + ELF-patch paths rely on
/// (DiscUtils is read-only, so writes go through the hand-rolled extent locator). SSX discs use
/// the primary uppercase volume descriptor, no Joliet.
/// </summary>
internal sealed class IsoService
{
    public CDReader OpenIso(Stream isoStream)
    {
        // SSX PS2 discs use the primary (uppercase) volume descriptor, no Joliet.
        return new CDReader(isoStream, joliet: false);
    }

    public int IsoLs(string[] args)
    {
        if (args.Length < 2) { Log.Error("iso-ls needs <iso> [subdir]"); return 1; }
        string iso = args[1];
        string sub = args.Length >= 3 ? NormalizeIsoDir(args[2]) : "";

        using FileStream isoStream = File.OpenRead(iso);
        CDReader cd = OpenIso(isoStream);

        var dir = string.IsNullOrEmpty(sub) ? cd.Root : cd.GetDirectoryInfo(sub);
        Log.Info($"Contents of '{(string.IsNullOrEmpty(sub) ? "\\" : sub)}':");
        foreach (var d in dir.GetDirectories())
            Log.Info($"  [DIR]  {CleanName(d.Name)}");
        foreach (var f in dir.GetFiles())
            Log.Info($"  {f.Length,12:n0}  {CleanName(f.Name)}");
        return 0;
    }

    public int IsoExtract(string[] args)
    {
        if (args.Length < 4) { Log.Error("iso-extract needs <iso> <internalPath> <out>"); return 1; }
        ExtractFile(args[1], args[2], args[3]);
        return 0;
    }

    // Extract one file out of the ISO by its internal path to outPath. The typed core `iso-extract`
    // exposes and the repack pipeline calls directly (pulling a level's BIG, a donor's ssh, ...).
    public void ExtractFile(string iso, string internalPath, string outPath)
    {
        string path = NormalizeIsoDir(internalPath);
        using FileStream isoStream = File.OpenRead(iso);
        CDReader cd = OpenIso(isoStream);

        var file = FindIsoFile(cd, path)
                   ?? throw new FileNotFoundException($"Not found in ISO: {path}");

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath))!);
        using (Stream src = file.OpenRead())
        using (FileStream dst = File.Create(outPath))
            src.CopyTo(dst);

        Log.Info($"Extracted {file.Length:n0} bytes -> {outPath}");
    }

    // Replace one file inside an ISO9660 image. If the new data fits the file's existing sector slot it is
    // overwritten in place (every other LBA stays bit-identical); if it is larger it is appended to the end
    // of the image and the file's directory record is repointed (extent + length) with the PVD volume size
    // grown to match. Only this one file moves either way - the rest of the 2.9 GB disc is untouched.
    public int IsoReplace(string[] args)
    {
        if (args.Length < 4) { Log.Error("iso-replace needs <iso> <internalPath> <newFile>"); return 1; }
        ReplaceFile(args[1], args[2], args[3]);
        return 0;
    }

    // The typed core `iso-replace` exposes and the repack pipeline calls directly (patching the rebuilt BIG
    // back into a fresh ISO).
    public void ReplaceFile(string iso, string internalPath, string newFile)
    {
        string[] parts = internalPath.Replace('\\', '/').Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        byte[] data = File.ReadAllBytes(newFile);

        using var fs = new FileStream(iso, FileMode.Open, FileAccess.ReadWrite);
        var hit = LocateIsoExtent(fs, parts) ?? throw new FileNotFoundException($"Not found in ISO: {internalPath}");
        (long lba, long len, long recordPos) = hit;
        long sectorSpace = (len + 2047) / 2048 * 2048; // whole 2048-byte sectors reserved for this file

        if (data.Length <= sectorSpace)
        {
            // In place: overwrite + zero the rest of the reserved sectors, update the directory length.
            fs.Seek(lba * 2048L, SeekOrigin.Begin);
            fs.Write(data, 0, data.Length);
            long pad = sectorSpace - data.Length;
            if (pad > 0) fs.Write(new byte[pad], 0, (int)pad);
            if (data.Length != len) WriteBothEndianU32(fs, recordPos + 10, (uint)data.Length);
            Log.Info($"In-place: {internalPath} @ LBA {lba} - {data.Length:n0} B (was {len:n0}) into a {sectorSpace:n0} B slot; dir length updated.");
        }
        else
        {
            // Relocate: append at the end of the image (sector-aligned), repoint the directory record's
            // extent + length, and grow the PVD volume-space size. The old sectors are left as dead space.
            long newLba = (fs.Length + 2047) / 2048;
            fs.Seek(newLba * 2048L, SeekOrigin.Begin);
            fs.Write(data, 0, data.Length);
            int tail = (int)((2048 - data.Length % 2048) % 2048);
            if (tail > 0) fs.Write(new byte[tail], 0, tail);
            WriteBothEndianU32(fs, recordPos + 2, (uint)newLba);          // directory record: extent location
            WriteBothEndianU32(fs, recordPos + 10, (uint)data.Length);    // directory record: data length
            long newTotalSectors = newLba + (data.Length + 2047) / 2048;
            WriteBothEndianU32(fs, 16L * 2048 + 80, (uint)newTotalSectors); // PVD (sector 16) volume space size
            Log.Info($"Relocated: {internalPath} {len:n0} B -> {data.Length:n0} B, LBA {lba} -> {newLba} (slot was {sectorSpace:n0} B). Old sectors dead; PVD size -> {newTotalSectors} sectors.");
        }
    }

    // Write a value as ISO9660's both-endian u32 (little-endian, then big-endian) at the given file offset.
    private static void WriteBothEndianU32(FileStream fs, long pos, uint val)
    {
        fs.Seek(pos, SeekOrigin.Begin);
        fs.Write(BitConverter.GetBytes(val), 0, 4);
        byte[] be = BitConverter.GetBytes(val); Array.Reverse(be);
        fs.Write(be, 0, 4);
    }

    private static readonly string[] SystemCnfPath = { "SYSTEM.CNF" };

    // The disc's boot executable name, read from SYSTEM.CNF's
    // BOOT2 line - the disc's own statement of which build it carries. That name is what selects a
    // region's executable patch file, so a patch can never be aimed at the wrong build. Falls back to
    // the root directory's SLxx_nnn.nn entry on a disc whose SYSTEM.CNF is missing or unparseable.
    public string? ReadBootExecutableName(Stream iso)
    {
        var hit = LocateIsoExtent(iso, SystemCnfPath);
        if (hit != null)
        {
            var (lba, len, _) = hit.Value;
            byte[] buf = new byte[Math.Min(len, 4096)];
            iso.Seek(lba * 2048L, SeekOrigin.Begin);
            iso.ReadExactly(buf);
            string cnf = System.Text.Encoding.ASCII.GetString(buf);
            var m = System.Text.RegularExpressions.Regex.Match(
                cnf, @"BOOT2\s*=\s*cdrom0:\\?([^;\s]+)", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
            if (m.Success) return m.Groups[1].Value.Trim();
        }
        return EnumerateRootNames(iso).FirstOrDefault(n =>
            System.Text.RegularExpressions.Regex.IsMatch(n, @"^SL[A-Z]{2}_\d{3}\.\d{2}$",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase));
    }

    // File names in the ISO root directory, ;version stripped.
    private IEnumerable<string> EnumerateRootNames(Stream iso)
    {
        byte[] pvd = ReadSector(iso, 16);
        long dirLba = BitConverter.ToUInt32(pvd, 156 + 2);
        long dirLen = BitConverter.ToUInt32(pvd, 156 + 10);
        long sectors = (dirLen + 2047) / 2048;
        for (long s = 0; s < sectors; s++)
        {
            byte[] sec = ReadSector(iso, dirLba + s);
            int off = 0;
            while (off < 2048)
            {
                int recLen = sec[off];
                if (recLen == 0) break;
                int nameLen = sec[off + 32];
                string name = System.Text.Encoding.ASCII.GetString(sec, off + 33, nameLen);
                int semi = name.IndexOf(';');
                if (semi >= 0) name = name[..semi];
                if ((sec[off + 25] & 0x02) == 0 && name.Length > 1) yield return name;
                off += recLen;
            }
        }
    }

    // Walk the ISO9660 primary volume to a file/dir path; return (extent LBA, data length, byte offset of
    // its directory record) or null.
    public (long lba, long len, long recordPos)? LocateIsoExtent(Stream iso, string[] pathParts)
    {
        byte[] pvd = ReadSector(iso, 16);
        if (pvd[0] != 1 || pvd[1] != 'C' || pvd[2] != 'D' || pvd[3] != '0' || pvd[4] != '0' || pvd[5] != '1')
            throw new InvalidDataException("No ISO9660 primary volume descriptor at sector 16.");
        long dirLba = BitConverter.ToUInt32(pvd, 156 + 2);   // root directory record (offset 156), extent LBA (LE at +2)
        long dirLen = BitConverter.ToUInt32(pvd, 156 + 10);  // ... data length (+10)

        for (int p = 0; p < pathParts.Length; p++)
        {
            var match = FindInDir(iso, dirLba, dirLen, pathParts[p], wantFile: p == pathParts.Length - 1);
            if (match == null) return null;
            if (p == pathParts.Length - 1) return match;
            (dirLba, dirLen, _) = match.Value;
        }
        return null;
    }

    // Scan one directory extent for a child by name (case-insensitive, ;version stripped), matching kind.
    private static (long lba, long len, long recordPos)? FindInDir(Stream iso, long dirLba, long dirLen, string name, bool wantFile)
    {
        long sectors = (dirLen + 2047) / 2048;
        for (long s = 0; s < sectors; s++)
        {
            long secBase = (dirLba + s) * 2048L;
            byte[] sec = ReadSector(iso, dirLba + s);
            int off = 0;
            while (off < 2048)
            {
                int recLen = sec[off];
                if (recLen == 0) break; // rest of this sector is padding; advance to the next
                long extent = BitConverter.ToUInt32(sec, off + 2);
                long length = BitConverter.ToUInt32(sec, off + 10);
                bool isDir = (sec[off + 25] & 0x02) != 0;
                int nameLen = sec[off + 32];
                string entryName = System.Text.Encoding.ASCII.GetString(sec, off + 33, nameLen);
                int semi = entryName.IndexOf(';');
                if (semi >= 0) entryName = entryName[..semi];
                if (isDir != wantFile && entryName.Equals(name, StringComparison.OrdinalIgnoreCase))
                    return (extent, length, secBase + off);
                off += recLen;
            }
        }
        return null;
    }

    private static byte[] ReadSector(Stream iso, long lba)
    {
        byte[] buf = new byte[2048];
        iso.Seek(lba * 2048L, SeekOrigin.Begin);
        for (int read = 0; read < 2048;)
        {
            int r = iso.Read(buf, read, 2048 - read);
            if (r <= 0) break;
            read += r;
        }
        return buf;
    }

    public void CopyIsoFile(CDReader cd, string internalPath, string outPath)
    {
        var f = FindIsoFile(cd, internalPath) ?? throw new FileNotFoundException($"{internalPath} not in ISO");
        using Stream src = f.OpenRead();
        using FileStream dst = File.Create(outPath);
        src.CopyTo(dst);
    }

    /// <summary>Strip the ISO9660 ";1" version suffix.</summary>
    public string CleanName(string name)
    {
        int semi = name.IndexOf(';');
        return semi >= 0 ? name.Substring(0, semi) : name;
    }

    public string NormalizeIsoDir(string p) => p.Replace('/', '\\').Trim('\\');

    public DiscUtils.DiscFileInfo? FindIsoFile(CDReader cd, string internalPath)
    {
        string dir = Path.GetDirectoryName(internalPath)?.Replace('/', '\\') ?? "";
        string name = Path.GetFileName(internalPath);
        var di = string.IsNullOrEmpty(dir) ? cd.Root : cd.GetDirectoryInfo(dir);
        return di.GetFiles().FirstOrDefault(f =>
            string.Equals(CleanName(f.Name), name, StringComparison.OrdinalIgnoreCase));
    }

    public DiscUtils.DiscFileInfo? FindLevelBig(CDReader cd, string levelName)
    {
        var modelsDir = cd.GetDirectoryInfo(@"DATA\MODELS");
        string want = levelName.ToUpperInvariant();
        if (!want.EndsWith(".BIG")) want += ".BIG";
        return modelsDir.GetFiles().FirstOrDefault(f =>
            string.Equals(CleanName(f.Name), want, StringComparison.OrdinalIgnoreCase));
    }
}
