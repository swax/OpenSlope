using Newtonsoft.Json.Linq;
using Snowknife.Bundle;
using Snowknife.Engine;
using static Snowknife.Tests.Bundle.EffectsFixture;

namespace Snowknife.Tests.Bundle;

/// <summary>
/// Mode gating reads the two retail leaf functions, HideShowOff and HideRace, while ignoring unrelated mode
/// entry-point nodes. Keeping those target sets separate is what allows race/show-off/freeride to be selected.
/// </summary>
public class RailGatingTests
{
    static RailGating.Result Gate(TempDir temp, JObject document) =>
        RailGating.Load(WriteLevel(temp, document));

    [Fact]
    public void NativeLtgGemLayerIsShowoffOnlyWithoutAnAuthoredHideTarget()
    {
        // LTG state 2 includes both Gem_TrickMultiplier pickups and Gem_RailSupport props. The latter have
        // no effect slot or HideShowOff target, so this native layer bit is their only mode classification.
        Assert.Equal(2, PropsBundle.ModeMaskForInstance(nativeShowoffObject: true,
            hiddenByHideShowOff: false, hiddenByHideRace: false));
        Assert.Equal(7, PropsBundle.ModeMaskForInstance(nativeShowoffObject: false,
            hiddenByHideShowOff: false, hiddenByHideRace: false));
    }

    [Fact]
    public void ARailTurnedOffByHideShowOffIsGated()
    {
        using var temp = new TempDir();

        var result = Gate(temp, Document(
            splines: new JArray(Row("spline-0", 0), Row("spline-showoff", 4)),
            functions: new JArray(Function("fn0", 0, "HideShowOff", ToggleRail("spline-showoff")))));

        Assert.Equal(new[] { 4 }, result.GatedSplines);
        Assert.True(result.Any);
    }

    [Fact]
    public void ARailToggledONIsNotGated()
    {
        // Effect 0 is the OFF that gates. Any other effect is the function turning a rail back on, and
        // gating on it would remove a rail free-ride is supposed to have.
        using var temp = new TempDir();

        var result = Gate(temp, Document(
            splines: new JArray(Row("spline-0", 0)),
            functions: new JArray(Function("fn0", 0, "HideShowOff", ToggleRail("spline-0", effect: 1)))));

        Assert.Empty(result.GatedSplines);
        Assert.False(result.Any);
    }

    [Fact]
    public void TheHiddenRailModelsAreCollectedSeparatelyFromTheSplines()
    {
        // Splines are skipped by PathBundle; instances are dropped by PropsBundle and CollisionBundle. Two
        // different consumers, so they must not be conflated.
        using var temp = new TempDir();

        var result = Gate(temp, Document(
            splines: new JArray(Row("spline-a", 2)),
            instances: new JArray(Row("inst-rail", 9)),
            functions: new JArray(Function("fn0", 0, "HideShowOff",
                ToggleRail("spline-a"),
                ActOnInstance("inst-rail")))));

        Assert.Equal(new[] { 2 }, result.GatedSplines);
        Assert.Equal(new[] { 9 }, result.HiddenInstances);
    }

    [Fact]
    public void PropsHiddenByHideRaceAreCollectedAsRaceOnly()
    {
        using var temp = new TempDir();

        var result = Gate(temp, Document(
            instances: new JArray(Row("inst-race-pad", 12)),
            functions: new JArray(Function("fn0", 0, "HideRace", ActOnInstance("inst-race-pad")))));

        Assert.Equal(new[] { 12 }, result.RaceHiddenInstances);
        Assert.Empty(result.HiddenInstances);
        Assert.True(result.Any);
    }

    [Fact]
    public void OnlyHideShowOffIsScanned()
    {
        // FreerideMode and the break dispatches also carry MainType 7 and 25 nodes. Reading them would drop
        // props the sandbox keeps.
        using var temp = new TempDir();

        var result = Gate(temp, Document(
            splines: new JArray(Row("spline-a", 0), Row("spline-b", 1)),
            instances: new JArray(Row("inst-gate", 3)),
            functions: new JArray(
                Function("fn0", 0, "HideShowOff", ToggleRail("spline-a")),
                Function("fn1", 1, "FreerideMode", ToggleRail("spline-b"), ActOnInstance("inst-gate")))));

        Assert.Equal(new[] { 0 }, result.GatedSplines);
        Assert.Empty(result.HiddenInstances);
    }

    [Fact]
    public void ALevelWithNoHideShowOffGatesNothing()
    {
        using var temp = new TempDir();

        var result = Gate(temp, Document(
            splines: new JArray(Row("spline-a", 0)),
            functions: new JArray(Function("fn0", 0, "BreakLogo1", ToggleRail("spline-a")))));

        Assert.False(result.Any);
    }

    [Fact]
    public void ALevelWithNoEffectsDocumentGatesNothing()
    {
        using var temp = new TempDir();

        var result = RailGating.Load(temp.Path);

        Assert.False(result.Any);
        Assert.Empty(result.GatedSplines);
        Assert.Empty(result.HiddenInstances);
        Assert.Empty(result.RaceHiddenInstances);
    }

    [Fact]
    public void AnEmptyHideShowOffGatesNothing()
    {
        using var temp = new TempDir();

        Assert.False(Gate(temp, Document(functions: new JArray(Function("fn0", 0, "HideShowOff")))).Any);
    }

    [Fact]
    public void NodesOfOtherMainTypesInsideHideShowOffAreIgnored()
    {
        using var temp = new TempDir();

        var result = Gate(temp, Document(
            splines: new JArray(Row("spline-a", 0)),
            functions: new JArray(Function("fn0", 0, "HideShowOff",
                Node(SsfMainType.Wait, new JObject { ["WaitTime"] = 1f }),
                ToggleRail("spline-a")))));

        Assert.Equal(new[] { 0 }, result.GatedSplines);
        Assert.Empty(result.HiddenInstances);
    }

    [Fact]
    public void RepeatedRailsAreCollectedOnce()
    {
        using var temp = new TempDir();

        var result = Gate(temp, Document(
            splines: new JArray(Row("spline-a", 5)),
            functions: new JArray(Function("fn0", 0, "HideShowOff",
                ToggleRail("spline-a"), ToggleRail("spline-a")))));

        Assert.Single(result.GatedSplines);
    }
}
