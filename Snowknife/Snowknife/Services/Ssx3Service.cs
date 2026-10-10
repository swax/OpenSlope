using System.Globalization;
using System.Numerics;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using Snowknife.Export;
using SSX_Library;
using SSXLibrary.FileHandlers.LevelFiles.SSX3PS2;
using SSXLibrary.FileHandlers.LevelFiles.SSX3PS2.SSBData;

namespace Snowknife.Services;

/// <summary>
/// SSX 3 world import. SSX 3 ships one streamed mountain, <c>DATA\WORLDS\BAM.BIG</c>, rather than a BIG per
/// course: its SDB names the mountain's sections (hubs, events, the connectors between them and the skies),
/// and its SSB streams every section's resources through one shared, Z-up world space.
/// [Trailmap: 510-container, 510-ssb, 511-locations, 511-one-space]
///
/// <c>ssx3-import</c> picks sections and writes them as one ordinary map folder - the same Patches, Textures,
/// Lightmaps, AIP, Splines and prop files the Tricky <c>import</c> writes - so Slopesmith can open and ride
/// it as a Reference. The library's SSX 3 handlers decode each resource; this service owns the selection,
/// the cross-section references, and the translation into the Tricky-shaped contract.
/// </summary>
internal sealed class Ssx3Service(IsoService iso, ContractValidationService contracts)
{
    private const string WorldBig = @"DATA\WORLDS\BAM.BIG";

    // Resource types in the SSB stream (SSBHandler's table).
    // [Trailmap: 510-bins]
    private const int TypeMaterial = 0, TypePatch = 1, TypeModel = 2, TypeInstance = 3;
    private const int TypeParticleModel = 4, TypeParticle = 5, TypeLight = 6, TypeHalo = 7;
    private const int TypeSpline = 8, TypeTexture = 9, TypeLightmap = 10, TypeCollision = 12, TypeAip = 14;

    // PHM/PSM name arrays, by resource family.
    // [Trailmap: 510-names]
    private const int NamePatch = 0, NameInstance = 1, NameModel = 2, NameSpline = 3, NameCollision = 4;

    /// <summary>
    /// The peaks, as the SDB's section prefixes group them: peak 1 is the bottom of the mountain.
    /// [Trailmap: 511-peaks]
    /// </summary>
    private static readonly Dictionary<string, string[]> Peaks = new(StringComparer.OrdinalIgnoreCase)
    {
        ["PEAK1"] = ["A", "B"],
        ["PEAK2"] = ["C", "D"],
        ["PEAK3"] = ["E"],
    };

    public int Raw(string[] args)
    {
        string outDir = Path.GetFullPath(args[2]);
        string ssb = ExtractWorld(args[1]);
        new SSBHandler().LoadAndExtractSSBFromSBD(ssb, Path.Combine(outDir, "raw"));
        return 0;
    }

    public int Sections(string[] args)
    {
        var world = World.Load(ExtractWorld(args[1]));
        var patches = new Dictionary<int, int>();
        var instances = new Dictionary<int, int>();
        foreach (var r in SSBHandler.ReadResources(world.Ssb))
        {
            if (r.Type == TypePatch) patches[r.Track] = patches.GetValueOrDefault(r.Track) + 1;
            else if (r.Type == TypeInstance) instances[r.Track] = instances.GetValueOrDefault(r.Track) + 1;
        }
        Log.Info("Sections (track, name, patches, props):");
        for (int t = 0; t < world.Sections.Length; t++)
            Log.Info($"  {t,3}  {world.Sections[t],-8}  {patches.GetValueOrDefault(t),6}  {instances.GetValueOrDefault(t),6}");
        Log.Info("");
        Log.Info("Selections: a section name, a comma list of them, PEAK1 (A*, B*), PEAK2 (C*, D*), PEAK3 (E*), or ALL.");
        Log.Info("An event name such as ARA1 brings its own connectors (A_ARA1, ARA1_B) with it.");
        return 0;
    }

