using UnityEngine;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    // The SSX MainType-0 BOOST FAMILY (docs/053): invisible AABB volumes that drive the rider's velocity while they are
    // INSIDE. Four sub-types ship, and the engine's class layout says they are one mechanism - sub-7 is the base class,
    // sub-24 derives from it, and sub-15/sub-18 lay out the same rate/target/axis triple at the same payload offsets.
    // So one behaviour carries all four ([Trailmap: 360-node, 360-zboost, 360-lapboost, 360-tubeend]):
    //
    //   Kind 0  DIRECTIONAL   the general velocity driver - conveyors, exhaust vents, sand boosts, wind.
    //   Kind 1  VERTICAL LIFT an elevator: cancels horizontal motion and aims at an ALTITUDE, not a speed.
    //   Kind 2  LAP-GATED     lifts like the elevator, and classifies the rider into a launch stage.
    //   Kind 3  TUBE-END      consumes that stage to launch the rider out of the top of the shaft.
    //
    // Distinct from the arrow PADS (docs/040, BoostPad), which only raise the top-speed cap and feed forward thrust
    // along your OWN travel. These drive a designer's vector, so they can shove a slow rider sideways or lift them
    // vertically out of a tube.
    //
    // DURATION IS CONTAINMENT, not a debounced contact event, which is why this uses OnTriggerStay rather than the
    // one-shot OnTriggerEnter the reset zones use. The volumes act every tick a rider is inside them: the lift cancels
    // horizontal motion PER TICK, and a lift that only fired on the cross would lurch instead of climb. The engine
    // tests the host's bounding box, confirmed live ([Trailmap: 360-tube-box]), so an AABB is the faithful shape.
    //
    // CONTAINMENT IS A POINT TEST ON THE BOARD, NOT COLLIDER OVERLAP. The engine selects riders with
    // WorldEntity_IntersectLineQuery over the tick's movement ([Trailmap: 360-node-apply, 130-modes]) - a LINE, which
    // has no thickness. Collider overlap would instead start the push as soon as the board's leading EDGE touched, i.e.
    // a board half-length early, and outside the shaft the finish tube's three volumes hand off inside. So the trigger
    // collider is only the broadphase (deliberately grown by BroadphaseMargin so its callback is already running), and
    // the real boundary is the swept board position against the AUTHORED box below.
    //
    // The sweep is why it is a segment rather than a point: at 30 m/s a rider covers half a metre per physics tick, so
    // a bare point test walks straight through a thin conveyor plate between two samples. A zero-length step degenerates
    // to exactly the point test.
    //
    // The push AXIS is authored in WORLD space - the engine never turns it by the host prop's transform. The importer
    // bakes it as this trigger's LOCAL direction purely so it rides the Level node's -90X/0.01 to world; the trigger
    // itself is unrotated, so TransformDirection reproduces exactly the engine's world vector and nothing else.
    // The lap boost's STAGE axis is the one deliberate exception: the engine really does run the host's instance
    // matrix over (1,0,0) there ([Trailmap: 360-lapboost-stage]), and the bake folds that rotation in.
    //
    // Local-only (sync None), board rider only. Realized from a BoostVolumeMarker; gate behind EmitBoostVolumes.
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class BoostVolume : UdonSharpBehaviour
    {
        [Tooltip("0 = directional, 1 = vertical lift, 2 = lap-gated, 3 = tube-end. Picks which fields below matter.")]
        public int Kind;

        [Tooltip("Push axis in this volume's LOCAL space (baked from the authored WORLD vector); TransformDirection'd.")]
        public Vector3 LocalDir = Vector3.forward;

        [Tooltip("Speed (m/s) along the push axis the rider is driven toward. The push only ever ADDS - it never brakes.")]
        public float Target = 20f;

        [Tooltip("How hard the volume grabs: speed approaches the target with time constant 1/rate. The real tuning knob.")]
        public float Rate = 3f;

        [Tooltip("World metres the trigger collider is grown by on each face beyond the authored box. Shrunk back off " +
                 "here so the broadphase margin never moves where the push starts.")]
        public float BroadphaseMargin;

        [Tooltip("The sub-7/24 lifetime rule: 0 = a cooldown that SUPPRESSES the push while it runs, 1 = an active " +
                 "window (all retail content), >=2 = inert. Only 'directional' and 'tube-end' read it.")]
        public int Mode = 1;

        [Tooltip("Seconds the Mode countdown runs. Meaningful only for Mode 0, where the push is suppressed for it.")]
        public float Seconds;

        [Header("Vertical lift (Kind 1)")]
        [Tooltip("How far ABOVE THIS VOLUME'S OWN CENTRE the lift carries riders, in metres. Resolved to a world " +
                 "altitude at Start from the collider's bounds, so it follows the Level wherever the importer's " +
                 "recenter puts it. A rider at or above that altitude is released rather than held.")]
        public float TargetAltitudeRise;

        [Tooltip("Once the remaining gap falls under this, the rider is placed at the target exactly. 0 never snaps.")]
        public float SnapTolerance;

        [Header("Lap-gated (Kind 2)")]
        [Tooltip("The host's own X axis, in this volume's LOCAL space. Which side of the box centre the rider is on " +
                 "along it decides stage 1 vs stage 2.")]
        public Vector3 LocalStageAxis = Vector3.right;

        [Tooltip("Height above the volume's own floor a rider must clear to get any stage above 0 (the engine's 10 m).")]
        public float StageFloorOffset = 10f;

        [Header("Tube-end (Kind 3)")]
        public Vector3 Stage0Dir = Vector3.forward;
        public Vector3 Stage1Dir = Vector3.forward;
        public Vector3 Stage2Dir = Vector3.forward;
        public float Stage0Speed = 27f;
        public float Stage1Speed = 35f;
        public float Stage2Speed = 35f;

        // Per-entry state. The engine latches on entry so the stage classification and the tube-end's direction capture
        // each happen exactly once; leaving clears the latch, because the engine builds a fresh node per contact
        // dispatch, which has the same effect ([Trailmap: 360-tube-latch]).
        private bool _latched;
        private bool _serviced;      // lap-gated: did the entry test decide to lift this rider at all?
        private bool _captured;
        private Vector3 _capturedDir;

        // VERTICAL LIFT ONLY: the node has RETIRED, so it will not lift again until the rider leaves and re-enters.
        // The lift's lifetime rule is presence rather than a window - its alive flag is set by a rider it lifted and by
        // nothing else, and an alive flag of zero self-ends the node on that tick ([Trailmap: 360-zboost]). So the first
        // tick everyone inside is at or above the target altitude is the tick the node ceases to exist.
        //
        // Without this the volume is a trampoline, and a bad one: the lift cancels horizontal motion every tick, so a
        // rider carried to the ceiling cannot travel out of the box - they fall back through the target, qualify again,
        // and are lifted again, indefinitely.
        private bool _retired;

        // Seconds this contact has lasted, for the Mode-0 cooldown to count against.
        private float _contactSeconds;

        // The volume never moves, so its world frame is resolved once here instead of on every physics tick - Udon
        // makes a TransformDirection in the hot path worth avoiding.
        private Vector3 _dirW = Vector3.forward;
        private Vector3 _stageAxisW = Vector3.right;
        private Vector3 _stage0W, _stage1W, _stage2W;
        private Vector3 _centre;
        private Vector3 _half;       // the AUTHORED half-extents: the collider's, less the broadphase margin
        private float _floorY;
        private float _targetY;      // TargetAltitudeRise resolved against this volume's own centre

        // The board position at the previous tick we saw, so containment can test the swept segment. Seeded on entry
        // (which happens OUTSIDE the authored box, thanks to the margin); until then the test degenerates to a point.
        private Vector3 _prevPos;
        private bool _havePrev;

        void Start()
        {
            _dirW = Norm(transform.TransformDirection(LocalDir), Vector3.forward);
            _stageAxisW = Norm(transform.TransformDirection(LocalStageAxis), Vector3.right);
            _stage0W = Norm(transform.TransformDirection(Stage0Dir), Vector3.forward);
            _stage1W = Norm(transform.TransformDirection(Stage1Dir), Vector3.forward);
            _stage2W = Norm(transform.TransformDirection(Stage2Dir), Vector3.forward);

            // The collider's WORLD bounds, not its local size: the volume hangs under the Level node's -90X, so the
            // box's local Y is not the vertical axis and reading size.y would measure the wrong side of the box. The
            // margin comes back off here, so _half/_floorY describe the AUTHORED box - which is what the stage gate
            // measures its 10 m from as well, not just what the push tests against.
            _centre = transform.position;
            _half = Vector3.zero;
            _floorY = _centre.y;
            BoxCollider box = (BoxCollider)GetComponent(typeof(BoxCollider));
            if (box != null)
            {
                Bounds b = box.bounds;
                _centre = b.center;
                _half = b.extents - Vector3.one * BroadphaseMargin;
                if (_half.x < 0f) _half.x = 0f;
                if (_half.y < 0f) _half.y = 0f;
                if (_half.z < 0f) _half.z = 0f;
                _floorY = _centre.y - _half.y;
            }
            _targetY = _centre.y + TargetAltitudeRise;
        }

        // Slab test of the segment from -> to against the authored box; true if any of it is inside. Written out per
        // axis rather than looped, which is the shape Udon is happiest with.
        private bool SweepHitsBox(Vector3 from, Vector3 to)
        {
            float enter = 0f;
            float exit = 1f;
            Vector3 lo = _centre - _half;
            Vector3 hi = _centre + _half;

            float a = from.x; float d = to.x - from.x;
            if (d > -1e-9f && d < 1e-9f) { if (a < lo.x || a > hi.x) return false; }
            else
            {
                float t0 = (lo.x - a) / d; float t1 = (hi.x - a) / d;
                float tmin = t0 < t1 ? t0 : t1; float tmax = t0 < t1 ? t1 : t0;
                if (tmin > enter) enter = tmin;
                if (tmax < exit) exit = tmax;
                if (enter > exit) return false;
            }

            a = from.y; d = to.y - from.y;
            if (d > -1e-9f && d < 1e-9f) { if (a < lo.y || a > hi.y) return false; }
            else
            {
                float t0 = (lo.y - a) / d; float t1 = (hi.y - a) / d;
                float tmin = t0 < t1 ? t0 : t1; float tmax = t0 < t1 ? t1 : t0;
                if (tmin > enter) enter = tmin;
                if (tmax < exit) exit = tmax;
                if (enter > exit) return false;
            }

            a = from.z; d = to.z - from.z;
            if (d > -1e-9f && d < 1e-9f) { if (a < lo.z || a > hi.z) return false; }
            else
            {
                float t0 = (lo.z - a) / d; float t1 = (hi.z - a) / d;
                float tmin = t0 < t1 ? t0 : t1; float tmax = t0 < t1 ? t1 : t0;
                if (tmin > enter) enter = tmin;
                if (tmax < exit) exit = tmax;
                if (enter > exit) return false;
            }
            return true;
        }

        private Vector3 Norm(Vector3 v, Vector3 fallback)
        {
            return v.sqrMagnitude > 1e-8f ? v.normalized : fallback;
        }

        // Entering the BROADPHASE only. Nothing is applied here - it seeds the sweep with a position that is still
        // outside the authored box, which is exactly what makes the first real crossing measurable.
        public void OnTriggerEnter(Collider other)
        {
            RideableBoard board = Board(other);
            if (board == null) return;
            _prevPos = board.transform.position;
            _havePrev = true;
            ClearLatches();
        }

        public void OnTriggerExit(Collider other)
        {
            RideableBoard board = Board(other);
            if (board == null) return;
            _havePrev = false;
            ClearLatches();
        }

        // Leaving clears the latch, because the engine builds a fresh node per contact dispatch, which has the same
        // effect ([Trailmap: 360-tube-latch]). A rider inside the broadphase but outside the authored box counts as
        // out, so a near miss can't leave a stale stage behind.
        private void ClearLatches()
        {
            _latched = false;
            _serviced = false;
            _captured = false;
            _retired = false;
            _contactSeconds = 0f;
        }

        public void OnTriggerStay(Collider other)
        {
            RideableBoard board = Board(other);
            if (board == null) return;

            // Physics-rate, because that is the rate this callback runs at. The push is a first-order lag, so it
            // converges on the same curve whatever the step size.
            float dt = Time.fixedDeltaTime;
            Vector3 pos = board.transform.position;

            // The real boundary. Everything above this line is broadphase.
            bool inside = SweepHitsBox(_havePrev ? _prevPos : pos, pos);
            _prevPos = pos;
            _havePrev = true;
            if (!inside) { ClearLatches(); return; }

            if (_retired) return;                                // the lift carried this rider already; the node is gone

            // Counted BEFORE the apply reads it would make a zero-length cooldown swallow its own first tick; after,
            // and Seconds = 0 means "already run", which is what every retail placement authors.
            bool suppressed = Suppressed();
            _contactSeconds += dt;

            if (Kind == 1) { VerticalLift(board, pos, dt); return; }   // presence is its rule; it reads no mode
            if (Kind == 2) { LapGated(board, pos, dt); return; }
            if (suppressed) return;
            if (Kind == 3) { TubeEnd(board, dt); return; }

            board.ApplyBoostPush(_dirW, Target, Rate, dt);
        }

        // Is the push suppressed this tick by the node's own lifetime rule ([Trailmap: 360-node-mode])?
        //
        // Mode 1 is the whole retail corpus and needs nothing: its window governs when the NODE retires, not when it
        // pushes, and containment already reproduces "alive exactly as long as contact". The other two are what an
        // author can reach and the engine treats very differently.
        //
        // WHERE THE COOLDOWN STARTS is the one thing containment has to choose. The engine seeds the countdown when the
        // node is CONSTRUCTED, and construction is a collision dispatch - an event a permanent volume does not have.
        // Contact is the closest thing to it, so it runs from the tick the rider arrived. Said out loud because no
        // shipped content exercises it: modes 0 and 2+ are read from the lifetime logic rather than observed in data.
        private bool Suppressed()
        {
            if (Mode >= 2) return true;                  // never seeded, retires on its first tick - inert
            if (Mode == 0) return _contactSeconds < Seconds;   // the cooldown: alive, and pushing nobody while it runs
            return false;
        }


        // Kind 1. An elevator: it aims at an ALTITUDE rather than a speed, and stops travel so only the climb remains.
        private void VerticalLift(RideableBoard board, Vector3 pos, float dt)
        {
            // At or above the target the rider is released - and with nobody left to lift the node ENDS here, which is
            // what makes this a ride rather than a trampoline. A rider who falls back through the target afterwards
            // meets nothing ([Trailmap: 360-zboost]).
            if (pos.y >= _targetY) { _retired = true; return; }
            if (_targetY - pos.y < SnapTolerance)
            {
                // Position only. The engine's arrival branch writes the altitude and moves straight on, so the climb
                // velocity survives - and that surviving climb is what the tube-end launch then builds on. A zero
                // tolerance (the air-shaft authoring) never takes this branch and eases all the way in; a tolerance
                // larger than any gap it can see snaps on the first tick, which is how the finish-tube marker places
                // a rider outright. Arrival is arrival: the next tick lifts nobody, so the node is done.
                board.SnapToBoostAltitude(_targetY);
                _retired = true;
                return;
            }
            board.ApplyBoostPush(_dirW, Target, Rate, dt);
            board.KillBoostHorizontalVelocity();
        }

        // Kind 2. Lifts like the elevator, but its real job is to CLASSIFY: the stage it records is what the tube-end
        // volume at the top of the shaft consumes.
        //
        // THE LAP GATE, and it is the engine's own test spelled the engine's way: a rider with passes left is lifted,
        // a rider whose crossing was the last is not ([Trailmap: 360-lapboost-gate]).
        //
        // ENTRY HERE IS ALSO THE LAP CROSSING. On MEGAPLE the DTF=0 plane - and the arch, and the finish trigger on
        // it - sit ~24 m DOWN-course of this shaft: a mid-race rider is lifted before ever reaching them, so a
        // counter decremented only at the plane never moves and the tube lifts forever. The engine's own captures
        // put the decrement at the shaft, not the plane: riders inside it mid-race read seed-minus-one
        // ([Trailmap: 390-lap-field]). So the mouth of the lap volume counts the crossing - unless one just counted
        // (board.LastLapCountTime), which keeps a course whose finish line sits UP-course of its tube from counting
        // one pass twice. The values this leaves descend 3/2/1 then 0 across MEGAPLE's four passes: three lifts,
        // and the fourth pass rides through to the plane below, where the finish line's detectors record it.
        // LapsRemaining is -1 when no lap race is running at all (free-riding), which is nonzero and so lifts.
        //
        // Decided ONCE on entry, like the engine's own test, so a lap counted while you are in the shaft can't change
        // what the volume is doing to you mid-climb.
        private const float LapCrossDebounce = 3f;   // s: an entry this soon after a counted crossing is the same crossing
        private void LapGated(RideableBoard board, Vector3 pos, float dt)
        {
            if (!_latched)
            {
                _latched = true;
                if (board.LapsRemaining > 0 && Time.time - board.LastLapCountTime >= LapCrossDebounce)
                    board.CountLapAtFinish();
                _serviced = board.LapsRemaining != 0;
                if (_serviced) board.BoostStage = ClassifyStage(pos);
            }
            if (!_serviced) return;
            board.ApplyBoostPush(_dirW, Target, Rate, dt);
            board.KillBoostHorizontalVelocity();
        }

        // Kind 3. The recorded stage picks one of three (direction, speed) pairs; from there it is the ordinary shared
        // push, with its axis and target chosen per rider rather than authored per volume.
        private void TubeEnd(RideableBoard board, float dt)
        {
            int stage = board.BoostStage;
            float speed = stage == 1 ? Stage1Speed : (stage == 2 ? Stage2Speed : Stage0Speed);
            if (!_captured)
            {
                _captured = true;
                _capturedDir = stage == 1 ? _stage1W : (stage == 2 ? _stage2W : _stage0W);
            }
            board.ApplyBoostPush(_capturedDir, speed, Rate, dt);
        }

        // Stage 0 below the floor line; otherwise which side of the box centre the rider is on along the host's own X.
        // Note that stage 0 is what a real run of the retail course produces, because a rider enters the shaft at its
        // base - well under the floor line - and the answer is latched there ([Trailmap: 360-tube-latch]).
        private int ClassifyStage(Vector3 pos)
        {
            if (pos.y <= _floorY + StageFloorOffset) return 0;
            Vector3 offset = pos - _centre;
            offset.y = 0f;
            return Vector3.Dot(offset, _stageAxisW) < 0f ? 1 : 2;
        }

        private RideableBoard Board(Collider other)
        {
            if (other == null) return null;
            RideableBoard board = other.GetComponentInParent<RideableBoard>();
            return (board != null && board.IsRiding) ? board : null;
        }
    }
}
