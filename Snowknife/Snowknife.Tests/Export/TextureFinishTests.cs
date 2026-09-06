using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using Snowknife.Export;

namespace Snowknife.Tests.Export;

/// <summary>
/// The premultiplied-alpha detector. It is a tuned pixel-statistical heuristic — at least 3% partial-alpha
/// pixels, under 0.5% of them brighter than their own alpha — and it is applied destructively, exactly once,
/// at decode time. Both halves of that are easy to break silently: loosen it and straight-alpha foliage gets
/// its colour divided out; tighten it and every crowd sprite keeps a black rim.
/// </summary>
public class TextureFinishTests
{
    /// <summary>Store <paramref name="colour"/> premultiplied against <paramref name="alpha"/>, the way the
    /// PS2-era sprites do (RGB = trueColour x alpha, anti-aliased against black).</summary>
    static Rgba32 Premultiplied(Rgba32 colour, int alpha) => new(
        (byte)Math.Round(colour.R * alpha / 255.0),
        (byte)Math.Round(colour.G * alpha / 255.0),
        (byte)Math.Round(colour.B * alpha / 255.0),
        (byte)alpha);

    static Rgba32[] Pixels(int total, int partialCount, Func<int, Rgba32> partial, Rgba32 rest)
    {
        var pixels = new Rgba32[total];
        for (int i = 0; i < total; i++) pixels[i] = i < partialCount ? partial(i) : rest;
        return pixels;
    }

    static readonly Rgba32 OpaqueGrey = new(90, 90, 90, 255);

    [Fact]
    public void AnImageWithNoPartialAlphaBandIsLeftAlone()
    {
        var pixels = Pixels(100, 0, _ => default, OpaqueGrey);
        var before = (Rgba32[])pixels.Clone();

        Assert.False(TextureFinish.Unpremultiply(pixels));
        Assert.Equal(before, pixels);
    }

    [Fact]
    public void AnEmptyImageIsLeftAlone()
    {
        Assert.False(TextureFinish.Unpremultiply(Array.Empty<Rgba32>()));
    }

    [Fact]
    public void PremultipliedArtHasItsTrueColourDividedBackOut()
    {
        var trueColour = new Rgba32(200, 100, 50, 255);
        var pixels = Pixels(100, 10, _ => Premultiplied(trueColour, 128), OpaqueGrey);

        Assert.True(TextureFinish.Unpremultiply(pixels));

        // Integer round-tripping through a byte cannot be exact; what matters is the dark edge band is gone.
        Assert.InRange(pixels[0].R, trueColour.R - 2, trueColour.R + 2);
        Assert.InRange(pixels[0].G, trueColour.G - 2, trueColour.G + 2);
        Assert.InRange(pixels[0].B, trueColour.B - 2, trueColour.B + 2);
        Assert.Equal(128, pixels[0].A);
    }

    [Fact]
    public void StraightAlphaArtIsRecognizedAndLeftAlone()
    {
        // Cut-out foliage and translucent glass carry BRIGHT partial-alpha pixels — colour above alpha —
        // which is the signature that says this art was never premultiplied.
        var pixels = Pixels(100, 10, _ => new Rgba32(255, 255, 255, 128), OpaqueGrey);
        var before = (Rgba32[])pixels.Clone();

        Assert.False(TextureFinish.Unpremultiply(pixels));
        Assert.Equal(before, pixels);
    }

    [Fact]
    public void ThePartialAlphaBandHasToReachThreePercent()
    {
        var trueColour = new Rgba32(200, 200, 200, 255);

        var justUnder = Pixels(100, 2, _ => Premultiplied(trueColour, 128), OpaqueGrey);
        var justOver = Pixels(100, 3, _ => Premultiplied(trueColour, 128), OpaqueGrey);

        Assert.False(TextureFinish.Unpremultiply(justUnder));
        Assert.True(TextureFinish.Unpremultiply(justOver));
    }

