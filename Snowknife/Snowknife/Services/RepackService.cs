using Newtonsoft.Json.Linq; // authored-gem instance synthesis (repack)
using SSX_Library;          // BIG
using SSX_Library.FileHandlers.LevelFiles.Tricky;
using SSX_Library.FileHandlers.LevelFiles.Tricky.PS2;   // SSFHandler (repack ssf sanitize + validate)
using SSXLibrary;           // TrickyLevelInterface
using System.Numerics;
using Snowknife.Repack;
using Snowknife.Formats;

namespace Snowknife.Services;

/// <summary>
/// The custom-mountain repack pipeline: regenerate a level's .pbd from its Maps JSON (`pbd-from-json`),
/// `repack` that swaps one level, and `repack-many` that builds several slots from a manifest. Composes the
/// ISO / BIG / RefPack / SSH / ELF services. Also the `ltg-stats` grid diagnostic used while tuning the rebuild.
/// </summary>
internal sealed class RepackService
{
    private readonly IsoService _iso;
    private readonly BigArchiveService _big;
    private readonly RefpackService _refpack;
    private readonly SshTextureService _ssh;
    private readonly ElfPatchService _elf;
    private readonly ContractValidationService _contracts;

    public RepackService(IsoService iso, BigArchiveService big, RefpackService refpack,
                         SshTextureService ssh, ElfPatchService elf, ContractValidationService contracts)
    {
        _iso = iso;
        _big = big;
        _refpack = refpack;
        _ssh = ssh;
        _elf = elf;
        _contracts = contracts;
    }

    /// <summary>
    /// Canonical authored props may occupy only the ordinary list or the live-verified Showoff layer. Keep
    /// state 2 and collapse every other incoming value to common state 0; raw state 1 is not an authoring API.
    /// </summary>
    internal static int NormalizeAuthoredPropLtgState(int state) => state == 2 ? 2 : 0;

    // --json puts the plan record alone on stdout, so the pipeline's own progress goes to stderr and the
    // record pipes straight into a check. Swapping Console.Out rather than Log's sink is deliberate: the
    // SSX-Library level builder writes to Console directly, and Log follows Console.Out on every call anyway.
    private static int Quietly(Func<int> run)
    {
        var stdout = Console.Out;
        Console.SetOut(Console.Error);
        try { return run(); }
        finally { Console.SetOut(stdout); }
    }

    // Build several custom course slots from one clean source ISO. Every slot is regenerated against the
    // source disc, all BIG replacements land in one temporary output, and the finished image replaces the
    // requested output only after every level and executable patch succeeds. `--dry-run` reports every
    // listed slot's plan together instead, which is where two courses contending for one bank shows.
    public int RepackMany(string[] args)
    {
        if (!args.Contains("--json")) return RepackMany(args, null);
        if (!args.Contains("--dry-run"))
        { Log.Error("repack-many: --json describes a plan, so it needs --dry-run."); return 1; }
        var record = new List<RepackPlan>();
        int rc = Quietly(() => RepackMany(args, record));
        Log.Info(new JObject
        {
            ["kind"] = "repack-many-dry-run",
            ["levels"] = new JArray(record.Select(plan => plan.ToJson())),
        }.ToString(Newtonsoft.Json.Formatting.Indented));
        return rc;
    }

    private int RepackMany(string[] args, List<RepackPlan>? record)
    {
        if (args.Length < 2)
        { Log.Error("repack-many needs <manifest.json>"); return 1; }

        string manifestPath = Path.GetFullPath(args[1]);
        _contracts.RequireFile(manifestPath, ContractKind.RepackManifestV1);
        var manifest = JObject.Parse(File.ReadAllText(manifestPath));
        string root = Path.GetDirectoryName(manifestPath)!;
        string Resolve(string? value, string field)
        {
            if (string.IsNullOrWhiteSpace(value)) throw new InvalidDataException($"repack-many: manifest needs {field}.");
            return Path.GetFullPath(Path.IsPathRooted(value) ? value : Path.Combine(root, value));
        }

        string inputIso = Resolve((string?)manifest["InputIso"], "InputIso");
        string outputIso = Resolve((string?)manifest["OutputIso"], "OutputIso");
        // Keep the custom-page format in the manifest, not as an impossible-to-express repack-many CLI
        // afterthought. Slopesmith exports opt into retail-shaped type 2: a prop-heavy course can exceed the
        // measured type-5 GS-VRAM ceiling while the exact same pages fit comfortably as indexed textures.
        bool textureType2 = (bool?)manifest["TextureType2"] == true;
        // Same argument for the sound side: the rate belongs beside the pages it trades against, because
        // both are spending the same kind of budget on the same disc.
        int soundRate = (int?)manifest["SoundRate"] ?? 0;
        if (manifest["Levels"] is not JArray levels || levels.Count == 0)
        { Log.Error("repack-many: manifest needs a non-empty Levels array."); return 1; }

        var jobs = new List<(string slot, string levelData, string export)>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var token in levels)
        {
            if (token is not JObject item) throw new InvalidDataException("repack-many: every Levels entry must be an object.");
            string slot = ((string?)item["Slot"] ?? "").ToUpperInvariant();
            if (slot.Length == 0) throw new InvalidDataException("repack-many: every level needs Slot.");
            if (!seen.Add(slot)) throw new InvalidDataException($"repack-many: slot {slot} is listed more than once.");
            jobs.Add((slot, Resolve((string?)item["LevelData"], $"Levels[{slot}].LevelData"),
                             Resolve((string?)item["Export"], $"Levels[{slot}].Export")));
        }
        using var prettyOutput = RepackConsole.NormalizeSharedServiceOutput();

