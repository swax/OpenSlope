using UdonSharp;
using UnityEngine;
using VRC.SDKBase;
using VRC.Udon.Common.Interfaces;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// SSX's breakable LCD jumbotron logo (docs/028). In the original you ride THROUGH the lit logo screen and it
    /// shatters with a sound; that "break" is a scripted MESH-SWAP, not a physics shatter: the intact
    /// logo screen + its scanline overlay are hidden and a pre-modelled BROKEN twin (already placed at the same
    /// spot, shipped invisible) is revealed, plus the LCD/glass break sound. We reproduce that swap exactly, and -
    /// as an engine-plausible embellishment the original omits (the source level authors no collision-particle emitter, see
    /// docs/unity/014) [Trailmap: 370-world-interaction] - spray the game's own brk* glass-shard debris sprites on the break.
    ///
    /// The real chain (SSFLogic.json) [Trailmap: 370-world-interaction]: the intact screen (Mdl_Lcd_ScreenLogo_*, zero response mass so you
    /// ride through it like a leaf cutout) carries EffectSlotIndex 15 -> CollisionEffectSlot 49 -> a RunFunction
    /// logo-break -> three MainType-7 instance toggles: HIDE the intact logo, SHOW the broken twin
    /// (Mdl_Lcd_ScreenLogoBroken_*), HIDE the scanlines (Mdl_Lcdscan_*). CollisonSound 63 remaps to the LCD break clip.
    ///
    /// Detection mirrors the firework trigger / gem pickup (the same two ways to be hit):
    ///   - WALKING player: OnPlayerTriggerEnter from the local player's capsule (needs only the trigger collider).
    ///   - RIDING the board: a VRCStation passenger stops raising OnPlayerTriggerEnter, so the board sweeps an
    ///     invisible RiderProbe capsule through us and we catch it in OnTriggerEnter; only while it's actually
    ///     ridden (IsRiding), and (optional) above a min speed.
    ///
    /// Shared across the instance (docs/vrchat/043, Tier 1): when you break the screen the client broadcasts a one-shot
    /// NetBreak to everyone (SendCustomNetworkEvent All), and each client shatters its OWN copy + runs its own respawn
    /// timer. Because the break AUTO-RESETS (respawn), it needs no synced latched state: the most a late joiner can
    /// miss is the brief window before the sign restores - and by the time they arrive it has very likely already
    /// reset - so the cost of carrying it as persistent state isn't worth it. (These screens are ride-THROUGH anyway,
    /// so the divergence is purely visual, never a collision contradiction.) Detection is single-source - only the
    /// local walking player, or the OWNER's board whose IsRiding is true on the owner alone - so exactly one client
    /// broadcasts. The breaker shatters INSTANTLY (local), not waiting on the round-trip; the per-client respawn timers
    /// re-arm within network latency of each other. Break / Restore self-guard on _broken so the broadcast is
    /// idempotent (the breaker's own NetBreak no-ops; a remote shatters with the full effect). Nothing is destroyed -
    /// we just toggle renderers - so the screen re-arms and breaks again. `networked = false` falls back to a purely
    /// local break (solo / demo). NOTE: with respawn = false (a permanent break) a late joiner sees it intact until
    /// they break it themselves - the one case a genuinely-permanent effect would want synced state (docs/vrchat/043).
    ///
    /// FRAGILE SURFACES (crackStrength > 0, docs/036 - the megaplex glass panes) invert the trigger's meaning. Every
    /// other breakable here breaks on the contact that reaches it; a pane is WORN DOWN. Contact cracks it (a crack
    /// sound and its material's cracked frame) and drains an impact pool, and only the contact that empties the pool
    /// runs the break below. What a contact costs depends on how the rider meets the surface: gliding along the glass
    /// is cheap and takes about three seconds to get through, dropping onto it spends the whole pool at once. And the
    /// break has a fourth job there - the pane you see is authored pass-through, so it also disables the invisible
    /// solid twin that was holding the rider up (supportColliders), which is what drops them through the hole.
    /// The drain is LOCAL, like the detection: only the client whose player or board is on the glass wears it down,
    /// and when it finally gives way that client broadcasts the same one-shot NetBreak everything else here uses, so
    /// every client shatters its own copy and runs its own respawn.
    ///
    /// You don't add this by hand: the importer (PropBuilder.BuildBreakableLogos) pulls the three screen instances
    /// out of the merged Props mesh into their own toggle-able GameObjects, builds the trigger box + debris + sound,
    /// and attaches+configures this directly via UdonTools.AddConfigured (which pushes the networked=true default, so a
    /// re-import turns sharing on). See docs/028-breakable-signs.md and docs/vrchat/043.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.Manual)] // Manual, NOT None: None BLOCKS SendCustomNetworkEvent (NetBreak). No synced vars, so Manual carries no traffic.
    public class BreakableLogoU : UdonSharpBehaviour
    {
        [Tooltip("Renderers HIDDEN on break - the intact lit logo screen + its scanline overlay (the game's BreakLogo " +
                 "hides both). Built + wired by the importer.")]
        public Renderer[] intactRenderers;

        [Tooltip("Renderers SHOWN on break - the pre-modelled broken/shattered twin (Mdl_Lcd_ScreenLogoBroken_*, " +
                 "shipped invisible in the data). Starts disabled; revealed on the break. Built + wired by the importer.")]
        public Renderer[] brokenRenderers;

        [Tooltip("One-shot source holding the LCD/glass break clip (CollisonSound 63 -> the course bank, slot 064), played " +
                 "on break. Built + wired by the importer; null = silent (the screen still swaps + sprays debris).")]
        public AudioSource breakSound;

        [Tooltip("Volume scale for the break clip (0..1).")]
        [Range(0f, 1f)] public float breakVolume = 1f;

        [Tooltip("Optional glass-shard debris burst (the game's brk* sprites) played at the screen on break. Built + " +
                 "wired by the importer; null = swap + sound only. An embellishment the original omits.")]
        public ParticleSystem debris;

        [Header("Piece throw (mesh-throw Sub20, docs/036)")]
        [Tooltip("The broken model's individual pieces (boards/planks), pivoted at their own centroids; revealed and " +
                 "THROWN on the break - the game's type0 Sub20 mesh-throw. Empty = plain swap (LCD logos). Wired by the importer.")]
        public Transform[] pieceTransforms;

        [Tooltip("Renderers of the pieces (parallel to pieceTransforms); hidden until the break.")]
        public Renderer[] pieceRenderers;

        [Tooltip("Per-axis throw velocity scale in SSX units (cm/s, mesh axes) - the Sub20 U6/U7/U8 (e.g. 500/500/300).")]
        public Vector3 throwVelScale = new Vector3(500f, 500f, 300f);

        [Tooltip("Throw direction scale - the Sub20 U9 (e.g. 0.8).")]
        public float throwDirScale = 0.8f;

        [Tooltip("Authored throw direction in mesh axes - the Sub20 U3/U4/U5. ZERO = the game's rule: throw along the " +
                 "direction you actually hit it from (the mesh-throw uses the actual collision direction when the " +
                 "authored throw dir is unset) [Trailmap: 370-world-interaction].")]
        public Vector3 throwDir = Vector3.zero;

        [Tooltip("Throw animation length in seconds - the Sub20 U2 (engine stores U2*60 frames). Pieces hide at the end.")]
        public float throwDuration = 2f;

        [Tooltip("Gravity applied to flying pieces, SSX units (cm/s^2) along mesh -Z.")]
        public float throwGravity = 981f;

        [Tooltip("Re-arm the screen after it breaks (the persistent free-roam world stays whole, and you can break it " +
                 "again). Off = it stays broken until the world reloads, the classic SSX single-run behaviour.")]
        public bool respawn = true;

        [Tooltip("Seconds after a break before the screen restores (respawn only).")]
        public float respawnDelay = 12f;

        [Header("Grow-back on respawn (docs/vrchat/043)")]
        [Tooltip("On respawn, GROW the restored prop back from nothing (like the trick gems) instead of popping it in " +
                 "instantly. The balloon animals use this; LCD logos/fences keep the instant restore. Wired by the importer.")]
        public bool growBackOnRestore = false;

        [Tooltip("Seconds the grow-back eases from nothing to full size (growBackOnRestore only).")]
        public float growBackDuration = 1f;

        [Header("Roll-away break (docs/036 - the globe sign)")]
        [Tooltip("Seconds between the hit and the hide/reveal/throw swap - the SSF chain's authored Wait. While it " +
                 "runs, rollAnim plays the intact's own model clip (the globe rolling down the street). 0 = the " +
                 "instant break every other cluster uses. Wired by the importer.")]
        public float breakDelay = 0f;

        [Tooltip("The break-owned animated prop playing the intact's roll clip (Trigger() at the hit, ResetToStart() " +
                 "on the respawn). Its segment renderers are part of intactRenderers, so the swap hides the rolled-away " +
                 "prop. Resolved by the wiring pass; null = no roll.")]
        public AnimatedPropU rollAnim;

        [Tooltip("One-shot at the LANDING (the chain's raw-slot MainType-8 crash), played at the delayed swap - the " +
                 "globe smashing at the end of its roll. Wired by the importer; null = silent swap.")]
        public AudioSource endSound;

        [Tooltip("Minimum board speed (m/s) to break while riding. 0 = any contact breaks it (you ride through it); " +
                 "raise to require some pace. The walking player always breaks on contact. Ignored by a fragile " +
                 "surface, whose gate is its impact pool instead.")]
        public float minRideSpeed = 0f;

        [Header("Fragile surface (docs/036 - the megaplex glass panes)")]
        [Tooltip("Impact-budget pool (the SSF Cracked node's authored strength; retail's panes ship 5). Above 0 this " +
                 "prop is WORN DOWN rather than smashed: contact cracks it, and only the contact that empties the pool " +
                 "runs the break. 0 = every other breakable, which breaks on the first contact. Wired by the importer.")]
        public float crackStrength = 0f;

        [Tooltip("Seconds a crack lasts before the surface HEALS, taking the accumulated damage with it. <= 0 never " +
                 "expires, which is what every retail pane authors: once cracked, cracked until it gives way.")]
        public float crackLifetime = -1f;

        [Tooltip("One-shot for the glancing hit that first cracks the glass (the collision chain's raw course-bank " +
                 "slot 65) - a different event from breakSound's smash. Wired by the importer; null = a silent crack.")]
        public AudioSource crackSound;

        [Tooltip("The pane's renderer. Its material carries a two-frame plain/cracked state list that the game's own " +
                 "crack handler selects frame 1 of - the graph deliberately has no flip node for it.")]
        public Renderer crackRenderer;

        [Tooltip("Material-slot (submesh) index on that renderer.")]
        public int crackSlot;

        [Tooltip("The material's ordered state frames: [0] plain, [1] cracked. Not an animation - the crack selects.")]
        public Texture2D[] crackFrames;

        [Tooltip("The pane's plane normal in level-local space, measured from its own geometry by the importer. The " +
                 "carried-vs-impact test is closing speed ALONG THIS AXIS, which is what separates a rider gliding " +
                 "along a sloped pane (near zero) from one dropping onto it.")]
        public Vector3 crackNormal = Vector3.up;

        [Tooltip("Colliders DISABLED by the break and restored by the respawn - the invisible solid twins that hold " +
                 "the rider up while the glass is intact. Wired by the importer's collision pass; empty = nothing to " +
                 "stand on in the first place (the pane itself is authored pass-through).")]
        public Collider[] supportColliders;

        [Tooltip("Seconds between accepted contacts. The game gates the drain at 30 frames, measured as a flat 0.5s " +
                 "on a carried ride, so a rider sitting on the glass spends two charges a second rather than 60.")]
        public float crackGate = 0.5f;

        [Tooltip("What one CARRIED contact costs - the rider supported by the surface, riding along it. Measured on " +
                 "PS2 at 0.687-2.5, so an authored 5 drains in about three seconds of being ridden.")]
        public float crackCarriedCost = 1f;

        [Tooltip("What one IMPACT costs - crossing into the pane, hitting it as a wall, or dropping onto it. Measured " +
                 "at 70-96, tightly clustered near 87, so an authored 5 is gone in one hit.")]
        public float crackImpactCost = 87f;

        [Tooltip("Closing speed along the pane's normal (m/s) at or above which a contact counts as an impact rather " +
                 "than a ride. Chosen rather than measured - the PS2 arithmetic reduces two contact vectors we do not " +
                 "reconstruct.")]
        public float crackImpactSpeed = 8f;

        [Header("Networking (docs/vrchat/043, Tier 1)")]
        [Tooltip("Broadcast the break to every player (a one-shot - everyone shatters their own copy + runs their own " +
                 "respawn timer). Off = local-only break. The importer pushes this default; existing un-pushed instances " +
                 "read false (local) until re-imported.")]
        public bool networked = true;

        private bool _broken;
        private bool _swapped;              // roll-aways: the delayed hide/reveal/throw has run for this break cycle
        private float _swapDue;             // Time.time the current cycle's swap is due (stale delayed-event guard)
        private Vector3 _impactWorld;       // hitter's world velocity at the break (the mesh-throw collision direction)

        // Grow-back state (captured at Start when growBackOnRestore): the intact renderers grow about their OWN mesh
        // centre, not the transform origin - a breakable's intact mesh carries absolute root-local coords at a
        // localPosition of 0, so a plain transform scale would balloon it out of the world origin. We pre-compute each
        // renderer's base pose + the pivot offset (base scale (.) mesh-bounds-centre) and scale about that.
        private bool _growReady;
        private bool _growing;
        private float _growStart;
        private Vector3[] _intactBasePos;   // each intact renderer's authored localPosition
        private Vector3[] _intactBaseScale; // each intact renderer's authored localScale
        private Vector3[] _intactPivot;     // base scale (.) mesh-bounds-centre = the pivot offset to hold fixed while scaling

        // Fragile-surface state. _pool is the remaining impact budget; _crackGateUntil is the 30-frame drain gate;
        // _healDue is when the CURRENT crack retires, and doubles as the stale-delayed-event guard (delayed events
        // cannot be cancelled, so one scheduled by an earlier crack must not wipe a later crack's damage).
        private float _pool;
        private bool _cracked;
        private float _crackGateUntil;
        private float _healDue;
        private Material _crackMat;

        void Start()
        {
            _pool = crackStrength;
            if (growBackOnRestore) CaptureGrow();
        }

        // Snapshot each intact renderer's pose + grow pivot once (at Start). The pivot is the mesh-bounds centre scaled
        // into parent space, so scaling about it keeps the prop's centre fixed as it grows.
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

        // Piece-throw state (allocated once on the first break).
        private bool _throwing;
        private float _throwT;
        private Vector3[] _pieceVel;        // mesh-space cm/s
        private Vector3[] _pieceHome;       // initial localPosition (the piece centroid)
        private Quaternion[] _pieceRot0;
        private Vector3[] _pieceSpinAxis;
        private float[] _pieceSpinDeg;      // deg/s tumble

        // Walking player rides through the screen (the board's seated rider doesn't raise this - see OnTriggerEnter).
        public override void OnPlayerTriggerEnter(VRCPlayerApi player)
        {
            if (player == null || !player.isLocal || _broken) return;
            _impactWorld = player.GetVelocity();
            if (crackStrength > 0f) { Charge(_impactWorld); return; }
            Hit();
        }

        // A fragile surface is worn down by PRESENCE, not by the crossing: the game re-runs the contact every tick the
        // rider overlaps the pane, gated, which is how a rider standing on the glass drains it over about three
        // seconds. So the pane needs Stay as well as Enter - and only a fragile one does, which is why both Stay
        // handlers early-out on crackStrength (an ordinary breakable has already broken on Enter anyway).
        public override void OnPlayerTriggerStay(VRCPlayerApi player)
        {
            if (crackStrength <= 0f || player == null || !player.isLocal || _broken) return;
            Charge(player.GetVelocity());
        }

        // The RIDEABLE BOARD: a VRCStation passenger reports no walking-capsule trigger, so the board sweeps an
        // invisible RiderProbe capsule through us. Break only while it's actually ridden (IsRiding, forced false on
        // remote boards so only the local crossing fires), and - if a speed gate is set - only above it.
        public void OnTriggerEnter(Collider other)
        {
            if (other == null || _broken) return;
            RideableBoard board = other.GetComponentInParent<RideableBoard>();
            if (board == null || !board.IsRiding) return;
            // The speed gate belongs to the instant break: a fragile surface decides carried-vs-impact from the
            // closing speed along its own plane, and a slow rider still wears it down rather than being ignored.
            if (crackStrength > 0f) { Charge(board.RiderVelocity); return; }
            if (minRideSpeed > 0f && board.RiderVelocity.magnitude < minRideSpeed) return;
            _impactWorld = board.RiderVelocity;
            Hit();
        }

        public void OnTriggerStay(Collider other)
        {
            if (crackStrength <= 0f || other == null || _broken) return;
            RideableBoard board = other.GetComponentInParent<RideableBoard>();
            if (board == null || !board.IsRiding) return;
            Charge(board.RiderVelocity);
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
                if (crackSound != null && crackSound.clip != null) crackSound.PlayOneShot(crackSound.clip, breakVolume);
                SetCrackFrame(1);
                // A finite crack retires on its own and takes the accumulated damage with it. Scheduled once, from
                // when the crack STARTED, so later contacts do not extend it. Retail authors -1 on every pane it
                // ships precisely so this cannot happen to glass.
                if (crackLifetime > 0f)
                {
                    _healDue = Time.time + crackLifetime;
                    SendCustomEventDelayedSeconds(nameof(CrackHeal), crackLifetime);
                }
            }
            Vector3 normal = transform.TransformDirection(crackNormal).normalized;
            float closing = Mathf.Abs(Vector3.Dot(velocity, normal));
            _pool -= closing >= crackImpactSpeed ? crackImpactCost : crackCarriedCost;
            if (_pool <= 0f) Hit();
        }

        // The crack retired before the pool ran out: the surface is whole again. Public so the delayed event can call
        // it; guarded so a heal scheduled by an earlier crack cycle cannot wipe the current one's damage.
        public void CrackHeal()
        {
            if (_broken || !_cracked || Time.time < _healDue - 0.05f) return;
            _cracked = false;
            _pool = crackStrength;
            SetCrackFrame(0);
        }

        // Select the pane's plain/cracked state frame. Udon has no MaterialPropertyBlock, so this owns the pane's
        // material - deferred to the first crack exactly as the buttons defer theirs, since instantiating at Start
        // would break batching on every pane on the level to change the few a rider ever touches.
        void SetCrackFrame(int frame)
        {
            if (crackFrames == null || frame < 0 || frame >= crackFrames.Length) return;
            if (_crackMat == null)
            {
                if (crackRenderer == null) return;
                Material[] mats = crackRenderer.materials;   // first access instantiates; the renderer keeps the copies
                if (crackSlot < 0 || crackSlot >= mats.Length) return;
                _crackMat = mats[crackSlot];
            }
            Texture2D tex = crackFrames[frame];
            if (_crackMat != null && tex != null) _crackMat.SetTexture("_MainTex", tex);
        }

        // Fire this cluster from ANOTHER prop's hit (docs/036 - the spill). A garbage can / news box / mail box is a
        // Roller KNOCK BODY whose collision chain also throws a hidden contents twin: the body owns the trigger the
        // rider crosses (it has to, it's the thing that topples), so it calls this instead of us carrying a second
        // trigger over the same spot. impactVelocity is the hitter's velocity, the mesh-throw's collision direction.
        public void HitFrom(Vector3 impactVelocity)
        {
            if (_broken) return;
            _impactWorld = impactVelocity;
            Hit();
        }

        // A LOCAL hit (this client's walking player or board crossed us). Shatter instantly for snappy feel, then
        // broadcast a one-shot so everyone else shatters their own copy. Each client runs its own respawn timer, so the
        // sign re-arms ~together (all receive the break within network latency). Shared by the walking + riding paths.
        public void Hit()
        {
            if (_broken) return;
            BreakAndArm();
            if (networked) SendCustomNetworkEvent(NetworkEventTarget.All, nameof(NetBreak));
        }

        // The broadcast target: shatter + arm the respawn on every client. The breaker's own copy already broke, so its
        // self-receipt no-ops via the guard; remotes shatter here with the full effect.
        public void NetBreak()
        {
            if (_broken) return;
            BreakAndArm();
        }

        // Shatter + schedule this client's own respawn. Break() is the idempotent visual swap; the re-arm is per-client.
        void BreakAndArm()
        {
            Break();
            if (respawn) SendCustomEventDelayedSeconds(nameof(Restore), respawnDelay);
        }

        // The scripted break. The plain clusters swap instantly: hide intact + scanlines, reveal the broken twin (or
        // throw its pieces), play the sound + debris, latch. A ROLL-AWAY cluster (breakDelay > 0, docs/036) sequences
        // it the way the SSF chain is authored: the hit plays the impact sound + starts the intact's roll clip, and
        // the swap (+ the landing crash) runs breakDelay seconds later via a delayed BreakSwap. Idempotent (early-out
        // when already broken): the broadcasting breaker's own NetBreak no-ops, and a remote runs the full effect.
        // The re-arm is scheduled by the caller (BreakAndArm), not here.
        public void Break()
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
                SendCustomEventDelayedSeconds(nameof(BreakSwap), breakDelay);
                return;
            }
            DoSwap();
        }

        // The delayed roll-away swap. Guards make a stale event harmless: a respawn already ran (_broken false), the
        // swap already happened (_swapped), or this event belongs to a PREVIOUS break cycle (it fires before the
        // current cycle's due time - delayed events can't be cancelled, so re-break after a config-short respawn
        // could leave one in flight).
        public void BreakSwap()
        {
            if (!_broken || _swapped || Time.time < _swapDue - 0.05f) return;
            DoSwap();
        }

        // Hide intact (for a roll-away that's the rolled-away Anim_* segments), reveal the broken twin / throw the
        // pieces, and play the landing crash. The one place both the instant and the sequenced path converge.
        void DoSwap()
        {
            _swapped = true;
            SetRenderers(intactRenderers, false);
            SetRenderers(brokenRenderers, true);
            // Take the floor away. A glass pane you SEE is authored pass-through; what actually held the rider up is
            // an invisible solid twin beside it, and the game's break kills that twin's collision - which is the whole
            // reason the rider drops through instead of standing on thin air where the glass was.
            SetColliders(supportColliders, false);
            if (endSound != null && endSound.clip != null) endSound.PlayOneShot(endSound.clip, breakVolume);
            StartThrow();
        }

        // The mesh-throw (Sub20) piece throw (docs/036): each piece gets velocity = throwDir (authored, or the impact
        // direction when authored zero - the game's rule) * U9, scaled per-axis by U6/U7/U8, with a little
        // per-piece jitter + tumble, integrated in mesh-local space (Z-up, cm) with gravity for U2 seconds.
        private void StartThrow()
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
            SendCustomEventDelayedFrames(nameof(ThrowStep), 1);      // drive the throw via a self-scheduled loop, not a persistent Update
        }

        // Per-frame throw step, SELF-SCHEDULED (no persistent Update): StartThrow fires the first call and each call
        // reschedules itself for the next frame until the throw finishes (U2 seconds). So an intact/at-rest sign costs ZERO
        // per-frame Udon - a persistent Update would dispatch on every breakable every frame (30+ idle dispatches/frame)
        // just to early-out on !_throwing. Trigger detection (OnTriggerEnter) is independent of Update, so breaking still fires it.
        public void ThrowStep()
        {
            if (!_throwing) return;
            float dt = Time.deltaTime;
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
                SetRenderers(pieceRenderers, false);                 // the engine's anim ends here too (U2 seconds)
                return;
            }
            SendCustomEventDelayedFrames(nameof(ThrowStep), 1);      // keep stepping next frame
        }

        // Re-arm: restore the intact screen so the persistent world stays whole (and it can break again). Idempotent
        // (early-out when already intact). Public so the delayed respawn event can call it.
        public void Restore()
        {
            if (!_broken) return;
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
            // Re-arm the fragile surface with a full pool and its plain frame. Done before the intact re-shows so the
            // pane never appears wearing the cracked texture it had when it gave way.
            _pool = crackStrength;
            _cracked = false;
            _crackGateUntil = 0f;
            SetCrackFrame(0);

            // Grow the intact prop back from nothing (balloons), or just pop it back instantly (logos/fences).
            if (growBackOnRestore && _growReady)
            {
                SetIntactGrow(0f);                 // collapse to its centre this frame...
                SetRenderers(intactRenderers, true);
                _growing = true;
                _growStart = Time.time;
                SendCustomEventDelayedFrames(nameof(GrowStep), 1);   // ...then ease back over growBackDuration (no idle Update)
            }
            else
            {
                SetRenderers(intactRenderers, true);
            }
        }

        // One step of the grow-back, self-scheduled only while growing (no persistent Update). Eases scale 0 -> base over
        // growBackDuration, then stops at full size. Bails if the prop is re-broken mid-grow (a fresh Restore restarts it).
        // Public so the delayed event can call it.
        public void GrowStep()
        {
            if (!_growing) return;
            if (_broken) { _growing = false; return; }
            float gd = growBackDuration > 0.01f ? growBackDuration : 1f;
            float p = (Time.time - _growStart) / gd;
            if (p >= 1f) { SetIntactGrow(1f); _growing = false; return; }   // fully grown
            SetIntactGrow(Mathf.SmoothStep(0f, 1f, p));
            SendCustomEventDelayedFrames(nameof(GrowStep), 1);
        }

        // Scale every intact renderer to fraction k of its authored size, ABOUT its own mesh centre (so it grows in
        // place, not out of the world origin): localScale = base*k, localPosition shifted to hold the pivot fixed.
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

        private void SetRenderers(Renderer[] rs, bool on)
        {
            if (rs == null) return;
            for (int i = 0; i < rs.Length; i++) if (rs[i] != null) rs[i].enabled = on;
        }

        private void SetColliders(Collider[] cs, bool on)
        {
            if (cs == null) return;
            for (int i = 0; i < cs.Length; i++) if (cs[i] != null) cs[i].enabled = on;
        }
    }
}
