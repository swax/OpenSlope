using DiscUtils.Iso9660;
using SSX_Library; // BIG
using Snowknife.Engine;
using Snowknife.Export;
using Snowknife.Repack;

namespace Snowknife.Services;

/// <summary>
/// Level and shared audio decoding: intro music (DATA\AUDIO\&lt;level&gt;.BIG stems), race songs (EA PathFinder
/// .mpf/.mus from MUSIC.BIG), SFX banks (crowd/ambient/board/course, mapped per level inside AUDIO.BIG), and MC
/// announcer speech (SPEECH.BIG MicroTalk). Also the debug one-shots (`bnk`, `audio-file`). The SFX helpers
/// (<see cref="ExportSfxBanks"/>, <see cref="ExtractAudioBigMembers"/>, <see cref="ExportSharedSfxBanksOnly"/>)
/// are shared with `import` step 8 and the `shared` bootstrap.
/// </summary>
internal sealed class AudioService
{
    private readonly IsoService _iso;
    private readonly SoundIndexService _soundIndex;

    public AudioService(IsoService iso)
    {
        _iso = iso;
        _soundIndex = new SoundIndexService(iso);
    }

    // Decode a level's music bank (DATA\AUDIO\<level>.BIG) into <outDir>/Audio/Music/*.wav.
    public int IntroMusic(string[] args)
    {
        if (args.Length < 4) { Log.Error("intro-music needs <iso> <courseSlot> <mapDir>"); return 1; }
        string iso = args[1];
        string levelName = args[2];
        string outDir = Path.GetFullPath(args[3]);

        string work = Path.Combine(Path.GetTempPath(), "snowknife_audio_" + Guid.NewGuid().ToString("N"));
        string? membersDir = ExtractAudioBigMembers(iso, levelName, work);
        if (membersDir == null)
        {
            Log.Error($"Could not find DATA\\AUDIO\\{levelName}.BIG in the ISO.");
            return 1;
        }
        int n = AudioExporter.ExportMusic(membersDir, outDir);
        Log.Info($"(temp work dir left for inspection: {work})");
        return n > 0 ? 0 : 1;
    }

    // The level's RACE music: EA PathFinder songs (musicmap.inf playlist -> music.inf song entries ->
    // MUSIC.BIG .mpf graph + .mus chunks). MUSIC.BIG is 451 MB, so its unpacked members are cached in a
    // stable temp dir across runs rather than a per-run GUID dir.
    public int RaceMusic(string[] args)
    {
        if (args.Length < 4) { Log.Error("race-music needs <iso> <courseSlot> <mapDir>"); return 1; }
        string iso = args[1];
        string levelName = args[2].ToUpperInvariant();
        string outDir = Path.GetFullPath(args[3]);

        string work = Path.Combine(Path.GetTempPath(), "snowknife_musicbig");
        Directory.CreateDirectory(work);

        // The two configs are small - always pull fresh.
        string mapInf = Path.Combine(work, "MUSICMAP.INF");
        string musInf = Path.Combine(work, "MUSIC.INF");
        string membersDir = Path.Combine(work, "files");
        string sourceMarker = Path.Combine(work, "source.txt");
        var isoInfo = new FileInfo(iso);
        string sourceKey = $"{Path.GetFullPath(iso)}|{isoInfo.Length}|{isoInfo.LastWriteTimeUtc.Ticks}";
        using (FileStream isoStream = File.OpenRead(iso))
        {
            CDReader cd = _iso.OpenIso(isoStream);
            _iso.CopyIsoFile(cd, @"DATA\CONFIG\MUSICMAP.INF", mapInf);
            _iso.CopyIsoFile(cd, @"DATA\CONFIG\MUSIC.INF", musInf);
            bool cacheMatches = File.Exists(sourceMarker) && File.ReadAllText(sourceMarker) == sourceKey;
            if (!cacheMatches || !Directory.Exists(membersDir) ||
                Directory.GetFiles(membersDir, "*.mpf", SearchOption.AllDirectories).Length == 0)
            {
                Log.Info("  Extracting DATA\\AUDIO\\MUSIC.BIG (451 MB, cached for later runs)...");
                string bigPath = Path.Combine(work, "MUSIC.BIG");
                var bigFile = _iso.FindIsoFile(cd, @"DATA\AUDIO\MUSIC.BIG");
                if (bigFile == null) { Log.Error("No DATA\\AUDIO\\MUSIC.BIG in the ISO."); return 1; }
                using (Stream src = bigFile.OpenRead())
                using (FileStream dst = File.Create(bigPath))
                    src.CopyTo(dst);
                if (Directory.Exists(membersDir)) Directory.Delete(membersDir, recursive: true);
                Directory.CreateDirectory(membersDir);
                BIG.Extract(bigPath, membersDir);
                File.Delete(bigPath);
                File.WriteAllText(sourceMarker, sourceKey);
            }
        }

        int n = MusicExporter.ExportSongs(mapInf, musInf, membersDir, levelName, outDir);
        Log.Info($"  {n} PathFinder song(s) -> {Path.Combine(outDir, "Audio", "Music")}");
        return n > 0 ? 0 : 1;
    }

