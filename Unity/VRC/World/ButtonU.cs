using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.Udon.Common.Interfaces;

namespace OpenSlope.VrcPlugin
{

    // VRChat/Udon component for an SSX ride-over BUTTON - the pad that reads green until a rider crosses it, flashes
    // red for a moment, and settles back to green.
    //
    // In the game the button carries no effect of its own. A co-located trigger volume's collision header does two
    // MainType-7 hops: one plays a FINITE-lifetime TextureFlip (Sub11, Length 0.5-1.0s) on the button instance, one
    // plays the AnimObject on the pillars/door/ramp. So the colour and the prop are two effects of ONE crossing, not
    // one driving the other - which is why the button flashes for a third of a second while the barricade it opened
    // stays open far longer, and why crossing again does nothing to the barricade's timer. The crossing's PING is the
    // volume's own `Sounds.CollisonSound` event id (179/180/181/38 on the megaplex - the musical button notes),
    // played by the same collision event that fires the chain; the importer resolves it onto this box's AudioSource.
    //
    // The flash colour comes from a SECOND node in the same graph: a MainType-3 control op (U0 = 2, "select frame")
    // forces the flip node onto frame U1 before it ever renders. The node then advances on its phase accumulator until
    // its lifetime expires - and the authored numbers make that an ODD number of advances, so a two-frame material
    // lands back on its own static frame and the node's death is invisible. Nothing persists between crossings.
    // [Trailmap: 410-texture-animation]
    //
    // snowknife replays that node offline and ships the RESULT (frame index + hold seconds per segment), so this
    // behaviour only walks a short list - no engine law, no accumulator, no rate. Two shipped shapes: 0.3s red then
    // done, and a 0.3/0.28/0.28/0.13 red-green-red-green blink on the eight Length-1.0 buttons.
    //
    // Shared across the instance (docs/vrchat/043, Tier 1) exactly like AnimTriggerU: the one client that crosses
    // broadcasts to EVERYONE (SendCustomNetworkEvent All -> Fire), so the flash reads the same for every player the
    // pillars moved for. Detection is single-source - the local walking player, or the OWNER's board whose IsRiding is
    // true on the owner alone - so exactly one client broadcasts. The sync mode must NOT be None: None blocks
    // SendCustomNetworkEvent. Manual carries no traffic (there are no synced variables).
    //
    // You don't add this by hand: the importer (PropBuilder.BuildButtons) attaches and wires it via
    // UdonTools.AddConfigured. See docs/vrchat/013-udon-components.md and docs/008-texture-animation.md.
    [UdonBehaviourSyncMode(BehaviourSyncMode.Manual)] // Manual, NOT None: None BLOCKS SendCustomNetworkEvent (Fire).
    public class ButtonU : UdonSharpBehaviour
    {
        [Tooltip("The button's renderer - its own diverted object. Wired by the importer.")]
        public Renderer target;

        [Tooltip("Material-slot (submesh) index on that renderer.")]
        public int slot;

        [Tooltip("The material's ordered state frames (>= 2). Not an animation - the pulse below selects among them.")]
        public Texture2D[] frames;

        [Tooltip("Frame index per pulse segment, in order from the crossing. Replayed from the engine's flip node by " +
                 "snowknife, so the last segment is already the material's own frame.")]
        public int[] pulseFrames;

        [Tooltip("How long each pulse segment holds, in seconds (parallel to pulseFrames).")]
        public float[] pulseHolds;

        [Tooltip("The crossing's ping - a positional source on this trigger box carrying the volume instance's " +
                 "CollisonSound clip. Wired by the importer; null = the button is authored-silent.")]
        public AudioSource sound;

        [Tooltip("Broadcast the pulse to every player (docs/vrchat/043) so the flash reads the same for everyone the " +
                 "pillars moved for. Off = local-only. The importer pushes this default.")]
        public bool networked = true;

        [Tooltip("Minimum seconds between crossings, so re-entering the volume doesn't spam the broadcast. The game " +
                 "debounces the same chain at 3s (its collision header's Sub2).")]
        public float Cooldown = 3f;

