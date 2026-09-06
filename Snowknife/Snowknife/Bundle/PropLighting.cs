using System.Numerics;

namespace Snowknife.Bundle;

/// <summary>
/// The measured PS2 placed-object lighting equation. Instance RGB values use 256 as texture-true and each
/// LightVector is model-local; for the already-placed Props.obj geometry we rotate it through the instance and
/// mirror X into bundle mesh space before taking N.L. Keeping this in one helper prevents the static, diverted,
/// and animated bundle paths from quietly growing different lighting laws.
/// </summary>
public static class PropLighting
{
    public const float RecordScale = 256f;

    public readonly record struct Key(Vector3 Colour, Vector3 MeshDirection);

    public static Vector3 Ambient(SsxInstance? instance) => V3(instance?.AmbentLightColour) / RecordScale;

    public static Key GetKey(SsxInstance? instance, int index, Vector3 fallbackMeshDirection)
    {
        float[]? colour = index switch
        {
            0 => instance?.LightColour1,
            1 => instance?.LightColour2,
            2 => instance?.LightColour3,
            _ => null,
        };
        float[]? direction = index switch
        {
            0 => instance?.LightVector1,
            1 => instance?.LightVector2,
            2 => instance?.LightVector3,
            _ => null,
        };

        Vector3 c = V3(colour) / RecordScale;
        Vector3 d = LocalRawToMeshWorld(instance, V3(direction));
        if (d.LengthSquared() <= 1e-12f) d = NormalizeOr(fallbackMeshDirection, Vector3.UnitZ);
        return new Key(c, d);
    }

    public static Vector4 Evaluate(SsxInstance? instance, Vector3 meshNormal, Vector3 fallbackMeshDirection)
    {
        Vector3 n = NormalizeOr(meshNormal, Vector3.UnitZ);
        Vector3 c = Ambient(instance);
        for (int i = 0; i < 3; i++)
        {
            Key key = GetKey(instance, i, fallbackMeshDirection);
            if (key.Colour.LengthSquared() <= 1e-12f) continue;
            c += key.Colour * MathF.Max(0f, Vector3.Dot(n, key.MeshDirection));
        }
        return new Vector4(Sat(c.X), Sat(c.Y), Sat(c.Z), 1f);
    }

    /// <summary>Flat colour for explicitly non-directional consumers: ambient plus half of every key.</summary>
    public static Vector4 Flat(SsxInstance? instance)
    {
        Vector3 c = Ambient(instance);
        for (int i = 0; i < 3; i++) c += 0.5f * KeyColour(instance, i);
        return new Vector4(Sat(c.X), Sat(c.Y), Sat(c.Z), 1f);
    }

    public static Vector3 KeyColour(SsxInstance? instance, int index)
    {
        float[]? colour = index switch
        {
            0 => instance?.LightColour1,
            1 => instance?.LightColour2,
            2 => instance?.LightColour3,
            _ => null,
        };
        return V3(colour) / RecordScale;
    }

    /// <summary>
    /// Convert an instance-model-local raw direction to placed bundle mesh space. Instance rotations are stored in
    /// the raw right-handed Z-up frame; PropsBundle mirrors X after PropsExporter has applied that placement.
    /// </summary>
    public static Vector3 LocalRawToMeshWorld(SsxInstance? instance, Vector3 localRaw)
    {
        if (localRaw.LengthSquared() <= 1e-12f) return Vector3.Zero;
        Quaternion q = Quaternion.Identity;
        if (instance?.Rotation is { Length: >= 4 } r)
        {
            var stored = new Quaternion(r[0], r[1], r[2], r[3]);
            if (stored.LengthSquared() > 1e-12f) q = Quaternion.Normalize(stored);
        }
        Vector3 rawWorld = Vector3.Transform(Vector3.Normalize(localRaw), q);
        return NormalizeOr(new Vector3(-rawWorld.X, rawWorld.Y, rawWorld.Z), Vector3.UnitZ);
    }

    public static float ScreenFactor(float ambientRecord, float keyRecord, float nDotL) =>
        Sat((MathF.Max(0f, ambientRecord) + MathF.Max(0f, nDotL) * MathF.Max(0f, keyRecord)) / RecordScale);

    static Vector3 V3(float[]? a) => a is { Length: >= 3 } ? new Vector3(a[0], a[1], a[2]) : Vector3.Zero;
    static Vector3 NormalizeOr(Vector3 v, Vector3 fallback) => v.LengthSquared() > 1e-12f ? Vector3.Normalize(v) : fallback;
    static float Sat(float v) => v < 0f ? 0f : v > 1f ? 1f : v;
}
