using DiscUtils.Iso9660;
using SSX_Library; // BIG
using SSX_Library.FileHandlers.LevelFiles.Tricky;
using SSX_Library.FileHandlers.LevelFiles.Tricky.PS2;
using SSXLibrary;  // TrickyLevelInterface
using Snowknife.Bundle;
using Snowknife.Export;
using Snowknife.Repack;

namespace Snowknife.Services;

/// <summary>
/// The level asset pipeline: `import` (ISO -> diagnosable Maps intermediate), `gltf` (build the
/// engine-neutral .glb bundle), `unity` (copy the Unity-needed subset into a project), plus the standalone
/// re-runnable stages `props` / `overrides` / `skybox` / `lightmaps`. Composes the ISO, audio, and particle
/// services for the level extract's shared decode steps.
/// </summary>
internal sealed class LevelPipelineService
{
    private readonly IsoService _iso;
    private readonly AudioService _audio;
    private readonly ParticleService _particles;
    private readonly EffectsDocumentService _effects;
    private readonly ContractValidationService _contracts;
    private readonly ElfPatchService _elf;

    public LevelPipelineService(IsoService iso, AudioService audio, ParticleService particles,
                                EffectsDocumentService effects, ContractValidationService contracts,
                                ElfPatchService elf)
    {
        _iso = iso;
        _audio = audio;
        _particles = particles;
        _effects = effects;
        _contracts = contracts;
        _elf = elf;
    }

    /// <summary>
    /// Write just <c>World.json</c> into an existing map folder — the same step `import` runs, on its own, so a
    /// map extracted before this contract existed can be brought up to date without re-running the whole
    /// extract. Reads the ISO; writes one file.
    /// </summary>
    public int World(string[] args)
    {
        if (args.Length < 4) { Log.Error("world needs <iso> <courseSlot> <mapDir>"); return 1; }
        string iso = args[1], levelName = args[2], mapDir = Path.GetFullPath(args[3]);
        if (!Directory.Exists(mapDir)) { Log.Error($"world: {mapDir} is not a map folder."); return 1; }
        if (!_elf.TryReadWorldConfig(iso, levelName, out var world, out string error))
        { Log.Error($"world: {error}"); return 1; }
        world.Write(mapDir);
        _contracts.RequireFile(Path.Combine(mapDir, WorldConfig.FileName), ContractKind.WorldV1);
        var g = world.Glare!;
        Log.Info($"world: wrote {Path.Combine(mapDir, WorldConfig.FileName)} - celestial glare "
                          + (g.Enabled
                             ? $"ON, sun az {g.AzimuthDegrees:0.###} / el {g.ElevationDegrees:0.###}, "
                               + $"fan [{string.Join(",", g.CoreColour)}] x{g.FanIntensity:0.###}, "
                               + $"sprite [{string.Join(",", g.RimColour)}] x{g.SpriteIntensity:0.###}, "
                               + $"distance {g.DistanceUnits:0.#}, size {g.SizeUnits:0.#}."
                             : "off for this course."));
        return 0;
    }

