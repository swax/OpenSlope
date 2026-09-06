using Newtonsoft.Json.Linq;
using Snowknife.Services;

namespace Snowknife.Tests.EndToEnd;

/// <summary>
/// Assertions over <c>repack --dry-run --json</c> for the fixtures the autotest harness actually rides.
///
/// The dry run is the whole pipeline with the byte writes elided: it reads the source ISO's texture bank,
/// the target slot's sidecars and the authored export, then runs the real allocation, path normalization and
/// sky decision. Every number in the plan is handed over BY the step that produced it, so asserting on the
/// plan is asserting on what the packer did — not on a prediction of it.
///
/// Two of these were already the tool's own pass/fail criteria and nothing was checking them: a bank that
/// grows past the 127-page overflow "ships unverified", and custom pages over the proven-clean VRAM budget
/// "can corrupt in game". Both are conditions you would otherwise discover by booting PCSX2.
/// </summary>
[Trait("Category", "EndToEnd")]
public class RepackPlanTests
{
    /// <summary>Findings that are informational rather than a reason not to ship. <c>texture-conform</c>
    /// reports pages resampled onto the GS power-of-two ladder, which is the ladder doing its job.</summary>
    static readonly HashSet<string> BenignFindings = new(StringComparer.Ordinal) { "texture-conform" };
    static readonly Dictionary<string, JObject> Plans = new(StringComparer.Ordinal);

    public static TheoryData<string> Fixtures()
    {
        var data = new TheoryData<string>();
        foreach (string fixture in E2E.Fixtures) data.Add(fixture);
        return data;
    }

    static JObject BuildPlan(string fixture)
    {
        using var temp = new TempDir();
        var (exitCode, output) = E2E.Repack([
            "repack", E2E.BaseIso, E2E.Slot, E2E.SlotMapDir, E2E.FixtureDir(fixture),
            Path.Combine(temp.Path, "unwritten.iso"),
            .. E2E.PackFlags, "--dry-run", "--json",
        ]);

        Assert.Equal(0, exitCode);
        return JObject.Parse(output);
    }

    // A plan reads and texture-conforms a complete authored fixture. Every assertion consumes the same
    // immutable JSON, so doing that work once per fixture keeps the disc-backed tier useful as a test suite
    // rather than accidentally turning each assertion into another multi-minute integration run.
    static JObject Plan(string fixture)
    {
        if (!Plans.TryGetValue(fixture, out JObject? plan))
            Plans.Add(fixture, plan = BuildPlan(fixture));
        return plan;
    }

    [E2ETheory]
    [MemberData(nameof(Fixtures))]
    public void ThePlanDescribesTheRepackItWasAskedFor(string fixture)
    {
        var plan = Plan(fixture);

        Assert.Equal("repack-dry-run", (string?)plan["kind"]);
        Assert.Equal(E2E.Slot, (string?)plan["level"]);
        Assert.Equal(fixture, (string?)plan["export"]);
        Assert.Equal("type-2", (string?)plan["customPageFormat"]);   // --texture-type2, as the harness packs
        Assert.False((bool?)plan["wroteIso"], "a dry run must not have written an image");
    }

    [E2ETheory]
    [MemberData(nameof(Fixtures))]
    public void CustomPagesFitTheProvenCleanVramBudget(string fixture)
    {
        // The packer's own words for exceeding this: "custom pages can corrupt in game".
        var custom = Plan(fixture)["custom"]!;

        long vram = (long)custom["vramBytes"]!, budget = (long)custom["budgetBytes"]!;
        Assert.True((bool)custom["fits"]!,
            $"{fixture} reports its custom pages do not fit: {vram:n0} of {budget:n0} bytes");
        Assert.True(vram <= budget, $"{fixture} uses {vram:n0} GS bytes against a {budget:n0} budget");
    }

    [E2ETheory]
    [MemberData(nameof(Fixtures))]
    public void TheBankStaysUnderThePageOverflowCeiling(string fixture)
    {
        // Past the ceiling the extra pages "ship unverified" - the bank grew beyond what has been proven to
        // load on console.
        var slots = Plan(fixture)["slots"]!;

        int projected = (int)slots["projected"]!, ceiling = (int)slots["appendCeiling"]!;
        Assert.True(projected <= ceiling,
            $"{fixture} projects a {projected}-page bank against a {ceiling}-page proven ceiling");
    }

