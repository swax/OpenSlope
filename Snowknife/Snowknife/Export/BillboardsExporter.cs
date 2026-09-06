using System.Globalization;
using System.Numerics;
using Newtonsoft.Json;
using Snowknife.Bundle;
using Snowknife.Services;

namespace Snowknife.Export;

/// <summary>One video-ready screen rectangle: a flat quad sitting just off a billboard's ad face.</summary>
public sealed class BillboardScreenDocument
{
    /// <summary>Unique within the document; a consumer may name its object after it.</summary>
    public string Name { get; set; } = "";
    /// <summary>What the screen sits on — the billboard model family for a detected screen. Consumers group by it.</summary>
    public string? Family { get; set; }
    /// <summary>Screen centre, SSX mesh space (X negated, cm).</summary>
    public float[] Center { get; set; } = new float[3];
    /// <summary>Unit normal out of the screen, toward the viewer.</summary>
    public float[] Normal { get; set; } = { 0f, -1f, 0f };
    /// <summary>Unit up direction of the image, perpendicular to <see cref="Normal"/>.</summary>
    public float[] Up { get; set; } = { 0f, 0f, 1f };
    public float Width { get; set; }
    public float Height { get; set; }
    /// <summary>The Instances.json row this screen was found on, when it has one.</summary>
    public int? Instance { get; set; }
    /// <summary>The texture page the covered face draws, when the screen was measured from one.</summary>
    public string? Page { get; set; }
}

/// <summary>
/// <c>Billboards.json</c> — the map-folder contract for a course's video screens, written either by the
/// detector below (an extracted map) or by Slopesmith (an authored one), and read back by
/// <see cref="Snowknife.Bundle.BillboardBundle"/> into the bundle manifest.
/// </summary>
public sealed class BillboardsDocument
{
    public const string FileName = "Billboards.json";
    public const string SchemaId = "openslope-billboards/v1";
    /// <summary>Measured from this map's own prop geometry.</summary>
    public const string DetectedSource = "detected";
    /// <summary>Placed by hand; the detector leaves it alone.</summary>
    public const string AuthoredSource = "authored";

    public string Schema { get; set; } = SchemaId;
    public string Source { get; set; } = DetectedSource;
    public List<BillboardScreenDocument> Screens { get; set; } = new();

    public static BillboardsDocument? Load(string levelDir)
    {
        string path = Path.Combine(levelDir, FileName);
        if (!File.Exists(path)) return null;
        try { return JsonConvert.DeserializeObject<BillboardsDocument>(File.ReadAllText(path)); }
        catch (Exception e)
        {
            Log.Warn($"  WARN: {path} is unreadable ({e.Message}) — treated as absent: detection will replace it and the bundle carries no screens.");
            return null;
        }
    }
}

/// <summary>
/// Finds a course's billboard SCREENS — the flat rectangle on each board that a video can be laid over — from
/// the placed prop geometry, and writes them as the portable <c>Billboards.json</c>. This is engine-agnostic
/// geometry work, so it lives here rather than in a consumer: Unity builds its overlay quads from the result
/// (Unity docs/vrchat/041) and Slopesmith draws and edits the same rectangles.
///
/// An SSX billboard is welded into the merged static prop mesh with shared atlas materials, so no engine can
/// retexture one board's face on its own; every consumer instead lays a fresh quad over the ad face, and what
/// it needs is exactly this: where that face is, how big it is, and which way it looks. The screen is found
/// from the TEXTURE rather than a per-model size guess:
///
///   - Every prop triangle is grouped by (material slot, facing direction). A slot is one SSX texture page, so
///     the ad image and the structural frame welded right behind it land in separate groups even though they
///     share a plane; a whole stack/row of same-page coplanar boards lands in ONE group, which the 3D cell
///     split separates again.
///   - A group is an ad image only if its UV bounding box spans a single, non-repeating chunk of its page
///     (<see cref="UvSpanMin"/>..<see cref="UvSpanMax"/> on both axes). A real ad shows its page once; a tiled
///     structural face repeats; a flip-book cell or atlas sliver spans a fraction. The spectator crowd
///     flip-book has its own page whose cells would pass, so crowd pages are blocked outright.
///   - The instance's own ad face is the UV-passing group whose centroid is CLOSEST in the ground plane to the
///     instance origin — the board standing on this base, rather than a bigger neighbour inside the search
///     radius. It is then split into board-size cells along up / right / normal, so a stacked triptych yields
///     three screens instead of one blob.
///   - Which SIDE is the front: a genuinely double-sided board (same page, close centre, two opposite ad faces
///     of similar area) is turned toward the nearest point on the course, the side the riders are on. A
///     single-faced extracted panel follows its authored normal, the side on which its texture reads forward;
///     custom OBJ geometry without authored normals falls back to the less obstructed/open side.
///
/// The jumbotron towers take a second recipe because their display is either a tiled flip-book page on a
/// curved drum or an explicitly scrolling material: fit one flat quad parallel to the largest flat plane,
/// trim a shared post where present, and push it proud of the front-most surface.
/// Finish screens use that same whole-surface fit: their shallow curved halves must become one full-width
/// player, and their mesh can be offset well outside the ordinary radius around the finish-stage origin.
///
/// Every quantity stays in SSX mesh space (X negated, centimetres, Z up) — the frame the bundle manifest and
/// every downstream consumer already speak.
/// </summary>
internal static class BillboardsExporter
{
    // Special model families whose front is a flat, video-able ad screen, found by the single-image UV gate.
    // The ordinary interchangeable panels are every exact Mdl_Billboard_Ad_<one letter> family discovered in
    // Instances.json (Ad_A through Ad_R in the extracted courses currently measured); keeping that rule dynamic
    // prevents another level-specific panel from silently falling outside a finite allow-list. Ad1..Ad4 are NOT
    // that family shape: they are co-located pieces of EABigBottom boards, which are measured by the calibrated
    // EABig entries below. Adimpact is likewise excluded because it is a fragmented breakable twin.
    //
    // Listing/discovering a family only ADMITS it — the per-board UV/area gate still decides per instance, so a
    // family with no qualifying ad face in range simply yields nothing.
    static readonly string[] SpecialFamilies =
    {
        "Mdl_Billboard_Elys",
        "Mdl_Billboard_EABigBottom", "Mdl_Billboard_EABigBottomnostand",
        "Mdl_Billboard_Event2", "Mdl_Billboard_EABig_Top",
        // Course-specific ad art uses descriptive names instead of the interchangeable Ad_<letter> shape.
        // These all pass the same single-image UV/area recipe. Event5 is deliberately absent: it is a
        // knockable physics prop, and a static overlay would be left behind when the native sign moves.
        "Mdl_Billboard_AlaskaLogo", "Mdl_Billboard_MercuryLogo",
        "Mdl_Billboard_SnowDreamLogo", "Mdl_Billboard_AfroSlide",
        "Mdl_Billboard_HorizA", "Mdl_Billboard_HorizA_ShortcutRailslide2001",
        "Mdl_Billboard_HorizC",
    };

    // Families whose ad face REPEATS its texture (UV span > 1), so the single-image gate can't size it: the
    // family's shared ad page is auto-detected and a flat, course-facing quad is fit to the whole face.
    // Deliberately EMPTY — every ad board measured so far turned out single-image and lives in Families above.
    // The machinery stays for the jumbotrons below and for any future level whose ad face genuinely tiles.
    static readonly string[] TiledFamilies = System.Array.Empty<string>();