    public int Import(string[] args)
    {
        if (args.Length < 4) { Log.Error("import needs <iso> <courseSlot> <mapDir>"); return 1; }
        string iso = args[1];
        string levelName = args[2];
        string outDir = Path.GetFullPath(args[3]);

        Directory.CreateDirectory(outDir);
        // A previous run's gltf/ was built FROM the raw layer this run replaces, so it would silently go
        // stale. Remove it so the workspace never carries a bundle older than its inputs.
        string staleGltf = Path.Combine(outDir, "gltf");
        if (Directory.Exists(staleGltf))
        {
            Directory.Delete(staleGltf, recursive: true);
            Log.Info("(removed the previous run's gltf/ - re-run `snowknife gltf` after this extract.)");
        }
        // Same for the mesh exports: one .obj per MeshID, so a model this extract no longer has would
        // otherwise survive as a stale file.
        ClearObjFiles(Path.Combine(outDir, "Meshes"));
        ClearObjFiles(Path.Combine(outDir, "Skybox", "Meshes"));
        string work = Path.Combine(Path.GetTempPath(), "snowknife_" + Guid.NewGuid().ToString("N"));
        string bigDir = Path.Combine(work, "big");
        string filesDir = Path.Combine(work, "files");
        Directory.CreateDirectory(bigDir);
        Directory.CreateDirectory(filesDir);

        // 1. Pull <levelName>.BIG out of DATA\MODELS in the ISO.
        string bigPath = Path.Combine(bigDir, levelName.ToUpperInvariant() + ".BIG");
        Log.Info($"[1/4] Reading {levelName}.BIG from ISO...");
        // The disc's own statement of which build it carries (SYSTEM.CNF), so the effects document can name
        // the build it interoperates with instead of assuming a region.
        string? bootExecutable;
        using (FileStream isoStream = File.OpenRead(iso))
        {
            bootExecutable = _iso.ReadBootExecutableName(isoStream);
            isoStream.Seek(0, SeekOrigin.Begin);
            CDReader cd = _iso.OpenIso(isoStream);
            var bigFile = _iso.FindLevelBig(cd, levelName)
                          ?? throw new FileNotFoundException($"Could not find a .BIG for level '{levelName}' under DATA\\MODELS in the ISO.");
            Log.Info($"      Found {_iso.CleanName(bigFile.Name)} ({bigFile.Length:n0} bytes)");
            using Stream src = bigFile.OpenRead();
            using FileStream dst = File.Create(bigPath);
            src.CopyTo(dst);
        }

        // 2. Decompress/unpack the BIG archive.
        Log.Info($"[2/4] Unpacking BIG ({BIG.GetBigType(bigPath)})...");
        BIG.Extract(bigPath, filesDir);

        // 3. Locate the .map (level entry point) the same way the GUI does.
        string[] maps = Directory.GetFiles(filesDir, "*.map", SearchOption.AllDirectories);
        if (maps.Length == 0)
            throw new FileNotFoundException("No .map file found inside the level BIG.");
        string mapPath = maps[0];
        string loadPath = mapPath.Substring(0, mapPath.Length - 4); // strip ".map"
        Log.Info($"[3/4] Found level: {Path.GetFileName(mapPath)}");
        Log.Info($"      Sibling files: {string.Join(", ", Directory.GetFiles(Path.GetDirectoryName(mapPath)!).Select(Path.GetFileName))}");

        if (HasFlag(args, "--repair-missing-map-links"))
            RepairMissingMapLinks(loadPath);

        // 4. Run the existing Tricky level extractor -> OBJ meshes + PNG textures.
        Log.Info($"[4/4] Extracting level to {outDir} ...");
        var lvl = new TrickyLevelInterface();
        lvl.ExtractTrickyLevelFiles(loadPath, outDir);
        _contracts.RequireFile(Path.Combine(outDir, "Patches.json"), ContractKind.PatchesV1);
        _contracts.RequireIfPresent(Path.Combine(outDir, "Splines.json"), ContractKind.SplinesV1);

        // Origin.json - what this folder is and what is in it, stated by the tool that knows rather than
        // guessed later by whoever opens it. Everything below this line copies bytes off the user's disc, so
        // the answer for an extract is settled before any of it runs: retail, and it carries retail data.
        // Slopesmith's export writes the same contract with its own classification, which is how an authored
        // mountain that borrows a tree ends up marked `slopesmith` AND retail. A consumer that finds no
        // Origin.json reads the folder as retail anyway; writing it is what lets an authored one say otherwise.
        var origin = MapOrigin.ForRetailExtract(levelName);
        origin.Write(outDir);
        _contracts.RequireFile(Path.Combine(outDir, MapOrigin.FileName), ContractKind.OriginV1);
        Log.Info($"      {MapOrigin.FileName}: {origin.Origin} extract of {origin.Course} - carries retail data.");

        // Effects.json is the lossless stable-ID contract every direction shares: `gltf` bundles from it,
        // Slopesmith edits it (including its physics-body decode), Unity accepts it, and Snowknife compiles
        // it back to SSF. SSFLogic.json is written for one consumer: repack's SSFGenerate compile.
        string effectsPath = Path.Combine(outDir, "Effects.json");
        if (HasFlag(args, "--no-effects"))
        {
            // Third-party level mods sometimes ship an SSF whose native instance references no longer fit
            // the PBD it accompanies. Terrain/props remain useful as a Slopesmith reference, but presenting
            // that broken graph as portable effects would make the corruption look supported. An explicit
            // opt-out drops any stale prior export and continues with no Effects.json, which every consumer
            // already treats as "this map has no portable effects".
            File.Delete(effectsPath);
            Log.Info("      Effects.json skipped (--no-effects); terrain, props and paths will still be imported.");
        }
        else
        {
            var effectsArgs = new List<string>
            {
                "effects-export", loadPath + ".ssf", effectsPath, "--level", levelName.ToUpperInvariant(),
            };
            if (bootExecutable is not null) effectsArgs.AddRange(["--executable", bootExecutable]);
            if (HasFlag(args, "--salvage-effects")) effectsArgs.Add("--salvage-dangling-references");
            _effects.Export(effectsArgs.ToArray());
        }

        // 4a2. World.json - the course's world-configuration record, which does NOT live in the level files:
        // it is per-course data in the executable ([Trailmap: 442-sky-color]), so it is read from the same ISO
        // and written beside the geometry as an ordinary map contract. Today that means the celestial glare
        // (the sun and the beams it fans across the view, [Trailmap: 400-rendering]). Optional by design: an
        // executable this build does not recognise leaves the map without a World.json, and every consumer
        // treats that as "no glare" rather than an error.
        if (_elf.TryReadWorldConfig(iso, levelName, out var world, out string worldError))
        {
            world.Write(outDir);
            _contracts.RequireFile(Path.Combine(outDir, WorldConfig.FileName), ContractKind.WorldV1);
            var g = world.Glare!;
            Log.Info(g.Enabled
                ? $"      World.json: celestial glare ON - sun az {g.AzimuthDegrees:0.###} / el {g.ElevationDegrees:0.###}, "
                  + $"fan [{string.Join(",", g.CoreColour)}] x{g.FanIntensity:0.###}, "
                  + $"sprite [{string.Join(",", g.RimColour)}] x{g.SpriteIntensity:0.###}."
                : "      World.json: this course authors no celestial glare.");
        }
        else Log.Warn($"      World.json skipped - {worldError}");

        // 4b. Re-export the terrain lightmaps correctly. The library's default lightmap export
        // brightens RGB and discards alpha, but the real luminance is in the alpha channel; this
        // overwrites Lightmaps/*.png with usable grayscale lightmaps. (See LightmapExporter.)
        LightmapExporter.Export(LightmapExporter.ResolveSshPath(loadPath), outDir);

        // 4c. Decode the shared crowd animation (DATA\TEXTURES\CROWD.SSH) into Textures/cd00..cdNN.png.
        // The 4x4_people spectators aren't in the level's own texture bank - the engine swaps in this
        // shared 16-frame anim at runtime - so we pull it from the ISO and let the importer flipbook it.
        _particles.ExtractCrowdFrames(iso, outDir);

        // 4d. Decode the shared particle sprite bank (DATA\TEXTURES\PARTICLE.SSH) into Textures/Particles/.
        // Like the crowd, the level's particle effects (ParticleInstances/ParticleModels.json: Fog_*, snow,
        // fireworks...) don't carry their own texture - the engine draws each as billboards using a sprite
        // from this shared bank, picked by effect TYPE not a stored index. fog0 is the start-line cloud sprite.
        _particles.ExtractParticleSprites(iso, outDir);

        // 5. Place the props into world space (Instances.json + Models.json), then bake the game's real
        // per-instance collision proxies (Collision/*.obj) into PropsCollision.obj. (Terrain is tessellated
        // directly from Patches.json by the bundle step, not to an OBJ here.)
        Log.Info();
        Log.Info("[5/8] Placing props into world space ...");
        // A fresh extract writes vanilla Meshes/Collision/Textures; re-install the prop remodel
        // packages (the `Overrides` sibling of the level folders) before baking so a re-extract
        // keeps custom props without any manual copying. --no-overrides extracts pure vanilla.
        if (!HasFlag(args, "--no-overrides")) PropOverrides.Apply(outDir, _contracts);
        PropsExporter.Export(outDir);
        PropsCollisionExporter.Export(outDir);
        // The course's video SCREENS, measured from the props just placed: which rectangle on each billboard a
        // video can be laid over. Engine-agnostic geometry, so it is settled once here and written as the
        // portable Billboards.json - Unity builds its overlay quads from it and Slopesmith shows and edits the
        // same rectangles, neither of them searching the mesh itself.
        BillboardsExporter.Export(outDir, _contracts);

        // 6. Merge the skybox backdrop into a single Skybox.obj (+Skybox.mtl). Unlike terrain/props, the skybox is
        // NOT in the bundle - the Unity importer's SkyboxBaker reads this OBJ + Skybox/Textures directly and bakes a
        // cubemap (the one system deliberately kept Unity-side), so `import` must emit it or an imported map has no sky.
        Log.Info();
        Log.Info("[6/8] Merging skybox backdrop ...");
        SkyboxExporter.Export(outDir, _contracts, allowNonRing: HasFlag(args, "--allow-nonring-sky"));

        // 7. Finish the decoded textures in place: un-premultiply the premultiplied-alpha sprites (crowd
        // cd*, some signs/LCD frames) so the top-level Textures/ is the ONE finished set every consumer -
        // Unity, Blender, `gltf` - reads as-is. Textures/Particles/ was already finished by
        // ExtractParticleSprites (each decode site finishes exactly the files it wrote, once).
        Log.Info();
        Log.Info("[7/8] Finishing textures (premultiplied-alpha fix) ...");
        int finished = TextureFinish.FinishDir(Path.Combine(outDir, "Textures"))
                     + TextureFinish.FinishDir(Path.Combine(outDir, "Skybox", "Textures"));
        Log.Info($"      un-premultiplied {finished} texture(s) in place.");

        // 8. Decode the level's audio. Music: DATA\AUDIO\<level>.BIG = the EA-XA layered stems
        // (A1..C8 + end) the game crossfades by intensity -> Audio/Music/*.wav. SFX: the
        // level's mapped banks inside the shared DATA\AUDIO\AUDIO.BIG (crowd/ambient/board) ->
        // Audio/SFX/<bank>/*.wav. Both non-fatal if the ISO lacks them.
        Log.Info();
        Log.Info("[8/8] Decoding level audio (music + SFX) ...");
        string? audioMembers = _audio.ExtractAudioBigMembers(iso, levelName, work);
        if (audioMembers != null) AudioExporter.ExportMusic(audioMembers, outDir);
        else Log.Warn($"      (no DATA\\AUDIO\\{levelName}.BIG in ISO - skipping music.)");
        _audio.ExportSfxBanks(iso, levelName, outDir, work);

        // Report what we produced.
        Log.Info();
        Log.Info("=== Output summary ===");
        ReportDir(outDir, "Meshes", "*.obj");
        ReportDir(outDir, "Textures", "*.png");
        ReportDir(outDir, "Lightmaps", "*.png");
        Log.Info($"  {"Props.obj",-16} {(File.Exists(Path.Combine(outDir, "Props.obj")) ? 1 : 0),5} (placed props, +Props.mtl)");
        Log.Info($"  {"PropsCollision.obj",-16} {(File.Exists(Path.Combine(outDir, "PropsCollision.obj")) ? 1 : 0),5} (real game collision proxies)");
        Log.Info($"  {"Skybox.obj",-16} {(File.Exists(Path.Combine(outDir, "Skybox.obj")) ? 1 : 0),5} (skybox backdrop, +Skybox.mtl)");
        ReportDir(outDir, "Audio/Music", "*.wav");
        ReportSfx(outDir);
        Log.Info($"Project folder: {outDir}");
        Log.Info($"(temp work dir left for inspection: {work})");
        return 0;
    }

