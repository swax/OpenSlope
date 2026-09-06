using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Part of BasisBoard (partial): the GRIND FX - the spark burst + scrape loop while riding a rail. Ported from the
    // VRChat RideableBoard's grind FX (RideableBoard.Rail.cs StartGrindFx/StopGrindFx/UpdateGrindFx), pared to what
    // Basis has today:
    //   - SPARKS run fully: a URP additive ParticleSystem (built by BasisBoardSetup) whose sprites peel off the rail
    //     seam under the deck (the _railPoint contact), up and back along the rail, at a rate that scales with speed.
    //   - The grind-SCRAPE loop rides an AudioSource whose clip the board setup leaves UNASSIGNED - the extracted scrape
    //     clip isn't in the Basis project yet (like the rest of the board audio) - so it's SILENT until a clip is provided;
    //     the volume/pitch envelope is wired so dropping a clip in makes it work.
    // The snow spray / carved-wake FX aren't ported, so there's no glide/carve loop to fade out here (the VRChat version
    // does, because a grind interrupts the snow FX).
    public partial class BasisBoard
    {
        [Header("Grind FX (built by BasisBoardSetup)")]
        [Tooltip("Spark burst emitted off the rail seam while grinding (a URP additive ParticleSystem). Null = no sparks.")]
        public ParticleSystem sparks;
        [Tooltip("Looping grind-scrape AudioSource. Its clip isn't in the Basis project yet, so it's silent until one is assigned.")]
        public AudioSource grindSource;
        [Range(0f, 1f)] public float grindVolume = 0.7f;
        [Tooltip("Min board speed (m/s) for grind sparks + scrape.")]
        public float grindMinSpeed = 3f;
        [Tooltip("Speed (m/s) at which the sparks + scrape reach full intensity.")]
        public float grindFullSpeed = 14f;
        [Tooltip("Sparks emitted per second at full speed (a steady scrape off the rail seam).")]
        public float grindSparkRate = 12f;

        // Per-player cosmetic switch the Performance Board (BasisPerfBoard) drives: when false, YOUR OWN board stops
        // drawing its grind sparks so a weak client can reclaim that cost. Local + static (one local rider); defaults on.
        public static bool ShowLocalBoardFx = true;

        float _sparkAccum;
        bool _grindFxOn;

        // Bring the grind FX alive on lock-on (from TryEnterGrind).
        void StartGrindFx()
        {
            _sparkAccum = 0f;
            if (grindSource != null)
            {
                grindSource.loop = true;
                grindSource.volume = 0f;
                if (grindSource.clip != null) grindSource.Play();
            }
            if (sparks != null) sparks.Play();
            _grindFxOn = grindSource != null || sparks != null;
        }

        // Silence + clear the grind FX when leaving a rail (from ExitGrind) or on dismount/respawn.
        void StopGrindFx()
        {
            _grindFxOn = false;
            if (grindSource != null) grindSource.Stop();
            if (sparks != null) { sparks.Stop(); sparks.Clear(); }
        }

        // Per grind frame (from GrindUpdate): ride the scrape's volume/pitch on speed and kick sparks off the rail seam.
        void UpdateGrindFx(float dt)
        {
            if (!_grindFxOn) return;
            float speed = _vel.magnitude;
            float span = Mathf.Max(0.1f, grindFullSpeed - grindMinSpeed);
            float s01 = Mathf.Clamp01((speed - grindMinSpeed) / span);

            if (grindSource != null && grindSource.clip != null)
            {
                grindSource.volume = Mathf.MoveTowards(grindSource.volume, grindVolume * s01, 4f * dt);
                grindSource.pitch = Mathf.Lerp(0.9f, 1.4f, s01);
            }

            if (sparks != null && ShowLocalBoardFx && speed > grindMinSpeed)
            {
                // Sparks come from the BOARD/RAIL contact (the line under the deck, _railPoint), up off the edge and BACK
                // ALONG the rail, so they trail the contact no matter which way the deck faces (grind sideways and they
                // still peel off the rail). Mirrors the VRChat grind sparks (docs/026).
                Vector3 along = _railFwd.sqrMagnitude > 1e-6f ? _railFwd.normalized
                              : (_vel.sqrMagnitude > 1e-4f ? _vel.normalized : _fwd);
                Vector3 dir = (Vector3.up - along).normalized;
                if (dir.sqrMagnitude < 1e-6f) dir = Vector3.up;
                sparks.transform.position = _railPoint + Vector3.up * (railHeight * 0.5f);
                sparks.transform.rotation = Quaternion.LookRotation(dir, Vector3.up);

                _sparkAccum += grindSparkRate * s01 * dt;
                int cnt = (int)_sparkAccum;
                if (cnt > 0) { _sparkAccum -= cnt; sparks.Emit(cnt); }
            }
        }
    }
}
