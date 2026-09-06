using System.Numerics;
using Snowknife.Bundle;

namespace Snowknife.Tests.Bundle;

/// <summary>
/// A reset zone is a PANEL the rider crosses, not a cube of space — 432 of the 433 shipped ones are flat to
/// within 10 cm. Baking its world AABB instead makes the trigger 77x the volume it should be, and the extra
/// volume is beside the panel, where it resets a rider who was never going to cross it.
///
/// The property that matters is containment: whatever frame the fit picks, every source vertex has to end up
/// inside the emitted slab, or the trigger would have holes a rider could pass through.
/// </summary>
public class ResetZoneSlabTests
{
    const float MinThickness = 200f;

    /// <summary>Is `p` inside the box described by the emitted centre/rotation/size?</summary>
    static bool Contains((Vector3 Center, float[] Rotation, Vector3 Size) slab, Vector3 p, float slack = 0.01f)
    {
        var q = new Quaternion(slab.Rotation[0], slab.Rotation[1], slab.Rotation[2], slab.Rotation[3]);
        var local = Vector3.Transform(p - slab.Center, Quaternion.Inverse(q));
        return MathF.Abs(local.X) <= slab.Size.X / 2 + slack
            && MathF.Abs(local.Y) <= slab.Size.Y / 2 + slack
            && MathF.Abs(local.Z) <= slab.Size.Z / 2 + slack;
    }

    static Vector3[] TiltedQuad(float yaw, float pitch, Vector3 at)
    {
        var r = Quaternion.CreateFromYawPitchRoll(yaw, pitch, 0f);
        return new[]
        {
            at + Vector3.Transform(new Vector3(-900, -650, 0), r),
            at + Vector3.Transform(new Vector3(900, -650, 0), r),
            at + Vector3.Transform(new Vector3(900, 650, 0), r),
            at + Vector3.Transform(new Vector3(-900, 650, 0), r),
        };
    }

    [Fact]
    public void EveryVertexOfATurnedPanelLandsInsideTheSlab()
    {
        foreach (var (yaw, pitch) in new[] { (0f, 0f), (0.6f, 0f), (0f, 0.5f), (0.9f, -0.4f), (2.4f, 1.1f) })
        {
            var quad = TiltedQuad(yaw, pitch, new Vector3(1200, -300, 4500));
            var slab = ParticleBundle.FitPanelSlab(quad, MinThickness);
            foreach (var p in quad)
                Assert.True(Contains(slab, p), $"vertex escaped the slab at yaw {yaw} pitch {pitch}");
        }
    }

    [Fact]
    public void TheSlabIsThinAcrossThePanelAndFullSizeAlongIt()
    {
        var slab = ParticleBundle.FitPanelSlab(TiltedQuad(0.7f, 0.3f, Vector3.Zero), MinThickness);
        var sorted = new[] { slab.Size.X, slab.Size.Y, slab.Size.Z };
        Array.Sort(sorted);

        // 1.8 m x 1.3 m panel: the two in-plane axes survive, the third collapses to the minimum thickness.
        Assert.Equal(MinThickness, sorted[0], 1);
        Assert.Equal(1300f, sorted[1], 1);
        Assert.Equal(1800f, sorted[2], 1);
    }

    [Fact]
    public void ATurnedPanelSlabIsFarSmallerThanItsWorldAabb()
    {
        // The whole point. At 45 degrees the AABB of a flat panel is a fat diamond envelope; the fitted slab
        // is the panel plus the crossing margin.
        var quad = TiltedQuad(MathF.PI / 4, 0.3f, Vector3.Zero);
        var slab = ParticleBundle.FitPanelSlab(quad, MinThickness);

        Vector3 mn = quad[0], mx = quad[0];
        foreach (var p in quad) { mn = Vector3.Min(mn, p); mx = Vector3.Max(mx, p); }
        var aabb = Vector3.Max(mx - mn, new Vector3(MinThickness));

        float fitted = slab.Size.X * slab.Size.Y * slab.Size.Z;
        float envelope = aabb.X * aabb.Y * aabb.Z;
        Assert.True(envelope > fitted * 3, $"expected the AABB to dwarf the slab, got {envelope / fitted:F1}x");
    }

    [Fact]
    public void ADegenerateGroupFallsBackToBoundsInsteadOfThrowing()
    {
        // Collinear or duplicated points have no plane to fit. The old AABB is the right answer there, and it
        // must come back with an identity rotation rather than a NaN frame.
        var line = new[] { new Vector3(0, 0, 0), new Vector3(100, 0, 0), new Vector3(200, 0, 0) };
        var slab = ParticleBundle.FitPanelSlab(line, MinThickness);

        Assert.Equal(new[] { 0f, 0f, 0f, 1f }, slab.Rotation);
        Assert.True(slab.Size.Y >= MinThickness && slab.Size.Z >= MinThickness);
        foreach (var p in line) Assert.True(Contains(slab, p));
    }

    [Fact]
    public void ANonPlanarGroupNeverFitsBIGGERThanItsOwnAabb()
    {
        // MERQUER's Mdl_ParlamentBuilding_59: 10 vertices spanning 41 m across the "plane", so the largest-area
        // triangle names an arbitrary frame and the oriented box in it came out at exactly 2.00x the plain AABB —
        // the opposite of the point. Whatever frame the fit lands on, it may not inflate the trigger.
        var rnd = new[]
        {
            new Vector3(-2000, -3050, -1300), new Vector3(2000, -3050, 1300),
            new Vector3(1400, 3050, -900), new Vector3(-1400, 3050, 900),
            new Vector3(0, 0, 1300), new Vector3(600, -1200, -1300),
            new Vector3(-1800, 2400, 400), new Vector3(1900, 900, -1100),
            new Vector3(-700, -2600, 1200), new Vector3(300, 2900, -400),
        };
        var slab = ParticleBundle.FitPanelSlab(rnd, MinThickness);

        Vector3 mn = rnd[0], mx = rnd[0];
        foreach (var p in rnd) { mn = Vector3.Min(mn, p); mx = Vector3.Max(mx, p); }
        var aabb = Vector3.Max(mx - mn, new Vector3(MinThickness));

        float fitted = slab.Size.X * slab.Size.Y * slab.Size.Z;
        float envelope = aabb.X * aabb.Y * aabb.Z;
        Assert.True(fitted <= envelope, $"the fit inflated a non-planar group to {fitted / envelope:F2}x its AABB");
        foreach (var p in rnd) Assert.True(Contains(slab, p), "and it must still contain every source vertex");
    }

    [Fact]
    public void AnAlreadyBoxyZoneKeepsItsVolume()
    {
        // Not every zone is a panel — MERQUER's are box-shaped, and the fit must not shrink one into a slab
        // that a rider could stand inside without tripping.
        var box = new List<Vector3>();
        foreach (var x in new[] { -500f, 500f })
            foreach (var y in new[] { -400f, 400f })
                foreach (var z in new[] { -300f, 300f })
                    box.Add(new Vector3(x, y, z));

        var slab = ParticleBundle.FitPanelSlab(box, MinThickness);

        foreach (var p in box) Assert.True(Contains(slab, p), "a boxy zone must still contain all its corners");
        float volume = slab.Size.X * slab.Size.Y * slab.Size.Z;
        Assert.True(volume > 0.9f * (1000f * 800f * 600f), "a boxy zone must not be collapsed into a panel");
    }
}