    // Build the engine-neutral glTF export (glTF + lightmap atlas + manifest) from an extracted level folder.
    public int Gltf(string[] args)
    {
        if (args.Length < 2) { Log.Error("gltf needs <mapDir> [bundleName] [--no-overrides]"); return 1; }
        string levelDir = Path.GetFullPath(args[1]);
        string levelName = args.Length >= 3 && !args[2].StartsWith("--") ? args[2] : new DirectoryInfo(levelDir).Name;
        _contracts.RequireFile(Path.Combine(levelDir, "Patches.json"), ContractKind.PatchesV1);
        _contracts.RequireIfPresent(Path.Combine(levelDir, "Splines.json"), ContractKind.SplinesV1);
        _contracts.RequireIfPresent(Path.Combine(levelDir, "Audio", EnvironmentAudioDocument.FileName),
            ContractKind.EnvironmentAudioV1);
        // The bundlers' SSF effect view is sourced from Effects.json — the lossless stable-ID document that
        // `snowknife import` and Slopesmith exports both write. A bare authored export legitimately
        // has no Effects.json (no effects/sounds authored); an extracted folder without one is missing its
        // effects-export step — warn loudly instead of silently bundling a level with no SSF-driven features.
        string effectsPath = Path.Combine(levelDir, "Effects.json");
        if (File.Exists(effectsPath))
            _contracts.RequireFile(effectsPath, ContractKind.EffectsV1);
        else
            Log.Warn("  ! warning: no Effects.json in the level folder - SSF-driven features (movers/pads/" +
                              "triggers/emitters/breakables) will be empty. For an extracted level, re-run `snowknife import` " +
                              "(or `snowknife effects-export <level.ssf> <mapDir>\\Effects.json`) to produce it.");
        // Re-install the remodel packages so the bundle bakes against the current Textures/ (pages +
        // TextureAlpha.overrides) and the current Meshes/ for ANIMATED props (which the bundle reads
        // model-local). IMPORTANT: STATIC prop geometry + collision are bundled from the pre-baked
        // Props.obj / PropsCollision.obj, which only `import`/`props` regenerate from Meshes/Collision/.
        // So after editing a static prop's MESH or COLLISION you must run `props` BEFORE `gltf` - this
        // gltf-time Apply alone updates Meshes/ but not Props.obj, so static geometry stays stale.
        // Retail remodel packages target extracted model indices. A SlopeSmith export already owns a complete
        // canonical model table, so those index-addressed packages must not be overlaid onto it.
        if (!HasFlag(args, "--no-overrides") && SlopesmithExport.Load(levelDir) == null)
            PropOverrides.Apply(levelDir, _contracts);
        return Bundle.BundleExporter.Export(levelDir, levelName, _contracts);
    }