    // Decode a level's SFX banks (the mapped members of the shared DATA\AUDIO\AUDIO.BIG) into
    // <outDir>/Audio/SFX/<bank>/NNN.wav. Crowd = stands cheer, the level's course bank = level ambient + one-shots,
    // zboard = board/carve SFX, Wind1 = ambient wind. Returns banks decoded; 0 (non-fatal) if the level
    // has no mapping or AUDIO.BIG / a bank is absent.
    public int Sfx(string[] args)
    {
        if (args.Length < 4) { Log.Error("sfx needs <iso> <courseSlot> <mapDir>"); return 1; }
        string iso = args[1];
        string levelName = args[2];
        string outDir = Path.GetFullPath(args[3]);

        string work = Path.Combine(Path.GetTempPath(), "snowknife_sfx_" + Guid.NewGuid().ToString("N"));
        int n = ExportSfxBanks(iso, levelName, outDir, work);
        Log.Info($"(temp work dir left for inspection: {work})");
        return n > 0 ? 0 : 1;
    }

    // Regenerate only the small map-local routing sidecar. Useful for an existing extraction when no WAVs
    // need to be decoded again; `import` and `sfx` already perform this step automatically.
    public int SoundIndex(string[] args)
    {
        if (args.Length < 4) { Log.Error("sound-index needs <iso> <courseSlot> <mapDir>"); return 1; }
        try
        {
            _soundIndex.Extract(args[1], args[2], Path.GetFullPath(args[3]));
            return 0;
        }
        catch (Exception ex)
        {
            Log.Error($"Could not extract the sound index: {ex.Message}");
            return 1;
        }
    }

    // Regenerate only the disc-global SurfaceType -> board-audio-family sidecar. `shared` performs the same
    // extraction automatically; this command is the cheap backfill for an existing Maps/Shared folder.
    public int BoardSoundIndex(string[] args)
    {
        if (args.Length < 3) { Log.Error("board-sound-index needs <iso> <sharedDir>"); return 1; }
        try
        {
            _soundIndex.ExtractBoardSoundIndex(args[1], Path.GetFullPath(args[2]));
            return 0;
        }
        catch (Exception ex)
        {
            Log.Error($"Could not extract the board sound index: {ex.Message}");
            return 1;
        }
    }

    public BoardSoundIndexDocument ExportBoardSoundIndex(string iso, string sharedDir) =>
        _soundIndex.ExtractBoardSoundIndex(iso, sharedDir);

