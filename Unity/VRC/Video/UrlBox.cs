using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.SDK3.Components;

namespace OpenSlope.VrcPlugin
{

    // The Interact backing for a "focus a URL field to pop VRChat's keyboard" button - used by the Jukebox's "Add video"
    // button (JukeboxSetup). It's driven by VRChat's Interact rather than the world-space UI laser (which doesn't
    // reliably grab a Canvas widget): point at the button and VRChat shows the "Add video to the queue" tooltip; press Use
    // and it opens VRChat's own keyboard to enter the URL (by focusing the button's always-active VRCUrlInputField).
    // Whatever you submit flows through the field's OnEndEdit -> Jukebox.OnAddSubmitted, which queues the video.
    //
    // ActivateInputField is called SYNCHRONOUSLY here on an ALREADY-ACTIVE field - that's what reliably pops VRChat's
    // keyboard (focusing a just-activated / delayed field does not). See docs/vrchat/049. Local + cosmetic (sync None); built
    // and wired by JukeboxSetup onto the Add button. (It's its own behaviour because it has to live on the button's
    // GameObject - the Interact target.)
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class UrlBox : UdonSharpBehaviour
    {
        [Tooltip("The always-active input field this box focuses to open VRChat's keyboard.")]
        public VRCUrlInputField urlField;

        public override void Interact()
        {
            if (urlField != null) urlField.ActivateInputField();
        }
    }
}
