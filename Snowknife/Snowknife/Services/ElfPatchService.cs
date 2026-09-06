using System.Buffers.Binary;
using System.Security.Cryptography;
using Newtonsoft.Json.Linq;

namespace Snowknife.Services;

/// <summary>
/// Executable byte-patching inside an ISO (noclip fly mode / authored HUD text / per-course sky colour). Each patch
/// file (Patches/&lt;name&gt;.&lt;target&gt;.json) describes its regions as (file offset, length, SHA-256 of the bytes it
/// expects to replace, bytes to write). The digest is what makes apply verify-before-write: an unknown executable or
/// a half-patched image is refused untouched. The bytes being replaced come from the user's own disc and are not part
/// of the patch file — apply saves them next to the ISO as &lt;iso&gt;.snowknife-restore.json, and --revert writes those
/// back after re-checking them against the same digest, so the executable is restored byte-exactly.
///
/// A region may also carry <see cref="Graft"/> windows. Those are the one part of a payload that is not in the patch
/// file: a trampoline hook has to re-execute whatever its branch displaced, and those instructions belong to the game,
/// so the file names where to copy each one from in the executable being patched instead of reproducing it. Grafts are
/// resolved before the first write, while the sites they read from are still intact.
/// </summary>
internal sealed class ElfPatchService
{
    private readonly IsoService _iso;

    public ElfPatchService(IsoService iso) => _iso = iso;

    /// <summary>
    /// One window inside a region's payload that is copied out of the executable being patched rather than
    /// carried in the patch file. A trampoline hook has to re-execute the instructions its branch displaced,
    /// and those words are the game's, not this project's — so the patch file names where to find them
    /// (<paramref name="FromFileOffset"/>, an offset into the same executable) instead of reproducing them.
    /// Until apply fills one in, the window reads as MIPS <c>break</c>, so a reader that ignored grafts would
    /// produce an executable that traps at the hook rather than one that quietly skipped the displaced work.
    /// </summary>
    internal sealed record Graft(int At, long FromFileOffset, int Length);

    internal sealed record Region(long Offset, int Length, string OriginalSha256, byte[] Patched, Graft[] Grafts);

    public int Noclip(string[] args)
    {
        if (args.Length < 2) { Log.Error("noclip needs <iso> [--revert] [--from <clean.iso>]"); return 1; }
        return Apply(args[1], "noclip", "noclip-fly-mode", args.Contains("--revert"), ParseOptions(args).RestoreFrom);
    }

    // Everything after "<cmd> <iso>": bare words are positional, "--from <path>" names a clean image to recover
    // the pre-patch bytes from, and any other "--flag" is handled by the caller.
    private static (string[] Positional, string? RestoreFrom) ParseOptions(string[] args)
    {
        var positional = new List<string>();
        string? from = null;
        for (int i = 2; i < args.Length; i++)
        {
            if (args[i] == "--from" && i + 1 < args.Length) { from = args[++i]; continue; }
            if (args[i].StartsWith("--")) continue;
            positional.Add(args[i]);
        }
        return (positional.ToArray(), from);
    }