        [HideInInspector] public int AutoTestFireCount;
        [HideInInspector] public int AutoTestPaintCount;

        private Material _mat;       // the button's instanced material, created on the FIRST pulse (see EnsureMat)
        private int _seg = -1;       // index into pulseFrames of the segment showing (-1 = at rest)
        private float _last = -999f; // Time.time of the last accepted crossing

        // Instantiate this button's material the first time it actually pulses. Udon has no MaterialPropertyBlock, so
        // changing one button's texture means owning its material - but doing that in Start() for every button on the
        // level would break batching on all of them to flash the few a rider ever crosses. Deferring it keeps every
        // untouched button on the shared material, which already carries the resting frame.
        bool EnsureMat()
        {
            if (_mat != null) return true;
            if (target == null) return false;
            var mats = target.materials;   // first access instantiates; the renderer keeps the instances
            if (slot >= 0 && slot < mats.Length) _mat = mats[slot];
            return _mat != null;
        }

        public override void OnPlayerTriggerEnter(VRCPlayerApi player)
        {
            if (player == null || !player.isLocal || target == null) return;
            FireTrigger();
        }

        // Also fire for the RIDEABLE BOARD: while you're a VRCStation passenger VRChat stops raising
        // OnPlayerTriggerEnter, so the board sweeps an invisible RiderProbe collider through here instead. Only a board
        // with a rider aboard counts (IsRiding is forced false on remote boards, so only the owner's cross fires).
        public void OnTriggerEnter(Collider other)
        {
            if (other == null || target == null) return;
            RideableBoard board = other.GetComponentInParent<RideableBoard>();
            if (board != null && board.IsRiding) FireTrigger();
        }

        void FireTrigger()
        {
            if (Time.time - _last < Cooldown) return;
            _last = Time.time;
            if (networked) SendCustomNetworkEvent(NetworkEventTarget.All, nameof(Fire));
            else Fire();
        }

        // Start the pulse. Public + param-less so it doubles as the network-event target (it runs on every client, the
        // sender included, when FireTrigger broadcasts). A pulse already running is left alone rather than restarted:
        // the engine's 3s chain debounce is longer than the longest authored pulse (1s), so retail never overlaps two
        // either - and since SendCustomEventDelayedSeconds carries no run token, letting them overlap would leave two
        // Step chains walking the same button.
        public void Fire()
        {
            AutoTestFireCount++;
            // The ping rides the same broadcast as the flash, so every player the pillars move for hears the button
            // too. It plays BEFORE the pulse guard: two riders crossing inside one pulse are still two hits (the
            // game's per-object sound debounce is shorter than its 3s chain debounce), and a button whose material
            // never resolves still sounds.
            if (sound != null && sound.clip != null) sound.PlayOneShot(sound.clip);
            if (pulseFrames == null || pulseFrames.Length == 0 || _seg >= 0 || !EnsureMat()) return;
            AutoTestPaintCount++;
            Step();
        }

        // Advance to the next pulse segment, scheduling itself for the end of it. Scheduled, NOT an Update(): a level
        // authors these by the dozen (75 on the megaplex) and a per-frame interpreted-VM tick each would cost far more
        // than the handful of crossings that ever happen. An idle button runs no code at all.
        public void Step()
        {
            if (pulseFrames == null) return;
            _seg++;
            if (_seg >= pulseFrames.Length)
            {
                // The pulse ended. Its last segment is already the material's own frame (the engine's advance count is
                // odd for exactly that reason), so there is nothing to restore.
                _seg = -1;
                return;
            }
            Show(pulseFrames[_seg]);
            float hold = (pulseHolds != null && _seg < pulseHolds.Length) ? pulseHolds[_seg] : 0f;
            if (hold > 0f) SendCustomEventDelayedSeconds(nameof(Step), hold);
            else Step();
        }

        void Show(int frame)
        {
            if (frames == null || frame < 0 || frame >= frames.Length || _mat == null) return;
            var tex = frames[frame];
            if (tex == null) return;
            _mat.SetTexture("_MainTex", tex);
        }
    }
}
