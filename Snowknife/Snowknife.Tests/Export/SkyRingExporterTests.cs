using System.Buffers.Binary;
using Snowknife.Export;

namespace Snowknife.Tests.Export;

public class SkyRingExporterTests
{
    [Fact]
    public void MeasuresGeometrySlotsAndTextureSizesFromPortableFiles()
    {
        using var temp = new TempDir();
        string skyDir = temp.File("Skybox/.keep");
        skyDir = Path.GetDirectoryName(skyDir)!;

        WritePanel(temp, 0, top: 2, bottom: 0);
        WritePanel(temp, 1, top: 0, bottom: -2);
        temp.Write("Skybox/Meshes/0002.obj", """
            v 0 0 -2
            v 10 0 -2
            v 0 10 -2
            vt 0.5 0.5
            vt 0.9 0.5
            vt 0.5 0.9
            """);
        WritePngHeader(temp, 0, 256, 128);
        WritePngHeader(temp, 1, 128, 64);
        WritePngHeader(temp, 2, 512, 512);

        SkyRingDocument ring = SkyRingExporter.Extract(skyDir);

        Assert.Equal(10, ring.Radius, 6);
        Assert.Equal(2, ring.TopZ, 6);
        Assert.Equal(0, ring.MidZ, 6);
        Assert.Equal(-2, ring.BottomZ, 6);
        Assert.Equal(2, ring.GroundIndex);
        Assert.Equal(0.4, ring.GroundUvRadius, 6);
        Assert.Equal(new[] { "upper", "lower" }, ring.Panels.Select(panel => panel.Band));
        Assert.Equal(new[] { (256, 128), (128, 64), (512, 512) },
            ring.Tiles.Select(tile => (tile.Width, tile.Height)));
    }

    [Fact]
    public void ACornerOnTheSeamMeasuresAsTheSeamItself()
    {
        // A rebuilt seam corner sits a hair below the axis (sin π is not zero), which Atan2 reads as -179.99999.
        using var temp = new TempDir();
        string skyDir = Path.GetDirectoryName(temp.File("Skybox/.keep"))!;
        WritePanel(temp, 0, top: 2, bottom: 0, from: (-10, -1e-5), to: (-7.0710678, 7.0710678));
        WritePanel(temp, 1, top: 0, bottom: -2, from: (-7.0710678, -7.0710678), to: (-10, -1e-5));
        temp.Write("Skybox/Meshes/0002.obj", """
            v 0 0 -2
            v 10 0 -2
            v 0 10 -2
            vt 0.5 0.5
            vt 0.9 0.5
            vt 0.5 0.9
            """);
        for (int index = 0; index < 3; index++) WritePngHeader(temp, index, 64, 64);

        SkyRingDocument ring = SkyRingExporter.Extract(skyDir);

        Assert.Equal(180, ring.Panels[0].AzFrom);
        Assert.Equal(135, ring.Panels[0].AzTo, 4);
        Assert.Equal(-135, ring.Panels[1].AzFrom, 4);
        Assert.Equal(180, ring.Panels[1].AzTo);
    }

    private static void WritePanel(TempDir temp, int index, double top, double bottom,
        (double X, double Y)? from = null, (double X, double Y)? to = null)
    {
        var (x0, y0) = from ?? (10, 0);
        var (x1, y1) = to ?? (0, 10);
        temp.Write($"Skybox/Meshes/{index:D4}.obj", FormattableString.Invariant($"""
            v {x0} {y0} {top}
            v {x1} {y1} {top}
            v {x0} {y0} {bottom}
            v {x1} {y1} {bottom}
            vt 0 0
            vt 1 0
            vt 0 1
            vt 1 1
            """));
    }

    private static void WritePngHeader(TempDir temp, int index, int width, int height)
    {
        byte[] header = new byte[24];
        new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }.CopyTo(header, 0);
        BinaryPrimitives.WriteUInt32BigEndian(header.AsSpan(16, 4), (uint)width);
        BinaryPrimitives.WriteUInt32BigEndian(header.AsSpan(20, 4), (uint)height);
        temp.Write($"Skybox/Textures/{index:D4}.png", header);
    }
}
