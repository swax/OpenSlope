using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.Udon.Common;

namespace OpenSlope.VrcPlugin
{

    // Part of RideableBoard (partial): the board glide/carve sound loops (local rider only). See docs/015-audio-runtime.md.
    public partial class RideableBoard
    {
        // ---- Board sound (glide + carve + focused-rider big-air wind, local rider only) -------------------
        // Two continuously-running layers - GLIDE (the slide) and CARVE (the edge bite) - whose clip is chosen by the
        // surface's audio group and whose volume/pitch ride the feel signals (speed, slip, lean). We port the
        // signal->loudness shape, not the exact SNOW.INF volume programs, so the inspector knobs are the tuning surface.
        // MAIN/032 is the exception in air: retail starts it only when the state-entry landing predictor says
        // this flight will exceed 1.5 s. It is a 2D rider voice, not a map/weather bed.

        // Spin up the loop sources on mount. They run silently until we're moving; volume/clip are driven per frame.
        void StartBoardAudio()
        {
            _audioGroup = -1;
            if (glideSource == null && carveSource == null && bigAirWindSource == null) return;
            LoadAudioGroup(0); // default to PACK until the first Probe picks the real surface
            if (glideSource != null) { glideSource.loop = true; glideSource.volume = 0f; glideSource.Play(); }
            if (carveSource != null) { carveSource.loop = true; carveSource.volume = 0f; carveSource.Play(); }
            if (bigAirWindSource != null) { bigAirWindSource.Stop(); bigAirWindSource.volume = 0f; }
            _audioWasGrounded = true; _predictedAirTime = 0f; _bigAirWindLoopOn = false;
            _audioOn = true;
        }

        // Silence the loops on dismount/eject so a parked or recycled board makes no sound.
        void StopBoardAudio()
        {
            _audioOn = false;
            if (glideSource != null) glideSource.Stop();
            if (carveSource != null) carveSource.Stop();
            if (boostSource != null) boostSource.Stop();
            if (bigAirWindSource != null) bigAirWindSource.Stop();
            _boostLoopOn = false; _boostWasActive = false;
            _bigAirWindLoopOn = false; _predictedAirTime = 0f; _audioWasGrounded = true;
        }

        // Swap the loop clips to a surface audio group if it changed (a no-op while the group holds). Group indices match
        // glideClips/carveClips: 0 PACK, 1 POWDER, 2 ICE, 3 ROCK, 4 CHUTE, 5 WOOD, 6 METAL, 7 GLASS, 8 LOOSE - see
        // AudioGroupFor. A board built before a group existed carries a shorter clip array; the range guard below keeps
        // its last clips on the new groups until RideableBoardSetup rebuilds it.
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

        // Per-frame loudness/pitch for the two loop layers. BedFrame is OpenSlope's project-authored response
        // over the live ride signals; both layers fade to silence in the air. MoveTowards eases transitions.
        void UpdateBoardAudio(bool onGround, float dt)
        {
            if (!_audioOn) return;
            float speed = _vel.magnitude;
            if (onGround) LoadAudioGroup(AudioGroupFor(_pAudioSurf)); // the contact's REAL type (a prop proxy's name-suffix type, e.g. the wood bridge), not the feel's propRideSurfaceType

            float span = Mathf.Max(0.1f, glideFullSpeed - glideMinSpeed);
            float speed01 = Mathf.Clamp01((speed - glideMinSpeed) / span);

            // OpenSlope's authored curve hands the bed from glide to carve as skid/lean rise. `open` keeps a
            // parked-but-grounded board silent while the curve shapes the approach through the speed band.
            BedFrame(_audioGroup, _slip * 100f, Mathf.Abs(_lean) * 127f, speed01);
            float open = Mathf.Clamp01(speed01 * 6f);

            float glideTarget = onGround ? glideVolume * _bedGlideVol * open * soundVolume : 0f;
            if (glideSource != null)
            {
                glideSource.volume = Mathf.MoveTowards(glideSource.volume, glideTarget, soundFade * dt);
                glideSource.pitch = 1f + _bedGlideBend * BED_BEND_SPAN;
            }

            float carveTarget = onGround ? carveVolume * _bedCarveVol * open * soundVolume : 0f;
            if (carveSource != null)
            {
                carveSource.volume = Mathf.MoveTowards(carveSource.volume, carveTarget, soundFade * dt);
                carveSource.pitch = 1f + _bedCarveBend * BED_BEND_SPAN;
            }

            UpdateBigAirWind(onGround, dt);
        }

