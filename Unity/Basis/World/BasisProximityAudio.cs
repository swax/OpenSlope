using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Basis counterpart of ProximityAudio: one throttled local listener pass starts only native retail crowd and
    // environmental sources inside their authored radii. It uses the same default 2 Hz cadence as the VRC/Udon port.
    public class BasisProximityAudio : MonoBehaviour
    {
        public AudioSource[] sources;
        public float pollSeconds = 0.5f;
        private float _nextPoll;

        void Update()
        {
            if (Time.time < _nextPoll) return;
            _nextPoll = Time.time + Mathf.Max(0.1f, pollSeconds);
            if (!BasisLocalPlayerProbe.TryGetPosition(out Vector3 listener)) return;
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
