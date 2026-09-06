using Newtonsoft.Json.Linq;

namespace Snowknife.Repack;

/// <summary>Which bank satisfies one authored <c>TexturePath</c> on the target disc.</summary>
internal enum TextureOrigin
{
    /// <summary>A page of the level being replaced: its own ssh already holds it, so nothing is installed.</summary>
    TargetPage,

    /// <summary>A page of another map on the same disc: that map's ssh is the donor, spliced in verbatim.</summary>
    DonorPage,

    /// <summary>Authored art with no bank behind it: encoded from the PNG the export staged for it.</summary>
    EncodedPage,
}

/// <summary>One resolved <c>TexturePath</c>.</summary>
/// <param name="Origin">Which bank satisfies the ref.</param>
/// <param name="Key">The installation identity, in the same <c>"LEVEL/NNNN.png"</c> shape the borrowed/custom
/// scan uses, so one page named by two refs (a terrain tile and a prop material, say) is installed once.</param>
/// <param name="Donor">The level whose ssh supplies a <see cref="TextureOrigin.DonorPage"/>.</param>
/// <param name="Name">The page's name in that level's bank - and, for a <see cref="TextureOrigin.TargetPage"/>,
/// the bare slot the rewritten <c>TexturePath</c> carries.</param>
/// <param name="File">The PNG under the export's <c>Textures/</c> an <see cref="TextureOrigin.EncodedPage"/> is
/// encoded from. A portable export stages it under a flattened name.</param>
internal readonly record struct TexturePlan(TextureOrigin Origin, string Key, string Donor, string Name, string File);

/// <summary>
/// A Slopesmith export's <c>Slopesmith.json</c> provenance sidecar, and the texture resolution it drives.
///
/// A portable export ships every painted tile flattened and verbatim - <c>Textures/GARI_0012.png</c> with a
/// <c>TexturePath</c> of <c>"GARI_0012.png"</c> - so the ref's own shape says nothing about which bank the page
/// belongs to. The manifest says it: per <c>TexturePath</c>, the <c>{level, name, staged}</c> it was painted
/// from. That is the whole disc-side decision once the target slot is known:
///
///   - <c>level</c> == the level being replaced -&gt; its bank already holds the page; reuse the slot,
///   - <c>level</c> == another map on the disc  -&gt; splice that map's page in verbatim (reuse-first, then append),
///   - <c>level</c> == <c>Custom</c>            -&gt; no bank behind it; encode the staged PNG.
///
/// A ref the manifest lists is resolved by the manifest alone. A ref it does not list, and that names no page of
/// the target bank, is the export's own generated art - the per-SurfaceType tiles written into its
/// <c>Textures/</c> under exactly the name the patches carry - and is encoded through the same allocator, because
/// a terrain <c>TexturePath</c> that is not a page of the shipped ssh stamps a texture index past the bank.
/// An export carrying no manifest resolves entirely on the ref's own shape (Services/RepackService.cs).
/// </summary>
internal sealed class SlopesmithExport
{
    /// <summary>The sidecar's file name, beside <c>Patches.json</c> in the folder Slopesmith writes.</summary>
    public const string FileName = "Slopesmith.json";

    /// <summary>The synthetic level Slopesmith paints the author's own tiles from. It is not a course, so no
    /// disc bank can supply its pages - they are encoded from the staged PNG.</summary>
    public const string CustomLevel = "Custom";

    private const int Schema = 1;
    private const string Kind = "slopesmith-export";

    // A staged file name is a single Textures/ entry, never a path - the export flattens "GARI/0012.png" to
    // "GARI_0012.png" precisely so it stays one.
    private static readonly char[] PathChars = { '/', '\\' };

    private readonly Dictionary<string, (string Level, string Name, string? Staged)> _textures;

    private SlopesmithExport(Dictionary<string, (string, string, string?)> textures) => _textures = textures;

    /// <summary>How many <c>TexturePath</c> sources the manifest carries.</summary>
    public int Count => _textures.Count;

