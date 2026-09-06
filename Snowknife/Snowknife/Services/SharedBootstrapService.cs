namespace Snowknife.Services;

/// <summary>
/// The one-shot per-project `shared` bootstrap: decode the level-INDEPENDENT assets the runtime needs (snowboard
/// decks + rider skins, MC announcer voice banks, board FX sprites, shared carve/crowd/wind SFX) into a neutral
/// Maps\Shared folder that `unity` later stages alongside each map. Pure orchestration over the model, audio,
/// and particle services.
/// </summary>
internal sealed class SharedBootstrapService
{
    private readonly ModelService _models;
    private readonly AudioService _audio;
    private readonly ParticleService _particles;

    public SharedBootstrapService(ModelService models, AudioService audio, ParticleService particles)
    {
        _models = models;
        _audio = audio;
        _particles = particles;
    }

    // The MC announcer banks the OpenSlope runtime actually plays (RaceAudioSetup.LoadBank); `shared` keeps only these
    // from the ~49 SPEECH.BIG mc banks so the world isn't bloated by ~500MB of unused commentary/menu voice.
    private static readonly string[] AnnouncerSpeechBanks =
        { "Go", "Big_Air", "Land", "Knockdown", "Slow", "Boost_Icon", "Sweet" };

    // One-shot PROJECT bootstrap (run once per project, not per map): decode the level-INDEPENDENT shared assets the
    // runtime needs into <dest> (e.g. <project>/Assets/OpenSlope/Maps/Shared). These are identical for every level - the snowboard
    // decks + rider skins, the MC announcer voice banks, the board's FX sprites (snow 'clod' / spark 'str3' from the
    // shared PARTICLE.SSH) and its carve/grind audio (the shared zboard bank) - so they live ONCE alongside the per-map
    // SSX/<LEVEL> folders instead of being duplicated into each. A map's OpenSlope/Load then finds boards + announcer here.
    public int Shared(string[] args)
    {
        if (args.Length < 3) { Log.Error("shared needs <iso> <destDir>  (e.g. <project>/Assets/OpenSlope/Maps/Shared)"); return 1; }
        string iso = args[1];
        string dest = Path.GetFullPath(args[2]);
        Log.Info($"===== snowknife shared: level-independent assets -> {dest} =====");

        Log.Info();
        Log.Info("########## [shared 1/4] Snowboard decks + rider skins ##########");
        int rc = _models.Board(new[] { "board", iso, Path.Combine(dest, "chars") });
        if (rc != 0) { Log.Error("shared: board export failed."); return rc; }

        Log.Info();
        Log.Info("########## [shared 2/4] MC announcer voice banks ##########");
        // The in-race announcer's per-event banks land at <dest>/speech/mc/<bank>/ (ExportSpeechDat names each folder
        // after its .dat; RaceAudioSetup reads Assets/OpenSlope/Maps/Shared/speech/mc). Then PRUNE to the banks the runtime
        // actually plays (AnnouncerSpeechBanks) - the rest is unused commentary that bloats the world. Non-fatal: a
        // region disc without SPEECH.BIG just leaves the announcer silent.
        try
        {
            string mc = Path.Combine(dest, "speech", "mc");
            _audio.Speech(new[] { "speech", iso, mc });
            if (Directory.Exists(mc))
            {
                var keep = new HashSet<string>(AnnouncerSpeechBanks, StringComparer.OrdinalIgnoreCase);
                int kept = 0, pruned = 0;
                foreach (string d in Directory.GetDirectories(mc))
                    if (keep.Contains(Path.GetFileName(d))) kept++;
                    else { Directory.Delete(d, recursive: true); pruned++; }
                Log.Info($"      announcer: kept {kept} used bank(s), pruned {pruned} unused.");
            }
        }
        catch (Exception ex) { Log.Warn($"      (announcer skipped: {ex.Message})"); }

        Log.Info();
        Log.Info("########## [shared 3/4] Board FX sprites (PARTICLE.SSH) ##########");
        // clod (snow burst) + str3 (grind spark) + the rest of the shared sprite bank -> <dest>/Textures/Particles/.
        _particles.ExtractParticleSprites(iso, dest);

        Log.Info();
        Log.Info("########## [shared 4/4] Shared SFX banks + board routing ##########");
        // ONLY the shared/reference banks (zboard/Crowd/Wind1/Wind2/zbxsfx/tricky) - NOT a course BANK, which stays in
        // SSX/<LEVEL>/Audio. The board reads <dest>/Audio/SFX/zboard/*.wav for its glide/carve loops.
        string work = Path.Combine(Path.GetTempPath(), "snowknife_sharedsfx_" + Guid.NewGuid().ToString("N"));
        int banks = _audio.ExportSharedSfxBanksOnly(iso, dest, work);
        Log.Info($"  Shared SFX: {banks} bank(s) -> {Path.Combine(dest, "Audio", "SFX")}");
        _audio.ExportBoardSoundIndex(iso, dest);

        Log.Info();
        Log.Info($"===== shared complete: {dest} =====");
        Log.Info("Neutral intermediate; `snowknife unity` copies this into <project>/Assets/OpenSlope/Maps/Shared alongside the level (once per project; level-independent).");
        return 0;
    }
}