    public int Import(string[] args)
    {
        string isoPath = args[1];
        string selection = args[2];
        string mapDir = Path.GetFullPath(args[3]);
        bool props = !args.Contains("--no-props");

        var world = World.Load(ExtractWorld(isoPath));
        var (tracks, races, course) = Select(world, selection);
        // The sky of the selection's first hub letter: ASKY for anything on peak 1's A sections, and so on.
        int skyTrack = Array.IndexOf(world.Sections, world.Sections[tracks.Min()][..1] + "SKY");
        Log.Info($"SSX 3 import: {string.Join(", ", tracks.Order().Select(t => world.Sections[t]))} -> {mapDir}");

        // Pass 1: everything that belongs to the chosen sections, plus every model and material on the mountain
        // (an instance may borrow a model from another section, and a model its materials).
        var patches = new List<(SSBResource res, WorldPatch patch)>();
        var instances = new List<(SSBResource res, WorldInstance inst)>();
        var splines = new List<(SSBResource res, WorldSpline spline)>();
        var aips = new List<(SSBResource res, WorldAIP aip)>();
        var collisions = new List<(string name, WorldCollision collision)>();
        var fx = new Dictionary<int, List<SSBResource>>
        {
            [TypeParticleModel] = [], [TypeParticle] = [], [TypeLight] = [], [TypeHalo] = [],
        };
        var models = new Dictionary<(int, int), byte[]>();
        var materials = new Dictionary<(int, int), WorldBin0>();
        (int, int)? skyModel = null;
        foreach (var r in SSBHandler.ReadResources(world.Ssb))
        {
            if (r.Type == TypeModel) { models.TryAdd((r.Track, r.Rid), r.Data); continue; }
            if (r.Type == TypeMaterial)
            {
                if (materials.ContainsKey((r.Track, r.Rid))) continue;
                var m = new WorldBin0();
                m.LoadData(new MemoryStream(r.Data), r.Track, r.Rid);
                materials[(r.Track, r.Rid)] = m;
                continue;
            }
            if (r.Type == TypeInstance && r.Track == skyTrack && skyModel is null)
            {
                var dome = new WorldInstance();
                dome.LoadData(new MemoryStream(r.Data));
                skyModel = (dome.ModelID.TrackID, dome.ModelID.RID);
            }
            if (!tracks.Contains(r.Track)) continue;
            switch (r.Type)
            {
                case TypePatch:
                    var patch = new WorldPatch();
                    patch.LoadPatch(new MemoryStream(r.Data));
                    patch.Name = world.Name(NamePatch, r.Track, r.Rid) ?? $"patch_{world.Sections[r.Track]}_{r.Rid}";
                    patches.Add((r, patch));
                    break;
                case TypeInstance when props:
                    var inst = new WorldInstance();
                    inst.LoadData(new MemoryStream(r.Data));
                    inst.Name = world.Name(NameInstance, r.Track, r.Rid) ?? $"mdl_{world.Sections[r.Track]}_{r.Rid}";
                    instances.Add((r, inst));
                    break;
                case TypeSpline:
                    var spline = new WorldSpline();
                    spline.LoadData(new MemoryStream(r.Data));
                    spline.Name = world.Name(NameSpline, r.Track, r.Rid) ?? $"spline_{world.Sections[r.Track]}_{r.Rid}";
                    splines.Add((r, spline));
                    break;
                case TypeCollision when props:
                    var collision = new WorldCollision();
                    var stdout = Console.Out;
                    try
                    {
                        Console.SetOut(TextWriter.Null);
                        collision.LoadData(new MemoryStream(r.Data), r.Track, r.Rid);
                    }
                    finally { Console.SetOut(stdout); }
                    if (world.Name(NameCollision, r.Track, r.Rid) is { } collisionName)
                        collisions.Add((collisionName, collision));
                    break;
                case TypeAip:
                    var aip = new WorldAIP();
                    aip.LoadData(r.Data);
                    aips.Add((r, aip));
                    break;
                case TypeParticleModel or TypeParticle or TypeLight or TypeHalo:
                    fx[r.Type].Add(r);
                    break;
            }
        }
        if (patches.Count == 0) throw new InvalidOperationException($"'{selection}' has no terrain patches.");

        // A rerun replaces the page and mesh folders outright, so a narrower selection leaves no strays. Files
        // only: a running Slopesmith watches the folders themselves, which can hold a directory delete open.
        foreach (string sub in new[] { "Textures", "Lightmaps", "Meshes", "Collision", Path.Combine("Skybox", "Meshes"), Path.Combine("Skybox", "Textures") })
        {
            string dir = Path.Combine(mapDir, sub);
            if (Directory.Exists(dir))
                foreach (string file in Directory.EnumerateFiles(dir)) File.Delete(file);
            Directory.CreateDirectory(dir);
        }

        // Records name their texture pages now, but which file each reads depends on the page's alpha, which is only
        // known once pass 2 decodes it; Patches.json and Materials.json are written after that.
        var pages = new Dictionary<int, TexturePage>();
        var lightmaps = new HashSet<int>();
        var patchRows = BuildPatches(patches, pages, lightmaps);
        int rails = WriteSplines(mapDir, splines);
        WriteAip(mapDir, aips, races, world);
        var (lightCount, haloCount) = WriteLights(mapDir, fx[TypeLight], fx[TypeHalo], world);
        int fogCount = WriteParticles(mapDir, fx[TypeParticleModel], fx[TypeParticle], world);
        string? bootExecutable;
        using (var isoStream = File.OpenRead(isoPath)) bootExecutable = iso.ReadBootExecutableName(isoStream);
        WriteJson(Path.Combine(mapDir, "Effects.json"), EffectsDocumentService.Empty("ssx-3", course, bootExecutable));

        int propCount = 0;
        List<object> materialRows = [];
        if (props)
            (propCount, materialRows) = WriteProps(mapDir, instances, models, materials, WriteCollision(mapDir, collisions), world, pages);
        else
        {
            WriteJson(Path.Combine(mapDir, "Instances.json"), new { Instances = Array.Empty<object>() });
            WriteJson(Path.Combine(mapDir, "Models.json"), new { Models = Array.Empty<object>() });
        }

        var skyPages = skyModel is { } skyKey && models.TryGetValue(skyKey, out var skyData)
            ? WriteSky(mapDir, skyData, materials)
            : [];

        // Pass 2: the texture and lightmap pages the written records name. Both are keyed mountain-wide.
        int texCount = 0, lmCount = 0;
        var doneTex = new HashSet<int>();
        var doneLm = new HashSet<int>();
        var doneSky = new HashSet<int>();
        foreach (var r in SSBHandler.ReadResources(world.Ssb))
        {
            if (r.Type == TypeTexture && !doneSky.Contains(r.Rid) && skyPages.ContainsValue(r.Rid))
            {
                doneSky.Add(r.Rid);
                using var skyPage = DecodeShape(r.Data);
                foreach (var (slot, _) in skyPages.Where(p => p.Value == r.Rid))
                    skyPage?.SaveAsPng(Path.Combine(mapDir, "Skybox", "Textures", PageName(slot)));
            }
            if (r.Type == TypeTexture && pages.TryGetValue(r.Rid, out var page) && doneTex.Add(r.Rid))
            {
                using var image = DecodeShape(r.Data);
                if (image is null) continue;
                WritePage(mapDir, r.Rid, page, image);
                texCount++;
            }
            else if (r.Type == TypeLightmap && lightmaps.Contains(r.Rid) && doneLm.Add(r.Rid))
            {
                using var source = DecodeShape(r.Data);
                if (source is null) continue;
                using var image = ToCentreAddressed(source);
                ToTrickyLightmap(image);
                image.SaveAsPng(Path.Combine(mapDir, "Lightmaps", PageName(r.Rid)));
                lmCount++;
            }
        }

        WriteJson(Path.Combine(mapDir, "Patches.json"), new { Patches = patchRows });
        WriteJson(Path.Combine(mapDir, "Materials.json"), new { Materials = materialRows });

        bool sky = false;
        if (skyPages.Count > 0)
        {
            try
            {
                SkyboxExporter.Export(mapDir, contracts);
                sky = File.Exists(Path.Combine(mapDir, "Skybox", SkyRingDocument.FileName));
            }
            catch (InvalidDataException ex) { Log.Warn($"  sky: {ex.Message}"); }
        }

        WriteJson(Path.Combine(mapDir, MapOrigin.FileName), MapOrigin.ForRetailExtract(course));

        Log.Info($"  sky: {(sky ? world.Sections[skyTrack] : "none")}");
        Log.Info($"  {patches.Count} patches, {texCount}/{pages.Count} textures, {lmCount}/{lightmaps.Count} lightmaps, {rails} rails, {propCount} props");
        Log.Info($"  {lightCount} lights, {haloCount} halos, {fogCount} particle volumes");
        Log.Info("Done.");
        return 0;
    }

    // ---------------------------------------------------------------- selection

    /// <summary>
    /// The sections a selection names, and the AIP resources its course comes from: an event's own race (RID 0),
    /// or for a peak or the whole mountain each hub's peak race (RID 1).
    /// [Trailmap: 514-path-slots]
    /// </summary>
    private static (HashSet<int> tracks, HashSet<(int, int)> races, string course) Select(World world, string selection)
    {
        var tracks = new HashSet<int>();
        var races = new HashSet<(int, int)>();
        var names = world.Sections;
        string course = "SSX3_" + selection.ToUpperInvariant().Replace(',', '_');
        bool IsHub(int t) => names[t].Length == 1;
        foreach (string raw in selection.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            string token = raw.ToUpperInvariant();
            if (token == "ALL" || Peaks.ContainsKey(token))
            {
                string[]? letters = token == "ALL" ? null : Peaks[token];
                for (int t = 0; t < names.Length; t++)
                {
                    if (IsSky(names[t]) || names[t] == "TRANSP") continue;
                    if (letters != null && !letters.Any(l => names[t].StartsWith(l, StringComparison.Ordinal))) continue;
                    tracks.Add(t);
                    if (IsHub(t)) races.Add((t, 1));
                }
                continue;
            }
            int exact = Array.IndexOf(names, token);
            if (exact < 0) throw new ArgumentException($"No SSX 3 section named '{raw}'. Run `snowknife ssx3-sections <iso>`.");
            tracks.Add(exact);
            races.Add((exact, IsHub(exact) ? 1 : 0));
            // An event brings the connectors that join it to its hub and to the next one down.
            if (token.Length == 4 && char.IsDigit(token[3]))
                for (int t = 0; t < names.Length; t++)
                    if (names[t].EndsWith("_" + token, StringComparison.Ordinal) || names[t].StartsWith(token + "_", StringComparison.Ordinal))
                        tracks.Add(t);
        }
        return (tracks, races, course);
    }

    private static bool IsSky(string name) => name.EndsWith("SKY", StringComparison.Ordinal);

    // ---------------------------------------------------------------- terrain

    /// <summary>
    /// SSX 3's patch surface byte, as the names the artists gave patches suggest, onto Tricky's surface enum.
    /// Unrecognised values stay rideable snow.
    /// [Trailmap: 510-surface, 511-surface-names]
    /// </summary>
    private static int SurfaceType(int ssx3) => ssx3 switch
    {
        2 => 3,   // powder
        3 => 4,   // deep powder
        4 => 5,   // ice
        9 => 12,  // trees / wood
        10 => 13, // metal
        _ => 1,   // snow
    };

    private static List<object> BuildPatches(List<(SSBResource res, WorldPatch patch)> patches,
        Dictionary<int, TexturePage> pages, HashSet<int> lightmaps)
    {
        var rows = new List<object>(patches.Count);
        foreach (var (_, patch) in patches)
        {
            var json = patch.ToJSON();
            if (patch.LightmapRID >= 0) lightmaps.Add(patch.LightmapRID);
            rows.Add(new
            {
                PatchName = patch.Name,
                LightMapPoint = CentreAddressedCell(json.LightMapPoint),
                json.UVPoints,
                json.Points,
                SurfaceType = SurfaceType(patch.U2),
                TrickOnlyPatch = false,
                TexturePath = patch.TextureRID >= 0 ? TexturePage.Use(pages, patch.TextureRID, PageUse.Terrain) : (object)"",
                LightmapID = patch.LightmapRID,
            });
        }
        return rows;
    }