    // Override one course's WorldConf sky RGB. The patch installs a load-time hook and a 13-entry RGB table.
    // On first application, that table is reconstructed from constant stores in this executable's own WorldConf
    // initializer; repeated calls update only the named course's entry. The stock loader still normalizes the
    // integers and sends them through the stock graphics setter.
    // Engine patch points: [Trailmap: 442-sky-color].
    public int SkyColor(string[] args)
    {
        bool revert = args.Contains("--revert");
        var (positional, restoreFrom) = ParseOptions(args);
        if (args.Length < 2 || (!revert && positional.Length != 2))
        { Log.Error("skycolor needs <iso> <LEVEL|0-12> <#rrggbb> [--revert] [--from <clean.iso>]"); return 1; }

        string iso = args[1];
        using var fs = new FileStream(iso, FileMode.Open, FileAccess.ReadWrite);
        if (!TryLoadPatchForIso(fs, "sky-color", "skycolor", out var doc, out _)) return 1;
        var regions = ParseRegions(doc, "sky-color");
        var table = doc["table"]!;
        int tableRegion = (int)table["region"]!;
        int entrySize = (int)table["entrySize"]!;
        var slots = (JArray)table["slots"]!;

        int slot = -1;
        byte[] rgb = new byte[3];
        if (!revert)
        {
            string level = positional[0].ToUpperInvariant();
            if (!int.TryParse(level, out slot))
                slot = slots.Select((name, i) => (name: (string?)name, i))
                            .FirstOrDefault(x => string.Equals(x.name, level, StringComparison.OrdinalIgnoreCase), (null, -1)).i;
            if (slot < 0 || slot >= slots.Count)
            {
                string names = string.Join(", ", slots.Select(x => (string?)x));
                Log.Error($"skycolor: '{positional[0]}' is not a course slot ({names} or 0-{slots.Count - 1}).");
                return 1;
            }
            if (!TryParseColour(positional[1], rgb))
            { Log.Error($"skycolor: '{positional[1]}' is not a #rrggbb colour."); return 1; }
        }

        if (!TryLocateExe(fs, doc, "skycolor", out long lba)) return 1;

        var current = regions.Select(r => ReadRegion(fs, lba, r)).ToArray();

        int tableBytes = slots.Count * entrySize;
        bool clean = current.Select((cur, i) => Sha256Hex(cur) == regions[i].OriginalSha256).All(x => x);
        bool parameterized = current.Select((cur, i) => i == tableRegion
                ? cur.AsSpan(tableBytes).SequenceEqual(regions[i].Patched.AsSpan(tableBytes))
                : MatchesOutsideGrafts(cur, regions[i]))
            .All(x => x);

        if (revert)
        {
            if (clean) { Log.Info("skycolor: already reverted."); return 0; }
            if (!parameterized) return UnknownSkyPatchState(regions);
            if (restoreFrom != null && !SeedRestorePoint(restoreFrom, iso, doc, "sky-color", regions, "skycolor")) return 1;
            if (!TryLoadRestorePoint(iso, "sky-color", regions, "skycolor", out var originals)) return 1;
            for (int i = 0; i < regions.Length; i++) WriteRegion(fs, lba, regions[i], originals[i]);
            Log.Info("skycolor: reverted - the original per-course sky colours are back.");
            return 0;
        }

        if (!clean && !parameterized) return UnknownSkyPatchState(regions);

        byte[] nextTable = clean
            ? BuildSkyTableFromExecutable(fs, lba, table, tableBytes, regions[tableRegion])
            : (byte[])current[tableRegion].Clone();
        rgb.CopyTo(nextTable, slot * entrySize);
        var writes = new List<(int region, byte[] data)>();
        if (clean)
            // Grafts are read here, before the loop below writes anything: on a clean image the hook site
            // still holds the two words this patch displaces and has to re-run.
            for (int i = 0; i < regions.Length; i++) writes.Add((i, i == tableRegion ? nextTable : Resolve(fs, lba, regions[i])));
        else if (!current[tableRegion].AsSpan().SequenceEqual(nextTable))
            writes.Add((tableRegion, nextTable));

        if (writes.Count == 0)
        { Log.Info($"skycolor: {slots[slot]} already uses #{Convert.ToHexString(rgb).ToLowerInvariant()}."); return 0; }
        if (clean) SaveRestorePoint(iso, "sky-color", regions.Select((r, i) => (r.Offset, current[i])));
        foreach (var (region, data) in writes) WriteRegion(fs, lba, regions[region], data);
        Log.Info($"skycolor: {slots[slot]} (slot {slot}) sky set to #{Convert.ToHexString(rgb).ToLowerInvariant()}.");
        return 0;
    }

    private static int UnknownSkyPatchState(Region[] regions)
    {
        Log.Error($"skycolor: patch regions at executable offset 0x{regions[0].Offset:x} are mixed or unexpected - image is not in a known state; aborting untouched.");
        return 1;
    }

    // Build the initial parameter table from the supported executable itself. The public patch definition carries
    // only this extraction recipe and the result's digest: no channel value is stored in the repository. Both
    // supported builds use a straight-line MIPS initializer that materializes their WorldConf records in an fp-
    // relative frame. A deliberately small constant-propagation pass recovers only those stores; the digest makes
    // the pass fail closed if a target or compiler layout ever differs from the vetted build.
    private static byte[] BuildSkyTableFromExecutable(
        FileStream fs, long lba, JToken table, int tableBytes, Region tableRegion)
    {
        var seed = table["seed"] as JObject
            ?? throw new InvalidDataException("sky-color: table has no local executable seed recipe.");
        if ((string?)seed["kind"] != "mips-worldconf-initializer")
            throw new InvalidDataException("sky-color: table seed recipe is not supported.");

        long initializerOffset = (long)seed["fileOffset"]!;
        int instructionCount = (int)seed["instructionCount"]!;
        int recordStride = (int)seed["recordStride"]!;
        int[] channelOffsets = ((JArray)seed["channelOffsets"]!).Select(x => (int)x).ToArray();
        int slotCount = table["slots"]!.Count();
        string expected = (string)seed["sha256"]!;
        if (instructionCount <= 0 || channelOffsets.Length == 0 || slotCount * channelOffsets.Length != tableBytes)
            throw new InvalidDataException("sky-color: table seed recipe dimensions are inconsistent.");

        byte[] instructions = new byte[checked(instructionCount * sizeof(uint))];
        fs.Seek(lba * 2048L + initializerOffset, SeekOrigin.Begin);
        fs.ReadExactly(instructions);
        byte[] derived = ExtractMipsWorldConfigTable(instructions, slotCount, recordStride, channelOffsets);
        if (Sha256Hex(derived) != expected)
            throw new InvalidDataException("sky-color: the executable initializer did not derive the verified per-course table; aborting untouched.");

        byte[] result = (byte[])tableRegion.Patched.Clone();
        if (result.Length < derived.Length)
            throw new InvalidDataException("sky-color: the parameter-table region is smaller than its derived seed.");
        derived.CopyTo(result, 0);
        return result;
    }

