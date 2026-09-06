using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.Udon.Common;

namespace OpenSlope.VrcPlugin
{

    // Part of RideableBoard (partial): the snow spray + landing-puff particles (local rider only). The carved wake
    // ribbon is its own partial, RideableBoard.Wake.cs. The spray model + design provenance live in docs/vrchat/032. [Trailmap: 380-carve-effects]
    public partial class RideableBoard
    {
        // ---- Board snow particles (carve fan + plume + streaks + powder, local rider only) -------------------
        // A cosmetic layer over the same ride state that drives the sound. All four systems are driven by manual Emit()
        // (no per-frame ParticleSystem-module edits - Udon-safe); the systems are just kept alive (Play, rate 0) between
        // mount and dismount. Snow surfaces spray; rock/metal/ramp run the grit spark gate instead (UpdateGritSparks).
        // Built + wired by RideableBoardSetup (BoardFX node).

        // Bring the four particle systems alive on mount: Play() them (rate 0) so they simulate what we hand-Emit() each frame.
        void StartBoardEffects()
        {
            _surfBurst = 0f; _surfCarry = 0f; _cloudCarry = 0f;
            if (surfaceSpray != null)
            {
                surfaceSpray.Play();
                if (_surfSprayRend == null)
                {
                    _surfSprayRend = surfSprayRenderer != null ? surfSprayRenderer : surfaceSpray.GetComponent<ParticleSystemRenderer>();
                    _surfMatIdx = -1;
                }
            }
            if (cloud != null) cloud.Play();
            _fxOn = surfaceSpray != null || cloud != null;
        }

        // Stop + clear on dismount/eject so a parked or recycled board shows no lingering snow.
        void StopBoardEffects()
        {
            _fxOn = false;
            if (surfaceSpray != null) { surfaceSpray.Stop(); surfaceSpray.Clear(); }
            if (cloud        != null) { cloud.Stop();        cloud.Clear(); }
            if (_gritOn) { _gritOn = false; if (sparks != null) { sparks.Stop(); sparks.Clear(); } } // rails stop it via StopGrindFx
            _surfBurst = 0f; _surfCarry = 0f; _cloudCarry = 0f;
        }

        // Powder surface = powdered snow (3) + slow/deep powder (4). The game's sys5 gate is the literal range SurfaceType in
        // {3,4} [Trailmap: 380-carve-effects]; sys1 also uses it to bypass its carve-lean gate on powder.
        bool IsPowderSurface(int t) { return t == powderSurfaceType || t == 4; }

        // Per-frame board spray: drive the four live-validated systems from ride state. The surface spray throws
        // its sprites with a real velocity (the carve fan); the other three freeze theirs at the spawn point - ACCUMULATION
        // along the path, like the game. All spawn at the deck contact area (the game anchors at the boarder position).
        void UpdateSpray(bool onGround, float dt)
        {
            if (!snowParticles || !_fxOn) return;
            float speed  = _vel.magnitude;
            float lean   = Mathf.Abs(_lean);                                             // raw game-scale lean (max 0.905)
            bool  powder = IsPowderSurface(_pSurf);
            Vector3 n = _contactN.sqrMagnitude > 1e-6f ? _contactN : Vector3.up;
            Vector3 basePt = transform.position - _fwd * sprayBackOffset + n * 0.05f;    // deck contact area (back offset defaults 0)
            Vector3 travel = _vel - n * Vector3.Dot(_vel, n);                            // velocity in the contact plane
            Vector3 travelDir = travel.sqrMagnitude > 1e-4f ? travel.normalized : _fwd;  // the throw / travel direction
            Vector3 side = Vector3.Cross(n, _fwd);                                       // rider-right in the contact plane
            side = side.sqrMagnitude > 1e-6f ? side.normalized : Vector3.right;

            UpdateSurfaceSpray(onGround, speed, lean, basePt, travelDir, side, n, dt);   // the per-surface THROWN fan (rooster-tail + flecks + landing)
            UpdateCloud(onGround, speed, lean, powder, basePt, travelDir, n, dt);        // the soft carve veil + powder cloud
        }