    // Decode SPEECH.BIG voice banks (.dat = concatenated MicroTalk SCHl streams, one per voice-line
    // variant). Given the ISO, pulls DATA\AUDIO\SPEECH.BIG (685 MB - unpacked once into a stable temp
    // cache) and decodes the MC announcer's event banks; given a .dat file or a directory, decodes that.
    public int Speech(string[] args)
    {
        if (args.Length < 3) { Log.Error("speech needs <iso|file.dat|dir> <outDir>"); return 1; }
        string inPath = Path.GetFullPath(args[1]);
        string outDir = Path.GetFullPath(args[2]);

        if (inPath.EndsWith(".iso", StringComparison.OrdinalIgnoreCase))
        {
            string work = Path.Combine(Path.GetTempPath(), "snowknife_speechbig");
            string membersDir = Path.Combine(work, "files");
            string mcDir = Path.Combine(membersDir, "data", "speech", "mc");
            if (!Directory.Exists(mcDir) || Directory.GetFiles(mcDir, "*.dat").Length == 0)
            {
                Log.Info("  Extracting DATA\\AUDIO\\SPEECH.BIG (685 MB, cached for later runs)...");
                Directory.CreateDirectory(work);
                string bigPath = Path.Combine(work, "SPEECH.BIG");
                using (FileStream isoStream = File.OpenRead(inPath))
                {
                    CDReader cd = _iso.OpenIso(isoStream);
                    var bigFile = _iso.FindIsoFile(cd, @"DATA\AUDIO\SPEECH.BIG");
                    if (bigFile == null) { Log.Error("No DATA\\AUDIO\\SPEECH.BIG in the ISO."); return 1; }
                    using Stream src = bigFile.OpenRead();
                    using FileStream dst = File.Create(bigPath);
                    src.CopyTo(dst);
                }
                Directory.CreateDirectory(membersDir);
                BIG.Extract(bigPath, membersDir);
                File.Delete(bigPath);
            }
            inPath = mcDir;   // the in-race announcer's per-event banks
        }

        string[] dats = Directory.Exists(inPath)
            ? Directory.GetFiles(inPath, "*.dat", SearchOption.AllDirectories)
            : new[] { inPath };
        int banks = 0;
        foreach (string dat in dats)
        {
            try { if (AudioExporter.ExportSpeechDat(dat, outDir) > 0) banks++; }
            catch (Exception ex) { Log.Warn($"  ! {Path.GetFileName(dat)}: {ex.Message}"); }
        }
        Log.Info($"  {banks}/{dats.Length} speech bank(s) -> {outDir}");
        return banks > 0 ? 0 : 1;
    }

    // Decode a BNKl sound bank to WAVs (debug/exploration; --verbose dumps each sound's patches).
    public int Bnk(string[] args)
    {
        if (args.Length < 3) { Log.Error("bnk needs <file.bnk> <outDir> [--verbose]"); return 1; }
        string inPath = Path.GetFullPath(args[1]);
        string outDir = Path.GetFullPath(args[2]);
        bool verbose = args.Any(a => a == "--verbose" || a == "-v");
        if (!File.Exists(inPath)) { Log.Error($"Not found: {inPath}"); return 1; }
        return AudioExporter.ExportBank(inPath, outDir, verbose) > 0 ? 0 : 1;
    }

