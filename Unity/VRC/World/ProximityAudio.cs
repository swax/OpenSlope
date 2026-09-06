using UnityEngine;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// Local listener gate for retail ADL crowd and environmental loops. The original keeps ExternalSounds in a spatial
    /// grid and updates only nearby voices; this single 2 Hz Udon loop does the equivalent small-N distance pass. Distant
    /// AudioSources remain stopped, avoiding decoder/mixer/virtual-voice cost on Quest while preserving each emitter.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class ProximityAudio : UdonSharpBehaviour
    {
        public AudioSource[] sources;
        public float pollSeconds = 0.5f;

        private VRCPlayerApi _player;

        void Start()
        {
            _player = Networking.LocalPlayer;
            AudioTick();
        }

        public void AudioTick()
        {
            SendCustomEventDelayedSeconds(nameof(AudioTick), Mathf.Max(0.1f, pollSeconds));
            if (_player == null) { _player = Networking.LocalPlayer; if (_player == null) return; }
            Vector3 listener = _player.GetPosition();
            int n = sources == null ? 0 : sources.Length;
            for (int i = 0; i < n; i++)
            {
                AudioSource src = sources[i];
                if (src == null) continue;
                float r = src.maxDistance;
                bool want = (src.transform.position - listener).sqrMagnitude < r * r;
                if (want) { if (!src.isPlaying) src.Play(); }
                else if (src.isPlaying) src.Stop();
            }
        }

        void OnDisable()
        {
            int n = sources == null ? 0 : sources.Length;
            for (int i = 0; i < n; i++) if (sources[i] != null) sources[i].Stop();
        }
    }
}
