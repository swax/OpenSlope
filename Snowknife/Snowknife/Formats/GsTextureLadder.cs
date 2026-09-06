using System.Buffers.Binary;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;

namespace Snowknife.Formats;

/// <summary>
/// The power-of-two ladder the GS addresses a texture page on, and the ceiling one disc's headroom leaves a
/// custom page. Every page encoded from an arbitrary PNG passes through here first
/// (<see cref="Services.SshTextureService.EncodeCustomPage"/>), so an installed page always has edges the
/// hardware can address - a bare pixel size out of an authoring tool does not.
///
/// Two decisions, both the disc's rather than the author's:
///
/// - <b>Edges</b> snap DOWN the ladder, each one independently, held inside [<see cref="MinEdge"/>, ceiling].
///   A non-square tile stays non-square (96x160 -&gt; 64x128) and nothing is padded or letterboxed: terrain
///   tiles are drawn with wrapping UVs, so a padded border would show as a seam across every cell painted with
///   it, where a stretch shows as nothing at all. A source under <see cref="MinEdge"/> is the one case that
///   grows, since the ladder has no rung beneath it.
/// - The <b>ceiling</b> is the largest rung whose aggregate fits the budget the caller measures the disc by,
///   searched no lower than <see cref="NativeEdge"/> - the size retail's own terrain pages ship at, so a whole
///   bank of them is a proven load. When no rung down to there fits, the top rung stands and the pages ship at
///   their staged size: the budget is a measured proven-clean edge rather than a hardware limit
///   (docs/repack-technical-reference.md, "Borrowed and authored pages"), so halving art that would miss it
///   anyway costs quality and buys nothing the
///   caller's overage report does not say better.
///
/// Resampling is an area average: an output texel is the alpha-weighted mean of exactly the source texels its
/// own cell covers. Terrain tiles are drawn with wrapping UVs and shrunk by as much as 4x when the ceiling
/// drops, which is what picks the filter:
///
/// - The cells partition the source exactly, so no tap ever reaches outside its own cell. The output is
///   therefore the average of the periodic tile, and its wrap seam is exactly as continuous as the source's -
///   at any ratio, enlargement included. A filter whose taps reach past the cell (bicubic and Lanczos always,
///   bilinear whenever it enlarges) has to clamp at the border, and that clamp is what draws a line down the
///   middle of a tiled slope.
/// - The whole cell is integrated, so a shrink past 2x carries no alias. A two-tap filter reads the same two
///   texels however far the shrink goes and folds everything between them into moire, which on a tile is a
///   pattern the eye reads as a second, wrong repeat.
/// </summary>
internal static class GsTextureLadder
{
    /// <summary>Smallest edge a page ships at; the snap never goes below it.</summary>
    public const int MinEdge = 16;

    /// <summary>Largest edge the ladder offers, and the ceiling when the whole set fits the budget there.</summary>
    public const int MaxEdge = 512;

    /// <summary>Retail's own terrain page size. The budget search never picks a ceiling below it.</summary>
    public const int NativeEdge = 128;

    /// <summary>Snap one edge onto the ladder, held inside [<see cref="MinEdge"/>, <paramref name="ceiling"/>].</summary>
    public static int Edge(int n, int ceiling)
    {
        int rung = MinEdge;
        while (rung * 2 <= n) rung *= 2;
        return Math.Min(ceiling, Math.Max(MinEdge, rung));
    }

    /// <summary>The size a source page ships at under one ceiling.</summary>
    public static (int Width, int Height) Fit((int Width, int Height) source, int ceiling) =>
        (Edge(source.Width, ceiling), Edge(source.Height, ceiling));

    /// <summary>Aggregate GS texel cost of a set of source pages shipped under one ceiling.</summary>
    public static long Bytes(IEnumerable<(int Width, int Height)> sources, int ceiling, int bytesPerTexel) =>
        sources.Sum(source =>
        {
            var (w, h) = Fit(source, ceiling);
            return (long)w * h * bytesPerTexel;
        });

    /// <summary>
    /// The ceiling a run of custom pages ships under: the largest rung down to <see cref="NativeEdge"/> whose
    /// aggregate fits <paramref name="budget"/> in the selected format, or <see cref="MaxEdge"/> - shrinking
    /// nothing - when no rung down to there does.
    /// </summary>
    public static int Ceiling(IEnumerable<(int Width, int Height)> sources, int bytesPerTexel, long budget)
    {
        var pages = sources.ToList();
        for (int ceiling = MaxEdge; ceiling >= NativeEdge; ceiling /= 2)
            if (Bytes(pages, ceiling, bytesPerTexel) <= budget) return ceiling;
        return MaxEdge;
    }

