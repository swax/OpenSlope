using System.Numerics;
using Newtonsoft.Json;
using Snowknife.Engine;

namespace Snowknife.Bundle;

/// <summary>
/// Bakes the board's grind RAILS and out-of-bounds COURSE PATHS into flat polylines - the engine-agnostic
/// curve work the Unity importer's RailBuilder + CoursePathBuilder consume rather than compute.
///   - Rails: Splines.json style-13/12 (or "Rail"-named) splines - including Alaska's style-5 IceRails - plus any spline a MainType-25 node registers as a
///            grind candidate (a fallen-tree trunk) - each a chain of cubic Beziers, sampled to a polyline
///            (RailSamplesPerSegment points/segment + the final endpoint).
///   - Course: AIP.json/SOP.json RaceLines + Respawnable AIPaths, whose PathPoints are INCREMENTAL deltas
///            from a running position seeded at PathPos (cumulative-sum), deduped across the two files.
/// Both in SSX mesh space (X negated) - root-local points the importer feeds straight into RailNetwork.
/// See Unity docs/026 (rails), Unity docs/011 (course path).
/// </summary>
public static class PathBundle
{
    public static BundleManifest.PathsInfo Build(string levelDir, out Dictionary<int, int> splineToRail,
                                                 int railSamplesPerSegment = 8, HashSet<int>? gatedSplines = null)
    {
        splineToRail = new Dictionary<int, int>();
        return new BundleManifest.PathsInfo
        {
            Rails = BuildRails(levelDir, Math.Max(2, railSamplesPerSegment), gatedSplines, splineToRail),
            Course = BuildCourse(levelDir),
        };
    }