    public int GltfInfo(string[] args)
    {
        if (args.Length < 2) { Log.Error("gltf-info needs <file.glb>"); return 1; }
        return Bundle.BundleExporter.Info(Path.GetFullPath(args[1]));
    }

    // Step [3/3] of the pipeline (level -> gltf -> unity): copy the Unity-NEEDED subset of an extracted level folder
    // into an OpenSlope project (e.g. <project>/Assets/OpenSlope/Maps/<LEVEL>), leaving the rich Maps intermediate intact + diagnosable.
    // The importer loads only gltf/ (glTF + manifest), Textures/, Audio/, Sounds/, Skybox.obj(+.mtl)/Skybox/Textures, and
    // Instances.json + Effects.json; everything else in the level folder is gltf-INPUT (baked into the .glb/manifest, or a redundant
    // raw form) and is SKIPPED. Non-destructive - the source is untouched, so you can re-run `gltf` and re-copy without
    // re-extracting. The MC announcer + boards are NOT per-level: decode those once per project with `board`/`speech`
    // into Assets/OpenSlope/Maps/Shared. Run OpenSlope/Load after copying to build the scene.
    public int Unity(string[] args)
    {
        if (args.Length < 3) { Log.Error("unity needs <mapDir> <destDir> [--no-shared] [--public [--confirm-rights]]  (e.g. <project>/Assets/OpenSlope/Maps/<MAP>)"); return 1; }
        string src = Path.GetFullPath(args[1]);
        string dest = Path.GetFullPath(args[2]);
        bool publicTarget = HasFlag(args, "--public");
        bool confirmRights = HasFlag(args, "--confirm-rights");
        if (confirmRights && !publicTarget)
        { Log.Error("unity: --confirm-rights is valid only with --public"); return 1; }
        bool noShared = publicTarget || HasFlag(args, "--no-shared");
        string sharedDest = Path.Combine(Path.GetDirectoryName(dest) ?? dest, "Shared");
        if (!Directory.Exists(src)) { Log.Error($"unity: source level folder not found: {src}"); return 1; }
        _contracts.RequireFile(Path.Combine(src, "Patches.json"), ContractKind.PatchesV1);
        _contracts.RequireIfPresent(Path.Combine(src, "Effects.json"), ContractKind.EffectsV1);
        _contracts.RequireIfPresent(Path.Combine(src, "Audio", EnvironmentAudioDocument.FileName),
            ContractKind.EnvironmentAudioV1);
        _contracts.RequireIfPresent(Path.Combine(src, "gltf", "manifest.json"), ContractKind.BundleManifestV3);
        if (publicTarget)
        {
            if (Directory.Exists(dest) && Directory.EnumerateFileSystemEntries(dest).Any())
            { Log.Error("unity --public: REFUSED — destination must be absent or empty so stale local/retail files cannot survive."); return 1; }
            if (Directory.Exists(sharedDest) && Directory.EnumerateFileSystemEntries(sharedDest).Any())
            { Log.Error($"unity --public: REFUSED — populated Shared sibling is unclassified: {sharedDest}"); return 1; }
            string bundleManifest = Path.Combine(src, "gltf", "manifest.json");
            if (!File.Exists(bundleManifest))
            { Log.Error("unity --public: no gltf/manifest.json; run `snowknife gltf` first"); return 1; }
            var provenance = ContentProvenance.ReadBundle(bundleManifest);
            if (!ContentProvenance.CanStagePublic(provenance, confirmRights, out string decision))
            { Log.Error($"unity --public: REFUSED — {decision}."); return 1; }
            Log.Info($"unity --public: {decision}; retail-derived Shared assets will not be staged.");
        }
        if (!Directory.Exists(Path.Combine(src, "gltf")))
            Log.Warn("  ! warning: no gltf/ subfolder in the source - run `snowknife gltf` first, or the import will have no meshes.");

        Log.Info($"===== snowknife unity: {src} -> {dest} =====");
        long copied = CopyUnitySubset(src, dest, out int files, out int skipped);
        Log.Info($"  level: copied {files} files ({copied / (1024.0 * 1024.0):n1} MB); skipped {skipped} intermediate/.meta file(s).");

        // The map's shared DEPENDENCY: `snowknife shared` writes the level-independent assets (boards, announcer, board
        // FX + carve audio) as a `Shared` SIBLING of the level dir in Maps. We stage it alongside the level - into
        // the `Shared` sibling of dest (i.e. <project>/Assets/OpenSlope/Maps/Shared) - so OpenSlope/Load finds boards + announcer. This
        // is the ONLY Unity-aware step: `shared` itself just decodes neutral assets into Maps. Copy-ONCE: skip if
        // the project already has Shared, so staging a SECOND map doesn't recopy it. --no-shared opts out (level only).
        string sharedSrc  = Path.Combine(Path.GetDirectoryName(src)  ?? src,  "Shared");
        if (noShared)
            Log.Info(publicTarget
                ? "  shared: skipped (public target; the disc-derived shared asset pack is local-only)."
                : "  shared: skipped (--no-shared).");
        else if (!Directory.Exists(sharedSrc))
            Log.Info($"  shared: no `Shared` sibling in the source - run `snowknife shared <iso> {sharedSrc}` once if boards/announcer are needed.");
        else if (Directory.Exists(sharedDest))
            Log.Info($"  shared: {sharedDest} already present - left as-is (delete it to refresh).");
        else
        {
            long sc = CopyUnitySubset(sharedSrc, sharedDest, out int sf, out _);
            Log.Info($"  shared: copied {sf} files ({sc / (1024.0 * 1024.0):n1} MB) -> {sharedDest}");
        }

        Log.Info($"===== unity complete: {dest} =====");
        Log.Info("  Run OpenSlope/Load in the project to build the scene.");
        return 0;
    }

