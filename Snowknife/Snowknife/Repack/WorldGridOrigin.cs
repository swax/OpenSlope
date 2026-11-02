using System.Numerics;
using SSX_Library.FileHandlers.LevelFiles.Tricky;

namespace Snowknife.Repack;

/// <summary>Keep the lookup origin consistent with the cells generated on whole grid boundaries.</summary>
internal static class WorldGridOrigin
{
    public static void Align(LTGHandler grid)
    {
        if (!float.IsFinite(grid.mainBboxSize) || grid.mainBboxSize <= 0)
            throw new InvalidDataException("Invalid world-grid cell size.");
        // RegenerateCentreLTG builds cells from floor(bounds / cellSize), while
        // retaining the unsnapped geometry bounds in the header. The game subtracts
        // that header origin directly when selecting a cell, including rider lighting.
        var low = grid.WorldBounds1;
        low.X = MathF.Floor(low.X / grid.mainBboxSize) * grid.mainBboxSize;
        low.Y = MathF.Floor(low.Y / grid.mainBboxSize) * grid.mainBboxSize;
        var high = grid.WorldBounds2;
        high.X = low.X + grid.pointerCount * grid.mainBboxSize;
        high.Y = low.Y + grid.pointerListCount * grid.mainBboxSize;
        grid.WorldBounds1 = low;
        grid.WorldBounds2 = high;
        grid.WorldBounds3 = (low + high) * .5f;
    }
}