    /// <summary>
    /// Read one course slot's world-configuration record out of the executable in an ISO — the block that
    /// carries the celestial glare beside the sky colour ([Trailmap: 442-sky-color]). Read-only: the image is
    /// opened for reading and nothing is written back.
    ///
    /// This shares the sky-colour patch's per-build recipe, because that is where the location of the record
    /// initializer for each supported executable already lives; keeping one copy is what stops the two from
    /// drifting. It also reuses that recipe's digest as an integrity gate: the same recovered frame is asked
    /// to reproduce the verified sky-colour table first, so an executable whose initializer does not decode
    /// exactly as expected yields nothing rather than plausible-looking noise.
    /// </summary>
    public bool TryReadWorldConfig(string isoPath, string slotName, out WorldConfig config, out string error)
    {
        config = null!;
        error = "";
        using var fs = new FileStream(isoPath, FileMode.Open, FileAccess.Read);
        if (!TryLoadPatchForIso(fs, "sky-color", "world", out var doc, out _))
        { error = "this disc's executable has no world-configuration recipe."; return false; }
        if (!TryLocateExe(fs, doc, "world", out long lba))
        { error = "could not locate the supported executable in this image."; return false; }

        var table = doc["table"]!;
        var seed = (table["seed"] as JObject) ?? throw new InvalidDataException("world: table has no initializer recipe.");
        var slots = (JArray)table["slots"]!;
        int slot = slots.Select((name, i) => (name: (string?)name, i))
                        .FirstOrDefault(x => string.Equals(x.name, slotName, StringComparison.OrdinalIgnoreCase), (null, -1)).i;
        if (slot < 0)
        { error = $"'{slotName}' is not a course slot ({string.Join(", ", slots.Select(x => (string?)x))})."; return false; }

        long initializerOffset = (long)seed["fileOffset"]!;
        int instructionCount = (int)seed["instructionCount"]!;
        int recordStride = (int)seed["recordStride"]!;
        int[] channelOffsets = ((JArray)seed["channelOffsets"]!).Select(x => (int)x).ToArray();

        byte[] instructions = new byte[checked(instructionCount * sizeof(uint))];
        fs.Seek(lba * 2048L + initializerOffset, SeekOrigin.Begin);
        fs.ReadExactly(instructions);

        // Fail closed: prove the pass decodes THIS executable correctly by rederiving the verified sky table
        // from the same instruction stream before trusting anything else it recovered.
        byte[] skyTable = ExtractMipsWorldConfigTable(instructions, slots.Count, recordStride, channelOffsets);
        if (Sha256Hex(skyTable) != (string)seed["sha256"]!)
        { error = "the executable initializer did not decode as expected; refusing to guess its world configuration."; return false; }

        var frame = ExtractMipsFrameWords(instructions);
        config = new WorldConfig
        {
            Course = slotName.ToUpperInvariant(),
            Glare = WorldConfig.DecodeGlare(frame, slot, recordStride),
        };
        return true;
    }

    /// <summary>
    /// Recover byte-sized fields written into fixed-stride fp-relative records by a straight-line MIPS initializer.
    /// Unwritten fields remain zero; the caller must verify the complete result against a target-specific digest.
    /// Exposed internally so a synthetic instruction stream can lock down the extraction contract without shipping
    /// an executable fixture or any derived table values.
    /// </summary>
    internal static byte[] ExtractMipsWorldConfigTable(
        ReadOnlySpan<byte> instructions, int slotCount, int recordStride, IReadOnlyList<int> channelOffsets)
    {
        if (instructions.Length % sizeof(uint) != 0 || slotCount <= 0 || recordStride <= 0 || channelOffsets.Count == 0)
            throw new InvalidDataException("MIPS initializer recipe is invalid.");

        var frameWords = ExtractMipsFrameWords(instructions);

        byte[] result = new byte[checked(slotCount * channelOffsets.Count)];
        for (int slot = 0; slot < slotCount; slot++)
            for (int channel = 0; channel < channelOffsets.Count; channel++)
            {
                int frameOffset = checked(slot * recordStride + channelOffsets[channel]);
                if (!frameWords.TryGetValue(frameOffset, out uint value)) continue;
                if (value > byte.MaxValue)
                    throw new InvalidDataException($"WorldConf initializer wrote non-byte value {value} at fp+0x{frameOffset:x}.");
                result[slot * channelOffsets.Count + channel] = (byte)value;
            }
        return result;
    }

