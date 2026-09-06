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

    private static void WritePanel(TempDir temp, int index, double top, double bottom)
    {
        temp.Write($"Skybox/Meshes/{index:D4}.obj", $"""
            v 10 0 {top}
            v 0 10 {top}
            v 10 0 {bottom}
            v 0 10 {bottom}
            vt 0 0
            vt 1 0
            vt 0 1
            vt 1 1
            """);
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
