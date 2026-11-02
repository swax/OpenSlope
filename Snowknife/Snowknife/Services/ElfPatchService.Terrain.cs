using Newtonsoft.Json.Linq;
using Snowknife.Repack;

namespace Snowknife.Services;

internal sealed partial class ElfPatchService
{
    // The fixed submission pool has no overflow check. Size for every patch rather than predicting camera
    // visibility, and change allocation and initialization together. Evidence: [Trailmap: 400-terrain-buffer].
    public int EnsureTerrainCapacity(string iso, int patches, ModManagerPackage? package, bool dryRun)
    {
        int required = TerrainRenderBuffer.RequiredPages(patches);
        if (required == 0) return 0;
        const string name = "terrain-buffer";
        using var fs = new FileStream(iso, FileMode.Open, package == null && !dryRun ? FileAccess.ReadWrite : FileAccess.Read);
        if (!TryLoadPatchForIso(fs, name, name, out var doc, out _)) return 1;
        var regions = ParseRegions(doc, name);
        if (!TryLocateExe(fs, doc, name, out long lba)) return 1;
        byte[][] current = regions.Select(region => ReadRegion(fs, lba, region)).ToArray();
        bool pristine = regions.Select((region, i) => Sha256Hex(current[i]) == region.OriginalSha256).All(value => value);
        int pages = pristine ? required : Math.Max(required, TerrainRenderBuffer.InstalledPages(current, regions));
        byte[][] instructions = regions.Select(region => TerrainRenderBuffer.Instruction(region, pages)).ToArray();
        Log.Info($"  terrain buffer: {patches:n0} patches covered by {pages * 64:n0} KiB (stock: 2,048 submissions)");
        if (dryRun) return 0;
        if (package != null)
        {
            uint[] addresses = ((JArray)doc["runtimeAddresses"]!).Select(token => (uint)token).ToArray();
            package.AddPcsx2Patch(TerrainRenderBuffer.Pcsx2Patch(addresses, instructions));
        }
        else
        {
            if (pristine) SaveRestorePoint(iso, name, regions.Select((region, i) => (region.Offset, current[i])));
            for (int i = 0; i < regions.Length; i++)
                if (!current[i].AsSpan().SequenceEqual(instructions[i])) WriteRegion(fs, lba, regions[i], instructions[i]);
        }
        return 0;
    }
}
