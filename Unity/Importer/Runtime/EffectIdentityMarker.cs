namespace OpenSlope.Importer
{
    // Import-time identity for joining separately built render, collision, and detached effect objects.
    public sealed class EffectIdentityMarker : Marker
    {
        [ImporterOnly] public int index = -1;
        [ImporterOnly] public bool detached;
    }
}
