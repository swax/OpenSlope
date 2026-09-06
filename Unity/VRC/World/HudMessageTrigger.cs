using UnityEngine;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    // Local trigger for SSF MainType-12 Show message. Walking players use OnPlayerTriggerEnter; a seated rider uses the
    // rideable board's RiderProbe through OnTriggerEnter, matching every other imported contact effect.
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class HudMessageTrigger : UdonSharpBehaviour
    {
        public string Message = "";
        public Color MessageColor = Color.white;
        public float Duration = 2.5f;
        public float Delay;
        public float Cooldown = 0.25f;
        public HudMessageDisplay display;
        public int EffectSlotIndex = -1;

        [HideInInspector] public int AutoTestFireCount;
        private float _last = -999f;
        private bool _pending;

        public override void OnPlayerTriggerEnter(VRCPlayerApi player)
        {
            if (player == null || !player.isLocal) return;
            Fire();
        }

        public void OnTriggerEnter(Collider other)
        {
            if (other == null) return;
            RideableBoard board = other.GetComponentInParent<RideableBoard>();
            if (board == null || !board.IsRiding) return;
            Fire();
        }

        private void Fire()
        {
            if (_pending || Time.time - _last < Cooldown) return;
            _last = Time.time;
            if (Delay > 0.001f)
            {
                _pending = true;
                SendCustomEventDelayedSeconds(nameof(Show), Delay);
            }
            else Show();
        }

        public void Show()
        {
            _pending = false;
            if (display == null || string.IsNullOrEmpty(Message)) return;
            AutoTestFireCount++;
            display.ShowMessage(Message, MessageColor, Duration);
        }
    }
}
