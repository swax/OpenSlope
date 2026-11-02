using System.IO.Compression;
using Newtonsoft.Json.Linq;
using SSX_Library;
using Snowknife.Services;

namespace Snowknife.Repack;

/// <summary>
/// SSXModManager v3 packages for its Tricky NTSC PS2 workspace. Course archives become decompressed loose
/// files; audio changes use directory-based big insert instructions to preserve other enabled mods' members.
/// Format: https://github.com/GlitcherOG/SSXModManager/tree/1f4cec6/ModSystem
/// </summary>
internal sealed class ModManagerPackage
{
    private readonly string _root;
    private readonly List<string> _instructions = new();
    private int _archiveCount;

    internal static string SupportedExecutable { get; } = ReadSupportedExecutable();

    internal sealed record Metadata(string Name, string Author, string Version);

    public ModManagerPackage(string root, Metadata metadata, string slot)
    {
        _root = root;
        Directory.CreateDirectory(root);
        File.WriteAllText(Path.Combine(root, "ModInfo.json"), new JObject
        {
            ["ModPackVersion"] = 3,
            ["Name"] = metadata.Name,
            ["Author"] = metadata.Author,
            ["Game"] = 2,
            ["Description"] = $"Custom course replacing {slot}. Requires SSX Tricky NTSC-U PS2.",
            ["Version"] = metadata.Version,
            ["DownloadLink"] = "",
            ["Tags"] = new JArray("Maps", "Slopesmith"),
        }.ToString());
    }

    public static Metadata ParseMetadata(string[] args, string defaultName)
    {
        string name = defaultName, author = "Unknown", version = "1.0.0";
        for (int i = 6; i < args.Length; i++)
        {
            string option = args[i].Split('=', 2)[0];
            if (option is not ("--mod-name" or "--mod-author" or "--mod-version")) continue;
            string value;
            if (args[i].StartsWith(option + "=", StringComparison.Ordinal)) value = args[i][(option.Length + 1)..];
            else if (i + 1 < args.Length && !args[i + 1].StartsWith('-')) value = args[++i];
            else throw new ArgumentException($"{option} needs a value.");
            if (string.IsNullOrWhiteSpace(value)) throw new ArgumentException($"{option} needs a non-empty value.");
            switch (option)
            {
                case "--mod-name": name = value; break;
                case "--mod-author": author = value; break;
                case "--mod-version": version = value; break;
            }
        }
        return new(name, author, version);
    }

    public static void RequireCompatibleSource(IsoService iso, string source)
    {
        using var stream = File.OpenRead(source);
        if (!string.Equals(iso.ReadBootExecutableName(stream), SupportedExecutable, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("--mod-manager requires a clean SSX Tricky NTSC-U PS2 ISO "
                + $"({SupportedExecutable}), matching the manager's supported Tricky workspace.");
    }

    private static string ReadSupportedExecutable()
    {
        using var stream = typeof(ModManagerPackage).Assembly.GetManifestResourceStream(
            "Snowknife.Repack.ssx-mod-manager-target.json")
            ?? throw new InvalidOperationException("Missing SSX Mod Manager target definition.");
        using var reader = new StreamReader(stream);
        return (string)JObject.Parse(reader.ReadToEnd())["executable"]!;
    }

    public void AddCourse(string archive)
    {
        string relative = "payload/course";
        BIG.Extract(archive, Path.Combine(_root, relative));
        _instructions.Add($"copy,mod\\{WindowsPath(relative)},game\\");
    }

    // The manager appends this root file to the selected game's PNACH before processing file instructions.
    public void AddPcsx2Patch(string text) => File.AppendAllText(Path.Combine(_root, "PCSX2Patch.txt"), text);

    public void AddFile(string gamePath, string source)
    {
        string path = SafePath(gamePath);
        string relative = "payload/files/" + path;
        string target = Path.Combine(_root, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        File.Copy(source, target, overwrite: true);
        _instructions.Add($"copy,mod\\{WindowsPath(relative)},game\\{WindowsPath(path)}");
    }

    public void AddArchiveMembers(string gameArchive, IReadOnlyDictionary<string, byte[]> members)
    {
        string archive = SafePath(gameArchive);
        if (members.Count == 0) return;
        string relative = $"payload/archive-{_archiveCount++}";
        foreach (var (member, bytes) in members.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            string target = Path.Combine(_root, relative, SafePath(member));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.WriteAllBytes(target, bytes);
        }
        _instructions.Add($"big insert,mod\\{WindowsPath(relative)},game\\{WindowsPath(archive)}");
    }

    public void Write(string output)
    {
        // LoadText in the manager splits on every newline, including a trailing one, then indexes three
        // comma-separated fields. Keep this file free of a trailing newline and blank lines.
        File.WriteAllText(Path.Combine(_root, "ModInstructions.txt"), string.Join('\n', _instructions));
        string full = Path.GetFullPath(output);
        Directory.CreateDirectory(Path.GetDirectoryName(full)!);
        string pending = full + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            ZipFile.CreateFromDirectory(_root, pending, CompressionLevel.Optimal, includeBaseDirectory: false);
            File.Move(pending, full, overwrite: true);
        }
        finally { if (File.Exists(pending)) File.Delete(pending); }
    }

    private static string WindowsPath(string path) => path.Replace('/', '\\');

    private static string SafePath(string path)
    {
        string clean = path.Replace('\\', '/').ToLowerInvariant();
        if (clean.Contains(':') || clean.Contains(',') || clean.Contains('\n') || clean.Contains('\r')
            || clean.Split('/').Any(part => part is "" or "." or ".."))
            throw new InvalidDataException($"Invalid mod package path: {path}");
        return clean;
    }
}
