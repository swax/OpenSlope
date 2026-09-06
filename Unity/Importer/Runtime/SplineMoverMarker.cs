using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for an SSX spline-path mover (MainType-2/Sub1, docs/053): a kinematic prop (e.g. a subway car)
    // that rides a sampled path. The importer (SplineMoverBuilder) diverts the template mesh and tags it with the
    // path; the platform wiring pass realizes the runtime mover behaviour. Field names mirror the behaviour's.
    public sealed class SplineMoverMarker : Marker
    {
        public Vector3[] Path;    // the sampled path the prop walks, in the prop's local space
        public float Speed;       // signed travel speed (SSX AnimationSpeed x the configured scale)
        public Quaternion Baked;  // the authored rotation baked into the template's mesh; the mover UNDOES it (see the behaviour)
        public float YawOffset;   // radians: the authored yaw, which picks WHICH model axis leads down the track
        public int OrientMode;    // 0 = yaw+pitch, 1 = yaw/level, 2 = fixed yaw+pitch, 3 = fixed
        public int EndMode;       // 0 = finish, 1 = wrap, 2 = ping-pong, 3 = hold at the end
        public float StartDist;   // where along the path this copy starts (the engine spaces InstanceCount copies by arc length)
    }
}
