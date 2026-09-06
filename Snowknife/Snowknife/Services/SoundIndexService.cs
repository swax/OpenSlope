using System.Buffers.Binary;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json;

namespace Snowknife.Services;

/// <summary>
/// A map-local description of the sound facts Snowknife recovered from the user's disc.  It is deliberately
/// generated beside the decoded WAVs: consumers should not need their own copy of the retail executable's
/// event resolver or of BANKS.INF's course table.
/// </summary>
public sealed class SoundIndexDocument
{
    public const string FileName = "SoundIndex.json";
    public const string SchemaId = "openslope-sound-index/v1";
    public string Schema { get; set; } = SchemaId;
    public string Level { get; set; } = "";
    public string SourceExecutable { get; set; } = "";
    public Dictionary<int, string> Banks { get; set; } = new();
    public Dictionary<int, SoundIndexEvent> CollisionEvents { get; set; } = new();

    [JsonIgnore]
    public string? CourseBank => Banks.TryGetValue(2, out string? bank) ? bank : null;

    public static SoundIndexDocument? Load(string levelDir)
    {
        string path = Path.Combine(levelDir, "Audio", FileName);
        if (!File.Exists(path)) return null;
        try
        {
            SoundIndexDocument? document = JsonConvert.DeserializeObject<SoundIndexDocument>(File.ReadAllText(path));
            return document?.Schema == SchemaId ? document : null;
        }
        catch (Exception e)
        {
            Log.Warn($"  WARN: {path} is unreadable ({e.Message}) — no sound index; collision clips and the course bank stay unresolved.");
            return null;
        }
    }

    public string? CollisionClip(int eventId) =>
        CollisionEvents.TryGetValue(eventId, out SoundIndexEvent? entry) ? entry.Clip : null;
}

public sealed class SoundIndexEvent
{
    public int Group { get; set; }
    public int Slot { get; set; }
    public string Bank { get; set; } = "";
    public string Clip { get; set; } = "";
}

/// <summary>
/// The disc-global terrain-surface routing used by the shared board-snow bank.  This document lives under
/// <c>Maps/Shared/Audio</c>, beside the decoded bank it indexes, and is generated from the user's boot ELF.
/// </summary>
public sealed class BoardSoundIndexDocument
{
    public const string FileName = "BoardSoundIndex.json";
    public const string SchemaId = "openslope-board-sound-index/v1";
    public string Schema { get; set; } = SchemaId;
    public string SourceExecutable { get; set; } = "";
    public List<int> SurfaceGroups { get; set; } = new();
}

internal sealed class DiscSoundBanks
{
    public Dictionary<int, string> LevelBanks { get; } = new();
    public List<string> SwapBanks { get; } = new();
    public List<string> CourseBanks { get; } = new();
}

/// <summary>
/// Reads BANKS.INF and interprets the collision-event and board-surface dispatchers directly from the boot ELF.
/// The extractor recognizes instruction structure and follows the referenced handlers; it carries no regional
/// addresses, event routes, or surface-to-family values of its own.
/// </summary>
internal sealed class SoundIndexService
{
    private readonly IsoService _iso;

    public SoundIndexService(IsoService iso) => _iso = iso;

    public SoundIndexDocument Extract(string isoPath, string levelName, string levelDir, bool write = true)
    {
        using FileStream iso = File.OpenRead(isoPath);
        string executable = _iso.ReadBootExecutableName(iso)
            ?? throw new InvalidDataException("The ISO has no boot executable name.");
        byte[] elf = ReadIsoFile(iso, executable);
        byte[] banksInf = ReadIsoFile(iso, @"DATA\CONFIG\BANKS.INF");
        DiscSoundBanks banks = ParseBanksInf(Encoding.ASCII.GetString(banksInf), levelName);
        Dictionary<int, (int Group, int Slot)> routes = ExtractCollisionEvents(elf);

        var document = new SoundIndexDocument
        {
            Level = NormalizeLevel(levelName),
            SourceExecutable = executable,
            Banks = new Dictionary<int, string>(banks.LevelBanks),
        };
        foreach (var (eventId, route) in routes.OrderBy(pair => pair.Key))
        {
            if (!banks.LevelBanks.TryGetValue(route.Group, out string? bank)) continue;
            document.CollisionEvents[eventId] = new SoundIndexEvent
            {
                Group = route.Group,
                Slot = route.Slot,
                Bank = bank,
                Clip = $"Audio/SFX/{bank}/{route.Slot:D3}.wav",
            };
        }

        if (write)
        {
            string audioDir = Path.Combine(levelDir, "Audio");
            Directory.CreateDirectory(audioDir);
            string path = Path.Combine(audioDir, SoundIndexDocument.FileName);
            string json = JsonConvert.SerializeObject(document, Formatting.Indented) + Environment.NewLine;
            new ContractValidationService().RequireJson(json, ContractKind.SoundIndexV1, path);
            File.WriteAllText(path, json);
            EnvironmentAudioDocument.WriteDefault(levelDir);
            Log.Info($"      sound index: {document.CollisionEvents.Count} event route(s) from {executable}; "
                + $"course bank {document.CourseBank ?? "(none)"}; environment bed Wind1/000.");
        }
        return document;
    }

