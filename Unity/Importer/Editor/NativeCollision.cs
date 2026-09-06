#if UNITY_EDITOR
using UnityEngine;

namespace OpenSlope.Importer
{

    // Named form of ObjectProperties.CollsionMode [Trailmap: 130-collision-data]
    // (the misspelling is part of SSX's data contract).
    // Unity realizes native trigger shapes as BoxColliders after snowknife has flattened them into bundle
    // center/size records. The source mode stays explicit so mode 0 is never treated as contact-capable.
    public static class NativeCollision
    {
        public const int None = 0;
        public const int TriangleProxy = 1;
        public const int BoundingBox = 2;
        public const int PhysicsBodySpheres = 3;

        public static BoxCollider AddPassThroughBox(GameObject host, Vector3 center, Vector3 size, int sourceMode)
        {
            Debug.Assert(sourceMode != None, "A native mode-0 instance has no contact shape.");
            var box = host.AddComponent<BoxCollider>();
            box.center = center;
            box.size = size;
            box.isTrigger = true;
            return box;
        }
    }
}
#endif
