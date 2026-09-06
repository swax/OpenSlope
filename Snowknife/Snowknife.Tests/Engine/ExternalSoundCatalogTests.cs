using Snowknife.Engine;

namespace Snowknife.Tests.Engine;

/// <summary>
/// The fixed-bank half of the retail special/external sound dispatcher. Runtime views are generated from one
/// reviewed identifier catalog, so this checks its shape against the ranges the resolver dispatches rather
/// than pinning a second copy of every name in test code.
/// </summary>
public class ExternalSoundCatalogTests
{
    static readonly int[] SpecialIds = Enumerable.Range(0, 256)
        .Where(ExternalSoundCatalog.IsSpecialBankEvent)
        .ToArray();

    [Fact]
    public void TheSpecialRangesAreTheOnesTheResolverDispatches()
    {
        Assert.Equal(
            Enumerable.Range(79, 18)
                .Concat(new[] { 102 })
                .Concat(Enumerable.Range(103, 45))
                .Concat(Enumerable.Range(159, 20))
                .Concat(Enumerable.Range(183, 3))
                .ToArray(),
            SpecialIds);
    }

    [Theory]
    [InlineData(78)]
    [InlineData(97)]
    [InlineData(101)]
    [InlineData(148)]
    [InlineData(158)]
    [InlineData(179)]
    [InlineData(182)]
    [InlineData(186)]
    [InlineData(0)]
    public void IdsOutsideThoseRangesAreNotSpecial(int eventId)
    {
        Assert.False(ExternalSoundCatalog.IsSpecialBankEvent(eventId));
    }

    [Fact]
    public void EverySpecialEventExceptTheCrowdChantResolvesToAFixedBank()
    {
        // The completeness claim the class makes: of the three resolve-time entries, only 102 stays genuinely
        // dynamic. A gap here means a level's ambient loop silently gets no clip at all.
        foreach (int eventId in SpecialIds)
        {
            bool resolved = ExternalSoundCatalog.TryGetFixedBank(eventId, out string bank);
            if (ExternalSoundCatalog.IsDynamicSpecialEvent(eventId))
            {
                Assert.False(resolved, $"event {eventId} is dynamic but carries a fixed bank");
                continue;
            }
            Assert.True(resolved, $"special event {eventId} has no fixed bank");
            Assert.False(string.IsNullOrWhiteSpace(bank), $"event {eventId} resolved to an empty bank name");
        }
    }

    [Fact]
    public void OnlyTheCrowdChantIsDynamic()
    {
        Assert.True(ExternalSoundCatalog.IsDynamicSpecialEvent(102));
        Assert.All(SpecialIds.Where(id => id != 102),
            id => Assert.False(ExternalSoundCatalog.IsDynamicSpecialEvent(id)));
    }

    [Fact]
    public void BothTrafficChannelsResolveToTheSameReachableLoop()
    {
        // Events 95 and 134 switch on flags that nothing in retail ever clears, so Traffic_Loop2 is
        // unreachable and both land on Trafficloop.
        Assert.True(ExternalSoundCatalog.TryGetFixedBank(95, out string first));
        Assert.True(ExternalSoundCatalog.TryGetFixedBank(134, out string second));

        Assert.Equal("Trafficloop", first);
        Assert.Equal("Trafficloop", second);
    }

    [Fact]
    public void AnIdOutsideTheTableResolvesToNothing()
    {
        Assert.False(ExternalSoundCatalog.TryGetFixedBank(102, out _));
        Assert.False(ExternalSoundCatalog.TryGetFixedBank(1, out _));
        Assert.False(ExternalSoundCatalog.TryGetFixedBank(1000, out _));
    }

    [Fact]
    public void ABankNameWithRetailsTrailingSpaceIsNormalizedForOutput()
    {
        // The AUDIO.BIG member is literally "Wolf .bnk". The decoded folder and the manifest path must not be.
        Assert.Equal("Wolf", ExternalSoundCatalog.OutputBankName("Wolf "));
        Assert.Equal("Wolf", ExternalSoundCatalog.OutputBankName("Wolf"));
        Assert.Equal("Audio/SFX/Wolf/000.wav", ExternalSoundCatalog.ClipPath("Wolf "));
    }

    [Fact]
    public void ClipPathsUseForwardSlashesForEveryFixedBank()
    {
        // These land in a manifest that Unity reads, so a backslash from a Windows path join would not resolve.
        foreach (int eventId in SpecialIds.Where(id => !ExternalSoundCatalog.IsDynamicSpecialEvent(id)))
        {
            Assert.True(ExternalSoundCatalog.TryGetFixedBank(eventId, out string bank));
            string path = ExternalSoundCatalog.ClipPath(bank);
            Assert.StartsWith("Audio/SFX/", path, StringComparison.Ordinal);
            Assert.EndsWith("/000.wav", path, StringComparison.Ordinal);
            Assert.DoesNotContain('\\', path);
        }
    }
}
