using UnityEngine;
using UnityEngine.UI;

namespace OpenSlope.Importer
{

    // Neutral hand-off for MainType-12 debug HUD text. The importer builds one local display plus a trigger for every
    // owning collision instance; the platform wiring pass realizes these into its own per-player runtime behaviours.
    public sealed class HudMessageDisplayMarker : Marker
    {
        public GameObject panel;
        public Text messageText;
        public float distance = 1.55f;
        public float verticalOffset = -0.18f;
    }

    public sealed class HudMessageMarker : Marker
    {
        public string Message = "";
        public Color MessageColor = Color.white;
        public float Duration = 2.5f;
        public float Delay;
        public float Cooldown = 0.25f;
        public GameObject displayObject; // resolved to HudMessageDisplay after every marker has been realized
        public int EffectSlotIndex = -1;
    }
}
