using DiscUtils.Iso9660;
using SSX_Library.EATextureLibrary; // OldShapeHandler (.SSH decode)
using Snowknife.Export;

namespace Snowknife.Services;

/// <summary>
/// Decodes the shared, level-independent sprite banks the engine swaps in at runtime: the crowd animation
/// (DATA\TEXTURES\CROWD.SSH) and the particle sprite bank (DATA\TEXTURES\PARTICLE.SSH). Both are referenced by
/// effect TYPE, not a per-level index, so they are pulled straight from the ISO. Shared by `import` and `shared`.
/// </summary>
internal sealed class ParticleService
{
    private readonly IsoService _iso;

    public ParticleService(IsoService iso) => _iso = iso;

    // Standalone re-decode of the shared particle sprite bank into <levelDir>/Textures/Particles/. The bank is
    // also pulled during `import`, but the effects reference it by TYPE (not a per-level index), so it's the same
    // shared art for every level - this lets you regenerate just the sprites without a full level re-export.
    // <levelDir> is the level's export folder (e.g. Maps\MYLEVEL).
    public int Particles(string[] args)
    {
        if (args.Length < 3) { Log.Error("particles needs <iso> <levelDir>"); return 1; }
        string iso = args[1];
        string levelDir = Path.GetFullPath(args[2]);

        Log.Info("Decoding particle sprites from DATA\\TEXTURES\\PARTICLE.SSH...");
        int n = ExtractParticleSprites(iso, levelDir);
        Log.Info($"  Particles: {n} sprite(s) -> {Path.Combine(levelDir, "Textures", "Particles")}");
        return 0;
    }

    // Decode the shared crowd animation out of the ISO into <outDir>/Textures/cd00..cdNN.png.
    // CROWD.SSH is the "SHPS" (old PS2) variant -> OldShapeHandler. Non-fatal if absent.
    public int ExtractCrowdFrames(string iso, string outDir)
    {
        string texturesDir = Path.Combine(outDir, "Textures");
        Directory.CreateDirectory(texturesDir);
        string tmpSsh = Path.Combine(Path.GetTempPath(), "snowknife_crowd_" + Guid.NewGuid().ToString("N") + ".ssh");
        try
        {
            using (FileStream isoStream = File.OpenRead(iso))
            {
                CDReader cd = _iso.OpenIso(isoStream);
                var file = _iso.FindIsoFile(cd, @"DATA\TEXTURES\CROWD.SSH");
                if (file == null) { Log.Info("      (CROWD.SSH not in ISO - crowd billboards will stay flat.)"); return 0; }
                using Stream s = file.OpenRead();
                using FileStream d = File.Create(tmpSsh);
                s.CopyTo(d);
            }

            var shape = new OldShapeHandler();
            shape.LoadShape(tmpSsh);
            int n = shape.ShapeImages.Count;
            for (int i = 0; i < n; i++)
            {
                // The crowd frames are stored half-bright and premultiplied against black. *2-brighten
                // every frame to restore full-range colour for the in-game crowd. The import-time
                // un-premultiply (TexturePostprocessor) runs after this and reads the brightened
                // interior (255, not ~128).
                shape.BrightenImage(i);
                shape.ExtractSingleImage(Path.Combine(texturesDir, "cd" + i.ToString("D2") + ".png"), i);
            }
            Log.Info($"      Crowd: decoded {n} frames (cd00..cd{(n - 1):D2}.png) from CROWD.SSH");
            return n;
        }
        finally { if (File.Exists(tmpSsh)) File.Delete(tmpSsh); }
    }

    // Decode the shared particle sprite bank (DATA\TEXTURES\PARTICLE.SSH) into <outDir>/Textures/Particles/<name>.png.
    // The level's particle effects (Fog_*, snow, fireworks...) reference these sprites by effect TYPE, not by any
    // index stored in the .pbd - so, exactly like CROWD.SSH, we pull the shared bank from the ISO. It's the same
    // "SHPS" variant -> OldShapeHandler. Names come from the bank (fog0, clod, snfl, halo, ...); fog0 is the
    // start-line clouds. Non-fatal if absent (older/region discs without the bank).
    public int ExtractParticleSprites(string iso, string outDir)
    {
        string spritesDir = Path.Combine(outDir, "Textures", "Particles");
        Directory.CreateDirectory(spritesDir);
        string tmpSsh = Path.Combine(Path.GetTempPath(), "snowknife_particle_" + Guid.NewGuid().ToString("N") + ".ssh");
        try
        {
            using (FileStream isoStream = File.OpenRead(iso))
            {
                CDReader cd = _iso.OpenIso(isoStream);
                var file = _iso.FindIsoFile(cd, @"DATA\TEXTURES\PARTICLE.SSH");
                if (file == null) { Log.Info("      (PARTICLE.SSH not in ISO - particle effects will have no sprite.)"); return 0; }
                using Stream s = file.OpenRead();
                using FileStream d = File.Create(tmpSsh);
                s.CopyTo(d);
            }

            var shape = new OldShapeHandler();
            shape.LoadShape(tmpSsh);
            int n = shape.ShapeImages.Count;
            int brightened = 0;
            for (int i = 0; i < n; i++)
            {
                // The sprite bank holds a per-image mix: half-bright glow art (the ex06-09 explosion
                // frames) that the *2 restores to full range, and sprites already stored full-range (fog0,
                // envr, the spray/trail/needle sprites). Brighten with the guard so each sprite doubles
                // only when its own opaque texels are half-bright. The sprites are straight-alpha, which
                // the un-premultiply below passes through.
                if (shape.BrightenImage(i, guard: true)) brightened++;
                shape.ExtractSingleImage(Path.Combine(spritesDir, shape.ShapeImages[i].Shortname + ".png"), i);
            }
            // Decode-time premultiply fix (TextureFinish): the ex06-09 explosion frames are premultiplied
            // and get divided back out; the rest of the bank is straight-alpha and passes through untouched.
            TextureFinish.FinishDir(spritesDir);
            Log.Info($"      Particles: decoded {n} sprites (fog0, clod, snfl, ...) from PARTICLE.SSH -> Textures/Particles/ "
                              + $"({brightened} half-bright *2-brightened, {n - brightened} already full-range left as-is)");
            return n;
        }
        finally { if (File.Exists(tmpSsh)) File.Delete(tmpSsh); }
    }
}
