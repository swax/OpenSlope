using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Basis behaviour for the SSX MainType-0 BOOST FAMILY (docs/053) - the Basis analogue of the VRChat BoostVolume.
    // Invisible AABB volumes that drive the rider's velocity while they are INSIDE. Four sub-types ship, and the
    // engine's class layout says they are one mechanism - sub-7 is the base class, sub-24 derives from it, and
    // sub-15/sub-18 lay out the same rate/target/axis triple at the same payload offsets. So one behaviour carries all
    // four ([Trailmap: 360-node, 360-zboost, 360-lapboost, 360-tubeend]):
    //
    //   Kind 0  DIRECTIONAL   the general velocity driver - conveyors, exhaust vents, sand boosts, wind.
    //   Kind 1  VERTICAL LIFT an elevator: cancels horizontal motion and aims at an ALTITUDE, not a speed.
    //   Kind 2  LAP-GATED     lifts like the elevator, and classifies the rider into a launch stage.
    //   Kind 3  TUBE-END      consumes that stage to launch the rider out of the top of the shaft.
    //
    // Distinct from the arrow PADS (BasisBoostPad), which only raise the top-speed cap and feed forward thrust along
    // your OWN travel. These drive a designer's vector, so they can shove a slow rider sideways or lift them vertically.
    // Realized from a BoostVolumeMarker by BasisWiring.
    //
    // Detection is the FX-trigger poll the rest of the Basis world behaviours use (Basis has no OnPlayerTriggerEnter,
    // and a physics trigger misses a seated rider): it polls the local player against the volume each frame. Unlike the
    // reset zone / boost pad, which act on the RISING EDGE, this one acts EVERY FRAME the rider is inside - duration
    // here is containment, not a debounced contact event. The lift cancels horizontal motion PER TICK, and a lift that
    // only fired on the cross would lurch instead of climb. The engine tests the host's bounding box, confirmed live
    // ([Trailmap: 360-tube-box]), so an AABB is the faithful shape. The BOOST is purely LOCAL - only the rider inside
    // the volume is moved - so there is nothing to broadcast.
    //
    // The boundary is the BOARD POSITION swept over the frame, against the AUTHORED box - the collider is grown by
    // BroadphaseMargin so the poll is live before the rider arrives, and that margin comes back off here so it never
    // moves where the push starts. The engine selects riders with WorldEntity_IntersectLineQuery over the tick's
    // movement ([Trailmap: 360-node-apply, 130-modes]): a line, so no rider thickness enters it, and a segment rather
    // than a point because at 30 m/s a frame covers half a metre and a point test walks through a thin plate.
    //
    // The push AXIS is authored in WORLD space; the engine never turns it by the host prop's transform. The importer
    // bakes it as this trigger's LOCAL direction purely so it rides the Level node's -90X/0.01 to world, and the
    // trigger itself is unrotated, so TransformDirection reproduces the engine's world vector and nothing else. The lap
    // boost's STAGE axis is the one deliberate exception: the engine really does run the host's instance matrix over
    // (1,0,0) there ([Trailmap: 360-lapboost-stage]), and the bake folds that rotation in.
    [RequireComponent(typeof(BoxCollider))]
    public class BasisBoostVolume : MonoBehaviour
    {
        public int Kind;                    // 0 = directional, 1 = vertical lift, 2 = lap-gated, 3 = tube-end

        public Vector3 LocalDir = Vector3.forward;   // push axis, trigger-local
        public float Target = 20f;                   // speed (m/s) along the axis the rider is driven toward
        public float Rate = 3f;                      // approach rate: the lag's 1/time-constant
        public float BroadphaseMargin;               // world m the collider is grown by per face; shrunk back off here

        [Header("Vertical lift (Kind 1)")]
        public int Mode = 1;        // sub-7/24 lifetime: 0 = suppressing cooldown, 1 = window (all retail), >=2 = inert
        public float Seconds;       // how long that countdown runs; only Mode 0 acts on it
        public float TargetAltitudeRise;    // metres above THIS VOLUME'S OWN CENTRE the elevator carries riders to;
                                            // resolved to a world altitude at Start, so it follows the Level's recenter
        public float SnapTolerance;         // gap under which the rider is placed there outright; 0 never snaps

        [Header("Lap-gated (Kind 2)")]
        public Vector3 LocalStageAxis = Vector3.right;
        public float StageFloorOffset = 10f;

        [Header("Tube-end (Kind 3)")]
        public Vector3 Stage0Dir = Vector3.forward;
        public Vector3 Stage1Dir = Vector3.forward;
        public Vector3 Stage2Dir = Vector3.forward;
        public float Stage0Speed = 27f;
        public float Stage1Speed = 35f;
        public float Stage2Speed = 35f;

        BoxCollider _volume;

        // Per-entry state. The engine latches on entry so the stage classification and the tube-end's direction capture
        // each happen exactly once; leaving clears the latch, because the engine builds a fresh node per contact
        // dispatch, which has the same effect ([Trailmap: 360-tube-latch]).
        bool _latched;
        bool _serviced;      // lap-gated: did the entry test decide to lift this rider at all?
        bool _captured;
        // VERTICAL LIFT ONLY: the node has RETIRED and will not lift again until the rider leaves and re-enters.
        // Its lifetime rule is presence, not a window - the alive flag is set by a rider it lifted and by nothing
        // else, and an alive flag of zero self-ends the node that tick ([Trailmap: 360-zboost]).
        bool _retired;
        float _contactSeconds;   // seconds this contact has lasted, for the Mode-0 cooldown
        Vector3 _capturedDir;

        // The volume never moves, so its world frame is resolved once rather than per frame.
        Vector3 _dirW, _stageAxisW, _stage0W, _stage1W, _stage2W, _centre;
        Vector3 _half;          // the AUTHORED half-extents: the collider's, less the broadphase margin
        float _floorY;
        float _targetY;         // TargetAltitudeRise resolved against this volume's own centre
        Vector3 _prevPos;       // board position last frame, so containment tests the swept segment
        bool _havePrev;

        void Start()
        {
            _volume = GetComponent<BoxCollider>();
            _dirW = Norm(transform.TransformDirection(LocalDir), Vector3.forward);
            _stageAxisW = Norm(transform.TransformDirection(LocalStageAxis), Vector3.right);
            _stage0W = Norm(transform.TransformDirection(Stage0Dir), Vector3.forward);
            _stage1W = Norm(transform.TransformDirection(Stage1Dir), Vector3.forward);
            _stage2W = Norm(transform.TransformDirection(Stage2Dir), Vector3.forward);

            // The collider's WORLD bounds, not its local size: the volume hangs under the Level node's -90X, so the
            // box's local Y is not the vertical axis and reading size.y would measure the wrong side of the box. The
            // margin comes back off here, so the stage gate measures its 10 m from the authored floor too.
            _centre = _volume != null ? _volume.bounds.center : transform.position;
            _half = _volume != null
                ? Vector3.Max(_volume.bounds.extents - Vector3.one * BroadphaseMargin, Vector3.zero)
                : Vector3.zero;
            _floorY = _centre.y - _half.y;
            _targetY = _centre.y + TargetAltitudeRise;
        }

        static Vector3 Norm(Vector3 v, Vector3 fallback) => v.sqrMagnitude > 1e-8f ? v.normalized : fallback;

        /// Slab test of the segment from -> to against the authored box; a zero-length step degenerates to a point test.
        bool SweepHitsBox(Vector3 from, Vector3 to)
        {
            Vector3 lo = _centre - _half, hi = _centre + _half;
            float enter = 0f, exit = 1f;
            for (int i = 0; i < 3; i++)
            {
                float a = from[i], delta = to[i] - from[i];
                if (Mathf.Abs(delta) < 1e-9f) { if (a < lo[i] || a > hi[i]) return false; continue; }
                float t0 = (lo[i] - a) / delta, t1 = (hi[i] - a) / delta;
                enter = Mathf.Max(enter, Mathf.Min(t0, t1));
                exit = Mathf.Min(exit, Mathf.Max(t0, t1));
                if (enter > exit) return false;
            }
            return true;
        }

        void Update()
        {
            // The BOARD's position, not the seated rider's root - the board is what these volumes carry, and it is what
            // the lift's altitude snap moves (BasisLocalPlayerProbe.PointInBox exists for exactly this test). A walking
            // player has no velocity of ours to drive, so no board means nothing to do.
            var board = BasisBoard.LocalRider;
            if (board == null) { _havePrev = false; ClearLatches(); return; }

            Vector3 pos = board.transform.position;
            bool inside = SweepHitsBox(_havePrev ? _prevPos : pos, pos);
            _prevPos = pos;
            _havePrev = true;
            if (!inside) { ClearLatches(); return; }
            if (_retired) return;                                // the lift carried this rider already; the node is gone

            float dt = Time.deltaTime;
            // Read before the increment, so Seconds = 0 means "already run" rather than swallowing its own tick.
            bool suppressed = Suppressed();
            _contactSeconds += dt;

            if (Kind == 1) VerticalLift(board, pos, dt);          // presence is its rule; it reads no mode
            else if (Kind == 2) LapGated(board, pos, dt);
            else if (suppressed) return;
            else if (Kind == 3) TubeEnd(board, dt);
            else board.ApplyBoostPush(_dirW, Target, Rate, dt);
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
        bool Suppressed()
        {
            if (Mode >= 2) return true;                  // never seeded, retires on its first tick - inert
            if (Mode == 0) return _contactSeconds < Seconds;   // the cooldown: alive, and pushing nobody while it runs
            return false;
        }


        // Leaving clears every per-entry latch, because the engine builds a fresh node per contact dispatch.
        void ClearLatches() { _latched = false; _serviced = false; _captured = false; _retired = false; _contactSeconds = 0f; }

        // Kind 1. An elevator: it aims at an ALTITUDE rather than a speed, and stops travel so only the climb remains.
        void VerticalLift(BasisBoard board, Vector3 pos, float dt)
        {
            // At or above the target the rider is released - and with nobody left to lift the node ENDS here, which
            // is what makes this a ride rather than a trampoline. The lift cancels horizontal motion every tick, so
            // a rider carried to the ceiling cannot travel out of the box: without the retire they fall back through
            // the target, qualify again, and are lifted again indefinitely ([Trailmap: 360-zboost]).
            if (pos.y >= _targetY) { _retired = true; return; }
            if (_targetY - pos.y < SnapTolerance)
            {
                // Position only. The engine's arrival branch writes the altitude and moves straight on, so the climb
                // velocity survives - and that surviving climb is what the tube-end launch then builds on. A zero
                // tolerance (the air-shaft authoring) never takes this branch and eases all the way in; a tolerance
                // larger than any gap it can see snaps on the first tick, which is how the finish-tube marker places
                // a rider outright.
                // Arrival is arrival: the next tick lifts nobody, so the node is done.
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
        // ENTRY HERE IS ALSO THE LAP CROSSING - on MEGAPLE the finish plane sits ~24 m DOWN-course of the shaft, so
        // mid-race passes end here and only the last, unlifted pass ever reaches the plane (see the VRChat twin for
        // the full story). The mouth counts the crossing unless one just counted (board.LastLapCountTime), leaving
        // 3/2/1 then 0 across MEGAPLE's four passes. -1 means no lap race is running, which is nonzero and so lifts;
        // with no finish trigger on this platform, -1 is the standing state and the tube lifts on every pass.
        //
        // Decided ONCE on entry, like the engine's own test, so a lap counted while you are in the shaft can't change
        // what the volume is doing to you mid-climb.
        const float LapCrossDebounce = 3f;   // s: an entry this soon after a counted crossing is the same crossing
        void LapGated(BasisBoard board, Vector3 pos, float dt)
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
        void TubeEnd(BasisBoard board, float dt)
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
        int ClassifyStage(Vector3 pos)
        {
            if (pos.y <= _floorY + StageFloorOffset) return 0;
            Vector3 offset = pos - _centre;
            offset.y = 0f;
            return Vector3.Dot(offset, _stageAxisW) < 0f ? 1 : 2;
        }
    }
}
