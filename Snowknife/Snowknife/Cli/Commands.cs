using Snowknife.Repack;
using Snowknife.Services;

namespace Snowknife.Cli;

/// <summary>
/// The command table: the service graph, and what every subcommand is for.
///
/// This is the compose root - leaf services first, then the services that build on them - and the single
/// place a command is declared. A row carries its handler, its arguments and its help together, so
/// `snowknife` can only dispatch what it can also explain.
///
/// Groups are the index's chapters, ordered the way an author meets them: import a course, re-run a stage,
/// then the audio, disc and byte-level work underneath.
/// </summary>
internal static class Commands
{
    /// <summary>The course slots on the disc, for the arguments that name one.</summary>
    private const string Slots = "GARI, MESA, ELYSIUM, SNOW, ALASKA, ALOHA, MEGAPLE, MERQUER, PIPE, UNTRACK or TRICK";

    /// <summary>Every executable patch shares one restore file; each says so on its own page.</summary>
    private const string Restore = """
        Applying any executable patch writes <iso>.snowknife-restore.json beside the image,
        holding the bytes it replaced. The descriptors in Patches/ carry no retail bytes - only a digest of
        what they expect to find - so every write verifies before it happens.
        """;

    public static CliGroup[] Build()
    {
        var iso       = new IsoService();
        var big       = new BigArchiveService();
        var refpack   = new RefpackService();
        var ssh       = new SshTextureService();
        var particles = new ParticleService(iso);
        var elf       = new ElfPatchService(iso);
        var audio     = new AudioService(iso);
        var models    = new ModelService(iso);
        var contracts = new ContractValidationService();
        var repack    = new RepackService(iso, big, refpack, ssh, elf, contracts);
        var ssf       = new SsfResearchService(iso, big, refpack);
        var effects   = new EffectsDocumentService(contracts);
        var level     = new LevelPipelineService(iso, audio, particles, effects, contracts, elf);
        var shared    = new SharedBootstrapService(models, audio, particles);

        return
        [
            new CliGroup("A course, end to end",
            [
                new CliCommand("import",
                    "[1/3] Import a Tricky course into the diagnosable Maps intermediate",
                    """
                    Writes Blender-ready OBJ/JSON/PNG, the finished Textures/, Lightmaps/, the intro music
                    and SFX, and the portable Effects.json that Slopesmith, Unity and SSF repackaging all
                    share.

                    It also removes a previous run's gltf/ - that bundle was built from the raw layer this
                    run replaces - so run `gltf` after it. The temp work dir is left under %TEMP%/snowknife_*
                    for inspection; the raw _L.ssh lives there.
                    """,
                    level.Import)
                {
                    Params =
                    [
                        new("<iso>", "Your own SSX Tricky disc image. Read only - nothing is written back to it."),
                        new("<courseSlot>", $"The course slot to import, as the disc names it: {Slots}."),
                        new("<mapDir>", "Where to write the intermediate, e.g. Maps\\<NAME>. Created if it is not there."),
                    ],
                    Flags =
                    [
                        new("--no-overrides", "Leave the prop remodel packages out of this import (see `overrides`)."),
                        new("--no-effects", "Import terrain and props without Effects.json when a third-party SSF is invalid."),
                        new("--salvage-effects", "Keep valid effects while replacing dangling third-party node targets with native nulls."),
                        new("--repair-missing-map-links", "Preserve third-party native records whose optional MAP name rows are missing."),
                        new("--allow-nonring-sky", "Keep custom sky geometry even when it cannot produce editable retail-ring metadata."),
                    ],
                },

                new CliCommand("world",
                    "Refresh a map's World.json from the disc",
                    """
                    The course's world-configuration record does not live in its level files - it is
                    per-course data in the executable - so `import` reads it from the same ISO and writes it
                    beside the geometry as World.json. This runs that one step on its own, for a map folder
                    extracted before the contract existed.

                    Today the record carries the CELESTIAL GLARE: whether the course has a sun, the separate
                    colour and intensity of its beam fan and soft corona sprite, and the sun's own azimuth,
                    elevation, distance and size. Nine of the thirteen slots author no glare at all, and
                    that is written out too, so a consumer never has to guess.

                    See [Trailmap: 400-rendering] (celestial glare) and [Trailmap: 442-sky-color].
                    """,
                    level.World)
                {
                    Params =
                    [
                        new("<iso>", "Your own SSX Tricky disc image. Read only."),
                        new("<courseSlot>", $"The course slot the map came from: {Slots}."),
                        new("<mapDir>", @"An existing map folder, e.g. Maps\<NAME>."),
                    ],
                },

                new CliCommand("gltf",
                    "[2/3] Build the engine-neutral glTF bundle",
                    """
                    Writes <mapDir>/gltf: the terrain, prop and collision meshes, the lightmap atlas and
                    manifest.json. Blender opens the .glb as-is; `unity` stages the same folder into a
                    project. SSF-driven features - movers, boost pads, triggers, emitters - are bundled from
                    the stable-ID Effects.json, and a folder without one is bundled with none of them, loudly.

                    SlopeSmith exports the same Instances.json, Models.json, Meshes/ and Collision/
                    representation as `import`; this command consumes that canonical folder directly.

                    On a retail extract, static prop geometry and collision come from the pre-baked Props.obj,
                    so run `props` first after editing a static prop mesh or collision.
                    """,
                    level.Gltf)
                {
                    Params =
                    [
                        new("<mapDir>", "A folder `import` wrote, or a Slopesmith export. The bundle lands in <mapDir>/gltf."),
                        new("[bundleName]", "Names the bundle. Defaults to the folder's own name."),
                    ],
                    Flags = [new("--no-overrides", "Bundle what is on disk, without re-installing the remodel packages.")],
                },

                new CliCommand("unity",
                    "[3/3] Stage the Unity-needed files into an OpenSlope project",
                    """
                    Copies the importer's subset - gltf/, Textures/, Audio/, the skybox, Instances.json,
                    Effects.json - and skips the gltf-input intermediates and every .meta, so the project
                    stays lean. The source is untouched, so you can re-run `gltf` and re-copy without
                    re-extracting. Then run OpenSlope/Load in the project. Use --public for a project intended for
                    upload or distribution: it fails closed on retail-derived/unknown content, requires a
                    fresh/empty destination with no populated Shared sibling, and omits the disc-derived Shared
                    asset pack. User-supplied assets additionally require --confirm-rights.
                    """,
                    level.Unity)
                {
                    Params =
                    [
                        new("<mapDir>", "The extracted or authored map folder, with its gltf/ already built."),
                        new("<destDir>", "Where in the project it lands, e.g. <project>/Assets/OpenSlope/Maps/MYMAP."),
                    ],
                    Flags =
                    [
                        new("--no-shared", """
                            Copy the map alone. Without it, the `Shared` sibling - boards, announcer - is
                            staged next to it once, and skipped when the project already has one.
                            """),
                        new("--public", "Refuse content not classified for public distribution; also implies --no-shared."),
                        new("--confirm-rights", "With --public, affirm that every user-supplied asset is licensed for the intended distribution."),
                    ],
                },

                new CliCommand("shared",
                    "Project bootstrap, once: decks, announcer, board FX, shared SFX",
                    """
                    Decodes the level-INDEPENDENT shared assets; `unity` then copies the folder into the
                    project. Once per project, not once per course.
                    """,
                    shared.Shared)
                {
                    Params =
                    [
                        new("<iso>", "Your own SSX Tricky disc image."),
                        new("<destDir>", "Where the shared assets land - Maps\\Shared, the sibling `unity` looks for."),
                    ],
                },
            ]),

            new CliGroup("Re-run one stage against an imported map",
            [
                new CliCommand("props",
                    "Place props into world space -> Props.obj",
                    """
                    Installs the prop overrides, then bakes each placement. Run this after editing a STATIC
                    prop's mesh or collision: `gltf` bundles static geometry and collision from the pre-baked
                    Props.obj, so on its own it will not pick those edits up.
                    """,
                    level.Props)
                {
                    Params = [new("<mapDir>", "The map folder to re-bake, in place.")],
                    Flags = [new("--no-overrides", "Bake what is on disk, without re-installing the remodel packages.")],
                },

                new CliCommand("billboards",
                    "Find the course's video screens -> Billboards.json",
                    """
                    Measures the flat rectangle on each billboard that a video can be laid over: the ad face is
                    found from the TEXTURE - the contiguous, non-repeating chunk of one page a real ad shows -
                    sized to that face, split into one screen per board in a cluster, and turned toward the
                    riders. The animated LCD towers take a second recipe, since their display is a tiled
                    flip-book page on a curved drum.

                    `import` and `props` already run this. Reach for it after editing a board's mesh, or to
                    bring a map extracted before the contract existed up to date. Unity builds its overlay
                    quads from the result (via the bundle) and Slopesmith draws and edits the same rectangles;
                    neither searches the geometry itself.
                    """,
                    level.Billboards)
                {
                    Params = [new("<mapDir>", "The map folder to scan, with its Props.obj already baked.")],
                    Flags = [new("--force", "Replace an AUTHORED Billboards.json too; without it a hand-placed screen set is kept.")],
                },

                new CliCommand("overrides",
                    "Install the prop remodel packages over a map",
                    """
                    Matches each <Maps>\Overrides\*\override.json to a model by ModelName and installs it
                    over the map's Meshes, Collision and Textures. `import`, `props` and `gltf` do this for you
                    - their --no-overrides opts out - so reach for this to preview a package or to re-apply
                    one on its own.
                    """,
                    level.Overrides)
                {
                    Params = [new("<mapDir>", "The map folder the packages are installed over.")],
                    Flags = [new("--dry", "Report what each package would replace, and write nothing.")],
                },

                new CliCommand("skybox",
                    "Merge the skybox backdrop -> Skybox.obj",
                    "Writes Skybox.obj and Skybox.mtl; the Unity SkyboxBaker reads them.",
                    level.Skybox)
                {
                    Params = [new("<mapDir>", "The map folder, with its Skybox/ already extracted.")],
                },

                new CliCommand("lightmaps",
                    "(Re)export the terrain lightmaps -> Lightmaps/",
                    """
                    Alpha becomes grayscale, which is the term the terrain shader reconstructs its lighting
                    from - the library's default export would discard it.
                    """,
                    level.Lightmaps)
                {
                    Params =
                    [
                        new("<_L.ssh>", "The raw terrain lightmap bank, left in the map's %TEMP% work dir by `import`."),
                        new("<mapDir>", "The map folder to write Lightmaps/ into."),
                    ],
                },

                new CliCommand("particles",
                    "Decode the shared particle sprite bank",
                    """
                    DATA\TEXTURES\PARTICLE.SSH is the same art for every course, which is why it has its own
                    command: the sprites can be regenerated without an `import` re-run.
                    """,
                    particles.Particles)
                {
                    Params =
                    [
                        new("<iso>", "Your own SSX Tricky disc image - the bank is shared, so any course's disc will do."),
                        new("<mapDir>", "The map folder; sprites land in <mapDir>/Textures/Particles/<name>.png."),
                    ],
                },

                new CliCommand("gltf-info",
                    "Inspect a bundle .glb: per-node mesh and vertex counts, bounds",
                    "",
                    level.GltfInfo)
                {
                    Params = [new("<file.glb>", "Any glTF binary - terrain.glb, props.glb, collision.glb.")],
                },
            ]),

            new CliGroup("Riders and boards",
            [
                new CliCommand("rider",
                    "Export a rider and measure its height for scale",
                    """
                    Read from the shared character archive, DATA\CHAR\MDLPS2.BIG, not from a level. The
                    measured height is the world-scale anchor the Unity side is built against.
                    """,
                    models.Rider)
                {
                    Params =
                    [
                        new("<iso>", "Your own SSX Tricky disc image."),
                        new("<name>", "The rider, lowercased for you: mac, elise, kaori, ..."),
                        new("[outDir]", "Where <name>.obj lands. Defaults to Assets/OpenSlope/Maps/chars."),
                    ],
                },

                new CliCommand("board",
                    "Export the snowboard decks and every deck skin",
                    """
                    board_Al/Bx/Fr.obj with UVs and normals, plus TEXPS2.BIG -> BoardTextures/<id>.png. Every
                    rider rides one board.mpf, so this is a disc-wide export, not a per-rider one.
                    """,
                    models.Board)
                {
                    Params =
                    [
                        new("<iso>", "Your own SSX Tricky disc image."),
                        new("[outDir]", "Where the decks and skins land. Defaults to Assets/OpenSlope/Maps/chars."),
                    ],
                },

                new CliCommand("skis",
                    "Export the ski decks and skins",
                    "ski_<name>.obj with UVs and normals, plus TEXPS2.BIG -> SkiTextures/<id>.png.",
                    models.Skis)
                {
                    Params =
                    [
                        new("<iso>", "An SSX On Tour disc image - Tricky has no skis."),
                        new("[outDir]", "Where the decks and skins land. Defaults to Assets/OpenSlope/Maps/chars."),
                    ],
                },
            ]),

            new CliGroup("Audio",
            [
                new CliCommand("intro-music",
                    "Decode a course's INTRO music (the start-gate stems)",
                    "EA-XA streams out of DATA\\AUDIO\\<level>.BIG, whose name matches the course.",
                    audio.IntroMusic)
                {
                    Params =
                    [
                        new("<iso>", "Your own SSX Tricky disc image."),
                        new("<courseSlot>", $"The course whose intro to decode: {Slots}."),
                        new("<mapDir>", "Stems land in <mapDir>/Audio/Music/*.wav."),
                    ],
                },

                new CliCommand("race-music",
                    "Decode a course's RACE songs (the EA PathFinder graph)",
                    """
                    The .mpf graph and .mus chunks out of the shared MUSIC.BIG. The unpacked source BIG is
                    cached under %TEMP%/snowknife_musicbig (451 MB), so re-runs are fast.
                    """,
                    audio.RaceMusic)
                {
                    Params =
                    [
                        new("<iso>", "Your own SSX Tricky disc image."),
                        new("<courseSlot>", $"The course whose race songs to decode: {Slots}."),
                        new("<mapDir>", "Each song lands in <mapDir>/Audio/Music/<song>/chunk_NNN.wav, with its graph.json."),
                    ],
                },

                new CliCommand("sfx",
                    "Decode a course's SFX banks (crowd, ambient, board)",
                    """
                    Takes the fixed global banks that Instances.json actually references. A traced global
                    bank missing from this archive is warned about; a referenced-but-missing course slot
                    fills from a sibling course.
                    """,
                    audio.Sfx)
                {
                    Params =
                    [
                        new("<iso>", "Your own SSX Tricky disc image; the banks live in the shared DATA\\AUDIO\\AUDIO.BIG."),
                        new("<courseSlot>", $"The course whose banks to decode: {Slots}."),
                        new("<mapDir>", "Banks land in <mapDir>/Audio/SFX/<bank>/*.wav."),
                    ],
                },

                new CliCommand("sound-index",
                    "Extract this disc's event routes -> Audio/SoundIndex.json",
                    "Reads BANKS.INF and interprets the boot ELF; `import` and `sfx` already run it.",
                    audio.SoundIndex)
                {
                    Params =
                    [
                        new("<iso>", "Your own SSX Tricky disc image."),
                        new("<courseSlot>", $"The course whose bank names are joined to the routes: {Slots}."),
                        new("<mapDir>", "The corresponding extracted map folder to update in place."),
                    ],
                },

                new CliCommand("board-sound-index",
                    "Extract this disc's board surface routes -> Shared/Audio/BoardSoundIndex.json",
                    "Interprets the boot ELF's board-surface dispatcher; `shared` already runs it.",
                    audio.BoardSoundIndex)
                {
                    Params =
                    [
                        new("<iso>", "Your own SSX Tricky disc image."),
                        new("<sharedDir>", "The project Shared folder to update, normally Maps\\Shared."),
                    ],
                },

                new CliCommand("speech",
                    "Decode SPEECH.BIG voice banks (EA MicroTalk)",
                    "The unpacked source BIG is cached under %TEMP%/snowknife_speechbig (685 MB), so re-runs are fast.",
                    audio.Speech)
                {
                    Params =
                    [
                        new("<iso|dat|dir>", """
                            A disc image - which gives you the MC announcer's race-event banks - or one
                            already-extracted .dat, or a folder of them.
                            """),
                        new("<outDir>", "Banks land in <outDir>/<bank>/NNN.wav."),
                    ],
                },

                new CliCommand("bnk",
                    "Decode one BNKl sound bank to WAVs",
                    "One of AUDIO.BIG's ~170 banks, decoded on its own.",
                    audio.Bnk)
                {
                    Params =
                    [
                        new("<file.bnk>", "A BNKl bank, e.g. one `big-extract` pulled out of AUDIO.BIG."),
                        new("<outDir>", "Sounds land in <outDir>/NNN.wav."),
                    ],
                    Flags = [new("-v", "Dump each sound's patch tags as it goes. --verbose does the same.")],
                },

                new CliCommand("bnk-rebuild",
                    "Load a bank and write it straight back (bisecting tool)",
                    """
                    Separates "the bank we wrote is correct" from "the bank we wrote is what the console
                    accepts": the output has been through the writer with nothing injected, so a disc built
                    from it isolates the LAYOUT from anything an injection put in it.
                    """,
                    audio.BnkRebuild)
                {
                    Params =
                    [
                        new("<in.bnk>", "A BNKl bank, e.g. one `big-extract` pulled out of AUDIO.BIG."),
                        new("<out.bnk>", "Where the rebuilt bank lands."),
                    ],
                    Flags =
                    [
                        new("--pad-to <bytes>", """
                            Zero-pad the result to this size, so it can replace a member of the original's
                            size and leave every following offset alone.
                            """),
                        new("--replace=<slot>=<file.wav>", """
                            Encode a WAV into a slot the bank already ships. The other half of the bisect:
                            it asks whether a sound this program built is audible without also asking
                            whether a slot the bank never had is audible. Repeatable.
                            """),
                    ],
                },

                new CliCommand("audio-file",
                    "Decode a single EA SCHl stream to WAV (debug)",
                    "",
                    audio.AudioFile)
                {
                    Params =
                    [
                        new("<schl-file>", "One EA SCHl stream (EA-XA ADPCM)."),
                        new("<out.wav>", "Where to write the decoded PCM."),
                    ],
                },

                new CliCommand("music-inject",
                    "Replace a course's lead race song",
                    """
                    Encodes the track as the retail-shaped short EA-XA streams the PathFinder graph expects.
                    `repack` consumes the same track from <customDir>/Music/track.wav, so reach for this
                    when the disc is not otherwise being repacked.
                    """,
                    args => CustomMusicInject.Command(iso, args))
                {
                    Params =
                    [
                        new("<input.iso>", "The image to build from. Copied, not modified."),
                        new("<LEVEL>", $"The course whose lead song is replaced: {Slots}."),
                        new("<track.wav>", "Your song."),
                        new("<out.iso>", "Where the built image lands."),
                    ],
                },

                new CliCommand("music-linearize",
                    "Rewire a donor graph into its linear loop (offline proof)",
                    "Sample-table order, as a structural check on the graph rewrite - no disc involved.",
                    CustomMusicInject.LinearizeCommand)
                {
                    Params =
                    [
                        new("<donor.mpf>", "A PathFinder graph, as `race-music` found it."),
                        new("<out.mpf>", "Where the linearized graph lands."),
                    ],
                },

                new CliCommand("bank-verify",
                    "Verify the BIGF/BNKl rebuilds and the PS-ADPCM round trip",
                    """
                    A byte-faithful no-op rebuild of the container, every BNKl slot, tag and sample
                    round-tripped, and the encoder's own fidelity. Run it when the audio writers change.
                    """,
                    CourseBankInject.Verify)
                {
                    Params = [new("<AUDIO.BIG|file.bnk>", "The whole archive, or one bank out of it.")],
                },
            ]),

            new CliGroup("Build a custom disc",
            [
                new CliCommand("repack",
                    "Replace one course with a custom mountain and patch a fresh ISO",
                    """
                    The whole recipe in one step: consume a Slopesmith export's native-shaped map
                    intermediate, clone the target slot's sidecars, append its canonical models/instances,
                    regenerate the level data and world grid, encode and install what the textures need, then
                    pack it into a copy of the disc.

                    Textures are installed by provenance: pages the export borrowed from a donor level go in
                    verbatim, custom ones are encoded, and both reuse the target slot's unreferenced pages
                    before any overflow is appended to the bank.

                    The custom terrain must be authored on the target slot's coordinates. Authored lighting,
                    music and gems are carried across when they are there, and skipped when they are not.
                    """,
                    repack.Repack)
                {
                    Params =
                    [
                        new("<iso>", "A clean SSX Tricky image to build from. Copied, never modified."),
                        new("<courseSlot>", $"The course slot the mountain rides as. Any of {Slots}."),
                        new("<mapDir>", "That slot's own imported Maps folder - the sidecars the mountain is overlaid onto."),
                        new("<customDir>", "The authored mountain: a Slopesmith export, or a Maps folder you edited."),
                        new("<out.iso>", "Where the built image lands."),
                    ],
                    Flags =
                    [
                        new("--dry-run", """
                            Run the same pipeline to the point of writing bytes and report what it found -
                            slots retained and reusable, pages in allocation order (reuse or append), bytes,
                            the custom-page VRAM total, path and placement, the sky decision, and anything
                            that will be dropped - instead of building an image.
                            """),
                        new("--json", "Emit that plan as a record instead of a report, with progress on stderr. Needs --dry-run."),
                        new("--texture-type2", "Encode custom terrain and prop pages as retail-shaped 8-bit type 2 instead of type 5."),
                        new("--sound-rate [hz]", """
                            Encode every custom prop sound at this rate instead of the target bank's own.
                            Bare, it takes retail's 22050 Hz.

                            This is an OVERRIDE, not a ceiling: clips are converted up as well as down, and
                            without the flag they are already converted — to the rate the target bank is
                            played at, which is what keeps their pitch right. The engine ignores a sound's
                            own rate tag and plays the slot at the bank's, so a clip encoded at any other
                            rate comes out at the wrong speed and pitch.

                            So the only rate that sounds correct is the one the build picks for you. Name a
                            lower one to buy bank bytes when a build is over budget, knowing the clips will
                            play sharp; the size is proportional to the rate.
                            """),
                        new("--patches <list>", """
                            Comma-separated executable features to bake into the image: noclip and/or
                            hud-text. The hud-text selection also keeps the export's Show message
                            nodes; without it they are dropped because a stock executable sends their opcode
                            to its do-nothing case. Example: --patches noclip,hud-text
                            """),
                        new("--no-skycolor", "Leave the slot's engine sky colour alone, which the export's Skybox TopColor would otherwise set."),
                        new("--no-sound-routing", """
                            Keep the export's reserved custom-sound event ids instead of re-pointing them onto
                            slots the target bank already ships. Routing is what keeps a rebuilt course bank
                            inside the size its level shipped with — past that it plays nothing at all — so
                            turning it off is for isolating a build, not for shipping one.
                            """),
                        new("--bare-slot", """
                            Hide the donor slot's own props, keeping only what the export places. An authored
                            course replaces the terrain but inherits the slot's whole prop population, sitting
                            at the donor's coordinates - the console never draws them because the world grid
                            only streams cells near the course, but the Unity bundle instantiates all of them.
                            The instances are hidden rather than deleted, so every index the .ssf, .ltg and
                            spline tables reference stays put; the StageArea start/finish markers are kept.
                            """),
                    ],
                },

                new CliCommand("repack-many",
                    "Build several course slots into one ISO from a clean source",
                    """
                    Each slot is repacked as `repack` would, but against one clean source and into one
                    image - so several custom courses ship on the same disc.
                    """,
                    repack.RepackMany)
                {
                    Params =
                    [
                        new("<manifest.json>", """
                            InputIso, OutputIso and Levels[{Slot, LevelData, Export}], plus optional Noclip,
                            TextureType2, SoundRate and SkyColors=false. TextureType2=true gives every
                            encoded terrain/prop page the retail bank's 8-bit indexed shape, and SoundRate
                            caps what custom prop sounds are resampled to (retail's own ceiling is 22050).
                            Paths resolve from the manifest's own folder. A Slopesmith export ships one
                            beside its Repack.md.
                            """),
                    ],
                    Flags =
                    [
                        new("--dry-run", "Plan every listed slot against the clean source bank and report them together."),
                        new("--json", "Emit those plans as records. Needs --dry-run."),
                    ],
                },

                new CliCommand("texture-plan",
                    "Show how an export's textures resolve against a target slot",
                    """
                    Page by page: reuse the target's own page, install a donor level's verbatim, or encode a
                    custom one. This is the same resolution `repack` performs, in the same first-seen
                    order - with no disc needed, so it answers the question before you own a build.
                    """,
                    SlopesmithExport.TexturePlanCommand)
                {
                    Params =
                    [
                        new("<exportDir>", "The authored export, whose Slopesmith.json carries the provenance behind each page."),
                        new("<LEVEL>", $"The course slot it would ride as: {Slots}."),
                    ],
                    Flags =
                    [
                        new("--slots N", "The target bank's page count, which is how many slots there are to reuse. Unbounded when left off."),
                        new("--json", "Emit the resolution as a record."),
                    ],
                },

                new CliCommand("pbd-from-json",
                    "Regenerate a level's .pbd from its Maps JSON",
                    """
                    The step `repack` runs internally, exposed on its own. The output is uncompressed -
                    `refpack` it, then `big-create --store`, before packing.
                    """,
                    repack.PbdFromJson)
                {
                    Params =
                    [
                        new("<mapDir>", "The map folder to build from: Patches.json, Instances.json, Meshes/, Textures/."),
                        new("<out.pbd>", "Where the .pbd lands; the sidecars below land beside it, under the same stem."),
                    ],
                    Flags =
                    [
                        new("--keepslots <orig.ssh>", """
                            Seed the texture slots from an original bank, so its pages are reused verbatim
                            rather than re-encoded. Takes precedence over --ssh.
                            """),
                        new("--ssh", "Also generate the texture bank, encoding every page."),
                        new("--lssh", "Also generate the terrain lightmap bank."),
                        new("--map", "Also generate the .map."),
                        new("--ltg", "Also generate the world grid, so terrain collision tracks the new patches."),
                        new("--aip", "Also generate the AI paths."),
                        new("--sop", "Also generate the .sop."),
                    ],
                },

                new CliCommand("ltg-stats",
                    "Per-cell list totals of a world grid",
                    "For holding a regenerated grid up against the original's: patches, lights, splines and instances per cell.",
                    repack.LtgStats)
                {
                    Params = [new("<file.ltg>", "A world grid, original or regenerated.")],
                },

                new CliCommand("ltg-find",
                    "Which grid node cells list an instance",
                    "The grid is the collision broadphase: a query point maps to its node cell, and only that cell's "
                    + "listed instances reach the narrowphase. So a prop is only a collision candidate where it is "
                    + "LISTED, which need not cover the prop's own bounds. Prints every node cell listing the "
                    + "instance, with that cell's world XY extent, so it can be held up against the prop's box.",
                    repack.LtgFind)
                {
                    Params =
                    [
                        new("<file.ltg>", "A world grid, original or regenerated."),
                        new("<instanceIndex>", "Instance index, as numbered by Instances.json."),
                    ],
                },
            ]),

            new CliGroup("Patch the executable",
            [
                new CliCommand("noclip",
                    "Toggleable in-game noclip fly mode",
                    $"""
                    TRIANGLE+CIRCLE toggles camera-relative flight for the local rider.

                    {Restore}

                    See [Trailmap: 440-noclip-fly-mode].
                    """,
                    elf.Noclip)
                {
                    Params = [new("<iso>", "The image to patch, in place.")],
                    Flags =
                    [
                        new("--revert", "Play the saved bytes back and take the patch out."),
                        new("--from <clean.iso>", "Rebuild the restore file from an unpatched copy of the disc, when it has gone missing."),
                    ],
                },

                new CliCommand("skycolor",
                    "Set one course slot's engine sky colour",
                    $"""
                    Re-running updates only the slot you name: the override seeds itself with the retail
                    colours, so the other twelve courses stay as they were.

                    {Restore}

                    See [Trailmap: 442-sky-color].
                    """,
                    elf.SkyColor)
                {
                    // --revert takes the whole table out, so it needs the image and nothing else.
                    Requires = 1,
                    Params =
                    [
                        new("<iso>", "The image to patch, in place."),
                        new("<LEVEL|0-12>", $"The course slot to colour, by name ({Slots}) or by its index in the table."),
                        new("<#rrggbb>", "The colour, as hex."),
                    ],
                    Flags =
                    [
                        new("--revert", "Remove the complete table override. The slot arguments are not needed."),
                        new("--from <clean.iso>", "Rebuild the restore file from an unpatched copy of the disc, when it has gone missing."),
                    ],
                },
            ]),

            new CliGroup("Effects and contracts",
            [
                new CliCommand("effects-export",
                    "Export an SSF's complete semantics as an Effects document",
                    """
                    The versioned, stable-ID interchange contract: Slopesmith authors it, the glTF bundle is
                    built from it, and `effects-import` compiles it back. `import` runs this for you.
                    """,
                    effects.Export)
                {
                    Params =
                    [
                        new("<in.ssf>", "A level's SSF, as `import` or `big-extract` left it."),
                        new("<out.effects.json>", "Where the document lands - Effects.json, beside the map."),
                    ],
                    Flags =
                    [
                        new("--level NAME", "The level the document names. Defaults to the input file's own name."),
                        new("--salvage-dangling-references", "Replace only missing effect-node targets with native nulls and record an audit extension."),
                    ],
                },

                new CliCommand("effects-import",
                    "Compile an Effects document back to SSF",
                    """
                    Requested IDs are honoured where the format allows and compacted back into native indexes
                    where it does not. The result must survive a save and reload semantically unchanged, or
                    the command fails rather than writing an SSF the engine would read differently.
                    """,
                    effects.Import)
                {
                    Params =
                    [
                        new("<in.effects.json>", "The document to compile."),
                        new("<out.ssf>", "Where the SSF lands."),
                    ],
                },

                new CliCommand("effects-check",
                    "Validate an Effects document and prove it survives SSF",
                    "The offline check: no disc, no repack, just the document and what the format will do to it.",
                    effects.Check)
                {
                    Params = [new("<file.effects.json>", "The document to check.")],
                },

                new CliCommand("ssf-check",
                    "Validate an SSF's references and its save/reload equality",
                    "References are resolved, the file is saved and reloaded, and the result must be semantically equal.",
                    ssf.Check)
                {
                    Params = [new("<file.ssf|directory>", "One SSF, or a folder - which checks every .ssf below it.")],
                },

                new CliCommand("ssf-canary",
                    "Append a fresh emitter and attach it to an effectless host",
                    """
                    The research probe behind the effects work: an emitter header and slot are appended, then
                    attached, and every assignment is verified after save and reload - so a field the format
                    will not carry is caught here rather than in game.
                    """,
                    ssf.Canary)
                {
                    Params =
                    [
                        new("<in.ssf>", "The SSF to graft onto."),
                        new("<out.ssf>", "Where the grafted SSF lands."),
                    ],
                    Flags =
                    [
                        new("--host N", "The host instance to attach the emitter to. Required."),
                        new("--source-header N", "Clone the emitter header from this one instead of building a fresh one."),
                        new("--source-node N", "Clone the emitter node from this one."),
                        new("--mode persistent|collision|trigger", "How the host fires it."),
                        new("--set U9=1000 U10=0 ...", "Assign emitter fields U0 through U50. Each field may be set once."),
                        new("--force-host", "Attach even to a host that already carries an effect."),
                    ],
                },

                new CliCommand("ssf-install-iso",
                    "Install one validated SSF into a copied ISO",
                    "Every other BIG member is preserved, and the result is verified before the image is kept.",
                    ssf.InstallIso)
                {
                    Params =
                    [
                        new("<source.iso>", "The image to build from. Copied, not modified."),
                        new("<LEVEL>", $"The course whose SSF is replaced: {Slots}."),
                        new("<file.ssf>", "The SSF to install. It is validated first."),
                        new("<out.iso>", "Where the built image lands."),
                    ],
                },

                new CliCommand("validate",
                    "Validate portable JSON against the embedded schemas",
                    """
                    Import and export boundaries already validate what they recognize; this is the standalone
                    check. Unrecognized files are skipped, not failed.
                    """,
                    contracts.ValidateCommand)
                {
                    Params =
                    [
                        new("<json-file|directory>", """
                            One document, or a folder - which checks every recognized contract below it:
                            patches, splines, effects, bundle manifests, tooling inputs.
                            """),
                    ],
                },
            ]),

            new CliGroup("Containers and codecs",
            [
                new CliCommand("iso-ls",
                    "List files inside the ISO",
                    "",
                    iso.IsoLs)
                {
                    Params =
                    [
                        new("<iso>", "Any PS2 disc image; read through DiscUtils, so nothing is mounted."),
                        new("[subdir]", "A folder inside the image, with backslashes: DATA\\MODELS. Defaults to the root."),
                    ],
                },

                new CliCommand("iso-extract",
                    "Extract one file out of the ISO",
                    "",
                    iso.IsoExtract)
                {
                    Params =
                    [
                        new("<iso>", "Any PS2 disc image."),
                        new("<internalPath>", "The file's path inside the image, with backslashes: DATA\\MODELS\\<LEVEL>.BIG."),
                        new("<out>", "Where to write it."),
                    ],
                },

                new CliCommand("iso-replace",
                    "Overwrite one file in the ISO, in place",
                    """
                    The fast repack/test loop: no image is rebuilt, so a changed member is in the game in
                    seconds.
                    """,
                    iso.IsoReplace)
                {
                    Params =
                    [
                        new("<iso>", "The image to write into, in place."),
                        new("<internalPath>", "The file to overwrite, with backslashes: DATA\\MODELS\\<LEVEL>.BIG."),
                        new("<file>", "Its replacement. Must be no larger than the original, which is what preserves every LBA."),
                    ],
                },

                new CliCommand("big-ls",
                    "List the member files of a .BIG archive",
                    "",
                    big.BigLs)
                {
                    Params = [new("<big>", "A C0FB or BIGF archive.")],
                },

                new CliCommand("big-extract",
                    "Extract a .BIG archive to a folder",
                    "",
                    big.BigExtract)
                {
                    Params =
                    [
                        new("<big>", "A C0FB or BIGF archive."),
                        new("<outDir>", "Where the members land."),
                    ],
                    Flags =
                    [
                        new("--raw", """
                            Keep the members compressed, exactly as stored. Pairs with `big-create --store`
                            to re-container an archive losslessly and instantly.
                            """),
                    ],
                },

                new CliCommand("big-create",
                    "Pack a folder of members into a .BIG",
                    "",
                    big.BigCreate)
                {
                    Params =
                    [
                        new("<memberFolder>", "The members to pack, recursively."),
                        new("<out.big>", "Where the archive lands."),
                        new("[c0fb|bigf]", "Which container to write. Defaults to c0fb, what the level archives use."),
                    ],
                    Flags =
                    [
                        new("--store", """
                            Store the input verbatim instead of RefPacking it - instant, and right for
                            members that are already compressed (`big-extract --raw`).
                            """),
                    ],
                },

                new CliCommand("refpack",
                    "RefPack-compress one file",
                    "Fast hash-chain; the output starts 10 FB. Compress a regenerated member, then `big-create --store`.",
                    refpack.Refpack)
                {
                    Params =
                    [
                        new("<in>", "The file to compress."),
                        new("<out>", "Where the compressed file lands."),
                    ],
                },

                new CliCommand("ssh-extract",
                    "Decode an EA .SSH texture bank to PNGs",
                    "",
                    ssh.SshExtract)
                {
                    Params =
                    [
                        new("<file.ssh>", "An SHPS bank - a level's own, or a shared one like DATA\\TEXTURES\\CROWD.SSH."),
                        new("<outDir>", "Where the pages land, one PNG per page."),
                    ],
                },

                new CliCommand("ssh-append",
                    "Append donor pages onto an SHPS bank, verbatim",
                    """
                    No re-encode - the pages are spliced across as they are. This is what borrowed textures
                    ride on inside `repack`, exposed here as its test harness.
                    """,
                    ssh.SshAppend)
                {
                    Params =
                    [
                        new("<target.ssh>", "The bank to append onto. Its own pages are untouched."),
                        new("<out.ssh>", "Where the grown bank lands."),
                        new("<donor.ssh>", "The bank to take pages from."),
                        new("<name> [...]", "Which donor pages to take, by name. As many as you need."),
                    ],
                },

                new CliCommand("ssh-encode",
                    "Encode a PNG into an SHPS bank as a new page",
                    "The other half of `ssh-append`: a page that no disc has yet, encoded and spliced on.",
                    ssh.SshEncode)
                {
                    Params =
                    [
                        new("<target.ssh>", "The bank to append onto."),
                        new("<out.ssh>", "Where the grown bank lands."),
                        new("<image.png>", "The image to encode."),
                    ],
                    Flags = [new("--type2", "Write a retail-shaped 8-bit indexed page instead of the default 32-bit type 5.")],
                },
            ]),
        ];
    }
}