        // Retail's Music_LevelReconcile path owns one global/focused rider voice: motion state 1 plus predicted
        // total flight >1.5 s starts MAIN slot 32, and landing destroys it. This preserves that ownership and gate;
        // the exact retail level curve is still open, so the recovered loop uses the board's ordinary fade rate.
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

        // The landing predictor is evaluated once on the ground->air edge. It uses the ride's own two-stage
        // gravity and horizontal drag, then casts descending chords against terrain/rideable props. Returning zero
        // means no landing was found inside the bounded eight-second horizon, so no big-air voice is guessed.
        float PredictAirDuration(Vector3 origin, Vector3 velocity)
        {
            const float step = 0.1f;
            const float horizon = 8f;
            float rise = velocity.y > 0f ? velocity.y / RIDE_AIR_GRAVITY_RISING : 0f;
            float riseHeight = velocity.y > 0f
                ? velocity.y * rise - 0.5f * RIDE_AIR_GRAVITY_RISING * rise * rise : 0f;
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
            float horizontal = RIDE_AIR_HORIZONTAL_DRAG > 0.000001f
                ? (1f - Mathf.Exp(-RIDE_AIR_HORIZONTAL_DRAG * t)) / RIDE_AIR_HORIZONTAL_DRAG : t;
            Vector3 point = origin + new Vector3(velocity.x * horizontal, 0f, velocity.z * horizontal);
            point.y += t <= rise
                ? velocity.y * t - 0.5f * RIDE_AIR_GRAVITY_RISING * t * t
                : riseHeight - 0.5f * RIDE_AIR_GRAVITY_FALLING * (t - rise) * (t - rise);
            return point;
        }

        // ---- OpenSlope board-bed response ---------------------------------------------------------------
        // Retail supplies the persistent-node, bank-row and signal interface. This response is an original
        // OpenSlope curve rather than a transcription of a SNOW.INF instruction sequence. Group order matches
        // glideClips: [0 PACK, 1 POWDER, 2 ICE, 3 ROCK, 4 CHUTE, 5 WOOD, 6 METAL, 7 GLASS, 8 LOOSE].
        private float _bedGlideVol, _bedGlideBend, _bedCarveVol, _bedCarveBend; // 0..1, written by BedFrame
        const float BED_BEND_SPAN = 0.5f;

        float Smooth01(float value)
        {
            float v = Mathf.Clamp01(value);
            return v * v * (3f - 2f * v);
        }

        void BedFrame(int group, float slip, float lean, float speed01)
        {
            if (group < 0 || group > 8) group = 0;
            float motion = Smooth01(speed01);
            float skid = Mathf.Clamp01(slip / 300f);
            float tilt = Mathf.Clamp01(lean / 100f);
            float handoff = Smooth01(Mathf.Max(skid, tilt));
            float glideVol, carveVol;
            if (group == 0 || group == 2 || group == 3 || group == 4 || group == 6) // firm families
            {
                glideVol = motion * (1f - handoff);
                carveVol = motion * handoff;
            }
            else if (group == 1 || group == 8)                                      // powder / loose
            {
                glideVol = motion * (0.35f + 0.65f * (1f - handoff));
                carveVol = motion * handoff * 0.7f;
            }
            else                                                                    // wood / glass
            {
                float texture = 0.3f + 0.7f * skid;
                glideVol = motion * texture * (1f - 0.5f * handoff);
                carveVol = motion * texture * (0.15f + 0.85f * handoff);
            }
            _bedGlideVol = Mathf.Clamp01(glideVol);
            _bedGlideBend = Mathf.Clamp01(0.7f * skid + 0.1f * tilt);
            _bedCarveVol = Mathf.Clamp01(carveVol);
            _bedCarveBend = Mathf.Clamp01(0.35f * skid + 0.2f * tilt);
        }