    [E2ETheory]
    [MemberData(nameof(Fixtures))]
    public void EveryCustomPageLandsInAReclaimedSlotRatherThanGrowingTheBank(string fixture)
    {
        // All four fixtures currently fit entirely in slots the bare-slot pass reclaims. That is the whole
        // point of the reuse-before-append policy, and losing it is the first sign the allocator regressed.
        var plan = Plan(fixture);

        Assert.Equal(0L, (long)plan["bytes"]!["appended"]!);
        Assert.Equal((int)plan["slots"]!["original"]!, (int)plan["slots"]!["projected"]!);
        Assert.All(plan["pages"]!, page => Assert.Equal("reuse", (string?)page["placement"]));
    }

    [E2ETheory]
    [MemberData(nameof(Fixtures))]
    public void ThePageListAgreesWithTheCustomPageCount(string fixture)
    {
        var plan = Plan(fixture);

        Assert.Equal((int)plan["custom"]!["pages"]!, plan["pages"]!.Count());
    }

    [E2ETheory]
    [MemberData(nameof(Fixtures))]
    public void NothingIsReportedBeyondTheKnownBenignFindings(string fixture)
    {
        var unexpected = Plan(fixture)["findings"]!
            .Select(f => (string)f["code"]!)
            .Where(code => !BenignFindings.Contains(code))
            .ToArray();

        Assert.True(unexpected.Length == 0,
            $"{fixture} reported {string.Join(", ", unexpected)}");
    }

    [E2ETheory]
    [MemberData(nameof(Fixtures))]
    public void ThePlanIsTheSameOnASecondRun(string fixture)
    {
        // Same inputs, same plan. Texture provenance walks dictionaries and reclaims slots by scan order, so
        // an unordered collection leaking into that path shows up here and nowhere else.
        Assert.Equal(Plan(fixture).ToString(), BuildPlan(fixture).ToString());
    }

    [E2EFact]
    public void TheRegressionCourseRidesTheTargetSlotsOwnRacePaths()
    {
        // GOLD is the harness's regression course, and it is authored ON GARI's frame so it can inherit the
        // slot's aip/sop paths. AUTOTEST1 deliberately overruns that footprint (it is the extensive
        // catalogue), so this is asserted for GOLD alone rather than across the fixtures.
        var placement = Plan("GOLD")["placement"]!;

        Assert.True((double)placement["overlap"]! > 0.99,
            $"GOLD's footprint overlap fell to {(double)placement["overlap"]!:F4}");
        Assert.Contains("aip/sop", (string?)placement["alignment"] ?? "", StringComparison.Ordinal);
    }

    [E2EFact]
    public void AnExportThatAuthorsNoSkyLeavesTheTargetsOwnAlone()
    {
        Assert.Equal("none", (string?)Plan("GOLD")["sky"]!["kind"]);
    }

    [E2EFact]
    public void AMissingExportIsRejectedAtTheContractBoundary()
    {
        // The pipeline validates the export's Patches.json before it touches the disc, and reports a missing
        // one by throwing; Program.Main is what turns that into exit code 2. Asserting the throw pins the
        // check to the boundary it actually happens at.
        using var temp = new TempDir();

        var error = Assert.Throws<ContractValidationException>(() => E2E.Repack([
            "repack", E2E.BaseIso, E2E.Slot, E2E.SlotMapDir,
            Path.Combine(temp.Path, "no-such-export"), Path.Combine(temp.Path, "out.iso"),
            "--dry-run",
        ]));

        Assert.Contains("Patches.json", error.Message, StringComparison.Ordinal);
    }

    [E2EFact]
    public void JsonWithoutDryRunIsRefused()
    {
        // --json describes a plan, and there is no plan when the pipeline is going to write bytes.
        using var temp = new TempDir();

        var (exitCode, _) = E2E.Repack([
            "repack", E2E.BaseIso, E2E.Slot, E2E.SlotMapDir, E2E.FixtureDir("GOLD"),
            Path.Combine(temp.Path, "out.iso"), "--json",
        ]);

        Assert.NotEqual(0, exitCode);
    }
}
