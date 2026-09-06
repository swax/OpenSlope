using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

namespace Snowknife.Export;

/// <summary>
/// Finishes decoded texture PNGs in place: detects premultiplied-alpha art and divides the colour back
/// out. PS2-era EA sprites (the crowd flipbook cd00..cd15 from CROWD.SSH, some signs/LCD frames) store
/// RGB = trueColour x alpha, anti-aliased against BLACK; the whole OpenSlope pipeline - and Blender, and any
/// straight-alpha viewer - composites straight alpha, so without this the dark premultiplied edge band
/// paints a black rim around every sprite. Baking the fix at decode time makes the level's Textures/ the
/// single finished set every consumer reads as-is. See Unity docs/unity/005-materials-and-alpha.md.
///
/// Applied EXACTLY ONCE per file: each decode site (`import`'s bank/crowd/skybox, ExtractParticleSprites,
/// ExportBoardTextures) finishes just the files it freshly wrote, never an already-finished set - the
/// detector is pixel-statistical, so re-running it on corrected output is not guaranteed to be a no-op.
/// </summary>
public static class TextureFinish
{
    // Partial-alpha pixels live in [Lo, Hi): below Lo is a transparent hole (clipped anyway, and
    // amplifying its near-zero alpha would blow up), at/above Hi is solid (premultiplied == straight).
    const int Lo = 8, Hi = 250;

    /// <summary>Un-premultiply every *.png directly in <paramref name="dir"/> (non-recursive, so a
    /// nested set finished by its own decode site isn't touched twice). Returns the corrected count.</summary>
    public static int FinishDir(string dir)
    {
        if (!Directory.Exists(dir)) return 0;
        int corrected = 0;
        foreach (string png in Directory.GetFiles(dir, "*.png"))
        {
            int w, h;
            Rgba32[] px;
            using (var img = Image.Load<Rgba32>(png))
            {
                w = img.Width; h = img.Height;
                px = new Rgba32[w * h];
                img.CopyPixelDataTo(px);
            }
            if (!Unpremultiply(px)) continue;
            using var outImg = Image.LoadPixelData<Rgba32>(px, w, h);
            outImg.SaveAsPng(png);
            corrected++;
        }
        return corrected;
    }

    // Premultiplied-alpha detector + fix. Signature: a real band of partial-alpha pixels AND essentially
    // none where a colour channel exceeds alpha (trueColour*alpha <= alpha always). Straight-alpha cutout
    // foliage and translucent glass both carry bright partial-alpha pixels (colour > alpha) and so are
    // left alone; opaque art has no partial band. Tuned: need >=3% partial and <0.5% over-alpha.
    public static bool Unpremultiply(Rgba32[] px)
    {
        int total = px.Length;
        if (total == 0) return false;
        int partial = 0, violations = 0;
        for (int i = 0; i < total; i++)
        {
            int a = px[i].A;
            if (a < Lo || a >= Hi) continue;
            partial++;
            int m = px[i].R;
            if (px[i].G > m) m = px[i].G;
            if (px[i].B > m) m = px[i].B;
            if (m > a + 4) violations++;             // colour exceeds alpha => not premultiplied
        }
        if (partial * 100L < total * 3L) return false;   // no meaningful partial-alpha band
        if (violations * 200L >= partial) return false;  // >=0.5% over-alpha => straight alpha, leave it

        // trueColour = storedRGB / (alpha/255), rounded and clamped. Holes (a<Lo) stay as-is; opaque
        // pixels are unchanged (premultiplied == straight at a=255).
        for (int i = 0; i < total; i++)
        {
            int a = px[i].A;
            if (a < Lo || a >= 255) continue;
            px[i].R = Un(px[i].R, a);
            px[i].G = Un(px[i].G, a);
            px[i].B = Un(px[i].B, a);
        }
        return true;
    }

    static byte Un(byte c, int a)
    {
        int v = (c * 255 + a / 2) / a;
        return (byte)(v > 255 ? 255 : v);
    }
}