        // 40-slot SURFACE SPRAY ([Trailmap: 380-carve-effects]; ring layout + throw law
        // live-validated against a paused mid-carve capture): the main carve fan, and the only spray system whose
        // sprites carry a real VELOCITY. Emit is a per-tick probability p = motionScalar * emit_rate / 60 (<=1/tick), with
        // motionScalar = speed_u * 0.006 * (1 + 149*lean^2) - lean enters SQUARED, so straight running is a ~1/s trickle and
        // a hard carve saturates at 60/s. Each sprite is thrown up out of the snow - live: |v| = clamp(|lean|*1.1*speed_u,
        // 150,450)*1.5 aimed ~36 deg off the contact normal tilted BACKWARD (plus a small tilt toward the carve edge), with
        // a second downward vector (~0.4*|v|) fanning the spread - and keeps that velocity for life (no gravity, no drag).
        // Sprite/size/lifetime/alpha come from the surface's material record; visible life = table lifetime / the ring's
        // 5x age-rate (live: snow sprays live ~0.6 s, not 3 s). A landing seeds motionScalar to ~70 decaying over ~0.6 s.
        void UpdateSurfaceSpray(bool onGround, float speed, float lean, Vector3 basePt, Vector3 travelDir, Vector3 side, Vector3 n, float dt)
        {
            if (surfaceSpray == null) return;
            float f = dt * 60f;
            if (_surfBurst > 0f) { _surfBurst *= Mathf.Pow(0.9467f, f); if (_surfBurst < 10f) _surfBurst = 0f; } // decay first: the burst window runs even off-ground
            if (!onGround || speed < sprayMinSpeed) { _surfCarry = 0f; return; }

            // Per-surface spray record (the per-surface spray record; lifetimes /5 for the ring's age-rate): emit_rate, visible
            // life (s), size range (m), additive alpha, material index. Surfaces the game authors at emit_rate 0 (slow
            // powder 4, glidy 8, rock/metal/ramp, props -1) throw nothing.
            float rate, life, sMin, sMax, alpha; int mat;
            if      (_pSurf == 1) { rate = 0.075f; life = 0.60f; sMin = 0.136f; sMax = 0.243f; alpha = 0.401f; mat = 0; } // standard snow: blb1 chunks
            else if (_pSurf == 2) { rate = 0.159f; life = 0.86f; sMin = 0.302f; sMax = 0.452f; alpha = 0.407f; mat = 1; } // off-track: swp2 puffs
            else if (_pSurf == 3) { rate = 0.505f; life = 1.57f; sMin = 0.356f; sMax = 0.582f; alpha = 0.231f; mat = 2; } // powder: str3 twinkles
            else if (_pSurf == 5) { rate = 0.200f; life = 0.24f; sMin = 0.030f; sMax = 0.070f; alpha = 0.508f; mat = 3; } // ice: cnf2 shards - tiny specks (live-measured ~0.04-0.05 m on ice; the solid cnf2 fills its quad, so the drawn speck IS the quad - the table's 0.10-0.27 renders far smaller on ice, unlike snow blb1)
            else if (_pSurf == 9 || _pSurf == 13 || _pSurf == 18 || _pSurf == 19)
            { _surfCarry = 0f; UpdateGritSparks(speed, basePt, travelDir, n, dt); return; } // rock/metal/ramp: the grit gate, not snow
            else { _surfCarry = 0f; return; }
            StopGritSparks(); // back on a snow record - end the metal shower (cheap: one bool on the common path)

            float speedU = speed * 100f;                                          // game engine units/s (100 u = 1 m)
            float ms = speedU * 0.006f * (1f + 149f * lean * lean);               // the game's carve motion scalar
            if (IsPowderSurface(_pSurf)) ms = Mathf.Max(ms, speedU * 0.006f * 3f); // powder: fan stays dense gliding straight (live ~19 at lean 0)
            if (_surfBurst > ms) ms = _surfBurst;                                 // landing burst window overrides a weaker gate
            // Standard snow (1): the soft cloud veil is enough - skip the steady kicked-up blb1 fan (a smaller/higher/sparser
            // spray we don't want on groomed) but KEEP the touchdown burst dust. Ice/off-track/powder still fan normally.
            if (_pSurf == 1 && _surfBurst < 10f) { _surfCarry = 0f; return; }
            float scale = surfEmitScale > 0.001f ? surfEmitScale : 1f;            // 0-default guard (un-rebuilt board)
            float expected = Mathf.Min(1f, ms * rate / 60f) * scale * f;          // spawns this frame (<=1 per 60 Hz tick)
            _surfCarry += expected;
            int emit = (int)_surfCarry;
            if (emit <= 0) return;
            _surfCarry -= emit;
            if (emit > 4) emit = 4;                                               // particle-budget guard on a frame hitch

            SetSurfMaterial(mat);
            float aScale = surfAlphaScale > 0.001f ? surfAlphaScale : 1f;
            float bright = sprayBrightness > 0.001f ? sprayBrightness : 1f;       // global additive-brightness (scales emit RGB, can exceed 1)
            float backT  = surfBackTilt  > 0.001f ? surfBackTilt  : 0.72f;
            // Throw: clamp(|lean|*1.1*speed, 1.5..4.5) * 1.5 m/s along (normal - backTilt*travel + sideTilt*carve-edge).
            float throwMag = Mathf.Clamp(lean * 1.1f * speed, 1.5f, 4.5f) * 1.5f;
            Vector3 edge = side * (Mathf.Clamp(_lean / 0.905f, -1f, 1f) * surfSideTilt); // toward the leaned/digging edge
            Vector3 throwDir = (n - travelDir * backT + edge).normalized;
            for (int i = 0; i < emit; i++)
            {
                surfaceSpray.transform.position = basePt + _fwd * 0.3f + side * ((Random.value - 0.5f) * 0.3f); // under the plowing nose
                _surfEmit.velocity = throwDir * (throwMag * Random.Range(0.7f, 1.05f)) - n * (throwMag * 0.4f * Random.value);
                _surfEmit.startSize = Random.Range(sMin, sMax);
                _surfEmit.startLifetime = life * Random.Range(0.8f, 1.2f);        // the game's x[0.8,1.2) lifetime jitter
                _surfEmit.startColor = new Color(bright, bright, bright, alpha * aScale);
                surfaceSpray.Emit(_surfEmit, 1);
            }
        }