    /// <summary>
    /// The shared constant-propagation core: recover every 32-bit word a straight-line MIPS initializer stores
    /// into its fp-relative frame, keyed by fp offset. Unwritten fields are simply absent.
    ///
    /// Both integer stores (<c>sw</c>) and FLOAT stores (<c>swc1</c>, whose value arrives through <c>mtc1</c>
    /// from an integer register the pass already tracks) are recorded, because a WorldConf record mixes 0-255
    /// integer colour channels with float angles, sizes and distances. Every float in the supported builds is
    /// materialised from <c>lui</c>/<c>ori</c> immediates, so no <c>.rodata</c> access is needed and the pass
    /// stays a pure function of the instruction span. A word whose value the pass cannot prove is simply not
    /// recorded — the pass can omit a store, but can never invent one.
    /// </summary>
    internal static Dictionary<int, uint> ExtractMipsFrameWords(ReadOnlySpan<byte> instructions)
    {
        if (instructions.Length % sizeof(uint) != 0)
            throw new InvalidDataException("MIPS initializer recipe is invalid.");

        uint?[] registers = new uint?[32];
        registers[0] = 0;
        uint?[] fpRegisters = new uint?[32];
        var frameWords = new Dictionary<int, uint>();
        for (int offset = 0; offset < instructions.Length; offset += sizeof(uint))
        {
            uint word = BinaryPrimitives.ReadUInt32LittleEndian(instructions[offset..]);
            int op = (int)(word >> 26);
            int rs = (int)((word >> 21) & 31);
            int rt = (int)((word >> 16) & 31);
            int rd = (int)((word >> 11) & 31);
            int shift = (int)((word >> 6) & 31);
            int function = (int)(word & 63);
            ushort immediate = (ushort)word;
            int signedImmediate = (short)immediate;

            switch (op)
            {
                case 0: // SPECIAL
                    registers[rd] = function switch
                    {
                        0 when registers[rt] is uint value => value << shift,                       // sll
                        33 when registers[rs] is uint left && registers[rt] is uint right => left + right, // addu
                        35 when registers[rs] is uint left && registers[rt] is uint right => left - right, // subu
                        37 when registers[rs] is uint left && registers[rt] is uint right => left | right, // or
                        8 => registers[rd], // jr writes no general register (rd is zero in the supported target)
                        _ => null,
                    };
                    break;
                case 9: // addiu
                    registers[rt] = registers[rs] is uint addBase ? addBase + unchecked((uint)signedImmediate) : null;
                    break;
                case 13: // ori
                    registers[rt] = registers[rs] is uint orBase ? orBase | immediate : null;
                    break;
                case 15: // lui
                    registers[rt] = (uint)immediate << 16;
                    break;
                case 17: // COP1
                    // mtc1 (rs == 4) moves an integer register's BITS into an FP register - the idiom that
                    // materialises every float constant here (lui/ori -> mtc1 -> swc1). mfc1/cfc1 (rs 0/2)
                    // write rt instead. Anything else is FP arithmetic: its destination (the fd field, which
                    // shares the rd bits) becomes unknown, so a computed value is never mistaken for a constant.
                    if (rs == 4) fpRegisters[rd] = registers[rt];
                    else if (rs is 0 or 2) registers[rt] = null;
                    else fpRegisters[shift] = null;   // fd occupies the shift-amount bits in the FP formats
                    break;
                case 49: // lwc1 - loads a float from memory this pass cannot see; its destination is unknown
                    fpRegisters[rt] = null;
                    break;
                case 57: // swc1 ft, off(base) - the float half of the frame write
                    if (rs == 30 && fpRegisters[rt] is uint storedFloat) frameWords[signedImmediate] = storedFloat;
                    break;
                case 35 or 36 or 37: // lw/lbu/lhu
                    registers[rt] = null;
                    break;
                case 43: // sw
                    if (rs == 30 && registers[rt] is uint stored) frameWords[signedImmediate] = stored;
                    break;
                case 2 or 4 or 5 or 6 or 7 or 20 or 21 or 22 or 23: // jumps and branches
                case 40 or 41 or 42 or 44 or 45 or 50 or 53 or 54 or 58 or 61 or 62 or 63: // other stores
                    break;
                default:
                    // The remaining immediate arithmetic and integer-load forms write rt. Conservatively discard
                    // its value; unsupported instructions can therefore omit a store, but can never invent one.
                    if (op is 8 or 10 or 11 or 12 or 14 or 24 or 25 or 26 or 27
                        or >= 32 and <= 39 or 48 or 52 or 55 or 56 or 60)
                        registers[rt] = null;
                    break;
            }
            registers[0] = 0;
        }
        return frameWords;
    }