    // splineToRail (out via the caller): each emitted rail's SOURCE spline index -> its rail-network index, so the
    // rail-toggle gates (RailGateBundle) can turn a MainType-25 spline into the rail index the runtime disables.
    static BundleManifest.PolyInfo? BuildRails(string levelDir, int n, HashSet<int>? gatedSplines, Dictionary<int, int> splineToRail)
    {
        string path = Path.Combine(levelDir, "Splines.json");
        if (!File.Exists(path)) return null;
        SplineFile? parsed;
        try { parsed = JsonConvert.DeserializeObject<SplineFile>(File.ReadAllText(path)); }
        catch (Exception e)
        {
            Log.Warn($"  WARN: {path} is unreadable ({e.Message}) — no rails for this level.");
            return null;
        }
        if (parsed?.Splines == null || parsed.Splines.Count == 0) return null;

        var info = new BundleManifest.PolyInfo();
        var styles = new List<int>();
        info.Style = styles;
        // Keep the SOURCE cubic segments next to the sampled polyline so the runtime can ride the analytic curve
        // (exact closest point + tangent), matching the PS2 engine. ControlPoints are pushed in lockstep with the
        // polyline sampling below (same valid-segment order + same n), so a baked chord maps back to its cubic.
        var cubic = new BundleManifest.CubicInfo { SamplesPerSegment = n };
        // Splines a MainType-25 node registers as a grind candidate (SSF Spline.Effect != 0). The engine promotes a
        // non-rail spline to grindable at runtime once its effect chain runs - e.g. Spline_FallenTree_0/1 (style 1)
        // become rails after the tree's ~3.5 s fall sequence. Our import shows the fallen trunk statically, so we
        // surface them as always-on rails alongside the style-13 set (spec 390-teleport sibling; [Trailmap: 350-rails]).
        var candidates = LoadRailCandidates(levelDir);
        int rails = 0, segs = 0, fromToggle = 0, showoff = 0;
        for (int idx = 0; idx < parsed.Splines.Count; idx++)
        {
            var sp = parsed.Splines[idx];
            if (sp?.Segments == null || sp.Segments.Count == 0) continue;
            // Grindable rail styles: 13 (metal) and 12 (wood) are both authored as ride-on rails. A few rails carry
            // no style bit (e.g. a HalfPipeThing_Rail, style -1) - the name is their only signal, so keep it as a
            // fallback for style-less "Rail" splines.
            bool styleRail = sp.SplineStyle == 13 || sp.SplineStyle == 12 || (sp.SplineName != null && sp.SplineName.Contains("Rail"));
            bool toggleRail = candidates.Contains(idx);
            if (!styleRail && !toggleRail) continue;
            // A SHOW-OFF rail (HideShowOff turns it off in free-ride/race mode; Unity docs/026). We bake it grindable and
            // TAG it (Rails.Showoff) so the importer can disable it for the free-ride config - the bundle stays
            // mode-agnostic; the importer picks the rail set (RailGating).
            bool showoffRail = gatedSplines != null && gatedSplines.Contains(idx);
            if (toggleRail && !styleRail) fromToggle++;

            int start = info.Points.Count;
            int firstSeg = cubic.ControlPoints.Count / 4;   // this rail's first cubic segment (before we push any)
            int railSegs = 0;
            bool any = false; Vector3 lastEnd = Vector3.Zero;
            foreach (var seg in sp.Segments)
            {
                if (seg?.Points == null || seg.Points.Length < 4) continue;
                Vector3 p0 = Pt(seg.Points[0]), p1 = Pt(seg.Points[1]), p2 = Pt(seg.Points[2]), p3 = Pt(seg.Points[3]);
                for (int k = 0; k < n; k++) Add(info.Points, Bezier.Point(p0, p1, p2, p3, (float)k / n));
                Add(cubic.ControlPoints, p0); Add(cubic.ControlPoints, p1);   // 4 control points/segment, same order as sampled
                Add(cubic.ControlPoints, p2); Add(cubic.ControlPoints, p3);
                lastEnd = p3; any = true; railSegs++; segs++;
            }
            if (!any) continue;
            Add(info.Points, lastEnd);
            info.Start.Add(start);
            info.Count.Add(info.Points.Count - start);
            styles.Add(sp.SplineStyle);                       // parallel to Start/Count: the grind's own surface row
            cubic.SegStart.Add(firstSeg);
            cubic.SegCount.Add(railSegs);
            splineToRail[idx] = rails;                       // source spline -> this rail's network index
            // A MainType-25 toggle rail (not also a style-13 rail) starts DISABLED: grindable only after its
            // RailGate fires (the fallen tree). Recorded here as a rail-network index the runtime gates off.
            if (toggleRail && !styleRail) info.Gated.Add(rails);
            if (showoffRail) { info.Showoff.Add(rails); showoff++; }   // free-ride gating: importer disables these
            rails++;
        }
        if (rails == 0) return null;
        info.Cubic = cubic;
        Log.Info($"  Rails: {rails} splines, {segs} segments, {info.Points.Count} points (+ {cubic.ControlPoints.Count / 4} cubic segments)" +
                          (fromToggle > 0 ? $" ({fromToggle} from MainType-25 rail toggle)" : "") +
                          (showoff > 0 ? $" ({showoff} show-off rails tagged for free-ride gating)" : "") + ".");
        return info;
    }

    // Spline indices a MainType-25 node ENABLES as a rail-riding candidate anywhere in the effect graph
    // (SSF Spline.Effect != 0). Grindability is a per-spline runtime bit, SET by default for a style-13 rail; a
    // MainType-25 node moves it - Effect != 0 enables, Effect == 0 disables ([Trailmap: 350-rails]). We collect
    // only the ENABLES here; the DISABLES are the free-ride/show-off mode gating, handled separately (RailGating +
    // Rails.Showoff, Unity docs/026). An enable is e.g. a header's Spline_FallenTree_* splines
    // (style 1, off until the tree falls), so this returns those spline indices for a level that authors such a chain and empty elsewhere. Those become
    // baked rails that start DISABLED (Rails.Gated) and are turned on at runtime by an RailGate (Unity docs/026).
    static HashSet<int> LoadRailCandidates(string levelDir)
    {
        var set = new HashSet<int>();
        var root = SsfLogic.Load(levelDir);

        void Scan(IEnumerable<SsfHeader>? headers)
        {
            if (headers == null) return;
            foreach (var h in headers)
            {
                if (h?.Effects == null) continue;
                foreach (var e in h.Effects)
                    if (e != null && e.MainType == SsfMainType.ToggleRail && e.Spline != null && e.Spline.Effect != 0)
                        set.Add(e.Spline.SplineIndex);
            }
        }
        Scan(root?.EffectHeaders);
        Scan(root?.Functions);   // a MainType-25 node can also live in a shared SSF function
        return set;
    }

