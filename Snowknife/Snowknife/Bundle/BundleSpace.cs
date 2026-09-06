using System.Numerics;

namespace Snowknife.Bundle;

/// <summary>
/// The bundle's coordinate convention in one place. Manifest points are emitted in SSX MESH space - the
/// engine's right-handed axes with X NEGATED (the handedness flip, Unity docs/unity/004) - so the Unity importer's
/// level root maps them into world exactly like the glb geometry. Centralising the two primitive ops
/// (emit a Vector3 as a JSON triple; read an SSX raw triple into a mesh-space Vector3) keeps the flip from
/// being re-derived (and copy-pasted as Pt/NegX/inline) per bundle section.
/// </summary>
public static class BundleSpace
{
    /// <summary>A mesh-space Vector3 as a JSON [x,y,z] triple.</summary>
    public static float[] Xyz(Vector3 v) => new[] { v.X, v.Y, v.Z };

    /// <summary>An SSX raw [x,y,z] (3+ floats) read into a mesh-space Vector3 (negate X). Null/short -> origin.</summary>
    public static Vector3 MeshPt(float[]? a) => (a == null || a.Length < 3) ? Vector3.Zero : new Vector3(-a[0], a[1], a[2]);
}