    // Apply or remove an executable patch by byte-patching the game executable inside an ISO. Every region is
    // classified before anything is written - its current bytes must either digest to the patch file's
    // originalSha256 or equal the patched bytes - so an unknown executable or a half-patched image is refused
    // untouched and apply is idempotent. Apply records what it replaces in the ISO's restore file; --revert plays
    // that back for a byte-exact original, and restoreFrom recovers that record from a clean image when the file
    // is gone. Engine patch point: [Trailmap: 440-noclip-fly-mode].
    public int Apply(string iso, string cmd, string patchName, bool revert, string? restoreFrom = null)
    {
        using var fs = new FileStream(iso, FileMode.Open, FileAccess.ReadWrite);
        if (!TryLoadPatchForIso(fs, patchName, cmd, out var doc, out _)) return 1;
        var regions = ParseRegions(doc, patchName);

        if (!TryLocateExe(fs, doc, cmd, out long lba)) return 1;

        var current = regions.Select(r => ReadRegion(fs, lba, r)).ToArray();
        bool[] pristine = regions.Select((r, i) => Sha256Hex(current[i]) == r.OriginalSha256).ToArray();
        bool[] applied = regions.Select((r, i) => MatchesOutsideGrafts(current[i], r)).ToArray();

        for (int i = 0; i < regions.Length; i++)
            if (!pristine[i] && !applied[i])
            {
                Log.Error($"{cmd}: unexpected bytes at executable offset 0x{regions[i].Offset:x} - image is not in a known state; aborting untouched.");
                return 1;
            }

        var todo = Enumerable.Range(0, regions.Length).Where(i => revert ? applied[i] : pristine[i]).ToArray();
        int already = regions.Length - todo.Length;
        if (todo.Length == 0)
        { Log.Info($"{cmd}: already {(revert ? "reverted" : "applied")} ({already} regions)."); return 0; }

        // Read every grafted word before the first write, while the sites they come from are still intact.
        byte[][] resolved = new byte[regions.Length][];
        if (!revert)
        {
            if (!GraftSourcesArePristine(regions, pristine, todo, out string problem))
            {
                Log.Error($"{cmd}: cannot apply - {problem}. Revert this image first, or rebuild it from a clean copy.");
                return 1;
            }
            for (int i = 0; i < regions.Length; i++) resolved[i] = Resolve(fs, lba, regions[i]);
        }

        if (revert)
        {
            // Only the regions still carrying patched bytes need a saved original.
            var needed = todo.Select(i => regions[i]).ToArray();
            if (restoreFrom != null && !SeedRestorePoint(restoreFrom, iso, doc, patchName, needed, cmd)) return 1;
            if (!TryLoadRestorePoint(iso, patchName, needed, cmd, out var originals)) return 1;
            for (int k = 0; k < needed.Length; k++) WriteRegion(fs, lba, needed[k], originals[k]);
        }
        else
        {
            var captured = new List<(long, byte[])>();
            for (int i = 0; i < regions.Length; i++) if (pristine[i]) captured.Add((regions[i].Offset, current[i]));
            SaveRestorePoint(iso, patchName, captured);
            foreach (int i in todo) WriteRegion(fs, lba, regions[i], resolved[i]);
        }

        Log.Info($"{cmd}: {(revert ? "reverted" : "applied")} {todo.Length} regions @ LBA {lba}"
                          + (already > 0 ? $" ({already} were already done)." : "."));
        return 0;
    }

    // Find the game executable in the ISO and refuse anything that is not the exact build the patch was authored
    // against - a byte patch aimed at the wrong executable would corrupt it silently.
    private bool TryLocateExe(FileStream fs, JObject doc, string cmd, out long lba)
    {
        string target = (string)doc["target"]!;
        long targetSize = (long)doc["targetSize"]!;
        lba = 0;
        var hit = _iso.LocateIsoExtent(fs, new[] { target });
        if (hit == null)
        {
            string? actual = _iso.ReadBootExecutableName(fs);
            Log.Error($"{cmd}: this image holds no {target}"
                                    + (actual != null ? $" - it boots {actual}, a different build." : "."));
            return false;
        }
        (lba, long len, _) = hit.Value;
        if (len == targetSize) return true;
        Log.Error($"{cmd}: {target} in this ISO is {len:n0} B, expected {targetSize:n0} - not the supported executable.");
        return false;
    }

    // formatVersion 2 has no grafts; 3 may carry them. A build that does not understand a version refuses the
    // file rather than guessing, because the one guess that matters here - ignoring a graft - would write a
    // hook with `break` where a displaced instruction belongs.
    private const int MinFormatVersion = 2;
    private const int MaxFormatVersion = 3;

    /// <summary>MIPS <c>break</c>: what an unfilled graft window reads as. Chosen over zero, which is
    /// <c>nop</c>, so a window that never got filled traps instead of silently skipping the work.</summary>
    private const uint MipsBreak = 0x0000000D;