        // HARD-SURFACE GRIT ([Trailmap: 380-carve-effects]): rock/metal/ramp {9,13,18,19} zero the snow-spray gate and
        // run a second per-tick emit gate instead - the spark shower riding the megaplex pipes, gutters and start ramp.
        // Retail fires one short-lived ring particle every tick while ridden; this drives the grind-spark system (the
        // same warm additive flecks the rail seam throws) at a rate that holds a similar live count against its
        // 0.15-0.45 s module lifetime. Sparks kick up off the contact and back along the travel, world-sim, so they
        // trail the board exactly like the rail's.
        void UpdateGritSparks(float speed, Vector3 basePt, Vector3 travelDir, Vector3 n, float dt)
        {
            if (sparks == null) return;
            if (!_gritOn) { _gritOn = true; sparks.Play(); } // Emit-driven shell; rails Play/Stop it on their own flag
            Vector3 dir = (n - travelDir).normalized;        // up off the surface and back along the travel
            if (dir.sqrMagnitude < 1e-6f) dir = n;
            sparks.transform.position = basePt;
            sparks.transform.rotation = Quaternion.LookRotation(dir, n);
            float span = Mathf.Max(0.1f, glideFullSpeed - sprayMinSpeed);
            float s01 = Mathf.Clamp01((speed - sprayMinSpeed) / span);
            _sparkAccum += 26f * s01 * dt; // denser than the rail's 12/s - retail's grit gate fires every tick
            int cnt = (int)_sparkAccum;
            if (cnt > 0) { _sparkAccum -= cnt; sparks.Emit(cnt); }
        }

        // Crossed back onto a snow record: end the shower softly - Stop() without Clear lets the last flecks age out
        // over their ~0.3 s instead of vanishing on the seam. One bool test on the common snow path.
        void StopGritSparks()
        {
            if (!_gritOn) return;
            _gritOn = false;
            if (sparks != null) sparks.Stop();
        }

        // Bind the surface class's spray material (snow dot / off-track / powder clod / ice streak). Cheap: only touches the
        // renderer when the class CHANGES (a few times a run); live particles adopt the new look with it, like the game's
        // per-surface sprite swap.
        void SetSurfMaterial(int idx)
        {
            if (idx == _surfMatIdx || _surfSprayRend == null || surfSprayMats == null || idx >= surfSprayMats.Length) return;
            Material m = surfSprayMats[idx];
            if (m == null) return;
            _surfSprayRend.sharedMaterial = m;
            _surfMatIdx = idx;
        }