    public int Props(string[] args)
    {
        if (args.Length < 2) { Log.Error("props needs <mapDir> [--no-overrides]"); return 1; }
        string levelDir = Path.GetFullPath(args[1]);
        if (!HasFlag(args, "--no-overrides")) PropOverrides.Apply(levelDir, _contracts);
        int r = PropsExporter.Export(levelDir);
        PropsCollisionExporter.Export(levelDir);   // also bake the real collision proxies
        BillboardsExporter.Export(levelDir, _contracts);   // the screens are measured off the props just rebaked
        return r;
    }

    // Re-run the billboard screen detection on its own - after editing a board's mesh, or to bring a map
    // extracted before this contract existed up to date. Reads Props.obj + Instances.json (+ the course lines
    // for which face the riders see) and writes Billboards.json.
    public int Billboards(string[] args)
    {
        if (args.Length < 2) { Log.Error("billboards needs <mapDir> [--force]"); return 1; }
        string levelDir = Path.GetFullPath(args[1]);
        if (!Directory.Exists(levelDir)) { Log.Error($"billboards: {levelDir} is not a map folder."); return 1; }
        return BillboardsExporter.Export(levelDir, _contracts, HasFlag(args, "--force"));
    }

    // Install the name-matched prop remodel packages (the `Overrides` sibling of the level folders)
    // into the level's Meshes/Collision/Textures. `import`/`props`/`gltf` already run this; the
    // standalone command exists for --dry previews and for re-installing without a rebake.
    public int Overrides(string[] args)
    {
        if (args.Length < 2) { Log.Error("overrides needs <mapDir> [--dry]"); return 1; }
        string levelDir = Path.GetFullPath(args[1]);
        int n = PropOverrides.Apply(levelDir, _contracts, dry: HasFlag(args, "--dry"));
        if (n == 0) Log.Info("No override packages applied (no Overrides sibling, or nothing matched).");
        return 0;
    }

