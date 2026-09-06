using Newtonsoft.Json.Linq;
using Snowknife.Formats;

namespace Snowknife.Repack;

/// <summary>One page the ssh allocator placed, as it landed.</summary>
/// <param name="Order">Allocation order — the order <c>repack</c> installs pages in.</param>
/// <param name="Kind">Which channel supplied it: <c>borrowed</c>, <c>custom</c> or <c>override</c>.</param>
/// <param name="Key">The allocator's dedupe/installation key, e.g. <c>"GARI/0019.png"</c>.</param>
/// <param name="Source">The authored ref that named it — the <c>TexturePath</c>, prop material or level material.</param>
/// <param name="Reused">True when it overwrote a reusable original slot; false when it grew the bank.</param>
/// <param name="Slot">The bare 4-digit slot it received.</param>
/// <param name="Width">Shipped pixel width, read from the encoded/verbatim page header.</param>
/// <param name="Height">Shipped pixel height, read from the same header.</param>
/// <param name="InstalledBytes">Bytes the page occupies in the bank (its chunk chain, 16-byte padded).</param>
/// <param name="VramBytes">GS texel cost of an encoded page in the selected format; 0 for a verbatim borrow.</param>
internal readonly record struct PlanPage(int Order, string Kind, string Key, string Source, bool Reused,
                                         string Slot, int Width, int Height, int InstalledBytes, long VramBytes);

/// <summary>How one start dataset's six rider slots resolved.</summary>
/// <param name="Dataset">"AIP" (Race/Freeride) or "SOP" (Show Off).</param>
/// <param name="Source">Where the dataset came from.</param>
/// <param name="Normalized">Whether the six-slot field had to be rebuilt from valid designated starts.</param>
/// <param name="Paths">How many paths the built dataset carries.</param>
/// <param name="Slots">The six <c>StartPosList</c> indices as built.</param>
internal readonly record struct PlanStart(string Dataset, string Source, bool Normalized, int Paths, int[] Slots);

/// <summary>What the target slot's sky costs.</summary>
/// <param name="Kind">"none", "verbatim", "donor" or "custom".</param>
/// <param name="Level">The donor level, when one supplies the bank.</param>
/// <param name="Pages">Pages re-encoded, for a custom sky.</param>
/// <param name="Bytes">Bank bytes the sky ships as.</param>
/// <param name="Note">The one-line description a human reads.</param>
internal readonly record struct PlanSky(string Kind, string Level, int Pages, long Bytes, string Note);

/// <summary>One thing the build drops, falls back on, or ships past a measured ceiling.</summary>
internal readonly record struct PlanFinding(string Code, string Message);

/// <summary>
/// What <c>repack --dry-run</c> observed: the real pipeline's own allocation, run to the point where bytes
/// would be written and reported instead. Every number here is recorded BY the step that produces it — the
/// protected-slot scan, the reuse-before-append assignment, <see cref="SshBank.ReplacePages"/> /
/// <see cref="SshBank.Append"/>, the page encoder, the six-slot start normalization and the skybox injector all
/// hand their own results in. Nothing is predicted, so a reported number cannot disagree with the build.
///
/// The human report and <c>--json</c> are two renderings of this one record.
/// </summary>
internal sealed class RepackPlan
{
    /// <summary>The installed custom pages' proven-clean GS aggregate [measured, GARI + PCSX2] (docs/repack-technical-reference.md).</summary>
    public const long VramBudgetBytes = 512 * 1024;

    /// <summary>Bank page count verified in game (docs/repack-technical-reference.md). Past it the append is unproven, not refused.</summary>
    public const int AppendCeiling = 127;

    /// <summary>One page handed to the allocator, with the blob the encoder/donor actually produced.</summary>
    /// <param name="Kind">"borrowed", "custom" or "override".</param>
    /// <param name="Key">The allocator's installation key.</param>
    /// <param name="Source">The authored ref that named it.</param>
    /// <param name="Blob">The page's chunk-chain bytes, exactly as installed.</param>
    internal readonly record struct Install(string Kind, string Key, string Source, byte[] Blob);