    // The animated-LCD towers: the same face finder, accepting either tiled UVs or an explicit _scr material.
    // Tiled variants keep only the top JumboScreenFrac because the post below shares the page; a scrolling
    // variant's model face is already exactly the display and keeps its full height. Top and Bottom are
    // co-located halves of one tower, so only Top is processed. Each tower can also carry a static single-image
    // ad panel with no instance of its own, so a second pass runs the ad finder from the tower origin.
    static readonly string[] JumbotronFamilies =
    {
        "Mdl_Jumbotron_Top",      // Top/Bottom are co-located halves -> one screen per tower
        "Mdl_Jumbotron_GariTop",  // GariBottom is the co-located lower half -> one screen per tower
        "Mdl_Jumbotron_SnowDreamTop", // SnowDreamBottom is the co-located lower half
    };

    // One shallow curved display at the finish stage. Instance ids vary by course, but the exact family does
    // not; it uses the curved/flat-plane fitter so both halves become one full-width video surface.
    static readonly string[] FinishFamilies =
    {
        "Mdl_Finish_Screen",
        "Mdl_Finsh_Screen", // Some retail assets omit the second 'i' (Gari 7000, Snowdream 4000).
    };

    // Every threshold is SSX centimetres (the metre figure each was calibrated at is in the comment).
    const float FindRadius   = 1800f;    // 18 m column radius around the instance to look for its screen
    const float MaxTilt      = 0.6f;     // |normal.Z| ceiling for "near-vertical" - a screen face, not ground/roof
    const float UvSpanMin    = 0.40f;    // below this is a flip-book cell (crowd cells sit near 0.33) or an atlas sliver
    const float UvSpanMax    = 1.20f;    // above this the page is TILED (a structural face), not a single ad image
    const float Inset        = 1.0f;     // match the ad face exactly (the fitted rect IS the ad-face extent)
    const float Proud        = 10f;      // 0.1 m off the face: covers the ad, gap not noticeable, no z-fight
    const float MinSize      = 300f;     // 3 m - reject degenerate fits
    const float MaxSize      = 4000f;    // 40 m - reject oversized ones
    const float MinAdArea    = 700_000f; // 70 m2 - a real ad face is bigger; below this is a UV-passing sliver
    const float DedupDist    = 250f;     // 2.5 m - quads this close and ~coplanar are the same screen
    const float SplitGap     = 60f;      // 0.6 m gap along an axis separates a stack / row / depth step into cells
    const float JumboScreenFrac = 0.42f; // the LCD display is the top ~42% of the tower; the rest is the post column
    const float TiledMaxSize = 6000f;    // 60 m - a tiled/jumbotron face can be wider than a single-image board
    const float OrientSkip   = 50f;      // 0.5 m - ignore ~coplanar panel tris when weighing which side is open
    const float OrientFootprint = 0.4f;  // fraction of the panel half-extent sampled behind it (excludes neighbours)
    const float OrientDepth  = 400f;     // 4 m - how far behind the panel to look for its backing
    const float FlipMajority = 1.3f;     // only flip the front when the structure clearly sits on the winding side

    /// <summary>Mesh space is Z up (the glTF/Unity Y-up swap happens downstream).</summary>
    static readonly Vector3 Up = Vector3.UnitZ;

    /// <summary>
    /// Detect this map's screens and write <c>Billboards.json</c>. An AUTHORED document is left alone unless
    /// <paramref name="force"/> — a hand-placed screen set is the author's, not the detector's, and re-running
    /// `import` over a folder someone has edited must not silently discard it.
    /// </summary>
    public static int Export(string levelDir, ContractValidationService contracts, bool force = false)
    {
        string path = Path.Combine(levelDir, BillboardsDocument.FileName);
        var existing = BillboardsDocument.Load(levelDir);
        if (!force && existing?.Source == BillboardsDocument.AuthoredSource)
        {
            Log.Info($"  Billboards: kept the authored {BillboardsDocument.FileName} " +
                              $"({existing.Screens.Count} screen(s)); pass --force to replace it with detection.");
            return 0;
        }

        BillboardsDocument document;
        try { document = Detect(levelDir); }
        catch (FileNotFoundException e)
        {
            // No placed props (a demo folder, or an extract that hasn't run `props` yet). Not an error: there is
            // simply nothing to catalog, and every consumer treats a missing document as "no screens".
            Log.Warn($"  Billboards: skipped - {e.Message}");
            return 0;
        }

        string json = JsonConvert.SerializeObject(document,
            new JsonSerializerSettings { Formatting = Formatting.Indented, NullValueHandling = NullValueHandling.Ignore })
            + Environment.NewLine;
        contracts.RequireJson(json, ContractKind.BillboardsV1, path);
        File.WriteAllText(path, json);
        Log.Info($"  -> {path} ({document.Screens.Count} screen(s) detected)");
        return 0;
    }

    /// <summary>Every screen this map's placed prop geometry carries, in instance order.</summary>
    public static BillboardsDocument Detect(string levelDir)
    {
        var instances = SsxInstances.Load(levelDir)
            ?? throw new FileNotFoundException($"Instances.json not found in '{levelDir}'.");
        var mesh = PropMesh.Load(levelDir, instances);
        // Authored OBJ normals identify the readable/front side. The course selects between two genuine
        // opposite faces and can expose the other side of a nearby unbacked single face when the open-side
        // evidence agrees; custom/legacy OBJ input without normals retains the open-side fallback outright.
        var course = CoursePoints(levelDir);

        var document = new BillboardsDocument();
        var placedCenters = new List<Vector3>();
        var placedNormals = new List<Vector3>();
        int duplicates = 0;

        void Process(IEnumerable<string> families, string groupSuffix,
                     Func<string, Vector3, int, List<Face>> find)
        {
            foreach (string prefix in families)
            {
                string family = ShortName(prefix) + groupSuffix;
                for (int i = 0; i < instances.Count; i++)
                {
                    string? name = instances[i].InstanceName;
                    if (name == null || !ModelMatches(name, prefix)) continue;
                    var faces = find(prefix, BundleSpace.MeshPt(instances[i].Location), i);
                    int cell = 0;
                    foreach (var face in faces)
                    {
                        if (IsDuplicate(face, placedCenters, placedNormals)) { duplicates++; continue; }
                        placedCenters.Add(face.Center);
                        placedNormals.Add(face.Normal);
                        // Name by FAMILY then the model's own instance id (then the cell, for a split cluster):
                        // ids repeat ACROSS families - Ad_A_1000 and EABigBottom_1000 are different boards - and
                        // consumers flatten every family into one container, where an id-only name collides.
                        document.Screens.Add(new BillboardScreenDocument
                        {
                            Name = family + "_" + InstanceId(name) + (faces.Count > 1 ? "_" + cell : ""),
                            Family = family,
                            Center = BundleSpace.Xyz(face.Center),
                            Normal = BundleSpace.Xyz(face.Normal),
                            Up = BundleSpace.Xyz(face.Up),
                            Width = face.Width,
                            Height = face.Height,
                            Instance = i,
                            Page = mesh.PageOf(face.Slot),
                        });
                        cell++;
                    }
                }
            }
        }

        // A named board's screen is part of that exact OBJ instance. Keeping the search instance-local prevents
        // a nearby coplanar board from becoming an extra cell and also finds offset meshes such as Finish_Screen.
        Process(SingleImageFamilies(instances), "",
            (family, origin, instance) => FindAdFaces(mesh, course, origin,
                sourceInstance: UsesVicinityAdSearch(family) ? -1 : instance,
                minVSpan: family == "Mdl_Billboard_EABig_Top" ? 0.20f : UvSpanMin));

        int finishSlot = DetectScreenSlot(mesh, instances, FinishFamilies, allowSingleImageSlot: true);
        Process(FinishFamilies, "", (_, origin, instance) =>
            FindTiledFlatFace(mesh, course, origin, finishSlot, 1f, TiledMaxSize, sourceInstance: instance));

        // Tiled flat boards: each family detects its OWN shared ad page (families can use different pages), then
        // fits a full-height (screenFrac 1), course-facing quad to that page's face.
        foreach (string family in TiledFamilies)
        {
            int slot = DetectScreenSlot(mesh, instances, new[] { family });
            if (slot < 0) continue;
            Process(new[] { family }, "",
                (_, origin, _) => FindTiledFlatFace(mesh, course, origin, slot, 1f, TiledMaxSize));
        }

        // Merquer's main LCD uses a single 0..1 image on an explicitly scrolling material (mat_*_scr*),
        // whereas the other retail jumbotrons repeat their UVs. Either authoring form identifies the screen.
        int jumboSlot = DetectScreenSlot(mesh, instances, JumbotronFamilies, allowScrollingSlot: true);
        float jumboScreenFrac = jumboSlot >= 0 && mesh.SlotScrolling[jumboSlot] ? 1f : JumboScreenFrac;
        Process(JumbotronFamilies, "",
            (_, origin, _) => FindTiledFlatFace(mesh, course, origin, jumboSlot, jumboScreenFrac, TiledMaxSize));
        // The static single-image ad panel beside each drum has no instance of its own, so it is found from the
        // tower's origin and cataloged separately. Exclude the LCD itself (Merquer's [0,1] scrolling face would
        // pass this gate), and rank in 3D because these tall towers can have unrelated geometry above them.
        Process(JumbotronFamilies, "_Ad", (_, origin, _) => FindAdFaces(mesh, course, origin,
            excludedSlot: jumboSlot, rankIn3D: true));

        Log.Info($"  Billboards: {document.Screens.Count} screen(s) from {mesh.TriangleCount:n0} prop triangle(s)" +
                          (duplicates > 0 ? $" ({duplicates} co-located variant(s) de-duped)" : "") +
                          (course.Count == 0 ? "; no course path - double-sided boards kept their authored face." : "."));
        return document;
    }

