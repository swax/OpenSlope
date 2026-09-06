
using Newtonsoft.Json;

namespace Snowknife.Services;

/// <summary>
/// Where a map folder came from, and whether it carries retail bytes — the portable form written to
/// <c>Maps/&lt;NAME&gt;/Origin.json</c>.
///
/// Two facts rather than one, because they are genuinely separate questions. <see cref="Origin"/> says who
/// wrote the folder: this importer, extracting a course off somebody's disc, or Slopesmith, composing an
/// authored mountain. <see cref="RetailData"/> says what is inside it. An authored mountain that places a
/// retail tree is <c>slopesmith</c> with <c>RetailData</c> set, and that combination is the whole reason one
/// boolean would not do.
///
/// Both producers write this file. `import` writes it here; Slopesmith's export writes the same shape from
/// the classification it already performs (`core/export/origin.ts`, whose reason vocabulary this shares).
/// Consumers read it to say what a folder is — Slopesmith shows it beside the loaded reference — so an
/// unmarked folder is read as retail by every consumer rather than as clean.
///
/// Sibling of <see cref="WorldConfig"/> in every respect: an ordinary map contract, validated on write,
/// optional to any consumer that does not care.
/// </summary>
public sealed class MapOrigin
{
    public const string SchemaId = "openslope-origin/v1";
    public const string FileName = "Origin.json";

    /// <summary>An extract of a retail course.</summary>
    public const string RetailOrigin = "retail";

    /// <summary>An authored mountain composed by Slopesmith.</summary>
    public const string SlopesmithOrigin = "slopesmith";

    /// <summary>
    /// The single reason an extract carries. An extract IS the disc's bytes, so there is nothing to enumerate
    /// — the per-channel `retail-*` list is for authored folders, where it records what was borrowed.
    /// </summary>
    public const string RetailExtractReason = "retail-extract";

    [JsonProperty("Schema")] public string Schema { get; set; } = SchemaId;

    /// <summary><see cref="RetailOrigin"/> or <see cref="SlopesmithOrigin"/>.</summary>
    [JsonProperty("Origin")] public string Origin { get; set; } = RetailOrigin;

    /// <summary>The course slot an extract was read from. Absent on an authored mountain.</summary>
    [JsonProperty("Course", NullValueHandling = NullValueHandling.Ignore)] public string? Course { get; set; }

    /// <summary>Whether the folder contains or references bytes that came off a retail disc.</summary>
    [JsonProperty("RetailData")] public bool RetailData { get; set; }

    /// <summary>Why. Empty exactly when <see cref="RetailData"/> is false — the schema states it both ways.</summary>
    [JsonProperty("Reasons")] public List<string> Reasons { get; set; } = new();

    /// <summary>The record `import` writes for a course it has just extracted.</summary>
    public static MapOrigin ForRetailExtract(string course) => new()
    {
        Origin = RetailOrigin,
        Course = course.ToUpperInvariant(),
        RetailData = true,
        Reasons = new List<string> { RetailExtractReason },
    };

    /// <summary>Read a map folder's Origin.json, or null when it has none / cannot be parsed. Null is not
    /// "no retail data": every caller resolves it to the conservative retail answer.</summary>
    public static MapOrigin? Read(string mapDir)
    {
        string path = Path.Combine(mapDir, FileName);
        if (!File.Exists(path)) return null;
        try { return JsonConvert.DeserializeObject<MapOrigin>(File.ReadAllText(path)); }
        catch { return null; }
    }

    public void Write(string mapDir)
    {
        File.WriteAllText(Path.Combine(mapDir, FileName),
            JsonConvert.SerializeObject(this, Formatting.Indented) + Environment.NewLine);
    }
}
