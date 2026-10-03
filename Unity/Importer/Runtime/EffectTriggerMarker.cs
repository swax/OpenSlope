using UnityEngine;

namespace OpenSlope.Importer
{
    public sealed class EffectTriggerMarker : Marker
    {
        public GameObject[] targetObjects;
        public int[] modes;
        public float[] delays;
        public bool oneShot;
    }
}