    /// <summary>A fitted screen rectangle: where it is, how it looks out, and how big it is.</summary>
    readonly struct Face
    {
        public Face(Vector3 center, Vector3 normal, Vector3 up, float width, float height, int slot)
        { Center = center; Normal = normal; Up = up; Width = width; Height = height; Slot = slot; }
        public Vector3 Center { get; }
        public Vector3 Normal { get; }
        public Vector3 Up { get; }
        public float Width { get; }
        public float Height { get; }
        /// <summary>The material slot of the covered face, for the record's page name.</summary>
        public int Slot { get; }
    }

    // ---- the single-image ad recipe ---------------------------------------------------------------------

    /// <summary>
    /// The instance's own ad face, split into board-size cells. Groups near-vertical triangles on non-blocked
    /// pages by (slot, facing), keeps the UV-passing groups, picks the one standing on this base, orients it,
    /// and emits one quad per cell. Named boards normally supply <paramref name="sourceInstance"/> so a nearby
    /// object cannot join the group; calibrated composite boards and auxiliary tower panels use the vicinity.
    /// Empty when nothing qualifies.
    /// </summary>
    static List<Face> FindAdFaces(PropMesh mesh, List<Vector3> course, Vector3 origin,
                                  int excludedSlot = -1, bool rankIn3D = false, int sourceInstance = -1,
                                  float minVSpan = UvSpanMin)
    {
        var faces = new List<Face>();
        var groups = GroupByPlane(mesh, origin, slot => slot != excludedSlot && !mesh.SlotBlocked[slot],
                                  sourceInstance: sourceInstance);

        // A real ad face is a sizeable contiguous image (MinAdArea+), which drops the stray structural slivers
        // that slip through the UV gate.
        var candidates = new List<Candidate>();
        foreach (var group in groups)
        {
            var stats = GroupStats(mesh, group.Triangles, withUv: true);
            if (stats == null) continue;
            var s = stats.Value;
            if (s.USpan < UvSpanMin || s.VSpan < minVSpan || s.USpan > UvSpanMax || s.VSpan > UvSpanMax) continue;
            if (s.Area < MinAdArea) continue;
            Vector3? authored = AuthoredGroupNormal(mesh, group.Triangles);
            candidates.Add(new Candidate(group.Triangles, s.Normal, s.Centroid, s.Area, group.Slot,
                authored ?? Vector3.Zero, authored != null));
        }
        if (candidates.Count == 0) return faces;

        // Closest in the ground plane to the instance origin = the board sitting on this base. The jumbotron's
        // secondary pass opts into full 3D distance because towers stack distant surfaces at nearly the same
        // XY. Ranking by closeness rather than area stops a bigger neighbour inside the search radius from
        // stealing the pick. Ties break on area then first triangle, keeping the output deterministic.
        candidates.Sort((a, b) =>
        {
            float DistanceSq(Candidate candidate) => rankIn3D
                ? Vector3.DistanceSquared(candidate.Centroid, origin)
                : GroundDistanceSq(candidate.Centroid, origin);
            int byDistance = DistanceSq(a).CompareTo(DistanceSq(b));
            if (byDistance != 0) return byDistance;
            int byArea = b.Area.CompareTo(a.Area);
            return byArea != 0 ? byArea : a.Triangles[0].CompareTo(b.Triangles[0]);
        });

        var best = candidates[0];
        Vector3 front = best.Normal;
        int opposite = -1;
        for (int i = 1; i < candidates.Count; i++)
            // A real back face draws the same image, is centred on the same panel, and is similarly sized.
            // Stand/punchout geometry can otherwise pass the UV gate and look opposite to the actual face;
            // AlaskaLogo is one such board, and selecting its stand leaves no coherent cell to emit.
            if (candidates[i].Slot == best.Slot
                && Vector3.DistanceSquared(candidates[i].Centroid, best.Centroid) <= 300f * 300f
                && candidates[i].Area >= 0.5f * best.Area
                && candidates[i].Area <= 2f * best.Area
                && Vector3.Dot(candidates[i].Normal, best.Normal) < -0.5f)
            { opposite = i; break; }

        if (opposite >= 0 && course.Count > 0)
        {
            // Genuinely DOUBLE-SIDED - two opposite ad faces of similar area, so the winding can't pick. The
            // course chooses the rider side.
            Vector3 bestReadable = best.AuthoredFacing ? CandidateFront(best) : best.Normal;
            bool bestFacesCourse = Vector3.Dot(bestReadable,
                NearestCourse(course, best.Centroid) - best.Centroid) > 0f;
            var other = candidates[opposite];
            Vector3 otherReadable = other.AuthoredFacing ? CandidateFront(other) : other.Normal;
            bool otherFacesCourse = Vector3.Dot(otherReadable,
                NearestCourse(course, other.Centroid) - other.Centroid) > 0f;
            if (otherFacesCourse && !bestFacesCourse) { best = other; front = other.Normal; }
        }
        else if (!best.AuthoredFacing)
        {
            // Legacy/custom OBJ with no vn stream: recover a plausible front from the open side. Extracted
            // props do not come through here — their authored signed normal is the texture's readable side,
            // and nearby frame/stand geometry must not overturn it.
            front = OrientToOpenSide(mesh, best.Triangles, front);
        }

        // Candidate selection remains geometric (and therefore preserves the measured face/cell set). Once
        // that physical face is fixed, its authored normal supplies the texture's readable-side sign.
        if (best.AuthoredFacing)
        {
            front = CandidateFront(best);
            // The authored normal normally identifies the readable side. If a nearby course is clearly on the
            // other side and the board's own backing/open-side evidence agrees with the course, cover the side
            // riders actually see. This handles freestanding one-sided panels without letting a distant path
            // or misleading frame overturn the authored direction.
            if (opposite < 0 && course.Count > 0)
            {
                Vector3 toCourse = NearestCourse(course, best.Centroid) - best.Centroid;
                toCourse.Z = 0f;
                if (toCourse.LengthSquared() <= 10_000f * 10_000f
                    && Vector3.Dot(front, toCourse) < 0f)
                {
                    Vector3 open = OrientToOpenSide(mesh, best.Triangles, best.Normal);
                    if (Vector3.Dot(open, toCourse) > 0f) front = -front;
                }
            }
        }

        EmitCells(mesh, best.Triangles, front, best.Slot, faces);
        // A UV/area-qualified group can still break into nothing but sub-MinSize fragments. Do not let that
        // unusable nearest surface suppress a coherent ad face slightly farther from the same instance (the
        // auxiliary panels around Merquer's jumbotrons exercise this). Candidate order remains deterministic.
        if (faces.Count == 0)
            foreach (var fallback in candidates)
            {
                if (fallback.Triangles[0] == best.Triangles[0]) continue;
                Vector3 fallbackFront = fallback.AuthoredFacing
                    ? CandidateFront(fallback)
                    : OrientToOpenSide(mesh, fallback.Triangles, fallback.Normal);
                EmitCells(mesh, fallback.Triangles, fallbackFront, fallback.Slot, faces);
                if (faces.Count > 0) break;
            }
        return faces;
    }

