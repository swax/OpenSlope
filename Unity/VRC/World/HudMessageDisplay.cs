using UnityEngine;
using UnityEngine.UI;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    // One local, head-following display for MainType-12 Show message events. The message is diagnostic: it is never
    // synchronized, and only the player whose capsule/board crossed the authoring volume sees it.
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class HudMessageDisplay : UdonSharpBehaviour
    {
        public GameObject panel;
        public Text messageText;
        public float distance = 1.55f;
        public float verticalOffset = -0.18f;

        private VRCPlayerApi _player;
        private float _hideAt = -1f;

        void Start()
        {
            _player = Networking.LocalPlayer;
            if (panel != null) panel.SetActive(false);
        }

        public void ShowMessage(string value, Color color, float seconds)
        {
            if (panel == null || messageText == null || string.IsNullOrEmpty(value)) return;
            messageText.text = value;
            messageText.color = color;
            _hideAt = Time.time + (seconds > 0.05f ? seconds : 2.5f);
            if (!panel.activeSelf) panel.SetActive(true);
            PlaceAtHead();
        }

        public override void PostLateUpdate()
        {
            if (panel == null || !panel.activeSelf) return;
            if (Time.time >= _hideAt) { panel.SetActive(false); return; }
            PlaceAtHead();
        }

        private void PlaceAtHead()
        {
            if (_player == null) { _player = Networking.LocalPlayer; if (_player == null) return; }
            VRCPlayerApi.TrackingData head = _player.GetTrackingData(VRCPlayerApi.TrackingDataType.Head);
            Vector3 forward = head.rotation * Vector3.forward;
            Vector3 up = head.rotation * Vector3.up;
            panel.transform.position = head.position + forward * distance + up * verticalOffset;
            // Unity UI's readable face is its -Z side, so +Z follows the viewer's gaze away from the head.
            panel.transform.rotation = head.rotation;
        }
    }
}
