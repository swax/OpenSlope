using System.Numerics;
using Snowknife.Bundle;

namespace Snowknife.Tests.Bundle;

/// <summary>
/// The bundle's coordinate convention. Two tiny operations, but they are the handedness flip that lets the
/// Unity importer's level root map manifest points into world exactly like the glb geometry — so getting one
/// wrong mirrors a whole system (rails, puffs, probes) against the terrain it sits on.
/// </summary>
public class BundleSpaceTests
{
    [Fact]
    public void ReadingAnSsxTripleNegatesX()
    {
        Assert.Equal(new Vector3(-1f, 2f, 3f), BundleSpace.MeshPt([1f, 2f, 3f]));
    }

    [Fact]
    public void ExtraComponentsBeyondTheFirstThreeAreIgnored()
    {
        // Some raw records are 4-float rows; only xyz is a position.
        Assert.Equal(new Vector3(-1f, 2f, 3f), BundleSpace.MeshPt([1f, 2f, 3f, 99f]));
    }

    [Fact]
    public void AMissingOrShortTripleReadsAsTheOrigin()
    {
        Assert.Equal(Vector3.Zero, BundleSpace.MeshPt(null));
        Assert.Equal(Vector3.Zero, BundleSpace.MeshPt([]));
        Assert.Equal(Vector3.Zero, BundleSpace.MeshPt([1f, 2f]));
    }

    [Fact]
    public void EmittingAVectorKeepsComponentOrder()
    {
        Assert.Equal(new[] { 1f, 2f, 3f }, BundleSpace.Xyz(new Vector3(1f, 2f, 3f)));
    }

    [Fact]
    public void TheFlipIsItsOwnInverse()
    {
        // Reading a raw triple and emitting it again should differ only by the X negation, so applying the
        // pair twice returns the original.
        float[] raw = [4f, -5f, 6f];

        float[] once = BundleSpace.Xyz(BundleSpace.MeshPt(raw));
        float[] twice = BundleSpace.Xyz(BundleSpace.MeshPt(once));

        Assert.Equal(raw, twice);
        Assert.Equal(new[] { -4f, -5f, 6f }, once);
    }
}