    private readonly List<PlanPage> _pages = new();
    private readonly List<PlanFinding> _findings = new();
    private readonly List<PlanStart> _starts = new();

    private bool _allocated;
    private int _textureCeiling;
    private int _originalSlots, _retainedSlots, _reusableSlots, _projectedSlots, _reusedPages;
    private long _originalBankBytes, _projectedBankBytes;
    private long _retainedOriginalBytes, _reusedInstallBytes, _freeReusableBytes, _appendedBytes;
    private PlanSky _sky = new("none", "", 0, 0, "the export authored no sky — the target's own is kept verbatim");
    private string _pathPlan = "";
    private string _alignment = "";
    private double _overlap;
    private double[]? _targetBounds, _authoredBounds;
    private double[]? _raceOrigin;

    public RepackPlan(string level, string exportDir, bool textureType2)
    {
        Level = level;
        Export = Path.GetFileName(exportDir.TrimEnd('\\', '/'));
        Format = textureType2 ? "type-2" : "type-5";
    }

    /// <summary>The retail slot being replaced.</summary>
    public string Level { get; }

    /// <summary>The export folder's name.</summary>
    public string Export { get; }

    /// <summary>The encoder custom pages are priced and shipped in: <c>type-5</c> or <c>type-2</c>.</summary>
    public string Format { get; }

    /// <summary>
    /// The GS ladder ceiling the encoded pages were conformed to: the largest rung whose aggregate fits
    /// <see cref="VramBudgetBytes"/>, chosen from the set actually being installed
    /// (<see cref="Formats.GsTextureLadder"/>). Zero while no page needs encoding, which is when there is no
    /// such decision to report.
    /// </summary>
    public void TextureCeiling(int edge) => _textureCeiling = edge;

    /// <summary>The bank's original page count, read before anything is installed.</summary>
    public void Bank(int slots)
    {
        _originalSlots = slots;
        _projectedSlots = slots;
    }

    /// <summary>
    /// Name something the build will drop, fall back on, or ship unproven. The same finding raised twice —
    /// one ref repeated across hundreds of patches — is one line.
    /// </summary>
    public void Note(string code, string message)
    {
        var finding = new PlanFinding(code, message);
        if (!_findings.Contains(finding)) _findings.Add(finding);
    }

    /// <summary>
    /// Record the allocation the real installer just performed: which original slots it protected, which it
    /// left reusable, and where every page it built landed. <paramref name="originalBank"/> and
    /// <paramref name="newBank"/> are the bank bytes before and after, so the byte column is measured rather
    /// than modelled.
    /// </summary>
    public void Allocation(byte[] originalBank, byte[] newBank, IReadOnlyCollection<int> protectedSlots,
                           IReadOnlyList<int> reusableSlots, IReadOnlyList<Install> installs,
                           IReadOnlyList<string> assignedSlots, int reused)
    {
        var bank = SshBank.Load(originalBank);
        _allocated = true;
        _originalSlots = bank.Count;
        _retainedSlots = protectedSlots.Count;
        _reusableSlots = reusableSlots.Count;
        _reusedPages = reused;
        _originalBankBytes = originalBank.Length;
        _projectedBankBytes = newBank.Length;
        _projectedSlots = SshBank.Load(newBank).Count;

        foreach (int slot in protectedSlots) _retainedOriginalBytes += bank.Extent(slot).len;
        for (int i = reused; i < reusableSlots.Count; i++) _freeReusableBytes += bank.Extent(reusableSlots[i]).len;

        for (int i = 0; i < installs.Count; i++)
        {
            var install = installs[i];
            int installed = Align16(install.Blob.Length);
            bool isReuse = i < reused;
            if (isReuse) _reusedInstallBytes += installed; else _appendedBytes += installed;
            var (w, h) = PageSize(install.Blob);
            long vram = install.Kind == "borrowed" ? 0 : (long)w * h * (Format == "type-2" ? 1 : 4);
            _pages.Add(new PlanPage(i + 1, install.Kind, install.Key, install.Source, isReuse,
                                    assignedSlots[i], w, h, installed, vram));
        }
    }