    /// <summary>
    /// One flat quad on a selected page's whole face — jumbotron LCD towers and the shallow-curved finish
    /// screens. <paramref name="screenFrac"/> below 1 keeps only the top of the face's height, trimming the post
    /// column that shares a tiled jumbotron page. <paramref name="sourceInstance"/> selects offset instance-owned
    /// geometry (finish screens); otherwise the ordinary vicinity column can include co-located tower halves.
    /// </summary>
    static List<Face> FindTiledFlatFace(PropMesh mesh, List<Vector3> course, Vector3 origin,
                                        int screenSlot, float screenFrac, float maxSize, int sourceInstance = -1)
    {
        var faces = new List<Face>();
        if (screenSlot < 0) return faces;

        var lcd = new List<int>();
        void Take(int t)
        {
            if (mesh.TriSlot[t] == screenSlot && IsNearVertical(mesh, t)) lcd.Add(t);
        }
        if (sourceInstance >= 0)
        {
            for (int t = 0; t < mesh.TriangleCount; t++)
                if (mesh.TriInstance[t] == sourceInstance) Take(t);
        }
        else
        {
            foreach (int t in mesh.Near(origin, FindRadius)) Take(t);
        }
        if (lcd.Count == 0) return faces;

        // Direction to the riders, FLATTENED to horizontal: the screen is a vertical panel facing across the
        // slope, not tilted down at the (downhill) course point, so the facing test must not pick that up.
        Vector3 center = Vector3.Zero;
        foreach (int t in lcd) center += mesh.Centroid[t];
        center /= lcd.Count;
        Vector3 toCourse;
        if (course.Count > 0) toCourse = NearestCourse(course, center) - center;
        else
        {
            Vector3 winding = Vector3.Zero;
            foreach (int t in lcd) winding += mesh.Normal[t] * mesh.Area[t];
            toCourse = winding;
        }
        toCourse.Z = 0f;
        toCourse = toCourse.LengthSquared() > 1e-9f ? Vector3.Normalize(toCourse) : new Vector3(0f, 1f, 0f);

        // The largest flat facing-group is the drum's main PLANE; building the quad parallel to it is what
        // stops it slicing through the curve (the per-triangle average normal tilts it).
        var facing = new Dictionary<long, (float Area, Vector3 Normal)>();
        var facingOrder = new List<long>();
        foreach (int t in lcd)
        {
            Vector3 n = mesh.Normal[t];
            long key = (long)MathF.Round(n.X * 5f) * 73856093L ^ (long)MathF.Round(n.Y * 5f) * 19349663L;
            if (!facing.TryGetValue(key, out var acc)) { acc = (0f, Vector3.Zero); facingOrder.Add(key); }
            facing[key] = (acc.Area + mesh.Area[t], acc.Normal + mesh.Normal[t] * mesh.Area[t]);
        }
        Vector3 main = new(0f, 1f, 0f);
        float biggest = -1f;
        foreach (long key in facingOrder)
        {
            var acc = facing[key];
            if (acc.Area > biggest && acc.Normal.LengthSquared() > 1e-9f) { biggest = acc.Area; main = Vector3.Normalize(acc.Normal); }
        }
        // Select the physical plane geometrically, then orient its output normal separately. Extracted vn
        // normals carry the readable side even when the course happens to lie behind the panel (Merquer's
        // single-sided LCDs do); filtering triangles by that signed output normal would otherwise discard the
        // entire selected plane.
        var front = new List<int>();
        foreach (int t in lcd) if (Vector3.Dot(mesh.Normal[t], main) > 0f) front.Add(t);
        if (front.Count == 0) return faces;
        Vector3? authored = AuthoredGroupNormal(mesh, front);
        Vector3 frontNormal = authored != null
            ? (Vector3.Dot(authored.Value, main) < 0f ? -main : main)
            : (Vector3.Dot(main, toCourse) > 0f ? main : -main);

        float lowest = float.MaxValue, highest = float.MinValue;
        foreach (int t in front) { float z = mesh.Centroid[t].Z; if (z < lowest) lowest = z; if (z > highest) highest = z; }
        var display = new List<int>();
        foreach (int t in front) if (mesh.Centroid[t].Z > highest - screenFrac * (highest - lowest)) display.Add(t);
        if (display.Count == 0) return faces;

        // Sized to the display's in-plane extent and pushed proud of the FRONT-MOST surface, so the curved drum
        // can't poke through the flat quad.
        Vector3 middle = Vector3.Zero;
        foreach (int t in display) middle += mesh.Centroid[t];
        middle /= display.Count;
        Vector3 right = Vector3.Normalize(Vector3.Cross(Up, frontNormal));
        Vector3 up = Vector3.Cross(frontNormal, right);
        float minR = float.MaxValue, maxR = float.MinValue, minU = float.MaxValue, maxU = float.MinValue, maxDepth = float.MinValue;
        foreach (int t in display)
            for (int k = 0; k < 3; k++)
            {
                Vector3 p = mesh.Vertex(t, k) - middle;
                float r = Vector3.Dot(p, right), u = Vector3.Dot(p, up), d = Vector3.Dot(p, frontNormal);
                if (r < minR) minR = r; if (r > maxR) maxR = r;
                if (u < minU) minU = u; if (u > maxU) maxU = u;
                if (d > maxDepth) maxDepth = d;
            }
        float width = (maxR - minR) * Inset, height = (maxU - minU) * Inset;
        if (width < MinSize || height < MinSize || width > maxSize || height > maxSize) return faces;

        Vector3 quadCenter = middle + right * ((minR + maxR) / 2f) + up * ((minU + maxU) / 2f)
                             + frontNormal * (maxDepth + Proud);
        faces.Add(new Face(quadCenter, frontNormal, up, width, height, screenSlot));
        return faces;
    }

