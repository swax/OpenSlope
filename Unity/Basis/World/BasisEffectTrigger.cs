using UnityEngine;

namespace OpenSlope.BasisPlugin
{
    public class BasisEffectTrigger : BasisNetEvent
    {
        public BasisEffectTarget[] targets = new BasisEffectTarget[0];
        public int[] modes = new int[0];
        public bool oneShot;
        public float[] delays = new float[0];
        public float Cooldown = 1f;
        public float respawnDelay = 30f;
        public bool networked = true;
        private float _started = -999f;
        private float _finishAt;
        private bool _running;
        private int _next;
        private int[] _generations;
        private BoxCollider _volume;
        private bool _inside;
        public override void Start() { base.Start(); _volume = GetComponent<BoxCollider>(); }
        protected override void OnRemoteEvent() { Fire(); }
        void Cross()
        {
            if (_running || Time.time - _started < Cooldown) return;
            Fire(); if (networked) Broadcast();
        }

        public void Fire()
        {
            if (_running || Time.time - _started < Cooldown) return;
            _started = Time.time; _running = true; _next = 0;
            _generations = new int[targets.Length];
            _finishAt = _started + (delays.Length > 0 ? delays[delays.Length - 1] : 0f) + respawnDelay;
            Advance();
        }
        void Update()
        {
            bool inside = BasisLocalPlayerProbe.InsideBox(_volume);
            if (inside && !_inside) Cross();
            _inside = inside;
            if (!_running) return;
            Advance();
            if (respawnDelay > 0f && Time.time >= _finishAt) Restore();
        }
        void Advance()
        {
            int count = targets.Length;
            while (_next < count && Time.time - _started >= (_next < delays.Length ? delays[_next] : 0f))
            {
                if (targets[_next] != null && _next < modes.Length)
                {
                    targets[_next].Apply(modes[_next]);
                    _generations[_next] = targets[_next].generation;
                }
                _next++;
            }
        }
        public void Restore()
        {
            if (!_running) return;
            for (int i = 0; i < _next; i++) if (targets[i] != null) targets[i].RestoreGeneration(_generations[i]);
            _running = false;
        }
    }
}