    // ---------------------------------------------------------------- rails

    /// <summary>
    /// SSX 3 keeps grind rails and animation paths (birds, rockets, the gondola) in one spline list, with nothing
    /// but the name to tell them apart. Returns the Tricky grind style for a rail, or null for a path.
    /// [Trailmap: 514-splines]
    /// </summary>
    private static int? RailStyle(string name)
    {
        string n = name.ToLowerInvariant();
        if (n.Contains("gondola") || n.Contains("path") || n.Contains("handplant")) return null;
        bool wood = n.Contains("wood") || n.Contains("log") || n.Contains("tree") || n.Contains("branch")
                    || n.Contains("teeter") || n.Contains("fence") || n.Contains("bench");
        if (wood) return 12;
        if (n.Contains("rail") || n.Contains("slide") || n.Contains("boxcar") || n.Contains("curve") || n.Contains("pipe"))
            return 13;
        return null;
    }

    private static int WriteSplines(string mapDir, List<(SSBResource res, WorldSpline spline)> splines)
    {
        var rows = new List<object>();
        foreach (var (_, spline) in splines)
        {
            int? style = RailStyle(spline.Name);
            if (style is null) continue;
            var json = spline.ToJSON();
            rows.Add(new
            {
                SplineName = spline.Name,
                U0 = 1,
                U1 = 1,
                SplineStyle = style.Value,
                Segments = json.Segments.Select(s => new { s.Points }).ToList(),
            });
        }
        WriteJson(Path.Combine(mapDir, "Splines.json"), new { Splines = rows });
        return rows.Count;
    }

    // ---------------------------------------------------------------- course and AI

    /// <summary>
    /// Each section carries up to three AIP resources: its own event (RID 0), and on a hub the whole peak's race
    /// (RID 1) and showoff (RID 2). The course comes from the selection's race resources (<paramref name="races"/>):
    /// a single event uses its own; a peak or the whole mountain uses the peak races, with each lower peak's distances
    /// lifted by the length of the peaks below it so the lines chain top to bottom. Race lines are SSX 3's type-1
    /// track paths, whose float is the distance to the finish. The AI network is every AI path the selected sections
    /// carry (<see cref="AiNetwork"/>), since the peak races' own paths cover only the hubs.
    /// [Trailmap: 514-path-slots, 514-peak-coverage, 514-race-distance]
    /// </summary>
    private static void WriteAip(string mapDir, List<(SSBResource res, WorldAIP aip)> aips, HashSet<(int, int)> races, World world)
    {
        static IEnumerable<WorldAIP.TrackPath> Races(WorldAIP aip) => aip.trackPaths.Where(t => t.Type == 1);
        static List<float[]> Steps(List<Vector4> points) =>
            points.Select(p => Vec(new Vector3(p.X, p.Y, p.Z) * p.W)).ToList();

        // Order the races top to bottom (the highest start first), then offset distances so they chain.
        var chosen = aips.Where(a => races.Contains((a.res.Track, a.res.Rid)) && Races(a.aip).Any())
            .OrderByDescending(p => Races(p.aip).Max(t => t.PathPos.Z)).ToList();
        var offsets = new float[chosen.Count];
        for (int i = chosen.Count - 2; i >= 0; i--)
            offsets[i] = offsets[i + 1] + Races(chosen[i + 1].aip).Max(t => t.U2); // U2 is distance to finish

        var raceLines = new List<object>();
        for (int c = 0; c < chosen.Count; c++)
        {
            string section = world.Sections[chosen[c].res.Track];
            foreach (var t in Races(chosen[c].aip))
                raceLines.Add(new
                {
                    Name = $"{section} Race Line {raceLines.Count}",
                    DistanceToFinish = t.U2 + offsets[c],
                    PathPos = Vec(t.PathPos),
                    PathPoints = Steps(t.VectorPoints),
                    PathEvents = t.PathEvents,
                });
        }

        var (network, coursePaths) = AiNetwork(
            chosen.Select(c => (c.res.Track, c.aip)).ToList(),
            aips.Where(a => !chosen.Any(c => c.aip == a.aip)).Select(a => (a.res.Track, a.aip)));
        var aiPaths = network.Select((n, i) => new
        {
            Name = $"{world.Sections[n.Section]} AI Path {i}",
            U3 = 50,
            Respawnable = true,
            PathPos = Vec(n.Path.PathPos),
            PathPoints = Steps(n.Path.VectorPoints),
            PathEvents = n.Path.PathEvents,
        }).ToList();

        // The start grid is a set of positions, not path indices; the course's AI path that leaves each slot is
        // the nearest path start, which is the form Tricky's StartPosList takes.
        // [Trailmap: 514-start-slots]
        var startList = new List<int>();
        foreach (var slot in chosen.Select(c => c.aip.u1Structs).FirstOrDefault(g => g.Count > 0) ?? [])
        {
            Vector3 pos = slot.U2;
            int best = -1;
            float bestD = 1000f * 1000f; // within 10 m
            for (int i = 0; i < coursePaths; i++)
            {
                float d = Vector3.DistanceSquared(network[i].Path.PathPos, pos);
                if (d < bestD) { bestD = d; best = i; }
            }
            if (best >= 0 && !startList.Contains(best)) startList.Add(best);
        }

        WriteJson(Path.Combine(mapDir, "AIP.json"), new { StartPosList = startList, AIPaths = aiPaths, RaceLines = raceLines });
    }

    /// <summary>
    /// The selection's AI network in the order AIP.json lists it: the course's own paths first, in course order, and
    /// the first <c>coursePaths</c> of them are the ones the start grid is matched against; then every other path the
    /// selected sections carry (events', connectors' and hubs' own, the peak showoffs'), highest start first. A
    /// speed prediction that rides lines no gate or ridden line feeds takes them in list order, so top down it rides
    /// each path's feeders before the path.
    /// </summary>
    internal static (List<(int Section, WorldAIP.AIPath Path)> Paths, int CoursePaths) AiNetwork(
        IReadOnlyList<(int Section, WorldAIP Aip)> course, IEnumerable<(int Section, WorldAIP Aip)> others)
    {
        var paths = course.SelectMany(c => c.Aip.aiPaths.Select(p => (c.Section, p))).ToList();
        int coursePaths = paths.Count;
        paths.AddRange(others.SelectMany(o => o.Aip.aiPaths.Select(p => (o.Section, p)))
            .OrderByDescending(n => n.p.PathPos.Z));
        return (paths, coursePaths);
    }

    // ---------------------------------------------------------------- lights, halos and fog

    /// <summary>
    /// Lights.json, in the Tricky import's field names, from the selection's lights (type 6) and halos (type 7). SSX 3
    /// lights carry no names, so each is named after its section and resource id. Only spot and point lights are
    /// written. Every section also carries a sun and a sky ambient, but all except four connector suns and hub B's
    /// ambient are the same white, horizontal placeholder, and Slopesmith would seed the level's sun from the first
    /// one instead of fitting it to the lightmaps. A halo is a glow sprite with no light of its own, so it becomes a
    /// glint-only row (<see cref="HaloRow"/>).
    /// [Trailmap: 515-light-slots, 515-placeholder]
    /// </summary>
    private static (int lights, int halos) WriteLights(string mapDir, List<SSBResource> lights, List<SSBResource> halos, World world)
    {
        var rows = new List<object>();
        foreach (var r in lights)
            if (LightRow($"{world.Sections[r.Track]}_light_{r.Rid}", r.Data) is { } row) rows.Add(row);
        int lightRows = rows.Count;
        rows.AddRange(halos.Select(r => HaloRow($"{world.Sections[r.Track]}_halo_{r.Rid}", r.Data)));
        WriteJson(Path.Combine(mapDir, "Lights.json"), new { Lights = rows });
        return (lightRows, halos.Count);
    }

