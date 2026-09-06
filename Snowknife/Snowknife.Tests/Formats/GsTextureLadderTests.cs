using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using Snowknife.Formats;

namespace Snowknife.Tests.Formats;

/// <summary>
/// The power-of-two ladder every custom texture page is snapped onto, and the budget search that picks the
/// ceiling. Two decisions the disc makes rather than the author, both invisible until a repacked disc either
/// misses its budget or draws a seam down a tiled slope — which is a long way from the code that caused it.
/// </summary>
public class GsTextureLadderTests
{
    [Theory]
    [InlineData(512, 512)]
    [InlineData(300, 256)]
    [InlineData(256, 256)]
    [InlineData(255, 128)]
    [InlineData(160, 128)]
    [InlineData(96, 64)]
    [InlineData(64, 64)]
    [InlineData(17, 16)]
    [InlineData(16, 16)]
    public void AnEdgeSnapsDownToTheRungBelowIt(int source, int expected)
    {
        Assert.Equal(expected, GsTextureLadder.Edge(source, GsTextureLadder.MaxEdge));
    }

    [Theory]
    [InlineData(15)]
    [InlineData(4)]
    [InlineData(1)]
    public void AnEdgeUnderTheSmallestRungGrowsToMeetIt(int source)
    {
        // The one case that enlarges: the ladder has no rung beneath MinEdge.
        Assert.Equal(GsTextureLadder.MinEdge, GsTextureLadder.Edge(source, GsTextureLadder.MaxEdge));
    }

    [Fact]
    public void AnEdgeIsHeldUnderTheCeiling()
    {
        Assert.Equal(128, GsTextureLadder.Edge(1024, 128));
        Assert.Equal(64, GsTextureLadder.Edge(300, 64));
    }

    [Fact]
    public void ANonSquareTileStaysNonSquare()
    {
        // Each edge snaps independently. Padding to square would draw a seam across every cell painted with
        // the tile, because terrain tiles are drawn with wrapping UVs.
        Assert.Equal((64, 128), GsTextureLadder.Fit((96, 160), GsTextureLadder.MaxEdge));
        Assert.Equal((256, 16), GsTextureLadder.Fit((300, 20), GsTextureLadder.MaxEdge));
    }

    [Fact]
    public void AggregateCostIsTheSumOfEachPageAtItsFittedSize()
    {
        var pages = new[] { (Width: 300, Height: 300), (Width: 96, Height: 160) };

        // 256x256 + 64x128 at 4 bytes per texel.
        Assert.Equal(256L * 256 * 4 + 64L * 128 * 4, GsTextureLadder.Bytes(pages, GsTextureLadder.MaxEdge, 4));
    }

    [Fact]
    public void ALowerCeilingNeverCostsMore()
    {
        var pages = new[] { (Width: 512, Height: 512), (Width: 300, Height: 96), (Width: 40, Height: 700) };

        long previous = long.MaxValue;
        for (int ceiling = GsTextureLadder.MaxEdge; ceiling >= GsTextureLadder.MinEdge; ceiling /= 2)
        {
            long cost = GsTextureLadder.Bytes(pages, ceiling, 4);
            Assert.True(cost <= previous, $"ceiling {ceiling} cost {cost}, more than the rung above it");
            previous = cost;
        }
    }

    [Fact]
    public void TheTopRungStandsWhenTheWholeSetAlreadyFits()
    {
        var pages = new[] { (Width: 512, Height: 512) };
        long exact = 512L * 512 * 4;

        Assert.Equal(GsTextureLadder.MaxEdge, GsTextureLadder.Ceiling(pages, 4, exact));
    }

    [Fact]
    public void TheCeilingDropsToTheLargestRungThatFits()
    {
        var pages = new[] { (Width: 512, Height: 512) };

        Assert.Equal(256, GsTextureLadder.Ceiling(pages, 4, 512L * 512 * 4 - 1));
        Assert.Equal(128, GsTextureLadder.Ceiling(pages, 4, 256L * 256 * 4 - 1));
    }

    [Fact]
    public void TheSearchNeverGoesBelowRetailsOwnPageSize()
    {
        // Below NativeEdge the budget is a measured proven-clean edge rather than a hardware limit, so
        // halving art that would miss it anyway costs quality and buys nothing. The top rung stands instead.
        var pages = new[] { (Width: 512, Height: 512) };

        Assert.Equal(GsTextureLadder.MaxEdge, GsTextureLadder.Ceiling(pages, 4, 0));
        Assert.Equal(GsTextureLadder.MaxEdge, GsTextureLadder.Ceiling(pages, 4, 128L * 128 * 4 - 1));
    }

