using System.Numerics;
using Snowknife.Bundle;

namespace Snowknife.Tests.Bundle;

/// <summary>
/// Mode-2 collision boxes are ORIENTED — the model's own box turned with the placement, not the axis-aligned
/// envelope of the turned result (spec 130-mode2-oriented, read live off a paused PCSX2 session: the box lives
/// on the MODEL record and two instances of one model share it while carrying different rotations).
///
/// Emitting the envelope instead inflates 62% of the shipped mode-2 colliders — median 1.6x the volume, and
/// hundreds of times over for the thin turned things (rail supports, jumbotron screens, banners) whose box is
/// fat exactly where the art has no thickness. These cover the conversion that keeps that from happening.
/// </summary>
public class OrientedBoundsBoxTests
{
    static float[] YawQuat(float radians) =>
        new[] { 0f, MathF.Sin(radians / 2f), 0f, MathF.Cos(radians / 2f) };

    static SsxInstance Placed(float[] location, float[] rotation) =>
        new() { InstanceName = "Mdl_Test", Location = location, Rotation = rotation };

    [Fact]
    public void APlacedVertexComesBackToItsOwnModelSpace()
    {
        // A point one metre down the model's +X, on an instance yawed 90 degrees and moved off the origin.
        var placement = CollisionBundle.Placement.Of(Placed(new[] { 500f, 20f, -300f }, YawQuat(MathF.PI / 2)));
        var placedPoint = Vector3.Transform(new Vector3(100f, 0f, 0f), placement.Rotation) + placement.Origin;

        var local = placement.ToLocal(placedPoint);

        Assert.Equal(100f, local.X, 3);
        Assert.Equal(0f, local.Y, 3);
        Assert.Equal(0f, local.Z, 3);
    }

    [Fact]
    public void AThinTurnedPanelKeepsItsOwnExtentsInsteadOfItsEnvelope()
    {
        // The shape that makes this matter: a wide, zero-thickness panel turned 45 degrees. Its own box is
        // thin; the envelope of the turned result is a fat diamond-shaped slab.
        var placement = CollisionBundle.Placement.Of(Placed(new[] { 0f, 0f, 0f }, YawQuat(MathF.PI / 4)));
        var corners = new[]
        {
            new Vector3(-700f, 0f, -50f), new Vector3(700f, 0f, -50f),
            new Vector3(-700f, 0f, 50f), new Vector3(700f, 0f, 50f),
        };

        var min = new Vector3(float.MaxValue);
        var max = new Vector3(float.MinValue);
        var envelopeMin = new Vector3(float.MaxValue);
        var envelopeMax = new Vector3(float.MinValue);
        foreach (var corner in corners)
        {
            var placed = Vector3.Transform(corner, placement.Rotation) + placement.Origin;
            envelopeMin = Vector3.Min(envelopeMin, placed);
            envelopeMax = Vector3.Max(envelopeMax, placed);
            var local = placement.ToLocal(placed);
            min = Vector3.Min(min, local);
            max = Vector3.Max(max, local);
        }

        // Recovered exactly: 14 m wide, 1 m deep.
        Assert.Equal(1400f, max.X - min.X, 2);
        Assert.Equal(100f, max.Z - min.Z, 2);
        // ...where the envelope is over ten metres in BOTH horizontal axes, most of it empty air.
        Assert.True(envelopeMax.X - envelopeMin.X > 1000f);
        Assert.True(envelopeMax.Z - envelopeMin.Z > 1000f);
    }

    [Fact]
    public void TheEmittedRotationIsMirroredIntoMeshSpaceLikeTheBodyRecords()
    {
        // Mesh space negates X, so the quaternion is conjugated by that mirror: (x,y,z,w) -> (x,-y,-z,w).
        // Getting this wrong turns every box the wrong way, which is worse than not turning it at all.
        var placement = CollisionBundle.Placement.Of(Placed(new[] { 0f, 0f, 0f }, new[] { 0.1f, 0.2f, 0.3f, 0.927f }));

        var mesh = placement.MeshRotation();

        Assert.Equal(0.1f, mesh[0], 4);
        Assert.Equal(-0.2f, mesh[1], 4);
        Assert.Equal(-0.3f, mesh[2], 4);
        Assert.Equal(0.927f, mesh[3], 4);
    }

    [Fact]
    public void AnUnplacedInstanceIsTheIdentity()
    {
        // Missing/short arrays are the older-extraction case and must not throw or invent a rotation: an
        // identity placement reproduces the axis-aligned behaviour these records had before.
        var placement = CollisionBundle.Placement.Of(new SsxInstance());

        Assert.Equal(Vector3.Zero, placement.Origin);
        Assert.Equal(new Vector3(25f, -5f, 7f), placement.ToLocal(new Vector3(25f, -5f, 7f)));
        Assert.Equal(new[] { 0f, 0f, 0f, 1f }, placement.MeshRotation());
    }
}