    static readonly string[] PathFiles = { "AIP.json", "SOP.json" };
    // internal: the billboard detector reads the same centreline to decide which face of a double-sided board
    // the riders see, and runs outside the bundle (at import time), so it asks for it with log: false.
    internal static BundleManifest.PolyInfo? BuildCourse(string levelDir, bool log = true)
    {
        var info = new BundleManifest.PolyInfo();
        var lineDtf = new List<float>();
        var seen = new HashSet<string>();
        int raceLines = 0, aiLines = 0;

        var files = new List<PathFile>();
        foreach (var file in PathFiles)
        {
            string path = Path.Combine(levelDir, file);
            if (!File.Exists(path)) continue;
            try { var p = JsonConvert.DeserializeObject<PathFile>(File.ReadAllText(path)); if (p != null) files.Add(p); }
            catch (Exception e)
            {
                Log.Warn($"  WARN: {path} is unreadable ({e.Message}) — its race lines and AI paths are left out.");
            }
        }

        // PASS 1: RACE LINES first (both files, deduped) so they are the LEADING polylines - their count = RaceLineCount,
        // and lineDtf stays parallel to those first entries. They carry the authored DistanceToFinish (the progress metric).
        foreach (var parsed in files)
            if (parsed.RaceLines != null)
                foreach (var rl in parsed.RaceLines)
                    if (rl != null && BakePath(rl.Name, rl.PathPos, rl.PathPoints, info, seen)) { lineDtf.Add(rl.DistanceToFinish); raceLines++; }

        // PASS 2: respawnable AI paths (for the out-of-bounds reset only; no DTF -> excluded from the progress metric).
        foreach (var parsed in files)
            if (parsed.AIPaths != null)
                foreach (var ap in parsed.AIPaths)
                    if (ap != null && ap.Respawnable && BakePath(ap.Name, ap.PathPos, ap.PathPoints, info, seen)) aiLines++;

        if (files.Count == 0 || (raceLines + aiLines) == 0) return null;
        info.LineDtf = lineDtf;
        info.RaceLineCount = raceLines;
        info.Checkpoints = LoadShowoffCheckpoints(levelDir);
        info.FinishArch = BuildFinishArch(levelDir, info);
        if (log)
            Log.Info($"  Course: {raceLines} race lines + {aiLines} AI/respawn lines, {info.Points.Count} points" +
                              (info.Checkpoints.Count > 0 ? $", {info.Checkpoints.Count} showoff checkpoint events" : "") +
                              (info.FinishArch != null ? $", finish arch {info.FinishArch.Size[0]:F0}x{info.FinishArch.Size[1]:F0}x{info.FinishArch.Size[2]:F0}." : ", no finish arch."));
        return info;
    }