        // Dry run: every slot is planned against the same clean source bank, then reported together. No
        // output image is touched, so the manifest's OutputIso need not exist.
        if (args.Contains("--dry-run"))
        {
            RepackConsole.Header("repack many dry run", $"{jobs.Count} course(s)", inputIso, outputIso);
            RepackConsole.Section("Inspect courses");
            var plans = new List<RepackPlan>();
            foreach (var job in jobs)
            {
                var one = new List<string> { "repack", inputIso, job.slot, job.levelData, job.export, outputIso, "--dry-run" };
                if (textureType2) one.Add("--texture-type2");
                if (soundRate > 0) { one.Add("--sound-rate"); one.Add(soundRate.ToString()); }
                if ((bool?)manifest["SkyColors"] == false) one.Add("--no-skycolor");
                if ((bool?)manifest["BareSlot"] == true) one.Add("--bare-slot");
                int rc = Repack(one.ToArray(), plans);
                if (rc != 0) return rc;
            }
            foreach (var plan in plans) plan.WriteTo(Log.Out);
            RepackConsole.Section("Summary");
            RepackConsole.Detail($"{plans.Count} course(s) against {Path.GetFileName(inputIso)}");
            foreach (var plan in plans) Log.Info(plan.Summary());
            // Every job borrows from the CLEAN source image, so a donor this manifest also replaces still
            // hands over its retail pages - not the custom mountain being built into that slot.
            var replaced = new HashSet<string>(jobs.Select(job => job.slot), StringComparer.OrdinalIgnoreCase);
            foreach (var plan in plans)
                foreach (string donor in plan.DonorLevels.Where(replaced.Contains))
                    RepackConsole.Detail($"Note: {plan.Level} borrows pages from {donor}, which this manifest also replaces "
                        + "— donor pages come from the clean source image, so they are the retail bank's.");
            record?.AddRange(plans);
            return 0;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(outputIso)!);
        string building = outputIso + ".building-" + Guid.NewGuid().ToString("N");
        var started = System.Diagnostics.Stopwatch.StartNew();
        try
        {
            RepackConsole.Header("repack many", $"{jobs.Count} course(s)", inputIso, outputIso);
            RepackConsole.Section("Prepare source");
            RepackConsole.Detail("Copying the clean source ISO once");
            File.Copy(inputIso, building, overwrite: true);
            foreach (var job in jobs)
            {
                var one = new List<string> { "repack", inputIso, job.slot, job.levelData, job.export, building, "--in-place" };
                if (textureType2) one.Add("--texture-type2");
                if (soundRate > 0) { one.Add("--sound-rate"); one.Add(soundRate.ToString()); }
                if ((bool?)manifest["SkyColors"] == false) one.Add("--no-skycolor");
                if ((bool?)manifest["BareSlot"] == true) one.Add("--bare-slot");
                int rc = Repack(one.ToArray());
                if (rc != 0) return rc;
            }

            bool noclip = (bool?)manifest["Noclip"] == true;
            if (noclip) RepackConsole.Section("Executable patches");
            if (noclip)
            { int rc = _elf.Apply(building, "noclip", "noclip-fly-mode", revert: false); if (rc != 0) return rc; }

            File.Move(building, outputIso, overwrite: true);
            RepackConsole.Success($"Repacked {jobs.Count} course(s)", outputIso, started.Elapsed);
            return 0;
        }
        finally
        {
            try { if (File.Exists(building)) File.Delete(building); } catch { }
        }
    }

    // Regenerate a level's .pbd (terrain + meshes + instances + materials + lights + splines) from its
    // Maps JSON folder, via SSX-Library's TrickyLevelInterface (the inverse of `import`). Only the PBD
    // is built; every other member stays whatever you pair it with at pack time. Output is uncompressed -
    // RefPack it (e.g. through a one-member big-create) before placing it in a BIG.
    public int PbdFromJson(string[] args)
    {
        if (args.Length < 3) { Log.Error("pbd-from-json needs <mapDir> <out.pbd> [--ssh] [--lssh] [--map] [--keepslots <orig.ssh>]"); return 1; }
        string loadDir = args[1];
        string outPbd = args[2]; // BuildTrickyLevelFiles strips the 4-char extension, so pass a *.pbd path
        if (!File.Exists(Path.Combine(loadDir, "Patches.json")))
        { Log.Error($"No Patches.json in {loadDir} - run `snowknife import` first."); return 1; }
        _contracts.RequireFile(Path.Combine(loadDir, "Patches.json"), ContractKind.PatchesV1);
        _contracts.RequireIfPresent(Path.Combine(loadDir, "Splines.json"), ContractKind.SplinesV1);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPbd))!);

        // --keepslots <orig.ssh>: pin each TexturePath's index to its bare slot number ("0028.png" -> 28) by
        // seeding the texture-name list with the original ssh's slots in order, so the verbatim ssh is reused
        // (no re-encode). Otherwise the PBD numbers textures in appearance order and needs a regenerated ssh.
        int ki = Array.IndexOf(args, "--keepslots");
        List<string>? seed = null;
        if (ki >= 0 && ki + 1 < args.Length)
        {
            byte[] hdr = new byte[12];
            using (var fsr = File.OpenRead(args[ki + 1])) fsr.ReadExactly(hdr, 0, 12);
            int count = BitConverter.ToInt32(hdr, 8); // SHPS image count (LE u32 @ +8)
            seed = Enumerable.Range(0, count).Select(i => i.ToString("D4") + ".png").ToList();
            Log.Info($"keepslots: seeding {count} texture slots from {Path.GetFileName(args[ki + 1])} (verbatim ssh reused)");
        }

        bool ssh = args.Contains("--ssh") && seed == null, lssh = args.Contains("--lssh"), map = args.Contains("--map");
        bool aip = args.Contains("--aip"), sop = args.Contains("--sop"), ltg = args.Contains("--ltg");
        var lvl = new TrickyLevelInterface
        {
            PBDGenerate = true, SSHGenerate = ssh, LSSHGenerate = lssh, MAPGenerate = map,
            LTGGenerate = ltg, SkyPBDGenerate = false, SkySSHGenerate = false,
            ADLGenerate = false, SSFGenerate = false, AIPGenerate = aip, SOPGenerate = sop,
            SeedImageFiles = seed,
        };
        lvl.BuildTrickyLevelFiles(loadDir, outPbd);

        string stem = outPbd[..^4];
        foreach (var (flag, ext) in new[] { (true, ".pbd"), (ssh, ".ssh"), (lssh, "_L.ssh"), (map, ".map"), (aip, ".aip"), (sop, ".sop"), (ltg, ".ltg") })
            if (flag && File.Exists(stem + ext))
                Log.Info($"  -> {stem + ext} ({new FileInfo(stem + ext).Length:n0} bytes, uncompressed)");
        return 0;
    }

    // One-shot: replace <levelName> in <iso> with a custom mountain, keeping that level's props / paths /
    // textures. Clone the level's sidecars, overlay the custom Patches.json (texture names normalised to
    // bare slots), regenerate the pbd against the verbatim ssh (--keepslots), then rebuild the world
    // (spatial/collision) grid (.ltg) from that pbd so terrain collision tracks the new patches, pack, patch
    // a fresh ISO. If the custom dir authored lighting it is carried in too (both optional, no-op when
    // absent): a custom Lights.json overlays the engine lights, and a custom Lightmaps/ regenerates _L.ssh
    // (static terrain lightmaps). Paths verbatim; the custom terrain must be authored on the level's coords.
    public int Repack(string[] args)
    {
        if (!args.Contains("--json")) return Repack(args, null);
        if (!args.Contains("--dry-run"))
        { Log.Error("repack: --json describes a plan, so it needs --dry-run."); return 1; }
        var record = new List<RepackPlan>();
        int rc = Quietly(() => Repack(args, record));
        foreach (var plan in record) Log.Info(plan.ToJson().ToString(Newtonsoft.Json.Formatting.Indented));
        return rc;
    }

    /// <summary>`--sound-rate [hz]` — the rate custom course-bank clips are converted to, 0 to take the
    /// target bank's own.
    ///
    /// The default is the one to use: the engine does not honour a sound's own rate tag, so a clip that does
    /// not match the bank it joins plays at the wrong speed and pitch — measured, a 440 Hz tone authored at
    /// 22,050 came back audibly flat beside the same tone at 16,000. An explicit value exists for trading
    /// fidelity against the bank's byte budget, not for choosing a house style.</summary>
    internal static bool TryParseSoundRate(string[] args, out int rate, out string? error)
    {
        const string Flag = "--sound-rate";
        const int Lowest = 4000, Highest = 48000;
        rate = 0;
        error = null;
        for (int i = 0; i < args.Length; i++)
        {
            string? value = null;
            if (args[i] == Flag)
            {
                if (i + 1 >= args.Length || args[i + 1].StartsWith('-'))
                { rate = CourseBankInject.RetailSoundRate; continue; }
                value = args[++i];
            }
            else if (args[i].StartsWith(Flag + "=", StringComparison.Ordinal))
                value = args[i][(Flag.Length + 1)..];

            if (value == null) continue;
            if (!int.TryParse(value, out int hz) || hz < Lowest || hz > Highest)
            {
                error = $"{Flag} wants a rate in Hz from {Lowest} to {Highest} — bare, it takes retail's "
                    + $"{CourseBankInject.RetailSoundRate}; got '{value}'.";
                return false;
            }
            rate = hz;
        }
        return true;
    }

    // `--dry-run` is this same pipeline with the writes elided: it reads the source ISO's bank, the target
    // level and the export folder, runs the real texture allocation, path normalization and sky decision, and
    // reports what those steps produced instead of packing an ISO (Slopesmith docs/037). Every number in
    // the report is handed over BY the step that produced it, so nothing is predicted. `collected` gathers the
    // plan for repack-many and for --json; without it a dry run prints its own report.
    private int Repack(string[] args, List<RepackPlan>? collected)
    {
        if (args.Length < 6)
        { Log.Error("repack needs <iso> <courseSlot> <mapDir> <customDir> <out.iso>"); return 1; }
        if (!RepackPatchSelection.TryParse(args, out var selectedPatches, out string? patchError))
        { Log.Error($"repack: {patchError}"); return 1; }
        if (!TryParseSoundRate(args, out int soundRate, out string? soundRateError))
        { Log.Error($"repack: {soundRateError}"); return 1; }
        string iso = args[1], level = args[2].ToUpperInvariant(), levelDir = args[3], customDir = args[4], outIso = args[5];
        bool textureType2 = args.Contains("--texture-type2");
        // Inherit the slot but not its prop population - see HideDonorInstances.
        bool bareSlot = args.Contains("--bare-slot");
        var plan = args.Contains("--dry-run") ? new RepackPlan(level, customDir, textureType2) : null;
        var started = System.Diagnostics.Stopwatch.StartNew();
        using var prettyOutput = RepackConsole.NormalizeSharedServiceOutput();
        // Every drop and fallback the pipeline announces is also a line of the plan's Findings section.
        void Warn(string code, string message)
        {
            RepackConsole.Warning(message);
            plan?.Note(code, message);
        }
        _contracts.RequireFile(Path.Combine(customDir, "Patches.json"), ContractKind.PatchesV1);
        _contracts.RequireIfPresent(Path.Combine(customDir, "Splines.json"), ContractKind.SplinesV1);
        _contracts.RequireIfPresent(Path.Combine(customDir, "Effects.json"), ContractKind.EffectsV1);
        _contracts.RequireIfPresent(Path.Combine(customDir, "Audio", EnvironmentAudioDocument.FileName),
            ContractKind.EnvironmentAudioV1);
        string lower = level.ToLowerInvariant();
        string bigInIso = $"DATA\\MODELS\\{level}.BIG";
        string tmp = Path.Combine(Path.GetTempPath(), "ssxrepack_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(tmp);
        try
        {
            string export = Path.GetFileName(customDir.TrimEnd('\\', '/'));
            bool nested = args.Contains("--in-place") || collected != null;
            if (nested) RepackConsole.Section($"{level}  ←  {export}");
            else RepackConsole.Header(plan == null ? "repack" : "repack dry run", $"{level}  ←  {export}", iso, outIso);
            RepackConsole.Section(plan == null ? "Prepare source" : "Inspect source");
            if (textureType2) RepackConsole.Detail("Custom textures: type-2, 8-bit indexed (opt-in)");
            if (soundRate > 0) RepackConsole.Detail($"Custom sounds: converted to {soundRate} Hz (asked for, in place of the bank's own)");
            if (!args.Contains("--in-place") && plan == null)
            {
                RepackConsole.Detail("Copying source ISO");
                File.Copy(iso, outIso, overwrite: true);
            }

            // pull the level's BIG: raw members (verbatim swap) + decompressed ssh (keepslots slot count)
            string bigPath = Path.Combine(tmp, $"{lower}.big");
            _iso.ExtractFile(iso, bigInIso, bigPath);
            string rawDir = Path.Combine(tmp, "raw");
            _big.RawExtractC0fb(bigPath, rawDir);
            BIG.Extract(bigPath, Path.Combine(tmp, "dec"));
            int slots;
            using (var fr = File.OpenRead(Path.Combine(tmp, "dec", "data", "models", $"{lower}.ssh")))
            { var h = new byte[12]; fr.ReadExactly(h, 0, 12); slots = BitConverter.ToInt32(h, 8); }
            var seed = Enumerable.Range(0, slots).Select(i => i.ToString("D4") + ".png").ToList();
            plan?.Bank(slots);

            // work dir: clone sidecars + overlay custom patches (normalise "PREFIX_0019.png" -> "0019.png")
            string work = Path.Combine(tmp, "work");
            Directory.CreateDirectory(work);
            foreach (var f in Directory.GetFiles(levelDir, "*.json").Concat(Directory.GetFiles(levelDir, "*.ssx")))
                File.Copy(f, Path.Combine(work, Path.GetFileName(f)), true);
            string cfg = Path.Combine(levelDir, "ConfigTricky.ssx");
            if (File.Exists(cfg)) File.Copy(cfg, Path.Combine(work, "trickyconfig.ssx"), true);
            // Collision/ is needed only when we regenerate the .ssf (authored gems): SSFGenerate reloads each
            // instance's collision model by path. Meshes/Textures/Skybox are always cloned for the pbd/skybox build.
            foreach (var d in new[] { "Meshes", "Textures", "Skybox", "Collision" })
                if (Directory.Exists(Path.Combine(levelDir, d))) CopyDir(Path.Combine(levelDir, d), Path.Combine(work, d));
            string patches = File.ReadAllText(Path.Combine(customDir, "Patches.json"));

            RepackConsole.Section("Textures");
            var propBake = CanonicalMapProps.Load(customDir);

            // Texture provenance (Slopesmith docs/037): a PORTABLE export ships every painted tile flattened
            // and verbatim - "GARI_0012.png" - and records the {level, name, staged} behind each one in
            // Slopesmith.json. That sidecar is what turns such a ref into a bank decision; SlopesmithExport
            // holds the table. A ref carrying its own bank ("DONOR/NNNN.png") is resolved by its shape below,
            // and an export shipping no manifest resolves every ref that way.
            var manifest = SlopesmithExport.Load(customDir);
            if (manifest != null) Log.Info($"  texture provenance: {SlopesmithExport.FileName} ({manifest.Count} source(s))");
            bool IsTargetPage(string name) => System.Text.RegularExpressions.Regex.IsMatch(name, @"^\d{4}\.png$")
                                           && int.TryParse(name.AsSpan(0, 4), out int page) && page < slots;

            // Foreign textures (Slopesmith docs/011 Phase 2/3): a TexturePath that isn't a bare slot of THIS level's ssh
            // needs its page installed in the bank. Unreferenced original slots are overwritten first; only
            // overflow grows the directory with SshBank.Append. Referenced native pages are never re-encoded.
            // Two kinds, both first-seen order:
            //   borrowed  "DONOR/NNNN.png"  (DONOR != this level, != custom) -> the donor's page pulled VERBATIM
            //                                from its own ssh in the same ISO (proven-displayable original bytes).
            //   custom    "custom/NAME.png"                                  -> <customDir>/Textures/NAME.png
            //                                encoded as the selected custom-page format: type-5 by default, or
            //                                retail-shaped type-2 indexed pages with --texture-type2.
            // A ref of neither shape goes to the manifest, which places it on the same two channels (or on the
            // target's own bank, which installs nothing); `portable` carries those decisions to the rewrite.
            var texRe = new System.Text.RegularExpressions.Regex("\"TexturePath\":\"([^\"]*)\"");
            var qualifiedRe = new System.Text.RegularExpressions.Regex("^([A-Za-z0-9_]+)/([^\"/]+\\.png)$");
            var foreignOrder = new List<(string kind, string key, string donor, string name, string file, string source)>();
            var foreignSeen = new HashSet<string>();
            var portable = new Dictionary<string, TexturePlan>(StringComparer.Ordinal);
            foreach (System.Text.RegularExpressions.Match m in texRe.Matches(patches))
            {
                var q = qualifiedRe.Match(m.Groups[1].Value);
                if (q.Success)
                {
                    string donor = q.Groups[1].Value, name = q.Groups[2].Value, key = $"{donor}/{name}";
                    if (string.Equals(donor, level, StringComparison.OrdinalIgnoreCase)) continue; // native (this level's own prefix)
                    if (!foreignSeen.Add(key)) continue;
                    foreignOrder.Add((string.Equals(donor, "custom", StringComparison.OrdinalIgnoreCase) ? "custom" : "borrowed",
                                      key, donor, name, name, m.Groups[1].Value));
                }
                else if (SlopesmithExport.TryResolve(manifest, customDir, m.Groups[1].Value, level, IsTargetPage, out var texPlan))
                {
                    if (portable.TryAdd(m.Groups[1].Value, texPlan) && texPlan.Origin == TextureOrigin.TargetPage
                        && !IsTargetPage(texPlan.Name))
                        Warn("manifest-page-not-in-bank",
                             $"{m.Groups[1].Value} is recorded as {level}/{texPlan.Name}, which is not a page of its {slots}-slot bank");
                    if (texPlan.Origin != TextureOrigin.TargetPage && foreignSeen.Add(texPlan.Key))
                        foreignOrder.Add((texPlan.Origin == TextureOrigin.DonorPage ? "borrowed" : "custom",
                                          texPlan.Key, texPlan.Donor, texPlan.Name, texPlan.File, m.Groups[1].Value));
                }
            }
            if (propBake != null)
                foreach (var tile in CanonicalMapProps.ForeignTileKeys(propBake, level))
                    if (foreignSeen.Add(tile.Key))
                        foreignOrder.Add((string.Equals(tile.Donor, "custom", StringComparison.OrdinalIgnoreCase) ? "custom" : "borrowed",
                                          tile.Key, tile.Donor, tile.Name, tile.Name, $"{tile.Key} (prop)"));
            // Override textures in the cloned level materials: an extraction can carry a loose-name
            // TexturePath (a re-skinned prop's PNG in the level's own Textures/, e.g. "tower_priv.png")
            // instead of a bare 4-digit slot. A full pbd regen would append the unknown NAME to its texture
            // list and stamp an index one past the shipped ssh (a dangling texture id) - encode the PNG as a
            // custom page instead and repoint the material after installation. Only a props build ships the
            // regenerated material table, so only it pays for the page.
            if (propBake != null)
            {
                var workMats = Newtonsoft.Json.Linq.JObject.Parse(File.ReadAllText(Path.Combine(work, "Materials.json")));
                foreach (var m in workMats["Materials"] as Newtonsoft.Json.Linq.JArray ?? new Newtonsoft.Json.Linq.JArray())
                {
                    string t = (string?)m["TexturePath"] ?? "";
                    if (t.Length == 0 || System.Text.RegularExpressions.Regex.IsMatch(t, @"^\d{4}\.png$")) continue;
                    string key = $"level/{t}";
                    if (foreignSeen.Add(key)) foreignOrder.Add(("override", key, "level", t, t, $"{level} material {t}"));
                }
            }
            bool needGrey = propBake?.AnyUntextured == true;       // one flat page for untextured prop submeshes
            var foreignSlot = new Dictionary<string, string>();    // "DONOR/NAME.png" -> installed bare slot "0085.png"
            if (foreignOrder.Count > 0 || needGrey)
            {
                byte[] targetSsh = File.ReadAllBytes(Path.Combine(tmp, "dec", "data", "models", $"{lower}.ssh"));
                var donorCache = new Dictionary<string, SshBank>(StringComparer.OrdinalIgnoreCase);
                var blobs = new List<byte[]>();
                var used = new List<string>();
                var installed = new List<(string kind, string source)>();   // parallel to blobs/used, for the plan
                int nBorrow = 0, nCustom = 0;

                // An encoded page is built from an arbitrary PNG, so its shipped size is this build's
                // decision and not the author's: every edge snaps onto the GS ladder, under the largest
                // ceiling whose aggregate fits the bank's proven-clean budget in the selected format
                // (GsTextureLadder). The whole set decides it, so it is sized before the first encode - and
                // a borrowed page takes no part, being retail bytes spliced in as they are.
                string StagedPng(string kind, string file) =>
                    Path.Combine(kind == "custom" ? customDir : work, "Textures", file);
                var sources = foreignOrder.Where(f => f.kind != "borrowed").Select(f => StagedPng(f.kind, f.file))
                    .Where(File.Exists).Select(TryPngSize).Where(size => size.Width > 0).ToList();
                if (needGrey) sources.Add((16, 16));   // the flat grey page written below
                int ceiling = GsTextureLadder.Ceiling(sources, textureType2 ? 1 : 4, RepackPlan.VramBudgetBytes);
                var conformed = new List<string>();
                if (sources.Count > 0)
                {
                    long aggregate = GsTextureLadder.Bytes(sources, ceiling, textureType2 ? 1 : 4);
                    Log.Info($"  custom page ceiling: {ceiling} px — {(aggregate + 1023) / 1024:n0} KB of the "
                        + $"{RepackPlan.VramBudgetBytes / 1024:n0} KB proven-clean budget "
                        + (aggregate > RepackPlan.VramBudgetBytes
                            ? $"(no rung down to {GsTextureLadder.NativeEdge} px fits it, so nothing is shrunk for a budget it cannot reach)"
                            : ceiling < GsTextureLadder.MaxEdge ? "(the largest ladder rung that fits)"
                            : "(the set fits at its staged size)"));
                    if (aggregate > RepackPlan.VramBudgetBytes)
                    {
                        long over = aggregate - RepackPlan.VramBudgetBytes;
                        string remedy;
                        if (!textureType2)
                        {
                            int type2Ceiling = GsTextureLadder.Ceiling(sources, 1, RepackPlan.VramBudgetBytes);
                            long type2Aggregate = GsTextureLadder.Bytes(sources, type2Ceiling, 1);
                            remedy = type2Aggregate <= RepackPlan.VramBudgetBytes
                                ? $"Repack with --texture-type2; this set then fits at {(type2Aggregate + 1023) / 1024:n0} KB."
                                : "Repack with --texture-type2 to reduce it, then remove or shrink custom textures until the alert clears.";
                        }
                        else
                            remedy = "Remove or shrink custom textures until the alert clears.";
                        RepackConsole.Alert($"Custom textures use {(aggregate + 1023) / 1024:n0} KB of GS texture memory "
                            + $"({(over + 1023) / 1024:n0} KB over the {RepackPlan.VramBudgetBytes / 1024:n0} KB "
                            + $"proven-clean limit); the PS2 build may corrupt textures or freeze. {remedy}");
                    }
                    plan?.TextureCeiling(ceiling);
                }

                foreach (var f in foreignOrder)
                {
                    byte[]? blob = null;
                    if (f.kind == "custom" || f.kind == "override")
                    {
                        // custom pages ship in the export's Textures/, under the name the export staged them
                        // as; override pages are the level extraction's own loose PNGs, already cloned into
                        // the work dir's Textures/.
                        string png = StagedPng(f.kind, f.file);
                        if (!File.Exists(png)) { Warn("missing-staged-png", $"{f.kind} texture {f.file} not in {Path.GetDirectoryName(png)} — {f.key} left unresolved"); continue; }
                        try { blob = _ssh.EncodeCustomPage(png, textureType2, ceiling); nCustom++; }
                        catch (Exception e) { Warn("encode-failed", $"encode {f.file} failed ({e.Message}) — {f.key} left unresolved"); continue; }
                        var source = TryPngSize(png);
                        var ships = GsTextureLadder.Fit(source, ceiling);
                        if (source.Width > 0 && ships != source)
                            conformed.Add($"{f.file} {source.Width}x{source.Height} -> {ships.Width}x{ships.Height}");
                    }
                    else
                    {
                        if (!donorCache.TryGetValue(f.donor, out var donor))
                        {
                            var sshBytes = PullDonorSsh(iso, f.donor, tmp);
                            if (sshBytes == null) { Warn("donor-missing", $"donor {f.donor} not in ISO — {f.key} left unresolved"); continue; }
                            donorCache[f.donor] = donor = SshBank.Load(sshBytes);
                        }
                        int idx = donor.IndexOfName(Path.GetFileNameWithoutExtension(f.name));
                        if (idx < 0) { Warn("donor-page-missing", $"{f.donor} has no page {f.name} — {f.key} left unresolved"); continue; }
                        blob = donor.PageBytes(idx); nBorrow++;
                    }
                    blobs.Add(blob); used.Add(f.key); installed.Add((f.kind, f.source));
                }
                if (needGrey)
                {
                    string greyPng = Path.Combine(tmp, "untextured.png");
                    using (var img = new SixLabors.ImageSharp.Image<SixLabors.ImageSharp.PixelFormats.Rgba32>(
                               16, 16, new SixLabors.ImageSharp.PixelFormats.Rgba32(153, 153, 153, 255)))
                        SixLabors.ImageSharp.ImageExtensions.SaveAsPng(img, greyPng);
                    blobs.Add(_ssh.EncodeCustomPage(greyPng, textureType2, ceiling)); used.Add(CanonicalMapProps.UntexturedKey);
                    installed.Add(("custom", "generated grey (untextured props)")); nCustom++;
                }
                if (conformed.Count > 0)
                    Warn("texture-conform", $"{conformed.Count} encoded page(s) ship resampled onto the GS ladder"
                        + (ceiling < GsTextureLadder.MaxEdge
                            ? $" at the {ceiling}-pixel ceiling the {RepackPlan.VramBudgetBytes / 1024:n0} KB budget leaves" : "")
                        + $": {string.Join(", ", conformed.Take(3))}"
                        + (conformed.Count > 3 ? $", +{conformed.Count - 3} more" : ""));
                if (blobs.Count > 0)
                {
                    var protectedSlots = ReferencedOriginalTextureSlots(
                        patches, Path.Combine(work, "Materials.json"), propBake, level, slots,
                        portable.Values.Where(p => p.Origin == TextureOrigin.TargetPage).Select(p => p.Name));
                    var reusableSlots = Enumerable.Range(0, slots).Where(i => !protectedSlots.Contains(i)).ToList();
                    int reused = Math.Min(reusableSlots.Count, blobs.Count);
                    var assignedSlots = new List<string>(blobs.Count);
                    var replacements = new Dictionary<int, byte[]>(reused);
                    for (int i = 0; i < reused; i++)
                    {
                        int slot = reusableSlots[i];
                        replacements[slot] = blobs[i];
                        assignedSlots.Add(slot.ToString("D4"));
                    }

                    byte[] newSsh = SshBank.ReplacePages(targetSsh, replacements);
                    int appended = blobs.Count - reused;
                    if (appended > 0)
                    {
                        var (grown, appendedSlots) = SshBank.Append(newSsh, blobs.Skip(reused).ToList());
                        newSsh = grown;
                        assignedSlots.AddRange(appendedSlots);
                    }

                    for (int i = 0; i < used.Count; i++) foreignSlot[used[i]] = assignedSlots[i] + ".png";
                    plan?.Allocation(targetSsh, newSsh, protectedSlots, reusableSlots,
                        used.Select((key, i) => new RepackPlan.Install(installed[i].kind, key, installed[i].source, blobs[i])).ToList(),
                        assignedSlots, reused);
                    if (plan == null)
                        File.WriteAllBytes(Path.Combine(rawDir, "data", "models", $"{lower}.ssh"), _refpack.Compress(newSsh));
                    slots += appended;
                    seed = Enumerable.Range(0, slots).Select(i => i.ToString("D4") + ".png").ToList();
                    Log.Info($"  textures installed: {nBorrow} borrowed + {nCustom} custom"
                        + (nCustom > 0 ? $" ({(textureType2 ? "type-2" : "type-5")})" : "")
                        + $" -> {reused} reused original slot(s) + {appended} appended ({slots} total)");
                    if (reused > 0)
                        Log.Info($"    reused slots: {DescribeSlots(assignedSlots.Take(reused))}");
                    if (appended > 0)
                        Log.Info($"    appended slots: {DescribeSlots(assignedSlots.Skip(reused))}");
                }
            }

            // Overlay the custom patches, rewriting each TexturePath: a resolved foreign tile -> its installed
            // slot; a manifest-resolved ref -> the target page it names, or the slot its install received; a
            // native ref -> the bare 4-digit slot ("PREFIX_0019.png" / "LEVEL/0019.png" -> "0019.png"); an
            // unresolved foreign ref -> slot 0000 (a safe existing slot, warned above).
            RepackConsole.Section("Course data");
            patches = System.Text.RegularExpressions.Regex.Replace(patches, "\"TexturePath\":\"([^\"]*)\"", m =>
            {
                string t = m.Groups[1].Value;
                if (foreignSlot.TryGetValue(t, out var slot)) return $"\"TexturePath\":\"{slot}\"";
                if (portable.TryGetValue(t, out var texPlan))
                    return texPlan.Origin == TextureOrigin.TargetPage ? $"\"TexturePath\":\"{texPlan.Name}\""
                         : foreignSlot.TryGetValue(texPlan.Key, out var page) ? $"\"TexturePath\":\"{page}\""
                         : "\"TexturePath\":\"0000.png\"";
                var nm = System.Text.RegularExpressions.Regex.Match(t, "(\\d{4}\\.png)$");
                if (nm.Success) return $"\"TexturePath\":\"{nm.Groups[1].Value}\"";        // native / stripped prefix
                if (t.Contains('/')) return "\"TexturePath\":\"0000.png\"";                // unresolved foreign -> safe slot 0
                // An unqualified ref that named no manifest source, no target page and no staged PNG survives
                // the rewrite as-is, so the pbd build stamps a texture index one past the shipped bank.
                plan?.Note("unresolved-terrain-ref",
                           $"terrain ref '{t}' resolves to no page of the shipped bank and is left as written");
                return m.Value;
            });
            File.WriteAllText(Path.Combine(work, "Patches.json"), patches);

            // Repoint the cloned materials' loose-name TexturePaths to their installed override pages. An
            // unresolved name falls to slot 0000 with a warning - either way the pbd build only ever sees
            // bare slots of the shipped ssh, so it can never invent a texture index past the bank.
            if (propBake != null)
            {
                string matsText = File.ReadAllText(Path.Combine(work, "Materials.json"));
                matsText = System.Text.RegularExpressions.Regex.Replace(matsText, "\"TexturePath\":\\s*\"([^\"]+)\"", m =>
                {
                    string t = m.Groups[1].Value;
                    if (System.Text.RegularExpressions.Regex.IsMatch(t, @"^\d{4}\.png$")) return m.Value;
                    if (foreignSlot.TryGetValue($"level/{t}", out var slot)) return $"\"TexturePath\":\"{slot}\"";
                    Warn("override-unresolved", $"level material texture '{t}' unresolved - repointed to slot 0000");
                    return "\"TexturePath\":\"0000.png\"";
                });
                File.WriteAllText(Path.Combine(work, "Materials.json"), matsText);
            }

            // Engine lights: if the custom mountain authored its own Lights.json, overlay it over the cloned
            // original one. The pbd build reads work/Lights.json into the PBD light chunk, and the LTG grid
            // regen below bakes those PBD lights - so the dynamic/engine lighting becomes the authored
            // sun+ambient instead of the original's. Absent -> keep the original's cloned Lights.json (no behaviour change).
            string customLights = Path.Combine(customDir, "Lights.json");
            bool haveAuthoredLights = File.Exists(customLights);
            if (haveAuthoredLights)
            {
                Log.Info("  overlaying authored Lights.json");
                File.Copy(customLights, Path.Combine(work, "Lights.json"), true);
            }

            // Authored particle volumes (fog banks): overlay the custom ParticleInstances/ParticleModels.json
            // so the regenerated pbd carries the export's clusters instead of the donor slot's.
            //
            // Without this the work folder keeps the CLONED ORIGINAL tables, and a pack silently ships the
            // donor's fog at the donor's coordinates - which on authored terrain is nowhere the rider will
            // ever look. It reads as "authored fog does not render", and it is not: the PBD is well-formed
            // and full of somebody else's banks. The tell is the packed PBD's NumParticleInstances matching the
            // donor's count rather than the export's.
            //
            // The two files move together on purpose. An instance addresses its cluster by
            // ParticleModelIndex, so overlaying the instances alone would point the export's placements into
            // the donor's model table and draw whatever happened to sit at that index.
            string customParticles = Path.Combine(customDir, "ParticleInstances.json");
            string customParticleModels = Path.Combine(customDir, "ParticleModels.json");
            if (File.Exists(customParticles) && File.Exists(customParticleModels))
            {
                Log.Info("  overlaying authored ParticleInstances.json + ParticleModels.json");
                File.Copy(customParticles, Path.Combine(work, "ParticleInstances.json"), true);
                File.Copy(customParticleModels, Path.Combine(work, "ParticleModels.json"), true);
            }
            else if (File.Exists(customParticles) || File.Exists(customParticleModels))
            {
                // Half a pair cannot be applied without mismatching indices, and quietly keeping the donor's
                // fog is exactly the failure this block exists to end - so say so.
                Log.Warn("  WARNING: the export has only one of ParticleInstances/ParticleModels.json; "
                    + "keeping the donor's fog banks rather than shipping a mismatched pair");
            }

            // Authored course splines: overlay the custom Splines.json so the regenerated pbd carries both
            // grind rails and Effects-owned motion routes. The surgical swap below lifts those sections into
            // the hybrid, while .ltg regen lists their segments in the world grid. Their native U0/U1/style row
            // is rebuilt into .ssf whenever authored instances cause SSFGenerate to run.
            string customSplines = Path.Combine(customDir, "Splines.json");
            bool haveAuthoredSplines = File.Exists(customSplines);
            if (haveAuthoredSplines)
            {
                Log.Info("  overlaying authored Splines.json");
                // Normalize legacy 0/0 exports to the proven grind row. Explicit negative values are preserved:
                // retail train/gondola animation routes use (-1, -2, style -1), distinct from grind's (1, 1).
                var splRoot = JObject.Parse(File.ReadAllText(customSplines));
                if (splRoot["Splines"] is JArray spl)
                    foreach (var s in spl.OfType<JObject>())
                    {
                        if (((int?)s["U0"] ?? 0) == 0) s["U0"] = 1;
                        if (((int?)s["U1"] ?? 0) == 0) s["U1"] = 1;
                    }
                File.WriteAllText(Path.Combine(work, "Splines.json"), splRoot.ToString(Newtonsoft.Json.Formatting.None));
            }

            // Authored course paths: race/freeride load .aip; Show Off loads .sop. Both runtime datasets
            // have a fixed six-pointer StartPosList field, so normalize every input to six valid paths before
            // building. Missing PathEvents are also filled because the library writer indexes them unconditionally.
            string customAip = Path.Combine(customDir, "AIP.json");
            bool haveAuthoredPaths = File.Exists(customAip);
            if (haveAuthoredPaths)
            {
                var aipRoot = JObject.Parse(File.ReadAllText(customAip));
                bool aipNormalized = EnsureSixStartPaths(aipRoot);
                if (aipNormalized)
                    Log.Info("  AIP start field normalized to six valid race slots");
                FillPathEvents(aipRoot);
                File.WriteAllText(Path.Combine(work, "AIP.json"), aipRoot.ToString(Newtonsoft.Json.Formatting.None));
                plan?.StartSlots("AIP", "AIP.json", aipRoot, aipNormalized, anchor: true);   // the anchor relocation reads this one
                string customSop = Path.Combine(customDir, "SOP.json");
                JObject sopRoot;
                string sopSource;
                if (File.Exists(customSop))
                {
                    sopRoot = JObject.Parse(File.ReadAllText(customSop));
                    sopSource = "SOP.json";
                    Log.Info("  overlaying authored AIP.json (Race) + SOP.json (Show Off)");
                }
                else
                {
                    sopRoot = (JObject)aipRoot.DeepClone();
                    sopSource = "AIP.json (cloned)";
                    Log.Info("  overlaying authored AIP.json (no SOP.json — using the same six-slot dataset for Show Off)");
                }
                bool sopNormalized = EnsureSixStartPaths(sopRoot);
                if (sopNormalized)
                    Log.Info("  SOP start field normalized to six valid Show Off slots");
                FillPathEvents(sopRoot);
                File.WriteAllText(Path.Combine(work, "SOP.json"), sopRoot.ToString(Newtonsoft.Json.Formatting.None));
                plan?.StartSlots("SOP", sopSource, sopRoot, sopNormalized);
                plan?.Paths($"regenerated from the export's AIP.json + {sopSource}; the retail StageArea anchor is relocated");
            }
            else plan?.Paths($"the export ships no AIP.json — {level}'s own .aip/.sop and StageArea transform stay verbatim");

            // The dry run stops here: everything past this point builds bytes (pbd, world grid, BIG, ISO) and
            // reports no number the plan carries. The sky decision is the last one that does, so it runs -
            // without its writes - and the plan is rendered.
            if (plan != null)
            {
                plan.Footprint(Path.Combine(levelDir, "Patches.json"), Path.Combine(customDir, "Patches.json"));
                InjectSkybox(iso, lower, customDir, tmp, rawDir, plan);
                plan.Finish();
                if (collected != null) collected.Add(plan); else plan.WriteTo(Log.Out);
                return 0;
            }

            RepackConsole.Section("Build level");

            // Authored effects (Slopesmith docs/026 attachments): merge the export Effects.json's ATTACHED slots/graphs
            // into the work dir's SSFLogic.json (compiled into the .ssf by the SSFGenerate build below) and
            // get back per-group instance wiring for the prop append to stamp (EffectSlotIndex, UVScroll,
            // touchability). A map with no attached baked groups has nothing to merge.
            var fxHops = new List<AuthoredEffects.Hop>();
            var fxWiring = propBake == null ? null
                : AuthoredEffects.Compile(customDir, work, out fxHops, selectedPatches.HudText);
            // Placed props: append the canonical source models/instances/meshes into the donor tables. Effect
            // indices and texture slots are the only donor-relative fields and are remapped here.
            // Runs BEFORE the gem append so authored gems stay the trailing instance range the gem LTG-state
            // override below assumes. Growing the models/materials/mesh sections means the regenerated pbd
            // ships wholesale (no surgical swap) when props are present.
            // Counted BEFORE the append so "the donor's props" means exactly the rows that were already there.
            int donorInstances = CountInstances(work);
            int customProps = propBake == null ? 0
                : CanonicalMapProps.Append(work, customDir, propBake, level, foreignSlot, fxWiring);
            bool haveCustomProps = customProps > 0;
            // The rows a MainType-7 node acts on exist only now, and SSFGenerate reads SSFLogic.json below —
            // this is the one window where the packed instance index is both known and still writable.
            if (haveCustomProps) AuthoredEffects.ResolveHops(work, fxHops);
            // --bare-slot: an authored course replaces the donor's TERRAIN but inherits its whole prop
            // population, which sits at the donor's coordinates - kilometres from a Slopesmith mountain. The
            // console never draws them because the world grid only streams cells near the course, but every
            // consumer without that streaming (the Unity bundle) instantiates all of them. Hiding is deliberate
            // rather than deleting: instance INDICES are referenced by the per-instance ObjectProperties list,
            // the name-hash table, the .ltg grid lists, effect slots and the spline/path tables, so removing a
            // row would renumber all of it. The StageArea markers are exempt - the engine resolves the rider's
            // start and finish placement through their name hashes [Trailmap: 120-objects].
            if (bareSlot)
            {
                int hidden = HideDonorInstances(work, donorInstances);
                Log.Info($"  bare slot: hid {hidden} of {donorInstances} donor instance(s) "
                    + "(kept the StageArea start/finish markers).");
            }
            if (haveCustomProps)
                Log.Info($"  placed props: {customProps} canonical model(s)+instance(s) appended.");
            // The prop-hit sound path gates on the level's .adl (instance hash -> sound row), NOT the pbd
            // instance fields [Trailmap: 420-audio-runtime] - so authored hit sounds also need the ADL
            // regenerated from the work Instances.json (retail rows round-trip; the appended instances'
            // stamped Sounds join them). Only then does the engine look the new instances' sounds up.
            bool haveAuthoredSounds = false;
            if (haveCustomProps
                && JObject.Parse(File.ReadAllText(Path.Combine(work, "Instances.json")))["Instances"] is JArray soundInstances)
                haveAuthoredSounds = soundInstances.Skip(donorInstances).OfType<JObject>().Any(instance =>
                    ((int?)(instance["Sounds"] as JObject)?["CollisonSound"] ?? 0) > 0
                    || (instance["Sounds"] as JObject)?["ExternalSounds"] is JArray { Count: > 0 });

            // Custom-sound routing has to happen HERE, in the window between the props being appended and the
            // ADL being regenerated from them below: it rewrites which event each authored custom clip rides,
            // and the ADL is the only place those ids reach the engine. The choice needs the target bank,
            // which is why it cannot live in the export, and the bank injection at the end of the pipeline
            // needs the same answer, which is why the map is carried forward rather than recomputed.
            var soundEventRemap = haveAuthoredSounds && !args.Contains("--no-sound-routing")
                ? CustomSoundRouting.Apply(_iso, outIso, level, customDir, work, tmp, donorInstances, soundRate)
                : new Dictionary<int, int>();

            // Type-1/2 ExternalSound records are 0x30 bytes and carry U7..U11, which the fixed intermediate row
            // may omit. Before sound regeneration, recover those tails from the freshly extracted retail ADL by
            // instance hash so a Slopesmith sound cannot truncate an unrelated floodlight/train volume.
            if (haveAuthoredSounds)
            {
                int restored = RestoreExternalSoundTails(
                    Path.Combine(work, "Instances.json"),
                    Path.Combine(tmp, "dec", "data", "models", $"{lower}.adl"));
                if (restored > 0) Log.Info($"  restored {restored} retail type-1/2 ExternalSound tail(s) from the source ADL.");
            }

            // Authored gem pickups: synthesise a gem INSTANCE per Gems.json entry (cloning a tier-matched shipped
            // gem for its model + MainType-14 effect slot + LTGState 2), appended to the working Instances.json.
            // Growing the instance section forces the .ssf's per-instance ObjectProperties/InstanceState to grow
            // with it (the engine reads state per instance), so gems trigger a full .ssf regen below — which also
            // rebuilds the spline-style table from Splines.json (spec 220), preserving grind and motion rows.
            // The .ltg regen lists the gems in its GemIndex off LTGState 2 (Slopesmith docs/014).
            int authoredGems = AppendAuthoredGems(work, customDir);
            bool haveAuthoredGems = authoredGems > 0;

            // Static terrain lightmaps: if the custom mountain authored Lightmaps/ pages (Slopesmith writes
            // original-brightness 000N.png when the sun is on; the patches' LightMapPoint/LightmapID in Patches.json
            // index these pages in file order), overlay them into the work dir and regenerate _L.ssh from them
            // (LSSHGenerate below: G278 FullColor + per-page DarkenImage). Absent -> leave LSSHGenerate off and
            // keep the original's _L.ssh verbatim.
            string customLightmaps = Path.Combine(customDir, "Lightmaps");
            bool haveLightmaps = Directory.Exists(customLightmaps)
                                 && Directory.GetFiles(customLightmaps, "*.png").Length > 0;
            if (haveLightmaps)
            {
                Log.Info("  regenerating terrain lightmaps (_L.ssh)");
                string workLightmaps = Path.Combine(work, "Lightmaps");
                if (Directory.Exists(workLightmaps)) Directory.Delete(workLightmaps, true);
                CopyDir(customLightmaps, workLightmaps);
            }

            RepackConsole.Detail($"Building PBD ({slots} texture slots, verbatim SSH)");
            string pbd = Path.Combine(tmp, $"{lower}.pbd");
            using (RepackConsole.SuppressPackingTrace())
            {
                new TrickyLevelInterface
                {
                    PBDGenerate = true, SSHGenerate = false, LSSHGenerate = haveLightmaps, LTGGenerate = false,
                    MAPGenerate = haveAuthoredGems || haveCustomProps,     // instance/model/material counts changed
                    SkyPBDGenerate = false, SkySSHGenerate = false,
                    ADLGenerate = haveAuthoredSounds,                        // authored hit/ambient sounds -> instance rows rebuilt
                    SSFGenerate = haveAuthoredGems || haveCustomProps,     // per-instance state + collision models grew
                    AIPGenerate = haveAuthoredPaths, SOPGenerate = haveAuthoredPaths, SeedImageFiles = seed,
                }.BuildTrickyLevelFiles(work, pbd);
            }

            // Surgical terrain swap: the full regenerate re-encodes the original's props through OBJ, losing their
            // triangle strips (+~14% mesh geometry) - harmless in draw count but it fragments the alpha-blended
            // props into more primitives, which the accurate GS blend (PCSX2 GS Blending = Full) pays for per
            // barrier (~30fps vs the original's 50). So keep the ORIGINAL pbd verbatim - its strip-optimised
            // prop meshes, materials, instances - and swap in only the freshly-built terrain patches, plus the
            // light section when the export authored its own Lights.json (so the authored sun+ambient light the
            // rider; the LTG regen below reads this hybrid, keeping its crossing lists consistent either way).
            // (Slopesmith docs/011.)
            // Placed props grow the model/material/mesh-data sections, which the surgical swap keeps verbatim
            // by design - so a props build ships the full regenerated pbd instead. A regenerated pbd is
            // perf-innocent under Full GS blending; what it does cost is the original props' triangle strips,
            // lost to the OBJ round-trip - the accepted price of carrying new models.
            byte[] hybridPbd;
            if (haveCustomProps)
            {
                hybridPbd = File.ReadAllBytes(pbd);
                Log.Info($"  full pbd regen (placed props): {BitConverter.ToInt32(hybridPbd, 8)} terrain patches"
                    + $" + {customProps} prop model(s)/instance(s)"
                    + (haveAuthoredLights ? $" + {BitConverter.ToInt32(hybridPbd, 28)} authored light(s)" : "")
                    + (haveAuthoredSplines ? $" + {BitConverter.ToInt32(hybridPbd, 0x20)} course spline(s)/{BitConverter.ToInt32(hybridPbd, 0x24)} segment(s)" : "")
                    + (haveAuthoredGems ? $" + {authoredGems} gem instance(s)" : "")
                    + $" ({BitConverter.ToInt32(hybridPbd, 0x0C)} instances total)");
            }
            else
            {
                hybridPbd = SurgicalPatchSwap(
                    File.ReadAllBytes(Path.Combine(tmp, "dec", "data", "models", $"{lower}.pbd")), // original, decompressed
                    File.ReadAllBytes(pbd),                                                         // freshly regenerated
                    swapLights: haveAuthoredLights, swapSplines: haveAuthoredSplines, swapInstances: haveAuthoredGems);
                Log.Info($"  surgical swap: kept original props/meshes verbatim, swapped {BitConverter.ToInt32(hybridPbd, 8)} terrain patches"
                    + (haveAuthoredLights ? $" + {BitConverter.ToInt32(hybridPbd, 28)} authored light(s)" : "")
                    + (haveAuthoredSplines ? $" + {BitConverter.ToInt32(hybridPbd, 0x20)} course spline(s)/{BitConverter.ToInt32(hybridPbd, 0x24)} segment(s)" : "")
                    + (haveAuthoredGems ? $" + {authoredGems} gem instance(s) ({BitConverter.ToInt32(hybridPbd, 0x0C)} total)" : ""));
            }

            // The six rider staging records are fixed formation offsets local to Mdl_StageArea_Start_0;
            // SOP StartPosList does not replace them. Move that retained retail anchor onto the authored
            // race-line origin and rotate its -X forward axis down the authored course. Keep the instance,
            // hash and index intact so the stock placement path continues to build the rider formation.
            if (haveAuthoredPaths)
                RelocateStageAreaStartAnchor(hybridPbd, Path.Combine(work, "AIP.json"));

            File.WriteAllBytes(pbd, hybridPbd); // so the .ltg regen (LoadPBD) and the compress below both use it

            File.WriteAllBytes(Path.Combine(rawDir, "data", "models", $"{lower}.pbd"), _refpack.Compress(File.ReadAllBytes(pbd)));

            // The regenerated collision-sound sidecar (BuildTrickyLevelFiles wrote it to "<base>.adl", base =
            // pbd minus its extension) swaps in like the pbd; without authored sounds the verbatim original
            // .adl stays as raw-extracted into rawDir.
            if (haveAuthoredSounds)
            {
                string adl = Path.Combine(tmp, $"{lower}.adl");
                if (File.Exists(adl))
                {
                    File.WriteAllBytes(Path.Combine(rawDir, "data", "models", $"{lower}.adl"), _refpack.Compress(File.ReadAllBytes(adl)));
                    Log.Info($"  regenerated {lower}.adl (collision-sound rows incl. the authored props).");
                }
                else Log.Warn($"  WARN: expected regenerated {lower}.adl not found — authored hit sounds stay silent in-game.");
            }

            // If we regenerated the terrain lightmaps, RefPack the rebuilt _L.ssh and swap it into the raw
            // members next to the pbd (BuildTrickyLevelFiles wrote it to "<base>_L.ssh", base = pbd minus its
            // 4-char extension). Otherwise the verbatim original _L.ssh stays as extracted into rawDir.
            if (haveLightmaps)
            {
                string lssh = Path.Combine(tmp, $"{lower}_L.ssh");
                // Retail truncates the lightmap member's STEM to six characters — merque_L.ssh, elysiu_L.ssh,
                // untrac_L.ssh, megapl_L.ssh (verified across every shipped level BIG) — and the engine builds
                // the same name. Write over the ORIGINAL member: a full-stem "<level>_L.ssh" on a 7-letter
                // level packs as a second, dead member and silently leaves the original lightmap live.
                string memberDir = Path.Combine(rawDir, "data", "models");
                string member = Path.Combine(memberDir, (lower.Length > 6 ? lower[..6] : lower) + "_L.ssh");
                if (!File.Exists(member))
                    member = Directory.GetFiles(memberDir, "*_L.ssh").FirstOrDefault() ?? member;
                File.WriteAllBytes(member, _refpack.Compress(File.ReadAllBytes(lssh)));
            }

            // Authored gems or placed props regenerated the .ssf (ObjectProperties/InstanceState grown for the
            // appended instances, prop collision models loaded, spline styles rebuilt from Splines.json) AND
            // the .map (its name/hash table is index-aligned with the pbd instances/models/materials, spec 220):
            // RefPack both into the members next to the pbd. Otherwise the verbatim original .ssf/.map stay.
            if (haveAuthoredGems || haveCustomProps)
            {
                string ssf = Path.Combine(tmp, $"{lower}.ssf");
                // The regenerated .ssf keeps the target's effect graphs but rebuilds its spline table from
                // the custom mountain's own Splines.json, so the donor's spline-riding nodes (tram/gondola
                // animations) point past the table — the engine indexing 20× past a 3-entry table is a
                // load-time crash. Drop those nodes, then refuse to pack anything ssf-check would fail:
                // shipping a file this tool's own validator rejects is how a build crashes PCSX2 at load.
                var fx = new SSFHandler();
                fx.Load(ssf);
                int dangling = SsfResearchService.DropDanglingSplineNodes(fx);
                if (dangling > 0)
                {
                    fx.Save(ssf);
                    fx = new SSFHandler();
                    fx.Load(ssf);   // validate what actually ships, not the in-memory model
                    Log.Warn($"  effects: dropped {dangling} spline-riding node(s) whose spline didn't survive the terrain swap (the target's tram/gondola rides can't run on a custom mountain).");
                }
                var ssfErrors = SsfResearchService.ValidationErrors(fx);
                if (ssfErrors.Count > 0)
                    throw new InvalidDataException(
                        $"repack produced an invalid {lower}.ssf ({ssfErrors.Count} error(s); first: {ssfErrors[0]}) — refusing to pack it.");
                File.WriteAllBytes(Path.Combine(rawDir, "data", "models", $"{lower}.ssf"), _refpack.Compress(File.ReadAllBytes(ssf)));
                string map = Path.Combine(tmp, $"{lower}.map");
                File.WriteAllBytes(Path.Combine(rawDir, "data", "models", $"{lower}.map"), _refpack.Compress(File.ReadAllBytes(map)));
            }

            // The authored course regenerated the path members: .aip (respawn paths + race line) and .sop
            // (the start gates the engine spawns from). RefPack both in next to the pbd; without authored
            // paths the verbatim originals stay (and so does the original level's spawn).
            if (haveAuthoredPaths)
            {
                foreach (var ext in new[] { ".aip", ".sop" })
                    File.WriteAllBytes(Path.Combine(rawDir, "data", "models", lower + ext),
                        _refpack.Compress(File.ReadAllBytes(Path.Combine(tmp, lower + ext))));
            }

            // Regenerate the world (spatial/collision) grid (.ltg) from the freshly built pbd. Terrain still
            // RENDERS from the patch array, but terrain COLLISION reaches patches only through this grid, so a
            // grid built for the old patches would leave the rider falling through the new terrain. Use the
            // decompressed original .ltg (in <tmp>/dec) as the structural template, rebuild against the new
            // patches (SSX-Library LTGHandler.RegenerateCentreLTG = the compact, no-crash rebuilder that lists
            // each patch/light in every cell it overlaps), RefPack it and drop it next to the pbd before
            // re-containering. The on-disc name stays .ltg.
            Log.Info("  regenerating world grid (.ltg) ...");
            string refLtg = Path.Combine(tmp, "dec", "data", "models", $"{lower}.ltg");
            string newLtg = Path.Combine(tmp, $"{lower}.ltg");
            var wgPbd = new SSX_Library.FileHandlers.LevelFiles.Tricky.PS2.PBDHandler();
            wgPbd.LoadPBD(pbd);
            var wgLtg = new SSX_Library.FileHandlers.LevelFiles.Tricky.LTGHandler();
            wgLtg.LoadLTG(refLtg);
            // Mirror the reference tool for ORIGINAL rows only: stamp each list-state (instance/race/gem)
            // from the template grid before the rebuild distributes instances into the new cells. Appended
            // canonical props already carry their authored semantic layer in LTGState; asking the donor grid
            // about those new indexes returns -1 and would erase a Showoff-only/state-2 choice.
            int appendedStart = wgPbd.Instances.Count - authoredGems - customProps;
            for (int i = 0; i < appendedStart; i++)
            {
                var inst = wgPbd.Instances[i];
                inst.LTGState = wgLtg.FindIfInstaneState(i);
                wgPbd.Instances[i] = inst;
            }
            // A props build replaces the level's scenery outright: delist every ORIGINAL static prop
            // (template state 0 -> -1 = listed in no grid cell; the render gather and the collision
            // broad-phase reach instances only through the grid, so a delisted prop neither draws nor
            // collides). Delisting instead of deleting keeps every instance index stable - Prev/Next
            // chains, the template-grid stamping above and the ssf/map alignment all key on the index.
            // Race-line markers (state 1) and the original gem pickups (state 2) stay listed.
            if (haveCustomProps)
            {
                int delisted = 0;
                for (int i = 0; i < wgPbd.Instances.Count - authoredGems - customProps; i++)
                {
                    var inst = wgPbd.Instances[i];
                    if (inst.LTGState != 0) continue;
                    inst.LTGState = -1;
                    wgPbd.Instances[i] = inst;
                    delisted++;
                }
                Log.Info($"  original scenery delisted from the world grid: {delisted} prop instance(s) (race markers + original gems stay).");
            }
            // Appended instances aren't in the template grid. Normalize placed props to the two authored
            // semantic layers: ordinary state 0 (the common InstanceIndex) or validated Showoff-only state 2
            // (GemIndex). Authored gems remain state 2. The order is [original..., props..., gems...].
            for (int i = wgPbd.Instances.Count - authoredGems - customProps; i >= 0 && i < wgPbd.Instances.Count - authoredGems; i++)
            {
                var inst = wgPbd.Instances[i];
                inst.LTGState = NormalizeAuthoredPropLtgState(inst.LTGState);
                wgPbd.Instances[i] = inst;
            }
            for (int i = wgPbd.Instances.Count - authoredGems; i >= 0 && i < wgPbd.Instances.Count; i++)
            {
                var inst = wgPbd.Instances[i];
                inst.LTGState = 2;
                wgPbd.Instances[i] = inst;
            }
            wgLtg.RegenerateCentreLTG(wgPbd);
            wgLtg.SaveLTGFile(newLtg);
            File.WriteAllBytes(Path.Combine(rawDir, "data", "models", $"{lower}.ltg"), _refpack.Compress(File.ReadAllBytes(newLtg)));

            // Authored skybox (Slopesmith docs/025): swap the level's backdrop for the one the export shipped in Skybox/.
            InjectSkybox(iso, lower, customDir, tmp, rawDir);

            string newBig = Path.Combine(tmp, $"{lower}.new.big");
            BIG.Create(BigType.C0FB, rawDir, newBig, useCompression: false, useBackslashes: false);

            RepackConsole.Section("Package ISO");
            RepackConsole.Detail("Replacing the rebuilt level archive");
            _iso.ReplaceFile(outIso, bigInIso, newBig);

            // Authored hit sounds: rebuild the level's course bank inside AUDIO.BIG (donor-fill slots the
            // target bank leaves empty, encode custom WAVs into their reserved slots). Non-fatal: a failure
            // keeps the retail banks and the ISO stays playable.
            try { CourseBankInject.Apply(_iso, outIso, level, customDir, work, tmp, soundRate, soundEventRemap); }
            catch (Exception e)
            { RepackConsole.Warning($"Authored sound-bank injection failed ({e.Message}) — the ISO keeps the retail banks."); }

            // Optional static race track: Slopesmith stages Music/track.wav. Encode it as stereo 36 kHz
            // EA-XA slices in the first PathFinder song's retail short-stream layout; keep its MPF unchanged.
            // Non-fatal for the same reason as custom SFX: geometry packing remains independently useful.
            try { CustomMusicInject.Apply(_iso, outIso, level, customDir, tmp); }
            catch (Exception e)
            { RepackConsole.Warning($"Custom race-music injection failed ({e.Message}) — the ISO keeps its current race music."); }

            if (selectedPatches.Noclip)
            { int rc = _elf.Apply(outIso, "noclip", "noclip-fly-mode", revert: false); if (rc != 0) return rc; }
            // One flag does both halves on purpose: the patch is inert without the nodes and the nodes are
            // inert without the patch, so letting them be selected separately would only make it possible to
            // build an image that quietly shows nothing.
            if (selectedPatches.HudText)
            { int rc = _elf.Apply(outIso, "debug-text", "debug-text", revert: false); if (rc != 0) return rc; }
            if (!args.Contains("--no-skycolor"))
            {
                string? top = SkyTopColor(customDir);
                if (top != null)
                {
                    int rc = _elf.SkyColor(new[] { "skycolor", outIso, level, top });
                    if (rc != 0) return rc;
                }
            }
            if (!args.Contains("--in-place")) RepackConsole.Success($"Repacked {level}", outIso, started.Elapsed);
            return 0;
        }
        finally { try { Directory.Delete(tmp, true); } catch { } }
    }

    // A staged PNG's own pixel size, or (0, 0) when the file does not read as a PNG at all - the encoder is
    // what reports that, so the ladder simply leaves such an image out of the ceiling it sizes.
    private static (int Width, int Height) TryPngSize(string png)
    {
        try { return GsTextureLadder.PngSize(png); }
        catch { return (0, 0); }
    }

    static int RestoreExternalSoundTails(string instancesPath, string originalAdlPath)
    {
        if (!File.Exists(instancesPath) || !File.Exists(originalAdlPath)) return 0;
        var adl = new ADLHandler(); adl.Load(originalAdlPath);
        var byHash = new Dictionary<int, ADLHandler.SoundData>();
        foreach (var row in adl.HashSounds) byHash[row.Hash] = row.Sound;

        var root = JObject.Parse(File.ReadAllText(instancesPath));
        if (root["Instances"] is not JArray instances) return 0;
        int restored = 0;
        foreach (var token in instances)
        {
            if (token is not JObject inst || (int?)inst["Hash"] is not int hash || !byHash.TryGetValue(hash, out var source)) continue;
            if ((inst["Sounds"] as JObject)?["ExternalSounds"] is not JArray dest) continue;
            int n = Math.Min(dest.Count, source.ExternalSounds.Count);
            for (int i = 0; i < n; i++)
            {
                var raw = source.ExternalSounds[i];
                if ((raw.U0 != 1 && raw.U0 != 2) || dest[i] is not JObject sound) continue;
                sound["U7"] = raw.U7; sound["U8"] = raw.U8; sound["U9"] = raw.U9;
                sound["U10"] = raw.U10; sound["U11"] = raw.U11;
                restored++;
            }
        }
        if (restored > 0) File.WriteAllText(instancesPath, root.ToString(Newtonsoft.Json.Formatting.None));
        return restored;
    }

    // Ensure every path in an authored AIP/SOP JSON carries a PathEvents array: the lib's path writer
    // (TrickyLevelInterface AIP/SOP build) indexes PathEvents unconditionally, and older Slopesmith
    // exports omit the field entirely (deserializes null -> NRE).
    private static void FillPathEvents(JObject root)
    {
        foreach (var key in new[] { "AIPaths", "RaceLines" })
            if (root[key] is JArray paths)
                foreach (var p in paths.OfType<JObject>())
                    if (p["PathEvents"] is not JArray)
                        p["PathEvents"] = new JArray();
    }

    // The loader writes StartPosCount pointers into a fixed inline six-slot field. AIP/SOP datasets must
    // provide exactly six. Preserve every original path, but prepend six clones of valid designated starts
    // when the table is not already the required shape.
    private static bool EnsureSixStartPaths(JObject root)
    {
        const int fieldSize = 6;
        var paths = root["AIPaths"] as JArray
            ?? throw new InvalidDataException("Authored path JSON has no AIPaths array.");
        var starts = root["StartPosList"] as JArray ?? new JArray();
        var valid = new List<JObject>();
        var validIndices = new List<int>();
        foreach (var token in starts)
        {
            int index = (int?)token ?? -1;
            if (index >= 0 && index < paths.Count && paths[index] is JObject path)
            {
                valid.Add(path);
                validIndices.Add(index);
            }
        }

        if (starts.Count == fieldSize && valid.Count == fieldSize)
            return false;

        if (valid.Count >= fieldSize)
        {
            root["StartPosList"] = new JArray(validIndices.Take(fieldSize));
            return true;
        }

        JObject fallback = valid.FirstOrDefault()
            ?? paths.OfType<JObject>().FirstOrDefault()
            ?? throw new InvalidDataException("Authored path JSON has no path to seed its six start slots.");
        if (valid.Count == 0) valid.Add(fallback);

        var expanded = new JArray();
        for (int i = 0; i < fieldSize; i++)
            expanded.Add(valid[i % valid.Count].DeepClone());
        foreach (var path in paths)
            expanded.Add(path.DeepClone());
        root["AIPaths"] = expanded;
        root["StartPosList"] = new JArray(Enumerable.Range(0, fieldSize));
        return true;
    }

    private static void RelocateStageAreaStartAnchor(byte[] pbd, string sopPath)
    {
        const uint stageAreaStartHash = 0x0091F640;
        // Centroid of the stock six-rider staging formation read at runtime. Its coordinates are local
        // to StageArea_Start; aligning it (rather than the anchor's origin) puts the field on the race origin.
        var formationCenter = new Vector3(-8.261667f, 42.926667f, 280.648346f);

        if (pbd.Length < 0x88)
            throw new InvalidDataException("PBD is too short to contain its instance/hash offsets.");

        var sop = JObject.Parse(File.ReadAllText(sopPath));
        var raceLine = (sop["RaceLines"] as JArray)?.OfType<JObject>().FirstOrDefault()
            ?? throw new InvalidDataException("Authored SOP has no race line for the StageArea start anchor.");
        Vector3 target = JsonVector3(raceLine["PathPos"], "SOP race-line PathPos");
        var points = raceLine["PathPoints"] as JArray
            ?? throw new InvalidDataException("Authored SOP race line has no PathPoints.");
        Vector3 firstStep = default;
        foreach (var point in points)
        {
            var candidate = JsonVector3(point, "SOP race-line PathPoints entry");
            if (candidate.X * candidate.X + candidate.Y * candidate.Y <= 0.0001f) continue;
            firstStep = candidate;
            break;
        }
        if (firstStep.X * firstStep.X + firstStep.Y * firstStep.Y <= 0.0001f)
            throw new InvalidDataException("Authored SOP race line has no horizontal first step.");

        int hashOffset = BitConverter.ToInt32(pbd, 0x80);
        if (hashOffset <= 0 || hashOffset > pbd.Length - 20)
            throw new InvalidDataException($"PBD has an invalid hash-section offset: 0x{hashOffset:X}.");

        int instanceCount = BitConverter.ToInt32(pbd, hashOffset + 12);
        int instanceOffset = BitConverter.ToInt32(pbd, hashOffset + 16);
        long entriesStart = (long)hashOffset + instanceOffset;
        long entriesEnd = entriesStart + (long)instanceCount * 8;
        if (instanceCount < 0 || instanceOffset < 0 || entriesStart < 0 || entriesEnd > pbd.Length)
            throw new InvalidDataException("PBD instance-hash table falls outside the file.");

        int instanceIndex = -1;
        for (int i = 0; i < instanceCount; i++)
        {
            int entry = (int)entriesStart + i * 8;
            uint hash = BitConverter.ToUInt32(pbd, entry);
            if (hash != stageAreaStartHash) continue;
            instanceIndex = BitConverter.ToInt32(pbd, entry + 4);
            break;
        }
        if (instanceIndex < 0)
            throw new InvalidDataException("PBD has no Mdl_StageArea_Start_0 instance-hash entry.");

        int pbdInstanceCount = BitConverter.ToInt32(pbd, 0x0C);
        int pbdInstanceOffset = BitConverter.ToInt32(pbd, 0x48);
        long recordLong = (long)pbdInstanceOffset + (long)instanceIndex * 256;
        if (instanceIndex >= pbdInstanceCount || recordLong < 0 || recordLong + 256 > pbd.Length)
            throw new InvalidDataException($"StageArea instance {instanceIndex} falls outside the PBD instance table.");
        int record = (int)recordLong;

        Matrix4x4 oldMatrix = ReadPbdMatrix(pbd, record);
        Vector3 oldMin = ReadPbdVector3(pbd, record + 0xCC);
        Vector3 oldMax = ReadPbdVector3(pbd, record + 0xD8);

        // An identity retail StageArea faces course-forward along -X. Rotate that axis onto the first
        // authored horizontal path step, then translate the formation centroid onto PathPos.
        float yaw = MathF.Atan2(firstStep.Y, firstStep.X) - MathF.PI;
        Matrix4x4 newMatrix = Matrix4x4.CreateRotationZ(yaw);
        Vector3 rotatedCenter = Vector3.TransformNormal(formationCenter, newMatrix);
        newMatrix.Translation = target - rotatedCenter;
        WritePbdMatrix(pbd, record, newMatrix);

        // Preserve a correct world-space instance AABB for LTG regeneration. Transform the old box back
        // through the old placement and then through the new placement; the result is conservative if the
        // old box enclosed a rotated model.
        if (Matrix4x4.Invert(oldMatrix, out Matrix4x4 inverseOld))
        {
            Vector3 newMin = new(float.PositiveInfinity);
            Vector3 newMax = new(float.NegativeInfinity);
            for (int mask = 0; mask < 8; mask++)
            {
                Vector3 corner = new(
                    (mask & 1) == 0 ? oldMin.X : oldMax.X,
                    (mask & 2) == 0 ? oldMin.Y : oldMax.Y,
                    (mask & 4) == 0 ? oldMin.Z : oldMax.Z);
                Vector3 moved = Vector3.Transform(Vector3.Transform(corner, inverseOld), newMatrix);
                newMin = Vector3.Min(newMin, moved);
                newMax = Vector3.Max(newMax, moved);
            }
            WritePbdVector3(pbd, record + 0xCC, newMin);
            WritePbdVector3(pbd, record + 0xD8, newMax);
        }

        Vector3 t = newMatrix.Translation;
        Log.Info($"  authored spawn: StageArea start instance {instanceIndex} -> "
            + $"({t.X:F1}, {t.Y:F1}, {t.Z:F1}), yaw {yaw * 180f / MathF.PI:F1} deg");
    }

    private static Vector3 JsonVector3(JToken? token, string label)
    {
        if (token is not JArray a || a.Count < 3)
            throw new InvalidDataException($"{label} is not a three-component array.");
        return new Vector3((float)a[0], (float)a[1], (float)a[2]);
    }

    private static Matrix4x4 ReadPbdMatrix(byte[] data, int offset) => new(
        BitConverter.ToSingle(data, offset + 0x00), BitConverter.ToSingle(data, offset + 0x04),
        BitConverter.ToSingle(data, offset + 0x08), BitConverter.ToSingle(data, offset + 0x0C),
        BitConverter.ToSingle(data, offset + 0x10), BitConverter.ToSingle(data, offset + 0x14),
        BitConverter.ToSingle(data, offset + 0x18), BitConverter.ToSingle(data, offset + 0x1C),
        BitConverter.ToSingle(data, offset + 0x20), BitConverter.ToSingle(data, offset + 0x24),
        BitConverter.ToSingle(data, offset + 0x28), BitConverter.ToSingle(data, offset + 0x2C),
        BitConverter.ToSingle(data, offset + 0x30), BitConverter.ToSingle(data, offset + 0x34),
        BitConverter.ToSingle(data, offset + 0x38), BitConverter.ToSingle(data, offset + 0x3C));

    private static void WritePbdMatrix(byte[] data, int offset, Matrix4x4 m)
    {
        float[] values =
        {
            m.M11, m.M12, m.M13, m.M14, m.M21, m.M22, m.M23, m.M24,
            m.M31, m.M32, m.M33, m.M34, m.M41, m.M42, m.M43, m.M44,
        };
        for (int i = 0; i < values.Length; i++)
            BitConverter.GetBytes(values[i]).CopyTo(data, offset + i * 4);
    }

    private static Vector3 ReadPbdVector3(byte[] data, int offset) => new(
        BitConverter.ToSingle(data, offset),
        BitConverter.ToSingle(data, offset + 4),
        BitConverter.ToSingle(data, offset + 8));

    private static void WritePbdVector3(byte[] data, int offset, Vector3 v)
    {
        BitConverter.GetBytes(v.X).CopyTo(data, offset);
        BitConverter.GetBytes(v.Y).CopyTo(data, offset + 4);
        BitConverter.GetBytes(v.Z).CopyTo(data, offset + 8);
    }

    /// <summary>Rows in the work dir's instance table, or 0 when it is unreadable.</summary>
    private static int CountInstances(string work)
    {
        string path = Path.Combine(work, "Instances.json");
        if (!File.Exists(path)) return 0;
        return JObject.Parse(File.ReadAllText(path))["Instances"] is JArray a ? a.Count : 0;
    }

    /// <summary>
    /// Make the first <paramref name="donorCount"/> instances invisible and non-contacting: the donor course's
    /// own props, which an authored course inherits along with the slot.
    ///
    /// Hidden, not removed. Instance indices are the join for the per-instance ObjectProperties/InstanceState
    /// list, the name-hash table, the .ltg grid lists, effect slots and the spline tables; deleting a row would
    /// renumber every one of them. Clearing the render and contact flags leaves all of that intact while the
    /// prop stops drawing and stops being an obstacle - and the Unity bundler already skips instances whose
    /// visible flag is clear, so the same edit answers both targets.
    ///
    /// The two StageArea markers stay: the engine hashes their names to place the rider at the start and the
    /// podium at the finish, and a course with neither strands the formation at the untransformed level origin.
    /// Returns the number hidden.
    /// </summary>
    private static int HideDonorInstances(string work, int donorCount)
    {
        string path = Path.Combine(work, "Instances.json");
        if (donorCount <= 0 || !File.Exists(path)) return 0;
        var root = JObject.Parse(File.ReadAllText(path));
        if (root["Instances"] is not JArray instances) return 0;
        int hidden = 0;
        for (int i = 0; i < donorCount && i < instances.Count; i++)
        {
            if (instances[i] is not JObject inst) continue;
            string name = (string?)inst["InstanceName"] ?? "";
            if (name.StartsWith("Mdl_StageArea_", StringComparison.OrdinalIgnoreCase)) continue;
            inst["Visable"] = false;
            inst["PlayerCollision"] = false;
            inst["PlayerBounce"] = false;
            inst["CollsionMode"] = Engine.NativeCollisionMode.None;
            inst["CollsionModelPaths"] = new JArray();
            // ...and its SOUND, which is not a drawing property and does not follow from any of the above. A
            // placed ambient emitter is dispatched off a spatial grid built from the ADL, never off the
            // instance's visibility or collision, so a hidden prop keeps its bed playing: an authored course
            // built --bare-slot still inherited the whole of Garibaldi's crowd and birdsong from props that
            // were not drawn, loud enough to mask the author's own emitters. "Bare" has to mean silent too.
            inst["IncludeSound"] = false;
            inst.Remove("Sounds");
            hidden++;
        }
        File.WriteAllText(path, root.ToString(Newtonsoft.Json.Formatting.None));
        return hidden;
    }

    // Append authored gem pickups (Slopesmith's Gems.json) into the work dir's Instances.json as real gem
    // INSTANCES (Slopesmith docs/014). Each gem clones a tier-matched ORIGINAL gem instance as a template — inheriting its
    // gem model (the tiered crystal), its EffectSlotIndex (the SSF MainType-14 pickup effect = the score
    // multiplier) and LTGState 2 (the gem list) — and just moves it to the authored raw position. Because the
    // regen rebuilds the pbd instances + the .ssf ObjectProperties/InstanceState from this file (SSFGenerate),
    // the gems' pickup behaviour comes for free from the borrowed slot, and the .ltg regen lists them in the
    // GemIndex off LTGState 2. Returns the number appended (0 = no Gems.json / no template gem in the level).
    private int AppendAuthoredGems(string work, string customDir)
    {
        string gemsPath = Path.Combine(customDir, "Gems.json");
        if (!File.Exists(gemsPath)) return 0;
        var gems = JObject.Parse(File.ReadAllText(gemsPath))["Gems"] as JArray;
        if (gems == null || gems.Count == 0) return 0;

        string instPath = Path.Combine(work, "Instances.json");
        var instRoot = JObject.Parse(File.ReadAllText(instPath));
        if (instRoot["Instances"] is not JArray instances) return 0;

        // Gem models by tier from Models.json: Gem_TrickMultiplier_YellowX2 / OrangeX3 / RedX5.
        var tierModels = new Dictionary<int, HashSet<int>> { { 2, new() }, { 3, new() }, { 5, new() } };
        if (JObject.Parse(File.ReadAllText(Path.Combine(work, "Models.json")))["Models"] is JArray models)
            for (int i = 0; i < models.Count; i++)
            {
                string nm = (string?)models[i]["ModelName"] ?? "";
                if (nm.IndexOf("Gem_TrickMultiplier", StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (nm.Contains("X2")) tierModels[2].Add(i);
                else if (nm.Contains("X3")) tierModels[3].Add(i);
                else if (nm.Contains("X5")) tierModels[5].Add(i);
            }

        // One template gem INSTANCE per tier (a shipped gem of that tier), for its model + effect slot + lighting.
        var template = new Dictionary<int, JObject>();
        foreach (var inst in instances)
        {
            int mid = (int?)inst["ModelID"] ?? -1;
            foreach (var tier in tierModels.Keys)
                if (tierModels[tier].Contains(mid) && !template.ContainsKey(tier)) template[tier] = (JObject)inst;
        }
        JObject? anyTpl = template.Count > 0 ? template.Values.First() : null;
        if (anyTpl == null) { Log.Warn("  WARN: no shipped gem instance to template — authored gems not injected."); return 0; }

        int added = 0;
        foreach (var g in gems)
        {
            if (g["Position"] is not JArray pos || pos.Count < 3) continue;
            int value = (int?)g["Value"] ?? 1;
            int tier = value <= 2 ? 2 : value <= 4 ? 3 : 5;
            var tpl = template.TryGetValue(tier, out var t) ? t : anyTpl;
            var gem = (JObject)tpl.DeepClone();
            gem["Location"] = new JArray((double)pos[0], (double)pos[1], (double)pos[2]);
            gem["InstanceName"] = $"AuthoredGem_{added}";
            gem["PrevInstance"] = -1;   // standalone: the gem's LTG membership comes from LTGState 2, not the instance chain
            gem["NextInstance"] = -1;
            instances.Add(gem);
            added++;
        }
        File.WriteAllText(instPath, instRoot.ToString(Newtonsoft.Json.Formatting.None));
        Log.Info($"  authored gems: {added} instance(s) appended (tier-matched shipped gem model + MainType-14 effect slot + LTGState 2).");
        return added;
    }

    // Build a PBD = original's verbatim with only the freshly-regenerated sections that carry authored data
    // swapped in: always the terrain patch section (regenerating everything instead re-encodes props through
    // OBJ, losing their triangle strips), plus the light section when the export
    // authored its own Lights.json (so the authored sun+ambient reach the PBD light chunk and the rider is
    // lit by them; without authored lights the original's light table stays byte-verbatim). PBD header is
    // little-endian u32: NumPatches@8, NumLights@28, NumTextures@52, section offsets @64..132 with
    // PatchOffset@68 and LightsOffset@88 (PBDHandler). Both sections are relocatable: patches reference
    // textures/lightmaps by index, lights are referenced only by index (the LTG's crossing lists, rebuilt
    // from this hybrid). A swapped section overwrites its original region in place when it fits (trailing
    // bytes go unread since the count bounds the read); else it is appended and its offset repointed. Every
    // untouched section stays byte-for-byte at its original offset, so props/meshes draw exactly as the
    // original. NumPatches/NumLights/NumTextures come from the regenerated PBD.
    private static byte[] SurgicalPatchSwap(byte[] original, byte[] regen, bool swapLights, bool swapSplines = false, bool swapInstances = false)
    {
        static int U(byte[] b, int p) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24);
        static void P(byte[] b, int p, int v) { b[p] = (byte)v; b[p + 1] = (byte)(v >> 8); b[p + 2] = (byte)(v >> 16); b[p + 3] = (byte)(v >> 24); }
        int[] offFields = { 64, 68, 72, 76, 80, 84, 88, 92, 96, 100, 104, 108, 112, 116, 120, 124, 128, 132 };
        int NextAfter(byte[] b, int off) { int end = b.Length; foreach (int f in offFields) { int o = U(b, f); if (o > off && o < end) end = o; } return end; }

        byte[] hybrid = (byte[])original.Clone();
        var sections = new List<(int cntField, int offField)> { (8, 68) };            // patches, always
        if (swapInstances) sections.Add((0x0C, 0x48));                                 // instances: count@0x0C, offset@0x48 (authored gems)
        if (swapLights) sections.Add((28, 88));                                        // lights, when authored
        if (swapSplines)                                                               // grind rails, when authored (spec 220)
        {
            sections.Add((0x20, 0x5C));                                                // splines: count@0x20, offset@0x5C
            sections.Add((0x24, 0x60));                                                // spline segments: count@0x24, offset@0x60
        }
        foreach (var (cntField, offField) in sections)
        {
            int regOff = U(regen, offField), len = NextAfter(regen, regOff) - regOff;
            int origOff = U(hybrid, offField), region = NextAfter(hybrid, origOff) - origOff;
            int dstOff;
            if (len <= region) dstOff = origOff;                                       // in place
            else                                                                       // append
            {
                int pad = (16 - (hybrid.Length % 16)) % 16;
                dstOff = hybrid.Length + pad;
                var grown = new byte[dstOff + len];
                System.Array.Copy(hybrid, grown, hybrid.Length);
                hybrid = grown;
            }
            System.Array.Copy(regen, regOff, hybrid, dstOff, len);
            P(hybrid, offField, dstOff);
            P(hybrid, cntField, U(regen, cntField));
        }
        P(hybrid, 52, U(regen, 52));  // NumTextures (grown by any appended borrowed/custom pages)
        return hybrid;
    }

    /// <summary>
    /// Conservatively identify original target-bank slots that the exported level can still address. Slot zero
    /// is always retained as the unresolved-texture fallback. The replacement terrain's native paths (both the
    /// ones it names outright and the ones its manifest resolves it to), every original material path/flipbook
    /// frame, and native pages used by authored props are protected; all other original slots are available for
    /// foreign/custom page installation.
    /// </summary>
    private static HashSet<int> ReferencedOriginalTextureSlots(
        string patchesJson, string materialsPath, CanonicalMapProps.Source? propBake, string targetLevel, int slotCount,
        IEnumerable<string> resolvedTargetPages)
    {
        var referenced = new HashSet<int>();
        if (slotCount > 0) referenced.Add(0);

        var bareSlot = new System.Text.RegularExpressions.Regex(@"^(\d{4})\.png$",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        var targetSlot = new System.Text.RegularExpressions.Regex(
            $@"^(?:p_)?{System.Text.RegularExpressions.Regex.Escape(targetLevel)}(?:_|[\\/])(\d{{4}})\.png$",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);

        void KeepMatch(System.Text.RegularExpressions.Match match)
        {
            if (match.Success && int.TryParse(match.Groups[1].Value, out int slot)
                && slot >= 0 && slot < slotCount)
                referenced.Add(slot);
        }
        void KeepBare(string? path) => KeepMatch(bareSlot.Match(path ?? ""));
        void KeepTerrainPath(string? path)
        {
            string value = path ?? "";
            var bare = bareSlot.Match(value);
            KeepMatch(bare.Success ? bare : targetSlot.Match(value));
        }

        var patchRoot = JObject.Parse(patchesJson);
        foreach (var patch in patchRoot["Patches"] as JArray ?? new JArray())
            KeepTerrainPath((string?)patch["TexturePath"]);

        foreach (string page in resolvedTargetPages) KeepBare(page);

        var materialRoot = JObject.Parse(File.ReadAllText(materialsPath));
        foreach (var material in materialRoot["Materials"] as JArray ?? new JArray())
        {
            KeepBare((string?)material["TexturePath"]);
            if (material["TextureFlipbook"] is JArray frames)
                foreach (var frame in frames) KeepBare((string?)frame);
        }

        if (propBake != null)
            foreach (int slot in CanonicalMapProps.NativeTileSlots(propBake, targetLevel))
                if (slot >= 0 && slot < slotCount) referenced.Add(slot);

        return referenced;
    }

    private static string DescribeSlots(IEnumerable<string> slots)
    {
        var list = slots.ToList();
        const int shown = 16;
        string text = string.Join(", ", list.Take(shown));
        return list.Count <= shown ? text : $"{text}, … (+{list.Count - shown})";
    }

    // The colour the export authored for the sky above the ring, or null if it authored none.
    private static string? SkyTopColor(string customDir)
    {
        string meta = Path.Combine(customDir, "Skybox", "Sky.json");
        if (!File.Exists(meta)) return null;
        return (string?)JObject.Parse(File.ReadAllText(meta))["TopColor"];
    }

    /// <summary>
    /// Replace the level's sky with the one the export authored (<c>&lt;customDir&gt;/Skybox/</c>, Slopesmith docs/025).
    /// No Skybox/Sky.json = no change: the target level keeps its own backdrop, exactly as before.
    ///
    /// SSX draws its sky as an open-topped cylinder of 25 textured panels — <c>&lt;stem&gt;_sky.pbd</c> for
    /// the ring, <c>&lt;stem&gt;_sky.ssh</c> for its texture bank — and the ring is BYTE-IDENTICAL on every
    /// level that ships one. That is what makes a sky portable, and it gives two paths:
    ///
    ///   Source "level"   the donor's <c>_sky.pbd</c> + <c>_sky.ssh</c> are lifted whole out of its own BIG in
    ///                    the same ISO and dropped into this level's slot. Nothing is decoded or re-encoded, so
    ///                    the sky arrives with its original 8-bit paletted pages intact — full quality, and no
    ///                    change in VRAM or upload cost. (The donor being the target itself is a no-op.)
    ///   Source "custom"  the 25 authored PNGs are encoded into a FRESH bank and only the <c>_sky.ssh</c> is
    ///                    replaced; the target's own <c>_sky.pbd</c> still supplies the geometry, which is
    ///                    correct precisely because every ring is the same. Authored pages must ship type-5
    ///                    (32-bit FullColor) — a re-encoded 8-bit page is not displayed by the PS2 uploader
    ///                    (Slopesmith docs/011 Phase 2) — so a custom sky costs 4× its page area in VRAM and per-frame
    ///                    upload. The export's "standard" tier (128px upper / 64px lower) exists to keep that
    ///                    within about the original sky's budget.
    ///
    /// The ring has an open top. Sky.json's TopColor is applied per course by the executable patch after the BIG
    /// is packed; sky export and injection retain the retail 25-mesh geometry.
    /// </summary>
    private void InjectSkybox(string iso, string lower, string customDir, string tmp, string rawDir, RepackPlan? plan = null)
    {
        string meta = Path.Combine(customDir, "Skybox", "Sky.json");
        if (!File.Exists(meta)) return;

        string models = Path.Combine(rawDir, "data", "models");
        string origSky = Path.Combine(tmp, "dec", "data", "models", $"{lower}_sky.ssh");
        if (!File.Exists(origSky))
        {
            string note = $"{lower} ships no _sky.ssh — authored skybox skipped.";
            Log.Warn("  WARN: " + note);
            plan?.Note("sky-no-target-bank", note);
            plan?.Sky(new PlanSky("verbatim", lower, 0, 0, note));
            return;
        }

        var sky = JObject.Parse(File.ReadAllText(meta));
        string source = (string?)sky["Source"] ?? "";
        string donor = (string?)sky["Level"] ?? "";
        string texDir = Path.Combine(customDir, "Skybox", "Textures");

        if (source == "level")
        {
            if (string.Equals(donor, lower, StringComparison.OrdinalIgnoreCase))
            {
                Log.Info("  skybox: the level's own — left verbatim.");
                plan?.Sky(new PlanSky("verbatim", lower, 0, 0, $"{lower}'s own sky — left verbatim, nothing installed"));
                return;
            }
            var pulled = PullDonorSky(iso, donor, tmp);
            if (pulled == null)
            {
                string missing = $"{donor} has no skybox in the ISO — {lower}'s own sky kept.";
                Log.Warn("  WARN: " + missing);
                plan?.Note("sky-donor-missing", missing);
                plan?.Sky(new PlanSky("verbatim", lower, 0, 0, missing));
                return;
            }
            if (plan == null)
            {
                File.WriteAllBytes(Path.Combine(models, $"{lower}_sky.pbd"), _refpack.Compress(pulled.Value.pbd));
                File.WriteAllBytes(Path.Combine(models, $"{lower}_sky.ssh"), _refpack.Compress(pulled.Value.ssh));
            }
            Log.Info($"  skybox: {donor}'s ring + texture bank lifted verbatim ({pulled.Value.ssh.Length:n0} bytes, no re-encode)");
            plan?.Sky(new PlanSky("donor", donor.ToUpperInvariant(), SshBank.Load(pulled.Value.ssh).Count, pulled.Value.ssh.Length,
                $"{donor.ToUpperInvariant()}'s bank lifted verbatim ({pulled.Value.ssh.Length:n0} bytes, no re-encode, no VRAM change)"));
            return;
        }

        if (!Directory.Exists(texDir))
        {
            string missing = "Skybox/Textures missing from the export — sky kept.";
            Log.Warn("  WARN: " + missing);
            plan?.Note("sky-textures-missing", missing);
            plan?.Sky(new PlanSky("verbatim", lower, 0, 0, missing));
            return;
        }
        var origBank = SshBank.Load(File.ReadAllBytes(origSky));
        var creator = new byte[4];
        System.Array.Copy(origBank.Bytes, 12, creator, 0, 4);

        // A custom panorama is exported as the retail ring's 25 pages. Re-encode exactly the target bank's
        // page count and retain its _sky.pbd geometry unchanged.
        var blobs = new List<byte[]>();
        for (int i = 0; i < origBank.Count; i++)
        {
            string png = Path.Combine(texDir, i.ToString("D4") + ".png");
            if (!File.Exists(png))
            {
                string missing = $"authored sky page {i:D4}.png missing — sky kept.";
                Log.Warn("  WARN: " + missing);
                plan?.Note("sky-page-missing", missing);
                plan?.Sky(new PlanSky("verbatim", lower, 0, 0, missing));
                return;
            }
            blobs.Add(_ssh.EncodeCustomPage(png));
        }
        byte[] bank = SshBank.Create(blobs, creator);
        Log.Info($"  skybox: {blobs.Count} authored pages encoded into a fresh _sky.ssh ({bank.Length:n0} bytes, 32-bit)");
        if (plan == null) File.WriteAllBytes(Path.Combine(models, $"{lower}_sky.ssh"), _refpack.Compress(bank));
        Log.Info($"  skybox: {lower}'s ring kept (25 meshes, open top)");
        plan?.Sky(new PlanSky("custom", lower.ToUpperInvariant(), blobs.Count, bank.Length,
            $"{blobs.Count} authored page(s) re-encoded type-5 into a fresh _sky.ssh ({bank.Length:n0} bytes) "
            + $"against {lower.ToUpperInvariant()}'s own {new FileInfo(origSky).Length:n0}-byte bank; the ring geometry is kept"));
    }

    /// <summary>A donor level's sky pair, pulled from its own BIG in the same ISO. Null if it ships none.</summary>
    private (byte[] pbd, byte[] ssh)? PullDonorSky(string iso, string donorLevel, string tmp)
    {
        try
        {
            string up = donorLevel.ToUpperInvariant(), low = donorLevel.ToLowerInvariant();
            string dec = Path.Combine(tmp, $"donor_{low}_dec");
            if (!Directory.Exists(dec))
            {
                string big = Path.Combine(tmp, $"donor_{low}.big");
                if (!File.Exists(big)) _iso.ExtractFile(iso, $"DATA\\MODELS\\{up}.BIG", big);
                BIG.Extract(big, dec);
            }
            string pbd = Path.Combine(dec, "data", "models", $"{low}_sky.pbd");
            string ssh = Path.Combine(dec, "data", "models", $"{low}_sky.ssh");
            if (!File.Exists(pbd) || !File.Exists(ssh)) return null;
            return (File.ReadAllBytes(pbd), File.ReadAllBytes(ssh));
        }
        catch { return null; }
    }

    // Pull a donor level's decompressed .ssh out of the ISO, for verbatim texture borrowing (Slopesmith docs/011 Phase 2).
    // Returns null if the donor BIG isn't in the ISO (e.g. a custom level not on the disc) or ships no ssh member.
    private byte[]? PullDonorSsh(string iso, string donorLevel, string tmp)
    {
        try
        {
            string up = donorLevel.ToUpperInvariant(), low = donorLevel.ToLowerInvariant();
            string big = Path.Combine(tmp, $"donor_{low}.big");
            _iso.ExtractFile(iso, $"DATA\\MODELS\\{up}.BIG", big);
            string dec = Path.Combine(tmp, $"donor_{low}_dec");
            BIG.Extract(big, dec);
            string ssh = Path.Combine(dec, "data", "models", $"{low}.ssh");
            return File.Exists(ssh) ? File.ReadAllBytes(ssh) : null;
        }
        catch { return null; }
    }

    private static void CopyDir(string src, string dst)
    {
        Directory.CreateDirectory(dst);
        foreach (var f in Directory.GetFiles(src, "*", SearchOption.AllDirectories))
        {
            string to = Path.Combine(dst, Path.GetRelativePath(src, f));
            Directory.CreateDirectory(Path.GetDirectoryName(to)!);
            File.Copy(f, to, true);
        }
    }

    // Diagnostic: per-cell list statistics of a world grid (.ltg, decompressed) - what the grid actually
    // distributes into cells. Used to compare a regenerated grid against the original's - an over-listed grid is
    // what costs frame rate under PCSX2's Full GS blending (docs/repack-technical-reference.md).
    public int LtgStats(string[] args)
    {
        if (args.Length < 2) { Log.Error("ltg-stats needs <file.ltg> [decompressed]"); return 1; }
        var ltg = new SSX_Library.FileHandlers.LevelFiles.Tricky.LTGHandler();
        ltg.LoadLTG(args[1]);
        int mw = ltg.mainBboxes!.GetLength(0), mh = ltg.mainBboxes.GetLength(1);
        long mPatch = 0, mLight = 0, mCross = 0, mSpline = 0, nPatch = 0, nLight = 0, nCross = 0, nSpline = 0, nInst = 0, nGem = 0;
        int mCrossMax = 0, nCrossMax = 0, cells = 0, nodes = 0;
        for (int y = 0; y < mh; y++) for (int x = 0; x < mw; x++)
        {
            var m = ltg.mainBboxes[x, y];
            cells++;
            mPatch += m.totalPatchCount; mLight += m.totalLightCount; mCross += m.totalLightsCrossingCount; mSpline += m.totalSplineCount;
            if (m.totalLightsCrossingCount > mCrossMax) mCrossMax = m.totalLightsCrossingCount;
            if (m.nodeBBoxes == null) continue;
            for (int y1 = 0; y1 < m.nodeBBoxes.GetLength(1); y1++) for (int x1 = 0; x1 < m.nodeBBoxes.GetLength(0); x1++)
            {
                var nb = m.nodeBBoxes[x1, y1];
                nodes++;
                nPatch += nb.patchCount; nLight += nb.lightCount; nCross += nb.lightsCrossingCount; nSpline += nb.splineCount;
                nInst += nb.InstanceIndex?.Count ?? 0; nGem += nb.GemIndex?.Count ?? 0;
                if (nb.lightsCrossingCount > nCrossMax) nCrossMax = nb.lightsCrossingCount;
            }
        }
        Log.Info($"{Path.GetFileName(args[1])}: grid {mw}x{mh} ({cells} cells, {nodes} nodes)");
        Log.Info($"  main:  patches {mPatch}  splines {mSpline}  lights {mLight}  lightsCrossing {mCross} (max/cell {mCrossMax})");
        Log.Info($"  nodes: patches {nPatch}  splines {nSpline}  lights {nLight}  lightsCrossing {nCross} (max/node {nCrossMax})");
        Log.Info($"  nodes: instances {nInst}  gems {nGem}");
        return 0;
    }

    // Diagnostic: which node cells LIST a given instance. The grid is the collision broadphase - a query point maps
    // to its node cell and only that cell's listed instances reach the narrowphase ([Trailmap: 130-broadphase]) - and
    // listing is single-cell, so the region where a prop can be hit is the listing CELL, not the prop's own bounds.
    // Prints each listing cell's world XY extent so the two can be compared directly.
    public int LtgFind(string[] args)
    {
        if (args.Length < 3) { Log.Error("ltg-find needs <file.ltg> <instanceIndex>"); return 1; }
        if (!int.TryParse(args[2], out int want)) { Log.Error($"ltg-find: '{args[2]}' is not an instance index"); return 1; }

        var ltg = new SSX_Library.FileHandlers.LevelFiles.Tricky.LTGHandler();
        ltg.LoadLTG(args[1]);
        int mw = ltg.mainBboxes!.GetLength(0), mh = ltg.mainBboxes.GetLength(1);

        Log.Info($"{Path.GetFileName(args[1])}: instance {want} - node cell size {ltg.nodeBoxSize}, " +
                          $"{ltg.nodeBoxWidth}x{ltg.nodeBoxWidth} nodes per {ltg.mainBboxSize} main cell");
        // The grid origin, so a listing cell's NOMINAL partition square can be stated beside the bounds stored on
        // it - the two differ in shipped data, and only the nominal square is what a query point maps into.
        var o = ltg.mainBboxes[0, 0].WorldBounds1;
        Log.Info($"  grid origin: X {o.X:F1}  Y {o.Y:F1}");
        int found = 0;
        for (int y = 0; y < mh; y++) for (int x = 0; x < mw; x++)
        {
            var m = ltg.mainBboxes[x, y];
            if (m.nodeBBoxes == null) continue;
            for (int y1 = 0; y1 < m.nodeBBoxes.GetLength(1); y1++) for (int x1 = 0; x1 < m.nodeBBoxes.GetLength(0); x1++)
            {
                var nb = m.nodeBBoxes[x1, y1];
                string list = (nb.InstanceIndex?.Contains(want) ?? false) ? "InstanceIndex"
                            : (nb.RaceInstanceIndex?.Contains(want) ?? false) ? "RaceInstanceIndex"
                            : (nb.GemIndex?.Contains(want) ?? false) ? "GemIndex" : null!;
                if (list == null) continue;
                found++;
                float nx = o.X + x * ltg.mainBboxSize + x1 * ltg.nodeBoxSize;
                float ny = o.Y + y * ltg.mainBboxSize + y1 * ltg.nodeBoxSize;
                Log.Info($"  main[{x},{y}] node[{x1},{y1}] {list}  ({nb.instanceCount} inst, {nb.patchCount} patches)");
                Log.Info($"      nominal square: X {nx:F1}..{nx + ltg.nodeBoxSize:F1}  Y {ny:F1}..{ny + ltg.nodeBoxSize:F1}");
                Log.Info($"      stored bounds:  X {nb.WorldBounds1.X:F1}..{nb.WorldBounds2.X:F1}  " +
                                  $"Y {nb.WorldBounds1.Y:F1}..{nb.WorldBounds2.Y:F1}");
            }
        }
        Log.Info(found == 0
            ? "  listed in NO node cell - it can never be a collision candidate."
            : $"  listed in {found} node cell(s).");
        return 0;
    }
}
