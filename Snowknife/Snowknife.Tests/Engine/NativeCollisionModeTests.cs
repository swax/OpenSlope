using Snowknife.Engine;

namespace Snowknife.Tests.Engine;

/// <summary>
/// Static rider response after a shape reports contact. The rule is deliberately narrower than it looks:
/// the collision SHAPE does not enter into it, because PlayerBounce-off was observed to suppress physical
/// response in every tested shape mode.
/// </summary>
public class NativeCollisionModeTests
{
    [Fact]
    public void TheNativeModeValuesMatchTheExtractedJsonContract()
    {
        Assert.Equal(0, NativeCollisionMode.None);
        Assert.Equal(1, NativeCollisionMode.TriangleProxy);
        Assert.Equal(2, NativeCollisionMode.BoundingBox);
        Assert.Equal(3, NativeCollisionMode.PhysicsBodySpheres);
    }

    [Fact]
    public void AnExactZeroResponseMassIsAlwaysPassThrough()
    {
        foreach (int mode in new[] { 0, 1, 2, 3 })
            Assert.False(NativeCollisionMode.HasStaticRiderResponse(mode, playerBounce: true, responseMass: 0f));
    }

    [Fact]
    public void PlayerBounceOffSuppressesResponseWhateverTheMass()
    {
        foreach (int mode in new[] { 0, 1, 2, 3 })
            Assert.False(NativeCollisionMode.HasStaticRiderResponse(mode, playerBounce: false, responseMass: 1e30f));
    }

    [Fact]
    public void APositiveMassWithBounceOnResponds()
    {
        foreach (int mode in new[] { 0, 1, 2, 3 })
            Assert.True(NativeCollisionMode.HasStaticRiderResponse(mode, playerBounce: true, responseMass: 1e30f));
    }

    [Fact]
    public void TheCollisionShapeDeliberatelyDoesNotChangeTheAnswer()
    {
        // The live mode-1 follow-up emitted its marker and passed through, matching the earlier mode-2
        // control. Anyone reintroducing a per-mode branch here should have to delete this test on purpose.
        foreach (bool bounce in new[] { true, false })
            foreach (float mass in new[] { 0f, 1f, 1e30f })
            {
                bool baseline = NativeCollisionMode.HasStaticRiderResponse(0, bounce, mass);
                for (int mode = 1; mode <= 3; mode++)
                    Assert.Equal(baseline, NativeCollisionMode.HasStaticRiderResponse(mode, bounce, mass));
            }
    }

    [Fact]
    public void ANegativeMassStillCountsAsMass()
    {
        // The rule tests against exact zero, not sign — a negative authored mass is not pass-through.
        Assert.True(NativeCollisionMode.HasStaticRiderResponse(1, playerBounce: true, responseMass: -5f));
    }
}