    /// <summary>
    /// Pixel size straight out of a PNG's IHDR, so a page that already conforms never pays for a decode.
    /// </summary>
    public static (int Width, int Height) PngSize(string path)
    {
        byte[] head = new byte[24];
        using (var file = File.OpenRead(path)) file.ReadExactly(head, 0, head.Length);
        if (BinaryPrimitives.ReadUInt64BigEndian(head) != 0x89504E470D0A1A0AUL
            || System.Text.Encoding.ASCII.GetString(head, 12, 4) != "IHDR")
            throw new InvalidDataException($"{Path.GetFileName(path)} is not a PNG");
        return (BinaryPrimitives.ReadInt32BigEndian(head.AsSpan(16)),
                BinaryPrimitives.ReadInt32BigEndian(head.AsSpan(20)));
    }

    /// <summary>
    /// The PNG a page is encoded from: <paramref name="pngPath"/> itself when it already sits on the ladder
    /// under this ceiling - the encoder then reads the staged bytes untouched - or a resampled copy at
    /// <paramref name="scratch"/>, which the caller deletes once encoded. An image whose size cannot be read,
    /// or that will not decode, is handed back as it is and left to the encoder.
    /// </summary>
    public static string Conform(string pngPath, int ceiling, out string? scratch)
    {
        scratch = null;
        (int Width, int Height) source;
        try { source = PngSize(pngPath); }
        catch { return pngPath; }
        if (source.Width <= 0 || source.Height <= 0) return pngPath;

        var fit = Fit(source, ceiling);
        if (fit == source) return pngPath;

        string temp = Path.Combine(Path.GetTempPath(), "sshfit_" + Guid.NewGuid().ToString("N") + ".png");
        try
        {
            using var image = Image.Load<Rgba32>(pngPath);
            var pixels = new Rgba32[image.Width * image.Height];
            image.CopyPixelDataTo(pixels);
            using var conformed = Image.LoadPixelData<Rgba32>(
                Resample(pixels, image.Width, image.Height, fit.Width, fit.Height), fit.Width, fit.Height);
            conformed.SaveAsPng(temp);
            scratch = temp;
            return temp;
        }
        catch
        {
            try { File.Delete(temp); } catch { }
            return pngPath;
        }
    }

    // Separable area resample. Colour is accumulated alpha-weighted so a cut-out tile's transparent texels
    // cannot bleed into its visible ones; a cell with nothing opaque in it has no colour to keep.
    private static Rgba32[] Resample(Rgba32[] source, int sw, int sh, int dw, int dh)
    {
        var columns = Taps(sw, dw);
        var rows = Taps(sh, dh);
        var target = new Rgba32[dw * dh];
        for (int y = 0; y < dh; y++)
            for (int x = 0; x < dw; x++)
            {
                double r = 0, g = 0, b = 0, a = 0;
                foreach (var row in rows[y])
                    foreach (var column in columns[x])
                    {
                        var texel = source[row.Index * sw + column.Index];
                        double alpha = texel.A * row.Weight * column.Weight;
                        r += texel.R * alpha;
                        g += texel.G * alpha;
                        b += texel.B * alpha;
                        a += alpha;
                    }
                target[y * dw + x] = a <= 0 ? default
                    : new Rgba32(Round(r / a), Round(g / a), Round(b / a), Round(a));
            }
        return target;
    }

    // The source texels one output texel covers, with the fraction of its cell each covers. The cells
    // partition [0, source) exactly, so no tap ever reaches outside the image and the weights sum to one.
    private static (int Index, double Weight)[][] Taps(int source, int target)
    {
        var taps = new (int Index, double Weight)[target][];
        double cell = (double)source / target;
        for (int i = 0; i < target; i++)
        {
            double lo = i * cell, hi = lo + cell;
            int first = Math.Clamp((int)Math.Floor(lo), 0, source - 1);
            int last = Math.Clamp((int)Math.Ceiling(hi) - 1, first, source - 1);
            var row = new (int Index, double Weight)[last - first + 1];
            double total = 0;
            for (int s = first; s <= last; s++)
            {
                double covered = Math.Max(0, Math.Min(hi, s + 1) - Math.Max(lo, s));
                row[s - first] = (s, covered);
                total += covered;
            }
            for (int t = 0; t < row.Length; t++) row[t].Weight /= total;
            taps[i] = row;
        }
        return taps;
    }

    private static byte Round(double value) => (byte)Math.Clamp(Math.Round(value), 0, 255);
}