    public DiscSoundBanks ReadBanks(string isoPath, string levelName)
    {
        using FileStream iso = File.OpenRead(isoPath);
        return ParseBanksInf(Encoding.ASCII.GetString(ReadIsoFile(iso, @"DATA\CONFIG\BANKS.INF")), levelName);
    }

    public BoardSoundIndexDocument ExtractBoardSoundIndex(string isoPath, string sharedDir, bool write = true)
    {
        using FileStream iso = File.OpenRead(isoPath);
        string executable = _iso.ReadBootExecutableName(iso)
            ?? throw new InvalidDataException("The ISO has no boot executable name.");
        var document = new BoardSoundIndexDocument
        {
            SourceExecutable = executable,
            SurfaceGroups = ExtractBoardSurfaceGroups(ReadIsoFile(iso, executable)),
        };

        if (write)
        {
            string audioDir = Path.Combine(sharedDir, "Audio");
            Directory.CreateDirectory(audioDir);
            string path = Path.Combine(audioDir, BoardSoundIndexDocument.FileName);
            string json = JsonConvert.SerializeObject(document, Formatting.Indented) + Environment.NewLine;
            new ContractValidationService().RequireJson(json, ContractKind.BoardSoundIndexV1, path);
            File.WriteAllText(path, json);
            Log.Info($"      board sound index: {document.SurfaceGroups.Count} surface route(s) from {executable}.");
        }
        return document;
    }

    private byte[] ReadIsoFile(Stream iso, string internalPath)
    {
        string[] parts = internalPath.Replace('\\', '/').Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        var hit = _iso.LocateIsoExtent(iso, parts)
            ?? throw new FileNotFoundException($"Not found in ISO: {internalPath}");
        if (hit.len > int.MaxValue) throw new InvalidDataException($"ISO file is too large: {internalPath}");
        byte[] bytes = new byte[(int)hit.len];
        iso.Seek(hit.lba * 2048L, SeekOrigin.Begin);
        iso.ReadExactly(bytes);
        return bytes;
    }

