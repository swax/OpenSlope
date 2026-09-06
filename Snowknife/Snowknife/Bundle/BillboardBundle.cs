using Snowknife.Export;

namespace Snowknife.Bundle;

/// <summary>
/// Carries the map folder's <c>Billboards.json</c> — the course's video-ready screen rectangles — into the
/// bundle manifest, so a consumer builds its overlay quads from one resolved list instead of searching the
/// prop geometry itself (Unity docs/vrchat/041).
///
/// Both kinds of map arrive the same way: <see cref="BillboardsExporter"/> writes the document from the placed
/// prop geometry of an extracted course, and Slopesmith writes it for an authored one. Everything is already in
/// bundle mesh space, so this is a pass-through with the document's own validity as the only gate.
/// </summary>
public static class BillboardBundle
{
    public static BundleManifest.BillboardsInfo? Build(string levelDir)
    {
        var document = BillboardsDocument.Load(levelDir);
        if (document?.Screens == null || document.Screens.Count == 0) return null;

        var info = new BundleManifest.BillboardsInfo();
        var named = new HashSet<string>(StringComparer.Ordinal);
        int unnamed = 0;
        foreach (var screen in document.Screens)
        {
            if (screen.Center.Length < 3 || screen.Normal.Length < 3 || screen.Up.Length < 3) continue;
            if (!(screen.Width > 0f) || !(screen.Height > 0f)) continue;
            // A consumer names an object after this, and a duplicate would collide once every family is
            // flattened into one container, so a repeat is suffixed rather than dropped.
            string name = string.IsNullOrWhiteSpace(screen.Name) ? "Screen_" + unnamed++ : screen.Name;
            string unique = name;
            for (int n = 2; !named.Add(unique); n++) unique = name + "_" + n;
            info.Screens.Add(new BundleManifest.BillboardScreenInfo
            {
                Name = unique,
                Family = string.IsNullOrWhiteSpace(screen.Family) ? null : screen.Family,
                Center = screen.Center,
                Normal = screen.Normal,
                Up = screen.Up,
                Width = screen.Width,
                Height = screen.Height,
                Instance = screen.Instance,
                Page = string.IsNullOrWhiteSpace(screen.Page) ? null : screen.Page,
            });
        }
        if (info.Screens.Count == 0) return null;
        Log.Info($"  Billboards: {info.Screens.Count} {document.Source} screen(s).");
        return info;
    }
}
