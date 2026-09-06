using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Basis contact sound for a non-solid authored prop. Basis does not expose VRChat-style player trigger callbacks,
    // so this follows the other Basis world triggers and polls the walking-player / active-board point against the box.
    public sealed class BasisContactSound : MonoBehaviour
    {
        public float MinSpeed = 0.5f;
        public float FullVolumeSpeed = 12f;
        public float Cooldown = 0.8f;

        BoxCollider _box;
        AudioSource _audio;
        bool _wasInside;
        float _nextPlay;

        void Start()
        {
            _box = GetComponent<BoxCollider>();
            _audio = GetComponent<AudioSource>();
        }

        void Update()
        {
            if (_box == null) return;
            var board = BasisBoard.LocalRider;
            bool inside = BasisLocalPlayerProbe.InsideBox(_box);
            Vector3 velocity;
            if (board != null)
            {
                inside |= BasisLocalPlayerProbe.PointInBox(_box, board.transform.position);
                velocity = board.RiderVelocity;
                if (velocity.sqrMagnitude < 1e-4f) BasisLocalPlayerProbe.TryGetVelocity(out velocity);
            }
            else BasisLocalPlayerProbe.TryGetVelocity(out velocity);

            if (inside && !_wasInside) PlayForSpeed(velocity.magnitude);
            _wasInside = inside;
        }

        void PlayForSpeed(float speed)
        {
            if (_audio == null || _audio.clip == null || speed < MinSpeed || Time.time < _nextPlay) return;
            float t = Mathf.Clamp01((speed - MinSpeed) / Mathf.Max(0.01f, FullVolumeSpeed - MinSpeed));
            _audio.PlayOneShot(_audio.clip, 0.35f + 0.65f * t);
            _nextPlay = Time.time + Mathf.Max(0f, Cooldown);
        }
    }
}