    /// <summary>
    /// One SSX 3 light record (112 bytes) as a Lights.json row, or null for a sun (type 0) or sky ambient (type 3).
    /// Words: 4 the type, numbered as Tricky's (1 spot, 2 point); 5 the intensity; 6 the colour's luminance; 7 the
    /// range; 8-10 the colour, 0 to 1; 11-13 the direction; 14-16 the position; 17-22 the influence box; 23 and 24
    /// the spot's inner and outer cone cosines, zero on a point light. Tricky's record stores the colour already
    /// multiplied by the intensity, so the row does too; a negative intensity makes the subtractive shadow light
    /// Tricky writes as a negative colour.
    /// [Trailmap: 515-light-record, 515-light-colour, 515-light-cone, 515-light-negative]
    /// </summary>
    internal static object? LightRow(string name, byte[] data)
    {
        int type = BitConverter.ToInt32(data, 16);
        if (type is not (1 or 2)) return null;
        float W(int word) => BitConverter.ToSingle(data, word * 4);
        float[] V(int word) => [W(word), W(word + 1), W(word + 2)];
        float intensity = W(5);
        return new
        {
            LightName = name,
            Type = type,
            SpriteRes = 0,
            Colour = new[] { W(8) * intensity, W(9) * intensity, W(10) * intensity },
            Direction = V(11),
            Position = V(14),
            LowestXYZ = V(17),
            HighestXYZ = V(20),
            UnknownFloat2 = W(24),
        };
    }

    /// <summary>
    /// One SSX 3 halo record (80 bytes) as a Lights.json row that only glints. Words: 3 the sprite size, 16 or 32;
    /// 4-6 the colour; 7-9 the position; 10-15 the sprite's box. The size goes to SpriteRes, the field a Tricky light's
    /// glint is gated on. The influence box is left empty at the position, so the halo lights nothing.
    /// [Trailmap: 515-halo-record, 515-halo-size]
    /// </summary>
    internal static object HaloRow(string name, byte[] data)
    {
        float W(int word) => BitConverter.ToSingle(data, word * 4);
        float[] position = [W(7), W(8), W(9)];
        return new
        {
            LightName = name,
            Type = 2,
            SpriteRes = BitConverter.ToInt32(data, 12),
            Colour = new[] { W(4), W(5), W(6) },
            Direction = new[] { 1f, 0f, 0f },
            Position = position,
            LowestXYZ = position,
            HighestXYZ = position,
            UnknownFloat2 = 0f,
        };
    }

    /// <summary>
    /// ParticleModels.json and ParticleInstances.json from the selection's particle models (type 4) and placements
    /// (type 5). These are the fog banks of Tricky's PBD: the same model layout (<see cref="ParticleModelRow"/>),
    /// and a placement with a world transform and a world box. Each model has exactly one placement, sharing its
    /// section and resource id.
    /// [Trailmap: 515-fog-placement]
    /// </summary>
    private static int WriteParticles(string mapDir, List<SSBResource> models, List<SSBResource> placements, World world)
    {
        var index = new Dictionary<(int, int), int>();
        var prefabs = new List<object>();
        foreach (var r in models)
        {
            index[(r.Track, r.Rid)] = prefabs.Count;
            prefabs.Add(ParticleModelRow($"{world.Sections[r.Track]}_particle_{r.Rid}", r.Data));
        }
        var particles = new List<object>();
        foreach (var r in placements)
        {
            if (!index.TryGetValue((r.Track, r.Rid), out int model)) continue;
            var placement = new WorldParticleInstance();
            placement.LoadData(new MemoryStream(r.Data));
            var (pos, rot, scale) = Decompose(placement.Transform);
            particles.Add(new
            {
                ParticleName = $"{world.Sections[r.Track]}_particle_{r.Rid}",
                Location = pos,
                Rotation = rot,
                Scale = scale,
                ParticleModelIndex = model,
                LowestXYZ = Vec(placement.AABBMin),
                HighestXYZ = Vec(placement.AABBMax),
            });
        }
        WriteJson(Path.Combine(mapDir, "ParticleModels.json"), new { ParticlePrefabs = prefabs });
        WriteJson(Path.Combine(mapDir, "ParticleInstances.json"), new { Particles = particles });
        return particles.Count;
    }

    /// <summary>
    /// One SSX 3 particle model as a ParticleModels.json row. It opens like Tricky's: an id in place of Tricky's byte
    /// size, the object count, and the offset of the object table. The second word of each table entry is the offset
    /// of its object from the record's start. The object holds its box, a word, the frame count and the offset of
    /// its frames from the object's start. Each frame is 28 bytes: a position, three floats and a radius.
    /// [Trailmap: 515-fog-model, 515-fog-puffs]
    /// </summary>
    internal static object ParticleModelRow(string name, byte[] data)
    {
        int I(int offset) => BitConverter.ToInt32(data, offset);
        float F(int offset) => BitConverter.ToSingle(data, offset);
        float[] V(int offset) => [F(offset), F(offset + 4), F(offset + 8)];
        var headers = new List<object>();
        for (int h = 0; h < I(4); h++)
        {
            int obj = I(I(8) + h * 16 + 4), frames = obj + I(obj + 32);
            headers.Add(new
            {
                ParticleObject = new
                {
                    LowestXYZ = V(obj),
                    HighestXYZ = V(obj + 12),
                    U1 = I(obj + 24),
                    AnimationFrames = Enumerable.Range(0, I(obj + 28)).Select(f => new
                    {
                        Position = V(frames + f * 28),
                        Rotation = V(frames + f * 28 + 12),
                        Unknown = F(frames + f * 28 + 24),
                    }).ToList(),
                },
            });
        }
        return new { ParticleModelName = name, ParticleObjectHeaders = headers };
    }

    // ---------------------------------------------------------------- props