        // CLOUD [Trailmap: 380-carve-effects]: one soft additive system represents the sys1/sys2
        // carve VEIL on groomed/off-track (NOT ice - sys2's veil gate is ~0 there) while carving, AND the sys5 powder cloud on
        // powder. All are "soft frozen puffs
        // laid along the path," so one Billboard system with a box-scatter shape covers them with a SINGLE batched Emit (no
        // per-particle loop). POWDER mode: count ~ speed (lean-independent), big ~0.45 m puffs that ANCHOR to the board (they
        // carry its velocity less a small backward creep). VEIL mode: frozen puffs whose brightness scales with carve hardness
        // (peak |lean|*cloudVeilAlpha), accumulating along the path. The rarely-seen sys4 slip streaks are intentionally dropped.
        void UpdateCloud(bool onGround, float speed, float lean, bool powder, Vector3 basePt, Vector3 travelDir, Vector3 n, float dt)
        {
            if (cloud == null || !onGround || speed < sprayMinSpeed) { _cloudCarry = 0f; return; }
            int cap = cloudMaxPerFrame > 0 ? cloudMaxPerFrame : 4;
            float perFrame, size, alpha; Vector3 vel;
            if (powder)
            {
                float perPuff = powderSpeedPerPuff > 1f ? powderSpeedPerPuff : 12.7f;
                perFrame = Mathf.Clamp(speed / perPuff, 1f, cap) * f60(dt);      // sys5: count ~ speed, lean-independent
                size  = cloudPowderSize > 0.01f ? cloudPowderSize : 0.45f;       // live-measured ~0.45 m drawn on powder
                alpha = powderPuffAlpha;
                vel   = _vel - travelDir * powderDrift;                          // ANCHORS to the board (board vel less a creep)
            }
            else if ((IsSnowSurface(_pSurf) || _pSurf == 2) && lean > cloudVeilGate) // NOT ice: sys2's veil gate is ~0 on ice, so ice throws only the fan's cnf2 specks
            {
                perFrame = (cloudVeilRate > 0.01f ? cloudVeilRate : 2f) * f60(dt); // sys1/sys2 veil while carving on snow/off-track
                size  = cloudVeilSize > 0.01f ? cloudVeilSize : 1.2f;
                alpha = lean * cloudVeilAlpha;                                   // peak |lean|*0.2, like the game
                vel   = Vector3.zero;                                            // frozen: accumulate along the path
            }
            else { _cloudCarry = 0f; return; }

            _cloudCarry += perFrame;
            int emit = (int)_cloudCarry;
            if (emit <= 0) return;
            _cloudCarry -= emit;
            if (emit > cap) emit = cap;                                          // particle-budget guard on a frame hitch
            cloud.transform.position = basePt;                                   // the box shape scatters the puffs around here
            float bright = sprayBrightness > 0.001f ? sprayBrightness : 1f;      // global additive-brightness (scales emit RGB, can exceed 1)
            _cloudEmit.velocity  = vel;
            _cloudEmit.startSize  = size;
            _cloudEmit.startColor = new Color(bright, bright, bright, alpha);
            cloud.Emit(_cloudEmit, emit);                                        // ONE extern; shape scatters, size curve billows over life
        }

        // Ticks-per-frame factor (dt*60): the game's counts are "per 60 Hz tick", so scale by this to hold the same
        // per-second rate at any frame rate.
        float f60(float dt) { return dt * 60f; }

        // Snow-ish SurfaceType (groomed + powder), shared by the spray + the wake ribbon + landing puff. This follows the
        // snow-feedback set, NOT the spray's emit_rate gate (e.g. slow powder 4 leaves a trail but throws no spray).
        bool IsSnowSurface(int t) { return t == 1 || t == 3 || t == 4 || t == 8 || t == 16; }

