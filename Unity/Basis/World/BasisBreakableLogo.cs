using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Basis runtime behaviour for SSX's breakable logos / signs / balloons (docs/028, docs/036) - the Basis analogue of the
    // VRChat BreakableLogoU. In the original you ride THROUGH a lit logo screen (or a fence / hole-cover / balloon) and
    // it shatters with a sound; the "break" is a scripted MESH-SWAP, not a physics shatter: the intact renderer set is
    // hidden and a pre-modelled broken twin (or a cluster of connected-component pieces) is revealed - the pieces thrown by
    // the mode-3 Sub20 mesh-throw - plus the break sound and, as an embellishment the original omits (the source level
    // authors no collision-particle emitter, docs/unity/014), the game's own shard/star debris sprites.
    //
    // The importer (PropBuilder.BuildBreakableLogos) does all the platform-neutral work - pulls the intact / broken / piece
    // meshes out of the merged Props mesh into toggle-able GameObjects, builds the pass-through trigger box + debris + break
    // sound, and stamps a BreakableLogoMarker naming them + the throw params. The Basis wiring pass (BasisWiring)
    // realizes this behaviour and copies the marker's fields across by name; nothing importer-side is Basis-specific.
    //
    // Detection (Basis-specific): Basis has no OnPlayerTriggerEnter, a physics trigger misses a seated board rider (the seat
    // driver disables the player's CharacterController), and the board's own obstacle sweep ignores triggers - so, like the
    // firework / gem / physics-prop volumes, this POLLS the local player against the importer's pass-through BoxCollider each
    // frame (BasisLocalPlayerProbe.InsideBox) and breaks on the rising edge (outside -> inside). That catches a walking player
    // and a board rider identically. While RIDING, the BOARD - not the seated rider's root, which the seat driver can fit
    // off the panel - is what plows through the screen, so we also test the board's position (PointInBox) and prefer the
    // board's own velocity for the mesh-throw direction; same fix as BasisPhysicsProp.
    //
    // FRAGILE SURFACES (crackStrength > 0, docs/036 - the megaplex glass panes) invert the crossing's meaning. Every other
    // breakable here breaks on the contact that reaches it; a pane is WORN DOWN. The containment poll above is already the
    // test the game makes, so instead of firing on the rising edge, every frame the rider is inside drains an impact pool
    // (gated at 30 frames). What a contact costs depends on how the rider meets the surface: gliding along the glass is
    // cheap and takes about three seconds to get through, dropping onto it spends the whole pool at once. And the break has
    // a fourth job there - the pane you see is authored pass-through, so it also disables the invisible solid twin that was
    // holding the rider up (supportColliders), which is what drops them through the hole.
    //
    // Shared across the instance (BasisNetEvent, like the gems / fireworks): the break is a transient one-shot, so the
    // client that crosses the volume shatters INSTANTLY (local, snappy) and Broadcast()s so every other player sees the same
    // screen shatter + respawn. Each client runs its OWN respawn timer, so the sign re-arms ~together (all break within
    // network latency). Break() self-guards on _broken, so the breaker's own copy already broke and a remote shatters with
    // the full effect; nothing is destroyed (we toggle renderers), so it re-arms and breaks again. Offline the broadcast
    // no-ops and it's a purely local break. The screens are ride-THROUGH, so a late joiner's brief divergence (intact vs a
    // mid-respawn break) is purely visual, never a collision contradiction - not worth carrying as synced latched state.
    public class BasisBreakableLogo : BasisNetEvent
    {
        [Tooltip("Renderers HIDDEN on break - the intact lit logo screen + its scanline overlay. Built + wired by the importer.")]
        public Renderer[] intactRenderers;

        [Tooltip("Renderers SHOWN on break - the pre-modelled broken/shattered twin (shipped invisible). Empty for logos " +
                 "(the screen just vanishes + sprays shards); the fence / hole-cover _Junk twin IS the visible break.")]
        public Renderer[] brokenRenderers;

        [Tooltip("One-shot source holding the break clip (CollisonSound 63 -> LCD/glass break), played on break. Built + " +
                 "wired by the importer; null = silent (the screen still swaps + sprays debris).")]
        public AudioSource breakSound;

        [Range(0f, 1f)] public float breakVolume = 1f;

        [Tooltip("Optional shard/star debris burst played at the screen on break. Built + wired by the importer; null = " +
                 "swap + sound only. An embellishment the original omits.")]
        public ParticleSystem debris;

        [Header("Piece throw (mesh-throw Sub20, docs/036)")]
        [Tooltip("The broken model's individual pieces (boards/planks), pivoted at their own centroids; revealed and THROWN " +
                 "on the break - the mode-3 type0 Sub20 mesh-throw. Empty = plain swap (LCD logos). Wired by the importer.")]
        public Transform[] pieceTransforms;

        [Tooltip("Renderers of the pieces (parallel to pieceTransforms); hidden until the break.")]
        public Renderer[] pieceRenderers;

        [Tooltip("Per-axis throw velocity scale in SSX units (cm/s, mesh axes) - the Sub20 U6/U7/U8 (e.g. 500/500/300).")]
        public Vector3 throwVelScale = new Vector3(500f, 500f, 300f);

        [Tooltip("Throw direction scale - the Sub20 U9 (e.g. 0.8).")]
        public float throwDirScale = 0.8f;

        [Tooltip("Authored throw direction in mesh axes - the Sub20 U3/U4/U5. ZERO = the game's rule: throw along the " +
                 "direction you actually hit it from (the mesh-throw uses the actual collision direction when unset).")]
        public Vector3 throwDir = Vector3.zero;

        [Tooltip("Throw animation length in seconds - the Sub20 U2. Pieces hide at the end.")]
        public float throwDuration = 2f;

        [Tooltip("Gravity applied to flying pieces, SSX units (cm/s^2) along mesh -Z.")]
        public float throwGravity = 981f;

        [Tooltip("Re-arm the screen after it breaks (the persistent free-roam world stays whole, and you can break it " +
                 "again). Off = it stays broken until the world reloads, the classic single-run behaviour.")]
        public bool respawn = true;

        [Tooltip("Seconds after a break before the screen restores (respawn only).")]
        public float respawnDelay = 12f;

        [Header("Grow-back on respawn (star-burst breakables)")]
        [Tooltip("On respawn, GROW the restored prop back from nothing (like the trick gems) instead of popping it in " +
                 "instantly. The balloon animals use this; LCD logos / fences keep the instant restore. Wired by the importer.")]
        public bool growBackOnRestore = false;

        [Tooltip("Seconds the grow-back eases from nothing to full size (growBackOnRestore only).")]
        public float growBackDuration = 1f;

        [Header("Roll-away break (docs/036 - the globe sign)")]
        [Tooltip("Seconds between the hit and the hide/reveal/throw swap - the SSF chain's authored Wait. While it runs, " +
                 "rollAnim plays the intact's own model clip (the globe rolling down the street). 0 = instant break.")]
        public float breakDelay = 0f;

        [Tooltip("The break-owned animated prop playing the intact's roll clip (Trigger() at the hit, ResetToStart() on " +
                 "the respawn). Its segment renderers are part of intactRenderers. Resolved by BasisWiring; null = no roll.")]
        public BasisAnimatedProp rollAnim;

        [Tooltip("One-shot at the LANDING (the chain's raw-slot crash), played at the delayed swap. Wired by the importer.")]
        public AudioSource endSound;

        [Tooltip("Minimum board speed (m/s) to break while riding. 0 = any contact breaks it (you ride through it); raise " +
                 "to require some pace. The walking player always breaks on contact. Ignored by a fragile surface, whose " +
                 "gate is its impact pool instead.")]
        public float minRideSpeed = 0f;

        [Header("Fragile surface (docs/036 - the megaplex glass panes)")]
        [Tooltip("Impact-budget pool (the SSF Cracked node's authored strength; retail's panes ship 5). Above 0 this prop " +
                 "is WORN DOWN rather than smashed: contact cracks it, and only the contact that empties the pool runs the " +
                 "break. 0 = every other breakable, which breaks on the first crossing. Wired by the importer.")]
        public float crackStrength = 0f;

        [Tooltip("Seconds a crack lasts before the surface HEALS, taking the accumulated damage with it. <= 0 never " +
                 "expires, which is what every retail pane authors: once cracked, cracked until it gives way.")]
        public float crackLifetime = -1f;

        [Tooltip("One-shot for the glancing hit that first cracks the glass (the collision chain's raw course-bank slot " +
                 "65) - a different event from breakSound's smash. Wired by the importer; null = a silent crack.")]
        public AudioSource crackSound;

        [Tooltip("The pane's renderer. Its material carries a two-frame plain/cracked state list that the game's own crack " +
                 "handler selects frame 1 of - the effect graph deliberately has no flip node for it.")]
        public Renderer crackRenderer;

        [Tooltip("Material-slot (submesh) index on that renderer.")]
        public int crackSlot;

        [Tooltip("The material's ordered state frames: [0] plain, [1] cracked. Not an animation - the crack selects.")]
        public Texture2D[] crackFrames;

        [Tooltip("The pane's plane normal in level-local space, measured from its own geometry by the importer. The " +
                 "carried-vs-impact test is closing speed ALONG THIS AXIS, which is what separates a rider gliding along " +
                 "a sloped pane (near zero) from one dropping onto it.")]
        public Vector3 crackNormal = Vector3.up;

        [Tooltip("Colliders DISABLED by the break and restored by the respawn - the invisible solid twins that hold the " +
                 "rider up while the glass is intact. Wired by the importer's collision pass.")]
        public Collider[] supportColliders;

        [Tooltip("Seconds between accepted contacts. The game gates the drain at 30 frames, measured as a flat 0.5s on a " +
                 "carried ride, so a rider sitting on the glass spends two charges a second rather than one per frame.")]
        public float crackGate = 0.5f;

        [Tooltip("What one CARRIED contact costs - the rider supported by the surface, riding along it. Measured on PS2 " +
                 "at 0.687-2.5, so an authored 5 drains in about three seconds of being ridden.")]
        public float crackCarriedCost = 1f;

        [Tooltip("What one IMPACT costs - crossing into the pane, hitting it as a wall, or dropping onto it. Measured at " +
                 "70-96, tightly clustered near 87, so an authored 5 is gone in one hit.")]
        public float crackImpactCost = 87f;

        [Tooltip("Closing speed along the pane's normal (m/s) at or above which a contact counts as an impact rather than " +
                 "a ride. Chosen rather than measured - the PS2 arithmetic reduces two contact vectors we do not rebuild.")]
        public float crackImpactSpeed = 8f;

        BoxCollider _box;                   // the importer's pass-through trigger box, polled for the crossing
        // Fragile-surface state: the remaining impact budget, the 30-frame drain gate, and the crack's own countdown.
        float _pool;
        bool _cracked;
        float _crackGateUntil;
        float _crackLife;
        MaterialPropertyBlock _crackBlock;
        bool _broken;
        bool _swapped;                      // roll-aways: the delayed hide/reveal/throw has run for this break cycle
        float _swapDue;                     // Time.time the current cycle's swap is due
        bool _wasInside;                    // rising-edge latch for the crossing poll
        float _breakTime;                   // Time.time of the break, for the respawn timer
        Vector3 _impactWorld;               // hitter's world velocity at the break (the mesh-throw collision direction)

        // Piece-throw state (allocated once on the first break).
        bool _throwing;
        float _throwT;
        Vector3[] _pieceVel;                // mesh-space cm/s
        Vector3[] _pieceHome;               // initial localPosition (the piece centroid), for Restore
        Quaternion[] _pieceRot0;
        Vector3[] _pieceSpinAxis;
        float[] _pieceSpinDeg;              // deg/s tumble

        // Grow-back state (captured at Start when growBackOnRestore): the intact renderers grow about their OWN mesh centre,
        // not the transform origin - a breakable's intact mesh carries absolute root-local coords at localPosition 0, so a
        // plain transform scale would balloon it out of the world origin. Pre-compute each renderer's base pose + the pivot
        // offset (base scale . mesh-bounds-centre) and scale about that.
        bool _growReady;
        bool _growing;
        float _growStart;
        Vector3[] _intactBasePos;
        Vector3[] _intactBaseScale;
        Vector3[] _intactPivot;

        public override void Start()
        {
            base.Start();                   // BasisNetworkBehaviour: async NetworkID + ownership wiring for the break broadcast
            _box = GetComponent<BoxCollider>();
            _pool = crackStrength;
            if (growBackOnRestore) CaptureGrow();
        }

        void Update()
        {
            // Growing back (not broken yet re-hittable): ease the intact prop up, holding off detection until it's whole.
            if (_growing) { GrowStep(); return; }

            if (_broken)
            {
                if (!_swapped && Time.time >= _swapDue) DoSwap();   // roll-away: the delayed hide/reveal/throw (docs/036)
                if (_throwing) ThrowStep(Time.deltaTime);
                if (respawn && Time.time - _breakTime >= respawnDelay) Restore();
                return;
            }

            if (_box == null) return;

            // Knock detection on the rising edge. On foot the player's ROOT crosses the box; while RIDING the BOARD - not
            // the seated rider's root, which can sit off the panel - is what plows through, so also test the board's
            // position and prefer its own velocity for the throw. Either point inside = a crossing.
            var board = BasisBoard.LocalRider;
            bool inside = BasisLocalPlayerProbe.InsideBox(_box);
            if (board != null) inside |= BasisLocalPlayerProbe.PointInBox(_box, board.transform.position);

            // A FRAGILE surface (docs/036) is worn down by PRESENCE rather than by the crossing: the game re-runs the
            // contact every tick the rider overlaps the pane, gated at 30 frames, which is how riding along the glass
            // drains it over about three seconds. This containment poll is already exactly that test, so the rising
            // edge is dropped and every frame inside charges instead.
            if (crackStrength > 0f)
            {
                if (_cracked && _crackLife > 0f)
                {
                    _crackLife -= Time.deltaTime;
                    // The crack retired before the pool ran out: it takes the accumulated damage with it and the
                    // surface is whole again. Retail authors -1 on every pane precisely so this cannot happen to glass.
                    if (_crackLife <= 0f) { _cracked = false; _pool = crackStrength; SetCrackFrame(0); }
                }
                if (inside)
                {
                    Vector3 velocity;
                    if (board != null) velocity = board.RiderVelocity;
                    else BasisLocalPlayerProbe.TryGetVelocity(out velocity);
                    Charge(velocity);
                }
                _wasInside = inside;
                return;
            }

            if (inside && !_wasInside) TryHit(board);
            _wasInside = inside;
        }

        // One accepted contact against the impact pool. The COST is what the whole behaviour turns on: a rider carried
        // along the pane closes on its plane at nearly nothing and pays the cheap price, while one crossing into it or
        // dropping onto it closes fast along the normal and spends the authored 5 in a single hit. Measuring closing
        // speed along the PANE'S OWN normal rather than vertically is load-bearing - a rider descending a steep course
        // carries several m/s downward while riding perfectly along a sloped pane, and a vertical test would read that
        // as a landing and shatter every pane the moment it was touched.
        void Charge(Vector3 velocity)
        {
            if (_broken || Time.time < _crackGateUntil) return;
            _crackGateUntil = Time.time + crackGate;
            _impactWorld = velocity;
            if (!_cracked)
            {
                _cracked = true;
                _crackLife = crackLifetime;
                if (crackSound != null && crackSound.clip != null) crackSound.PlayOneShot(crackSound.clip, breakVolume);
                SetCrackFrame(1);
            }
            Vector3 normal = transform.TransformDirection(crackNormal).normalized;
            float closing = Mathf.Abs(Vector3.Dot(velocity, normal));
            _pool -= closing >= crackImpactSpeed ? crackImpactCost : crackCarriedCost;
            if (_pool > 0f) return;
            BreakAndArm();
            Broadcast();                    // the glass gave way here; every other client shatters its own copy
        }

        // Select the pane's plain/cracked state frame. Unlike the Udon original this can go through a
        // MaterialPropertyBlock, so one pane cracking leaves the material - shared by every glass instance on the
        // level - and the batching of all the others untouched.
        void SetCrackFrame(int frame)
        {
            if (crackRenderer == null || crackFrames == null || frame < 0 || frame >= crackFrames.Length) return;
            Texture2D tex = crackFrames[frame];
            if (tex == null) return;
            _crackBlock ??= new MaterialPropertyBlock();
            crackRenderer.GetPropertyBlock(_crackBlock, crackSlot);
            _crackBlock.SetTexture("_MainTex", tex);
            crackRenderer.SetPropertyBlock(_crackBlock, crackSlot);
        }

        // Fire this cluster from ANOTHER prop's hit (docs/036 - the spill). A garbage can / news box / mail box is a
        // Roller KNOCK BODY whose collision chain also throws a hidden contents twin: the body owns the crossing poll
        // (it has to, it's the thing that topples), so it calls this instead of us carrying a second box over the same
        // spot - which is why a spill cluster has no BoxCollider and its own detection above never runs. impactVelocity
        // is the hitter's velocity, the mesh-throw's collision direction.
        public void HitFrom(Vector3 impactVelocity)
        {
            if (_broken) return;
            _impactWorld = impactVelocity;
            BreakAndArm();
            Broadcast();                    // every other client sees this spill (no-op offline)
        }

        // A crossing was detected. Riding gates on minRideSpeed (walking always breaks) and throws along the board's
        // velocity; walking throws along the tracked player velocity. Then shatter + broadcast.
        void TryHit(BasisBoard board)
        {
            if (board != null)
            {
                if (minRideSpeed > 0f && board.RiderSpeed < minRideSpeed) return;
                _impactWorld = board.RiderVelocity;
            }
            else BasisLocalPlayerProbe.TryGetVelocity(out _impactWorld);

            if (_broken) return;
            BreakAndArm();
            Broadcast();                    // every other client sees this screen shatter (no-op offline)
        }

        // A remote player broke this screen: replay the shatter. No impact velocity on the wire, so the throw falls back to
        // the panel's own facing (StartThrow's rule) - the same fallback the VRChat NetBreak uses.
        protected override void OnRemoteEvent() { BreakAndArm(); }

        // Shatter + start this client's own respawn clock. Idempotent via Break()'s guard.
        void BreakAndArm()
        {
            if (_broken) return;
            Break();
            _breakTime = Time.time;
        }

        // The scripted break. Plain clusters swap instantly; a ROLL-AWAY cluster (breakDelay > 0, docs/036) sequences
        // it the way the SSF chain is authored: the hit plays the impact sound + starts the intact's roll clip, and
        // the swap (+ the landing crash) runs breakDelay seconds later (driven by the broken-state Update).
        void Break()
        {
            if (_broken) return;
            _broken = true;
            _swapped = false;
            if (breakSound != null && breakSound.clip != null) breakSound.PlayOneShot(breakSound.clip, breakVolume);
            if (debris != null) debris.Play();
            if (breakDelay > 0f)
            {
                if (rollAnim != null) rollAnim.Trigger();
                _swapDue = Time.time + breakDelay;
                return;
            }
            DoSwap();
        }

        // Hide intact (for a roll-away that's the rolled-away Anim_* segments), reveal the broken twin / throw the
        // pieces, and play the landing crash. Both the instant and the sequenced path converge here.
        void DoSwap()
        {
            _swapped = true;
            SetRenderers(intactRenderers, false);
            SetRenderers(brokenRenderers, true);
            // Take the floor away. A glass pane you SEE is authored pass-through; what actually held the rider up is an
            // invisible solid twin beside it, and the game's break kills that twin's collision - which is the whole
            // reason the rider drops through instead of standing on thin air where the glass was.
            SetColliders(supportColliders, false);
            if (endSound != null && endSound.clip != null) endSound.PlayOneShot(endSound.clip, breakVolume);
            StartThrow();
        }

        // The mesh-throw (Sub20) piece throw (docs/036): each piece gets velocity = throwDir (authored, or the impact
        // direction when authored zero - the game's rule) * U9, scaled per-axis by U6/U7/U8, with a little per-piece jitter
        // + tumble, integrated in mesh-local space (Z-up, cm) with gravity for U2 seconds.
        void StartThrow()
        {
            if (pieceTransforms == null || pieceTransforms.Length == 0) return;
            int n = pieceTransforms.Length;
            if (_pieceVel == null)
            {
                _pieceVel = new Vector3[n];
                _pieceHome = new Vector3[n];
                _pieceRot0 = new Quaternion[n];
                _pieceSpinAxis = new Vector3[n];
                _pieceSpinDeg = new float[n];
                for (int i = 0; i < n; i++)
                {
                    if (pieceTransforms[i] == null) continue;
                    _pieceHome[i] = pieceTransforms[i].localPosition;
                    _pieceRot0[i] = pieceTransforms[i].localRotation;
                }
            }

            Vector3 dir = throwDir;
            if (dir.sqrMagnitude < 0.0001f)
            {
                Vector3 w = _impactWorld;
                if (w.sqrMagnitude < 0.01f) w = transform.up;                 // no read on the hitter - toss along the prop's facing
                dir = transform.InverseTransformDirection(w.normalized);      // world -> mesh axes (the parent is the Level frame)
            }
            dir = dir.normalized * throwDirScale;

            for (int i = 0; i < n; i++)
            {
                if (pieceTransforms[i] == null) continue;
                float jitter = 0.7f + 0.6f * Random.value;
                Vector3 v = Vector3.Scale(dir, throwVelScale) * jitter;
                v += Random.insideUnitSphere * (0.15f * throwVelScale.magnitude);   // fan the boards out a little
                _pieceVel[i] = v;
                _pieceSpinAxis[i] = Random.onUnitSphere;
                _pieceSpinDeg[i] = 180f + 360f * Random.value;
            }
            SetRenderers(pieceRenderers, true);
            _throwT = 0f;
            _throwing = true;
        }

        // Per-frame throw step (driven by Update while _throwing). Integrates mesh-space Z-up with gravity; the pieces hide
        // when the throw finishes (U2 seconds) - the engine's anim ends there too.
        void ThrowStep(float dt)
        {
            _throwT += dt;
            bool done = _throwT >= throwDuration;
            for (int i = 0; i < pieceTransforms.Length; i++)
            {
                Transform t = pieceTransforms[i];
                if (t == null) continue;
                _pieceVel[i].z -= throwGravity * dt;                 // mesh space is Z-up
                t.localPosition += _pieceVel[i] * dt;
                t.localRotation = Quaternion.AngleAxis(_pieceSpinDeg[i] * dt, _pieceSpinAxis[i]) * t.localRotation;
            }
            if (done)
            {
                _throwing = false;
                SetRenderers(pieceRenderers, false);
            }
        }

        // Re-arm: restore the intact screen so the persistent world stays whole (and it can break again). Reset the pieces
        // to their centroids, then either grow the intact prop back from nothing (balloons) or pop it back instantly.
        void Restore()
        {
            _throwing = false;
            SetRenderers(brokenRenderers, false);
            SetRenderers(pieceRenderers, false);
            if (pieceTransforms != null && _pieceHome != null)
                for (int i = 0; i < pieceTransforms.Length; i++)
                {
                    if (pieceTransforms[i] == null) continue;
                    pieceTransforms[i].localPosition = _pieceHome[i];
                    pieceTransforms[i].localRotation = _pieceRot0[i];
                }
            if (rollAnim != null) rollAnim.ResetToStart();   // rewind the roll-away clip BEFORE the intact re-shows (docs/036)
            SetColliders(supportColliders, true);            // the glass is whole again, so it holds the rider again
            _broken = false;
            _swapped = false;
            _wasInside = true;               // require leaving the box before it can break again (don't re-break on the restore frame)
            // Re-arm the fragile surface with a full pool and its plain frame. The gate is pushed out one full interval
            // so a rider still standing where the glass was does not spend a charge on the frame it comes back.
            _pool = crackStrength;
            _cracked = false;
            _crackGateUntil = Time.time + crackGate;
            SetCrackFrame(0);

            if (growBackOnRestore && _growReady)
            {
                SetIntactGrow(0f);           // collapse to its centre this frame...
                SetRenderers(intactRenderers, true);
                _growing = true;
                _growStart = Time.time;      // ...then ease back over growBackDuration
            }
            else SetRenderers(intactRenderers, true);
        }

        // One step of the grow-back (driven by Update while _growing). Eases scale 0 -> base over growBackDuration, then
        // stops at full size; a re-break mid-grow is impossible (detection is gated while growing).
        void GrowStep()
        {
            float gd = growBackDuration > 0.01f ? growBackDuration : 1f;
            float p = (Time.time - _growStart) / gd;
            if (p >= 1f)
            {
                SetIntactGrow(1f);
                _growing = false;
                _wasInside = BasisLocalPlayerProbe.InsideBox(_box);   // if you're still standing in it, require leaving before it breaks again
                return;
            }
            SetIntactGrow(Mathf.SmoothStep(0f, 1f, p));
        }

        // Snapshot each intact renderer's pose + grow pivot once (at Start). The pivot is the mesh-bounds centre scaled into
        // parent space, so scaling about it keeps the prop's centre fixed as it grows.
        void CaptureGrow()
        {
            if (intactRenderers == null) return;
            int n = intactRenderers.Length;
            _intactBasePos = new Vector3[n];
            _intactBaseScale = new Vector3[n];
            _intactPivot = new Vector3[n];
            for (int i = 0; i < n; i++)
            {
                if (intactRenderers[i] == null) continue;
                Transform t = intactRenderers[i].transform;
                _intactBasePos[i] = t.localPosition;
                _intactBaseScale[i] = t.localScale;
                MeshFilter mf = intactRenderers[i].GetComponent<MeshFilter>();
                Vector3 bc = (mf != null && mf.sharedMesh != null) ? mf.sharedMesh.bounds.center : Vector3.zero;
                _intactPivot[i] = Vector3.Scale(t.localScale, bc);
            }
            _growReady = true;
        }

        // Scale every intact renderer to fraction k of its authored size, ABOUT its own mesh centre (so it grows in place,
        // not out of the world origin): localScale = base*k, localPosition shifted to hold the pivot fixed.
        void SetIntactGrow(float k)
        {
            if (intactRenderers == null || _intactPivot == null) return;
            for (int i = 0; i < intactRenderers.Length; i++)
            {
                if (intactRenderers[i] == null) continue;
                Transform t = intactRenderers[i].transform;
                t.localScale = _intactBaseScale[i] * k;
                t.localPosition = _intactBasePos[i] + _intactPivot[i] * (1f - k);
            }
        }

        static void SetRenderers(Renderer[] rs, bool on)
        {
            if (rs == null) return;
            for (int i = 0; i < rs.Length; i++) if (rs[i] != null) rs[i].enabled = on;
        }

        static void SetColliders(Collider[] cs, bool on)
        {
            if (cs == null) return;
            for (int i = 0; i < cs.Length; i++) if (cs[i] != null) cs[i].enabled = on;
        }
    }
}