    /// <summary>
    /// Record how the six rider start slots came out of one built dataset. <paramref name="anchor"/> marks the
    /// dataset the StageArea relocation reads, so the reported race-line origin is the field it moves onto.
    /// </summary>
    public void StartSlots(string dataset, string source, JObject root, bool normalized, bool anchor = false)
    {
        var slots = (root["StartPosList"] as JArray ?? new JArray()).Select(t => (int?)t ?? -1).ToArray();
        _starts.Add(new PlanStart(dataset, source, normalized, (root["AIPaths"] as JArray)?.Count ?? 0, slots));
        if (anchor && (root["RaceLines"] as JArray)?.FirstOrDefault() is JObject line
            && line["PathPos"] is JArray pos && pos.Count >= 3)
            _raceOrigin = new[] { (double)pos[0], (double)pos[1], (double)pos[2] };
    }

    /// <summary>What ships for the course paths, and what happens to the retail start anchor.</summary>
    public void Paths(string plan) => _pathPlan = plan;

    /// <summary>What the sky injector decided.</summary>
    public void Sky(PlanSky sky) => _sky = sky;

    /// <summary>
    /// Whether the authored mountain sits inside the target's own horizontal footprint. Both boxes come from
    /// the two <c>Patches.json</c> control-point sets this build reads — raw X,Y is the horizontal plane
    /// (raw Z is up). An overlapping mountain can ride the target's <c>aip</c>/<c>sop</c>; one authored
    /// elsewhere must ship its own, which is what <see cref="Paths"/> reports actually happening.
    /// </summary>
    public void Footprint(string targetPatches, string authoredPatches)
    {
        _targetBounds = Bounds(targetPatches);
        _authoredBounds = Bounds(authoredPatches);
        if (_targetBounds == null || _authoredBounds == null)
        {
            _alignment = _targetBounds == null
                ? $"{Level} has no readable terrain bounds — overlap unknown"
                : "the export has no readable terrain bounds — overlap unknown";
            return;
        }
        double ox = Math.Max(0, Math.Min(_authoredBounds[2], _targetBounds[2]) - Math.Max(_authoredBounds[0], _targetBounds[0]));
        double oy = Math.Max(0, Math.Min(_authoredBounds[3], _targetBounds[3]) - Math.Max(_authoredBounds[1], _targetBounds[1]));
        double area = (_authoredBounds[2] - _authoredBounds[0]) * (_authoredBounds[3] - _authoredBounds[1]);
        _overlap = area > 0 ? ox * oy / area : 0;
        _alignment = _overlap > 0.5
            ? $"authored on {Level}'s frame ({_overlap * 100:F0}% of its own footprint overlaps) — can ride its aip/sop"
            : $"authored off {Level}'s frame ({_overlap * 100:F0}% of its own footprint overlaps) — stands alone";
    }

    /// <summary>
    /// Findings the finished plan carries that no single step owns: a page whose shipped size is not a power
    /// of two, a bank grown past the page count proven in game, and a custom aggregate over the proven-clean
    /// GS budget. The first reads the header of the page that ships, so it names exactly the images the
    /// ladder conform could not take — one it could not decode ships at its own size.
    /// </summary>
    public void Finish()
    {
        foreach (var page in _pages)
        {
            if (page.Kind == "borrowed" || (IsPot(page.Width) && IsPot(page.Height))) continue;
            Note("no-pot-conform", $"{page.Source} encodes at {page.Width}x{page.Height} — not a power-of-two page. "
                + "Its image did not survive the GS ladder conform, so it ships at a size the hardware cannot address.");
        }
        int appended = _pages.Count - _reusedPages;
        if (appended > 0 && _projectedSlots > AppendCeiling)
            Note("append-ceiling", $"{appended} page(s) append, growing the bank from {_originalSlots} to {_projectedSlots} "
                + $"— past the {AppendCeiling}-page overflow proven in game, so the extra pages ship unverified.");
        long vram = CustomVramBytes;
        if (vram > VramBudgetBytes)
            Note("vram-budget", $"the {CustomPages} encoded page(s) total {Kb(vram)} KB of GS texels ({Format}), "
                + $"over the {Kb(VramBudgetBytes)} KB proven clean — custom pages can corrupt in game.");
    }

