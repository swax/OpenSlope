using System.Numerics;
using Snowknife.Bundle;

namespace Snowknife.Tests.Bundle;

/// <summary>
/// The measured PS2 placed-object lighting equation, shared by the static, diverted and animated bundle
/// paths so none of them can quietly grow a different lighting law. The Unity shader evaluates the same
/// equation per pixel from the keys baked here, so a change on this side is a change to how every prop in
/// the world is lit.
/// </summary>
public class PropLightingTests
{
    static void Near(float expected, float actual, float tolerance = 1e-5f) =>
        Assert.True(MathF.Abs(expected - actual) <= tolerance, $"expected {expected}, got {actual}");

    static void Near(Vector3 expected, Vector3 actual, float tolerance = 1e-5f) =>
        Assert.True(Vector3.Distance(expected, actual) <= tolerance, $"expected {expected}, got {actual}");

    static SsxInstance Identity() => new()
    {
        Rotation = [0f, 0f, 0f, 1f],
        AmbentLightColour = [64f, 64f, 64f],
        LightColour1 = [128f, 64f, 32f],
        LightVector1 = [1f, 0f, 0f],
    };

    [Fact]
    public void RecordValuesAreNormalizedBy256NotBy255()
    {
        // 256 is texture-true. The /255 normalization is only detectably wrong at this boundary, which is
        // exactly why it needs a test rather than an eyeball.
        Assert.Equal(256f, PropLighting.RecordScale);
        Near(1f, PropLighting.ScreenFactor(256f, 0f, 0f));
        Near(0.5f, PropLighting.ScreenFactor(128f, 0f, 0f));
    }

    [Fact]
    public void ScreenFactorAddsAmbientToTheFacingKey()
    {
        Near(0.75f, PropLighting.ScreenFactor(64f, 128f, 1f));
        Near(0.25f, PropLighting.ScreenFactor(64f, 128f, -1f));   // a back face gets ambient only
        Near(0.5f, PropLighting.ScreenFactor(64f, 128f, 0.5f));
    }

    [Fact]
    public void ScreenFactorSaturatesRatherThanOverflowing()
    {
        Near(1f, PropLighting.ScreenFactor(256f, 256f, 1f));
        Near(0f, PropLighting.ScreenFactor(-50f, 0f, 0f));
    }

    [Fact]
    public void AModelLocalLightIsMirroredIntoMeshSpace()
    {
        // PropsBundle mirrors X, so a model-local +X light faces mesh-space -X after identity placement.
        Near(-Vector3.UnitX, PropLighting.LocalRawToMeshWorld(Identity(), Vector3.UnitX));
    }

    [Fact]
    public void AnInstanceRotationCarriesItsLightsWithIt()
    {
        float s = MathF.Sqrt(0.5f);
        var yaw90 = new SsxInstance { Rotation = [0f, 0f, s, s] };

        Near(Vector3.UnitY, PropLighting.LocalRawToMeshWorld(yaw90, Vector3.UnitX));
    }

    [Fact]
    public void AZeroQuaternionBehavesAsIdentityRatherThanProducingNaNs()
    {
        // Some incomplete or hand-authored records carry an all-zero rotation.
        var zero = new SsxInstance { Rotation = [0f, 0f, 0f, 0f] };

        Vector3 direction = PropLighting.LocalRawToMeshWorld(zero, Vector3.UnitX);

        Near(-Vector3.UnitX, direction);
        Assert.False(float.IsNaN(direction.X) || float.IsNaN(direction.Y) || float.IsNaN(direction.Z));
    }

    [Fact]
    public void AnUnnormalizedRotationIsNormalizedBeforeUse()
    {
        var scaled = new SsxInstance { Rotation = [0f, 0f, 0f, 5f] };

        Near(-Vector3.UnitX, PropLighting.LocalRawToMeshWorld(scaled, Vector3.UnitX));
    }

    [Fact]
    public void AZeroLengthDirectionIsNotADirection()
    {
        Near(Vector3.Zero, PropLighting.LocalRawToMeshWorld(Identity(), Vector3.Zero));
    }

    [Fact]
    public void AMissingInstanceLightsNothing()
    {
        Near(Vector3.Zero, PropLighting.Ambient(null));
        Assert.Equal(new Vector4(0f, 0f, 0f, 1f), PropLighting.Evaluate(null, Vector3.UnitZ, Vector3.UnitZ));
    }