    /// <summary>
    /// The display page a family shares: each instance votes its largest qualifying near-vertical face's slot
    /// from triangles owned by that exact instance, so neighbouring structural geometry cannot cast a vote.
    /// Qualifying normally means tiled UVs; selected callers also admit an explicit _scr material or a
    /// single-image finish surface. -1 when the family has none (it then yields no screens).
    /// </summary>
    static int DetectScreenSlot(PropMesh mesh, List<SsxInstance> instances, string[] families,
                                bool allowScrollingSlot = false, bool allowSingleImageSlot = false)
    {
        var votes = new Dictionary<int, int>();
        var order = new List<int>();
        for (int instanceIndex = 0; instanceIndex < instances.Count; instanceIndex++)
        {
            var instance = instances[instanceIndex];
            string? name = instance.InstanceName;
            if (name == null) continue;
            bool matched = false;
            foreach (string family in families) if (ModelMatches(name, family)) { matched = true; break; }
            if (!matched) continue;

            float bestArea = -1f; int bestSlot = -1;
            // Slot detection is a property of this model, not of unrelated geometry which happens to sit in
            // the same 18 m search column. The subsequent fitter can still use co-located model halves.
            foreach (var group in GroupByPlane(mesh, BundleSpace.MeshPt(instance.Location), _ => true,
                                               sourceInstance: instanceIndex))
            {
                var stats = GroupStats(mesh, group.Triangles, withUv: true);
                if (stats == null) continue;
                var s = stats.Value;
                bool tiled = s.USpan > UvSpanMax || s.VSpan > UvSpanMax;
                bool admitted = tiled || allowSingleImageSlot
                    || (allowScrollingSlot && mesh.SlotScrolling[group.Slot]);
                if (!admitted || s.Area < MinAdArea)
                    continue;
                if (s.Area > bestArea) { bestArea = s.Area; bestSlot = group.Slot; }
            }
            if (bestSlot < 0) continue;
            if (votes.TryAdd(bestSlot, 0)) order.Add(bestSlot);
            votes[bestSlot]++;
        }
        int winner = -1, best = 0;
        foreach (int slot in order) if (votes[slot] > best) { best = votes[slot]; winner = slot; }
        return winner;
    }

    // ---- grouping + fitting ------------------------------------------------------------------------------

    readonly record struct PlaneGroup(int Slot, List<int> Triangles);
    readonly record struct Candidate(List<int> Triangles, Vector3 Normal, Vector3 Centroid, float Area, int Slot,
                                     Vector3 AuthoredNormal, bool AuthoredFacing);

    // The authored stream chooses only the SIGN. Geometry still supplies the exact plane normal, so a smoothed
    // or slightly noisy vertex normal cannot tilt the fitted quad, alter its dimensions, or change cell splits.
    static Vector3 CandidateFront(Candidate candidate) =>
        candidate.AuthoredFacing && Vector3.Dot(candidate.AuthoredNormal, candidate.Normal) < 0f
            ? -candidate.Normal : candidate.Normal;

    /// <summary>
    /// Near-vertical triangles in the column around <paramref name="origin"/>, bucketed by (material slot,
    /// quantized facing). Groups come back in first-seen triangle order, so everything downstream is a function
    /// of the geometry rather than of dictionary iteration order.
    /// </summary>
    static List<PlaneGroup> GroupByPlane(PropMesh mesh, Vector3 origin, Func<int, bool> slotAllowed,
                                         Func<int, bool>? triangleAllowed = null, int sourceInstance = -1)
    {
        var byKey = new Dictionary<long, int>();
        var groups = new List<PlaneGroup>();
        void Take(int t)
        {
            if (triangleAllowed != null && !triangleAllowed(t)) return;
            int slot = mesh.TriSlot[t];
            if (!slotAllowed(slot) || !IsNearVertical(mesh, t)) return;
            long key = PlaneKey(slot, mesh.Normal[t]);
            if (!byKey.TryGetValue(key, out int at))
            {
                at = groups.Count;
                byKey[key] = at;
                groups.Add(new PlaneGroup(slot, new List<int>()));
            }
            groups[at].Triangles.Add(t);
        }
        if (sourceInstance >= 0)
        {
            for (int t = 0; t < mesh.TriangleCount; t++)
                if (mesh.TriInstance[t] == sourceInstance) Take(t);
        }
        else
        {
            foreach (int t in mesh.Near(origin, FindRadius)) Take(t);
        }
        return groups;
    }

    /// <summary>
    /// Key a group by texture page AND facing direction — not by depth — so two coplanar faces on DIFFERENT
    /// pages (the ad image versus the structural frame welded behind it) split apart, while a whole stack or
    /// row of same-page coplanar boards stays together for the cell split. Opposite faces get opposite keys.
    /// </summary>
    static long PlaneKey(int slot, Vector3 n) =>
        (long)slot * 1000003L
        ^ (long)MathF.Round(n.X * 5f) * 73856093L
        ^ (long)MathF.Round(n.Y * 5f) * 6291469L
        ^ (long)MathF.Round(n.Z * 5f) * 19349663L;

    static bool IsNearVertical(PropMesh mesh, int t)
    {
        Vector3 n = mesh.Normal[t];
        return n != Vector3.Zero && MathF.Abs(n.Z) <= MaxTilt;
    }

    /// <summary>Area-weighted normal, centroid, total area and UV span of a group. Null when it has no normal.</summary>
    static (Vector3 Normal, Vector3 Centroid, float Area, float USpan, float VSpan)? GroupStats(
        PropMesh mesh, List<int> triangles, bool withUv)
    {
        float area = 0f;
        Vector3 normal = Vector3.Zero, centroid = Vector3.Zero;
        float minU = float.MaxValue, minV = float.MaxValue, maxU = float.MinValue, maxV = float.MinValue;
        foreach (int t in triangles)
        {
            area += mesh.Area[t];
            normal += mesh.Normal[t] * mesh.Area[t];
            centroid += mesh.Centroid[t];
            if (!withUv) continue;
            for (int k = 0; k < 3; k++)
            {
                Vector2 uv = mesh.Uv(t, k);
                if (uv.X < minU) minU = uv.X; if (uv.X > maxU) maxU = uv.X;
                if (uv.Y < minV) minV = uv.Y; if (uv.Y > maxV) maxV = uv.Y;
            }
        }
        if (normal.LengthSquared() < 1e-9f) return null;
        return (Vector3.Normalize(normal), centroid / triangles.Count, area,
                withUv ? maxU - minU : 0f, withUv ? maxV - minV : 0f);
    }

    /// <summary>
    /// The face's authored/readable direction without changing its geometric grouping. Extracted faces carry a
    /// complete vn triple on every triangle; a partial/malformed stream deliberately falls back as one unit so
    /// a face cannot alternate orientation triangle by triangle.
    /// </summary>
    static Vector3? AuthoredGroupNormal(PropMesh mesh, List<int> triangles)
    {
        Vector3 normal = Vector3.Zero;
        foreach (int t in triangles)
        {
            if (!mesh.HasAuthoredNormal[t]) return null;
            normal += mesh.AuthoredNormal[t] * mesh.Area[t];
        }
        return normal.LengthSquared() > 1e-9f ? Vector3.Normalize(normal) : null;
    }

    /// <summary>
    /// 3D-split a chosen face into board-size cells — a gap along up separates a vertical STACK, along right a
    /// horizontal ROW, along the normal a DEPTH step — and emit one quad per cell. Within a single face the
    /// triangles overlap on every axis, so they stay together; the ~1 m gap between adjacent boards splits them.
    /// </summary>
    static void EmitCells(PropMesh mesh, List<int> triangles, Vector3 front, int slot, List<Face> faces)
    {
        Vector3 right = Vector3.Normalize(Vector3.Cross(Up, front));
        Vector3 up = Vector3.Cross(front, right);
        foreach (var row in SplitAxis(mesh, triangles, up))
            foreach (var column in SplitAxis(mesh, row, right))
                foreach (var cell in SplitAxis(mesh, column, front))
                    EmitCell(mesh, cell, front, slot, faces);
    }