    /// <summary>Read the export's manifest, or null when it carries none / one this build does not recognize.</summary>
    public static SlopesmithExport? Load(string customDir)
    {
        string path = Path.Combine(customDir, FileName);
        if (!File.Exists(path)) return null;

        JObject root;
        try { root = JObject.Parse(File.ReadAllText(path)); }
        catch (Exception e)
        { Log.Warn($"  WARN: {FileName} is unreadable ({e.Message}) — texture refs resolve on their own shape"); return null; }

        if ((int?)root["schema"] != Schema || (string?)root["kind"] != Kind)
        { Log.Warn($"  WARN: {FileName} is not a schema {Schema} {Kind} — texture refs resolve on their own shape"); return null; }

        // Texture path keys come out of Patches.json, which the ISO pipeline treats case-insensitively.
        var textures = new Dictionary<string, (string, string, string?)>(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in root["textures"] as JObject ?? new JObject())
        {
            string level = (string?)entry.Value?["level"] ?? "";
            string name = (string?)entry.Value?["name"] ?? "";
            if (level.Length == 0 || name.Length == 0) continue;
            textures[entry.Key] = (level, name, (string?)entry.Value?["staged"]);
        }
        return new SlopesmithExport(textures);
    }

    /// <summary>
    /// Resolve one portable (non-qualified) <c>TexturePath</c>. False leaves the ref to resolve on its own
    /// shape, which is what an export with no manifest gets for every ref.
    /// </summary>
    /// <param name="manifest">The export's manifest, or null when it ships none.</param>
    /// <param name="customDir">The export folder, holding the staged PNGs under <c>Textures/</c>.</param>
    /// <param name="texturePath">The ref exactly as <c>Patches.json</c> carries it.</param>
    /// <param name="targetLevel">The retail slot being replaced.</param>
    /// <param name="isTargetPage">Whether a name is a page of that slot's own bank.</param>
    public static bool TryResolve(SlopesmithExport? manifest, string customDir, string texturePath,
                                  string targetLevel, Func<string, bool> isTargetPage, out TexturePlan plan)
    {
        plan = default;
        if (manifest == null || texturePath.Length == 0 || texturePath.IndexOfAny(PathChars) >= 0) return false;

        if (manifest._textures.TryGetValue(texturePath, out var src))
        {
            string key = $"{src.Level}/{src.Name}";
            string file = src.Staged ?? src.Name;
            var origin = string.Equals(src.Level, targetLevel, StringComparison.OrdinalIgnoreCase) ? TextureOrigin.TargetPage
                       : string.Equals(src.Level, CustomLevel, StringComparison.OrdinalIgnoreCase) ? TextureOrigin.EncodedPage
                       : TextureOrigin.DonorPage;
            plan = new TexturePlan(origin, key, src.Level, src.Name, file);
            return true;
        }

        // Unlisted: the per-SurfaceType tiles the export generates itself (snow.png, ice.png, …) and writes into
        // its own Textures/ under the same name the patches carry. They have no provenance to record because
        // they came from no bank - encode them. Keys are namespaced away from a "Custom/<name>.png" manifest
        // entry so an authored tile sharing a generated tile's name still gets its own page.
        if (isTargetPage(texturePath) || !File.Exists(Path.Combine(customDir, "Textures", texturePath))) return false;
        plan = new TexturePlan(TextureOrigin.EncodedPage, $"staged/{texturePath}", CustomLevel, texturePath, texturePath);
        return true;
    }

    // Print how an export folder's terrain TexturePaths resolve against a target slot, without a disc: the
    // decision table above over the export's own Patches.json + Slopesmith.json. The offline check behind
    // repack's texture installation, and — with --json — the deterministic assertion of it: the same
    // resolution and the same first-seen order that decide `repack --dry-run`'s page list, as a record.
    //   texture-plan <exportDir> <LEVEL> [--slots N] [--json]
    public static int TexturePlanCommand(string[] args)
    {
        if (args.Length < 3) { Log.Error("texture-plan needs <exportDir> <LEVEL> [--slots N] [--json]"); return 1; }
        string customDir = args[1], level = args[2].ToUpperInvariant();
        string patchesPath = Path.Combine(customDir, "Patches.json");
        if (!File.Exists(patchesPath)) { Log.Error($"No Patches.json in {customDir}"); return 1; }

        // Without a disc the bank size is unknown, so any 4-digit name counts as a page of it; --slots N is the
        // target ssh's real page count, which is what repack itself measures the refs against.
        int slots = int.MaxValue;
        int si = Array.IndexOf(args, "--slots");
        if (si >= 0 && si + 1 < args.Length && int.TryParse(args[si + 1], out int n)) slots = n;
        bool IsTargetPage(string name) => System.Text.RegularExpressions.Regex.IsMatch(name, @"^\d{4}\.png$")
                                       && int.TryParse(name.AsSpan(0, 4), out int slot) && slot < slots;

        var manifest = Load(customDir);
        var qualified = new System.Text.RegularExpressions.Regex(@"^([A-Za-z0-9_]+)/([^/]+\.png)$");

        // First-seen order, the order repack installs in and therefore the order slots are assigned in.
        var order = new List<string>();
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var patch in JObject.Parse(File.ReadAllText(patchesPath))["Patches"] as JArray ?? new JArray())
        {
            string t = (string?)patch["TexturePath"] ?? "";
            if (t.Length == 0) continue;
            if (!counts.ContainsKey(t)) order.Add(t);
            counts[t] = counts.GetValueOrDefault(t) + 1;
        }

