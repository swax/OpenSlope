using UnityEngine;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// Puts every rider on a board into one shared VOICE CHANNEL: while you're riding, you can hear (and be heard by) every
    /// other rider across the whole map, as if you're all on the same comms channel - and anyone standing physically near
    /// you still hears you normally on top of that. Step off the board and you drop back to plain proximity voice.
    ///
    /// HOW VRChat voice works (and why this is the whole mechanism): voice attenuation is a LISTENER-SIDE, per-other-player
    /// setting - each client decides, for every OTHER player, how far away that player can still be heard
    /// (<see cref="VRCPlayerApi.SetVoiceDistanceFar"/>, default 25 m). There is no server "channel"; you build one by
    /// agreeing, on each client, to widen the hearing range of the players who are "in the channel". So this behaviour runs
    /// on EVERY client (it's all local) and, a few times a second:
    ///   1. builds the global set of riders - a board that is being ridden carries the synced <c>occupied == true</c> flag,
    ///      and its rider is simply its network owner (<see cref="Networking.GetOwner"/>). No new synced state is needed;
    ///      we read the board pool the <see cref="BoardManager"/> already maintains.
    ///   2. if the LOCAL player is one of those riders, it raises the voice far-distance of every OTHER rider to
    ///      <see cref="channelFarDistance"/> (audible across the map); otherwise everyone sits at the default.
    /// The gate is MUTUAL on purpose: you hear a far-away rider only when YOU are also riding (you're in the channel). A
    /// non-rider hears riders only when they're close (default proximity), and a rider hears a non-rider only when they're
    /// close too - exactly the "board = channel, plus normal proximity for everyone nearby" the design calls for.
    ///
    /// We never touch a player's own voice (you don't hear yourself), and we only re-assert the boosted settings on the
    /// small set of current channel members each tick - players who just LEFT the channel are reset back to the defaults
    /// once, so nothing is stomped every frame.
    ///
    /// NETWORKED ONLY: this reads the shared, synced board state, so it needs the boards' multiplayer sync
    /// (<see cref="RideableBoard.networked"/>, on by default). In a solo instance there's no one else to hear anyway. No
    /// synced variables of its own and it sends no network events, so SyncMode.None is correct (and lightest).
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class BoardVoiceChannel : UdonSharpBehaviour
    {
        [Header("Wiring")]
        [Tooltip("The shared board pool's manager (BoardManager). We read its boards[] to find who is riding. Wired by " +
                 "BoardVoiceChannelSetup; null disables the channel (everyone stays at plain proximity voice).")]
        public BoardManager manager;

        [Header("Update")]
        [Tooltip("How often (s) to recompute who's in the channel and re-apply voice ranges. Voice doesn't need to be " +
                 "frame-tight, so this is throttled - ~1 s is responsive without scanning the board pool every frame. The " +
                 "pass is allocation-free (pre-sized buffers, reused each tick), so this is about responsiveness, not GC.")]
        public float updateInterval = 1f;

        [Header("Channel voice (applied to a fellow rider while YOU are riding)")]
        [Tooltip("Far hearing distance (m) for a fellow rider - how far away they can still be heard. Sized to span the " +
                 "whole run with margin (the map is ~3 km, so 6000 covers corner-to-corner); beyond it a channel member " +
                 "cuts to silence. VRChat's default (for everyone NOT in the channel) is 25 m.")]
        public float channelFarDistance = 6000f;
        [Tooltip("Near distance (m) - within this radius a channel member is at FULL volume; only past it does volume roll " +
                 "off toward zero at channelFarDistance. Defaulted EQUAL to channelFarDistance for a flat, walkie-talkie " +
                 "channel: every rider is equally loud no matter how far across the map they are (no distance falloff). The " +
                 "code clamps it just under far, so the tiny gap from near to far is the only rolloff (effectively a hard " +
                 "edge nobody on a 3 km map ever reaches). Lower it (e.g. 0) if you'd rather hear distance in a rider's " +
                 "volume instead.")]
        public float channelNearDistance = 6000f;
        [Tooltip("Voice gain (dB) for a channel member. 15 is VRChat's default; nudge up a touch if the channel feels quiet.")]
        public float channelGain = 15f;
        [Tooltip("Apply VRChat's distance LOWPASS to a channel member (muffles with distance). OFF here for a clear, 'radio' " +
                 "channel that stays crisp at range (pairs with the flat volume above); turn ON for a more natural, " +
                 "muffles-with-distance feel.")]
        public bool channelLowpass = false;

        [Header("Default voice (VRChat stock - restored when someone leaves the channel)")]
        [Tooltip("Default far distance (m). VRChat's stock value is 25.")]
        public float defaultFarDistance = 25f;
        [Tooltip("Default near distance (m). VRChat's stock value is 0.")]
        public float defaultNearDistance = 0f;
        [Tooltip("Default voice gain (dB). VRChat's stock value is 15.")]
        public float defaultGain = 15f;
        [Tooltip("Default lowpass. VRChat's stock value is on (true).")]
        public bool defaultLowpass = true;

        [Tooltip("Log channel join/leave + membership to the console (prefixed 'OpenSlopeVOICE'). Off for normal play.")]
        public bool debugLog = false;

        [Header("Local mute (driven by the Settings Board's 'Global rider chat' toggle)")]
        [Tooltip("Local MUTE for the rider voice channel. While true the channel is OFF for THIS client: every fellow " +
                 "rider drops back to plain proximity voice, so you only hear people physically near you even while riding " +
                 "(others are unaffected - it's listener-side). Defaults FALSE (channel active) so an old, un-repushed " +
                 "instance is never left silently muted.")]
        public bool uiMuted;

        private float _nextUpdate;
        // Playerids of the channel members (other riders) we boosted last tick, so we know who to RESET when they drop out.
        private int[] _prevMembers;
        private int _prevCount;
        // Scratch buffers, reused each tick to avoid per-frame allocation. Sized to the VRChat instance cap with headroom.
        private int[] _curMembers;
        private int _riderCount;
        private int[] _riderIds;

        void Start()
        {
            _prevMembers = new int[128];
            _curMembers  = new int[128];
            _riderIds    = new int[128];
            _prevCount = 0;
        }

        void Update()
        {
            if (Time.time < _nextUpdate) return;
            _nextUpdate = Time.time + (updateInterval > 0.1f ? updateInterval : 0.1f);
            Recompute();
        }

        // Rebuild the rider set from the synced board state, then bring the local client's per-player voice ranges in line:
        // boost the fellow riders (only while WE ride), reset anyone who just left the channel. All local; runs everywhere.
        void Recompute()
        {
            VRCPlayerApi local = Networking.LocalPlayer;
            if (local == null) return;

            // 1) Gather the riders: the owner of every board that is currently being ridden (occupied + active). occupied is
            //    UdonSynced and the owner is the rider, so this is the same on every client. Dedupe (a player rides one board).
            _riderCount = 0;
            RideableBoard[] boards = manager != null ? manager.boards : null;
            if (boards != null)
            {
                for (int i = 0; i < boards.Length; i++)
                {
                    RideableBoard b = boards[i];
                    if (b == null) continue;
                    GameObject go = b.gameObject;
                    if (!go.activeInHierarchy) continue;   // pooled/inactive board - not in play
                    if (!b.occupied) continue;             // free board - nobody's riding it
                    VRCPlayerApi o = Networking.GetOwner(go);
                    if (o == null || !Utilities.IsValid(o)) continue;
                    if (!ContainsId(_riderIds, _riderCount, o.playerId) && _riderCount < _riderIds.Length)
                        _riderIds[_riderCount++] = o.playerId;
                }
            }

            bool localRiding = ContainsId(_riderIds, _riderCount, local.playerId);

            // 2) Current channel members = the OTHER riders, but only if WE are riding too (the mutual gate) AND the channel
            //    isn't locally muted (the Settings Board's 'Global rider chat' toggle). When muted or off a board the set is empty for
            //    us, so everyone we'd boosted gets reset to proximity below.
            int curCount = 0;
            if (!uiMuted && localRiding)
            {
                for (int i = 0; i < _riderCount; i++)
                {
                    int id = _riderIds[i];
                    if (id == local.playerId) continue;
                    if (curCount < _curMembers.Length) _curMembers[curCount++] = id;
                }
            }

            // 3) Reset anyone who was in the channel last tick but isn't now (stopped riding, or we did) back to proximity.
            for (int i = 0; i < _prevCount; i++)
            {
                int id = _prevMembers[i];
                if (ContainsId(_curMembers, curCount, id)) continue;
                VRCPlayerApi p = VRCPlayerApi.GetPlayerById(id);
                if (p != null && Utilities.IsValid(p) && !p.isLocal)
                {
                    ApplyDefault(p);
                    if (debugLog) Debug.Log($"OpenSlopeVOICE: {id} left the board channel -> proximity voice");
                }
            }

            // 4) (Re)assert the channel voice on the current members. Cheap (few riders) and self-healing - if anything ever
            //    reset a member's voice, this puts it back next tick.
            for (int i = 0; i < curCount; i++)
            {
                VRCPlayerApi p = VRCPlayerApi.GetPlayerById(_curMembers[i]);
                if (p != null && Utilities.IsValid(p) && !p.isLocal) ApplyChannel(p);
            }

            if (debugLog && curCount != _prevCount)
                Debug.Log($"OpenSlopeVOICE: localRiding={localRiding} channelMembers={curCount} riders={_riderCount}");

            // 5) The current members become last tick's, so the next pass can detect who drops out. Swap the buffers (the old
            //    _prevMembers becomes the next scratch _curMembers) so neither is reallocated.
            int[] tmp = _prevMembers; _prevMembers = _curMembers; _curMembers = tmp;
            _prevCount = curCount;
        }

        // Widen a fellow rider's voice to the channel range. Order matters: raise FAR first, then set NEAR, so NEAR is never
        // momentarily above the current FAR (VRChat requires near < far). Clamp near just under far defensively.
        void ApplyChannel(VRCPlayerApi p)
        {
            float far = channelFarDistance;
            float near = channelNearDistance;
            if (near > far - 0.1f) near = far - 0.1f;
            if (near < 0f) near = 0f;
            p.SetVoiceDistanceFar(far);
            p.SetVoiceDistanceNear(near);
            p.SetVoiceGain(channelGain);
            p.SetVoiceLowpass(channelLowpass);
        }

        // Restore VRChat's stock proximity voice. Order is the mirror of ApplyChannel: lower NEAR first, then FAR, so near
        // never sits above far during the transition down from the wide channel range.
        void ApplyDefault(VRCPlayerApi p)
        {
            float far = defaultFarDistance;
            float near = defaultNearDistance;
            if (near > far - 0.1f) near = far - 0.1f;
            if (near < 0f) near = 0f;
            p.SetVoiceDistanceNear(near);
            p.SetVoiceDistanceFar(far);
            p.SetVoiceGain(defaultGain);
            p.SetVoiceLowpass(defaultLowpass);
        }

        static bool ContainsId(int[] arr, int count, int id)
        {
            for (int i = 0; i < count; i++) if (arr[i] == id) return true;
            return false;
        }
    }
}
