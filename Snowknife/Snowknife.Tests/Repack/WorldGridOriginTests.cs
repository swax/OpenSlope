using System.Numerics;
using Snowknife.Repack;
using SSX_Library.FileHandlers.LevelFiles.Tricky;
using SSX_Library.FileHandlers.LevelFiles.Tricky.PS2;

namespace Snowknife.Tests.Repack;

public class WorldGridOriginTests
{
    [Theory]
    [InlineData(-205143f, -46841f)]
    [InlineData(2317f, 1841f)]
    [InlineData(-20000f, -30000f)]
    public void RuntimeLookupFindsTheGeneratedPatchAndLights(float x, float y)
    {
        var point = new Vector3(x, y, 200);
        var pbd = new PBDHandler();
        pbd.Patches.Add(new Patch { LowestXYZ = point - new Vector3(10), HighestXYZ = point + new Vector3(10) });
        pbd.lights.Add(new Light
        {
            Type = 3, Colour = new Vector3(.3f), LowestXYZ = point - new Vector3(500), HighestXYZ = point + new Vector3(500),
        });
        var grid = new LTGHandler();
        grid.RegenerateCentreLTG(pbd);
        WorldGridOrigin.Align(grid);
        var savedLow = grid.WorldBounds1;
        WorldGridOrigin.Align(grid);
        Assert.Equal(savedLow, grid.WorldBounds1);
        using var temp = new TempDir();
        grid.SaveLTGFile(temp.File("course.ltg"));
        var loaded = new LTGHandler();
        loaded.LoadLTG(temp.File("course.ltg"));

        int mainX = (int)((point.X - loaded.WorldBounds1.X) / loaded.mainBboxSize);
        int mainY = (int)((point.Y - loaded.WorldBounds1.Y) / loaded.mainBboxSize);
        Assert.NotEqual(0, loaded.offsetList![mainX, mainY]);
        int nodeX = (int)((point.X - loaded.WorldBounds1.X - mainX * loaded.mainBboxSize) / loaded.nodeBoxSize);
        int nodeY = (int)((point.Y - loaded.WorldBounds1.Y - mainY * loaded.mainBboxSize) / loaded.nodeBoxSize);
        var node = loaded.mainBboxes![mainX, mainY].nodeBBoxes[nodeX, nodeY];
        Assert.Equal(new[] { 0 }, node.PatchIndex);
        Assert.Equal(new[] { 0 }, node.LightCrossingIndex);
        Assert.Empty(node.LightIndex);
        int entries = 0;
        foreach (var main in loaded.mainBboxes)
            if (main.nodeBBoxes != null)
                foreach (var child in main.nodeBBoxes) entries += child.PatchIndex.Count;
        Assert.Equal(1, entries); // Lighting coverage must not multiply terrain render submissions.
        Assert.Equal(point.Z - 500, loaded.WorldBounds1.Z);
        Assert.Equal(point.Z + 500, loaded.WorldBounds2.Z);
    }
}
