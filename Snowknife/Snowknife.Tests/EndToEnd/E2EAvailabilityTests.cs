namespace Snowknife.Tests.EndToEnd;

/// <summary>
/// Guards on the disc-backed tier itself, and deliberately part of the FAST tier — plain
/// <see cref="FactAttribute"/>, no <c>Category</c> trait, so these run on every checkout including CI's.
///
/// Skipping is how that tier stays green without a disc, and it is also how it could quietly stop existing:
/// thirty-odd skipped tests read exactly like thirty-odd passed ones. Nothing else here notices if the
/// probe starts reporting "unavailable" for a reason that is no longer true.
/// </summary>
public class E2EAvailabilityTests
{
    [Fact]
    public void TheDiscBackedTierIsOnWhereverItsInputsAre()
    {
        // Two ways for the tier to be legitimately off: someone asked for the fast inner loop, or this is a
        // checkout with no disc (CI, and any clone). Neither is a fault, and neither is silent — the runner
        // prints the skip count and this reason with every run.
        if (Environment.GetEnvironmentVariable("SNOWKNIFE_SKIP_E2E") == "1") return;
        if (!File.Exists(E2E.BaseIso)) return;

        // Past that, the image IS here, so the tier is meant to be running. Anything still holding it back is
        // missing derived data, which the message names along with the command that produces it.
        Assert.True(E2E.Unavailable is null,
            $"{E2E.BaseIsoName} is present, so the end-to-end tier should be running — but it is skipping: "
            + E2E.Unavailable);
    }

    [Fact]
    public void TheHarnessAndTheTestsRideTheSameIso()
    {
        // The tests assert on an ISO built with the flags in E2E.PackFlags; the autotest harness rides one it
        // packs itself. Those are two independent call sites, and if they drift the suite is making claims
        // about a configuration nothing plays. Python source is the only mechanism across that boundary.
        string harness = File.ReadAllText(
            Path.Combine(E2E.Root, "Trailmap", "tools", "autotest", "run.py"));

        Assert.Contains($"\"{E2E.BaseIsoName}\"", harness, StringComparison.Ordinal);
        Assert.Contains($"SLOT = \"{E2E.Slot}\"", harness, StringComparison.Ordinal);
        foreach (string flag in E2E.PackFlags)
            Assert.True(harness.Contains($"\"{flag}\"", StringComparison.Ordinal),
                $"run.py no longer packs with {flag} — E2E.PackFlags is asserting on an ISO nobody rides");
    }
}
