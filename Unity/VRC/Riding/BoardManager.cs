using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.SDK3.Components;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// Master-authoritative dispenser for the SHARED board pool (docs/vrchat/042, Stage 2 / Layer B). Sits on the same object as
    /// a <see cref="VRCObjectPool"/> whose <c>Pool</c> is every networked <see cref="RideableBoard"/> (a fixed pool
    /// sized to the player cap, pre-placed inactive). Only the POOL OWNER (the instance master, who owns this scene
    /// object) runs the policy here - everyone else's copy returns immediately. The pool itself syncs each board's
    /// active-state + ownership to all clients (including late joiners); each board syncs its own pose (Stage 1). So this
    /// behaviour never needs synced fields of its own - it just decides WHEN to <c>TryToSpawn</c> / <c>Return</c>.
    ///
    /// Policy:
    ///  - DISPENSE: a post click routes here (via <see cref="BoardRequest"/>) as <see cref="OnRequest"/>. We spawn a
    ///    free board from the pool and pose it at that post's anchor. If a free board is ALREADY at the post, the click
    ///    REPLACES it with a different board (the old one returns to the pool) so players can browse the pool's deck
    ///    variety without piling up boards - the live count stays flat.
    ///  - CAP: the pool size IS the cap. When the pool is exhausted we RECLAIM the least-recently-dispensed board that is
    ///    NOT being ridden and NOT currently parked at a post, returning it to the pool, then spawn. A board someone is
    ///    riding is never reclaimed: the <c>occupied</c> check at every reclaim site is the guard, and <see cref="ReturnBoard"/>
    ///    only deactivates a board once it confirms it owns it (so a rider who grabbed the board in the sync gap - and whose
    ///    <see cref="RideableBoard.OnOwnershipRequest"/> then denies our ownership grab - keeps it).
    ///  - ABANDONMENT TIMEOUT: a board ridden off and dismounted (active, not occupied, not at a post) returns itself to
    ///    the pool after <see cref="abandonTimeout"/>, so the working set stays ~= (riders + posts) and the cap is rarely
    ///    hit at all.
    ///
    /// State (_postBoard / _spawnTime) is master-LOCAL and rebuilt by proximity whenever we (re)gain ownership, so a
    /// master migration doesn't double-dispense - the authoritative visible state lives in the pool + per-board sync.
    ///
    /// NOT multiplayer-tested - VRCObjectPool's spawn/return ownership semantics need an in-instance upload to verify.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class BoardManager : UdonSharpBehaviour
    {
        [Tooltip("The object pool of boards. Its Pool array is the full set of networked boards (sized to the player cap), " +
                 "pre-placed inactive. Built + wired by StartGateSetup.")]
        public VRCObjectPool pool;
        [Tooltip("The boards, PARALLEL to pool.Pool (same GameObjects), so we can read each board's `occupied` flag and " +
                 "transform without a GetComponent. Built + wired by StartGateSetup.")]
        public RideableBoard[] boards;
        [Tooltip("Per-post spawn anchors (world position + downhill facing), indexed by the post's index. A dispensed " +
                 "board is posed here. Built + wired by StartGateSetup.")]
        public Transform[] anchors;
        [Tooltip("Seconds an abandoned board (ridden off, dismounted, not sitting at a post) stays out before it returns " +
                 "itself to the pool. With board idle-sleep (RideableBoard.sleepWhenParked) an abandoned board costs " +
                 "~nothing while it sits, so this is a LONG declutter backstop (1 hour) rather than a tight perf timer - " +
                 "dropped boards persist on the mountain for anyone to grab, then eventually recycle. A ridden or at-a-post " +
                 "board never times out.")]
        public float abandonTimeout = 3600f;
        [Tooltip("How often (s) the master runs the reclaim/timeout sweep. Cheap; 1 s is plenty responsive.")]
        public float sweepInterval = 1f;
        [Tooltip("How close (world m) a free active board must sit to a post anchor to be counted as 'parked at that post' " +
                 "when rebuilding state after gaining ownership. A dispensed board sits EXACTLY on its anchor, and the match " +
                 "picks each board's NEAREST post, so this is just an outer bound - keep it well under the post spacing " +
                 "(gate posts can be ~1.4 m apart) so a board drifted near the gate isn't mistaken for a parked one.")]
        public float postMatchDistance = 0.6f;

        private int[] _postBoard;    // pool index currently parked at each post, -1 = none (master-local)
        private float[] _spawnTime;  // Time.time each board was last dispensed, for LRU + timeout (master-local)
        private float _nextSweep;
        private bool _wasOwner;      // edge-detect (re)gaining pool ownership, to rebuild state once on master migration

        void Start()
        {
            int n = boards != null ? boards.Length : 0;
            _spawnTime = new float[n];
            int posts = anchors != null ? anchors.Length : 0;
            _postBoard = new int[posts];
            for (int i = 0; i < posts; i++) _postBoard[i] = -1;
            SendCustomEventDelayedSeconds(nameof(OwnerTick), 0.25f);
        }

        // True only on the client that owns the pool object - i.e. the instance master, since the pool is never handed off.
        public bool IsPoolOwner()
        {
            return pool != null && Networking.IsOwner(pool.gameObject);
        }

        // Master-migration edge-detect + the periodic reclaim/timeout sweep, on a SELF-SCHEDULED quarter-second loop
        // rather than a per-frame Update: dispensing is event-driven (OnRequest), so nothing here needs frame rate, and
        // the interpreted per-behaviour Update dispatch is exactly the per-frame Udon cost Quest pays for. Delayed
        // events fire even on a disabled behaviour, so the loop is immortal (4 dispatches/s).
        public void OwnerTick()
        {
            SendCustomEventDelayedSeconds(nameof(OwnerTick), 0.25f);
            bool own = IsPoolOwner();
            if (own && !_wasOwner) RebuildStateAndFill(); // first ownership, or inherited it on master migration
            _wasOwner = own;
            if (!own) return; // everyone but the pool owner does nothing - the pool + per-board sync carry the visible state
            if (Time.time >= _nextSweep) { _nextSweep = Time.time + sweepInterval; Sweep(); }
        }

        // Reconstruct _postBoard / _spawnTime from the live (synced) board state, so a fresh or migrated master doesn't
        // double-dispense. Any post that has no free board sitting at it gets seeded with one.
        void RebuildStateAndFill()
        {
            if (boards == null || _spawnTime == null) return;
            for (int idx = 0; idx < boards.Length; idx++) _spawnTime[idx] = Time.time; // true age unknown -> treat as fresh
            for (int p = 0; p < _postBoard.Length; p++) _postBoard[p] = -1;
            // Match each free, active board to its NEAREST post anchor (within postMatchDistance), and ONLY that one - so a
            // board belongs to exactly one post, the closest. Gate anchors sit closer together (~1.4 m) than
            // postMatchDistance, so a "first board within range, per post" scan would let one post claim its neighbour's
            // board, and a later click on that post would take the REPLACE path and RETURN the neighbour's board. Picking
            // the single nearest post means an off-anchor/stray board never gets mis-assigned to a farther post. docs/vrchat/042.
            for (int idx = 0; idx < boards.Length; idx++)
            {
                RideableBoard b = boards[idx];
                if (b == null || !b.gameObject.activeSelf || b.occupied) continue;
                int best = -1; float bestD = postMatchDistance * postMatchDistance;
                for (int p = 0; p < _postBoard.Length; p++)
                {
                    if (anchors[p] == null) continue;
                    float d = (b.transform.position - anchors[p].position).sqrMagnitude;
                    if (d < bestD) { bestD = d; best = p; }
                }
                if (best >= 0 && _postBoard[best] < 0) _postBoard[best] = idx; // claim the nearest post if it's still free
            }
            // Any post with no board sitting at it gets a fresh one dispensed.
            for (int p = 0; p < _postBoard.Length; p++)
                if (anchors[p] != null && _postBoard[p] < 0) Dispense(p);
        }

        // A post click arrives here (from BoardRequest on the pool owner). Spawn a board at that post.
        public void OnRequest(int postIndex)
        {
            if (!IsPoolOwner()) return; // only the pool owner may TryToSpawn
            if (_postBoard == null || postIndex < 0 || postIndex >= _postBoard.Length) return;
            Dispense(postIndex);
        }

        // A player reached over their shoulder and had NO board of their own to recall (BoardSummon -> BoardRequest).
        // Hand them a fresh one: spawn it from the pool, scrub it, and STAMP THEIR CLAIM on it.
        //
        // We deliberately do NOT transfer ownership here. Their client is already hunting for a board claimed by it, and
        // takes ownership itself the moment our claim lands (a free board's OnOwnershipRequest allows the grab). That makes
        // this path identical to a RECALL of a board they already own - one code path, no reply protocol, and no race
        // between the claim we serialize and an ownership handoff racing it. Pool owner only.
        public void OnSummon(int playerId)
        {
            if (!IsPoolOwner()) return;
            VRCPlayerApi p = VRCPlayerApi.GetPlayerById(playerId);
            if (p == null) return; // they left between the reach and our hearing about it

            GameObject g = pool.TryToSpawn();
            if (g == null) { ReclaimLeastRecent(); g = pool.TryToSpawn(); } // pool full -> free the LRU idle board, retry
            if (g == null) return; // nothing free to hand out - the summon simply doesn't land (their reach times out)

            int idx = IndexOf(g);
            if (idx < 0) return;
            RideableBoard b = boards[idx];
            if (b == null) return;

            b.PrepareSummonFor(p);
            _spawnTime[idx] = Time.time;
        }

        // Put a board at post `postIndex`. If the post is empty (or its board was just ridden away) we simply spawn one;
        // if a FREE board is already sitting there, we REPLACE it with a different board from the pool (the old one goes
        // back to the pool) - so a player can click the post repeatedly to browse the pool's variety of decks WITHOUT
        // accumulating boards (the live count stays flat). Owner-only (callers gate on IsPoolOwner).
        void Dispense(int postIndex)
        {
            int cur = _postBoard[postIndex];
            bool replacing = cur >= 0 && boards[cur] != null && boards[cur].gameObject.activeSelf && !boards[cur].occupied;

            // Spawn the replacement FIRST, while the old board is still active, so TryToSpawn is guaranteed to hand back a
            // DIFFERENT board (it only ever spawns an INACTIVE one). Returning the old one first could just hand it right
            // back out.
            GameObject g = pool.TryToSpawn();
            if (g == null) { ReclaimLeastRecent(); g = pool.TryToSpawn(); } // pool full -> free the LRU idle board, retry
            if (g == null) return; // nothing free to hand out - leave whatever's already at the post

            int idx = IndexOf(g);
            if (idx < 0) return;

            if (replacing) ReturnBoard(boards[cur].gameObject); // retire the board the player is swapping away from (net-zero count)

            RideableBoard b = boards[idx];
            Transform a = anchors[postIndex];
            if (b != null && a != null)
            {
                // We own it now (TryToSpawn). PlaceAtGate poses it AND scrubs the board-local runtime state a reactivated
                // pool object carries over (coast velocity, wake ribbon, grind/carve), publishing a clean, free, still board.
                b.PlaceAtGate(a.position, a.rotation);
            }
            else if (a != null)
            {
                g.transform.SetPositionAndRotation(a.position, a.rotation);
            }
            _postBoard[postIndex] = idx;
            _spawnTime[idx] = Time.time;
        }

        // Periodic master sweep: free posts whose board was ridden away, and time out abandoned boards back to the pool.
        void Sweep()
        {
            // A board parked at a post that's now being ridden has left the gate -> the post is empty again.
            for (int p = 0; p < _postBoard.Length; p++)
            {
                int idx = _postBoard[p];
                if (idx >= 0 && boards[idx] != null && boards[idx].occupied) _postBoard[p] = -1;
            }
            // Abandoned active boards (not occupied, not at a post) return to the pool after the timeout.
            VRCPlayerApi lp = Networking.LocalPlayer;
            for (int idx = 0; idx < boards.Length; idx++)
            {
                RideableBoard b = boards[idx];
                if (b == null || !b.gameObject.activeSelf) continue;
                // Orphan recovery backstop: a board WE (the pool owner) now own that still claims occupied with no local
                // rider was stranded by a rider who DISCONNECTED mid-ride - VRChat reassigned it to us, but the dismount
                // that clears `occupied` never ran. Free it (the board clears + broadcasts; only its owner may) so the
                // checks below can reclaim it instead of leaking a pool slot forever. The board's own OnOwnershipTransferred
                // usually catches this the instant the handoff lands; this covers a cascade (the new owner also left). 042.
                if (b.occupied && !b.IsRiding && lp != null && Networking.IsOwner(lp, b.gameObject)) b.ClearOrphanedOccupied();
                if (b.occupied) { _spawnTime[idx] = Time.time; continue; } // in use - keep its clock fresh so it never times out
                if (IsParkedAtAPost(idx)) continue;                        // available at a gate - keep it there
                if (Time.time - _spawnTime[idx] > abandonTimeout) ReturnBoard(b.gameObject);
            }
        }

        // Return the least-recently-dispensed board that is free and not parked at a post, to make room when the pool is full.
        void ReclaimLeastRecent()
        {
            int best = -1; float bestT = 0f;
            for (int idx = 0; idx < boards.Length; idx++)
            {
                RideableBoard b = boards[idx];
                if (b == null || !b.gameObject.activeSelf || b.occupied || IsParkedAtAPost(idx)) continue;
                if (best < 0 || _spawnTime[idx] < bestT) { best = idx; bestT = _spawnTime[idx]; }
            }
            if (best >= 0) ReturnBoard(boards[best].gameObject);
        }

        // Return a FREE board to the pool. The real guard against yanking a RIDDEN board is the `occupied` check every
        // caller makes (re-checked here) - NOT OnOwnershipRequest, which only gates ownership-transfer *requests* and has
        // no say over pool.Return. We make that chain sound: take ownership first (a genuinely free board's owner allows the
        // grab - their OnOwnershipRequest returns !occupied = true), then deactivate ONLY once we ACTUALLY own it. If a
        // remote rider mounted in the sync gap (their occupied=true hasn't reached us yet) and so DENIED our grab, we won't
        // own the board, and we skip this pass rather than risk pulling it out from under them - a later sweep retries, by
        // when their occupied=true has synced and the re-check below bails. (The denied-grab -> not-owner assumption is the
        // one piece that wants in-instance verification; if a denied SetOwner still reads as owner locally, a deferred
        // return keyed on OnOwnershipTransferred would be needed instead.) See docs/vrchat/042.
        void ReturnBoard(GameObject g)
        {
            VRCPlayerApi lp = Networking.LocalPlayer;
            if (lp == null) return;
            int idx = IndexOf(g);
            if (idx >= 0 && boards[idx] != null && boards[idx].occupied) return; // mounted since the caller checked - leave it be
            if (!Networking.IsOwner(lp, g)) Networking.SetOwner(lp, g);
            if (!Networking.IsOwner(lp, g)) return; // grab didn't land (a rider denied it) - don't return a board we don't own
            pool.Return(g);
            for (int p = 0; p < _postBoard.Length; p++) if (_postBoard[p] == idx) _postBoard[p] = -1;
        }

        bool IsParkedAtAPost(int idx)
        {
            for (int p = 0; p < _postBoard.Length; p++) if (_postBoard[p] == idx) return true;
            return false;
        }

        int IndexOf(GameObject g)
        {
            if (boards == null) return -1;
            for (int i = 0; i < boards.Length; i++) if (boards[i] != null && boards[i].gameObject == g) return i;
            return -1;
        }
    }
}
