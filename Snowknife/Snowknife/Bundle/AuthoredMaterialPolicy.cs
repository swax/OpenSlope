namespace Snowknife.Bundle;

/// <summary>
/// Small, package-free rules shared by bundle material resolution and the suite that pins it.
/// Slopesmith's authored OBJ dialect appends an object-part identity to a material slot so
/// the disc packer can preserve moving submeshes; that suffix is metadata, not a new material.
/// Authored custom materials likewise have no native SSX appearance-flags word, so their
/// conventional PNG alpha is authoritative instead of the neutral zero written to Materials.json.
/// </summary>
public static class AuthoredMaterialPolicy
{
    public static string StripObjectSuffix(string slot)
    {
        int marker = slot.LastIndexOf("_obj", StringComparison.Ordinal);
        if (marker < 0 || marker + 4 == slot.Length) return slot;

        for (int i = marker + 4; i < slot.Length; i++)
            if (!char.IsAsciiDigit(slot[i])) return slot;

        return slot.Substring(0, marker);
    }

    public static bool UsesPixelAlpha(string? materialName) =>
        materialName?.StartsWith("model_Custom_", StringComparison.OrdinalIgnoreCase) == true;
}