    /// <summary>`bnk-rebuild &lt;in.bnk&gt; &lt;out.bnk&gt; [--pad-to N]` — load a bank and write it back out,
    /// changing nothing.
    ///
    /// A bisecting tool rather than a build step. "The bank we WROTE is correct" and "the bank we wrote is
    /// what the console accepts" are different claims, and separating them needs a bank that has been through
    /// the writer with no other change — anything else confounds the layout with whatever was injected.
    /// `--pad-to` appends zero bytes so the result can drop into an archive slot of the original's size,
    /// which is what makes the test an in-place ISO replace instead of a repack.</summary>
    public int BnkRebuild(string[] args)
    {
        if (args.Length < 3) { Log.Error("bnk-rebuild needs <in.bnk> <out.bnk> [--pad-to N]"); return 1; }
        string inPath = Path.GetFullPath(args[1]), outPath = Path.GetFullPath(args[2]);
        if (!File.Exists(inPath)) { Log.Error($"Not found: {inPath}"); return 1; }
        byte[] original = File.ReadAllBytes(inPath);
        var bank = Formats.BnkFile.Load(original);
        // `--replace=SLOT=file.wav` is the other half of the bisect: it puts this encoder's output into a slot
        // the bank already ships, so "a sound we built is audible" can be asked without also asking "a slot
        // the bank never had is audible" - two questions that are otherwise confounded.
        foreach (string argument in args)
        {
            if (!argument.StartsWith("--replace=", StringComparison.Ordinal)) continue;
            string[] parts = argument["--replace=".Length..].Split('=', 2);
            if (parts.Length != 2 || !int.TryParse(parts[0], out int slot))
            { Log.Error("--replace wants SLOT=file.wav"); return 1; }
            var (samples, rate) = Repack.CourseBankInject.ReadWavPcm16Mono(File.ReadAllBytes(parts[1]));
            while (bank.Slots.Count <= slot) bank.Slots.Add(null);
            bank.Slots[slot] = Formats.BnkFile.BuildPsAdpcm(Formats.PsAdpcmEncoder.Encode(samples), samples.Length, rate);
            Log.Info($"  slot {slot:D3} <- {Path.GetFileName(parts[1])} "
                + $"({samples.Length / (double)rate:0.0}s @ {rate} Hz, one-shot)");
        }
        byte[] rebuilt = bank.Write();
        int padTo = 0;
        int flag = Array.IndexOf(args, "--pad-to");
        if (flag >= 0 && flag + 1 < args.Length && !int.TryParse(args[flag + 1], out padTo))
        { Log.Error("--pad-to needs a byte count"); return 1; }
        if (padTo > 0 && rebuilt.Length > padTo)
        { Log.Error($"rebuilt bank is {rebuilt.Length:N0} bytes, past the {padTo:N0} asked for"); return 1; }
        if (padTo > rebuilt.Length) Array.Resize(ref rebuilt, padTo);
        File.WriteAllBytes(outPath, rebuilt);
        Log.Info($"bnk-rebuild: {original.Length:N0} -> {rebuilt.Length:N0} bytes"
            + (rebuilt.Length == original.Length && rebuilt.AsSpan().SequenceEqual(original) ? " (byte-identical)" : ""));
        return 0;
    }

    // Decode a single EA SCHl stream file to WAV.
    public int AudioFile(string[] args)
    {
        if (args.Length < 3) { Log.Error("audio-file needs <schl-file> <out.wav>"); return 1; }
        string inPath = Path.GetFullPath(args[1]);
        string outWav = Path.GetFullPath(args[2]);
        if (!File.Exists(inPath)) { Log.Error($"Not found: {inPath}"); return 1; }
        return AudioExporter.DecodeFileToWav(inPath, outWav);
    }

