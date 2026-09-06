using UnityEngine;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    // Local-only contact sound for a non-solid authored prop. The collider remains a trigger, so the prop never blocks;
    // crossing it on foot or on the rideable board plays the importer-attached AudioSource once with speed-scaled volume.
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class ContactSound : UdonSharpBehaviour
    {
        public float MinSpeed = 0.5f;
        public float FullVolumeSpeed = 12f;
        public float Cooldown = 0.8f;

        private AudioSource _audio;
        private float _nextPlay;

        void Start() { _audio = (AudioSource)GetComponent(typeof(AudioSource)); }

        public override void OnPlayerTriggerEnter(VRCPlayerApi player)
        {
            if (player != null && player.isLocal) PlayForSpeed(player.GetVelocity().magnitude);
        }

        public void OnTriggerEnter(Collider other)
        {
            if (other == null) return;
            RideableBoard board = other.GetComponentInParent<RideableBoard>();
            if (board != null && board.IsRiding) PlayForSpeed(board.RiderVelocity.magnitude);
        }

        private void PlayForSpeed(float speed)
        {
            if (_audio == null || _audio.clip == null || speed < MinSpeed || Time.time < _nextPlay) return;
            float t = Mathf.Clamp01((speed - MinSpeed) / Mathf.Max(0.01f, FullVolumeSpeed - MinSpeed));
            _audio.PlayOneShot(_audio.clip, 0.35f + 0.65f * t);
            _nextPlay = Time.time + Mathf.Max(0f, Cooldown);
        }
    }
}
