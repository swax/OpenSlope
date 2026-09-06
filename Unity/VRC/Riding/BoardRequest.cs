using UnityEngine;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// A tiny synced "mailbox" that routes a start-gate post click to the board pool's owner (the master), carrying WHICH
    /// post asked (docs/vrchat/042, Stage 2). VRCObjectPool can only be spawned from by its owner, so a non-master clicker can't
    /// spawn directly - instead it stamps a request here and lets the master act on it.
    ///
    /// Flow: the clicker takes ownership of THIS object, writes the post index + bumps a nonce, and serializes. Every
    /// non-owner (which includes the master) then gets <see cref="OnDeserialization"/> and forwards the index to the
    /// <see cref="BoardManager"/>, which ignores it unless IT is the pool owner. If the clicker happens to already BE
    /// the pool owner (the master clicked their own post), they won't receive their own deserialization, so
    /// <see cref="Request"/> calls the manager directly in that case.
    ///
    /// Manual sync (we only send on an explicit click). The nonce guarantees the synced data CHANGES even when the same
    /// post is clicked twice in a row, so the deserialization always fires. Ownership floats to whoever clicked last -
    /// that's fine, it's just a mailbox; the master never needs to own it (and must not, or it wouldn't hear its own
    /// deserialization).
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.Manual)]
    public class BoardRequest : UdonSharpBehaviour
    {
        [Tooltip("The pool dispenser this mailbox forwards post requests to. Wired by StartGateSetup.")]
        public BoardManager manager;

        [UdonSynced] private int _postIndex = -1;    // which post asked for a board (kind 0)
        [UdonSynced] private int _summonPlayer = -1; // which player summoned one over the shoulder with none of their own (kind 1)
        [UdonSynced] private int _kind;              // 0 = a post asked for a board, 1 = a player summoned one
        [UdonSynced] private int _nonce;             // bumped each request so the synced state always changes -> always deserializes

        // Called by a post (BoardSpawner.Interact) on the clicking client.
        public void Request(int postIndex)
        {
            VRCPlayerApi lp = Networking.LocalPlayer;
            if (lp == null || manager == null) return;
            if (!Networking.IsOwner(lp, gameObject)) Networking.SetOwner(lp, gameObject);
            _kind = 0;
            _postIndex = postIndex;
            _nonce++;
            RequestSerialization();
            // We won't get our own OnDeserialization, so if we're already the pool owner, act on it directly here.
            if (manager.IsPoolOwner()) manager.OnRequest(postIndex);
        }

        // Called by BoardSummon on the summoning client when they reached over their shoulder and had NO board of their
        // own to recall. The master dispenses a fresh one and stamps their claim on it; the summoner's own client takes it
        // from there (it's already hunting for a board claimed by it), so nothing needs to come back the other way.
        public void Summon(int playerId)
        {
            VRCPlayerApi lp = Networking.LocalPlayer;
            if (lp == null || manager == null) return;
            if (!Networking.IsOwner(lp, gameObject)) Networking.SetOwner(lp, gameObject);
            _kind = 1;
            _summonPlayer = playerId;
            _nonce++;
            RequestSerialization();
            // We won't get our own OnDeserialization, so if we're already the pool owner, act on it directly here.
            if (manager.IsPoolOwner()) manager.OnSummon(playerId);
        }

        // Fires on every client EXCEPT the one that sent it - including the master. The manager no-ops unless this client
        // owns the pool, so effectively only the master acts.
        public override void OnDeserialization()
        {
            if (manager == null) return;
            if (_kind == 1) manager.OnSummon(_summonPlayer);
            else manager.OnRequest(_postIndex);
        }
    }
}
