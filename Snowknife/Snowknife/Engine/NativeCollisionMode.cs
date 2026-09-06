namespace Snowknife.Engine;

/// <summary>
/// Native <c>ObjectProperties.CollsionMode</c> values [Trailmap: 130-collision-data]. The misspelled field name is part of the
/// extracted/repacked JSON contract; these names describe the collision shape selected by its value.
/// </summary>
internal static class NativeCollisionMode
{
    public const int None = 0;
    public const int TriangleProxy = 1;
    public const int BoundingBox = 2;
    public const int PhysicsBodySpheres = 3;

    /// <summary>
    /// Ordinary static rider response after a shape has reported contact. Exact-zero response mass is always
    /// pass-through. PlayerBounce-off also suppresses physical response after contact in every tested shape mode:
    /// the live mode-1 follow-up emitted its marker and passed through, matching the earlier mode-2 control.
    /// [Trailmap: 130-collision-data, 370-world-interaction]
    /// </summary>
    public static bool HasStaticRiderResponse(int mode, bool playerBounce, float responseMass) =>
        responseMass != 0f && playerBounce;
}
