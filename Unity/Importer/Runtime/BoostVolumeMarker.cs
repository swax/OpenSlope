using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for an SSX MainType-0 BOOST VOLUME (docs/053): a trigger box that drives the rider's velocity
    // while they are inside it. The importer (VolumeBuilder) builds the trigger collider and tags it; the platform
    // wiring pass realizes the runtime behaviour (BoostVolume / BasisBoostVolume). Field names mirror both.
    //
    // One marker carries all four sub-types of the family, because the engine treats them as one mechanism with
    // different trimmings ([Trailmap: 360-node-fields]). `Kind` says which fields past the shared triple matter.
    public sealed class BoostVolumeMarker : Marker
    {
        public int Kind;              // 0 = directional, 1 = vertical lift, 2 = lap-gated, 3 = tube-end

        // The shared triple every sub-type carries.
        public Vector3 LocalDir;      // push axis in the trigger's local space (the behaviour transforms it to world)
        public float Target;          // speed (m/s) along that axis the rider is driven toward
        public float Rate;            // approach rate: the lag's 1/time-constant

        // World metres the trigger collider is grown by on every face beyond the AUTHORED box. The collider is only a
        // broadphase - it has to fire its callback before the rider reaches the real boundary - so the behaviour shrinks
        // the collider's bounds by this to recover the authored box, and pushes only inside THAT.
        public float BroadphaseMargin;

        // Kind 1, the vertical lift. The altitude is carried as a RISE ABOVE THE VOLUME'S OWN CENTRE, not as an
        // absolute world Y: the importer recenters the Level after the volumes are built (LevelImporter), which
        // moves every volume but would leave a baked absolute behind, aiming the finish tube's elevator at an altitude
        // the shaft no longer reaches. A rise is measured between two points in the same frame, so it survives that.
        // The sub-7/24 lifetime rule ([Trailmap: 360-node-mode]). Every retail placement is Mode 1, so these
        // carry AUTHORED content: a mode that makes a node inert on PS2 must not push in the world either.
        public int Mode = 1;
        public float Seconds;         // mode 0: seconds of cooldown during which the push is suppressed

        public float TargetAltitudeRise;
        public float SnapTolerance;   // gap (m) under which the rider is placed there outright; 0 never snaps

        // Kind 2, the lap-gated lift.
        public Vector3 LocalStageAxis;   // the host's own X axis, trigger-local; picks stage 1 vs 2 by side of centre
        public float StageFloorOffset;   // height (m) above the volume's floor needed for any stage above 0

        // Kind 3, the tube-end launch.
        public Vector3 Stage0Dir, Stage1Dir, Stage2Dir;
        public float Stage0Speed, Stage1Speed, Stage2Speed;
    }
}
