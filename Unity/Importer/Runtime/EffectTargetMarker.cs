using UnityEngine;

namespace OpenSlope.Importer
{
    public sealed class EffectTargetMarker : Marker
    {
        public Renderer[] targetRenderers;
        public Collider[] targetColliders;
        public GameObject[] installedObjects;
        public GameObject[] detachedObjects;
        public ParticleSystem[] detachedParticles;
    }
}
