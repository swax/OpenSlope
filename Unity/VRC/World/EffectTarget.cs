using UnityEngine;
using UdonSharp;

namespace OpenSlope.VrcPlugin
{
    // Installed nodes and detached emitters/movers have different lifetimes. Mode 2 leaves detached
    // work alive; mode 3 additionally retires it. [Trailmap: 230-level-ssf]
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class EffectTarget : UdonSharpBehaviour
    {
        public Renderer[] targetRenderers = new Renderer[0];
        public Collider[] targetColliders = new Collider[0];
        public AnimatedPropU[] animations = new AnimatedPropU[0];
        public FlipbookAnimator[] flipbooks = new FlipbookAnimator[0];
        public AmbientEmitter[] ambient = new AmbientEmitter[0];
        public SplineMover[] movers = new SplineMover[0];
        public ParticleSystem[] detachedParticles = new ParticleSystem[0];
        [HideInInspector] public int generation;
        private bool[] _rendered;
        private bool[] _collided;
        private bool[] _emitting;
        private bool[] _moving;
        private bool _stopped;
        private bool _detachedStopped;

        public void Apply(int mode)
        {
            if (mode < 0 || mode > 4) return;
            if (!_stopped)
            {
                _rendered = new bool[targetRenderers.Length];
                _collided = new bool[targetColliders.Length];
                for (int i = 0; i < targetRenderers.Length; i++) if (targetRenderers[i] != null) _rendered[i] = targetRenderers[i].enabled;
                for (int i = 0; i < targetColliders.Length; i++) if (targetColliders[i] != null) _collided[i] = targetColliders[i].enabled;
                SetStopped(true);
                SetMaterialTime(Time.time);
                _stopped = true;
            }
            generation++;
            if (mode >= 2)
            {
                for (int i = 0; i < targetRenderers.Length; i++) if (targetRenderers[i] != null) targetRenderers[i].enabled = false;
                for (int i = 0; i < targetColliders.Length; i++) if (targetColliders[i] != null) targetColliders[i].enabled = false;
            }
            if (mode == 3 && !_detachedStopped)
            {
                _emitting = new bool[detachedParticles.Length];
                for (int i = 0; i < detachedParticles.Length; i++)
                {
                    var ps = detachedParticles[i]; if (ps == null) continue;
                    _emitting[i] = ps.isPlaying;
                    ps.Stop(false, ParticleSystemStopBehavior.StopEmitting);
                }
                _moving = new bool[movers.Length];
                for (int i = 0; i < movers.Length; i++) if (movers[i] != null)
                {
                    _moving[i] = movers[i].gameObject.activeSelf;
                    movers[i].gameObject.SetActive(false);
                }
                _detachedStopped = true;
            }
        }

        public void RestoreGeneration(int expected) { if (generation == expected) Restore(); }

        public void Restore()
        {
            if (!_stopped) return;
            for (int i = 0; i < targetRenderers.Length; i++) if (targetRenderers[i] != null) targetRenderers[i].enabled = _rendered[i];
            for (int i = 0; i < targetColliders.Length; i++) if (targetColliders[i] != null) targetColliders[i].enabled = _collided[i];
            SetStopped(false); SetMaterialTime(-1f);
            for (int i = 0; i < animations.Length; i++) if (animations[i] != null) animations[i].ResetToStart();
            if (_detachedStopped)
            {
                for (int i = 0; i < detachedParticles.Length; i++) if (_emitting[i] && detachedParticles[i] != null) detachedParticles[i].Play(false);
                for (int i = 0; i < movers.Length; i++) if (_moving[i] && movers[i] != null) movers[i].ResetEffect();
            }
            _stopped = false; _detachedStopped = false;
        }

        void SetStopped(bool value)
        {
            for (int i = 0; i < animations.Length; i++) if (animations[i] != null) animations[i].effectStopped = value;
            for (int i = 0; i < flipbooks.Length; i++) if (flipbooks[i] != null) flipbooks[i].effectStopped = value;
            for (int i = 0; i < ambient.Length; i++) if (ambient[i] != null) ambient[i].effectStopped = value;
        }

        void SetMaterialTime(float value)
        {
            for (int i = 0; i < targetRenderers.Length; i++)
            {
                var renderer = targetRenderers[i]; if (renderer == null) continue;
                var materials = renderer.sharedMaterials;
                for (int s = 0; s < materials.Length; s++)
                    if (materials[s] != null && materials[s].HasProperty("_EffectTime")) materials[s].SetFloat("_EffectTime", value);
            }
        }
    }
}
