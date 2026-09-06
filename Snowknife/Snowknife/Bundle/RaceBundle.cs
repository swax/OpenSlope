using Newtonsoft.Json.Linq;

namespace Snowknife.Bundle;

/// <summary>
/// The course's RACE settings for the bundle: how many laps it is raced over, and how long its showoff run is.
///
/// Both are properties of the disc SLOT rather than of any level file, which is why they are tabled here — but
/// they are that for opposite reasons, and the distinction is worth keeping.
///
/// LAPS have no data anywhere. The game holds no lap table: its shared-state reset seeds a rider counter to 4
/// when the course index is MEGAPLE's and to 0 for every other course, so the count is decided in code
/// ([Trailmap: 390-lap-counter]). That seed IS the pass count. The counter descends once per finish crossing and
/// the race ends when it reaches zero, so Megaplex is ridden top to bottom four times — the announcer counts
/// down the last three of them, "3 laps to go" at the first crossing, which is why the race reads as "three
/// laps" at the rail ([Trailmap: 390-lap-rate]). <see cref="BundleManifest.RaceInfo.Laps"/> states the same pass
/// count — what an author sets, and what an engine seeds its own countdown from.
///
/// SHOWOFF SECONDS are data, and this table follows the clean per-course timing specification. A trick run is a
/// countdown seeded from the boot executable's per-course catalogue; the showoff duration is stored in hundredths.
/// The
/// engine reads it only in the showoff modes and counts it down; every other mode zeroes the same field and
/// counts it up as the race clock ([Trailmap: 390-showoff-clock]). Transcribed because the bundle is built from
/// an extracted level FOLDER, which has no executable in it — reading the disc per build would mean an
/// ELF-offset descriptor per region, like <c>patches/sky-color.*.json</c>, for a number that has not moved.
///
/// An authored map has no slot until it is packed onto one, so its author owns both instead: Slopesmith writes
/// them into the export's <c>Slopesmith.json</c> sidecar, the same place the rest of the authored provenance a
/// native file cannot hold already rides. That sidecar therefore wins over the tables below, which only ever
/// describe retail.
/// </summary>
internal static class RaceBundle
{
    /// <summary>Retail's own lap counts, by extracted level name. Every course is a single pass except the one
    /// the engine seeds a countdown for ([Trailmap: 390-lap-counter, 390-lap-rate]).</summary>
    private static readonly Dictionary<string, int> RetailLaps = new(StringComparer.OrdinalIgnoreCase)
    {
        ["MEGAPLE"] = 4,
    };

    /// <summary>Retail's showoff clock per course, in seconds — the executable's own table read out and divided
    /// by 100 ([Trailmap: 390-showoff-clock]). UNTRACK and TRICK carry zero because those slots host no showoff
    /// event, so the engine never seeds a clock there.</summary>
    private static readonly Dictionary<string, float> RetailShowoffSeconds = new(StringComparer.OrdinalIgnoreCase)
    {
        ["GARI"] = 120f,
        ["SNOW"] = 90f,
        ["ELYSIUM"] = 90f,
        ["MESA"] = 90f,
        ["MERQUER"] = 90f,
        ["ALOHA"] = 90f,
        ["PIPE"] = 90f,
        ["UNTRACK"] = 0f,
        ["MEGAPLE"] = 90f,
        ["BIGAIR"] = 90f,
        ["TRICK"] = 0f,
        ["ALASKA"] = 135f,
    };

    /// <summary>Laps for a course we ship no knowledge of — one pass, the classic mount-to-finish run.</summary>
    private const int DefaultLaps = 1;

    /// <summary>Showoff seconds for a course we ship no knowledge of. Garibaldi's number: the first course, and
    /// the most generous of the three retail uses. Matches Slopesmith's own editor default.</summary>
    private const float DefaultShowoffSeconds = 120f;

    /// <summary>
    /// The level's race settings: the authored numbers from <c>Slopesmith.json</c> when the folder carries one,
    /// otherwise retail's own for that slot, otherwise the defaults. The sidecar is read once for both.
    /// </summary>
    public static BundleManifest.RaceInfo Build(string levelDir, string levelName)
    {
        JObject? sidecar = ReadSidecar(levelDir);
        return new BundleManifest.RaceInfo
        {
            Laps = AuthoredLaps(sidecar)
                ?? (RetailLaps.TryGetValue(levelName, out int laps) ? laps : DefaultLaps),
            ShowoffSeconds = AuthoredShowoffSeconds(sidecar)
                ?? (RetailShowoffSeconds.TryGetValue(levelName, out float seconds) ? seconds : DefaultShowoffSeconds),
        };
    }

    // The export sidecar, or null for an extracted retail level (which has none) or an unreadable one. Read as a
    // whole rather than per field so a broken file is reported once instead of once per number read out of it.
    private static JObject? ReadSidecar(string levelDir)
    {
        string path = Path.Combine(levelDir, "Slopesmith.json");
        if (!File.Exists(path)) return null;
        try
        {
            return JObject.Parse(File.ReadAllText(path));
        }
        catch (Exception e)
        {
            Log.Warn($"  WARN: Slopesmith.json is unreadable ({e.Message}) — racing {DefaultLaps} lap "
                              + $"over {DefaultShowoffSeconds:0.#}s of showoff");
            return null;
        }
    }

    // A sidecar written before maps carried the field says nothing, and falls through to the table.
    private static int? AuthoredLaps(JObject? sidecar)
    {
        int? laps = (int?)sidecar?["laps"];
        return laps is > 0 ? laps : null;
    }

    // Zero is authorable here and means it: a map whose author wants no showoff clock. Only a missing or
    // negative value falls through to the table.
    private static float? AuthoredShowoffSeconds(JObject? sidecar)
    {
        float? seconds = (float?)sidecar?["showoffSeconds"];
        return seconds is >= 0f ? seconds : null;
    }
}
