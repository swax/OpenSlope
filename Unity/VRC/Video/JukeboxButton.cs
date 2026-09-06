using UnityEngine;
using UdonSharp;

namespace OpenSlope.VrcPlugin
{

    // One INTERACT target for the Jukebox - the counterpart of PlayersButton, dispatching to Jukebox. VRChat's
    // world-space UI laser doesn't reliably drive a Canvas widget in-world, so every push button on the board (remove a
    // queued item, page Prev/Next, Skip, the local Screens toggle, the moderator Lock) carries a BoxCollider + this
    // behaviour: look at it and press Use/Trigger and it calls back into the jukebox. Built + wired by JukeboxSetup.
    //
    // The "Add video" button is the one exception - it uses UrlBox to focus an always-active URL field and pop VRChat's
    // keyboard; the entered URL then flows through the field's OnEndEdit -> Jukebox.OnAddSubmitted. The scrub bar is a
    // real draggable Slider (not an Interact button). See docs/vrchat/049.
    //
    // `command` selects the action; for a remove button, `slot` is the visible row index (0..pageSize-1). Local behaviour
    // here - the jukebox itself decides what's networked (sync None).
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class JukeboxButton : UdonSharpBehaviour
    {
        [Tooltip("The Jukebox this button drives.")]
        public Jukebox jukebox;

        [Tooltip("1=remove slot, 2=prev page, 3=next page, 4=skip, 5=toggle local screens, 6=cycle lock mode.")]
        public int command;

        [Tooltip("For a remove button (command 1): the visible row index to remove. Ignored otherwise.")]
        public int slot = -1;

        public override void Interact()
        {
            if (jukebox == null) return;
            if (command == 1) jukebox.RemoveSlot(slot);
            else if (command == 2) jukebox.PagePrev();
            else if (command == 3) jukebox.PageNext();
            else if (command == 4) jukebox.Skip();
            else if (command == 5) jukebox.ToggleLocalScreens();
            else if (command == 6) jukebox.CycleLock();
        }
    }
}