    [Fact]
    public void AnEmptySetFitsAnyBudgetAtTheTopRung()
    {
        Assert.Equal(GsTextureLadder.MaxEdge,
            GsTextureLadder.Ceiling(Array.Empty<(int, int)>(), 4, 0));
    }

    [Fact]
    public void PngSizeReadsStraightFromTheIhdr()
    {
        using var temp = new TempDir();
        string path = temp.File("page.png");
        using (var image = new Image<Rgba32>(96, 160)) image.SaveAsPng(path);

        Assert.Equal((96, 160), GsTextureLadder.PngSize(path));
    }

    [Fact]
    public void PngSizeRejectsAFileThatIsNotAPng()
    {
        using var temp = new TempDir();

        Assert.Throws<InvalidDataException>(() =>
            GsTextureLadder.PngSize(temp.Write("page.png", new byte[64])));
    }

    [Fact]
    public void APageAlreadyOnTheLadderIsHandedBackUntouched()
    {
        // No decode, no scratch file — the encoder reads the staged bytes as they are.
        using var temp = new TempDir();
        string path = temp.File("page.png");
        using (var image = new Image<Rgba32>(128, 64)) image.SaveAsPng(path);

        string conformed = GsTextureLadder.Conform(path, GsTextureLadder.MaxEdge, out string? scratch);

        Assert.Equal(path, conformed);
        Assert.Null(scratch);
    }

    [Fact]
    public void APageOffTheLadderIsResampledToAScratchCopy()
    {
        using var temp = new TempDir();
        string path = temp.File("page.png");
        using (var image = new Image<Rgba32>(96, 160)) image.SaveAsPng(path);

        string conformed = GsTextureLadder.Conform(path, GsTextureLadder.MaxEdge, out string? scratch);

        try
        {
            Assert.NotNull(scratch);
            Assert.Equal(scratch, conformed);
            Assert.NotEqual(path, conformed);
            Assert.Equal((64, 128), GsTextureLadder.PngSize(conformed));
        }
        finally { if (scratch != null) File.Delete(scratch); }
    }

    [Fact]
    public void AnUnreadableImageIsHandedBackForTheEncoderToDealWith()
    {
        using var temp = new TempDir();

        string conformed = GsTextureLadder.Conform(temp.Write("page.png", new byte[64]),
            GsTextureLadder.MaxEdge, out string? scratch);

        Assert.Equal(temp.File("page.png"), conformed);
        Assert.Null(scratch);
    }

    [Fact]
    public void ResamplingAFlatColourReproducesItExactly()
    {
        // The area filter integrates whole cells, so a constant source has to come back constant — no ringing
        // at the border the way a filter with taps outside its cell would give.
        using var temp = new TempDir();
        var colour = new Rgba32(200, 100, 50, 255);
        string path = temp.File("flat.png");
        using (var image = new Image<Rgba32>(96, 96, colour)) image.SaveAsPng(path);

        string conformed = GsTextureLadder.Conform(path, GsTextureLadder.MaxEdge, out string? scratch);

        try
        {
            using var resampled = Image.Load<Rgba32>(conformed);
            Assert.Equal(64, resampled.Width);
            for (int y = 0; y < resampled.Height; y++)
                for (int x = 0; x < resampled.Width; x++)
                    Assert.Equal(colour, resampled[x, y]);
        }
        finally { if (scratch != null) File.Delete(scratch); }
    }

    [Fact]
    public void TransparentTexelsDoNotDarkenTheirOpaqueNeighbours()
    {
        // Colour is accumulated alpha-weighted. Without that, a cell straddling the cut-out edge would average
        // the transparent black in and leave a dark rim exactly where the art is thinnest.
        using var temp = new TempDir();
        string path = temp.File("cutout.png");
        using (var image = new Image<Rgba32>(96, 16))
        {
            for (int y = 0; y < 16; y++)
                for (int x = 0; x < 96; x++)
                    image[x, y] = x < 50 ? new Rgba32(255, 0, 0, 255) : new Rgba32(0, 0, 0, 0);
            image.SaveAsPng(path);
        }

        string conformed = GsTextureLadder.Conform(path, GsTextureLadder.MaxEdge, out string? scratch);

        try
        {
            using var resampled = Image.Load<Rgba32>(conformed);
            Assert.Equal((64, 16), (resampled.Width, resampled.Height));
            for (int y = 0; y < resampled.Height; y++)
                for (int x = 0; x < resampled.Width; x++)
                {
                    var texel = resampled[x, y];
                    if (texel.A == 0) continue;
                    Assert.Equal(255, texel.R);          // still fully saturated red
                    Assert.Equal(0, texel.G);
                    Assert.Equal(0, texel.B);
                }
        }
        finally { if (scratch != null) File.Delete(scratch); }
    }
}