        // ---- Remote rider FX: wake + spray for a board ridden by ANOTHER player (docs/vrchat/042) -------------------------
        // A remote copy normally just follows the owner's synced pose (NetFollow) and shows NO trail/spray. This drives the
        // SAME wake + spray systems from data the remote already has - the RENDERED motion (transform delta), the synced
        // deck bank (_netBank -> a carve-lean proxy via the shared bank maximum), and a LOCAL ground probe for the surface - so a rider
        // you watch carves a groove and throws powder like your own board, with no synced FX fields and no new objects
        // (every board is built with its Wake child + Spray system; on a remote they just sat idle).
        //
        // PERFORMANCE is bounded by DISTANCE LOD, so cost scales with the riders you can SEE near you, not the instance
        // size: beyond remoteFxRange the FX stop + clear (returning the particle budget); the expensive wake MESH rebuild
        // only runs inside the tighter remoteWakeRange; the ground probe is throttled (remoteProbeInterval). Parked/stopped
        // boards (speed ~0) early-out before the probe, so only boards actually being RIDDEN near you cost anything. We feed
        // the owner-physics fields (_vel/_lean/_pSurf/...) the shared FX code reads - they're unused on a remote (physics
        // doesn't run) - so there is zero duplicated FX logic. Called from Update's remote branch, AFTER NetFollow poses us.
        void RemoteFxUpdate()
        {
            bool wantWake  = trailEnabled  && wakeMeshFilter != null;
            bool wantSpray = snowParticles && (surfaceSpray != null || cloud != null);
            if (!wantWake && !wantSpray) return;

            // Tuning Board (PERF section) opt-out: a viewer who unchecked "Other riders' FX" sees no wake/spray on OTHER
            // players' boards (this REMOTE path only - your own board's FX, driven elsewhere, are never gated). Null
            // diagnosticsBoard => FX on, so an un-rewired board behaves as before. Clear any live ribbon/spray when off.
            if (diagnosticsBoard != null && !diagnosticsBoard.remoteRiderFx)
            {
                if (_remoteFxActive) StopRemoteFx();
                return;
            }

            VRCPlayerApi lp = Networking.LocalPlayer;
            if (lp == null) return;
            // Defensive defaults: a newly added field reads 0 on an un-repushed board, so
            // floor each range/interval to a sane value -> remote FX works on the existing boards without a re-push.
            float fxRange   = remoteFxRange       > 0.01f  ? remoteFxRange       : 45f;
            float wakeRange = remoteWakeRange      > 0.01f ? remoteWakeRange     : 45f;
            float probeI    = remoteProbeInterval > 0.001f ? remoteProbeInterval : 0.1f;

            Vector3 pos = transform.position;
            float d2 = (pos - lp.GetPosition()).sqrMagnitude;
            if (d2 > fxRange * fxRange)
            {
                if (_remoteFxActive) StopRemoteFx(); // left range -> stop + clear, free the particle budget
                return;
            }
            if (!_remoteFxActive) StartRemoteFx();

            float dt = Time.deltaTime;
            if (dt <= 1e-5f) return;

            // Velocity from the RENDERED motion, so the wake trails the visible (extrapolated) board, not the stale sample.
            Vector3 rvel = _fxHavePos ? (pos - _fxLastPos) / dt : Vector3.zero;
            _fxLastPos = pos; _fxHavePos = true;
            float speed = rvel.magnitude;

            // Idle remote board (parked at a gate / stopped) with no ribbon left -> nothing to draw, skip the probe + FX.
            if (speed < trailMinSpeed && speed < sprayMinSpeed && _wkN == 0) return;

            // Throttle the ground probe - surface type/normal change slowly vs the frame rate.
            _fxProbeTimer -= dt;
            if (!_fxProbedOnce || _fxProbeTimer <= 0f) { _fxProbeTimer = probeI; _fxProbedOnce = true; Probe(pos); }

            // Feed the owner-physics fields the shared FX code reads (free to use on a remote - physics never runs here).
            _vel = rvel;
            _contactN = _pFound && _pNormal.sqrMagnitude > 1e-6f ? _pNormal : Vector3.up;
            // Heading from the DECK pivot, not the root: in VR the synced root is pinned LEVEL, so transform.forward loses
            // the carve heading - the deck (root * _netDeckLocal, applied by ApplyRemoteDeckPose) carries the real facing,
            // which the wake projects for its width. Fall back to the root forward on an old board with no Heading pivot.
            Vector3 fwd = _pivot != null ? _pivot.forward : transform.forward;
            _fwd = fwd.sqrMagnitude > 1e-6f ? fwd.normalized : Vector3.forward;
            _lean = Mathf.Clamp(_netBank / Mathf.Max(1f, RIDE_BANK_MAX), -1f, 1f); // synced deck roll -> carve-lean proxy
            bool onGround = _pFound && (pos.y - _pGroundY) <= wakeGroundReach;

            if (wantWake && d2 <= wakeRange * wakeRange) UpdateWakeTrail(dt); // full ribbon for CLOSE boards (the costly path)
            else if (_wkN > 0) WakeAgeOnly(dt);                              // out of wake range -> let any ribbon age out
            if (wantSpray) UpdateSpray(onGround, dt);
        }

        // Remote: entered FX range - bring the systems alive (idempotent). Mirrors the owner's mount-time StartBoardEffects.
        void StartRemoteFx()
        {
            _remoteFxActive = true;
            _fxHavePos = false; _fxProbedOnce = false; _fxProbeTimer = 0f;
            if (!_wakeReady) InitWakeMesh();      // Start already built it; guard a board that somehow missed it
            ClearWake(); _haveLastWake = false;   // fresh ribbon - don't stitch onto a stale one from a previous pass
            StartBoardEffects();                  // Play the spray system (rate 0 until we Emit); sets _fxOn
        }

        // Remote: left FX range (or we took ownership) - stop + clear so a distant/owned board shows nothing and frees budget.
        void StopRemoteFx()
        {
            _remoteFxActive = false;
            StopBoardEffects();                   // Stop + Clear the spray (_fxOn = false)
            ClearWake(); _haveLastWake = false; _wkN = 0;
        }
    }
}