    private static (int count, List<object> materials) WriteProps(string mapDir,
        List<(SSBResource res, WorldInstance inst)> instances, Dictionary<(int, int), byte[]> modelData,
        Dictionary<(int, int), WorldBin0> materialData, Dictionary<string, string> collisionFiles, World world,
        Dictionary<int, TexturePage> pages)
    {
        string meshDir = Path.Combine(mapDir, "Meshes");

        var modelIds = new Dictionary<(int, int), int?>();
        var models = new List<object>();
        var materialIds = new Dictionary<(int, int), int>();
        var materials = new List<object>();
        var rows = new List<object>();
        var helperModels = new HashSet<int>();
        var lightingStreams = new Dictionary<int, int>(); // model id -> vertices in its vertex-lighting stream

        int Material((int track, int rid) key)
        {
            if (materialIds.TryGetValue(key, out int id)) return id;
            materialIds[key] = id = materials.Count;
            materialData.TryGetValue(key, out var m);
            // Tricky's appearance-word bit 18 puts a material in the alpha pass, where Slopesmith reads the page's
            // own alpha to choose between alpha-test holes and blending - exactly the choice SSX 3's flag makes.
            int appearance = m != null ? Appearance(m.U7) : 0;
            PageRef? texture = m is { TextureID: >= 0 }
                ? TexturePage.Use(pages, m.TextureID, appearance != 0 ? PageUse.AlphaPass : PageUse.Opaque)
                : null;
            materials.Add(new { MaterialName = $"mat_{key.track}_{key.rid}", TexturePath = texture, TextureFlipbook = Array.Empty<string>(), UnknownInt18 = appearance });
            return id;
        }

        int? Model((int track, int rid) key)
        {
            if (modelIds.TryGetValue(key, out int? known)) return known;
            modelIds[key] = null;
            if (!modelData.TryGetValue(key, out var data)) return null;
            var mdr = new WorldMDR();
            var stdout = Console.Out;
            try
            {
                Console.SetOut(TextWriter.Null); // the decoder narrates every record it recovers
                mdr.LoadData(new MemoryStream(data));
            }
            catch (Exception ex)
            {
                Console.SetOut(stdout);
                Log.Warn($"  model {world.Sections[key.track]}/{key.rid}: {ex.Message}");
                return null;
            }
            finally { Console.SetOut(stdout); }

            var objects = new List<object>();
            int part = 0, stream = 0;
            for (int o = 0; o < mdr.ModelObjects.Count; o++)
            {
                var obj = mdr.ModelObjects[o];
                var meshData = new List<object>();
                foreach (var header in obj.unknownS2.ModelHeaderOffset ?? [])
                {
                    var (mesh, vertices, faces) = StreamMesh(header);
                    int lightingBase = stream;
                    stream += vertices;
                    if (faces == 0) continue;
                    string meshPath = $"m{key.track}_{key.rid}_{part++}.obj";
                    File.WriteAllText(Path.Combine(meshDir, meshPath), mesh);
                    int materialId = header.MaterialID >= 0 && header.MaterialID < mdr.MaterialList.Count
                        ? Material((mdr.MaterialList[header.MaterialID].TrackID, mdr.MaterialList[header.MaterialID].RID))
                        : -1;
                    meshData.Add(new { MeshPath = meshPath, MaterialID = materialId, VertexLightingBase = lightingBase });
                }
                bool hasMatrix = obj.MatrixOffset > 0;
                var (pos, rot, scale) = hasMatrix ? Decompose(obj.matrix4X4) : (null, null, null);
                objects.Add(new
                {
                    ObjectName = $"Model Object {o}",
                    obj.ParentID,
                    Flags = 0,
                    Animation = (object?)null,
                    MeshData = meshData,
                    Position = pos,
                    Rotation = rot,
                    Scale = scale,
                    IncludeAnimation = false,
                    IncludeMatrix = hasMatrix,
                });
            }
            if (part == 0) return null;
            if (mdr.MaterialList.Count > 0 && mdr.MaterialList.All(material =>
                    materialData.TryGetValue((material.TrackID, material.RID), out var m) && m.TextureID == HelperTexture))
                helperModels.Add(models.Count);
            lightingStreams[models.Count] = stream;
            modelIds[key] = models.Count;
            models.Add(new
            {
                ModelName = world.Name(NameModel, key.track, key.rid) ?? $"mdl_{key.track}_{key.rid}",
                Unknown3 = 0,
                AnimTime = 0f,
                ModelObjects = objects,
            });
            return models.Count - 1;
        }

        var sharedCollision = CollisionByModel(
            instances.Select(i => (i.res.Track, i.inst.Name, i.inst.ModelID.TrackID, i.inst.ModelID.RID)), collisionFiles);
        foreach (var (res, inst) in instances)
        {
            int? model = Model((inst.ModelID.TrackID, inst.ModelID.RID));
            if (model is null) continue;
            var (pos, rot, scale) = Decompose(inst.matrix4X4);
            var (visible, solid) = Classify(inst.Name, helperModels.Contains(model.Value));
            string? collide = solid
                ? collisionFiles.GetValueOrDefault(inst.Name)
                    ?? sharedCollision.GetValueOrDefault((res.Track, inst.ModelID.TrackID, inst.ModelID.RID))
                : null;
            rows.Add(new
            {
                InstanceName = inst.Name,
                Location = pos,
                Rotation = rot,
                Scale = scale,
                ModelID = model.Value,
                Visable = visible,
                PlayerCollision = collide != null,
                SurfaceType = -1,
                CollsionMode = collide != null ? 1 : 0,
                CollsionModelPaths = collide != null ? new[] { collide } : null,
                PhysicsIndex = -1,
                EffectSlotIndex = -1,
                VertexLighting = VertexLighting(inst.VertexColors, lightingStreams[model.Value]),
            });
        }

        WriteJson(Path.Combine(mapDir, "Instances.json"), new { Instances = rows });
        WriteJson(Path.Combine(mapDir, "Models.json"), new { Models = models });
        return (rows.Count, materials);
    }

    /// <summary>
    /// SSX 3's material render-state word: 1 draws opaque, bit 0x2 alpha-tests (3), bit 0x4 blends (7), and bit 0x40
    /// marks the additive glows. Measured against the pages' own alpha across the whole mountain.
    /// [Trailmap: 512-render-state, 512-state-vs-alpha]
    /// </summary>
    private const int AlphaStates = 0x46;

    /// <summary>Tricky's appearance-word bit 18: the material draws in the alpha pass.</summary>
    private const int AlphaPass = 0x40000;

    /// <summary>
    /// SSX 3's orange debug page. Every model drawn only with it is helper geometry the game never shows - the
    /// collision fences, trigger, one-way and fail volumes, reset planes, teleports, and the load/unload and
    /// ride-state boxes - and no visible prop uses it.
    /// [Trailmap: 512-debug-page, 513-helpers]
    /// </summary>
    private const int HelperTexture = 17;

