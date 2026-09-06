using System.Text.Json;

namespace Snowknife.Bundle;

/// <summary>
/// Bakes the MATERIAL RESOLUTION the Unity importer's MaterialFactory consumes. Turns each glb prim's
/// material-slot name - terrain slots are the texture file ("0012.png"); prop slots are the OBJ MaterialID
/// ("mat_10"), a scroll variant ("mat_108_scr0"), an authored object-part alias ("mat_10_obj2"), or the
/// shared crowd slot ("mat_crowd") - into the
/// engine-agnostic facts a consumer needs to build a material: the frame-0 texture, the per-material alpha
/// mode, the ordered flipbook frames + fps, and the complete UV-scroll motion profile. Reads the source tables
/// (Materials.json / Scroll.json / Flip.json and the crowd cd*.png frames), then emits the records as the
/// manifest "Materials" section.
///
/// This makes the bundle SELF-DESCRIBING: Blender reads texture props straight off the manifest instead of
/// scraping the OBJ .mtl, and the Unity importer's MaterialFactory just looks up a slot name and turns it
/// into a material asset, with no JSON table-loading of its own. See Unity docs/unity/005 (materials/alpha) and
/// Unity docs/008 (texture animation).
/// </summary>
public static class MaterialBundle
{
    public sealed class Opts
    {
        // Same calibration defaults as ImportConfig - snowknife owns them; the importer just consumes the resolved records.
        public float FlipSpeedScale = 1f;    // Flip.json Speed -> fps. The engine advances Speed/60 of a frame per
                                             // tick and the texture-animation list ticks at 60 Hz, so on-screen fps
                                             // = Speed exactly. The tick was MEASURED off a megaplex button: its red
                                             // segment ends at the flip's first advance (tick 18 at Speed 3.5) and
                                             // that segment is 0.3 s, which is 18/60 - a 30 Hz list would give 0.6 s.
        // The MaterialIDs a TRIGGERED flip pulses (TriggeredFlipClassifier): their frame list is a state pair the
        // ride-over buttons switch, not an animation, so they must never free-run.
        public HashSet<int> PulsedMaterials = new();
        public float ScrollSpeedScale = 60f; // SSX per-tick UV-scroll -> units/sec: the scroll tick is the
                                             // 60 Hz sim rate (retail vs 30/s preview side-by-side showed 2x)
        // U4 pause/dwell screens (LCD): the texture-flip behavior holds frame A for a
        // per-cycle RANDOM (Speed/60)*uniform[0.25,1.0) re-arm - dwell = (1/Speed)/u sec, 1..4s at Speed 1 -
        // then flashes frame B for a hardcoded 1/6-per-tick re-arm = 6 ticks = 0.1s. Emitted as the manifest
        // "Dwell" law [dwellBase, flash] for the runtime to roll per cycle (dwellBase = 1/Speed). Both durations
        // are ticks/60 on the measured 60 Hz list (see FlipSpeedScale).
        public float U4FlashSeconds = 0.1f;
    }

    public static List<BundleManifest.MaterialInfo> Build(
        string levelDir, IEnumerable<string> slots,
        IReadOnlyList<BundleManifest.TextureInfo> textures, Opts o)
    {
        var alpha = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var t in textures) alpha[t.File] = t.Alpha;

        var mats = LoadMaterials(Path.Combine(levelDir, "Materials.json"));
        var scroll = LoadScroll(Path.Combine(levelDir, "Scroll.json"));
        var flip = LoadFlip(Path.Combine(levelDir, "Flip.json"));
        var crowd = LoadCrowdFrames(Path.Combine(levelDir, "Textures"));

