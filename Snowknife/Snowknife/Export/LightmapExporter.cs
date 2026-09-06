using SSX_Library.EATextureLibrary;

namespace Snowknife.Export;

/// <summary>
/// Re-exports the terrain lightmaps from a level's <c>_L.ssh</c> shape file as raw RGBA PNGs that
/// carry the PS2 GS lightmap encoding intact (one PNG per lightmap, named by its shape shortname,
/// e.g. <c>0000.png</c>, matching the per-patch <c>LightmapID</c>).
///
/// SSX Tricky terrain lightmaps are FullColor (RGBA) shapes that store the game's two-term GS
/// lighting blend: <b>alpha = A_S</b> (light intensity, a smooth 76..255 gradient) and
/// <b>RGB = C_S</b> (the source-colour residual; only a faint tint, blue ~0). The terrain shader
/// reconstructs the lit result <c>(C_D - C_S) x A_S</c> from both channels (see TerrainBundle /
/// Unity docs/unity/007), so we keep them verbatim and do NOT collapse to grayscale here.
/// </summary>
internal static class LightmapExporter
{
    /// <summary>
    /// Load <paramref name="sshPath"/> and write corrected lightmap PNGs into
    /// <paramref name="levelDir"/>/Lightmaps (overwriting the library's brightened ones).
    /// Returns the number of lightmaps written, or 0 if the SSH was missing.
    /// </summary>
    public static int Export(string sshPath, string levelDir)
    {
        if (!File.Exists(sshPath))
        {
            Log.Warn($"Lightmaps: no _L.ssh at '{sshPath}' (skipping).");
            return 0;
        }

        var handler = new OldShapeHandler();
        handler.LoadShape(sshPath);

        string outDir = Path.Combine(levelDir, "Lightmaps");
        Directory.CreateDirectory(outDir);

        int n = handler.ShapeImages.Count, full = 0;
        for (int i = 0; i < n; i++)
        {
            // Write the RAW decoded RGBA: RGB = C_S (the GS source-colour residual), alpha = A_S (light
            // intensity). The authentic GS blend (C_D - C_S) x A_S reconstructed in the terrain shader
            // needs BOTH channels, so do NOT collapse to grayscale here. See the 2002 GDC "Light maps
            // on the PS2".
            if (handler.ShapeImages[i].MatrixType == OldShapeHandler.MatrixType.FullColor) full++;
            else Log.Info($"Lightmaps: shape {i} ({handler.ShapeImages[i].Shortname}) is "
                                   + $"{handler.ShapeImages[i].MatrixType}, not FullColor - C_S/A_S layout may not hold.");
            string name = handler.ShapeImages[i].Shortname;
            handler.ExtractSingleImage(Path.Combine(outDir, name + ".png"), i);
        }

        Log.Info($"Lightmaps: {n} written (raw C_S+A_S RGBA, {full} FullColor) -> {outDir}");
        return n;
    }

    /// <summary>
    /// Resolve the <c>_L.ssh</c> path for a level given the extractor's load-path stem
    /// (the .map path minus its extension), matching the two layouts the library handles.
    /// </summary>
    public static string ResolveSshPath(string loadPath)
    {
        string primary = loadPath + "_L.ssh";
        if (File.Exists(primary)) return primary;
        // Some level stems end with a trailing separator/char the library strips.
        string alt = string.Concat(loadPath.AsSpan(0, loadPath.Length - 1), "_L.ssh");
        return File.Exists(alt) ? alt : primary;
    }
}