    /// <summary>Encoded (non-verbatim) pages this build installs.</summary>
    public int CustomPages => _pages.Count(p => p.Kind != "borrowed");

    /// <summary>Their aggregate GS texel cost in the selected format — the VRAM bar, from the installed pages.</summary>
    public long CustomVramBytes => _pages.Sum(p => p.VramBytes);

    /// <summary>The part of that aggregate landing in reused original slots.</summary>
    public long CustomReusedVramBytes => _pages.Where(p => p.Reused).Sum(p => p.VramBytes);

    /// <summary>The part landing in appended slots.</summary>
    public long CustomAppendedVramBytes => _pages.Where(p => !p.Reused).Sum(p => p.VramBytes);

    /// <summary>The levels whose banks supply this build's verbatim borrows, from the keys the allocator used.</summary>
    public IEnumerable<string> DonorLevels => _pages
        .Where(p => p.Kind == "borrowed" && p.Key.Contains('/'))
        .Select(p => p.Key[..p.Key.IndexOf('/')])
        .Distinct(StringComparer.OrdinalIgnoreCase);

    /// <summary>Bank bytes neither retained, reused, freed nor appended: the SHPS header and directory.</summary>
    private long OverheadBytes =>
        _projectedBankBytes - _retainedOriginalBytes - _reusedInstallBytes - _freeReusableBytes - _appendedBytes;

    /// <summary>The plan a human reads. Same fields, same order and same numbers as <see cref="ToJson"/>.</summary>
    public void WriteTo(TextWriter w)
    {
        w.WriteLine();
        w.WriteLine($"── Plan · {Level} ← {Export} · custom pages: {Format}");
        w.WriteLine();
        w.WriteLine("Slots");
        if (_allocated)
        {
            w.WriteLine($"  original                {_originalSlots,8:n0}");
            w.WriteLine($"  retained                {_retainedSlots,8:n0}   referenced by kept materials/flipbooks, the terrain's own pages, and slot 0000");
            w.WriteLine($"  reusable                {_reusableSlots,8:n0}   {_reusedPages:n0} taken, {_reusableSlots - _reusedPages:n0} left");
            w.WriteLine($"  projected               {_projectedSlots,8:n0}   {(_projectedSlots == _originalSlots ? "nothing appended" : $"+{_projectedSlots - _originalSlots:n0} appended")}");
        }
        else
        {
            w.WriteLine($"  original                {_originalSlots,8:n0}");
            w.WriteLine("  retained / reusable            —   no page needs installing, so the allocator does not run; the bank ships verbatim");
        }

        w.WriteLine();
        w.WriteLine($"Pages to install ({_pages.Count:n0}, allocation order)");
        if (_pages.Count == 0) w.WriteLine("  (none)");
        foreach (var page in _pages)
        {
            string where = page.Reused ? $"reuse -> slot {page.Slot}" : $"append -> slot {page.Slot}";
            w.WriteLine($"  {page.Order,3}  {where,-22} {page.Kind,-8} {Trim(page.Source, 44),-44} "
                + $"{Dims(page),-11} {page.InstalledBytes,9:n0} B"
                + (page.VramBytes > 0 ? $"  {Kb(page.VramBytes),6:n0} KB GS" : ""));
        }

        if (_allocated)
        {
            w.WriteLine();
            w.WriteLine("Bytes");
            w.WriteLine($"  retained original       {_retainedOriginalBytes,12:n0}");
            w.WriteLine($"  reused install          {_reusedInstallBytes,12:n0}");
            w.WriteLine($"  free in reusable pool   {_freeReusableBytes,12:n0}");
            w.WriteLine($"  appended                {_appendedBytes,12:n0}");
            w.WriteLine($"  header + directory      {OverheadBytes,12:n0}");
            w.WriteLine($"  projected bank          {_projectedBankBytes,12:n0}   original {_originalBankBytes:n0} "
                + $"({_projectedBankBytes - _originalBankBytes:+#,##0;-#,##0;0})");
        }

        w.WriteLine();
        w.WriteLine($"Custom pages ({Format}, GS texels"
            + (_textureCeiling > 0 ? $", GS ladder ceiling {_textureCeiling} px" : "") + ")");
        var custom = _pages.Where(p => p.Kind != "borrowed").ToList();
        if (custom.Count == 0) w.WriteLine("  (none)");
        foreach (var page in custom)
            w.WriteLine($"  {Trim(page.Source, 44),-44} {Dims(page),-11} {Kb(page.VramBytes),6:n0} KB");
        long vram = CustomVramBytes;
        w.WriteLine($"  {custom.Count:n0} page(s)".PadRight(46)
            + $"{Kb(vram):n0} KB of the {Kb(VramBudgetBytes):n0} KB proven-clean budget "
            + $"({Percent(vram, VramBudgetBytes)}) — {(vram <= VramBudgetBytes ? "fits" : "OVER")}");
        w.WriteLine("  ".PadRight(46) + $"{Kb(CustomReusedVramBytes):n0} KB in reused slots + "
            + $"{Kb(CustomAppendedVramBytes):n0} KB appended");

        w.WriteLine();
        w.WriteLine("Paths and placement");
        w.WriteLine($"  footprint    {_alignment}");
        w.WriteLine($"  aip / sop    {_pathPlan}");
        foreach (var start in _starts)
            w.WriteLine($"  start slots  {start.Dataset}: [{string.Join(", ", start.Slots)}] of {start.Paths:n0} path(s)"
                + $" from {start.Source}{(start.Normalized ? " (normalized to six valid slots)" : "")}");
        if (_raceOrigin != null)
            w.WriteLine($"  stage area   Mdl_StageArea_Start_0 moved onto the authored race-line origin "
                + $"({_raceOrigin[0]:F1}, {_raceOrigin[1]:F1}, {_raceOrigin[2]:F1})");

        w.WriteLine();
        w.WriteLine("Sky");
        w.WriteLine($"  {_sky.Note}");

        w.WriteLine();
        w.WriteLine($"Findings ({_findings.Count:n0})");
        if (_findings.Count == 0) w.WriteLine("  nothing is dropped or falls back.");
        foreach (var finding in _findings)
            w.WriteLine($"  {finding.Code,-26} {finding.Message}");

        w.WriteLine();
        w.WriteLine("No bytes written: --dry-run builds no ISO.");
    }