    /// <summary>
    /// Size and place one cell's quad from ITS OWN normal and centre, so a fanned or depth-stepped cluster
    /// doesn't yaw or mis-depth its cells; <paramref name="front"/> only fixes which way is out.
    /// </summary>
    static void EmitCell(PropMesh mesh, List<int> triangles, Vector3 front, int slot, List<Face> faces)
    {
        var stats = GroupStats(mesh, triangles, withUv: false);
        if (stats == null) return;
        Vector3 normal = stats.Value.Normal;
        if (Vector3.Dot(normal, front) < 0f) normal = -normal;   // keep the chosen front direction
        Vector3 center = stats.Value.Centroid;
        Vector3 right = Vector3.Normalize(Vector3.Cross(Up, normal));
        Vector3 up = Vector3.Cross(normal, right);

        float minR = float.MaxValue, maxR = float.MinValue, minU = float.MaxValue, maxU = float.MinValue;
        foreach (int t in triangles)
            for (int k = 0; k < 3; k++)
            {
                Vector3 p = mesh.Vertex(t, k) - center;
                float r = Vector3.Dot(p, right), u = Vector3.Dot(p, up);
                if (r < minR) minR = r; if (r > maxR) maxR = r;
                if (u < minU) minU = u; if (u > maxU) maxU = u;
            }
        float width = (maxR - minR) * Inset, height = (maxU - minU) * Inset;
        if (width < MinSize || height < MinSize || width > MaxSize || height > MaxSize) return;

        Vector3 quadCenter = center + right * ((minR + maxR) / 2f) + up * ((minU + maxU) / 2f) + normal * Proud;
        faces.Add(new Face(quadCenter, normal, up, width, height, slot));
    }

    /// <summary>
    /// Split a group's triangles into runs separated by a gap wider than <see cref="SplitGap"/> along an axis —
    /// one run per board in a stack (axis = up) or row (axis = right).
    /// </summary>
    static List<List<int>> SplitAxis(PropMesh mesh, List<int> triangles, Vector3 axis)
    {
        var spans = new List<(float Low, float High, int Triangle)>(triangles.Count);
        foreach (int t in triangles)
        {
            float a = Vector3.Dot(mesh.Vertex(t, 0), axis);
            float b = Vector3.Dot(mesh.Vertex(t, 1), axis);
            float c = Vector3.Dot(mesh.Vertex(t, 2), axis);
            spans.Add((MathF.Min(a, MathF.Min(b, c)), MathF.Max(a, MathF.Max(b, c)), t));
        }
        // Ordered by span start, with the triangle index breaking ties so identical spans keep a stable order.
        spans.Sort((x, y) => x.Low != y.Low ? x.Low.CompareTo(y.Low) : x.Triangle.CompareTo(y.Triangle));

        var runs = new List<List<int>>();
        List<int>? current = null;
        float currentHigh = 0f;
        foreach (var span in spans)
        {
            if (current == null || span.Low > currentHigh + SplitGap)
            { current = new List<int>(); runs.Add(current); currentHigh = span.High; }
            else if (span.High > currentHigh) currentHigh = span.High;
            current.Add(span.Triangle);
        }
        return runs;
    }

    /// <summary>
    /// Front-orient a single-faced board to its OPEN side: the board's backing sits directly behind the ad
    /// panel, so the side carrying less geometry right behind it — measured only within the panel's own
    /// footprint and a shallow depth, so the post below or a nearby tree doesn't count — is the viewer side.
    /// The winding is flipped only on a clear majority; a freestanding panel keeps its textured side.
    /// </summary>
    static Vector3 OrientToOpenSide(PropMesh mesh, List<int> triangles, Vector3 winding)
    {
        Vector3 center = Vector3.Zero;
        foreach (int t in triangles) center += mesh.Centroid[t];
        center /= triangles.Count;
        Vector3 right = Vector3.Normalize(Vector3.Cross(Up, winding));
        Vector3 up = Vector3.Cross(winding, right);

        float minR = float.MaxValue, maxR = float.MinValue, minU = float.MaxValue, maxU = float.MinValue;
        foreach (int t in triangles)
            for (int k = 0; k < 3; k++)
            {
                Vector3 p = mesh.Vertex(t, k) - center;
                float r = Vector3.Dot(p, right), u = Vector3.Dot(p, up);
                if (r < minR) minR = r; if (r > maxR) maxR = r;
                if (u < minU) minU = u; if (u > maxU) maxU = u;
            }
        float halfWidth = (maxR - minR) * OrientFootprint, halfHeight = (maxU - minU) * OrientFootprint;

        // Every triangle the test can accept lies inside the footprint box, so this radius covers it exactly -
        // a shorter query would silently drop the far corners of a wide board's backing and weigh the sides
        // against each other on a partial count.
        float reach = MathF.Sqrt(halfWidth * halfWidth + halfHeight * halfHeight + OrientDepth * OrientDepth);
        float ahead = 0f, behind = 0f;
        foreach (int t in mesh.Near(center, reach))
        {
            Vector3 p = mesh.Centroid[t] - center;
            float depth = Vector3.Dot(p, winding), r = Vector3.Dot(p, right), u = Vector3.Dot(p, up);
            if (MathF.Abs(r) > halfWidth || MathF.Abs(u) > halfHeight) continue;          // outside the panel footprint
            if (MathF.Abs(depth) < OrientSkip || MathF.Abs(depth) > OrientDepth) continue; // skip the panel plane; stay shallow
            if (depth > 0f) ahead += mesh.Area[t]; else behind += mesh.Area[t];
        }
        return ahead > behind * FlipMajority ? -winding : winding;   // structure in front of the winding -> flip
    }

    static bool IsDuplicate(Face face, List<Vector3> centers, List<Vector3> normals)
    {
        for (int i = 0; i < centers.Count; i++)
            if ((centers[i] - face.Center).LengthSquared() < DedupDist * DedupDist
                && MathF.Abs(Vector3.Dot(normals[i], face.Normal)) > 0.7f) return true;
        return false;
    }

    // ---- names, course, small helpers --------------------------------------------------------------------

    /// <summary>
    /// Exact single-image families present in this map: the known special boards plus every ordinary
    /// Mdl_Billboard_Ad_&lt;one letter&gt; panel. Returning exact family names keeps each screen's Family/Name useful
    /// to consumers; treating Mdl_Billboard_Ad_ as one loose prefix would collapse Ad_C, Ad_I, etc. together.
    /// </summary>
    static List<string> SingleImageFamilies(IEnumerable<SsxInstance> instances)
    {
        var discovered = new HashSet<string>(StringComparer.Ordinal);
        foreach (var instance in instances)
        {
            string? name = instance.InstanceName;
            if (name == null) continue;
            string family = InstanceFamily(name);
            if (IsLetteredAdFamily(family)) discovered.Add(family);
        }

        var families = discovered.OrderBy(f => f, StringComparer.Ordinal).ToList();
        families.AddRange(SpecialFamilies);
        return families;
    }

    // These composite frames keep their actual ad page in co-located companion pieces rather than in the
    // named bottom instance. They retain the calibrated vicinity search; ordinary boards and finish screens
    // are read from their exact OBJ instance so a neighbour cannot be mistaken for one of their cells.
    static bool UsesVicinityAdSearch(string family) =>
        family == "Mdl_Billboard_EABigBottom" || family == "Mdl_Billboard_EABigBottomnostand";