    [Fact]
    public void EvenOneOverAlphaPixelInTwoHundredBlocksTheCorrection()
    {
        // The over-alpha allowance is under 0.5% of the partial band, so at 200 partial pixels the budget is
        // zero. This is the boundary that decides whether a mixed bank is treated as premultiplied.
        var trueColour = new Rgba32(200, 200, 200, 255);

        var clean = Pixels(400, 200, _ => Premultiplied(trueColour, 128), OpaqueGrey);
        var oneViolation = Pixels(400, 200,
            i => i == 0 ? new Rgba32(255, 255, 255, 128) : Premultiplied(trueColour, 128), OpaqueGrey);

        Assert.True(TextureFinish.Unpremultiply(clean));
        Assert.False(TextureFinish.Unpremultiply(oneViolation));
    }

    [Fact]
    public void FullyTransparentHolesAreLeftAsTheyAre()
    {
        // Below the low cut a pixel is a clipped hole; amplifying its near-zero alpha would blow the colour up.
        var trueColour = new Rgba32(200, 200, 200, 255);
        var pixels = Pixels(100, 10, _ => Premultiplied(trueColour, 128), OpaqueGrey);
        pixels[50] = new Rgba32(3, 4, 5, 2);

        Assert.True(TextureFinish.Unpremultiply(pixels));
        Assert.Equal(new Rgba32(3, 4, 5, 2), pixels[50]);
    }

    [Fact]
    public void OpaquePixelsAreUnchangedBecausePremultipliedEqualsStraightAtFullAlpha()
    {
        var trueColour = new Rgba32(200, 200, 200, 255);
        var pixels = Pixels(100, 10, _ => Premultiplied(trueColour, 128), OpaqueGrey);

        Assert.True(TextureFinish.Unpremultiply(pixels));
        Assert.Equal(OpaqueGrey, pixels[99]);
    }

    [Fact]
    public void NearOpaquePixelsAboveTheHighCutAreNotCountedAsPartial()
    {
        // At/above 250 premultiplied and straight are the same to within a byte, so those pixels neither
        // trigger the detector nor get divided.
        var pixels = Pixels(100, 50, _ => new Rgba32(90, 90, 90, 251), OpaqueGrey);
        var before = (Rgba32[])pixels.Clone();

        Assert.False(TextureFinish.Unpremultiply(pixels));
        Assert.Equal(before, pixels);
    }

    [Fact]
    public void FinishDirCorrectsPremultipliedPngsAndCountsThem()
    {
        using var temp = new TempDir();
        var trueColour = new Rgba32(200, 100, 50, 255);
        WritePng(temp.File("sprite.png"), Pixels(100, 40, _ => Premultiplied(trueColour, 128), OpaqueGrey), 10, 10);
        WritePng(temp.File("opaque.png"), Pixels(100, 0, _ => default, OpaqueGrey), 10, 10);

        Assert.Equal(1, TextureFinish.FinishDir(temp.Path));

        using var corrected = Image.Load<Rgba32>(temp.File("sprite.png"));
        Assert.InRange(corrected[0, 0].R, trueColour.R - 2, trueColour.R + 2);
    }

    [Fact]
    public void FinishDirDoesNotDescendIntoSubdirectories()
    {
        // Each decode site finishes exactly the files it wrote. The detector is not idempotent, so a nested
        // set that its own site already corrected must not be corrected a second time.
        using var temp = new TempDir();
        var trueColour = new Rgba32(200, 100, 50, 255);
        var premultiplied = Pixels(100, 40, _ => Premultiplied(trueColour, 128), OpaqueGrey);
        WritePng(temp.File("nested/sprite.png"), premultiplied, 10, 10);

        Assert.Equal(0, TextureFinish.FinishDir(temp.Path));

        using var untouched = Image.Load<Rgba32>(temp.File("nested/sprite.png"));
        Assert.Equal(premultiplied[0], untouched[0, 0]);
    }

    [Fact]
    public void FinishDirOnAMissingDirectoryIsANoOp()
    {
        using var temp = new TempDir();

        Assert.Equal(0, TextureFinish.FinishDir(Path.Combine(temp.Path, "not-there")));
    }

    static void WritePng(string path, Rgba32[] pixels, int width, int height)
    {
        using var image = Image.LoadPixelData<Rgba32>(pixels, width, height);
        image.SaveAsPng(path);
    }
}