    internal static Region[] ParseRegions(JObject doc, string patchName)
    {
        int version = (int?)doc["formatVersion"] ?? 0;
        if (version is < MinFormatVersion or > MaxFormatVersion)
            throw new InvalidDataException(
                $"{patchName}: patch file formatVersion {version} is not supported by this build of snowknife "
                + $"(understands {MinFormatVersion}-{MaxFormatVersion}). Rebuild snowknife against the current tree.");

        return ((JArray)doc["regions"]!).Select(r =>
        {
            long offset = (long)r["fileOffset"]!;
            byte[] patched = Convert.FromHexString((string)r["patched"]!);
            string? digest = (string?)r["originalSha256"]
                ?? throw new InvalidDataException($"{patchName}: region at 0x{offset:x} has no originalSha256 - patch file is not the expected format.");
            int length = (int?)r["length"] ?? patched.Length;
            if (length != patched.Length)
                throw new InvalidDataException($"{patchName}: region at 0x{offset:x} verifies {length} B but writes {patched.Length} B - patch file is inconsistent.");

            // A patch file can come from anywhere, so every graft invariant the authoring scanner
            // enforces is re-checked here rather than trusted. A malformed one must fail closed:
            // the failure mode this guards is writing a hook with the wrong bytes in it.
            var grafts = ((JArray?)r["graft"] ?? new JArray()).Select(g =>
            {
                var graft = new Graft((int)g["at"]!, (long)g["fromFileOffset"]!, (int)g["length"]!);
                string Bad(string why) => $"{patchName}: region at 0x{offset:x} has a graft window ({graft.At}+{graft.Length}) {why}.";
                if (graft.At < 0 || graft.Length <= 0 || graft.At + graft.Length > patched.Length)
                    throw new InvalidDataException(Bad($"outside its {patched.Length} B payload"));
                if (graft.At % 4 != 0 || graft.Length % 4 != 0)
                    throw new InvalidDataException(Bad("that is not instruction-aligned"));
                if (graft.FromFileOffset < 0)
                    throw new InvalidDataException(Bad($"reading from a negative file offset ({graft.FromFileOffset})"));
                return graft;
            }).ToArray();

            if (grafts.Length > 0 && version < 3)
                throw new InvalidDataException($"{patchName}: region at 0x{offset:x} carries a graft, which formatVersion {version} does not define.");

            // Overlapping windows would make the applied bytes depend on which graft ran last.
            var covered = new bool[patched.Length];
            foreach (var graft in grafts)
                for (int i = graft.At; i < graft.At + graft.Length; i++)
                {
                    if (covered[i])
                        throw new InvalidDataException($"{patchName}: region at 0x{offset:x} has overlapping graft windows at byte {i}.");
                    covered[i] = true;
                }

            // A region whose every byte is grafted has nothing that identifies the patch, so it would
            // compare equal to anything and read as already applied. The generator refuses to emit one;
            // refuse to act on one too, rather than silently skipping a region that was never written.
            if (grafts.Length > 0 && grafts.Sum(g => g.Length) >= patched.Length)
                throw new InvalidDataException(
                    $"{patchName}: region at 0x{offset:x} is entirely graft windows, so nothing in it identifies the patch.");

            // `break` marks an unfilled window. Inside one it is expected; outside one it means the
            // file was generated half-way through a change and apply would write a trap into the game.
            for (int i = 0; i + 4 <= patched.Length; i += 4)
            {
                bool isBreak = BinaryPrimitives.ReadUInt32LittleEndian(patched.AsSpan(i)) == MipsBreak;
                if (isBreak && !covered[i])
                    throw new InvalidDataException(
                        $"{patchName}: region at 0x{offset:x} publishes `break` at byte {i}, which no graft window covers.");
                if (!isBreak && covered[i])
                    throw new InvalidDataException(
                        $"{patchName}: region at 0x{offset:x} has a graft window at byte {i} that is not `break` - it may carry a real instruction.");
            }
            return new Region(offset, length, digest, patched, grafts);
        }).ToArray();
    }

    /// <summary>
    /// Fill a region's graft windows by reading each one's source out of the executable being patched, through
    /// <paramref name="readSource"/>(fileOffset, length). Must run before anything is written: a graft source is
    /// normally the hook site this same patch is about to overwrite, so those words are only there to be read
    /// while the image is still pristine. Taking the reader as a delegate is what lets a test drive the real
    /// substitution against a synthetic executable instead of an ISO.
    /// </summary>
    internal static byte[] ResolveGrafts(Region region, Func<long, int, byte[]> readSource)
    {
        if (region.Grafts.Length == 0) return region.Patched;
        byte[] result = (byte[])region.Patched.Clone();
        foreach (var graft in region.Grafts)
            readSource(graft.FromFileOffset, graft.Length).CopyTo(result, graft.At);
        return result;
    }

    private static byte[] Resolve(FileStream fs, long lba, Region region) =>
        ResolveGrafts(region, (fileOffset, length) =>
        {
            byte[] source = new byte[length];
            fs.Seek(lba * 2048L + fileOffset, SeekOrigin.Begin);
            fs.ReadExactly(source);
            return source;
        });

    // Whether a region's current bytes are this patch's payload, ignoring the graft windows - the only part of
    // the payload that is not fixed by the patch file. Same shape as the sky table's parameterized comparison.
    internal static bool MatchesOutsideGrafts(ReadOnlySpan<byte> current, Region region)
    {
        if (current.Length != region.Patched.Length) return false;
        for (int i = 0; i < current.Length; i++)
        {
            bool grafted = false;
            foreach (var graft in region.Grafts)
                if (i >= graft.At && i < graft.At + graft.Length) { grafted = true; break; }
            if (!grafted && current[i] != region.Patched[i]) return false;
        }
        return true;
    }