        var outList = new List<BundleManifest.MaterialInfo>();
        foreach (var slot in slots.Distinct(StringComparer.Ordinal).OrderBy(s => s, StringComparer.Ordinal))
        {
            bool isTerrain = slot.EndsWith(".png", StringComparison.OrdinalIgnoreCase);
            Resolve(slot, isTerrain, mats, flip, crowd, o,
                    out string? tex, out List<string>? frames, out int scrollIdx, out float flipFps, out float[]? dwell,
                    out bool isCrowd, out bool isPulsed);

            float[]? scr = null, scrollCycle = null;
            if (scrollIdx >= 0 && scrollIdx < scroll.Count)
            {
                var sp = scroll[scrollIdx];
                // V negated: SSX's texture-V runs opposite to a top-left-origin consumer, so a raw +V scroll
                // flows the wrong way (river segments run backwards). Mirrors MaterialFactory.Build.
                scr = new[] { sp.U * o.ScrollSpeedScale, -sp.V * o.ScrollSpeedScale };
                scrollCycle = new[] { (float)sp.Mode, sp.ActiveDuration, sp.PauseDuration, sp.Lifetime };
            }

            // A FRAME LIST IS NOT AN ANIMATION. Three consumers share one list shape and only the EFFECT tells
            // them apart, so the frames alone never start playback:
            //   - free-running flipbook - a persistent Sub11 TextureFlip (Length 0), the only thing Flip.json
            //     records. Cycles at the authored rate. The signs, the LCD screens.
            //   - triggered pulse - a Length>0 one-shot fired at a target instance (isPulsed): a crossing shows
            //     another frame briefly and the surface settles back here, so the material's own frame is the
            //     resting state and playback stays off. The ride-over buttons.
            //   - state list with no effect at all - the glass panes' intact/cracked, the start-light countdown,
            //     the broken-LCD twins. Nothing animates these; they render frame 0 and wait on game logic.
            // The crowd keeps its frame list too (the shader's texture-array source) but plays on the per-cell
            // CrowdBox schedule, so its FlipFps is 0 as well.
            //
            // Every one of those non-animated cases renders the material's OWN texture, which the level loader
            // sets to flipbook frame 0 [Trailmap: 410-texture-animation] - the same frame
            // Materials.json already names. Texture is therefore correct as read, and only the rate is decided here.
            bool hasFrames = frames != null && frames.Count >= 2;
            bool isFlip = hasFrames && !isCrowd && !isPulsed && flipFps > 0f;
            outList.Add(new BundleManifest.MaterialInfo
            {
                Name = slot,
                Texture = tex,
                Alpha = MaterialAlpha(tex, frames, alpha, allowBlend: !isTerrain),
                Flipbook = hasFrames ? frames : null,
                FlipFps = isFlip ? flipFps : 0f,
                Dwell = isFlip ? dwell : null,
                Scroll = scr,
                ScrollCycle = scrollCycle,
                Crowd = isCrowd ? true : null,
            });
        }
        return outList;
    }

    /// <summary>
    /// The texture file each slot renders at rest, for a consumer that needs only the page identity rather
    /// than a whole material record — the billboard detector, whose ad gate keys on "which SSX page is this
    /// face drawing". Same slot-name rules as the manifest build, so the two can never drift apart.
    /// </summary>
    public static Dictionary<string, string?> SlotTextures(string levelDir, IEnumerable<string> slots)
    {
        var mats = LoadMaterials(Path.Combine(levelDir, "Materials.json"));
        var flip = LoadFlip(Path.Combine(levelDir, "Flip.json"));
        var crowd = LoadCrowdFrames(Path.Combine(levelDir, "Textures"));
        var o = new Opts();
        var textures = new Dictionary<string, string?>(StringComparer.Ordinal);
        foreach (string slot in slots)
        {
            if (textures.ContainsKey(slot)) continue;
            Resolve(slot, slot.EndsWith(".png", StringComparison.OrdinalIgnoreCase), mats, flip, crowd, o,
                    out string? tex, out _, out _, out _, out _, out _, out _);
            textures[slot] = tex;
        }
        return textures;
    }

    // Mirror of MaterialFactory.Resolve. Terrain slot == texture file; prop slot == MaterialID, crowd, or
    // scroll variant. (areIds is implicit: a prop slot never ends in ".png", a terrain slot always does.)
    static void Resolve(string slotName, bool isTerrain, List<SsxMat> mats, Dictionary<int, (float speed, int u4)> flip,
                        List<string> crowd, Opts o,
                        out string? tex, out List<string>? frames, out int scrollIdx, out float flipFps, out float[]? dwell,
                        out bool isCrowd, out bool isPulsed)
    {
        tex = null; frames = null; scrollIdx = -1; flipFps = 0f; dwell = null; isCrowd = false; isPulsed = false;

        if (isTerrain) { tex = slotName; return; }   // terrain: the slot name IS the texture file

        string s = slotName.StartsWith("mat_", StringComparison.Ordinal) ? slotName.Substring(4) : slotName;

        // Slopesmith appends "_obj<k>" after the optional scroll tag. It keeps animated parts distinct
        // for the disc packer, but every alias still resolves through the same Materials.json slot.
        // Strip it first so "9_scr2_obj4" can still expose scroll index 2 below.
        s = AuthoredMaterialPolicy.StripObjectSuffix(s);
        if (s == "untextured") return;

        // Crowd billboards: the shared CrowdBox slot. Frames = the cd00..cd15 bank (CROWD.SSH); the
        // consumer stacks them into a texture array and the shader plays each cell's own schedule.
        if (s == "crowd")
        {
            isCrowd = true;
            if (crowd.Count >= 2) { frames = crowd; tex = crowd[0]; }
            else if (crowd.Count == 1) tex = crowd[0];
            return;
        }

        // Scroll-variant tag "<id>_scr<k>" (props only): strip it off, remember the speed index.
        int sp = s.IndexOf("_scr", StringComparison.Ordinal);
        if (sp >= 0)
        {
            if (int.TryParse(s.AsSpan(sp + 4), out int k)) scrollIdx = k;
            s = s.Substring(0, sp);
        }

        if (int.TryParse(s, out int id) && id >= 0 && id < mats.Count)
        {
            var m = mats[id];
            tex = string.IsNullOrEmpty(m.TexturePath) ? null : m.TexturePath;
            frames = (m.TextureFlipbook != null && m.TextureFlipbook.Count >= 2) ? m.TextureFlipbook : null;
            isPulsed = o.PulsedMaterials.Contains(id);
            if (flip.TryGetValue(id, out var fe))
            {
                flipFps = fe.speed * o.FlipSpeedScale;
                // The TextureFlip "pause/dwell" flag (U4 != 0) on a 2-frame screen (the LCD jumbotrons): the engine
                // holds frame A a long, per-cycle-randomized time, then briefly flashes frame B and returns (see the
                // Opts comment for the specified re-arm math). Emit the law - [dwellBase = 1/Speed, flash] - and the
                // runtime animator rolls the random hold each cycle; frames stay [A,B]. Screens that instead bake the
                // dwell into repeated frames have >2 entries and keep the uniform Speed fps rate.
                if (fe.u4 != 0 && frames != null && frames.Count == 2 && fe.speed > 0f)
                    dwell = new[] { 1f / fe.speed, o.U4FlashSeconds };
            }
        }
    }

    // Per-material alpha: cutout if the texture or ANY flipbook frame is cutout (cutout wins); else glow if
    // any is glow (a light-halo sheet; TextureBundle.IsGlowSheet); else blend if any is blend; else opaque.
    // Terrain never blends (its render path only honours cutout). Mirrors MaterialFactory.Build / BuildTerrain.
    static string MaterialAlpha(string? tex, List<string>? frames, Dictionary<string, string> alpha, bool allowBlend)
    {
        bool cut = false, bln = false, glw = false;
        void Take(string? f)
        {
            if (f != null && alpha.TryGetValue(f, out var a)) { if (a == "cutout") cut = true; else if (a == "blend") bln = true; else if (a == "glow") glw = true; }
        }
        Take(tex);
        if (frames != null) foreach (var f in frames) Take(f);
        return cut ? "cutout" : (glw && allowBlend) ? "glow" : (bln && allowBlend) ? "blend" : "opaque";
    }

    // ---- source-table loaders (System.Text.Json; tolerant of missing files / extra fields) ----
    static readonly JsonSerializerOptions Js = new() { PropertyNameCaseInsensitive = true };

    static List<SsxMat> LoadMaterials(string path)
    {
        if (!File.Exists(path)) return new List<SsxMat>();
        var parsed = JsonSerializer.Deserialize<SsxMatList>(File.ReadAllText(path), Js);
        return parsed?.Materials ?? new List<SsxMat>();
    }

    static List<SsxScroll> LoadScroll(string path)
    {
        if (!File.Exists(path)) return new List<SsxScroll>();
        var parsed = JsonSerializer.Deserialize<SsxScrollList>(File.ReadAllText(path), Js);
        return parsed?.Speeds ?? new List<SsxScroll>();
    }

    static Dictionary<int, (float speed, int u4)> LoadFlip(string path)
    {
        var outv = new Dictionary<int, (float speed, int u4)>();
        if (!File.Exists(path)) return outv;
        var parsed = JsonSerializer.Deserialize<SsxFlipList>(File.ReadAllText(path), Js);
        if (parsed?.Materials != null) foreach (var m in parsed.Materials) outv[m.Id] = (m.Speed, m.U4);
        return outv;
    }

    // The shared crowd animation frames (cd00.png, cd01.png, ...) from Textures/, in play order.
    static List<string> LoadCrowdFrames(string texDir)
    {
        var outv = new List<string>();
        if (!Directory.Exists(texDir)) return outv;
        var files = Directory.GetFiles(texDir, "cd*.png");
        Array.Sort(files, StringComparer.Ordinal);
        foreach (var f in files) outv.Add(Path.GetFileName(f));
        return outv;
    }

    // ---- DTOs ----
    sealed class SsxMatList { public List<SsxMat>? Materials { get; set; } }
    sealed class SsxMat { public string? TexturePath { get; set; } public List<string>? TextureFlipbook { get; set; } }
    sealed class SsxScrollList { public List<SsxScroll>? Speeds { get; set; } }
    sealed class SsxScroll
    {
        public float U { get; set; }
        public float V { get; set; }
        public int Mode { get; set; }
        public float ActiveDuration { get; set; }
        public float PauseDuration { get; set; }
        public float Lifetime { get; set; }
    }
    sealed class SsxFlipList { public List<SsxFlip>? Materials { get; set; } }
    sealed class SsxFlip { public int Id { get; set; } public float Speed { get; set; } public int U4 { get; set; } }
}
