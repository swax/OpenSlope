using System.Numerics;

namespace Snowknife.Bundle;

/// <summary>
/// Cubic-Bezier evaluation shared by the bundle's curve work - the terrain's bicubic patches
/// (<see cref="TerrainBundle"/>) and the grind-rail splines (<see cref="PathBundle"/>). One source of
/// truth so the sampled geometry stays consistent with anything that re-evaluates the same curve at
/// runtime (the importer's RailNetwork rides these exact rail cubics; see Unity docs/026). Bernstein basis;
/// the operation order matches the terrain tessellator's, so both evaluate a curve bit-identically.
/// </summary>
public static class Bezier
{
    /// <summary>Cubic point P(t).</summary>
    public static Vector3 Point(Vector3 p0, Vector3 p1, Vector3 p2, Vector3 p3, float t)
    {
        float s = 1f - t;
        return s * s * s * p0 + 3f * s * s * t * p1 + 3f * s * t * t * p2 + t * t * t * p3;
    }

    /// <summary>Cubic derivative P'(t) - the unnormalized tangent.</summary>
    public static Vector3 Deriv(Vector3 p0, Vector3 p1, Vector3 p2, Vector3 p3, float t)
    {
        float s = 1f - t;
        return 3f * s * s * (p1 - p0) + 6f * s * t * (p2 - p1) + 3f * t * t * (p3 - p2);
    }

    /// <summary>Bicubic patch surface point at (u,v) from 16 row-major control points.</summary>
    public static Vector3 Patch(Vector3[] cp, float u, float v)
    {
        Vector3 r0 = Point(cp[0], cp[1], cp[2], cp[3], v);
        Vector3 r1 = Point(cp[4], cp[5], cp[6], cp[7], v);
        Vector3 r2 = Point(cp[8], cp[9], cp[10], cp[11], v);
        Vector3 r3 = Point(cp[12], cp[13], cp[14], cp[15], v);
        return Point(r0, r1, r2, r3, u);
    }

    /// <summary>Bicubic patch surface tangents at (u,v) - du/dv, the cross of which is the analytic normal.</summary>
    public static void PatchTangents(Vector3[] cp, float u, float v, out Vector3 du, out Vector3 dv)
    {
        Vector3 r0 = Point(cp[0], cp[1], cp[2], cp[3], v);
        Vector3 r1 = Point(cp[4], cp[5], cp[6], cp[7], v);
        Vector3 r2 = Point(cp[8], cp[9], cp[10], cp[11], v);
        Vector3 r3 = Point(cp[12], cp[13], cp[14], cp[15], v);
        du = Deriv(r0, r1, r2, r3, u);
        Vector3 d0 = Deriv(cp[0], cp[1], cp[2], cp[3], v);
        Vector3 d1 = Deriv(cp[4], cp[5], cp[6], cp[7], v);
        Vector3 d2 = Deriv(cp[8], cp[9], cp[10], cp[11], v);
        Vector3 d3 = Deriv(cp[12], cp[13], cp[14], cp[15], v);
        dv = Point(d0, d1, d2, d3, u);
    }
}