    // Pull the BANKS.INF-declared SFX banks for <levelName> out of the shared AUDIO.BIG and decode each to
    // <outDir>/Audio/SFX/<bank>/NNN.wav. Shared by `sfx` and `import` step 8.
    public int ExportSfxBanks(string iso, string levelName, string outDir, string work)
    {
        DiscSoundBanks discBanks;
        try { discBanks = _soundIndex.ReadBanks(iso, levelName); }
        catch (Exception ex)
        {
            Log.Warn($"      (BANKS.INF could not resolve level '{levelName}': {ex.Message} - skipping SFX.)");
            return 0;
        }
        try { _soundIndex.Extract(iso, levelName, outDir); }
        catch (Exception ex)
        {
            Log.Warn($"      ! collision sound index not written: {ex.Message}");
            // The environment contract is independent of collision routing, so a region whose dispatcher is
            // not yet recognized can still produce the declared filler and its bank.
            EnvironmentAudioDocument.WriteDefault(outDir);
        }

        var banks = discBanks.LevelBanks.Values.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        if (banks.Count == 0) return 0;

        string? filesDir = ExtractSharedAudioBig(iso, work);
        if (filesDir == null) { Log.Warn("      (no DATA\\AUDIO\\AUDIO.BIG in ISO - skipping SFX.)"); return 0; }

        var requestedBanks = banks.ToList();
        // Environment.json is the portable declaration both Unity and Slopesmith consume. Its default bed is
        // deliberately staged even when no retail ExternalSounds record references event 116: this is an
        // explicit OpenSlope off-board fallback, never an inference from a map emitter or weather state.
        string environmentBank = EnvironmentAudioDocument.DefaultBed().Bank;
        bool addedEnvironmentBed = !requestedBanks.Contains(environmentBank, StringComparer.OrdinalIgnoreCase);
        if (addedEnvironmentBed)
            requestedBanks.Add(environmentBank);
        int beforeReferencedEnvironment = requestedBanks.Count;
        var dynamicEvents = new SortedSet<int>();
        foreach (string bank in ReadReferencedExternalBanks(outDir, dynamicEvents))
            if (!requestedBanks.Contains(bank, StringComparer.OrdinalIgnoreCase)) requestedBanks.Add(bank);
        if (addedEnvironmentBed)
            Log.Info($"      environment bed: declared {environmentBank}/000 bank added.");
        if (requestedBanks.Count > beforeReferencedEnvironment)
            Log.Info($"      native environment: {requestedBanks.Count - beforeReferencedEnvironment} referenced global bank(s) added.");
        if (dynamicEvents.Count > 0)
            Log.Info($"      native environment: dynamic event program(s) {string.Join(", ", dynamicEvents)} remain unexported.");

        string sfxOut = Path.Combine(outDir, "Audio", "SFX");
        int decoded = 0;
        foreach (string bank in requestedBanks)
        {
            string? bnk = FindBankFile(filesDir, bank);
            if (bnk == null) { Log.Warn($"      ! SFX bank '{bank}.bnk' not in AUDIO.BIG - skipping."); continue; }
            try { AudioExporter.ExportBank(bnk, sfxOut, folderName: ExternalSoundCatalog.OutputBankName(bank)); decoded++; }
            catch (Exception ex) { Log.Warn($"      ! {bank}.bnk: {ex.Message}"); }
        }
        FillMissingCourseSlots(outDir, sfxOut, filesDir, discBanks);
        return decoded;
    }

    // Decode ONLY the shared/reference SFX banks from AUDIO.BIG into <outDir>/Audio/SFX/<bank>/. Like ExportSfxBanks
    // but excludes the per-level course BANK + its missing-slot donor-fill, so a project's SSX/Shared carries just the
    // reusable audio (the board's zboard carve loops, crowd, wind candidates, zbxsfx gem chimes, tricky announcer SFX).
    public int ExportSharedSfxBanksOnly(string iso, string outDir, string work)
    {
        string? filesDir = ExtractSharedAudioBig(iso, work);
        if (filesDir == null) { Log.Warn("      (no DATA\\AUDIO\\AUDIO.BIG in ISO - skipping shared SFX.)"); return 0; }
        string sfxOut = Path.Combine(outDir, "Audio", "SFX");
        int decoded = 0;
        foreach (string bank in SharedSfxBanks)
        {
            string? bnk = Directory.GetFiles(filesDir, bank + ".bnk", SearchOption.AllDirectories).FirstOrDefault();
            if (bnk == null) { Log.Warn($"      ! shared SFX bank '{bank}.bnk' not in AUDIO.BIG - skipping."); continue; }
            try { AudioExporter.ExportBank(bnk, sfxOut, folderName: bank); decoded++; }
            catch (Exception ex) { Log.Warn($"      ! {bank}.bnk: {ex.Message}"); }
        }
        return decoded;
    }

    // Shared/reference SFX banks; the one OTHER entry in a level's runtime bank list is its course BANK
    // (BANKS.INF group 2: the per-level course bank). Mirrors ImportConfig.DetectLevelSfxBank.
    private static readonly string[] SharedSfxBanks = { "Crowd", "zboard", "Wind1", "Wind2", "zbxsfx", "tricky" };

