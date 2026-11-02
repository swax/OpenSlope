using System.IO.Compression;

namespace Snowknife.Repack;

/// <summary>A map directory or a Slopesmith .snowknife.zip snapshot, unpacked for the existing readers.</summary>
internal sealed class MapArchiveInput : IDisposable
{
    private const long MaxUnpackedBytes = 2L * 1024 * 1024 * 1024;
    private const int MaxEntries = 20_000;
    private readonly string? _scratch;

    public string MapDirectory { get; }

    private MapArchiveInput(string directory, string? scratch = null)
    {
        MapDirectory = directory;
        _scratch = scratch;
    }

    public static string DisplayName(string source)
    {
        string name = Path.GetFileName(Path.TrimEndingDirectorySeparator(source));
        if (Directory.Exists(source)) return name;
        if (name.EndsWith(".snowknife.zip", StringComparison.OrdinalIgnoreCase)) return name[..^14];
        return name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase) ? name[..^4] : name;
    }

    public static MapArchiveInput Open(string source)
    {
        if (Directory.Exists(source)) return new(Path.GetFullPath(source));
        if (source.EndsWith(".slopesmith.zip", StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("This is an editable Slopesmith mountain. Choose Export for Snowknife "
                + "in Slopesmith to download a .snowknife.zip build input.");
        if (!source.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            return new(Path.GetFullPath(source)); // Preserve each command's existing missing-folder diagnostics.

        using var archive = ZipFile.OpenRead(source);
        if (archive.Entries.Count > MaxEntries) throw new InvalidDataException("Map ZIP contains too many entries.");
        var entries = new List<(ZipArchiveEntry Entry, string Path, bool Directory)>();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        long total = 0;
        foreach (var entry in archive.Entries)
        {
            string path = entry.FullName.Replace('\\', '/');
            bool directory = path.EndsWith('/');
            path = path.TrimEnd('/');
            if (path.Contains(':') || path.Split('/').Any(part => part is "" or "." or "..")
                || !names.Add(path))
                throw new InvalidDataException($"Invalid or duplicate map ZIP path: {entry.FullName}");
            if (((entry.ExternalAttributes >> 16) & 0xF000) == 0xA000)
                throw new InvalidDataException($"Map ZIP cannot contain symbolic links: {entry.FullName}");
            if (entry.Length > MaxUnpackedBytes - total)
                throw new InvalidDataException("Map ZIP exceeds the 2 GiB unpacked limit.");
            total += entry.Length;
            entries.Add((entry, path, directory));
        }

        string[] roots = entries.Where(item => !item.Directory)
            .Where(item => item.Path.Equals("Patches.json", StringComparison.OrdinalIgnoreCase)
                || item.Path.Count(c => c == '/') == 1 && item.Path.EndsWith("/Patches.json", StringComparison.OrdinalIgnoreCase))
            .Select(item => item.Path.Contains('/') ? item.Path[..item.Path.LastIndexOf('/')] : "")
            .ToArray();
        if (roots.Length != 1)
            throw new InvalidDataException("Map ZIP must contain one map's Patches.json at its root or in one top-level folder.");

        string scratch = Path.Combine(Path.GetTempPath(), "snowknife-map-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(scratch);
        string boundary = Path.GetFullPath(scratch) + Path.DirectorySeparatorChar;
        try
        {
            foreach (var (entry, path, directory) in entries)
            {
                string target = Path.GetFullPath(Path.Combine(scratch, path));
                if (!target.StartsWith(boundary, StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException($"Map ZIP path escapes its extraction folder: {path}");
                if (directory) Directory.CreateDirectory(target);
                else
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                    entry.ExtractToFile(target);
                }
            }
            return new(Path.Combine(scratch, roots[0]), scratch);
        }
        catch
        {
            DeleteScratch(scratch);
            throw;
        }
    }

    public void Dispose()
    {
        if (_scratch != null) DeleteScratch(_scratch);
    }

    private static void DeleteScratch(string scratch)
    {
        string root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(Path.GetTempPath())) + Path.DirectorySeparatorChar;
        string target = Path.GetFullPath(scratch);
        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase)
            || !Path.GetFileName(target).StartsWith("snowknife-map-", StringComparison.Ordinal))
            throw new InvalidOperationException("Invalid map extraction cleanup path.");
        try { if (Directory.Exists(target)) Directory.Delete(target, recursive: true); }
        catch (IOException) { /* A locked temporary file must not hide the build result. */ }
        catch (UnauthorizedAccessException) { /* Leave locked temporary files for the OS to retire. */ }
    }
}
