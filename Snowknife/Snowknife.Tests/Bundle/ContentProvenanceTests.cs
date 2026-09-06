using System.Text.Json;
using Snowknife.Bundle;

namespace Snowknife.Tests.Bundle;

public sealed class ContentProvenanceTests
{
    [Fact]
    public void CurrentAuthoredManifestCarriesItsDecisionIntoTheBundle()
    {
        using var temp = new TempDir();
        File.WriteAllText(temp.File("Slopesmith.json"), JsonSerializer.Serialize(new
        {
            schema = 1,
            kind = "slopesmith-export",
            provenance = new
            {
                source = "slopesmith-authored",
                publicDistribution = "rights-review-required",
                retailDerived = false,
                userSupplied = true,
                reasons = new[] { "user-texture" },
            },
        }));

        var provenance = ContentProvenance.Read(temp.Path);
        Assert.Equal(ContentProvenance.ReviewRequired, provenance.PublicDistribution);
        Assert.True(provenance.UserSupplied);
        Assert.Equal(["user-texture"], provenance.Reasons);
        Assert.False(ContentProvenance.CanStagePublic(provenance, false, out _));
        Assert.True(ContentProvenance.CanStagePublic(provenance, true, out _));
    }

    [Fact]
    public void RetailAndUnknownContentFailClosedEvenWithConfirmation()
    {
        var retail = new BundleManifest.ProvenanceInfo
        {
            Source = "slopesmith-authored",
            PublicDistribution = ContentProvenance.RetailBlocked,
            RetailDerived = true,
            Reasons = ["retail-prop-art"],
        };
        Assert.False(ContentProvenance.CanStagePublic(retail, true, out string retailMessage));
        Assert.Contains("must be replaced", retailMessage);

        using var temp = new TempDir();
        var unknown = ContentProvenance.Read(temp.Path);
        Assert.Equal(ContentProvenance.UnknownBlocked, unknown.PublicDistribution);
        Assert.False(ContentProvenance.CanStagePublic(unknown, true, out _));

        var forgedAllowed = new BundleManifest.ProvenanceInfo
        {
            Source = "slopesmith-authored",
            PublicDistribution = ContentProvenance.Allowed,
            RetailDerived = true,
            Reasons = ["retail-texture"],
        };
        Assert.False(ContentProvenance.CanStagePublic(forgedAllowed, true, out string forgedMessage));
        Assert.Contains("inconsistent", forgedMessage);
    }
}
