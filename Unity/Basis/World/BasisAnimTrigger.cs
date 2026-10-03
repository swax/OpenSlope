using UnityEngine;

namespace OpenSlope.BasisPlugin
{
    [RequireComponent(typeof(BoxCollider))]
    public class BasisAnimTrigger : BasisNetEvent
    {
        public BasisAnimatedProp target;
        public bool poke;
        public bool combo;
        public bool networked = true;
        public float Cooldown = 1f;
        public float delay;
        public float rearmDelay;
        private float _rearmAt = -999f;
        private BoxCollider _volume;
        private bool _inside;
        private bool _pending;
        private float _due;
        private float _last = -999f;
        public override void Start() { base.Start(); _volume = GetComponent<BoxCollider>(); }
        void Update()
        {
            bool inside = BasisLocalPlayerProbe.InsideBox(_volume);
            if (inside && !_inside && Time.time - _last >= Cooldown && !_pending)
            { Fire(); if (networked) Broadcast(); }
            _inside = inside;
            if (_pending && Time.time >= _due) { _pending = false; Play(); }
        }
        protected override void OnRemoteEvent() { Fire(); }
        public void Fire()
        {
            if (_pending || Time.time - _last < Cooldown || Time.time < _rearmAt) return;
            _rearmAt = Time.time + rearmDelay;
            _last = Time.time;
            if (delay > 0f) { _pending = true; _due = Time.time + delay; }
            else Play();
        }
        void Play()
        {
            if (target == null) return;
            if (combo) target.TriggerCombo(); else if (poke) target.Poke(); else target.Trigger();
        }
    }
}
