using UnityEngine;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// Gives an imported SSX level surface "feel" in VRChat: per-surface footstep audio, optional
    /// snow particles, and out-of-bounds respawn - all driven by the SSX SurfaceType the importer
    /// baked into the terrain's per-type collision children (OpenSlope_Map/Collision/Surf_&lt;type&gt;).
    ///
    /// VRChat exposes no per-surface friction (the player capsule is engine-controlled and ignores
    /// PhysicMaterial), so this is cosmetic + respawn only - there is no real ice sliding. It runs
    /// on the LOCAL player every frame: raycast straight down, find which Surf_&lt;type&gt; collider is
    /// underfoot, look up its SSX SurfaceType, and react. Local-only, so no networking/sync.
    ///
    /// Setup: drop this on a GameObject (it auto-finds OpenSlope_Map/Collision and an AudioSource
    /// on itself), assign the footstep clips, and optionally a short burst ParticleSystem for snow.
    ///
    /// SurfaceType buckets (from the game's PBDHandler legend):
    ///   0  Reset (out of bounds)        1/3/4/8/16 snow-ish      5/7/11 ice
    ///   9/2 rock/off-track              10/13/14/18 wall/metal   17 no-collision (no collider built)
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class SurfaceDetector : UdonSharpBehaviour
    {
        [Tooltip("Parent of the Surf_<type> collision children. Auto-found as OpenSlope_Map/Collision if empty.")]
        public Transform collisionRoot;

        [Header("Footsteps")]
        [Tooltip("AudioSource the steps play through. Falls back to an AudioSource on this object.")]
        public AudioSource footstepSource;
        public AudioClip snowStep;
        public AudioClip iceStep;
        public AudioClip rockStep;
        public AudioClip metalStep;
        public AudioClip defaultStep;
        [Tooltip("World metres of travel between footsteps.")]
        public float stepDistance = 1.4f;
        [Tooltip("Minimum horizontal speed (m/s) that counts as walking.")]
        public float minMoveSpeed = 0.4f;
        [Tooltip("Above this horizontal speed (m/s) footsteps are suppressed entirely - at a high world " +
                 "run-speed (set for fast traversal) you're zooming, not running, so the steps would " +
                 "machine-gun. Fixed realistic-run cap on purpose - NOT GetRunSpeed(), which may be " +
                 "cranked up. 0 = no cap.")]
        public float maxStepSpeed = 5f;

        [Header("Particles (optional)")]
        [Tooltip("Short burst ParticleSystem Play()'d on snow footsteps.")]
        public ParticleSystem snowPuff;

        [Header("Out of bounds")]
        [Tooltip("Respawn the player when standing on an SSX 'Reset' (type 0) surface. Off by default: in a " +
                 "free-roam VRChat world the type-0 patches are scattered through the level, so the game's " +
                 "out-of-bounds reset just reads as a surprise teleport to spawn. The -2700 death floor still resets genuine falls.")]
        public bool respawnOnReset = false;
        public float respawnCooldown = 1.5f;

        [Header("Raycast")]
        [Tooltip("Start the down-ray this far above the player's feet.")]
        public float rayUp = 0.6f;
        [Tooltip("Probe this far below the player's feet.")]
        public float rayDown = 1.2f;

        [Tooltip("Perf: run the surface raycast + footstep check every Nth frame (elapsed time/travel are accumulated so " +
                 "speed and step cadence stay correct). 3 ~= 20 Hz, plenty for footsteps. 0 -> default 3.")]
        public int updateInterval = 3;

        private Collider[] _colliders; // cached terrain surface colliders
        private int[] _types;          // parallel SSX SurfaceType per collider
        private VRCPlayerApi _player;
        private Vector3 _lastPos;
        private float _distAccum;
        private float _lastRespawn = -999f;
        private int _tick;
        private float _accumDt;

        void Start()
        {
            if (collisionRoot == null)
            {
                GameObject go = GameObject.Find("OpenSlope_Map/Collision");
                if (go != null) collisionRoot = go.transform;
            }
            if (footstepSource == null) footstepSource = GetComponent<AudioSource>();
            CacheSurfaces();

            _player = Networking.LocalPlayer;
            if (_player != null) _lastPos = _player.GetPosition();
        }

        // Snapshot the Surf_<type> children once: collider + parsed SurfaceType.
        void CacheSurfaces()
        {
            if (collisionRoot == null) { _colliders = new Collider[0]; _types = new int[0]; return; }

            int n = collisionRoot.childCount;
            Collider[] cols = new Collider[n];
            int[] types = new int[n];
            int count = 0;
            for (int i = 0; i < n; i++)
            {
                Transform c = collisionRoot.GetChild(i);
                Collider col = c.GetComponent<Collider>();
                if (col == null) continue;
                cols[count] = col;
                types[count] = ParseSurfType(c.name);
                count++;
            }

            _colliders = new Collider[count];
            _types = new int[count];
            for (int i = 0; i < count; i++) { _colliders[i] = cols[i]; _types[i] = types[i]; }
        }

        // "Surf_5" -> 5 ; -1 if unparseable. Hand-rolled (no int.Parse) to stay safely inside Udon.
        int ParseSurfType(string nm)
        {
            if (nm == null) return -1;
            int us = nm.IndexOf('_');
            if (us < 0 || us + 1 >= nm.Length) return -1;
            int v = 0;
            bool any = false;
            for (int i = us + 1; i < nm.Length; i++)
            {
                int d = (int)nm[i] - (int)'0';
                if (d < 0 || d > 9) return -1;
                v = v * 10 + d;
                any = true;
            }
            return any ? v : -1;
        }

        void Update()
        {
            if (_player == null)
            {
                _player = Networking.LocalPlayer;
                if (_player == null) return;
                _lastPos = _player.GetPosition();
            }

            // Perf throttle: the surface raycast + footstep bookkeeping only need to run a few times a second, not every
            // frame. We accumulate dt and the actual travel between runs, so speed (horiz/dt) and the step-distance cadence
            // stay correct - just sampled coarser. 0 -> default 3 (so existing un-repushed instances still throttle).
            _accumDt += Time.deltaTime;
            int iv = updateInterval > 0 ? updateInterval : 3;
            if (++_tick < iv) return;
            _tick = 0;

            Vector3 pos = _player.GetPosition();
            Vector3 delta = pos - _lastPos;
            Vector3 horiz = new Vector3(delta.x, 0f, delta.z);
            float dt = _accumDt; _accumDt = 0f;   // elapsed time since the last run (not a single frame)
            float speed = dt > 0f ? horiz.magnitude / dt : 0f;
            _lastPos = pos;

            int surfType = SurfaceUnderfoot(pos);

            // Out-of-bounds: standing on a Reset surface respawns (with a cooldown so it fires once).
            if (surfType == 0 && respawnOnReset && Time.time - _lastRespawn >= respawnCooldown)
            {
                _lastRespawn = Time.time;
                _distAccum = 0f;
                _player.Respawn();
                return;
            }

            // Footsteps: accumulate horizontal travel while walking on a known surface. Suppressed when
            // standing (below minMoveSpeed) OR zooming (above maxStepSpeed) - a high world run-speed for
            // fast traversal isn't "running", so don't play steps at all rather than machine-gun them.
            bool tooSlow = speed < minMoveSpeed;
            bool tooFast = maxStepSpeed > 0f && speed > maxStepSpeed;
            if (tooSlow || tooFast)
            {
                _distAccum = 0f;
            }
            else if (surfType > 0)
            {
                _distAccum += horiz.magnitude;
                if (_distAccum >= stepDistance)
                {
                    _distAccum = 0f;
                    PlayStep(surfType);
                }
            }
        }

        // SSX SurfaceType underfoot; -1 = hit a non-terrain collider (e.g. a prop), -2 = airborne.
        int SurfaceUnderfoot(Vector3 feet)
        {
            RaycastHit hit;
            Vector3 origin = feet + Vector3.up * rayUp;
            if (Physics.Raycast(origin, Vector3.down, out hit, rayUp + rayDown))
            {
                Collider col = hit.collider;
                for (int i = 0; i < _colliders.Length; i++)
                    if (_colliders[i] == col) return _types[i];
                return -1;
            }
            return -2;
        }

        void PlayStep(int surfType)
        {
            AudioClip clip = ClipFor(surfType);
            if (clip != null && footstepSource != null) footstepSource.PlayOneShot(clip);
            if (snowPuff != null && IsSnow(surfType)) snowPuff.Play();
        }

        AudioClip ClipFor(int t)
        {
            if (IsSnow(t))  return snowStep  != null ? snowStep  : defaultStep;
            if (IsIce(t))   return iceStep   != null ? iceStep   : defaultStep;
            if (IsMetal(t)) return metalStep != null ? metalStep : defaultStep;
            if (IsRock(t))  return rockStep  != null ? rockStep  : defaultStep;
            return defaultStep;
        }

        bool IsSnow(int t)  { return t == 1 || t == 3 || t == 4 || t == 8 || t == 16; }
        bool IsIce(int t)   { return t == 5 || t == 7 || t == 11; }
        bool IsMetal(int t) { return t == 10 || t == 13 || t == 14 || t == 18; }
        bool IsRock(int t)  { return t == 9 || t == 2; }
    }
}
