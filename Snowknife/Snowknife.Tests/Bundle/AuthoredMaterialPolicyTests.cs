using Snowknife.Bundle;

namespace Snowknife.Tests.Bundle;

/// <summary>
/// The two rules that keep Slopesmith's authored OBJ dialect from being read as retail data: an object-part
/// suffix on a material slot is disc-packing metadata rather than a new material, and an authored custom
/// material has no native appearance-flags word, so its PNG's own alpha is authoritative.
/// </summary>
public class AuthoredMaterialPolicyTests
{
    [Theory]
    [InlineData("9_obj4", "9")]
    [InlineData("9_obj12", "9")]
    [InlineData("untextured_obj12", "untextured")]
    [InlineData("model_Custom_MediumFir_0_obj3", "model_Custom_MediumFir_0")]
    public void ANumericObjectSuffixIsMetadataAndComesOff(string slot, string expected)
    {
        Assert.Equal(expected, AuthoredMaterialPolicy.StripObjectSuffix(slot));
    }

    [Fact]
    public void AScrollTagIsPartOfTheMaterialAndSurvives()
    {
        Assert.Equal("9_scr2", AuthoredMaterialPolicy.StripObjectSuffix("9_scr2_obj4"));
    }

    [Theory]
    [InlineData("9_object")]        // not the contract suffix
    [InlineData("9_obj")]           // no index after the marker
    [InlineData("9_objA")]          // not numeric
    [InlineData("9_obj4x")]         // trailing non-digit
    [InlineData("9")]               // no suffix at all
    [InlineData("")]
    public void AnythingThatIsNotTheContractSuffixIsLeftAlone(string slot)
    {
        Assert.Equal(slot, AuthoredMaterialPolicy.StripObjectSuffix(slot));
    }

    [Fact]
    public void OnlyTheLastObjectSuffixIsRemoved()
    {
        // The marker is matched from the right, so an earlier "_objN" is part of the material's own name.
        Assert.Equal("part_obj2", AuthoredMaterialPolicy.StripObjectSuffix("part_obj2_obj7"));
    }

    [Fact]
    public void AuthoredCustomMaterialsUseTheirPngAlpha()
    {
        Assert.True(AuthoredMaterialPolicy.UsesPixelAlpha("model_Custom_MediumFir_0"));
        Assert.True(AuthoredMaterialPolicy.UsesPixelAlpha("MODEL_CUSTOM_anything"));   // the check is case-insensitive
    }

    [Fact]
    public void RetailMaterialsKeepTheirNativeAppearanceFlags()
    {
        Assert.False(AuthoredMaterialPolicy.UsesPixelAlpha("model_DONOR_0037"));
        Assert.False(AuthoredMaterialPolicy.UsesPixelAlpha("9"));
        Assert.False(AuthoredMaterialPolicy.UsesPixelAlpha(null));
        Assert.False(AuthoredMaterialPolicy.UsesPixelAlpha(""));
    }
}
