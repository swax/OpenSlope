using UnityEngine;

namespace OpenSlope.BasisPlugin
{
    public class BasisAnimPoker : MonoBehaviour
    {
        public BasisAnimatedProp[] targets;
        public float intervalMin = 5f;
        public float intervalMax = 12f;
        public bool pokeEnabled = true;
        private float _next;
        void Start() { _next = Time.time + Random.Range(intervalMin, intervalMax); }
        void Update() { if (Time.time >= _next) PokeTick(); }
        public void PokeTick()
        {
            _next = Time.time + Random.Range(intervalMin, intervalMax);
            if (!pokeEnabled || targets == null) return;
            foreach (var target in targets) if (target != null) target.Poke();
        }
    }
}