    /// <summary>
    /// The helpers that borrow a real page instead, by the names SSX 3 gives them. `trig` is kept off `startright`,
    /// a visible fence.
    /// [Trailmap: 513-helpers]
    /// </summary>
    private static readonly Regex HelperName = new(
        @"reset|volume|trig(?!h)|teleport|ridestate|_(un)?load(_|$)|emit|occluder|portal|invis|nis_",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>
    /// The helpers that are walls in play: the invisible fences and fence proxies lining a course. Reset planes and
    /// volumes carry collision too but would be plain walls without their effects, the start- and end-mode gates
    /// close only during an event, a cutscene's fences only during the cutscene, and `noCollide` art is visible.
    /// [Trailmap: 513-helper-proxies]
    /// </summary>
    private static readonly Regex FenceCollision = new(
        @"(?<!no)collision|proxy|fence_coll_plane", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    /// <summary>
    /// Whether an instance is drawn, and whether its collision resource (if it has one) blocks the rider.
    /// <paramref name="debugPageOnly"/> is true when its model is drawn only with <see cref="HelperTexture"/>.
    /// </summary>
    internal static (bool Visible, bool Solid) Classify(string instanceName, bool debugPageOnly)
    {
        bool fence = FenceCollision.IsMatch(instanceName) && !instanceName.Contains("nis", StringComparison.OrdinalIgnoreCase);
        bool helper = fence || debugPageOnly || HelperName.IsMatch(instanceName);
        return (!helper, !helper || fence);
    }

    /// <summary>The Tricky appearance word for an SSX 3 material's render-state word.</summary>
    internal static int Appearance(int renderState) => (renderState & AlphaStates) != 0 ? AlphaPass : 0;

    /// <summary>
    /// SSX 3 keeps a collidable model's collision once in each section that places it, in the model's own space,
    /// named after the first instance there with a `_CollideModel_ConvexHull` or `_CollideModel_ProgMesh`
    /// suffix. Writes each one to Collision/ as the triangle proxy Tricky's props use, and returns the file by
    /// that instance's name; <see cref="CollisionByModel"/> shares it with the model's other instances.
    /// [Trailmap: 513-proxy-kinds, 513-model-space, 513-binding]
    /// </summary>
    private static Dictionary<string, string> WriteCollision(string mapDir, List<(string name, WorldCollision collision)> collisions)
    {
        var files = new Dictionary<string, string>();
        var inv = CultureInfo.InvariantCulture;
        foreach (var (name, collision) in collisions)
        {
            int cut = name.IndexOf("_CollideModel", StringComparison.Ordinal);
            if (cut <= 0 || collision.Models.Count == 0) continue;
            string instance = name[..cut];
            if (files.ContainsKey(instance)) continue;
            var sb = new StringBuilder();
            int based = 1;
            var faces = new StringBuilder();
            foreach (var model in collision.Models)
            {
                foreach (var v in model.Vectors) sb.Append(inv, $"v {v.X} {v.Y} {v.Z}\n");
                foreach (var f in model.Indices)
                    faces.Append(inv, $"f {f.Index1 + based} {f.Index2 + based} {f.Index3 + based}\n");
                based += model.Vectors.Count;
            }
            string file = $"c{files.Count}.obj";
            File.WriteAllText(Path.Combine(mapDir, "Collision", file), sb.Append(faces).ToString());
            files[instance] = file;
        }
        return files;
    }

    /// <summary>
    /// The collision file each placed model shares within a section, from the instances its resources are named
    /// after. Across the mountain every section that places a collidable model carries its resource, so one
    /// boulder model's 439 placements read the one file named after the first of them.
    /// [Trailmap: 513-binding, 513-coverage]
    /// </summary>
    internal static Dictionary<(int Section, int ModelTrack, int ModelRid), string> CollisionByModel(
        IEnumerable<(int Section, string Name, int ModelTrack, int ModelRid)> instances,
        IReadOnlyDictionary<string, string> byOwner)
    {
        var shared = new Dictionary<(int, int, int), string>();
        foreach (var (section, name, modelTrack, modelRid) in instances)
            if (byOwner.TryGetValue(name, out string? file)) shared.TryAdd((section, modelTrack, modelRid), file);
        return shared;
    }

    private static (float[] pos, float[] rot, float[] scale) Decompose(Matrix4x4 m)
    {
        if (!Matrix4x4.Decompose(m, out var scale, out var rotation, out var translation))
        {
            // A mirrored placement: pull the reflection into X so the rest decomposes as a rotation.
            var mirrored = Matrix4x4.CreateScale(-1, 1, 1) * m;
            Matrix4x4.Decompose(mirrored, out scale, out rotation, out translation);
            scale.X = -scale.X;
            translation = m.Translation;
        }
        return (Vec(translation), [rotation.X, rotation.Y, rotation.Z, rotation.W], Vec(scale));
    }

    /// <summary>
    /// One model part as OBJ text, with its vertices in the game's own vertex stream: every vertex/UV record of the
    /// part, in order, one `v`, `vt` and `vn` per stream vertex. An instance's baked lighting holds one colour per
    /// stream vertex across all of the model's parts, so OBJ vertex <c>i</c> of a part lights from colour
    /// <c>VertexLightingBase + i</c>. Faces are the records' triangle strips, cut and wound exactly as
    /// <see cref="WorldMDR.GenerateFaces"/> cuts them. A record whose normal record is missing still holds its
    /// place in the stream but draws nothing, as in the decoder.
    /// [Trailmap: 513-vertex-light]
    /// </summary>
    internal static (string Obj, int Vertices, int Faces) StreamMesh(WorldMDR.ModelDataHeaderStruct header)
    {
        var inv = CultureInfo.InvariantCulture;
        var head = new StringBuilder();
        var f = new StringBuilder();
        int based = 0, faces = 0;
        var records = header.ModelOffsetHeaders ?? [];
        for (int b = 0; b + 1 < records.Count; b += 2)
        {
            var data = records[b].modelVandUVData;
            if (data.Vertices is not { } vertices || data.UV is not { } uvs) continue;
            var normals = records[b + 1].modelNormalData.Normals;
            bool drawn = normals is { Count: > 0 } && data.Tristrip != null;
            for (int i = 0; i < vertices.Count; i++)
            {
                var p = vertices[i];
                var uv = i < uvs.Count ? uvs[i] : Vector2.Zero;
                var nn = drawn ? normals![Math.Min(i, normals.Count - 1)] : Vector3.UnitZ;
                head.Append(inv, $"v {p.X} {p.Y} {p.Z}\n");
                head.Append(inv, $"vt {uv.X} {1 - uv.Y}\n"); // OBJ's V runs up
                head.Append(inv, $"vn {nn.X} {nn.Y} {nn.Z}\n");
            }
            if (drawn)
            {
                var cuts = new HashSet<int> { 0 };
                int run = 0;
                foreach (int length in data.Tristrip!) cuts.Add(run += length);
                int local = 0;
                bool flip = false;
                for (int i = 0; i < vertices.Count; i++)
                {
                    if (cuts.Contains(i)) { flip = false; local = 1; continue; }
                    if (local < 2) { local++; continue; }
                    var (a, c) = flip ? (i, i - 2) : (i - 2, i);
                    int A = based + a + 1, B = based + i, C = based + c + 1; // B is i - 1, 1-based
                    f.Append(inv, $"f {A}/{A}/{A} {B}/{B}/{B} {C}/{C}/{C}\n");
                    faces++;
                    flip = !flip;
                    local++;
                }
            }
            based += vertices.Count;
        }
        return (head.Append(f).ToString(), based, faces);
    }

    /// <summary>
    /// An instance's baked vertex lighting as the base64 of its raw ABGR1555 halfwords, little-endian, one per vertex
    /// of its model's stream (<see cref="StreamMesh"/>); null when the tail does not cover the model exactly.
    /// [Trailmap: 513-vertex-light, 513-vertex-light-placement]
    /// </summary>
    internal static string? VertexLighting(IReadOnlyList<int> colours, int streamVertices)
    {
        if (streamVertices == 0 || colours.Count != streamVertices) return null;
        var bytes = new byte[colours.Count * 2];
        for (int i = 0; i < colours.Count; i++)
            System.Buffers.Binary.BinaryPrimitives.WriteUInt16LittleEndian(bytes.AsSpan(i * 2), (ushort)colours[i]);
        return Convert.ToBase64String(bytes);
    }

    /// <summary>
    /// Re-scale an SSX 3 lightmap texel onto Tricky's encoding. Both store the GS blend's two terms - alpha the
    /// light intensity A_S, RGB the residual C_S subtracted from the framebuffer - but Tricky's textures sit on
    /// disc at PS2 half brightness while SSX 3's are full range, so the residual is subtracted from a base twice
    /// as bright. The lit result (C_D - C_S)·A_S/128 is Tricky's (0.5·C_D - C_S')·A_S'/128 with
    /// C_S' = C_S/2 and A_S' = 2·A_S. Where 2·A_S overflows a byte, the texel is re-encoded at full alpha for a
    /// white base, which is what snow is.
    /// [Trailmap: 511-lm-terms, 511-lm-base, 512-full-range]
    /// </summary>
    private enum PageUse { Terrain, AlphaPass, Opaque }

    /// <summary>How the records on one texture page use it, and the file each use reads once it is decoded.</summary>
    private sealed class TexturePage(int rid)
    {
        public bool Terrain, AlphaPass, Opaque;
        public string TerrainFile = PageName(rid), AlphaFile = PageName(rid), OpaqueFile = PageName(rid);

        public static PageRef Use(Dictionary<int, TexturePage> pages, int rid, PageUse use)
        {
            if (!pages.TryGetValue(rid, out var page)) pages[rid] = page = new TexturePage(rid);
            switch (use)
            {
                case PageUse.Terrain: page.Terrain = true; return new PageRef(() => page.TerrainFile);
                case PageUse.AlphaPass: page.AlphaPass = true; return new PageRef(() => page.AlphaFile);
                default: page.Opaque = true; return new PageRef(() => page.OpaqueFile);
            }
        }
    }

    /// <summary>A record's texture, written as whichever file its use resolved to.</summary>
    [JsonConverter(typeof(PageRefConverter))]
    private sealed record PageRef(Func<string> File);

    private sealed class PageRefConverter : JsonConverter<PageRef>
    {
        public override void WriteJson(JsonWriter writer, PageRef? value, JsonSerializer serializer) =>
            writer.WriteValue(value?.File());

        public override PageRef ReadJson(JsonReader reader, Type objectType, PageRef? existingValue, bool hasExistingValue,
            JsonSerializer serializer) => throw new NotSupportedException();
    }

    /// <summary>
    /// SSX 3 keeps a glitter and gloss mask in many pages' alpha - most of the icy and carved terrain, and much of the
    /// opaque prop art - rather than transparency. Slopesmith reads alpha as coverage, and packs pages through a
    /// premultiplied canvas that loses the colour under low alpha: the masked streaks came out flat grey and
    /// posterised, and a mask that happens to look binary would punch holes in the ground. So a page keeps its alpha
    /// only for a use that means it - an alpha-pass prop material, or terrain whose alpha really is a hole mask, like
    /// the trusses on EBA3's metal ramp - and is otherwise written opaque. A page with both kinds of use gets an
    /// opaque copy beside it.
    /// [Trailmap: 512-terrain-mask, 512-mask-pass]
    /// </summary>
    private static void WritePage(string mapDir, int rid, TexturePage page, Image<Rgba32> image)
    {
        bool holes = page.Terrain && IsHoleMask(image);
        bool keepAlpha = page.AlphaPass || holes;
        bool opaque = page.Opaque || page.Terrain && !holes;
        page.AlphaFile = PageName(rid);
        page.OpaqueFile = keepAlpha ? PageName(rid, "_o") : PageName(rid);
        page.TerrainFile = holes ? page.AlphaFile : page.OpaqueFile;
        if (keepAlpha) image.SaveAsPng(Path.Combine(mapDir, "Textures", page.AlphaFile));
        if (!opaque) return;
        using var solid = image.Clone();
        MakeOpaque(solid);
        solid.SaveAsPng(Path.Combine(mapDir, "Textures", page.OpaqueFile));
    }

    /// <summary>
    /// A terrain page whose alpha cuts real holes: a large clear area and a large solid one. SSX 3's gloss masks
    /// are almost never solid, so they fail the second test however clear they are.
    /// [Trailmap: 512-cutout]
    /// </summary>
    internal static bool IsHoleMask(Image<Rgba32> image)
    {
        long clear = 0, solid = 0;
        image.ProcessPixelRows(rows =>
        {
            for (int y = 0; y < rows.Height; y++)
                foreach (var p in rows.GetRowSpan(y))
                {
                    if (p.A < 8) clear++;
                    else if (p.A >= 250) solid++;
                }
        });
        long total = (long)image.Width * image.Height;
        return clear * 20 >= total && solid * 4 >= total;
    }

    internal static void MakeOpaque(Image<Rgba32> image) =>
        image.ProcessPixelRows(rows =>
        {
            for (int y = 0; y < rows.Height; y++)
                foreach (ref var p in rows.GetRowSpan(y)) p.A = 255;
        });

    /// <summary>
    /// SSX 3 addresses a patch's lightmap cell edge to edge, as the GS samples a texture coordinate: a patch corner
    /// sits on the outer edge of its cell's corner texel, so the patches either side of a seam both read the blend
    /// of the texels straddling it, and meet exactly. That is why its cells are 2, 6, 14 or 30 texels. Tricky's
    /// cells, and Slopesmith's lookup, put the corner on the corner texel's centre instead, which leaves every
    /// SSX 3 seam half a texel off on each side.
    ///
    /// The page is resampled, bilinearly as the GS filters it, onto a 128 px grid whose texel centres fall on the
    /// source's texel edges at every page size; <see cref="CentreAddressedCell"/> then widens each cell by the one
    /// texel that takes, so Slopesmith's centre lookup reads what the game does.
    /// [Trailmap: 511-lm-slots, 511-lm-edges]
    /// </summary>
    internal static Image<Rgba32> ToCentreAddressed(Image<Rgba32> source)
    {
        const int Size = 128;
        int w = source.Width, h = source.Height;
        var texels = new Vector4[w * h];
        source.ProcessPixelRows(rows =>
        {
            for (int y = 0; y < h; y++)
            {
                var row = rows.GetRowSpan(y);
                for (int x = 0; x < w; x++) texels[y * w + x] = row[x].ToVector4();
            }
        });
        Vector4 At(int x, int y) => texels[Math.Clamp(y, 0, h - 1) * w + Math.Clamp(x, 0, w - 1)];

        var page = new Image<Rgba32>(Size, Size);
        page.ProcessPixelRows(rows =>
        {
            for (int y = 0; y < Size; y++)
            {
                // Output texel j sits at source position j/k in texel units, k = Size/size: a source texel edge.
                float sy = y * (float)h / Size - 0.5f;
                int y0 = (int)MathF.Floor(sy);
                float fy = sy - y0;
                var row = rows.GetRowSpan(y);
                for (int x = 0; x < Size; x++)
                {
                    float sx = x * (float)w / Size - 0.5f;
                    int x0 = (int)MathF.Floor(sx);
                    float fx = sx - x0;
                    var top = Vector4.Lerp(At(x0, y0), At(x0 + 1, y0), fx);
                    var bottom = Vector4.Lerp(At(x0, y0 + 1), At(x0 + 1, y0 + 1), fx);
                    row[x] = Rgba32.FromVector4(Vector4.Lerp(top, bottom, fy));
                }
            }
        });
        return page;
    }

    /// <summary>
    /// A patch's cell on a <see cref="ToCentreAddressed"/> page: the same start, one texel wider, so Slopesmith's
    /// lookup runs from the cell's first edge to its last.
    /// </summary>
    internal static float[] CentreAddressedCell(float[] cell) =>
        cell.Length < 4 ? cell : [cell[0], cell[1], cell[2] + 1f / 128, cell[3] + 1f / 128];

    internal static void ToTrickyLightmap(Image<Rgba32> image)
    {
        image.ProcessPixelRows(rows =>
        {
            for (int y = 0; y < rows.Height; y++)
            {
                var row = rows.GetRowSpan(y);
                for (int x = 0; x < row.Length; x++)
                {
                    ref var p = ref row[x];
                    if (p.A * 2 <= 255)
                    {
                        p = new Rgba32((byte)(p.R / 2), (byte)(p.G / 2), (byte)(p.B / 2), (byte)(p.A * 2));
                        continue;
                    }
                    float k = p.A / 128f;
                    byte Residual(byte c) => (byte)Math.Clamp(MathF.Round((0.5f - (1 - c / 255f) * k / (255f / 128f)) * 255f), 0, 255);
                    p = new Rgba32(Residual(p.R), Residual(p.G), Residual(p.B), 255);
                }
            }
        });
    }

    // ---------------------------------------------------------------- sky

    /// <summary>
    /// Each hub letter has a sky section (ASKY .. ESKY) holding one camera-centred dome: a cap, a floor, and a ring
    /// of eight upper and eight lower wall panels. Tricky's sky ring has the same two bands, so the walls are
    /// rebuilt as the flat quads that ring is made of - at their own azimuths, between the measured band heights -
    /// and the floor is flattened into the ground slot. The cap has no slot in the ring and is left out.
    /// SkyboxExporter then measures Ring.json and bakes Skybox.obj exactly as it does for a Tricky import.
    /// Returns the texture page each written slot needs, by slot index.
    /// [Trailmap: 514-sky]
    /// </summary>
    private static Dictionary<int, int> WriteSky(string mapDir, byte[] data, Dictionary<(int, int), WorldBin0> materialData)
    {
        var mdr = new WorldMDR();
        var stdout = Console.Out;
        try
        {
            Console.SetOut(TextWriter.Null);
            mdr.LoadData(new MemoryStream(data));
        }
        finally { Console.SetOut(stdout); }

        // One textured part per dome object.
        var parts = new List<(List<WorldMDR.ModelFace> faces, int texture)>();
        foreach (var obj in mdr.ModelObjects)
            foreach (var header in obj.unknownS2.ModelHeaderOffset ?? [])
            {
                if (header.modelFaces is not { Count: > 0 }) continue;
                int texture = header.MaterialID >= 0 && header.MaterialID < mdr.MaterialList.Count
                    && materialData.TryGetValue((mdr.MaterialList[header.MaterialID].TrackID, mdr.MaterialList[header.MaterialID].RID), out var m)
                    ? m.TextureID : -1;
                parts.Add((header.modelFaces, texture));
            }
        static IEnumerable<(Vector3 p, Vector2 uv)> Corners(List<WorldMDR.ModelFace> faces) =>
            faces.SelectMany(f => new[] { (f.V1, f.UV1), (f.V2, f.UV2), (f.V3, f.UV3) });
        static float Radius(Vector3 p) => MathF.Sqrt(p.X * p.X + p.Y * p.Y);
        static float Top(List<WorldMDR.ModelFace> faces) => Corners(faces).Max(c => c.p.Z);
        static float Bottom(List<WorldMDR.ModelFace> faces) => Corners(faces).Min(c => c.p.Z);

        // The cap and the floor are the two parts that cross the dome's axis; the walls never come near it.
        var axial = parts.Where(part => Corners(part.faces).Min(c => Radius(c.p)) < 1f).ToList();
        var walls = parts.Except(axial).ToList();
        if (axial.Count == 0 || walls.Count < 4) return [];
        var floor = axial.MinBy(part => Bottom(part.faces));

        float top = walls.Max(w => Top(w.faces));
        var upper = walls.Where(w => MathF.Abs(Top(w.faces) - top) < 0.5f).ToList();
        var lower = walls.Except(upper).ToList();
        float mid = upper.Min(w => Bottom(w.faces));
        float bottom = lower.Count > 0 ? lower.Min(w => Bottom(w.faces)) : mid - (top - mid) / 2;
        float radius = upper.SelectMany(w => Corners(w.faces)).Average(c => Radius(c.p));

        string meshDir = Path.Combine(mapDir, "Skybox", "Meshes");
        var inv = CultureInfo.InvariantCulture;
        var pages = new Dictionary<int, int>();
        var meshes = new List<object>();
        var materials = new List<object>();
        void Slot(string obj, int texture)
        {
            int slot = pages.Count;
            File.WriteAllText(Path.Combine(meshDir, slot.ToString(inv) + ".obj"), obj);
            pages[slot] = texture;
            meshes.Add(new { MeshPath = $"{slot}.obj", MaterialID = slot });
            materials.Add(new { MaterialName = $"Skybox Material {slot}", TexturePath = PageName(slot), TextureFlipbook = Array.Empty<string>() });
        }

        foreach (var (band, from, to) in new[] { (upper, top, mid), (lower, mid, bottom) })
            foreach (var (faces, texture) in band.OrderByDescending(w => Azimuth(Corners(w.faces).MinBy(c => c.uv.X).p)))
            {
                // The panel's edge columns are its least and greatest U; their bearings are the panel's span.
                var corners = Corners(faces).ToList();
                float u0 = corners.Min(c => c.uv.X), u1 = corners.Max(c => c.uv.X);
                float a0 = Azimuth(corners.First(c => c.uv.X == u0).p), a1 = Azimuth(corners.First(c => c.uv.X == u1).p);
                var sb = new StringBuilder();
                foreach (var (a, z) in new[] { (a0, from), (a0, to), (a1, from), (a1, to) })
                    sb.Append(inv, $"v {radius * MathF.Cos(a)} {radius * MathF.Sin(a)} {z}\n");
                sb.Append(inv, $"vt {u0} 1\nvt {u0} 0\nvt {u1} 1\nvt {u1} 0\n");
                sb.Append("f 1/1 2/2 3/3\nf 4/4 3/3 2/2\n");
                Slot(sb.ToString(), texture);
            }

        // The floor keeps its own layout and UVs, laid flat at the bottom band.
        var index = new Dictionary<(Vector2, Vector2), int>();
        var ground = new StringBuilder();
        var tris = new StringBuilder();
        foreach (var face in floor.faces)
        {
            tris.Append('f');
            foreach (var (p, uv) in new[] { (face.V1, face.UV1), (face.V2, face.UV2), (face.V3, face.UV3) })
            {
                var key = (new Vector2(p.X, p.Y), uv);
                if (!index.TryGetValue(key, out int i))
                {
                    index[key] = i = index.Count + 1;
                    ground.Append(inv, $"v {p.X} {p.Y} {bottom}\n");
                }
                tris.Append(inv, $" {i}/{i}");
            }
            tris.Append('\n');
        }
        foreach (var (_, uv) in index.Keys) ground.Append(inv, $"vt {uv.X} {1 - uv.Y}\n");
        Slot(ground.Append(tris).ToString(), floor.texture);

        WriteJson(Path.Combine(mapDir, "Skybox", "Models.json"), new
        {
            Models = new[]
            {
                new
                {
                    ModelName = "Skybox Model 0",
                    Unknown3 = 0,
                    AnimTime = 0f,
                    ModelObjects = new[]
                    {
                        new { ObjectName = "Skybox Object 0", ParentID = -1, Flags = 0, Animation = (object?)null, MeshData = meshes },
                    },
                },
            },
        });
        WriteJson(Path.Combine(mapDir, "Skybox", "Materials.json"), new { Materials = materials });
        return pages;
    }

    private static float Azimuth(Vector3 p) => MathF.Atan2(p.Y, p.X);

    // ---------------------------------------------------------------- shared

    private static string PageName(int rid, string variant = "") =>
        rid.ToString("D4", CultureInfo.InvariantCulture) + variant + ".png";

    private static float[] Vec(Vector3 v) => [v.X, v.Y, v.Z];

    private static Image<Rgba32>? DecodeShape(byte[] data)
    {
        try
        {
            var ssh = new WorldSSH();
            ssh.Load(new MemoryStream(data));
            return ssh.bitmap;
        }
        catch (Exception ex)
        {
            Log.Warn($"  shape decode failed: {ex.Message}");
            return null;
        }
    }

    private static void WriteJson(string path, object value) =>
        File.WriteAllText(path, JsonConvert.SerializeObject(value, Formatting.None), new UTF8Encoding(false));

    /// <summary>BAM.BIG's members, extracted once per disc into the temp folder and reused.</summary>
    private string ExtractWorld(string isoPath)
    {
        var info = new FileInfo(isoPath);
        if (!info.Exists) throw new FileNotFoundException("ISO not found", isoPath);
        string work = Path.Combine(Path.GetTempPath(), $"snowknife_ssx3_{info.Length:x}");
        string ssb = Path.Combine(work, "data", "worlds", "bam.ssb");
        if (File.Exists(ssb)) return ssb;
        Directory.CreateDirectory(work);
        string big = Path.Combine(work, "BAM.BIG");
        iso.ExtractFile(isoPath, WorldBig, big);
        BIG.Extract(big, work);
        File.Delete(big);
        if (!File.Exists(ssb)) throw new InvalidDataException($"{WorldBig} has no data/worlds/bam.ssb - is this an SSX 3 disc?");
        return ssb;
    }

    /// <summary>The SDB's section names and the PHM/PSM name tables, keyed for lookup.</summary>
    private sealed class World
    {
        public required string Ssb { get; init; }
        public required string[] Sections { get; init; }
        private readonly Dictionary<(int, int, int), string> names = new();

        public string? Name(int family, int track, int rid) => names.GetValueOrDefault((family, track, rid));

        public static World Load(string ssb)
        {
            var sdb = new SDBHandler();
            sdb.LoadSBD(Path.ChangeExtension(ssb, ".sdb"));
            var phm = new PHMHandler();
            phm.LoadPHM(Path.ChangeExtension(ssb, ".phm"));
            var psm = new PSMHandler();
            psm.LoadPSM(Path.ChangeExtension(ssb, ".psm"));

            var world = new World
            {
                Ssb = ssb,
                Sections = sdb.locations.Select(l => l.Name.TrimEnd('\0').Trim().ToUpperInvariant()).ToArray(),
            };
            for (int family = 0; family < Math.Min(phm.resourceLinks.Count, psm.nameLists.Count); family++)
            {
                var entries = phm.resourceLinks[family].Entries;
                var strings = psm.nameLists[family].strings;
                for (int i = 0; i < Math.Min(entries.Count, strings.Count); i++)
                    world.names.TryAdd((family, entries[i].TrackID, (int)entries[i].RID), strings[i]);
            }
            return world;
        }
    }
}