    // Merge the level's skybox backdrop (Skybox/Models.json + Meshes) into a single Skybox.obj (+Skybox.mtl). The
    // skybox is the one system that stays Unity-side rather than going into the bundle: the importer's SkyboxBaker
    // reads Skybox.obj + Skybox/Textures and bakes a cubemap. So `import` must emit this OBJ for every level - without
    // it a freshly-imported map has no sky. Re-run standalone to regenerate just the skybox.
    public int Skybox(string[] args)
    {
        if (args.Length < 2) { Log.Error("skybox needs <mapDir>"); return 1; }
        string levelDir = Path.GetFullPath(args[1]);
        return SkyboxExporter.Export(levelDir, _contracts);
    }

    public int Lightmaps(string[] args)
    {
        if (args.Length < 3) { Log.Error("lightmaps needs <_L.ssh> <mapDir>"); return 1; }
        string sshPath = Path.GetFullPath(args[1]);
        string levelDir = Path.GetFullPath(args[2]);
        Directory.CreateDirectory(levelDir);
        return LightmapExporter.Export(sshPath, levelDir) > 0 ? 0 : 1;
    }

    // The extraction intermediates `gltf` consumes as INPUT but the importer never reads: each was either baked into
    // the .glb/manifest (Models/Materials/Flip/Scroll/particles/SSF/paths) or is a redundant raw form
    // (Meshes/Collision/Lightmaps, the Props*/PropsCollision OBJs). `unity` SKIPS these (and every .meta) when copying,
    // so a Unity map stays lean and the editor never imports hundreds of stray OBJs. Verified against every importer
    // file read: KEPT = gltf/, Textures/, Audio/, Sounds/, Skybox.obj(+.mtl)/Skybox/Textures, Instances.json, Patches.json
    // (Patches.json is BOTH a gltf input AND read by the analytic-contact baker, so it ships - see the skip list).
    private static readonly string[] UnitySkipFiles =
    {
        "Props.obj", "Props.mtl", "PropsCollision.obj", "ConfigTricky.ssx",
        "AIP.json", "SOP.json", "Splines.json", "Cameras.json", "Flip.json", "Scroll.json",
        "Lights.json", "Materials.json", "Models.json", "ParticleInstances.json", "ParticleModels.json",
        "SSFLogic.json",
        // The screens ride in the bundle manifest (Billboards section), which is what the importer reads; the
        // source document is a gltf INPUT like the rest of this list.
        "Billboards.json",
        // NOTE: Patches.json is intentionally NOT skipped - it's tessellated into terrain.glb for RENDER/collision,
        // but the importer ALSO reads it at import to bake the analytic bicubic CONTACT surface the board rides
        // (TerrainPatchBuilder -> TerrainPatches, Unity docs/021). So it ships to the project as a real importer input.
        // Skybox sub-intermediates: the baker reads only the MERGED Skybox.obj + Skybox/Textures/, so the raw
        // component meshes + their source JSON are dead weight (and stray OBJs Unity would import).
        "Skybox/Models.json", "Skybox/Materials.json",
    };
    // gltf/ ships no texture copies: the .glb carries no images/URIs - each material is merely NAMED after its
    // texture file ("0057.png", empty pbr) - and every consumer resolves the PNGs from the level's finished
    // top-level Textures/ (Unity via MaterialFactory, Blender via ../Textures from the .glb). The "gltf/Textures"
    // entry guards a workspace whose gltf/ predates that layout from copying its texture duplicate into a project.
    private static readonly string[] UnitySkipDirs = { "Meshes", "Collision", "Lightmaps", "Skybox/Meshes", "gltf/Textures" };