    // A graft reads bytes that another region of the same patch replaces, so it is only trustworthy while every
    // region it overlaps still holds the executable's own words. Half-applied images are already refused
    // upstream; this catches the narrower case where one region is pristine and the region its graft reads
    // from is not.
    private static bool GraftSourcesArePristine(Region[] regions, bool[] pristine, IEnumerable<int> writing, out string problem)
    {
        foreach (int i in writing)
            foreach (var graft in regions[i].Grafts)
                for (int j = 0; j < regions.Length; j++)
                {
                    bool overlaps = graft.FromFileOffset < regions[j].Offset + regions[j].Length
                                    && regions[j].Offset < graft.FromFileOffset + graft.Length;
                    if (!overlaps || pristine[j]) continue;
                    problem = $"the executable bytes at 0x{graft.FromFileOffset:x}, which this patch's hook at "
                              + $"0x{regions[i].Offset:x} has to preserve, have already been replaced";
                    return false;
                }
        problem = "";
        return true;
    }

    private static byte[] ReadRegion(FileStream fs, long lba, Region region)
    {
        byte[] buf = new byte[region.Length];
        fs.Seek(lba * 2048L + region.Offset, SeekOrigin.Begin);
        fs.ReadExactly(buf);
        return buf;
    }

    private static void WriteRegion(FileStream fs, long lba, Region region, byte[] data)
    {
        fs.Seek(lba * 2048L + region.Offset, SeekOrigin.Begin);
        fs.Write(data, 0, data.Length);
    }

    private static string Sha256Hex(ReadOnlySpan<byte> data) => Convert.ToHexString(SHA256.HashData(data)).ToLowerInvariant();

    private static string RestorePath(string iso) => iso + ".snowknife-restore.json";

    // Record the bytes a patch is about to replace, next to the ISO they came from, so --revert can put them back
    // exactly. Regions already recorded keep their first saved copy and other patches' entries are left alone, so
    // stacking noclip, HUD text and sky colours on one image accumulates a single complete restore point. Bytes
    // recovered from a clean image pass replaceExisting: they have been checked against the patch file's digest,
    // which makes them authoritative over an entry that is already there and possibly damaged.
    private static void SaveRestorePoint(string iso, string patchName, IEnumerable<(long Offset, byte[] Bytes)> captured,
                                         bool replaceExisting = false)
    {
        var items = captured.ToArray();
        if (items.Length == 0) return;
        string path = RestorePath(iso);
        JObject root = File.Exists(path) ? JObject.Parse(File.ReadAllText(path)) : new JObject();
        root["note"] = "Executable bytes replaced by snowknife patches, saved from this ISO so --revert can restore it exactly. "
                     + "Keep it beside the ISO; it holds data from your own disc and belongs to that image alone.";
        var patches = root["patches"] as JObject ?? new JObject();
        var entry = patches[patchName] as JObject ?? new JObject();
        var list = entry["regions"] as JArray ?? new JArray();
        if (replaceExisting)
        {
            var replacing = items.Select(x => x.Offset).ToHashSet();
            foreach (var stale in list.Where(r => replacing.Contains((long)r["fileOffset"]!)).ToArray()) stale.Remove();
        }
        var have = list.Select(r => (long)r["fileOffset"]!).ToHashSet();
        foreach (var (offset, bytes) in items.OrderBy(x => x.Offset))
            if (have.Add(offset))
                list.Add(new JObject
                {
                    ["fileOffset"] = offset,
                    ["original"] = Convert.ToHexString(bytes).ToLowerInvariant(),
                });
        entry["regions"] = new JArray(list.OrderBy(r => (long)r["fileOffset"]!));
        patches[patchName] = entry;
        root["patches"] = patches;
        File.WriteAllText(path, root.ToString(Newtonsoft.Json.Formatting.Indented) + "\n");
    }

    // Rebuild a missing restore point by reading the pre-patch bytes out of an unpatched copy of the same disc.
    // This is the way back for an image patched before its restore file existed, or one whose file was lost: the
    // bytes still come from the user's own game, and every region must digest to the patch file's originalSha256
    // or the image is not the clean copy it claims to be.
    private bool SeedRestorePoint(string cleanIso, string iso, JObject doc, string patchName, Region[] regions, string cmd)
    {
        if (!File.Exists(cleanIso))
        { Log.Error($"{cmd}: --from {cleanIso} does not exist."); return false; }
        if (Path.GetFullPath(cleanIso) == Path.GetFullPath(iso))
        { Log.Error($"{cmd}: --from must name a different image than the one being reverted."); return false; }

        using var clean = new FileStream(cleanIso, FileMode.Open, FileAccess.Read);
        if (!TryLocateExe(clean, doc, cmd, out long lba)) return false;

        var captured = new List<(long, byte[])>();
        foreach (var region in regions)
        {
            byte[] bytes = ReadRegion(clean, lba, region);
            if (Sha256Hex(bytes) != region.OriginalSha256)
            {
                Log.Error($"{cmd}: --from {Path.GetFileName(cleanIso)} does not hold the original bytes at executable offset 0x{region.Offset:x} - it is patched or is a different build.");
                return false;
            }
            captured.Add((region.Offset, bytes));
        }
        SaveRestorePoint(iso, patchName, captured, replaceExisting: true);
        Log.Info($"{cmd}: recovered {captured.Count} regions from {Path.GetFileName(cleanIso)}.");
        return true;
    }