    internal static DiscSoundBanks ParseBanksInf(string text, string levelName)
    {
        var sections = new Dictionary<string, Dictionary<string, List<string>>>(StringComparer.OrdinalIgnoreCase);
        Dictionary<string, List<string>>? current = null;
        foreach (string raw in text.Replace("\r", "").Split('\n'))
        {
            string line = raw.Split('#', 2)[0].Trim();
            var section = Regex.Match(line, @"^\[([^]]+)\]$");
            if (section.Success)
            {
                current = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
                sections[section.Groups[1].Value.Trim()] = current;
                continue;
            }
            if (current == null) continue;
            var assignment = Regex.Match(line, @"^([A-Za-z0-9_]+)\s*=\s*""([^""]+)""");
            if (!assignment.Success) continue;
            string key = assignment.Groups[1].Value;
            if (!current.TryGetValue(key, out List<string>? values)) current[key] = values = new();
            values.Add(Path.GetFileNameWithoutExtension(assignment.Groups[2].Value.Trim()));
        }

        string wanted = NormalizeLevel(levelName);
        string? chosen = sections.Keys.Where(name => !name.Equals("GLOBAL", StringComparison.OrdinalIgnoreCase)
                                                  && !name.Equals("FE", StringComparison.OrdinalIgnoreCase))
            .Select(name => (Name: name, Score: CommonPrefix(wanted, name.ToUpperInvariant())))
            .Where(candidate => candidate.Score >= 4)
            .OrderByDescending(candidate => candidate.Score)
            .ThenBy(candidate => candidate.Name, StringComparer.OrdinalIgnoreCase)
            .Select(candidate => candidate.Name).FirstOrDefault();
        if (chosen == null) throw new InvalidDataException($"BANKS.INF has no section matching course '{levelName}'.");

        var result = new DiscSoundBanks();
        var groupKeys = new (int Group, string Key)[] { (0, "MAIN"), (1, "BOARD"), (2, "BANK"), (3, "CROWD"), (5, "TRICKY") };
        foreach (var (group, key) in groupKeys)
            if (sections[chosen].TryGetValue(key, out List<string>? values) && values.Count > 0)
                result.LevelBanks[group] = values[0];
        if (sections[chosen].TryGetValue("SWAP", out List<string>? swaps)) result.SwapBanks.AddRange(swaps);
        foreach (var section in sections.Values)
            if (section.TryGetValue("BANK", out List<string>? values))
                foreach (string bank in values)
                    if (!result.CourseBanks.Contains(bank, StringComparer.OrdinalIgnoreCase)) result.CourseBanks.Add(bank);
        return result;
    }

    private static string NormalizeLevel(string levelName) =>
        Path.GetFileNameWithoutExtension(levelName).Trim().ToUpperInvariant();

    private static int CommonPrefix(string left, string right)
    {
        int count = 0;
        while (count < left.Length && count < right.Length && left[count] == right[count]) count++;
        return count;
    }

    internal static Dictionary<int, (int Group, int Slot)> ExtractCollisionEvents(byte[] elf)
    {
        int signature = FindResolverSignature(elf);
        uint eventBias = Word(elf, signature);
        uint defaultGroupWord = Word(elf, signature + 4);
        uint countWord = Word(elf, signature + 8);
        uint tableUpperWord = Word(elf, signature + 20);
        uint tableLowerWord = Word(elf, signature + 28);
        int firstEvent = -(short)(eventBias & 0xffff);
        int count = (ushort)countWord;
        int defaultGroup = (short)(defaultGroupWord & 0xffff);
        uint tableAddress = (uint)(((tableUpperWord & 0xffff) << 16) + (short)(tableLowerWord & 0xffff));
        if (firstEvent < 0 || count <= 0 || count > 4096 || defaultGroup < 0)
            throw new InvalidDataException("The collision-sound resolver has invalid bounds.");

        var segments = LoadSegments(elf);
        int tableOffset = VirtualToFile(tableAddress, sizeof(uint) * count, segments);
        var result = new Dictionary<int, (int Group, int Slot)>();
        for (int index = 0; index < count; index++)
        {
            uint handler = Word(elf, tableOffset + index * sizeof(uint));
            if (TryRunHandler(elf, handler, defaultGroup, segments, out int group, out int slot))
                result[firstEvent + index] = (group, slot);
        }
        if (result.Count == 0) throw new InvalidDataException("The collision-sound resolver yielded no event routes.");
        return result;
    }