    // Positive raw type-11 events on SOP race lines are the showoff time checkpoints. EventStart is an arc
    // station in the same horizontal metric as DTF. Several race lines can carry the same logical station for
    // alternate routes; cluster those by remaining DTF (within 2 m) regardless of value, because MEGAPLEX offers
    // different seconds on route alternatives at the same checkpoint.
    static List<BundleManifest.CourseCheckpointInfo> LoadShowoffCheckpoints(string levelDir)
    {
        string path = Path.Combine(levelDir, "SOP.json");
        if (!File.Exists(path)) return new();
        PathFile? parsed;
        try { parsed = JsonConvert.DeserializeObject<PathFile>(File.ReadAllText(path)); }
        catch (Exception e)
        {
            Log.Warn($"  WARN: {path} is unreadable ({e.Message}) — no showoff checkpoints.");
            return new();
        }
        var result = new List<BundleManifest.CourseCheckpointInfo>();
        if (parsed?.RaceLines == null) return result;
        foreach (var line in parsed.RaceLines)
        {
            if (line?.PathEvents == null) continue;
            foreach (var e in line.PathEvents)
            {
                if (e == null || e.EventType != 11 || e.EventValue <= 0) continue;
                if (!TryPointAtStation(line, e.EventStart, out Vector3 raw)) continue;
                float dtf = line.DistanceToFinish - e.EventStart;
                int group = -1;
                for (int i = 0; i < result.Count; i++)
                    if (MathF.Abs(result[i].Dtf - dtf) <= 200f) { group = result[i].Group; break; }
                if (group < 0) group = result.Count == 0 ? 0 : result.Max(c => c.Group) + 1;
                result.Add(new BundleManifest.CourseCheckpointInfo
                {
                    Position = new[] { -raw.X, raw.Y, raw.Z },
                    Dtf = dtf,
                    BonusSeconds = e.EventValue,
                    Group = group,
                });
            }
        }
        return result;
    }

    static bool TryPointAtStation(RaceLine line, float station, out Vector3 point)
    {
        float ax = line.PathPos != null && line.PathPos.Length >= 3 ? line.PathPos[0] : 0f;
        float ay = line.PathPos != null && line.PathPos.Length >= 3 ? line.PathPos[1] : 0f;
        float az = line.PathPos != null && line.PathPos.Length >= 3 ? line.PathPos[2] : 0f;
        point = new Vector3(ax, ay, az);
        if (line.PathPoints == null || line.PathPoints.Length == 0 || station < 0f) return false;
        float arc = 0f;
        foreach (var delta in line.PathPoints)
        {
            if (delta == null || delta.Length < 3) continue;
            Vector3 next = point + new Vector3(delta[0], delta[1], delta[2]);
            float length = MathF.Sqrt(delta[0] * delta[0] + delta[1] * delta[1]);
            if (station <= arc + length || ReferenceEquals(delta, line.PathPoints[^1]))
            {
                float t = length > 1e-6f ? Math.Clamp((station - arc) / length, 0f, 1f) : 0f;
                point = Vector3.Lerp(point, next, t);
                return true;
            }
            arc += length;
            point = next;
        }
        return true;
    }

    // ---- the finish arch --------------------------------------------------------------------------------
    // Every Tricky course places its finish gate as `Mdl_FinnishGate_*` instances (the game's spelling): a crossbar
    // plus two posts, straddling the point where the last race line's distance-to-finish reaches ZERO. That DTF=0
    // plane IS the finish (on MERQUER the level's checker-flag decal, Mdl_FinishLine_6000, starts on it to within
    // 0.14 m). `Mdl_StageArea_Finish_0` is NOT the line - it is the podium/corral 16-48 m further on, co-located
    // with Mdl_Finish_Stage/Screen/Coral. So we ship the arch's AABB and let the importer size its finish trigger
    // from the course's own geometry instead of a constant fitted to one level.
    const string ArchName = "FinnishGate";
    const float  ArchRadius = 6000f;   // SSX cm (60 m) around DTF=0: a decorative arch elsewhere can't be picked up