    static bool IsLetteredAdFamily(string family)
    {
        const string prefix = "Mdl_Billboard_Ad_";
        return family.Length == prefix.Length + 1
            && family.StartsWith(prefix, StringComparison.Ordinal)
            && family[^1] is >= 'A' and <= 'Z';
    }

    static string InstanceFamily(string name)
    {
        int cut = name.LastIndexOf('_');
        if (cut < 0 || cut == name.Length - 1) return name;
        for (int i = cut + 1; i < name.Length; i++)
            if (name[i] < '0' || name[i] > '9') return name;
        return name.Substring(0, cut);
    }

    /// <summary>"Mdl_Billboard_Ad_A_2000" belongs to family "Mdl_Billboard_Ad_A". Comparing the exact family
    /// (rather than a raw prefix) also keeps nested names such as HorizA_ShortcutRailslide2001 distinct.</summary>
    static bool ModelMatches(string instanceName, string prefix)
        => string.Equals(InstanceFamily(instanceName), prefix, StringComparison.Ordinal);

    static string ShortName(string prefix)
    {
        if (prefix.StartsWith("Mdl_Billboard_", StringComparison.Ordinal)) return prefix.Substring("Mdl_Billboard_".Length);
        if (prefix.StartsWith("Mdl_", StringComparison.Ordinal)) return prefix.Substring("Mdl_".Length);
        return prefix;
    }

    static string InstanceId(string name)
    {
        int cut = name.LastIndexOf('_');
        return cut >= 0 ? name.Substring(cut + 1) : name;
    }

    static float GroundDistanceSq(Vector3 a, Vector3 b)
    {
        float dx = a.X - b.X, dy = a.Y - b.Y;   // mesh space is Z-up: the ground plane is XY
        return dx * dx + dy * dy;
    }

    static Vector3 NearestCourse(IReadOnlyList<Vector3> points, Vector3 query)
    {
        float best = float.MaxValue;
        Vector3 nearest = query;
        foreach (var p in points)
        {
            float d = (p - query).LengthSquared();
            if (d < best) { best = d; nearest = p; }
        }
        return nearest;
    }

    /// <summary>The baked course centreline, or empty for a folder with no path tables.</summary>
    static List<Vector3> CoursePoints(string levelDir)
    {
        var points = new List<Vector3>();
        var course = PathBundle.BuildCourse(levelDir, log: false);
        if (course == null) return points;
        foreach (var p in course.Points) if (p.Length >= 3) points.Add(new Vector3(p[0], p[1], p[2]));
        return points;
    }

    // ---- the placed prop geometry ------------------------------------------------------------------------

    /// <summary>
    /// The world-placed prop triangles the search runs over, read from <c>Props.obj</c>: positions in mesh
    /// space, per-corner UVs, and the material slot each triangle draws (one slot = one SSX texture page, which
    /// is the identity the ad gate keys on). Triangles of instances the level hides are left out, matching the
    /// merged static mesh every consumer actually draws.
    /// </summary>
    sealed class PropMesh
    {
        public Vector3[] Centroid = System.Array.Empty<Vector3>();
        public Vector3[] Normal = System.Array.Empty<Vector3>();
        public Vector3[] AuthoredNormal = System.Array.Empty<Vector3>();
        public bool[] HasAuthoredNormal = System.Array.Empty<bool>();
        public float[] Area = System.Array.Empty<float>();
        public int[] TriSlot = System.Array.Empty<int>();
        public int[] TriInstance = System.Array.Empty<int>();
        public bool[] SlotBlocked = System.Array.Empty<bool>();
        public bool[] SlotScrolling = System.Array.Empty<bool>();
        public int TriangleCount => Area.Length;

        Vector3[] _positions = System.Array.Empty<Vector3>();
        Vector2[] _uvs = System.Array.Empty<Vector2>();
        Vector3[] _normals = System.Array.Empty<Vector3>();
        int[] _triPos = System.Array.Empty<int>();   // 3 per triangle
        int[] _triUv = System.Array.Empty<int>();    // 3 per triangle, -1 when the face carries no UV
        int[] _triNormal = System.Array.Empty<int>(); // 3 per triangle, -1 when the face carries no authored normal
        string?[] _slotPage = System.Array.Empty<string?>();
        Dictionary<long, List<int>> _grid = new();

        public Vector3 Vertex(int triangle, int corner) => _positions[_triPos[triangle * 3 + corner]];

        public Vector2 Uv(int triangle, int corner)
        {
            int at = _triUv[triangle * 3 + corner];
            return at >= 0 ? _uvs[at] : Vector2.Zero;
        }

        /// <summary>The texture page a slot draws ("0031"), or null when it resolves to none.</summary>
        public string? PageOf(int slot) => slot >= 0 && slot < _slotPage.Length ? _slotPage[slot] : null;

        /// <summary>
        /// Triangles whose centroid is within <paramref name="radius"/> of <paramref name="origin"/> in the
        /// ground plane, in ascending index order. A uniform XY grid keeps a per-instance column search from
        /// walking every triangle on the mountain; the predicate itself is exact.
        /// </summary>
        public List<int> Near(Vector3 origin, float radius)
        {
            int cellX = (int)MathF.Floor(origin.X / GridCell), cellY = (int)MathF.Floor(origin.Y / GridCell);
            int reach = (int)MathF.Ceiling(radius / GridCell);
            var found = new List<int>();
            for (int x = cellX - reach; x <= cellX + reach; x++)
                for (int y = cellY - reach; y <= cellY + reach; y++)
                    if (_grid.TryGetValue(CellKey(x, y), out var bucket))
                        foreach (int t in bucket)
                        {
                            float dx = Centroid[t].X - origin.X, dy = Centroid[t].Y - origin.Y;
                            if (dx * dx + dy * dy <= radius * radius) found.Add(t);
                        }
            found.Sort();
            return found;
        }

        const float GridCell = FindRadius;
        static long CellKey(int x, int y) => ((long)x << 32) ^ (uint)y;