    // Recursively copy src -> dest, skipping the intermediates above + any Unity .meta sidecar. Relative paths are
    // compared '/'-normalised. Returns bytes copied; reports copied + skipped file counts via out params.
    private static long CopyUnitySubset(string src, string dest, out int filesCopied, out int filesSkipped)
    {
        var skipDirs = new HashSet<string>(UnitySkipDirs.Select(NormRel), StringComparer.OrdinalIgnoreCase);
        var skipFiles = new HashSet<string>(UnitySkipFiles.Select(NormRel), StringComparer.OrdinalIgnoreCase);
        long copied = 0; filesCopied = 0; filesSkipped = 0;
        foreach (string file in Directory.EnumerateFiles(src, "*", SearchOption.AllDirectories))
        {
            string rel = NormRel(Path.GetRelativePath(src, file));
            if (rel.EndsWith(".meta", StringComparison.OrdinalIgnoreCase) || skipFiles.Contains(rel) || UnderSkipDir(rel, skipDirs))
            {
                filesSkipped++;
                continue;
            }
            string target = Path.Combine(dest, rel.Replace('/', Path.DirectorySeparatorChar));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite: true);
            copied += new FileInfo(file).Length;
            filesCopied++;
        }
        return copied;
    }

    private static string NormRel(string p) => p.Replace('\\', '/').Trim('/');

    // True if any ANCESTOR directory of rel is a skip dir (so "Skybox/Meshes/x.obj" is caught by "Skybox/Meshes").
    private static bool UnderSkipDir(string rel, HashSet<string> skipDirs)
    {
        int slash = rel.LastIndexOf('/');
        while (slash >= 0)
        {
            string prefix = rel.Substring(0, slash);
            if (skipDirs.Contains(prefix)) return true;
            slash = prefix.LastIndexOf('/');
        }
        return false;
    }

    // Drop a previous extract's mesh exports so this run's are the only ones in the folder. Only *.obj:
    // PropOverrides' *.orig_bak backups and any authored sidecars stay put.
    private static void ClearObjFiles(string dir)
    {
        if (!Directory.Exists(dir)) return;
        string[] objs = Directory.GetFiles(dir, "*.obj");
        foreach (string f in objs) File.Delete(f);
        if (objs.Length > 0)
            Log.Info($"(cleared {objs.Length} .obj from the previous extract in {Path.GetFileName(dir)}/.)");
    }

    private static void ReportDir(string root, string sub, string pattern)
    {
        string p = Path.Combine(root, sub.Replace('/', Path.DirectorySeparatorChar));
        int count = Directory.Exists(p) ? Directory.GetFiles(p, pattern).Length : 0;
        Log.Info($"  {sub,-16} {count,5} {pattern}");
    }

    // SFX is nested (Audio/SFX/<bank>/NNN.wav), so report banks + total wavs rather than a flat count.
    private static void ReportSfx(string root)
    {
        string p = Path.Combine(root, "Audio", "SFX");
        int banks = Directory.Exists(p) ? Directory.GetDirectories(p).Length : 0;
        int wavs = Directory.Exists(p) ? Directory.GetFiles(p, "*.wav", SearchOption.AllDirectories).Length : 0;
        Log.Info($"  {"Audio/SFX",-16} {banks,5} bank(s), {wavs} wav(s)");
    }

    private static bool HasFlag(string[] args, string flag) =>
        args.Any(a => a.Equals(flag, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Some third-party courses contain valid PBD records but omit their display-name rows from the text MAP
    /// linker. The legacy extractor pairs those lists by index, so the missing optional names otherwise make
    /// terrain extraction fail. Repair only the unpacked temporary MAP used by this import; the ISO and source
    /// mod remain untouched and every native record is preserved.
    /// </summary>
    private static void RepairMissingMapLinks(string loadPath)
    {
        var map = new MapHandler();
        map.Load(loadPath + ".map");
        var pbd = new PBDHandler();
        pbd.LoadPBD(loadPath + ".pbd");

        int repaired = 0;
        repaired += Fill(map.Patchs, pbd.Patches.Count, "Patch");
        repaired += Fill(map.InternalInstances, pbd.Instances.Count, "Instance");
        repaired += Fill(map.ParticleInstances, pbd.particleInstances.Count, "ParticleInstance");
        repaired += Fill(map.Materials, pbd.materials.Count, "Material");
        repaired += Fill(map.Lights, pbd.lights.Count, "Light");
        repaired += Fill(map.Splines, pbd.splines.Count, "Spline");
        repaired += Fill(map.Models, pbd.modelData.Count, "Model");
        repaired += Fill(map.particelModels, pbd.particleModels.Count, "ParticleModel");
        repaired += Fill(map.Cameras, pbd.Cameras.Count, "Camera");
        if (repaired == 0) return;

        map.Save(loadPath + ".map");
        Log.Warn($"      WARNING: synthesized {repaired} missing native name link(s) in the temporary MAP " +
                          "(--repair-missing-map-links).");

        static int Fill(List<LinkerItem> links, int required, string kind)
        {
            int firstMissing = links.Count;
            if (firstMissing >= required) return 0;
            for (int i = firstMissing; i < required; i++)
            {
                string name = $"Unlinked{kind}_{i:D4}";
                links.Add(new LinkerItem
                {
                    Name = name,
                    UID = i,
                    Ref = 1,
                    Hashvalue = MapHandler.GenerateHash(name),
                });
            }
            return required - firstMissing;
        }
    }
}
