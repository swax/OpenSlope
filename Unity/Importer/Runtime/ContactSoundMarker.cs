// Neutral hand-off for a pass-through authored prop with a contact sound. CollisionBuilder creates the trigger
// volume + AudioSource; the platform wiring pass realizes the small local-only player/board trigger behaviour.

namespace OpenSlope.Importer
{
    public sealed class ContactSoundMarker : Marker
    {
        public float MinSpeed = 0.5f;
        public float FullVolumeSpeed = 12f;
        public float Cooldown = 0.8f;
    }
}