    /// <summary>The same plan as a record. Asserting this is asserting the build's allocation.</summary>
    public JObject ToJson() => new()
    {
        ["kind"] = "repack-dry-run",
        ["level"] = Level,
        ["export"] = Export,
        ["customPageFormat"] = Format,
        ["slots"] = new JObject
        {
            ["allocatorRan"] = _allocated,
            ["original"] = _originalSlots,
            ["retained"] = _allocated ? _retainedSlots : null,
            ["reusable"] = _allocated ? _reusableSlots : null,
            ["reused"] = _allocated ? _reusedPages : null,
            ["projected"] = _projectedSlots,
            ["appendCeiling"] = AppendCeiling,
        },
        ["bytes"] = !_allocated ? JValue.CreateNull() : new JObject
        {
            ["originalBank"] = _originalBankBytes,
            ["retainedOriginal"] = _retainedOriginalBytes,
            ["reusedInstall"] = _reusedInstallBytes,
            ["freeReusable"] = _freeReusableBytes,
            ["appended"] = _appendedBytes,
            ["headerAndDirectory"] = OverheadBytes,
            ["projectedBank"] = _projectedBankBytes,
        },
        ["pages"] = new JArray(_pages.Select(p => new JObject
        {
            ["order"] = p.Order,
            ["placement"] = p.Reused ? "reuse" : "append",
            ["slot"] = p.Slot,
            ["kind"] = p.Kind,
            ["key"] = p.Key,
            ["source"] = p.Source,
            ["width"] = p.Width,
            ["height"] = p.Height,
            ["installedBytes"] = p.InstalledBytes,
            ["vramBytes"] = p.VramBytes,
        })),
        ["custom"] = new JObject
        {
            ["pages"] = CustomPages,
            ["format"] = Format,
            ["ceilingEdge"] = _textureCeiling == 0 ? JValue.CreateNull() : new JValue(_textureCeiling),
            ["vramBytes"] = CustomVramBytes,
            ["reusedVramBytes"] = CustomReusedVramBytes,
            ["appendedVramBytes"] = CustomAppendedVramBytes,
            ["budgetBytes"] = VramBudgetBytes,
            ["fits"] = CustomVramBytes <= VramBudgetBytes,
        },
        ["placement"] = new JObject
        {
            ["targetBoundsRaw"] = Box(_targetBounds),
            ["authoredBoundsRaw"] = Box(_authoredBounds),
            ["overlap"] = _overlap,
            ["alignment"] = _alignment,
            ["paths"] = _pathPlan,
            ["startSlots"] = new JArray(_starts.Select(s => new JObject
            {
                ["dataset"] = s.Dataset,
                ["source"] = s.Source,
                ["normalized"] = s.Normalized,
                ["paths"] = s.Paths,
                ["slots"] = new JArray(s.Slots),
            })),
            ["raceOrigin"] = _raceOrigin == null ? JValue.CreateNull() : new JArray(_raceOrigin),
        },
        ["sky"] = new JObject
        {
            ["kind"] = _sky.Kind,
            ["level"] = _sky.Level,
            ["pages"] = _sky.Pages,
            ["bytes"] = _sky.Bytes,
            ["note"] = _sky.Note,
        },
        ["findings"] = new JArray(_findings.Select(f => new JObject
        {
            ["code"] = f.Code,
            ["message"] = f.Message,
        })),
        ["wroteIso"] = false,
    };

