using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Part of BasisBoard (partial): the board GLIDE + CARVE loops, held-BOOST roar, and big-air wind, for the LOCAL rider
    // only. The Basis port of the VRChat RideableBoard.Audio.cs (docs/015-audio-runtime), pared to what Basis carries:
    //   - GLIDE (the slide) + CARVE (the edge bite): two continuously-running loops whose clip is chosen by the contact
    //     surface's audio group and whose volume/pitch ride the feel signals (speed, lean, sideways slip). They fade to
    //     silence in the air and while grinding a rail (the grind scrape covers that).
    //   - BOOST roar: a dedicated looping source with a reconstructed envelope - PUNCH on the held-boost engage,
    //     decay to a low SUSTAIN while held, fast FADE out on release / when the thrust stops. It runs wherever the
    //     boost actually thrusts: on the ground, and in the air while the aimed air boost fires (_airBoostActive);
    //     rails stay silent. The VRChat boost-METER tiers aren't ported (boost is unlimited on Basis), so there's
    //     one boost clip rather than the 120/121/122 meter slots.
    //
    // The surface/boost clips aren't in the Basis project yet, but setup does resolve the recovered shared MAIN/032
    // big-air clip when `snowknife shared` has staged it. These are the local
    // rider's own board, so the sources are 2D (you always hear your own board); a remote board never mounts locally, so
    // StartBoardAudio only ever runs for the player actually riding.
    public partial class BasisBoard
    {
        [Header("Board audio (glide + carve + boost + big-air wind; local rider only)")]
        [Tooltip("The GLIDE (slide) loop source. Null = no glide sound.")]
        public AudioSource glideSource;
        [Tooltip("The CARVE (edge bite) loop source. Null = no carve sound.")]
        public AudioSource carveSource;
        [Tooltip("The held-BOOST roar loop source. Null = no boost sound.")]
        public AudioSource boostSource;
        [Tooltip("Focused-rider big-air wind source. MAIN/032 starts only for a predicted flight >1.5 s.")]
        public AudioSource bigAirWindSource;
        [Tooltip("Per-surface-group GLIDE clips, indexed [0 PACK, 1 POWDER, 2 ICE, 3 ROCK, 4 CHUTE, 5 WOOD] (AudioGroupFor). " +
                 "Not in the Basis project yet - leave empty for a silent (but fully wired) glide loop.")]
        public AudioClip[] glideClips;
        [Tooltip("Per-surface-group CARVE clips, same 6 groups as glideClips.")]
        public AudioClip[] carveClips;
        [Tooltip("Held-boost roar loop clip (a flat ~constant roar; the punch/sustain/release envelope is applied here). Empty = silent.")]
        public AudioClip boostClip;
        [Tooltip("Shared MAIN-bank big-air wind loop (zbxsfx slot 032). This is rider state, not map ambience.")]
        public AudioClip bigAirWindClip;

        [Header("Board audio feel")]
        [Range(0f, 1f)] public float soundVolume = 1f;   // master board-sound volume (scales glide/carve/boost)
        [Tooltip("Volume slew (1/s) so loop transitions ease instead of clicking.")]
        public float soundFade = 6f;
        [Range(0f, 1f)] public float glideVolume = 0.8f;
        [Tooltip("Speed (m/s) below which the glide loop is silent, and (glideFullSpeed) where it reaches full volume.")]
        public float glideMinSpeed = 2f;
        public float glideFullSpeed = 22f;
        public float glidePitchMin = 0.85f;
        public float glidePitchMax = 1.35f;
        [Range(0f, 1f)] public float carveVolume = 0.7f;
        [Range(0f, 1f)] public float boostVolume = 0.9f;
        [Tooltip("Length (s) of the loud PUNCH at the start of a held boost before it decays to the sustain level.")]
        public float boostPunchSeconds = 0.35f;
        [Tooltip("Sustain level of the boost roar while held, as a fraction of boostVolume (after the punch).")]
        [Range(0f, 1f)] public float boostSustainFrac = 0.55f;
        [Tooltip("Fade-out rate (1/s) of the boost roar on release / leaving the ground (the punch onset uses soundFade).")]
        public float boostFadeRate = 2.5f;
        [Range(0f, 1f)] public float bigAirWindVolume = 0.7f;
        public float bigAirWindMinSeconds = 1.5f;

        // ---- Board audio state -----------------------------------------------------------------------------
        int _audioGroup = -1;      // the surface audio group currently loaded into glide/carve (-1 = none yet)
        bool _audioOn;             // the loops are spun up (between mount and dismount)
        bool _boostLoopOn;         // the boost source is currently playing its loop
        bool _boostWasActive;      // held boost was active last frame (to detect the fresh engage edge)
        float _boostEngageTime;    // Time.time of the last fresh boost engage (arms the punch)
        bool _bigAirWindLoopOn;
        bool _audioWasGrounded;
        float _predictedAirTime;

        // Spin up the loop sources on mount. They run silently until we move; volume/clip are driven per frame.
        void StartBoardAudio()
        {
            _audioGroup = -1;
            if (glideSource == null && carveSource == null && boostSource == null && bigAirWindSource == null) return;
            LoadAudioGroup(0);   // default to PACK until the first ground Probe picks the real surface
            if (glideSource != null) { glideSource.loop = true; glideSource.volume = 0f; if (glideSource.clip != null) glideSource.Play(); }
            if (carveSource != null) { carveSource.loop = true; carveSource.volume = 0f; if (carveSource.clip != null) carveSource.Play(); }
            _audioOn = true;
            _boostLoopOn = false; _boostWasActive = false;
            if (bigAirWindSource != null) { bigAirWindSource.Stop(); bigAirWindSource.volume = 0f; }
            _bigAirWindLoopOn = false; _audioWasGrounded = true; _predictedAirTime = 0f;
        }

        // Silence the loops on dismount so a parked or recycled board makes no sound.
        void StopBoardAudio()
        {
            _audioOn = false;
            if (glideSource != null) glideSource.Stop();
            if (carveSource != null) carveSource.Stop();
            if (boostSource != null) boostSource.Stop();
            if (bigAirWindSource != null) bigAirWindSource.Stop();
            _boostLoopOn = false; _boostWasActive = false;
            _bigAirWindLoopOn = false; _audioWasGrounded = true; _predictedAirTime = 0f;
        }

        // Swap the loop clips to a surface audio group if it changed (a no-op while the group holds). Group indices match
        // glideClips/carveClips: 0 PACK, 1 POWDER, 2 ICE, 3 ROCK, 4 CHUTE, 5 WOOD - see AudioGroupFor.
        void LoadAudioGroup(int g)
        {
            if (g == _audioGroup) return;
            _audioGroup = g;
            if (glideSource != null && glideClips != null && g >= 0 && g < glideClips.Length && glideClips[g] != null)
            {
                glideSource.clip = glideClips[g];
                if (_audioOn) glideSource.Play();
            }
            if (carveSource != null && carveClips != null && g >= 0 && g < carveClips.Length && carveClips[g] != null)
            {
                carveSource.clip = carveClips[g];
                if (_audioOn) carveSource.Play();
            }
        }

        // Per-frame loudness/pitch for the two loop layers from this frame's ride state. Glide rides speed; carve rides lean
        // + sideways slip; both fade to silence in the air (and while grinding, when the ride loop calls this with
        // onGround=false). MoveTowards eases the volumes so transitions don't click.
        void UpdateBoardAudio(bool onGround, float dt)
        {
            if (!_audioOn) return;
            float speed = _vel.magnitude;
            if (onGround) LoadAudioGroup(AudioGroupFor(_pSurf)); // the contact's surface type (Basis has no separate prop-audio surface)

            float span = Mathf.Max(0.1f, glideFullSpeed - glideMinSpeed);
            float speed01 = Mathf.Clamp01((speed - glideMinSpeed) / span);

            float glideTarget = onGround ? glideVolume * speed01 * soundVolume : 0f;
            if (glideSource != null)
            {
                glideSource.volume = Mathf.MoveTowards(glideSource.volume, glideTarget, soundFade * dt);
                glideSource.pitch = Mathf.Lerp(glidePitchMin, glidePitchMax, speed01);
            }

            // Carve intensity: how hard you're leaning (edge angle) plus how much you're sliding sideways (slip), gated by
            // speed so a stopped board with the stick held doesn't scrape.
            float carve01 = Mathf.Clamp01(Mathf.Abs(_lean) + _slip * 0.08f) * speed01;
            float carveTarget = onGround ? carveVolume * carve01 * soundVolume : 0f;
            if (carveSource != null)
            {
                carveSource.volume = Mathf.MoveTowards(carveSource.volume, carveTarget, soundFade * dt);
                carveSource.pitch = Mathf.Lerp(0.9f, 1.3f, carve01);
            }

            UpdateBigAirWind(onGround || _grinding, dt);
        }

        void UpdateBigAirWind(bool onGround, float dt)
        {
            if (bigAirWindSource == null) { _audioWasGrounded = onGround; return; }
            if (!onGround && _audioWasGrounded)
                _predictedAirTime = PredictAirDuration(transform.position, _vel);
            else if (onGround)
                _predictedAirTime = 0f;

            bool active = !onGround && _predictedAirTime > bigAirWindMinSeconds;
            if (active && !_bigAirWindLoopOn && bigAirWindClip != null)
            {
                bigAirWindSource.clip = bigAirWindClip;
                bigAirWindSource.loop = true;
                bigAirWindSource.volume = 0f;
                bigAirWindSource.Play();
                _bigAirWindLoopOn = true;
            }
            if (_bigAirWindLoopOn)
            {
                float target = active ? bigAirWindVolume * soundVolume : 0f;
                bigAirWindSource.volume = Mathf.MoveTowards(bigAirWindSource.volume, target, soundFade * dt);
                if (!active && bigAirWindSource.volume <= 0.001f)
                {
                    bigAirWindSource.Stop();
                    _bigAirWindLoopOn = false;
                }
            }
            _audioWasGrounded = onGround;
        }

        float PredictAirDuration(Vector3 origin, Vector3 velocity)
        {
            const float step = 0.1f;
            const float horizon = 8f;
            float rise = velocity.y > 0f ? velocity.y / gravityRising : 0f;
            float riseHeight = velocity.y > 0f ? velocity.y * rise - 0.5f * gravityRising * rise * rise : 0f;
            Vector3 from = AirPathPoint(origin, velocity, 0f, rise, riseHeight);
            for (float t = step; t <= horizon + 0.001f; t += step)
            {
                Vector3 to = AirPathPoint(origin, velocity, t, rise, riseHeight);
                if (t > rise + step * 0.5f && t >= 0.2f)
                {
                    Vector3 chord = to - from;
                    float length = chord.magnitude;
                    if (length > 0.0001f)
                    {
                        int count = Physics.RaycastNonAlloc(from, chord / length, _hitBuf, length, ~0,
                                                            QueryTriggerInteraction.Ignore);
                        float nearest = length + 1f;
                        for (int i = 0; i < count; i++)
                        {
                            Collider c = _hitBuf[i].collider;
                            if (c == null || c == _ownCollider || c == _probeCol || _hitBuf[i].normal.y <= 0f) continue;
                            int ci = IndexOf(c);
                            if (_colliders != null && _colliders.Length > 0 && ci < 0 && !IsRideableProp(c)) continue;
                            if (_hitBuf[i].distance < nearest) nearest = _hitBuf[i].distance;
                        }
                        if (nearest <= length) return Mathf.Max(0f, t - step + step * nearest / length);
                    }
                }
                from = to;
            }
            return 0f;
        }

        Vector3 AirPathPoint(Vector3 origin, Vector3 velocity, float t, float rise, float riseHeight)
        {
            float horizontal = airHorizontalDrag > 0.000001f
                ? (1f - Mathf.Exp(-airHorizontalDrag * t)) / airHorizontalDrag : t;
            Vector3 point = origin + new Vector3(velocity.x * horizontal, 0f, velocity.z * horizontal);
            point.y += t <= rise
                ? velocity.y * t - 0.5f * gravityRising * t * t
                : riseHeight - 0.5f * gravity * (t - rise) * (t - rise);
            return point;
        }

        // The held-boost roar, shaped. On the engage edge PUNCH to boostVolume for boostPunchSeconds, decay to a low
        // SUSTAIN while held, then fast-FADE to 0 + Stop on release (or when the thrust stops). Runs on the ground and
        // while the aimed air boost fires (_airBoostActive); rails stay silent. Gates on the HELD boost (not the
        // pad boost, which plays its own pad cue). No boost meter on Basis, so one clip - the VRChat 120/121/122 meter
        // tiers aren't ported.
        void UpdateBoostAudio(bool onGround, float dt)
        {
            if (boostSource == null) return;
            bool active = holdBoostEnabled && _boostHeld && (onGround || _airBoostActive);
            if (active && !_boostWasActive) _boostEngageTime = Time.time; // (re)arm the punch on every fresh engage
            _boostWasActive = active;

            if (active && !_boostLoopOn)
            {
                if (boostClip != null)
                {
                    boostSource.clip = boostClip; boostSource.loop = true; boostSource.volume = 0f; boostSource.Play();
                    _boostLoopOn = true;
                }
            }
            if (!_boostLoopOn) return;

            float target = 0f;
            if (active)
            {
                bool punch = (Time.time - _boostEngageTime) < boostPunchSeconds;
                target = (punch ? boostVolume : boostVolume * Mathf.Clamp01(boostSustainFrac)) * soundVolume;
            }
            // Rising = fast/punchy onset (soundFade); falling (post-punch decay + release) = smoother (boostFadeRate).
            float rate = (boostSource.volume < target) ? soundFade : (boostFadeRate > 0f ? boostFadeRate : 2.5f);
            boostSource.volume = Mathf.MoveTowards(boostSource.volume, target, rate * dt);
            if (!active && boostSource.volume <= 0.001f) { boostSource.Stop(); _boostLoopOn = false; } // fully faded on release -> stop
        }

        // SSX SurfaceType -> board-snow audio group index into glideClips/carveClips. The game's 10 groups collapse onto
        // 6 here ([0 PACK, 1 POWDER, 2 ICE, 3 ROCK, 4 CHUTE, 5 WOOD]); the pairing is the real per-surface snow-audio group
        // mapping [Trailmap: 420-audio-runtime]. Unknown ~ PACK. Ported verbatim from the VRChat board.
        int AudioGroupFor(int t)
        {
            if (t == 1 || t == 7 || t == 8 || t == 15 || t == 16) return 0; // PACK (groomed/packed snow)
            if (t == 0 || t == 3 || t == 4) return 1;                       // POWDER (powder; reset maps here too)
            if (t == 5 || t == 6) return 2;                                 // ICE
            if (t == 2 || t == 9 || t == 10 || t == 11) return 3;           // ROCK / wall / off-track
            if (t == 18 || t == 19) return 4;                               // CHUTE (show-off ramp / metal)
            if (t == 12) return 5;                                          // WOOD (the bridge-deck planks)
            return 0;                                                       // unknown ~ PACK
        }
    }
}
