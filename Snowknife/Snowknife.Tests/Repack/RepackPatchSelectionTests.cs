using Snowknife.Repack;

namespace Snowknife.Tests.Repack;

public class RepackPatchSelectionTests
{
    [Fact]
    public void OneCommaSeparatedValueSelectsEveryRequestedPatch()
    {
        bool ok = RepackPatchSelection.TryParse(
            ["repack", "in.iso", "DONOR", "Maps/DONOR", "Export", "out.iso",
             "--patches", "noclip,hud-text"],
            out var patches, out string? error);

        Assert.True(ok, error);
        Assert.True(patches.Noclip);
        Assert.True(patches.HudText);
    }

    [Fact]
    public void EqualsFormAndRepeatedOptionsAreAccepted()
    {
        bool ok = RepackPatchSelection.TryParse(
            ["repack", "--patches=noclip", "--patches", "hud-text"],
            out var patches, out string? error);

        Assert.True(ok, error);
        Assert.True(patches.Noclip);
        Assert.True(patches.HudText);
    }

    [Theory]
    [InlineData("bogus", "unknown patch 'bogus'")]
    [InlineData("noclip,", "needs a comma-separated list")]
    public void InvalidListsAreRejected(string value, string expected)
    {
        bool ok = RepackPatchSelection.TryParse(
            ["repack", "--patches", value], out _, out string? error);

        Assert.False(ok);
        Assert.Contains(expected, error, StringComparison.Ordinal);
    }

    [Fact]
    public void MissingListIsRejected()
    {
        bool ok = RepackPatchSelection.TryParse(
            ["repack", "--patches", "--dry-run"], out _, out string? error);

        Assert.False(ok);
        Assert.Contains("needs a comma-separated list", error, StringComparison.Ordinal);
    }
}