    // Type-0 ExternalSounds that resolve through the dedicated group-6 bank dispatcher need their named global
    // banks in the map's neutral Audio/SFX staging area. Read only the fixed programs referenced by this map;
    // decoding every environmental bank would waste project/import size, particularly on Quest. Normal group-2
    // external events use the already-decoded course bank and crowd events use Crowd, so neither belongs here.
    private static IEnumerable<string> ReadReferencedExternalBanks(string levelDir, SortedSet<int> dynamicEvents)
    {
        var instances = Bundle.SsxInstances.Load(levelDir);
        if (instances == null) yield break;
        var emitted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var instance in instances)
        {
            if (instance.Sounds?.ExternalSounds == null) continue;
            foreach (var sound in instance.Sounds.ExternalSounds)
            {
                // Types 0 (point) and 1 (oriented ellipsoid, approximated as a sphere by ScenePlacementBundle)
                // both reach the importer. Types 2/3 have no records in any of the 11 retail courses.
                if (sound.U0 != 0 && sound.U0 != 1) continue;
                if (ExternalSoundCatalog.TryGetFixedBank(sound.SoundIndex, out string bank))
                {
                    if (emitted.Add(bank)) yield return bank;
                }
                else if (ExternalSoundCatalog.IsDynamicSpecialEvent(sound.SoundIndex))
                    dynamicEvents.Add(sound.SoundIndex);
            }
        }
    }

    private static string? FindBankFile(string filesDir, string bank)
    {
        string wanted = Path.GetFileNameWithoutExtension(bank).Trim();
        return Directory.GetFiles(filesDir, "*.bnk", SearchOption.AllDirectories)
            .FirstOrDefault(p => Path.GetFileNameWithoutExtension(p).Trim()
                .Equals(wanted, StringComparison.OrdinalIgnoreCase));
    }

    // Course-bank slots have FIXED MEANINGS across levels: the global event-id resolver ([Trailmap: 420-audio-runtime]) maps each
    // id to the same slot for every course, and the SSF effect-graph SoundPlay path ([Trailmap: 230-level-ssf]) plays its id
    // RAW from group 2 (the course BANK). A level's bank ships only the subset it filled - when its SSF graph
    // references a slot the bank left empty, the game plays NOTHING (verified: no remap, no fallback - e.g.
    // a Bomb_Event SoundPlay 83 vs the course bank's empty slot 83). Better than silence: fill each such
    // referenced-but-missing slot from the first sibling course bank that ships it (slot 083 = the big
    // bang sibling of the 082 firework report), and say so - the fill is auditable, not silent.
    private void FillMissingCourseSlots(string levelDir, string sfxOut, string audioBigDir, DiscSoundBanks banks)
    {
        string? courseBank = banks.LevelBanks.TryGetValue(2, out string? mapped) ? mapped : null;
        if (courseBank == null) return;

        List<int> wanted = ReadSsfSoundPlayIds(levelDir);
        if (wanted.Count == 0) return;   // no effect document next to the audio output (standalone run) - nothing to check

        string bankDir = Path.Combine(sfxOut, courseBank);
        var missing = wanted.Where(id => !File.Exists(Path.Combine(bankDir, $"{id:D3}.wav"))).ToList();
        if (missing.Count == 0) return;

        foreach (int slot in missing)
        {
            bool filled = false;
            foreach (string donor in banks.CourseBanks)
            {
                if (donor.Equals(courseBank, StringComparison.OrdinalIgnoreCase)) continue;
                string? bnk = Directory.GetFiles(audioBigDir, donor + ".bnk", SearchOption.AllDirectories).FirstOrDefault();
                if (bnk == null) continue;
                if (AudioExporter.ExportBankSlot(bnk, slot, Path.Combine(bankDir, $"{slot:D3}.wav")))
                {
                    Log.Info($"      {courseBank}: slot {slot:D3} is referenced by the level's SSF graph but not in its bank - filled from {donor}.");
                    filled = true;
                    break;
                }
            }
            if (!filled)
                Log.Info($"      {courseBank}: slot {slot:D3} is referenced by the level's SSF graph but no course bank ships it - stays silent.");
        }
    }

    // All MainType-8 "SoundPlay" ids in the level's SSF effect graph (the shared SsfLogic view of
    // Effects.json) - the course-bank (group 2) slots its effects play raw. Empty if the document is
    // absent/unparseable.
    private static List<int> ReadSsfSoundPlayIds(string levelDir)
    {
        var ids = new List<int>();
        var root = Bundle.SsfLogic.Load(levelDir);
        foreach (var hdr in root?.EffectHeaders ?? Array.Empty<Bundle.SsfHeader>())
            foreach (var node in hdr?.Effects ?? Array.Empty<Bundle.SsfNode>())
                if (node?.MainType == SsfMainType.PlaySound && node.SoundPlay >= 0 && !ids.Contains(node.SoundPlay))
                    ids.Add(node.SoundPlay);
        ids.Sort();
        return ids;
    }

    // Pull the shared DATA\AUDIO\AUDIO.BIG out of the ISO and unpack it once; returns the unpacked-members
    // directory (or null if absent). Cached per work dir so `import` doesn't extract its 13.7 MB twice.
    private string? ExtractSharedAudioBig(string iso, string work)
    {
        string filesDir = Path.Combine(work, "audio_shared");
        if (Directory.Exists(filesDir) && Directory.GetFiles(filesDir, "*.bnk", SearchOption.AllDirectories).Length > 0)
            return filesDir;   // already extracted this run

        Directory.CreateDirectory(work);
        string bigPath = Path.Combine(work, "AUDIO.BIG");
        using (FileStream isoStream = File.OpenRead(iso))
        {
            CDReader cd = _iso.OpenIso(isoStream);
            var bigFile = _iso.FindIsoFile(cd, @"DATA\AUDIO\AUDIO.BIG");
            if (bigFile == null) return null;
            using Stream src = bigFile.OpenRead();
            using FileStream dst = File.Create(bigPath);
            src.CopyTo(dst);
        }
        Directory.CreateDirectory(filesDir);
        BIG.Extract(bigPath, filesDir);
        return filesDir;
    }

    // Pull DATA\AUDIO\<level>.BIG out of the ISO and unpack it; returns the unpacked-members
    // directory (or null if the ISO has no audio bank for this level).
    public string? ExtractAudioBigMembers(string iso, string levelName, string work)
    {
        string bigDir = Path.Combine(work, "big");
        string filesDir = Path.Combine(work, "files");
        Directory.CreateDirectory(bigDir);
        Directory.CreateDirectory(filesDir);

        string bigPath = Path.Combine(bigDir, levelName.ToUpperInvariant() + "_AUDIO.BIG");
        using (FileStream isoStream = File.OpenRead(iso))
        {
            CDReader cd = _iso.OpenIso(isoStream);
            var bigFile = FindAudioBig(cd, levelName);
            if (bigFile == null) return null;
            using Stream src = bigFile.OpenRead();
            using FileStream dst = File.Create(bigPath);
            src.CopyTo(dst);
        }
        BIG.Extract(bigPath, filesDir);
        return filesDir;
    }

    // A level's INTRO-music BIG in DATA\AUDIO isn't always named like its model BIG: a level's models may be in
    // SNOW.BIG while its audio is SNOWDRM.BIG (likewise PIPE->PIPEDRM, MEGAPLE->MEGAPLEX, MERQUER->MERQURY). Map
    // those, then look up <name>.BIG in DATA\AUDIO.
    private static readonly Dictionary<string, string> AudioBigAlias =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["SNOW"] = "SNOWDRM", ["PIPE"] = "PIPEDRM", ["MEGAPLE"] = "MEGAPLEX", ["MERQUER"] = "MERQURY",
        };

    private DiscUtils.DiscFileInfo? FindAudioBig(CDReader cd, string levelName)
    {
        var audioDir = cd.GetDirectoryInfo(@"DATA\AUDIO");
        string want = levelName.ToUpperInvariant();
        if (want.EndsWith(".BIG")) want = want.Substring(0, want.Length - 4);
        if (AudioBigAlias.TryGetValue(want, out var alias)) want = alias;
        want += ".BIG";
        return audioDir.GetFiles().FirstOrDefault(f =>
            string.Equals(_iso.CleanName(f.Name), want, StringComparison.OrdinalIgnoreCase));
    }
}
