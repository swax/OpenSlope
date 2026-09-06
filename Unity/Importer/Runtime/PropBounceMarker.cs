// Neutral hand-off for a solid prop-collision bounce bucket (docs/009): a merged MeshCollider whose surface can bounce
// the walking player. The importer (CollisionBuilder) builds the collider and tags it; the platform wiring pass
// realizes the runtime bounce behaviour. Field names mirror the behaviour's.

namespace OpenSlope.Importer
{
    public sealed class PropBounceMarker : Marker
    {
        public bool PlayerBounce;         // whether this surface bounces the walking player
        public float PlayerBounceAmmount; // bounce strength (spelling matches the behaviour field)
        public int SurfaceType = -1;      // ride feel/audio material; -1 = object fallback
        public int InstanceCount;         // how many prop instances share this bucket
        // Which native CollsionMode produced this collider (NativeCollision.*). The rider meets the three modes
        // with DIFFERENT shapes [Trailmap: 370-probe-modes]: a proxy mesh and a physics body are met by the
        // limb spheres, which the board's ~0.3 m capsule stands in for, while a mode-2 bounding box is met by
        // one 0.85 m ball at the pelvis. Defaults to TriangleProxy so a scene imported before this field
        // existed keeps the capsule for everything, exactly as it did.
        public int NativeMode = 1;
    }
}