    static BundleManifest.BoxInfo? BuildFinishArch(string levelDir, BundleManifest.PolyInfo course)
    {
        if (!TryDtfZero(course, out Vector3 zero)) return null;
        string instPath = Path.Combine(levelDir, "Instances.json");
        string objPath = Path.Combine(levelDir, "Props.obj");
        if (!File.Exists(instPath) || !File.Exists(objPath)) return null;

        InstFile? insts;
        try { insts = JsonConvert.DeserializeObject<InstFile>(File.ReadAllText(instPath)); }
        catch (Exception e)
        {
            Log.Warn($"  WARN: {instPath} is unreadable ({e.Message}) — no finish arch.");
            return null;
        }
        if (insts?.Instances == null) return null;

        // Which instance indices are arch parts (Props.obj tags each group `... instN`, matching Instances.json order).
        var want = new HashSet<int>();
        for (int i = 0; i < insts.Instances.Count; i++)
            if (insts.Instances[i].InstanceName?.Contains(ArchName, StringComparison.OrdinalIgnoreCase) == true) want.Add(i);
        if (want.Count == 0) return null;

        // Per-part AABB from the props mesh - the parts' collision shape differs per level (bounds box, doorway body,
        // proxy mesh), but every one of them is a visible prop, so the mesh is the one representation always present.
        var mn = new Dictionary<int, Vector3>();
        var mx = new Dictionary<int, Vector3>();
        int cur = -1;
        foreach (var line in File.ReadLines(objPath))
        {
            if (line.Length < 2) continue;
            if (line[0] == 'o' && line[1] == ' ') { cur = ParseInst(line); continue; }
            if (line[0] != 'v' || line[1] != ' ' || !want.Contains(cur)) continue;
            var p = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (p.Length < 4) continue;
            Vector3 v = new(-PF(p[1]), PF(p[2]), PF(p[3]));   // SSX mesh space (X negated), same as Points
            if (mn.TryGetValue(cur, out Vector3 least)) { mn[cur] = Vector3.Min(least, v); mx[cur] = Vector3.Max(mx[cur], v); }
            else { mn[cur] = v; mx[cur] = v; }
        }

        Vector3 lo = new(float.MaxValue), hi = new(float.MinValue);
        int used = 0;
        foreach (var i in mn.Keys)
        {
            Vector3 c = (mn[i] + mx[i]) * 0.5f;
            if (Vector3.Distance(c, zero) > ArchRadius) continue;
            lo = Vector3.Min(lo, mn[i]); hi = Vector3.Max(hi, mx[i]); used++;
        }
        if (used == 0) return null;

        return new BundleManifest.BoxInfo
        {
            Name = ArchName,
            Center = BundleSpace.Xyz((lo + hi) * 0.5f),
            Size = BundleSpace.Xyz(hi - lo),
        };
    }

    // The DTF=0 crossing: walk each race line's own segments (anchored at its authored DistanceToFinish, minus the
    // HORIZONTAL arc length walked - the engine's metric) and take the interpolated point where DTF first crosses
    // zero. Race lines lead the polyline list, `.aip` lines before `.sop` ones, so the first crossing is the `.aip`
    // authoring - the one that lands on the arch. (Where the two disagree the `.sop` copy is late: on GARI its last
    // line zeroes ~14 m past the arch.) The last race line runs PAST the finish, so a crossing always exists.
    static bool TryDtfZero(BundleManifest.PolyInfo course, out Vector3 zero)
    {
        zero = Vector3.Zero;
        if (course.LineDtf == null) return false;
        int lines = Math.Min(course.RaceLineCount, Math.Min(course.Start.Count, course.LineDtf.Count));
        for (int r = 0; r < lines; r++)
        {
            int s = course.Start[r], c = course.Count[r];
            if (c < 2 || s < 0 || s + c > course.Points.Count) continue;
            float acc = 0f, dtf = course.LineDtf[r];
            for (int j = 1; j < c; j++)
            {
                Vector3 pa = Pt3(course.Points[s + j - 1]), pb = Pt3(course.Points[s + j]);
                float prev = acc;
                acc += MathF.Sqrt((pb.X - pa.X) * (pb.X - pa.X) + (pb.Y - pa.Y) * (pb.Y - pa.Y));   // horizontal (Z is up)
                float a = dtf - prev, b = dtf - acc;
                if (a <= 0f || b > 0f) continue;                        // want a > 0 >= b: the straddle
                zero = Vector3.Lerp(pa, pb, a / (a - b));               // DTF is linear along a straight segment
                return true;
            }
        }
        return false;
    }