        public static PropMesh Load(string levelDir, List<SsxInstance> instances)
        {
            string objPath = Path.Combine(levelDir, "Props.obj");
            if (!File.Exists(objPath))
                throw new FileNotFoundException($"Props.obj not found in '{levelDir}'; run `snowknife props` first.");

            var positions = new List<Vector3>(1 << 16);
            var uvs = new List<Vector2>(1 << 16);
            var normals = new List<Vector3>(1 << 16);
            var triPos = new List<int>(1 << 16);
            var triUv = new List<int>(1 << 16);
            var triNormal = new List<int>(1 << 16);
            var triSlot = new List<int>(1 << 14);
            var triInstance = new List<int>(1 << 14);
            var slotIndex = new Dictionary<string, int>(StringComparer.Ordinal);
            var slotNames = new List<string>();
            int currentSlot = -1;
            int currentInstance = -1;
            bool visible = true;

            foreach (string line in File.ReadLines(objPath))
            {
                if (line.Length < 2) continue;
                char a = line[0], b = line[1];
                if (a == 'v' && b == ' ')
                {
                    var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length >= 4) positions.Add(new Vector3(-Parse(parts[1]), Parse(parts[2]), Parse(parts[3])));
                }
                else if (a == 'v' && b == 't')
                {
                    var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length >= 3) uvs.Add(new Vector2(Parse(parts[1]), Parse(parts[2])));
                }
                else if (a == 'v' && b == 'n')
                {
                    var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length >= 4)
                    {
                        // Props.obj is raw SSX placement space. A normal is a direction, so the raw -> mesh
                        // conversion negates X exactly as PropsBundle does; unlike a cross product recomputed
                        // after that reflection, this preserves the authored/readable side of the texture.
                        Vector3 n = new(-Parse(parts[1]), Parse(parts[2]), Parse(parts[3]));
                        normals.Add(n.LengthSquared() > 1e-12f ? Vector3.Normalize(n) : Vector3.Zero);
                    }
                }
                else if (a == 'o' && b == ' ')
                {
                    currentInstance = ParseInstance(line);
                    visible = currentInstance < 0 || currentInstance >= instances.Count || instances[currentInstance].Visable;
                }
                else if (a == 'u' && line.StartsWith("usemtl ", StringComparison.Ordinal))
                {
                    string slot = line.Substring(7).Trim();
                    if (!slotIndex.TryGetValue(slot, out currentSlot))
                    { currentSlot = slotNames.Count; slotIndex[slot] = currentSlot; slotNames.Add(slot); }
                }
                else if (a == 'f' && b == ' ')
                {
                    if (!visible) continue;
                    var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                    if (parts.Length < 4) continue;
                    // The prop OBJ is already triangulated; a longer face is fanned, as every other reader does.
                    (int Pos, int Uv, int Normal) first = Corner(parts[1]);
                    for (int k = 2; k < parts.Length - 1; k++)
                    {
                        (int Pos, int Uv, int Normal) second = Corner(parts[k]), third = Corner(parts[k + 1]);
                        if (first.Pos < 0 || second.Pos < 0 || third.Pos < 0) continue;
                        triPos.Add(first.Pos); triPos.Add(second.Pos); triPos.Add(third.Pos);
                        triUv.Add(first.Uv); triUv.Add(second.Uv); triUv.Add(third.Uv);
                        triNormal.Add(first.Normal); triNormal.Add(second.Normal); triNormal.Add(third.Normal);
                        triSlot.Add(currentSlot);
                        triInstance.Add(currentInstance);
                    }
                }
            }

            var mesh = new PropMesh
            {
                _positions = positions.ToArray(),
                _uvs = uvs.ToArray(),
                _normals = normals.ToArray(),
                _triPos = triPos.ToArray(),
                _triUv = triUv.ToArray(),
                _triNormal = triNormal.ToArray(),
                TriSlot = triSlot.ToArray(),
                TriInstance = triInstance.ToArray(),
            };
            // One material slot is one SSX texture page; MaterialBundle owns the slot-name rules, so the page
            // name comes from there rather than from a second copy of them here.
            var textures = MaterialBundle.SlotTextures(levelDir, slotNames);
            mesh._slotPage = new string?[slotNames.Count];
            for (int s = 0; s < slotNames.Count; s++)
            {
                string? file = textures.GetValueOrDefault(slotNames[s]);
                mesh._slotPage[s] = string.IsNullOrEmpty(file) ? null : Path.GetFileNameWithoutExtension(file);
            }
            // Pages that can never be an ad: the spectator CROWD flip-book has its own page and its sprite
            // cells pass the UV test, so a board with no real ad face standing in a crowd would otherwise grab
            // a crowd quad.
            mesh.SlotBlocked = new bool[slotNames.Count];
            mesh.SlotScrolling = new bool[slotNames.Count];
            for (int s = 0; s < slotNames.Count; s++)
            {
                mesh.SlotBlocked[s] = slotNames[s].StartsWith("mat_crowd", StringComparison.Ordinal)
                    || (mesh._slotPage[s]?.StartsWith("cd", StringComparison.OrdinalIgnoreCase) ?? false);
                mesh.SlotScrolling[s] = IsScrollingSlot(slotNames[s]);
            }

            int count = triSlot.Count;
            mesh.Centroid = new Vector3[count];
            mesh.Normal = new Vector3[count];
            mesh.AuthoredNormal = new Vector3[count];
            mesh.HasAuthoredNormal = new bool[count];
            mesh.Area = new float[count];
            for (int t = 0; t < count; t++)
            {
                Vector3 p0 = mesh.Vertex(t, 0), p1 = mesh.Vertex(t, 1), p2 = mesh.Vertex(t, 2);
                mesh.Centroid[t] = (p0 + p1 + p2) / 3f;
                Vector3 cross = Vector3.Cross(p1 - p0, p2 - p0);
                mesh.Area[t] = cross.Length() * 0.5f;
                // Geometry owns grouping, dimensions and all plane math. Its sign changed under the X
                // reflection, but that does not matter until the final facing choice below.
                mesh.Normal[t] = cross.LengthSquared() > 1e-12f ? Vector3.Normalize(cross) : Vector3.Zero;
                Vector3 authored = Vector3.Zero;
                int authoredCount = 0;
                for (int k = 0; k < 3; k++)
                {
                    int at = mesh._triNormal[t * 3 + k];
                    if (at < 0 || at >= mesh._normals.Length || mesh._normals[at] == Vector3.Zero) continue;
                    authored += mesh._normals[at];
                    authoredCount++;
                }
                if (authoredCount == 3 && authored.LengthSquared() > 1e-12f)
                {
                    mesh.AuthoredNormal[t] = Vector3.Normalize(authored);
                    mesh.HasAuthoredNormal[t] = true;
                }

                long key = CellKey((int)MathF.Floor(mesh.Centroid[t].X / GridCell),
                                   (int)MathF.Floor(mesh.Centroid[t].Y / GridCell));
                if (!mesh._grid.TryGetValue(key, out var bucket)) { bucket = new List<int>(); mesh._grid[key] = bucket; }
                bucket.Add(t);
            }
            return mesh;

            static bool IsScrollingSlot(string slot)
            {
                int tag = slot.IndexOf("_scr", StringComparison.Ordinal);
                if (tag < 0) return false;
                int start = tag + 4;
                int end = slot.IndexOf("_obj", start, StringComparison.Ordinal);
                if (end < 0) end = slot.Length;
                if (start == end) return false;
                for (int i = start; i < end; i++)
                    if (slot[i] < '0' || slot[i] > '9') return false;
                return true;
            }

            (int Pos, int Uv, int Normal) Corner(string token)
            {
                int slash = token.IndexOf('/');
                var posSpan = slash < 0 ? token.AsSpan() : token.AsSpan(0, slash);
                if (!int.TryParse(posSpan, out int position)) return (-1, -1, -1);
                int uv = -1, normal = -1;
                if (slash >= 0)
                {
                    var rest = token.AsSpan(slash + 1);
                    int second = rest.IndexOf('/');
                    var uvSpan = second < 0 ? rest : rest.Slice(0, second);
                    if (uvSpan.Length > 0 && int.TryParse(uvSpan, out int parsed)) uv = parsed - 1;
                    if (second >= 0)
                    {
                        var normalSpan = rest.Slice(second + 1);
                        if (normalSpan.Length > 0 && int.TryParse(normalSpan, out int parsedNormal))
                            normal = parsedNormal - 1;
                    }
                }
                return (position - 1, uv, normal);
            }
        }

        static float Parse(string value) => float.Parse(value, CultureInfo.InvariantCulture);

        /// <summary>The instance index out of an "o inst&lt;n&gt;_&lt;name&gt;" group line; -1 when absent.</summary>
        static int ParseInstance(string line)
        {
            int at = line.IndexOf("inst", StringComparison.Ordinal);
            if (at < 0) return -1;
            int start = at + 4, end = start;
            while (end < line.Length && line[end] >= '0' && line[end] <= '9') end++;
            return end > start && int.TryParse(line.AsSpan(start, end - start), out int index) ? index : -1;
        }
    }
}
