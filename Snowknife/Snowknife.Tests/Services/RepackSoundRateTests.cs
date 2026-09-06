using Snowknife.Repack;
using Snowknife.Services;

namespace Snowknife.Tests.Services;

/// <summary>
/// `--sound-rate`, the audio half of the same trade `--texture-type2` makes: what a build is willing to spend
/// on a bank that gets uploaded whole. Parsed here rather than at the point of use so a typo is refused
/// before an ISO is copied, which is the only cheap moment to refuse it.
///
/// The flag is an OVERRIDE, not a ceiling, and absent does not mean untouched: 0 tells the injection to take
/// the target bank's own rate, and every clip is converted to it either way. `CourseBankInjectRateTests`
/// covers what 0 resolves to; what is settled here is only the parse.
/// </summary>
public class RepackSoundRateTests
{
    static (bool Ok, int Rate, string? Error) Parse(params string[] args)
    {
        bool ok = RepackService.TryParseSoundRate(args, out int rate, out string? error);
        return (ok, rate, error);
    }

    [Fact]
    public void AbsentAsksForNoOverride_SoTheInjectionTakesTheBanksOwnRate()
    {
        Assert.Equal((true, 0, null), Parse("repack", "in.iso", "DONOR", "maps", "custom", "out.iso"));
    }

    [Fact]
    public void BareTakesRetailsOwnRate()
    {
        Assert.Equal((true, CourseBankInject.RetailSoundRate, null), Parse("repack", "--sound-rate"));
        // Still bare when another flag follows it rather than a number.
        Assert.Equal((true, CourseBankInject.RetailSoundRate, null), Parse("repack", "--sound-rate", "--dry-run"));
    }

    [Fact]
    public void AnExplicitRateIsTakenInEitherSpelling()
    {
        Assert.Equal((true, 16000, null), Parse("repack", "--sound-rate", "16000"));
        Assert.Equal((true, 16000, null), Parse("repack", "--sound-rate=16000"));
    }

    [Theory]
    [InlineData("0")]
    [InlineData("100")]
    [InlineData("96000")]
    [InlineData("22.05k")]
    [InlineData("lots")]
    public void ARateThatCouldNotBeMeantIsRefusedWithTheRangeInTheMessage(string value)
    {
        var (ok, rate, error) = Parse("repack", "--sound-rate", value);

        Assert.False(ok);
        Assert.Equal(0, rate);
        Assert.Contains("4000", error);
        Assert.Contains("48000", error);
    }

    [Fact]
    public void TheLastOneWinsRatherThanTheFirst()
    {
        // repack-many appends the manifest's value onto a caller-built argument list, so a duplicate is a
        // late override rather than a conflict to reject.
        Assert.Equal((true, 16000, null), Parse("repack", "--sound-rate", "22050", "--sound-rate", "16000"));
    }
}