    /// <summary>
    /// Locate the compiler-emitted switch used by the board-snow mapper, follow its ELF-addressed jump table,
    /// and evaluate each constant-return handler.  The switch includes one sentinel on either side of the
    /// terrain range; only the interior surface entries are exported.  No output value participates in finding
    /// or validating the function, so a different regional mapping is recovered rather than rejected.
    /// </summary>
    internal static List<int> ExtractBoardSurfaceGroups(byte[] elf)
    {
        var segments = LoadSegments(elf);
        int found = -1;
        for (int offset = 0; offset + 60 <= elf.Length; offset += 4)
        {
            uint addBias = Word(elf, offset + 20);
            uint range = Word(elf, offset + 24);
            uint branchDefault = Word(elf, offset + 28);
            uint tableUpper = Word(elf, offset + 32);
            uint scale = Word(elf, offset + 36);
            uint tableLower = Word(elf, offset + 40);
            uint addTable = Word(elf, offset + 44);
            uint loadHandler = Word(elf, offset + 48);
            uint jumpHandler = Word(elf, offset + 52);
            uint delay = Word(elf, offset + 56);

            // The register-relative shape of a compiled switch, with X the case index, Z the range test,
            // T the table pointer and A the handler:
            //   addiu X,?,1 ; sltiu Z,X,count ; beq Z,zero,default ; lui T,hi ; sll X,X,2 ;
            //   addiu T,T,lo ; addu X,X,T ; lw A,0(X) ; jr A ; nop
            if (!IsAddiu(addBias) || Imm(addBias) != 1) continue;
            int x = Rt(addBias);
            if (!IsSltiu(range, rs: x)) continue;
            int z = Rt(range);
            if (!IsBeqZero(branchDefault, z) || !IsLui(tableUpper)) continue;
            int t = Rt(tableUpper);
            if (!IsSllBy2(scale, rd: x, rt: x) || !IsAddiu(tableLower, rt: t, rs: t)
                || !IsAddu(addTable, rd: x, rs: x, rt: t) || !IsLwZeroOffset(loadHandler, baseRegister: x)) continue;
            int handlerRegister = Rt(loadHandler);
            if (!IsJr(jumpHandler, handlerRegister) || delay != 0) continue;

            int count = (ushort)range;
            if (count < 3 || count > 256) continue;
            uint tableAddress = (uint)(((tableUpper & 0xffff) << 16) + (short)(tableLower & 0xffff));
            int tableOffset;
            try { tableOffset = VirtualToFile(tableAddress, checked(count * sizeof(uint)), segments); }
            catch (InvalidDataException) { continue; }

            var values = new List<int>(count);
            bool valid = true;
            for (int index = 0; index < count; index++)
            {
                uint handler = Word(elf, tableOffset + index * sizeof(uint));
                if (!TryReadConstantReturn(elf, handler, segments, out int value)) { valid = false; break; }
                values.Add(value);
            }
            if (!valid || values.Distinct().Count() < 2) continue;
            if (found >= 0)
                throw new InvalidDataException("The boot ELF has more than one board-surface audio mapper candidate.");
            found = offset;
        }

        if (found < 0) throw new InvalidDataException("The boot ELF's board-surface audio mapper was not recognized.");

        uint foundRange = Word(elf, found + 24);
        uint foundUpper = Word(elf, found + 32);
        uint foundLower = Word(elf, found + 40);
        int foundCount = (ushort)foundRange;
        uint foundTable = (uint)(((foundUpper & 0xffff) << 16) + (short)(foundLower & 0xffff));
        int foundTableOffset = VirtualToFile(foundTable, checked(foundCount * sizeof(uint)), segments);
        var result = new List<int>(foundCount - 2);
        for (int index = 1; index < foundCount - 1; index++)
        {
            uint handler = Word(elf, foundTableOffset + index * sizeof(uint));
            if (!TryReadConstantReturn(elf, handler, segments, out int value))
                throw new InvalidDataException("The board-surface audio mapper has a non-constant handler.");
            result.Add(value);
        }
        return result;
    }

    private static bool TryReadConstantReturn(byte[] elf, uint address, IReadOnlyList<ElfSegment> segments,
                                              out int value)
    {
        value = 0;
        int offset;
        try { offset = VirtualToFile(address, 8, segments); }
        catch (InvalidDataException) { return false; }
        if (!IsJr(Word(elf, offset), ReturnAddress)) return false;               // jr ra
        uint delay = Word(elf, offset + 4);
        if (IsAddiu(delay, rt: ReturnValue, rs: Zero))                           // addiu v0,zero,value
        {
            value = Imm(delay);
            return value >= 0;
        }
        if (IsMoveZero(delay, ReturnValue))                                      // addu/daddu v0,zero,zero
        {
            value = 0;
            return true;
        }
        return false;
    }

