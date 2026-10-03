using UnityEngine;

namespace OpenSlope.BasisPlugin
{
    public class BasisRailGate : BasisNetEvent
    {
        public BasisRailNetwork railNetwork;
        public BasisAnimatedProp[] animations = new BasisAnimatedProp[0];
        public int[] rails = new int[0];
        public bool[] railEnabled = new bool[0];
        private bool[] _initial;
        public float[] delays = new float[0];
        public float Cooldown = 1f;
        public float respawnDelay = 30f;
        public bool networked = true;
        private float _started = -999f;
        private float _finishAt;
        private bool _running;
        private int _next;
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
            _finishAt = _started + (delays.Length > 0 ? delays[delays.Length - 1] : 0f) + respawnDelay;
            _initial = new bool[rails.Length];
            for (int i = 0; i < rails.Length; i++) _initial[i] = railNetwork != null && railNetwork.IsRailEnabled(rails[i]);
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
            int count = rails.Length;
            while (_next < count && Time.time - _started >= (_next < delays.Length ? delays[_next] : 0f))
            {
                if (railNetwork != null) railNetwork.SetRailEnabled(rails[_next],
                    _next < railEnabled.Length ? railEnabled[_next] : true);
                _next++;
            }
        }
        public void Restore()
        {
            if (!_running) return;
            for (int i = 0; i < rails.Length; i++) if (railNetwork != null) railNetwork.SetRailEnabled(rails[i], _initial[i]);
            for (int i = 0; i < animations.Length; i++) if (animations[i] != null) animations[i].ResetToStart();
            _running = false;
        }
        public void EnableRails() { Fire(); } // Existing scene/event compatibility.
    }
}
