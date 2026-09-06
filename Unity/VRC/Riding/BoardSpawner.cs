using UnityEngine;
using UdonSharp;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// A start-gate post: a clickable pole that asks the shared board pool for a board at this post (docs/vrchat/042, Stage 2).
    /// One board sits AVAILABLE in front of each post; ride it away (a <see cref="RideableBoard"/>), then look at the
    /// POST and Use/click to have the next board dropped in its place. Clicking the post while a free board is still
    /// sitting there SWAPS it for a different board from the pool, so you can click through to browse the deck variety
    /// (the old board returns to the pool - no pile-up).
    ///
    /// This post holds NO boards of its own anymore - it just forwards a request (its own index) through the synced
    /// <see cref="BoardRequest"/> mailbox to the pool's owner (the master), which runs the dispense/cap/reclaim policy
    /// (<see cref="BoardManager"/>). Networked: every client sees the same boards, owned and posed by whoever spawned/
    /// rides them. Sync None here because the post itself carries no state - the request object + the boards do.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class BoardSpawner : UdonSharpBehaviour
    {
        [Tooltip("The shared synced mailbox that forwards this post's click to the master's dispenser. Wired by " +
                 "StartGateSetup.")]
        public BoardRequest request;
        [Tooltip("This post's index into the dispenser's anchors[] (which post asked). Set by StartGateSetup.")]
        public int postIndex;

        public override void Interact()
        {
            if (request == null) return;
            request.Request(postIndex);
        }
    }
}