    private static int FindResolverSignature(byte[] elf)
    {
        int found = -1;
        for (int offset = 0; offset + 32 <= elf.Length; offset += 4)
        {
            uint biasWord = Word(elf, offset), groupWord = Word(elf, offset + 4), countWord = Word(elf, offset + 8);
            uint branchWord = Word(elf, offset + 12), storeWord = Word(elf, offset + 16), upperWord = Word(elf, offset + 20);
            uint scaleWord = Word(elf, offset + 24), lowerWord = Word(elf, offset + 28);
            // The register-relative shape of the resolver's entry, with E the rebased event, G the group
            // (reused as the table pointer) and C the range test:
            //   addiu E,?,-N ; addiu G,zero,group ; sltiu C,E,count ; beq C,zero,skip ; sw G,0(?) ;
            //   lui G,hi ; sll C,E,2 ; addiu G,G,lo
            if (!IsAddiu(biasWord)) continue;
            int e = Rt(biasWord);
            if (!IsAddiu(groupWord, rs: Zero)) continue;
            int g = Rt(groupWord);
            if (!IsSltiu(countWord, rs: e)) continue;
            int c = Rt(countWord);
            bool match = IsBeqZero(branchWord, c)
                && IsSwZeroOffset(storeWord, rt: g)
                && IsLui(upperWord) && Rt(upperWord) == g
                && IsSllBy2(scaleWord, rd: c, rt: e)
                && IsAddiu(lowerWord, rt: g, rs: g);
            if (!match) continue;
            if (found >= 0) throw new InvalidDataException("The boot ELF has more than one collision-sound resolver candidate.");
            found = offset;
        }
        return found >= 0 ? found : throw new InvalidDataException("The boot ELF's collision-sound resolver was not recognized.");
    }

    // ---- MIPS field decoders ------------------------------------------------------------------------
    // The matchers above describe an instruction by its opcode, function and shift fields and by which
    // register fields must agree with one another -- never by a whole word. Register allocation and every
    // operand are the compiler's, so the register-relative shape is what identifies an idiom, and no encoded
    // instruction from the executable being read is carried in this source.
    private const uint OpSpecial = 0, OpBeq = 4, OpAddiu = 9, OpSltiu = 11, OpLui = 15, OpLw = 35, OpSw = 43;
    private const uint FnSll = 0, FnJr = 8, FnAddu = 0x21, FnDaddu = 0x2d;
    private const int Zero = 0, ReturnValue = 2, ReturnAddress = 31;   // fixed by the MIPS ABI, not the compiler

    private static uint Op(uint word) => word >> 26;
    private static int Rs(uint word) => (int)(word >> 21) & 31;
    private static int Rt(uint word) => (int)(word >> 16) & 31;
    private static int Rd(uint word) => (int)(word >> 11) & 31;
    private static int Sa(uint word) => (int)(word >> 6) & 31;
    private static uint Fn(uint word) => word & 63;
    private static short Imm(uint word) => (short)word;

    /// <summary>addiu rt, rs, imm; a register left at -1 is unconstrained.</summary>
    private static bool IsAddiu(uint word, int rt = -1, int rs = -1) =>
        Op(word) == OpAddiu && (rt < 0 || Rt(word) == rt) && (rs < 0 || Rs(word) == rs);
    private static bool IsSltiu(uint word, int rs) => Op(word) == OpSltiu && Rs(word) == rs;
    private static bool IsBeqZero(uint word, int rs) => Op(word) == OpBeq && Rs(word) == rs && Rt(word) == Zero;
    private static bool IsLui(uint word) => Op(word) == OpLui && Rs(word) == Zero;
    private static bool IsSllBy2(uint word, int rd, int rt) =>
        Op(word) == OpSpecial && Fn(word) == FnSll && Rs(word) == Zero
        && Rd(word) == rd && Rt(word) == rt && Sa(word) == 2;
    private static bool IsAddu(uint word, int rd, int rs, int rt) =>
        Op(word) == OpSpecial && Fn(word) == FnAddu && Sa(word) == 0
        && Rd(word) == rd && Rs(word) == rs && Rt(word) == rt;
    private static bool IsMoveZero(uint word, int rd) =>                        // addu/daddu rd, zero, zero
        Op(word) == OpSpecial && Fn(word) is FnAddu or FnDaddu && Sa(word) == 0
        && Rd(word) == rd && Rs(word) == Zero && Rt(word) == Zero;
    private static bool IsLwZeroOffset(uint word, int baseRegister) =>
        Op(word) == OpLw && Rs(word) == baseRegister && Imm(word) == 0;
    private static bool IsSwZeroOffset(uint word, int rt) => Op(word) == OpSw && Rt(word) == rt && Imm(word) == 0;
    private static bool IsJr(uint word, int rs) =>
        Op(word) == OpSpecial && Fn(word) == FnJr && Rs(word) == rs
        && Rt(word) == Zero && Rd(word) == Zero && Sa(word) == 0;

