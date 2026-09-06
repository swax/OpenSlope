using Basis;
using Basis.Network.Core;

namespace OpenSlope.BasisPlugin
{

    // The first OpenSlope Basis networked behaviour: a fire-and-forget SHARED EVENT. A transient one-shot that any client can
    // trigger locally and have every OTHER client replay - the Basis analogue of the VRChat SendCustomNetworkEvent(All)
    // the gems, fireworks and ambient bursts use (docs/vrchat/043). Subclass it, do the effect locally on the local
    // trigger and call Broadcast(); implement OnRemoteEvent() to replay it when a remote fires.
    //
    // Basis vs VRChat: Basis's SendCustomNetworkEvent(recipients = null) means "everyone but self" - it does NOT loop back
    // to the sender - so the trigger runs its effect directly and remotes get it through OnNetworkMessage; there's no
    // self-echo, so none of the VRChat dedupe window is needed. The NetworkID is derived from the object's stable
    // hierarchy path (identical on every client because a level imports identically), so it identifies WHICH object fired.
    // Most events carry a 1-byte ping; a subsystem may use the overload to carry a small contact frame. ReliableOrdered
    // means a one-shot and its payload are never separated or reordered.
    //
    // Offline / not yet connected: HasNetworkID is false, so Broadcast() no-ops and only the local effect runs - solo play
    // is unchanged. BasisNetworkBehaviour.Start()/OnDestroy() do the async ID + ownership wiring, so a subclass that needs
    // its own Start/OnDestroy MUST call base.Start()/base.OnDestroy().
    public abstract class BasisNetEvent : BasisNetworkBehaviour
    {
        static readonly byte[] Ping = new byte[] { 1 };

        // Replay this event on every OTHER client. Call right AFTER doing the effect locally. No-op until networked
        // (offline / pre-connect), where the local effect alone is the whole behaviour.
        protected void Broadcast()
        {
            if (HasNetworkID) SendCustomNetworkEvent(Ping, DeliveryMethod.ReliableOrdered);
        }

        protected void Broadcast(byte[] payload)
        {
            if (HasNetworkID && payload != null && payload.Length > 0)
                SendCustomNetworkEvent(payload, DeliveryMethod.ReliableOrdered);
        }

        // A remote client triggered this event - the shared effect is replayed here (the NetworkID already told the
        // transport which object; the default handler ignores a ping while payload-aware subclasses override it).
        public override void OnNetworkMessage(ushort playerId, byte[] buffer, DeliveryMethod deliveryMethod)
        {
            OnRemoteEvent(buffer);
        }

        protected virtual void OnRemoteEvent(byte[] buffer) { OnRemoteEvent(); }

        // Replay the effect on receipt of a remote broadcast. Do the LOCAL-only parts (score award, the collector's own
        // chime) in the trigger handler instead, not here.
        protected abstract void OnRemoteEvent();
    }
}