        // ---- Boost sound (the SSX held-boost cue, shaped) -------------------------------------------------
        // The game fires a one-shot on the frame boost engages - a meter-tier slot (120/121/122) into the gem/pad sound
        // ring - for the local human rider only, and only from the ground/antic paths (so air/rail boost is silent).
        // The clips themselves are FLAT ~constant 1.12 s roars (measured). So a literal one-shot would play steady then
        // cut - but the real game's boost sound clearly FADES (quick on release, and even while held down to a low
        // sustain), which a flat clip can only do via external voice volume control. That volume shaping isn't pinned
        // down, so we RECONSTRUCT the heard envelope here. [Trailmap: 360-speed-and-boost "The boost/Tricky meter"],
        // [Trailmap: 420-audio-runtime].
        //
        // Envelope on a dedicated LOOPING boostSource (the flat clip loops cleanly): on the engage edge, PUNCH to
        // boostVolume for boostPunchSeconds, then decay to a low SUSTAIN (boostVolume*boostSustainFrac) while held, then fast
        // FADE to 0 + Stop on release (or when the thrust stops / the meter runs out). Slew speed reuses soundFade.
        // boostMeter01 / the live run meter pick the tier (see BoostMeterClip). The cue runs wherever the boost is
        // actually THRUSTING: on the ground, and in the air while the aimed air boost fires (_airBoostActive, an
        // embellishment past the engine's ground-only cue - a player-commanded thrust should be heard). Rails stay
        // silent (a grind frame never sets the flag).
        void UpdateBoostAudio(bool onGround, float dt)
        {
            if (boostSource == null) return;
            // held boost thrusting (ground, or the airborne head-thrust), with meter charge during a scored run
            // (the game gates the sfx on meter>0).
            bool active = holdBoostEnabled && _boostHeld && (onGround || _airBoostActive) && BoostMeterHasCharge();
            if (active && !_boostWasActive) _boostEngageTime = Time.time; // (re)arm the punch on every fresh engage
            _boostWasActive = active;

            if (active && !_boostLoopOn)
            {
                AudioClip clip = BoostMeterClip();
                if (clip != null)
                {
                    boostSource.clip = clip; boostSource.loop = true; boostSource.volume = 0f; boostSource.Play();
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

        // The game's meter-tier pick: >0.666 -> [0] (slot 120), >0.334 -> [1] (121), else [2] (122). During a scored run we
        // use the LIVE boost meter; free-riding (no meter) falls back to boostMeter01 (1.0 = the pinned-full clip 120).
        AudioClip BoostMeterClip()
        {
            if (boostClips == null || boostClips.Length == 0) return null;
            float m = BoostMeterActive() ? _boostMeter : boostMeter01;
            int i = m > 0.666f ? 0 : (m > 0.334f ? 1 : 2);
            if (i >= boostClips.Length) i = boostClips.Length - 1; // fewer clips wired than tiers -> fall to the last one
            return boostClips[i];
        }

        // SSX SurfaceType -> board-snow audio group index into glideClips/carveClips. 9 of the game's 10 groups are
        // wired ([0 PACK, 1 POWDER, 2 ICE, 3 ROCK, 4 CHUTE, 5 WOOD, 6 METAL, 7 GLASS, 8 LOOSE]; RAIL is the grind
        // path's own clip, never returned for terrain contact); the pairing is the real per-surface snow-audio group
        // mapping [Trailmap: 420-audio-runtime]. METAL matters most: the megaplex start ramp and gutters (13) play
        // the rail-scrape clips - retail's zboard METAL row IS the rail sound. Unknown ~ PACK.
        int AudioGroupFor(int t)
        {
            if (t == 1 || t == 7 || t == 8 || t == 15 || t == 16) return 0; // PACK (groomed/packed snow)
            if (t == 0 || t == 3 || t == 4) return 1;                       // POWDER (powder; reset maps here too)
            if (t == 5 || t == 6) return 2;                                 // ICE
            if (t == 9 || t == 10 || t == 11) return 3;                     // ROCK / wall / ice-crunch
            if (t == 18 || t == 19) return 4;                               // CHUTE (show-off ramp / metal)
            if (t == 12) return 5;                                          // WOOD (the bridge-deck planks; _T12 prop proxies)
            if (t == 13) return 6;                                          // METAL (off-track metal - the rail-scrape clips)
            if (t == 14) return 7;                                          // GLASS (speed / grinding)
            if (t == 2) return 8;                                           // LOOSE (off-track snow)
            return 0;                                                       // unknown ~ PACK
        }
    }
}