    private readonly record struct ElfSegment(uint VirtualAddress, uint FileOffset, uint FileSize);

    private static List<ElfSegment> LoadSegments(byte[] elf)
    {
        if (elf.Length < 52 || elf[0] != 0x7f || elf[1] != 'E' || elf[2] != 'L' || elf[3] != 'F'
            || elf[4] != 1 || elf[5] != 1)
            throw new InvalidDataException("Boot executable is not a little-endian ELF32 file.");
        int phoff = checked((int)Word(elf, 28));
        int entrySize = BinaryPrimitives.ReadUInt16LittleEndian(elf.AsSpan(42, 2));
        int count = BinaryPrimitives.ReadUInt16LittleEndian(elf.AsSpan(44, 2));
        var result = new List<ElfSegment>();
        for (int index = 0; index < count; index++)
        {
            int offset = checked(phoff + index * entrySize);
            if (offset < 0 || offset + 32 > elf.Length) throw new InvalidDataException("ELF program-header table is truncated.");
            if (Word(elf, offset) != 1) continue; // PT_LOAD
            result.Add(new ElfSegment(Word(elf, offset + 8), Word(elf, offset + 4), Word(elf, offset + 16)));
        }
        return result;
    }

    private static int VirtualToFile(uint address, int length, IReadOnlyList<ElfSegment> segments)
    {
        foreach (ElfSegment segment in segments)
        {
            ulong start = segment.VirtualAddress, end = start + segment.FileSize;
            if (address < start || (ulong)address + (uint)length > end) continue;
            return checked((int)(segment.FileOffset + address - segment.VirtualAddress));
        }
        throw new InvalidDataException($"ELF virtual address 0x{address:x8} is not file-backed.");
    }

    private static bool TryRunHandler(byte[] elf, uint start, int defaultGroup,
                                      IReadOnlyList<ElfSegment> segments, out int group, out int slot)
    {
        var registers = new int[32];
        group = defaultGroup;
        slot = -1;
        uint pc = start;
        for (int steps = 0; steps < 64; steps++)
        {
            uint instruction;
            try { instruction = Word(elf, VirtualToFile(pc, 4, segments)); }
            catch (InvalidDataException) { return false; }
            int opcode = (int)(instruction >> 26);
            if (opcode is 4 or 5) // beq / bne, with one delay instruction
            {
                int rs = (int)(instruction >> 21) & 31, rt = (int)(instruction >> 16) & 31;
                bool taken = opcode == 4 ? registers[rs] == registers[rt] : registers[rs] != registers[rt];
                uint delay = Word(elf, VirtualToFile(pc + 4, 4, segments));
                ExecuteSimple(delay, registers, ref group, ref slot);
                if (slot >= 0) return true;
                pc = taken ? unchecked(pc + 4 + (uint)((short)instruction * 4)) : pc + 8;
                continue;
            }
            ExecuteSimple(instruction, registers, ref group, ref slot);
            if (slot >= 0) return true;
            pc += 4;
        }
        return false;
    }

    private static void ExecuteSimple(uint instruction, int[] registers, ref int group, ref int slot)
    {
        int opcode = (int)(instruction >> 26);
        int rs = (int)(instruction >> 21) & 31, rt = (int)(instruction >> 16) & 31;
        short immediate = (short)instruction;
        if (opcode == 9) registers[rt] = unchecked(registers[rs] + immediate); // addiu
        else if (opcode == 43) // sw; the resolver's two output pointers live in s1 (group) and s0 (slot)
        {
            if (rs == 17 && immediate == 0) group = registers[rt];
            else if (rs == 16 && immediate == 0) slot = registers[rt];
        }
        registers[0] = 0;
    }

    private static uint Word(byte[] bytes, int offset)
    {
        if (offset < 0 || offset + sizeof(uint) > bytes.Length) throw new InvalidDataException("ELF data is truncated.");
        return BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(offset, sizeof(uint)));
    }
}
