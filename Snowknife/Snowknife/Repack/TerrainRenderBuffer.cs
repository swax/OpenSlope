using System.Buffers.Binary;
using System.Globalization;
using System.Text;
using Snowknife.Services;

namespace Snowknife.Repack;

/// <summary>Size the per-frame terrain submission pool for a complete authored course.</summary>
internal static class TerrainRenderBuffer
{
    public const int StockCapacity = 2048;
    private const int RecordBytes = 24;
    private const int PageBytes = 65536;
    private const int MaxPages = 16;

    public static int RequiredPages(int patches)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(patches);
        if (patches <= StockCapacity) return 0;
        long pages = ((long)patches * RecordBytes + PageBytes - 1) / PageBytes;
        if (pages > MaxPages)
            throw new InvalidDataException("Terrain needs more than the supported 1 MiB submission buffer; reduce the patch count.");
        return (int)pages;
    }

    /// <summary>Recognize only our paired, matching allocation and initialization instructions.</summary>
    public static int InstalledPages(IReadOnlyList<byte[]> current, IReadOnlyList<ElfPatchService.Region> regions)
    {
        if (current.Count != 2 || regions.Count != 2)
            throw new InvalidDataException("Terrain-buffer definition needs its allocation and initialization regions.");
        int pages = -1;
        for (int i = 0; i < 2; i++)
        {
            if (current[i].Length != sizeof(uint) || regions[i].Patched.Length != sizeof(uint))
                throw new InvalidDataException("Invalid terrain-buffer instruction length.");
            uint word = BinaryPrimitives.ReadUInt32LittleEndian(current[i]);
            uint template = BinaryPrimitives.ReadUInt32LittleEndian(regions[i].Patched);
            int value = (int)(word & ushort.MaxValue);
            if ((word >> 16) != (template >> 16) || value is < 1 or > MaxPages || (pages != -1 && value != pages))
                throw new InvalidDataException("Terrain-buffer allocation and initialization are modified or inconsistent; rebuild from a clean ISO.");
            pages = value;
        }
        return pages;
    }

    public static byte[] Instruction(ElfPatchService.Region region, int pages)
    {
        if (pages is < 1 or > MaxPages) throw new ArgumentOutOfRangeException(nameof(pages));
        byte[] bytes = (byte[])region.Patched.Clone();
        BinaryPrimitives.WriteUInt16LittleEndian(bytes, (ushort)pages);
        return bytes;
    }

    public static string Pcsx2Patch(IReadOnlyList<uint> addresses, IReadOnlyList<byte[]> instructions)
    {
        if (addresses.Count != instructions.Count || addresses.Count != 2)
            throw new InvalidDataException("Terrain-buffer patch needs two executable addresses.");
        var text = new StringBuilder("// Snowknife terrain submission capacity\n");
        for (int i = 0; i < addresses.Count; i++)
            text.Append(CultureInfo.InvariantCulture,
                $"patch=0,EE,{addresses[i]:X8},word,{BinaryPrimitives.ReadUInt32LittleEndian(instructions[i]):X8}\n");
        return text.ToString();
    }
}