    // Load the saved originals for every region of a patch. Each blob is re-checked against the region's digest
    // before it is handed back, so a restore file that is truncated, edited, or from a different image is refused
    // rather than written into the executable.
    private static bool TryLoadRestorePoint(string iso, string patchName, Region[] regions, string cmd, out byte[][] originals)
    {
        originals = [];
        string path = RestorePath(iso);
        var saved = File.Exists(path)
            ? (JObject.Parse(File.ReadAllText(path))["patches"] as JObject)?[patchName]?["regions"] as JArray
            : null;
        var byOffset = saved?.ToDictionary(r => (long)r["fileOffset"]!, r => (string?)r["original"])
                       ?? new Dictionary<long, string?>();

        var result = new byte[regions.Length][];
        for (int i = 0; i < regions.Length; i++)
        {
            byOffset.TryGetValue(regions[i].Offset, out string? hex);
            byte[]? blob = hex == null ? null : Convert.FromHexString(hex);
            if (blob == null || blob.Length != regions[i].Length || Sha256Hex(blob) != regions[i].OriginalSha256)
            {
                Log.Error(
                    $"{cmd}: cannot revert - {Path.GetFileName(path)} holds no verified copy of the executable bytes at offset 0x{regions[i].Offset:x}. "
                    + "That file is written beside the ISO whenever a patch is applied; the patch file itself carries only a digest of those bytes. "
                    + "Re-run with --from <clean.iso> to recover them from an unpatched copy of the disc.");
                return false;
            }
            result[i] = blob;
        }
        originals = result;
        return true;
    }

    private static bool TryParseColour(string s, byte[] rgb)
    {
        string h = s.TrimStart('#');
        if (h.Length != 6 || !uint.TryParse(h, System.Globalization.NumberStyles.HexNumber, null, out uint value)) return false;
        rgb[0] = (byte)(value >> 16);
        rgb[1] = (byte)(value >> 8);
        rgb[2] = (byte)value;
        return true;
    }

    // The patch file for one build: Patches/<name>.<bootExecutable>.json.
    private static string? FindPatchFile(string patchName, string target)
    {
        foreach (var dir in PatchDirs())
        {
            string path = Path.Combine(dir, $"{patchName}.{target}.json");
            if (File.Exists(path)) return path;
        }
        return null;
    }

    private static IEnumerable<string> PatchDirs()
    {
        // The build output carries its own copy (Patches/** is CopyToOutputDirectory), so the first root is
        // the one that normally answers. The others let the tool run against the source tree from the
        // repository root or from Snowknife's own folder.
        foreach (var root in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory(),
                                     Path.Combine(Directory.GetCurrentDirectory(), "Snowknife"),
                                     Path.Combine(Directory.GetCurrentDirectory(), "Snowknife", "Snowknife") })
        {
            string dir = Path.Combine(root, "Patches");
            if (Directory.Exists(dir)) yield return dir;
        }
    }

    // Every build a patch ships for, for the "not supported" message.
    private static string[] SupportedTargets(string patchName) =>
        PatchDirs().SelectMany(d => Directory.GetFiles(d, patchName + ".*.json"))
                   .Select(p => Path.GetFileNameWithoutExtension(p)!)
                   .Select(n => n.Length > patchName.Length + 1 ? n[(patchName.Length + 1)..] : n)
                   .Distinct().OrderBy(x => x).ToArray();

    /// <summary>
    /// Load the patch file for whichever build this ISO actually carries. The disc names its own boot
    /// executable in SYSTEM.CNF, and that name selects the file, so a patch authored for one region can
    /// never be written into another's executable.
    /// </summary>
    private bool TryLoadPatchForIso(Stream iso, string patchName, string cmd, out JObject doc, out string target)
    {
        doc = null!;
        target = _iso.ReadBootExecutableName(iso) ?? "";
        if (target.Length == 0)
        {
            Log.Error($"{cmd}: cannot read a boot executable name from this image - not an SSX PS2 disc?");
            return false;
        }
        string? patchPath = FindPatchFile(patchName, target);
        if (patchPath == null)
        {
            var have = SupportedTargets(patchName);
            Log.Error(have.Length > 0
                ? $"{cmd}: this disc boots {target}, which has no {patchName} patch. Supported: {string.Join(", ", have)}."
                : $"{cmd}: Patches/{patchName}.*.json not found next to the executable or working directory.");
            return false;
        }
        doc = JObject.Parse(File.ReadAllText(patchPath));
        return true;
    }
}