    /// <summary>A one-line summary for the combined <c>repack-many --dry-run</c> table.</summary>
    public string Summary() =>
        $"  {Level,-16} {Export,-22} {_pages.Count,3} page(s): {_reusedPages,3} reuse + {_pages.Count - _reusedPages,3} append"
        + $"  -> {_projectedSlots,4:n0} slots, {Kb(CustomVramBytes),5:n0} KB GS, {_findings.Count,2} finding(s)";

    // Pixel size of a page from its own SHPS image header: type@0 (u8), data size u24@1, width i16@4,
    // height i16@6 (OldShapeHandler.WriteImageHeader). The same header fronts an encoded page and a donor
    // page copied verbatim, so a shipped size is always read off the bytes that ship.
    private static (int w, int h) PageSize(byte[] blob) => blob.Length < 8
        ? (0, 0)
        : (blob[4] | (blob[5] << 8), blob[6] | (blob[7] << 8));

    private static int Align16(int n) => (n + 15) & ~15;

    private static bool IsPot(int n) => n > 0 && (n & (n - 1)) == 0;

    private static long Kb(long bytes) => (bytes + 1023) / 1024;

    private static string Percent(long value, long of) => of == 0 ? "n/a" : $"{value * 100.0 / of:F0}%";

    private static string Dims(PlanPage page) => $"{page.Width}x{page.Height}";

    private static string Trim(string text, int width) => text.Length <= width ? text : "…" + text[^(width - 1)..];

    private static JToken Box(double[]? b) => b == null
        ? JValue.CreateNull()
        : new JObject { ["min"] = new JArray(b[0], b[1]), ["max"] = new JArray(b[2], b[3]) };

    // Raw horizontal (X,Y) bounding box of a Patches.json's control points; raw Z is up. Null when the file
    // carries no readable patches.
    private static double[]? Bounds(string patchesPath)
    {
        if (!File.Exists(patchesPath)) return null;
        double minX = double.PositiveInfinity, minY = double.PositiveInfinity;
        double maxX = double.NegativeInfinity, maxY = double.NegativeInfinity;
        foreach (var patch in JObject.Parse(File.ReadAllText(patchesPath))["Patches"] as JArray ?? new JArray())
            foreach (var point in patch["Points"] as JArray ?? new JArray())
            {
                if (point is not JArray p || p.Count < 2) continue;
                double x = (double)p[0], y = (double)p[1];
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        return double.IsFinite(minX) ? new[] { minX, minY, maxX, maxY } : null;
    }
}
