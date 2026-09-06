using System.Numerics;
using Snowknife.Bundle;

namespace Snowknife.Tests.Bundle;

/// <summary>
/// The curve evaluator shared by the terrain tessellator and the grind-rail splines. The importer's rail
/// network re-evaluates these exact cubics at runtime, so what matters is that the maths is the textbook
/// Bernstein basis rather than anything that happens to look right at the midpoint.
/// </summary>
public class BezierTests
{
    static readonly Vector3 P0 = new(0f, 0f, 0f);
    static readonly Vector3 P1 = new(1f, 2f, 0f);
    static readonly Vector3 P2 = new(3f, 2f, 1f);
    static readonly Vector3 P3 = new(4f, 0f, 1f);

    /// <summary>A patch whose 16 control points lie on a plane tilted in both u and v.</summary>
    static Vector3[] TiltedPatch()
    {
        var control = new Vector3[16];
        for (int row = 0; row < 4; row++)
            for (int column = 0; column < 4; column++)
                control[row * 4 + column] = new Vector3(row, column, row * 0.5f + column * 0.25f);
        return control;
    }

    static void Near(Vector3 expected, Vector3 actual, float tolerance = 1e-5f) =>
        Assert.True(Vector3.Distance(expected, actual) <= tolerance, $"expected {expected}, got {actual}");

    [Fact]
    public void TheCurveStartsAtTheFirstControlPointAndEndsAtTheLast()
    {
        Near(P0, Bezier.Point(P0, P1, P2, P3, 0f));
        Near(P3, Bezier.Point(P0, P1, P2, P3, 1f));
    }

    [Fact]
    public void TheEndpointTangentsPointAlongTheControlLegs()
    {
        // P'(0) = 3(P1-P0) and P'(1) = 3(P3-P2). The rail network reads these to orient a grind.
        Near(3f * (P1 - P0), Bezier.Deriv(P0, P1, P2, P3, 0f));
        Near(3f * (P3 - P2), Bezier.Deriv(P0, P1, P2, P3, 1f));
    }

    [Fact]
    public void TheDerivativeMatchesAFiniteDifferenceOfThePoint()
    {
        const float h = 1e-3f;
        foreach (float t in new[] { 0.15f, 0.4f, 0.63f, 0.9f })
        {
            Vector3 numeric = (Bezier.Point(P0, P1, P2, P3, t + h) - Bezier.Point(P0, P1, P2, P3, t - h)) / (2f * h);
            Near(numeric, Bezier.Deriv(P0, P1, P2, P3, t), 1e-2f);
        }
    }

    [Fact]
    public void AConstantCurveStaysPut()
    {
        var p = new Vector3(5f, -2f, 7f);

        foreach (float t in new[] { 0f, 0.3f, 0.5f, 1f })
        {
            Near(p, Bezier.Point(p, p, p, p, t));
            Near(Vector3.Zero, Bezier.Deriv(p, p, p, p, t));
        }
    }

    [Fact]
    public void EvenlySpacedControlPointsGiveAStraightLine()
    {
        // A cubic whose control points are collinear and evenly spaced reduces to linear interpolation.
        var a = new Vector3(0f, 0f, 0f);
        var d = new Vector3(3f, 6f, 9f);
        Vector3 b = a + (d - a) / 3f, c = a + 2f * (d - a) / 3f;

        foreach (float t in new[] { 0.2f, 0.5f, 0.75f })
            Near(Vector3.Lerp(a, d, t), Bezier.Point(a, b, c, d, t));
    }

    [Fact]
    public void PatchCornersLandOnTheCornerControlPoints()
    {
        var control = TiltedPatch();

        Near(control[0], Bezier.Patch(control, 0f, 0f));
        Near(control[3], Bezier.Patch(control, 0f, 1f));
        Near(control[12], Bezier.Patch(control, 1f, 0f));
        Near(control[15], Bezier.Patch(control, 1f, 1f));
    }

    [Fact]
    public void PatchTangentsCrossToTheSurfaceNormal()
    {
        // The tessellator takes du x dv as the analytic normal. On this tilted plane the normal is constant,
        // so any (u,v) has to produce the same direction.
        var control = TiltedPatch();
        Vector3? first = null;

        foreach (var (u, v) in new[] { (0.1f, 0.2f), (0.5f, 0.5f), (0.9f, 0.3f) })
        {
            Bezier.PatchTangents(control, u, v, out Vector3 du, out Vector3 dv);
            Vector3 normal = Vector3.Normalize(Vector3.Cross(du, dv));
            first ??= normal;
            Near(first.Value, normal, 1e-4f);
        }
    }

    [Fact]
    public void PatchTangentsMatchAFiniteDifferenceOfThePatch()
    {
        var control = TiltedPatch();
        const float h = 1e-3f;
        const float u = 0.35f, v = 0.62f;

        Bezier.PatchTangents(control, u, v, out Vector3 du, out Vector3 dv);

        Near((Bezier.Patch(control, u + h, v) - Bezier.Patch(control, u - h, v)) / (2f * h), du, 1e-2f);
        Near((Bezier.Patch(control, u, v + h) - Bezier.Patch(control, u, v - h)) / (2f * h), dv, 1e-2f);
    }

    [Fact]
    public void APlanarPatchStaysOnItsPlane()
    {
        var control = TiltedPatch();

        // z = 0.5*x + 0.25*y everywhere on this patch, by construction.
        foreach (var (u, v) in new[] { (0.25f, 0.75f), (0.5f, 0.1f), (0.8f, 0.8f) })
        {
            Vector3 point = Bezier.Patch(control, u, v);
            Assert.True(MathF.Abs(point.Z - (0.5f * point.X + 0.25f * point.Y)) < 1e-4f,
                $"({u},{v}) left the plane at {point}");
        }
    }
}
