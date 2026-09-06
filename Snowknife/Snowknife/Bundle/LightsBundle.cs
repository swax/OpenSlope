using System.Numerics;
using Newtonsoft.Json;

namespace Snowknife.Bundle;

/// <summary>
/// Surfaces a level's global lighting from <c>Lights.json</c> into <c>manifest.Sun</c>: the directional
/// sun (Type 0) and the ambient/sky fill (Type 3). The terrain itself is lit by the baked lightmaps; this
/// is the sun the importer uses to orient the scene's Directional Light + tilt the light probes (so a
/// custom level lights its dynamic objects from its own authored sun, not a fixed config). The directional
/// <c>Direction</c> in <c>Lights.json</c> is the raw-space PROPAGATION (from-light) vector; we negate it
/// to TO-LIGHT and map raw → Unity world the same way geometry does (<c>(-rawX, rawZ, -rawY)</c>), which
/// nets out to <c>(px, -pz, py)</c>.
/// </summary>
public static class LightsBundle
{
    public static BundleManifest.SunInfo? Build(string levelDir)
    {
        string path = Path.Combine(levelDir, "Lights.json");
        if (!File.Exists(path)) return null;
        LightsFile? parsed;
        try { parsed = JsonConvert.DeserializeObject<LightsFile>(File.ReadAllText(path)); }
        catch (Exception e)
        {
            Log.Warn($"  WARN: {path} is unreadable ({e.Message}) — no authored sun.");
            return null;
        }
        if (parsed?.Lights == null) return null;

        LightRec? dir = null, amb = null;
        foreach (var l in parsed.Lights)
        {
            if (l == null) continue;
            if (l.Type == 0 && dir == null) dir = l;      // SD_Di_Directional - the sun
            else if (l.Type == 3 && amb == null) amb = l; // DY_Am_Ambient - the sky fill
        }
        if (dir == null && amb == null) return null;

        var sun = new BundleManifest.SunInfo();
        if (dir?.Direction is { Length: >= 3 } p)
        {
            // raw propagation -> Unity-world to-light: negate to to-light, then raw->Unity (-x, z, -y)
            var v = Vector3.Normalize(new Vector3(p[0], -p[2], p[1]));
            sun.Direction = new[] { v.X, v.Y, v.Z };
        }
        if (dir?.Colour is { Length: >= 3 } c) sun.Colour = new[] { c[0], c[1], c[2] };
        if (amb?.Colour is { Length: >= 3 } a) sun.Ambient = new[] { a[0], a[1], a[2] };
        Log.Info($"  Sun: dir [{sun.Direction[0]:0.00},{sun.Direction[1]:0.00},{sun.Direction[2]:0.00}] " +
                          $"colour [{sun.Colour[0]:0.00},{sun.Colour[1]:0.00},{sun.Colour[2]:0.00}] ambient [{sun.Ambient[0]:0.00},{sun.Ambient[1]:0.00},{sun.Ambient[2]:0.00}].");
        return sun;
    }

    // Newtonsoft populates these fields through reflection; direct assignments would only add DTO boilerplate.
#pragma warning disable CS0649
    class LightsFile { public List<LightRec>? Lights; }
    class LightRec { public int Type; public float[]? Colour; public float[]? Direction; }
#pragma warning restore CS0649
}
