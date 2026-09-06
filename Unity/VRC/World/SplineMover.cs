using UnityEngine;
using UdonSharp;

namespace OpenSlope.VrcPlugin
{

    // Spline-path movers (docs/053; [Trailmap: 230-level-ssf]): a prop travels along a baked
    // spline at a set speed - e.g. a subway train. The importer built the (invisible-template) mesh under Movers/Mover_<idx>
    // and hands us the sampled path in this transform's LOCAL space (mesh units, under the Level node's 0.01 scale). We walk
    // the transform along it with the native end/orientation laws. Purely cosmetic + kinematic (no collider), local-only.
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class SplineMover : UdonSharpBehaviour
    {
        [Tooltip("Path points in this transform's LOCAL space (mesh units). The path is open; EndMode decides what happens at its ends.")]
        public Vector3[] Path;

        [Tooltip("Signed travel speed in WORLD m/s. Native movers always initialize at route distance zero.")]
        public float Speed = 8f;

        [Tooltip("The authored rotation baked into the template's mesh. Undone before the prop is posed - the engine builds this prop's matrix from the spline alone.")]
        public Quaternion Baked = Quaternion.identity;

        [Tooltip("Authored yaw in RADIANS. Yaw = (this + pi/2) - the tangent's compass angle, so this is what picks which model axis leads down the track.")]
        public float YawOffset;

        [Tooltip("0 = follow yaw + pitch, 1 = follow yaw/stay level, 2 = fixed yaw/follow pitch, 3 = fixed orientation.")]
        public int OrientMode;

        [Tooltip("0 = finish and remove, 1 = wrap, 2 = ping-pong, 3 = hold at the forward end.")]
        public int EndMode = 1;

        [Tooltip("Where along the path this copy starts, in LOCAL (mesh) units. The engine rides InstanceCount copies of one model on a spline, spaced evenly by arc length - a chairlift's chairs.")]
        public float StartDist;

        private Quaternion _unbake;
        private float _pathLen;
        private float _distance;
        private int _direction;
        private bool _stopped;
        private float[] _cumLen;    // arc length from the path start to Path[i]; segment i spans [_cumLen[i], _cumLen[i+1]]
        private float _invScale;    // 1 / |lossyScale.x| - the Level node's import scale, constant at runtime
        private float _startOffset; // StartDist wrapped into [0, _pathLen) once, so the per-frame wrap is a single subtract
        private int _seg;           // cached segment cursor; the sample moves a little per frame, so the walk resumes here
        private int _poseSeg = -1;  // segment the current rotation was built from (-1 = none yet)
        private int _poseDir;       // travel direction the current rotation was built from

        void Start()
        {
            if (Path == null || Path.Length < 2) { enabled = false; return; }
            _cumLen = new float[Path.Length];
            _cumLen[0] = 0f;
            for (int i = 1; i < Path.Length; i++) _cumLen[i] = _cumLen[i - 1] + Vector3.Distance(Path[i - 1], Path[i]);
            _pathLen = _cumLen[Path.Length - 1];
            if (_pathLen <= 0.001f) { enabled = false; return; }
            _distance = 0f;                         // The specified mover initializes its shared cursor to zero.
            _direction = Speed < 0f ? -1 : 1;
            _stopped = false;
            _seg = 0;

            float scale = Mathf.Abs(transform.lossyScale.x);
            if (scale < 1e-5f) scale = 0.01f;
            _invScale = 1f / scale;

            _startOffset = Mathf.Max(0f, StartDist);
            int wrapGuard = 0;
            while (_startOffset >= _pathLen && wrapGuard++ < 4096) _startOffset -= _pathLen;

            // The template's authored rotation is baked into the mesh (it's diverted like any other prop), but the engine
            // poses a spline mover from the spline ALONE - it never reads that rotation. So undo it, putting the mesh back
            // in MODEL space, which is the space the engine's yaw/pitch below are defined in.
            _unbake = Quaternion.Inverse(Baked);
            ApplyPose();
        }

        void Update()
        {
            // A stopped mover's pose can never change (the cursor is frozen and StartDist is fixed), and the stopping
            // frame already posed it - so a held/clamped mover costs nothing per frame.
            if (_stopped || Path == null || Path.Length < 2 || _pathLen <= 0.001f) return;

            // Path is in LOCAL (mesh) units; the Level node's ~0.01 scale takes it to world. Convert world speed into
            // local units/s. All copies advance the SAME base cursor; StartDist is added only by ApplyPose, matching
            // the specified shared cursor + evenly spaced per-copy sampling [Trailmap: 230-level-ssf].
            float next = _distance + Mathf.Abs(Speed) * _invScale * Time.deltaTime * _direction;
            bool finish = false;
            int guard = 0;
            while ((next < 0f || next >= _pathLen) && guard++ < 128)
            {
                if (next < 0f)
                {
                    // Only ping-pong reverses at the starting end. Every other mode repeatedly clamps there.
                    if (EndMode == 2) { next = -next; _direction = 1; continue; }
                    next = 0f; _stopped = true; break;
                }
                if (EndMode == 0) { next = _pathLen; finish = true; break; }
                if (EndMode == 3) { next = _pathLen; _stopped = true; break; }
                if (EndMode == 2)
                {
                    float overshoot = next - _pathLen;
                    next = _pathLen - overshoot;
                    _direction = -1;
                    if (overshoot <= 0f) break;
                    continue;
                }
                next -= _pathLen;               // mode 1 and every out-of-range value use the native wrap fallback
            }
            _distance = Mathf.Clamp(next, 0f, _pathLen);
            ApplyPose();
            if (finish)
            {
                // Native mode 0 marks the node complete, then destroys it (and its pose buffer) on the next update.
                enabled = false;
                gameObject.SetActive(false);
            }
        }

        void ApplyPose()
        {
            // _distance is in [0, _pathLen] and _startOffset in [0, _pathLen), so one subtract is the whole wrap.
            float sample = _distance + _startOffset;
            if (sample > _pathLen) sample -= _pathLen;

            // Resume the segment walk at the cached cursor: forward as the sample advances, backward on a ping-pong
            // reverse leg. The wrap from the path's end back to its start walks the cursor down the whole array in one
            // frame, but against precomputed lengths that's float compares, not distance recomputes.
            int last = Path.Length - 2;
            int seg = _seg;
            if (seg > last) seg = last; else if (seg < 0) seg = 0;
            int guard = 0;
            while (seg < last && sample >= _cumLen[seg + 1] && guard++ < 4096) seg++;
            guard = 0;
            while (seg > 0 && sample < _cumLen[seg] && guard++ < 4096) seg--;
            _seg = seg;

            float segLen = _cumLen[seg + 1] - _cumLen[seg];
            float t = segLen > 0.001f ? Mathf.Clamp01((sample - _cumLen[seg]) / segLen) : 0f;
            Vector3 p0 = Path[seg];
            Vector3 p1 = Path[seg + 1];
            transform.localPosition = Vector3.Lerp(p0, p1, t);

            // The rotation depends only on the segment's tangent and the travel direction (everything else is authored
            // constants), so the trig below runs only when one of those changes - not per frame.
            if (seg == _poseSeg && _direction == _poseDir) return;

            // Pose the model the way the engine does. It builds a yaw about the level's up (mesh +Z, which the Level node's
            // -90 X stands up in the world) and a pitch about the model's own X, from the spline TANGENT - not from a
            // LookRotation, which would aim the transform's +Z (mesh UP) down the track and lay the prop on its side.
            //
            //   yaw   = (YawOffset + pi/2) - the tangent's compass angle
            //   pitch = -tangent.z radians (the engine reads the tangent's height straight off as an angle), or 0 when the
            //           orientation mode disables it
            //
            // YawOffset is what decides which model axis leads: 0 aims +Y down-track, and the subway's 1.62 rad swings that
            // round to its long -X axis. We never hardcode an axis - the offset does it, as in the game.
            //
            // Our mesh space negates X (the mirror the whole level is baked with), which reverses the sense of a yaw about
            // Z but leaves a pitch about X alone - hence the signs below. Building the basis vectors directly keeps this
            // free of any row/column or handedness convention: they ARE the images of the model's axes.
            Vector3 dir = p1 - p0;                  // forward path tangent; reverse-leg facing is applied explicitly below
            if (dir.sqrMagnitude <= 1e-4f) return;
            dir = dir.normalized;

            float yaw = YawOffset + Mathf.PI * 0.5f;
            bool followYaw = OrientMode != 2 && OrientMode != 3;    // every other integer follows yaw like native mode 0
            if (EndMode == 2 && _direction < 0) yaw += Mathf.PI;    // native direction flip is independent of tangent-yaw mode
            if (followYaw)
                yaw -= Mathf.Atan2(dir.y, -dir.x);                  // -x: the tangent's compass angle in the game's (unmirrored) space
            float pitch = (OrientMode == 1 || OrientMode == 3) ? 0f : -dir.z * _direction;

            float cy = Mathf.Cos(yaw), sy = Mathf.Sin(yaw);
            float cp = Mathf.Cos(pitch), sp = Mathf.Sin(pitch);
            Vector3 modelY = new Vector3(-cp * sy, cp * cy, -sp);   // where the model's +Y lands
            Vector3 modelZ = new Vector3(-sp * sy, sp * cy, cp);    // ... and its +Z
            transform.localRotation = Quaternion.LookRotation(modelZ, modelY) * _unbake;
            _poseSeg = seg; _poseDir = _direction;
        }
    }
}