    static Vector3 Pt3(float[] p) => new(p[0], p[1], p[2]);
    static float PF(string s) => float.Parse(s, System.Globalization.CultureInfo.InvariantCulture);
    static int ParseInst(string line)
    {
        int us = line.IndexOf("inst", StringComparison.Ordinal);
        if (us < 0) return -1;
        int s = us + 4, e = s;
        while (e < line.Length && line[e] >= '0' && line[e] <= '9') e++;
        return e > s && int.TryParse(line.AsSpan(s, e - s), out int n) ? n : -1;
    }

    // Newtonsoft populates these fields through reflection; direct assignments would only add DTO boilerplate.
#pragma warning disable CS0649
    class InstFile { public List<Inst>? Instances; }
    class Inst { public string? InstanceName { get; set; } }

    static bool BakePath(string? name, float[]? pathPos, float[][]? points, BundleManifest.PolyInfo info, HashSet<string> seen)
    {
        if (points == null || points.Length < 2) return false;
        float ax = pathPos != null && pathPos.Length >= 3 ? pathPos[0] : 0f;
        float ay = pathPos != null && pathPos.Length >= 3 ? pathPos[1] : 0f;
        float az = pathPos != null && pathPos.Length >= 3 ? pathPos[2] : 0f;
        var f0 = points[0];
        string sig = (name ?? "?") + "|" + (int)MathF.Round(ax + (f0 != null && f0.Length > 0 ? f0[0] : 0f))
                                   + "," + (int)MathF.Round(az + (f0 != null && f0.Length > 2 ? f0[2] : 0f));
        if (!seen.Add(sig)) return false;

        // PathPos is the path's FIRST VERTEX, not just an origin to hang the deltas off: the engine seeds its own
        // walk with it and then steps once per stored delta, so N deltas are a polyline of N+1 points and arc length
        // starts counting there ([Trailmap: 250-paths-aip-sop]). Emit it, so each line's head sits where the level
        // authored it - the out-of-bounds reset snaps a rider to the nearest point on these lines, and a line that
        // starts a segment late carries them further down-course than the authored path intended (a median 4-6 m
        // per path across the retail levels, up to 111 m on one Garibaldi line).
        int start = info.Points.Count, added = 1;
        info.Points.Add(new[] { -ax, ay, az });       // root-local (-x, y, z)
        foreach (var p in points)
        {
            if (p == null || p.Length < 3) continue;
            ax += p[0]; ay += p[1]; az += p[2];
            info.Points.Add(new[] { -ax, ay, az });
            added++;
        }
        if (added < 2) { info.Points.RemoveRange(start, added); return false; }
        info.Start.Add(start); info.Count.Add(added);
        return true;
    }

    static void Add(List<float[]> outPts, Vector3 v) => outPts.Add(BundleSpace.Xyz(v));
    static Vector3 Pt(float[]? p) => BundleSpace.MeshPt(p);

    class SplineFile { public List<Spline>? Splines; }
    class Spline { public string? SplineName; public int SplineStyle; public List<Segment>? Segments; }
    class Segment { public float[][]? Points; }

    class PathFile { public List<RaceLine>? RaceLines; public List<AIPath>? AIPaths; }
    class RaceLine { public string? Name; public float[]? PathPos; public float[][]? PathPoints; public float DistanceToFinish; public List<PathEvent>? PathEvents; }
    class PathEvent { public int EventType; public int EventValue; public float EventStart; public float EventEnd; }
    class AIPath { public string? Name; public float[]? PathPos; public float[][]? PathPoints; public bool Respawnable; }
#pragma warning restore CS0649
}
