using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.Udon.Common.Interfaces;

namespace OpenSlope.VrcPlugin
{

    // VRChat/Udon component for SSX's speed/trick BOOST PADS (spec 360-speed-and-boost, docs/040). The course
    // carries two kinds, both VISIBLE arrow decals on the slope that the rider crosses:
    //   Mdl_SpeedBoost_Gold_*    gold pads (SSF effect slot 0, MainType-17) - a SPEED boost.
    //   Mdl_TrickBoost_RedGreen_* red/green pads (slot 1, MainType-18) - a TRICK-window boost in the game.
    //
    // The importer (BoostPadBuilder) overlays an invisible trigger volume over each pad carrying this behaviour,
    // exactly like the firework triggers. The contact burst is the pad's OWN authored MainType-2 emitters, rendered
    // through the shared P6 path (docs/019, docs/052). The pad also POPS on a cross - snaps to nothing, holds, then
    // grows back, like a gem (docs/023) - which is a DELIBERATE DIVERGENCE: in the game a pad never disappears (its
    // closing node is DeadNodeMode 2, not the 4 that hides the source). That needs the decal diverted out of the
    // merged static mesh, which it is (divert kind "boostpad"); without a padVisual the pad just bursts. On a SPEED pad we
    // run the rideable board's timed boost (raise the top-speed cap + lean-gated forward thrust for a window) -
    // the game's actual pad mechanic, which raises the cap and feeds the cruise drive rather than writing velocity
    // (so it can't fling a stopped rider, only let a moving one run faster). TRICK pads have nothing to consume in
    // a free-roam world (no trick/scoring system), so they're cosmetic here: sparkle + chime, no physics.
    //
    // Detection mirrors FireworkTrigger / GemPickup - the same two ways to be hit:
    //   - WALKING player: OnPlayerTriggerEnter from the local player's capsule (cosmetic only; no board to boost).
    //   - RIDING the board: a VRCStation passenger stops raising OnPlayerTriggerEnter, so the board sweeps its
    //     invisible RiderProbe capsule through us and we catch it in OnTriggerEnter; we boost only while ridden.
    //
    // Split networking (docs/vrchat/043, Tier 1): the BOOST itself is a private physics change to YOUR board, so it stays
    // local - a remote shouldn't have their board sped up because someone else crossed a pad they're nowhere near.
    // Only the COSMETIC feedback (sparkle + chime) is shared: the crossing client broadcasts PlayFx to everyone
    // (SendCustomNetworkEvent All), so other players see + hear that a pad was hit. Detection is single-source (local
    // walking player, or the owner's board whose IsRiding is true on the owner alone), so exactly one client
    // broadcasts. `networked = false` keeps the cosmetic local too (solo / demo). The behaviour must NOT be None:
    // None BLOCKS SendCustomNetworkEvent. It's Manual (zero synced variables, so no traffic) - just enough for the
    // event. You don't add this by hand: the importer attaches + configures it directly via
    // UdonTools.AddConfigured (which pushes the networked=true default).
    [UdonBehaviourSyncMode(BehaviourSyncMode.Manual)] // Manual, NOT None: None BLOCKS SendCustomNetworkEvent (PlayFx). No synced vars, so Manual carries no traffic.
    public class BoostPad : UdonSharpBehaviour
    {
        [Tooltip("false = gold SPEED pad (boosts the rideable board); true = red/green TRICK pad (cosmetic here - " +
                 "no trick scoring in a free-roam world, so sparkle + chime only).")]
        public bool Trick;

        [Tooltip("Seconds of boost the rideable board runs on a SPEED pad cross (the board raises its top-speed cap + " +
                 "adds forward thrust for this long). 0 / a trick pad = no boost. Set by the importer from the pad's " +
                 "authored magnitude x BoostPadSecondsPerUnit.")]
        public float BoostSeconds = 2.5f;

        [Tooltip("Minimum seconds between re-fires, so re-entering / sitting in the volume doesn't re-trigger every frame.")]
        public float Cooldown = 2f;

        [Tooltip("Minimum board speed (m/s) to fire while riding. 0 = any contact fires it.")]
        public float MinRideSpeed = 0f;

        [Tooltip("Contact burst - the pad's OWN authored MainType-2 emitters (9 layers), rendered by the shared P6 path " +
                 "that also serves the fireworks / ambient bursts. Built + wired by the importer; null = no burst.")]
        public ParticleSystem sparkle;

        [Tooltip("The pad's arrow decal, diverted out of the merged static mesh so it can be scaled. On a cross it snaps " +
                 "to nothing, holds, then grows back - like a gem (docs/023). This is a DELIBERATE DIVERGENCE from the " +
                 "game, whose pads never disappear. Null = the pad stays put and only bursts + chimes.")]
        public Transform padVisual;

        [Tooltip("Seconds the pad stays gone before it starts growing back. This blackout doubles as the re-cross " +
                 "debounce, exactly as it does on a gem.")]
        public float popHoldDelay = 0.5f;

        [Tooltip("Seconds the pad takes to ease back to full size once the hold ends.")]
        public float growBackDuration = 1.2f;

        [Tooltip("One-shot pad-cross sound, built + wired by the importer (code-driven, not an SSF node - " +
                 "speed pad = zbxsfx slot 115, trick pad = 114 [Trailmap: 360-speed-and-boost]). null = silent.")]
        public AudioSource chime;