    [Fact]
    public void AFacingSurfaceGetsAmbientPlusTheFullKey()
    {
        Vector4 lit = PropLighting.Evaluate(Identity(), -Vector3.UnitX, Vector3.UnitZ);

        Near(0.75f, lit.X);    // 64/256 ambient + 128/256 key
        Near(0.5f, lit.Y);     // 64/256 ambient + 64/256 key
        Near(0.375f, lit.Z);   // 64/256 ambient + 32/256 key
        Near(1f, lit.W);
    }

    [Fact]
    public void ASurfaceFacingAwayGetsAmbientOnly()
    {
        Vector4 lit = PropLighting.Evaluate(Identity(), Vector3.UnitX, Vector3.UnitZ);

        Near(0.25f, lit.X);
        Near(0.25f, lit.Y);
        Near(0.25f, lit.Z);
    }

    [Fact]
    public void EveryKeySlotIsRead()
    {
        var threeKeys = new SsxInstance
        {
            Rotation = [0f, 0f, 0f, 1f],
            AmbentLightColour = [0f, 0f, 0f],
            LightColour1 = [64f, 0f, 0f],
            LightVector1 = [1f, 0f, 0f],
            LightColour2 = [0f, 64f, 0f],
            LightVector2 = [1f, 0f, 0f],
            LightColour3 = [0f, 0f, 64f],
            LightVector3 = [1f, 0f, 0f],
        };

        Vector4 lit = PropLighting.Evaluate(threeKeys, -Vector3.UnitX, Vector3.UnitZ);

        Near(0.25f, lit.X);
        Near(0.25f, lit.Y);
        Near(0.25f, lit.Z);
    }

    [Fact]
    public void AKeyWithNoColourContributesNothingEvenFacingOn()
    {
        var dark = new SsxInstance
        {
            Rotation = [0f, 0f, 0f, 1f],
            AmbentLightColour = [32f, 32f, 32f],
            LightColour1 = [0f, 0f, 0f],
            LightVector1 = [1f, 0f, 0f],
        };

        Vector4 lit = PropLighting.Evaluate(dark, -Vector3.UnitX, Vector3.UnitZ);

        Near(0.125f, lit.X);
    }

    [Fact]
    public void AKeyWithNoDirectionFallsBackToTheSuppliedOne()
    {
        var noDirection = new SsxInstance
        {
            Rotation = [0f, 0f, 0f, 1f],
            AmbentLightColour = [0f, 0f, 0f],
            LightColour1 = [128f, 128f, 128f],
            LightVector1 = [0f, 0f, 0f],
        };

        var key = PropLighting.GetKey(noDirection, 0, Vector3.UnitY);

        Near(Vector3.UnitY, key.MeshDirection);
    }

    [Fact]
    public void LightingSaturatesRatherThanBlowingPastWhite()
    {
        var blazing = new SsxInstance
        {
            Rotation = [0f, 0f, 0f, 1f],
            AmbentLightColour = [256f, 256f, 256f],
            LightColour1 = [256f, 256f, 256f],
            LightVector1 = [1f, 0f, 0f],
        };

        Vector4 lit = PropLighting.Evaluate(blazing, -Vector3.UnitX, Vector3.UnitZ);

        Assert.Equal(new Vector4(1f, 1f, 1f, 1f), lit);
    }

    [Fact]
    public void FlatColourIsAmbientPlusHalfOfEveryKey()
    {
        // The explicitly non-directional consumers get this instead of a normal-dependent value.
        Vector4 flat = PropLighting.Flat(Identity());

        Near(0.25f + 0.25f, flat.X);      // 64/256 + 0.5 * 128/256
        Near(0.25f + 0.125f, flat.Y);
        Near(0.25f + 0.0625f, flat.Z);
    }

    [Fact]
    public void KeyColourReadsTheSlotItIsAskedFor()
    {
        var instance = new SsxInstance
        {
            LightColour1 = [256f, 0f, 0f],
            LightColour2 = [0f, 256f, 0f],
            LightColour3 = [0f, 0f, 256f],
        };

        Near(Vector3.UnitX, PropLighting.KeyColour(instance, 0));
        Near(Vector3.UnitY, PropLighting.KeyColour(instance, 1));
        Near(Vector3.UnitZ, PropLighting.KeyColour(instance, 2));
        Near(Vector3.Zero, PropLighting.KeyColour(instance, 3));   // there is no fourth key
    }
}
