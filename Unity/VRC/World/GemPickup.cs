using UdonSharp;
using UnityEngine;
using VRC.SDKBase;
using VRC.Udon.Common.Interfaces;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// Collect feedback for SSX's trick-multiplier "gem" pickups (the spinning snowflake x2/x3/x5 icons). The gem spins
    /// via <see cref="SpinnerManager"/>; this sibling behaviour gives the HIT effect: ride or walk through a gem and it
    /// POPS - vanishes INSTANTLY (a one-frame snap to nothing, no shrink) in a sparkle burst - HOLDS gone for a beat
    /// (popHoldDelay, ~0.5 s, collider off the whole time), then GROWS back from nothing. It's poppable again as soon as
    /// it starts regrowing (a re-hit mid-grow restarts the pop); the hold blackout is what keeps a single SLOW pass from
    /// double-popping (by the time the collider returns you've cleared it).
    ///
    /// The pop is the SAME effect everywhere (docs/vrchat/043). The collector hears a one-shot chime (LOCAL, instant feedback)
    /// and the gem pops immediately on their client; on a networked instance the pop is also broadcast so every other
    /// player sees the gem you hit pop + regrow. The gem is never destroyed or hidden per-player - it only SCALES - so
    /// it's always present and re-collectible for everyone, and a transient shared pop can't strand it (it's back in
    /// <see cref="growBackDuration"/> seconds). <c>networked = false</c> is a purely local pop (solo / demo).
    ///
    /// Detection mirrors <see cref="PhysicsProp"/>, because a gem has the same two ways to be hit:
    ///   - WALKING player: OnPlayerTriggerEnter from the local player's capsule.
    ///   - RIDING the board: a VRCStation passenger stops raising OnPlayerTriggerEnter, so the board sweeps an invisible
    ///     RiderProbe capsule through us and we catch OnTriggerEnter (needs the kinematic Rigidbody the importer adds). We
    ///     pop only while the board is actually ridden (IsRiding, forced false on remote boards so only the local crossing
    ///     pops). While popped the gem's collider is scaled to ~nothing with it, so it naturally can't be re-hit until it
    ///     has grown back enough.
    ///
    /// NO per-frame Update: the grow-back self-steps with delayed events ONLY while a gem is actually growing, so an idle
    /// gem costs nothing - matching the perf design that moved the spin into the single-Update <see cref="SpinnerManager"/>.
    ///
    /// You don't add this by hand to the gems: the importer (PropBuilder.BuildSpinners) adds the Rigidbody + trigger
    /// collider and attaches+configures this directly via UdonTools.AddConfigured. See docs/023-gem-pickups.md.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.Manual)] // Manual, NOT None: None BLOCKS SendCustomNetworkEvent (Pop). No synced vars, so Manual carries no traffic - it's just what lets the event through.
    public class GemPickup : UdonSharpBehaviour
    {
        [Tooltip("Trick multiplier this gem awards (Yellow=2, Orange=3, Red=5). Native gems are active only in " +
                 "Trick/Showoff, where riding through one raises the run multiplier (MAX-not-stack, consumed by the " +
                 "next banked trick). The board also rejects awards in Race/Free ride defensively (docs/050).")]
        public int Multiplier = 2;

        [Tooltip("One-shot source holding the gem's pickup chime, played LOCALLY on a hit (the collector's own feedback). " +
                 "Built + wired by the importer; null = silent (the gem still pops + sparkles).")]
        public AudioSource pickupSound;

        [Tooltip("Volume scale for the pickup chime (0..1).")]
        [Range(0f, 1f)] public float pickupVolume = 1f;

        [Tooltip("Sparkle burst played at the gem on a hit - the game's real pickup flash (SSF effect 9/11/13, an additive " +
                 "particle burst). Built + wired by the importer; null = no sparkle (the gem still pops + regrows).")]
        public ParticleSystem sparkle;

        [Tooltip("Seconds the gem stays popped (invisible, no collider) before it starts growing back. This blackout is the " +
                 "debounce that stops a SLOW pass from double-popping - the collider's gone long enough to clear you. A new " +
                 "field, floored to 0.5 on an un-repushed gem (the proxy default doesn't reach existing instances).")]
        public float popHoldDelay = 0.5f;

        [Tooltip("Seconds the gem takes to grow back from nothing once the hold ends. A new field, floored to 1.2 on an " +
                 "un-repushed gem.")]
        public float growBackDuration = 1.2f;

        [Tooltip("Minimum board speed (m/s) to collect while riding. 0 = any contact pops it (a pickup, not a knock); the " +
                 "walking player always pops it on contact.")]
        public float minRideSpeed = 0f;

        [Header("Networking (docs/vrchat/043)")]
        [Tooltip("Broadcast the pop to all players so everyone sees the gem you hit pop + regrow. Off = purely local (solo / " +
                 "demo). The importer pushes this default; existing un-pushed gems read false until re-imported.")]
        public bool networked = true;

        private Vector3 _baseScale = Vector3.one; // the gem's authored scale, captured at Start; we snap to 0 then grow back to this
        private bool _popped;                      // in the pop cycle (hold + grow-back): gates local re-triggers so one pass = one pop
        private float _growStart;                  // Time.time the grow BEGINS (= pop time + popHoldDelay); before it, hold at 0
        private float _popDedupe;                  // short window that swallows the collector's own All-broadcast echo

        void Start()
        {
            _baseScale = transform.localScale;
            if (_baseScale.sqrMagnitude < 1e-9f) _baseScale = Vector3.one; // guard a zero authored scale
        }

        // Walking player skis through us (the board's seated rider doesn't raise this - see OnTriggerEnter).
        public override void OnPlayerTriggerEnter(VRCPlayerApi player)
        {
            if (player == null || !player.isLocal) return;
            Hit();
        }

        // The RIDEABLE BOARD: a VRCStation passenger reports no walking-capsule trigger, so the board sweeps an invisible
        // RiderProbe capsule through us. Pop only while it's actually ridden (IsRiding, forced false on remote boards so
        // only the local crossing pops) and - if a speed gate is set - only above it.
        public void OnTriggerEnter(Collider other)
        {
            if (other == null) return;
            RideableBoard board = other.GetComponentInParent<RideableBoard>();
            if (board == null || !board.IsRiding) return;
            if (minRideSpeed > 0f && board.RiderVelocity.magnitude < minRideSpeed) return;
            board.ApplyGemMultiplier(Multiplier); // x2/x3/x5 trick multiplier on THIS rider's run (local; max-not-stack)
            Hit();
        }

        // A local hit: the chime (collector feedback) plays LOCALLY + instantly, the gem pops on this client immediately
        // (so our own feedback never waits on a network round-trip), and the pop is broadcast so everyone sees it. The gem
        // is poppable again as soon as it starts regrowing (a re-hit mid-grow just restarts the pop). The popHoldDelay
        // blackout - the collider is gone the whole time - is what keeps a single SLOW pass from double-popping; Pop's own
        // short dedupe window swallows any same-frame/echo repeat. (A remote's broadcast Pop always plays.)
        public void Hit()
        {
            if (pickupSound != null && pickupSound.clip != null) pickupSound.PlayOneShot(pickupSound.clip, pickupVolume);
            Pop();                                                                        // local + immediate
            if (networked) SendCustomNetworkEvent(NetworkEventTarget.All, nameof(Pop));   // others (our own echo is swallowed below)
        }

        // The shared pop: sparkle burst + an INSTANT snap to nothing (one frame, no shrink), HOLD invisible for
        // popHoldDelay, then grow back. Public + param-less so it doubles as the network-event target - it runs on every
        // client. The collector ran this locally in Hit, so its own All-broadcast echo (a frame later) lands inside the
        // short dedupe window and is ignored; a LATER hit by anyone (past the window) restarts the pop everywhere.
        public void Pop()
        {
            if (Time.time < _popDedupe) return;
            _popDedupe = Time.time + 0.15f;
            if (sparkle != null) sparkle.Play();
            float hold = popHoldDelay > 0.001f ? popHoldDelay : 0.5f;     // floor the new-field default on un-repushed gems
            bool wasPopped = _popped;                                    // a Pop arriving mid-cycle (e.g. another player's broadcast) restarts it
            _growStart = Time.time + hold;                               // grow BEGINS after the hold; until then we sit at 0
            ApplyScale(0f); // pop to nothing THIS frame (instant, not a shrink); the collider scales with us, so it's not re-hittable while gone
            _popped = true;
            if (!wasPopped) SendCustomEventDelayedFrames(nameof(GrowStep), 1); // start the chain once; a re-Pop just moves _growStart, the running chain follows
        }

        // One step of the hold-then-grow, scheduled only during a pop cycle (no idle Update). Sits at 0 through the hold,
        // then eases the scale from 0 back to the authored size over growBackDuration, then stops + re-arms the gem. A
        // restart (a fresh Pop pushing _growStart forward) is picked up here. Public so the delayed event can call it.
        public void GrowStep()
        {
            if (!_popped) return;
            float gd = growBackDuration > 0.01f ? growBackDuration : 1.2f; // floor the new-field default on un-repushed gems
            float p = (Time.time - _growStart) / gd;
            if (p < 0f) { ApplyScale(0f); SendCustomEventDelayedFrames(nameof(GrowStep), 1); return; } // still holding at nothing
            if (p >= 1f) { ApplyScale(1f); _popped = false; return; }      // fully grown -> stop + re-arm (poppable again)
            ApplyScale(Mathf.SmoothStep(0f, 1f, p));
            SendCustomEventDelayedFrames(nameof(GrowStep), 1);
        }

        private void ApplyScale(float k) { transform.localScale = _baseScale * k; }
    }
}