        // One resolution, rendered two ways: the table a human reads and the record a check asserts.
        var rows = new JArray();
        int target = 0, donor = 0, encoded = 0, bare = 0;
        foreach (string t in order)
        {
            string kind, detail, warning = "";
            var q = qualified.Match(t);
            if (q.Success && string.Equals(q.Groups[1].Value, level, StringComparison.OrdinalIgnoreCase))
            { kind = "target"; detail = q.Groups[2].Value; target++; }
            else if (q.Success && string.Equals(q.Groups[1].Value, CustomLevel, StringComparison.OrdinalIgnoreCase))
            { kind = "encode"; detail = $"Textures/{q.Groups[2].Value}"; encoded++; }
            else if (q.Success)
            { kind = "donor"; detail = t; donor++; }
            else if (TryResolve(manifest, customDir, t, level, IsTargetPage, out var plan))
            {
                switch (plan.Origin)
                {
                    case TextureOrigin.TargetPage:
                        kind = "target"; detail = plan.Name; target++;
                        if (!IsTargetPage(plan.Name)) warning = "not a page of the bank";
                        break;
                    case TextureOrigin.DonorPage:
                        kind = "donor"; detail = plan.Key; donor++;
                        break;
                    default:
                        kind = "encode"; detail = $"Textures/{plan.File}"; encoded++;
                        break;
                }
            }
            else if (IsTargetPage(t)) { kind = "target"; detail = t; bare++; }
            else { kind = "unresolved"; detail = "-> slot 0000"; }
            rows.Add(new JObject
            {
                ["ref"] = t,
                ["resolves"] = kind,
                ["detail"] = detail,
                ["patches"] = counts[t],
                ["warning"] = warning.Length == 0 ? null : warning,
            });
        }

        if (args.Contains("--json"))
        {
            Log.Info(new JObject
            {
                ["kind"] = "texture-plan",
                ["export"] = Path.GetFileName(customDir.TrimEnd('\\', '/')),
                ["level"] = level,
                ["manifest"] = manifest?.Count,
                ["slots"] = slots == int.MaxValue ? null : slots,
                ["refs"] = rows,
                ["targetPages"] = target + bare,
                ["donorPages"] = donor,
                ["encodedPages"] = encoded,
                ["installs"] = donor + encoded,
            }.ToString(Newtonsoft.Json.Formatting.Indented));
            return 0;
        }

        Log.Info($"texture-plan: {Path.GetFileName(customDir.TrimEnd('\\', '/'))} -> {level}"
            + (manifest == null ? $" (no {FileName})" : $" ({FileName}, {manifest.Count} source(s))"));
        foreach (var row in rows)
        {
            string action = (string?)row["resolves"] switch
            {
                "target" => $"target page   {row["detail"]}",
                "donor" => $"donor page    {row["detail"]}",
                "encode" => $"encode        {row["detail"]}",
                _ => $"unresolved    {row["detail"]}",
            };
            if ((string?)row["warning"] is string note) action += $"   WARN: {note}";
            Log.Info($"  {(string?)row["ref"],-32} {action,-46} x{(int?)row["patches"]}");
        }
        Log.Info($"  {order.Count} distinct ref(s): {target + bare} target page(s), {donor} donor page(s), "
            + $"{encoded} encoded page(s) — {donor + encoded} install(s)");
        return 0;
    }
}