        [Tooltip("Volume scale for the chime (0..1).")]
        [Range(0f, 1f)] public float chimeVolume = 1f;

        [Tooltip("Broadcast the pad's cosmetic sparkle + chime to every player (docs/vrchat/043) so others see/hear it was " +
                 "hit. The boost physics is always local (only the crossing rider speeds up). Off = local cosmetic too.")]
        public bool networked = true;

        [Tooltip("The SSX EffectSlotIndex this pad carried (0 speed / 1 trick). Reference/debug only.")]
        public int EffectSlotIndex = -1;

        [HideInInspector] public int AutoTestFireCount;

        private float _last = -999f;

        // Pop state, mirroring GemPickup: the decal only ever SCALES (never hidden, never destroyed), so it is
        // always present for everyone and a transient shared pop can't strand it.
        private Vector3 _baseScale = Vector3.one;   // the decal's authored scale, captured at Start
        private bool _popped;                       // inside the pop cycle (hold + grow-back)
        private float _growStart;                   // Time.time the grow BEGINS (= pop time + popHoldDelay)

        void Start()
        {
            if (padVisual != null)
            {
                _baseScale = padVisual.localScale;
                if (_baseScale.sqrMagnitude < 1e-9f) _baseScale = Vector3.one;   // guard a zero authored scale
            }
        }

        // Walking player skis through the pad (the board's seated rider doesn't raise this - see OnTriggerEnter).
        // Cosmetic only: a player on foot has no board to boost.
        public override void OnPlayerTriggerEnter(VRCPlayerApi player)
        {
            if (player == null || !player.isLocal) return;
            Fire(null);
        }

        // The RIDEABLE BOARD: a VRCStation passenger reports no walking-capsule trigger, so the board sweeps an
        // invisible RiderProbe capsule through us. Boost only while it's actually ridden (IsRiding), and - if a speed
        // gate is set - only above it (read off the board's reported velocity, like the gem/crash-bag paths).
        public void OnTriggerEnter(Collider other)
        {
            if (other == null) return;
            RideableBoard board = other.GetComponentInParent<RideableBoard>();
            if (board == null || !board.IsRiding) return;
            if (MinRideSpeed > 0f && board.RiderVelocity.magnitude < MinRideSpeed) return;
            Fire(board);
        }

        // Apply the boost (speed pads, when ridden) + the cosmetic feedback. Shared by the walking and riding paths;
        // `board` is null for the walking player. A Cooldown stops the volume re-firing every frame you sit in it. The
        // boost stays LOCAL (only this rider's board); the cosmetic is broadcast to all (docs/vrchat/043).
        private void Fire(RideableBoard board)
        {
            if (Time.time - _last < Cooldown) return;
            _last = Time.time;
            if (!Trick && board != null && BoostSeconds > 0f) board.ApplyPadSpeedBoost(BoostSeconds); // local physics only
            if (networked) SendCustomNetworkEvent(NetworkEventTarget.All, nameof(PlayFx));            // cosmetic for everyone
            else PlayFx();
        }

        // The pad's burst + chime + pop. Public + param-less so it doubles as the network-event target (runs on every
        // client, including the sender, when Fire broadcasts) - so other players see/hear a pad was crossed, and see it
        // pop + regrow. Fire's Cooldown already debounces the local re-trigger, so unlike the gem there's no separate
        // dedupe window here: a remote broadcast is the only other caller and it should always play.
        public void PlayFx()
        {
            AutoTestFireCount++;
            if (sparkle != null) sparkle.Play();
            if (chime != null && chime.clip != null) chime.PlayOneShot(chime.clip, chimeVolume);
            Pop();
        }

        // Snap the decal to nothing THIS frame (an instant pop, not a shrink), hold, then grow back. Same shape as
        // GemPickup.Pop: a re-pop mid-cycle just pushes _growStart forward and the running chain follows it, so the
        // chain is only ever started once.
        private void Pop()
        {
            if (padVisual == null) return;
            float hold = popHoldDelay > 0.001f ? popHoldDelay : 0.5f;
            bool wasPopped = _popped;
            _growStart = Time.time + hold;
            ApplyScale(0f);
            _popped = true;
            if (!wasPopped) SendCustomEventDelayedFrames(nameof(GrowStep), 1);
        }

        // One step of the hold-then-grow, scheduled only during a pop cycle - an idle pad costs no Update. Sits at 0
        // through the hold, then eases back to the authored size. Public so the delayed event can reach it.
        public void GrowStep()
        {
            if (!_popped || padVisual == null) return;
            float gd = growBackDuration > 0.01f ? growBackDuration : 1.2f;
            float p = (Time.time - _growStart) / gd;
            if (p < 0f) { ApplyScale(0f); SendCustomEventDelayedFrames(nameof(GrowStep), 1); return; }   // still holding
            if (p >= 1f) { ApplyScale(1f); _popped = false; return; }                                     // fully grown
            ApplyScale(Mathf.SmoothStep(0f, 1f, p));
            SendCustomEventDelayedFrames(nameof(GrowStep), 1);
        }

        private void ApplyScale(float k) { padVisual.localScale = _baseScale * k; }
    }
}
