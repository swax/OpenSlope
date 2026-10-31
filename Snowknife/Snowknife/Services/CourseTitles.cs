using System.Buffers.Binary;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Snowknife.Services;

/// <summary>Source course descriptors shared by the managed Tricky and SSX 3 import routes.</summary>
internal static class CourseTitles
{
    public static string? Read(byte[] data, string course)
    {
        if (course.StartsWith("TRICKY_", StringComparison.OrdinalIgnoreCase)) course = TrickyCourse.Slot(course);
        if (data.Length < 52 || data.Length > 64 * 1024 * 1024 || data[0] != 127 ||
            Encoding.ASCII.GetString(data, 1, 3) != "ELF" || data[4] != 1 || data[5] != 1) return null;
        uint Word(int p) => p >= 0 && p <= data.Length - 4 ? BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(p, 4)) : 0;
        int Half(int p) => BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(p, 2));
        int ph = checked((int)Word(28)), stride = Half(42), count = Half(44);
        if (stride < 32 || count > 64 || ph < 0 || (long)ph + stride * count > data.Length) return null;
        List<(uint Offset, uint Address, uint Size)> sections = [];
        for (int i = 0; i < count; i++)
        {
            int p = ph + i * stride;
            if (Word(p) != 1) continue;
            var section = (Offset: Word(p + 4), Address: Word(p + 8), Size: Word(p + 16));
            if ((long)section.Offset + section.Size > data.Length) return null;
            sections.Add(section);
        }
        string Text(int p, int limit)
        {
            if (p < 0 || p >= data.Length) return "";
            int end = p;
            while (end < data.Length && end - p < limit)
            {
                byte c = data[end];
                if (c == 0) return Encoding.ASCII.GetString(data, p, end - p);
                if (c < 32 || c > 126) return "";
                end++;
            }
            return "";
        }
        string Pointer(uint address, int limit)
        {
            foreach (var s in sections)
                if (address >= s.Address && (ulong)address - s.Address < s.Size)
                    return Text(checked((int)(s.Offset + address - s.Address)), limit);
            return "";
        }
        Dictionary<string, string> titles = new(StringComparer.OrdinalIgnoreCase);
        bool streamed = course.StartsWith("SSX3_", StringComparison.OrdinalIgnoreCase);
        if (streamed && course.Length == 10 && course.StartsWith("SSX3_PEAK", StringComparison.OrdinalIgnoreCase) && course[^1] is >= '1' and <= '3') return "Peak " + course[^1];
        for (int p = 0; p + 100 <= data.Length; p += 4)
        {
            if (streamed && Text(p + 64, 16) == "BAM")
            {
                string key = Text(p + 48, 16), title = Text(p, 32);
                if (key.Length > 0 && title.Length > 0) titles.TryAdd("SSX3_" + key, title);
            }
            else if (!streamed && Word(p) < 64)
            {
                string key = Pointer(Word(p + 20), 16), title = Pointer(Word(p + 4), 80), menuKey = Pointer(Word(p + 8), 32);
                bool neighbour = Word(p + 28) == Word(p) + 1 && Pointer(Word(p + 48), 16).Length > 0 ||
                    p >= 28 && Word(p - 28) + 1 == Word(p) && Pointer(Word(p - 8), 16).Length > 0;
                if (neighbour && key.Length > 0 && title.Length > 0 && menuKey.Length > 0 && !menuKey.Any(c => c is >= 'a' and <= 'z'))
                    titles.TryAdd(key, title);
            }
        }
        if (titles.TryGetValue(course, out string? found)) return found;
        if (streamed)
        {
            int split = course.IndexOf('_', 5);
            if (split >= 0 && titles.TryGetValue(course[..split], out string? first) &&
                titles.TryGetValue("SSX3_" + course[(split + 1)..], out string? last)) return first + " / " + last;
        }
        return null;
    }

    public static void WriteFromIso(IsoService iso, string image, string map, string course, string game, IEnumerable<string>? sections = null, bool chain = false)
    {
        string? name = null, source = null;
        try
        {
            using var stream = File.OpenRead(image);
            source = iso.ReadBootExecutableName(stream);
            stream.Position = 0;
            using var cd = iso.OpenIso(stream);
            var file = source is null ? null : iso.FindIsoFile(cd, source);
            if (file is not null && file.Length <= 64 * 1024 * 1024)
            {
                using var input = file.OpenRead();
                using var bytes = new MemoryStream(); input.CopyTo(bytes);
                name = Read(bytes.ToArray(), course);
            }
        }
        catch (Exception e) when (e is IOException or InvalidDataException or OverflowException) { /* Optional on legacy/custom inputs. */ }
        string path = Path.Combine(map, "Import.json");
        JObject metadata = File.Exists(path) ? JObject.Parse(File.ReadAllText(path)) : new JObject { ["Schema"] = "openslope-import-metadata/v1" };
        metadata["Game"] = game;
        metadata["Course"] = course.ToUpperInvariant();
        metadata["MapType"] = "run";
        foreach (string key in new[] { "WorldId", "ParentMap", "SourceSections", "Connects" }) metadata.Remove(key);
        if (game == "ssx-3")
            foreach (var property in CourseLayout.Ssx3(course, sections ?? [], chain).Properties()) metadata[property.Name] = property.Value;
        metadata.Remove("DisplayName"); metadata.Remove("NameSource");
        if (!string.IsNullOrEmpty(name))
        {
            metadata["DisplayName"] = name;
            metadata["NameSource"] = course.StartsWith("SSX3_PEAK", StringComparison.OrdinalIgnoreCase) ? "openslope:peak-selection" : source + ":course-descriptors";
        }
        File.WriteAllText(path, metadata.ToString(Formatting.Indented) + "\n");
    }
}
