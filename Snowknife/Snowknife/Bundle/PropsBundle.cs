using System.Globalization;
using System.Numerics;
namespace Snowknife.Bundle;

/// <summary>
/// Bakes the placed-object (prop) geometry the Unity importer's PropBuilder consumes. Parses
/// Props.obj + Instances.json, classifies each instance, and splits the output two ways:
///
///  - the MERGED STATIC mesh (the bulk of the props) -> one glTF "Props" node, per-instance lighting baked
///    into vertex colour, a submesh per MaterialID. The importer loads this directly.
///  - the DIVERTED instances (spinning gems, knock-and-tumble physics bodies, breakable LCD logos) -> one
///    glTF "Divert_{index}" node EACH, plus a manifest record (kind/role/cluster/pivot/lighting/physics).
///    These need their own GameObject + Udon engine-side, so the importer reads the records and wires the
///    behaviour; this is the ONLY place that classifies or lights them.
///
/// Classification (which instances divert, into which kind) and per-instance lighting live HERE ONLY - the
/// importer never re-derives them, so the two can't drift. Diverted node geometry is emitted ABSOLUTE (the
/// importer recentres spinners/physics on the recorded pivot) so no two identical gems collapse into one
/// glTF mesh. Output is SSX mesh space (X negated, Z up); GltfMeshWriter converts to glTF. See Unity docs/unity/003
/// (props), Unity docs/unity/010 (object lighting), Unity docs/012/016/028 (the diverted kinds), Snowknife docs/034.
/// </summary>
public static class PropsBundle
{
    readonly record struct ObjVert(int Position, int Uv, int Normal);

    // Presence mask used by the bundle and both Unity runtimes. LTG state 2 is the native Showoff object set
    // (the LTG GemIndex): it contains both trick-multiplier pickups and their Gem_RailSupport props, none of
    // which are enumerated by HideShowOff. Live retail verification confirms that whole set is absent in
    // Race and Freeride.
    public static int ModeMaskForInstance(bool nativeShowoffObject, bool hiddenByHideShowOff, bool hiddenByHideRace)
    {
        if (nativeShowoffObject) return 2;
        return (hiddenByHideShowOff ? 2 : 7) & (hiddenByHideRace ? 1 : 7);
    }

    public sealed class Opts
    {
        public float Scale = 0.01f;
        public bool PropLighting = true, PropStaticDirLight = true, PropDirLight = true;
        public Vector3 PropDirLightDir = new(-0.48f, 0.88f, 0f);
        public bool AnimateSpinners = true, BuildPhysicsProps = true, BuildBreakableLogos = true;
        public string[] PhysicsExcludeModels = System.Array.Empty<string>();
        // Props that get a pose-only LOCATOR emitted - an empty anchor at the prop's authored position + rotation -
        // so the importer / start-gate setup can align to them. The prop itself STAYS in the merged mesh (it is NOT
        // pulled out, so there's no render cost). Model-name substring match; the Cover/Light
        // overlays are skipped so the locator takes the gate STRUCTURE's pose. "Mdl_StartGate" -> the start gate the
        // post row anchors to. Empty array = no locators.
        //
        // The two StageArea markers are the ENGINE's own start/finish anchors, not decoration: Tricky hard-codes the
        // names `Mdl_StageArea_Start_0` / `Mdl_StageArea_Finish_0`, hashes them at runtime and transforms a fixed
        // six-rider staging formation through the Start one ([Trailmap: 120-objects, 390-pickups-and-race]). So the
        // Start marker IS where a course begins - the importer spawns there instead of guessing at the top of the
        // path network, which is a different place entirely on a lap course. Finish is the post-race podium/corral
        // 20-48 m PAST the finish line, not the line (that stays the DTF=0 crossing; see BuildFinishArch). Both
        // models carry a ~1 x 0.1 x 1 m box, so they reach Props.obj and this walk like any other prop.
        public string[] LocatorModelMatches = { "Mdl_StartGate", "Mdl_StageArea_Start", "Mdl_StageArea_Finish" };
    }

    public sealed class Result
    {
        public GltfMeshWriter.Node Static = new() { Name = "Props" };          // merged static prop mesh
        public GltfMeshWriter.Node? ShowoffStatic;                             // show-off-only static props (HideShowOff targets)
        public GltfMeshWriter.Node? RaceStatic;                                // race-only static props (HideRace targets)
        public List<GltfMeshWriter.Node> Diverted = new();                     // one node per diverted instance
        public List<BundleManifest.DivertInfo> Records = new();                // matching manifest metadata
        public List<BundleManifest.LocatorInfo> Locators = new();              // pose-only anchors (e.g. the start gate)
        public string Stats = "";
    }

    // One diverted instance under construction: its own welded vertex pool (dedup per (vIdx,vtIdx,vnIdx)) + the
    // classification/physics/sound facts carried from Instances.json.
    sealed class DivAccum
    {
        public int Index;
        public string Kind = "";                 // spinner | physics | breakable | mover | softflag | softfence | boostpad | button
        public string Model = "";
        public List<BundleManifest.AnimTriggerBox>? Triggers;   // button only: the volumes whose crossing pulses it
        public int[]? PulseFrames;               // button only: the replayed pulse - frame index per segment
        public float[]? PulseHolds;              // button only: how long each segment holds, seconds
        public string? Role, ClusterKey;         // breakable only
        public string? SpillCluster;             // physics only: the breakable cluster this knock body also throws (Unity docs/036)
        public float[]? Throw;                   // breakable only: the cluster's Sub20 mesh-throw piece params
        public float[]? BurstColor;              // breakable "intact" only: star-burst [r,g,b] (balloon pop); null otherwise
        public float BreakDelay;                 // breakable "intact" only: roll-away chain wait before the swap (Unity docs/036)
        public int BreakSound = -1;              // breakable "intact" only: roll-away raw-slot crash at the swap
        public float CrackStrength;              // breakable "intact" only: fragile-surface impact pool (0 = instant break)
        public float CrackLifetime;              // breakable "intact" only: seconds a crack lasts (-1 = never heals)
        public int CrackSound = -1;              // breakable "intact" only: the glancing-hit crack's raw slot
        public string? SoundClip;                // optional staged WAV carried by the canonical instance
        public float? PhysicsMass;               // Roller payload U0
        public int ModeMask = 7;                 // race=1, show-off=2, freeride=4
        public SsxInstance Inst = null!;
        public readonly List<Vector3> Pos = new();
        public readonly List<Vector3> Nrm = new();
        public readonly List<Vector2> Uv = new();
        public readonly List<int> SrcV = new();  // per Pos entry: the OBJ v index (welds (v,vt)-split verts for the piece split)
        public readonly Dictionary<ObjVert, int> Vmap = new();
        public readonly Dictionary<string, List<int>> TriBySlot = new(System.StringComparer.Ordinal);
    }

    public static Result Build(string levelDir, Opts o, Dictionary<int, BreakableClassifier.Member>? breakMap = null,
                               HashSet<int>? animSet = null, HashSet<int>? hiddenInstances = null, HashSet<int>? rollerPhysics = null,
                               Dictionary<int, float>? rollerMasses = null,
                               HashSet<int>? splineMovers = null, HashSet<int>? softFlags = null, HashSet<int>? softFences = null,
                               HashSet<int>? gemInstances = null,
                               HashSet<int>? boostPads = null,
                               Dictionary<int, List<BundleManifest.EmitterLayerInfo>>? burstLayers = null,
                               Dictionary<int, string>? spillSources = null,
                               Dictionary<int, TriggeredFlipClassifier.Pulse>? pulses = null,
                               Dictionary<int, BundleManifest.AnimTriggerBox>? pulseBoxes = null,
                               Dictionary<int, (int[] frames, float[] holds)>? pulseTimelines = null,
                               HashSet<int>? raceHiddenInstances = null)
    {
        string objPath = Path.Combine(levelDir, "Props.obj");
        if (!File.Exists(objPath)) throw new FileNotFoundException($"Props.obj not found in '{levelDir}'.");
        var instances = SsxInstances.Load(levelDir)
            ?? throw new FileNotFoundException($"Instances.json not found in '{levelDir}'.");
        breakMap ??= new Dictionary<int, BreakableClassifier.Member>();
        spillSources ??= new Dictionary<int, string>();
        animSet ??= new HashSet<int>();
        hiddenInstances ??= new HashSet<int>();       // HideShowOff targets: present only in show-off mode
        raceHiddenInstances ??= new HashSet<int>();   // HideRace targets: present only in race mode
        bool lighting = o.PropLighting;
        bool doStaticDir = lighting && o.PropStaticDirLight;

        // Shared OBJ pools (1-based in faces). X negated to match the terrain build.
        var pos = new List<Vector3>(1 << 20);
        var uvs = new List<Vector2>(1 << 20);
        var normals = new List<Vector3>(1 << 20);

        // Merged static mesh accumulator. The normal index is part of the key so native hard edges survive.
        var wPos = new List<Vector3>(1 << 20);
        var wNrm = new List<Vector3>(1 << 20);
        var wUv = new List<Vector2>(1 << 20);
        // Crowd cell identity, carried per-vertex as glTF TEXCOORD_1 = (cell id 0..15, instance ordinal).
        // The writer already emits a zero-filled second UV set for rich meshes, so this costs nothing on
        // crowd-less levels; the Unity shader's _CROWD path reads it to run each cell's independent stream.
        var wUv1 = new List<Vector2>(1 << 20);
        var wCol = new List<Vector4>(1 << 20);
        var vmap = new Dictionary<ObjVert, int>(1 << 20);
        var triBySlot = new Dictionary<string, List<int>>(System.StringComparer.Ordinal);
        var staticLit = new List<(int start, SsxInstance? inst)>();

        // Free-ride gating (RailGating, Unity docs/026): the show-off rail models (hiddenInstances) accumulate into a
        // SECOND merged mesh, kept out of "Props", emitted as the "PropsShowoff" node. Same shape as the main
        // accumulators; the importer builds it only when NOT gating (so a free-ride import hides them).
        var wPosS = new List<Vector3>();
        var wNrmS = new List<Vector3>();
        var wUvS = new List<Vector2>();
        var wColS = new List<Vector4>();
        var vmapS = new Dictionary<ObjVert, int>();
        var triBySlotS = new Dictionary<string, List<int>>(System.StringComparer.Ordinal);
        var staticLitS = new List<(int start, SsxInstance? inst)>();

        // Race-only static props use a third merged node. GARI's current targets are diverted boost pads, but keeping
        // this generic preserves authored mode gating if another level targets an ordinary static prop.
        var wPosR = new List<Vector3>();
        var wNrmR = new List<Vector3>();
        var wUvR = new List<Vector2>();
        var wColR = new List<Vector4>();
        var vmapR = new Dictionary<ObjVert, int>();
        var triBySlotR = new Dictionary<string, List<int>>(System.StringComparer.Ordinal);
        var staticLitR = new List<(int start, SsxInstance? inst)>();

        // Diverted instances, in OBJ encounter order.
        var diverts = new List<DivAccum>();
        // Pose-only locators (the start gate). EVERY qualifying instance is emitted, not just the first per key:
        // Alaska authors two `Mdl_StartGate_*` and the one that matters is the one at the grid, which is not the
        // one that happens to come first in instance order. Which to use is a question about the COURSE, and the
        // importer is where the course line lives - so the bundle carries them all, in instance order, and the
        // consumer picks (BundleManifestReader.BestLocator).
        var locators = new List<BundleManifest.LocatorInfo>();

        Vector4 curCol = new(1, 1, 1, 1);
        bool curVisible = true;
        bool curShowoff = false;                  // the current 'o' group is a show-off rail model -> the PropsShowoff mesh
        bool curRace = false;                     // the current 'o' group is race-only -> the PropsRace mesh
        DivAccum? curDiv = null;                  // non-null = the current 'o' group is a diverted instance
        SsxInstance? curInst = null;
        string curSlot = "mat_untextured";
        // Crowd cell state. curCrowdCell tracks curSlot (a "mat_crowd_c<NN>" slot; -1 = not crowd) and, like
        // curSlot, persists across 'o' groups (OBJ material state carries over). instOrdinal is the running
        // 'o'-group ordinal - the per-stand seed that de-correlates identical cells of neighbouring stands.
        int curCrowdCell = -1, instOrdinal = -1;
        bool anyCrowd = false;
        int placed = 0, hidden = 0, lit = 0, animSkipped = 0, gatedOut = 0, raceOut = 0;

        // Resolve an OBJ "v/vt/vn" token; -1 position when unparseable. Custom OBJ input may omit normals;
        // extracted/current authored props carry them and preserve their exact splits.
        bool ParseTok(string tok, out int vi, out int ti, out int ni)
        {
            ti = -1; ni = -1;
            int slash = tok.IndexOf('/');
            if (slash < 0) { if (!int.TryParse(tok, out vi)) return false; }
            else
            {
                if (!int.TryParse(tok.AsSpan(0, slash), out vi)) return false;
                int slash2 = tok.IndexOf('/', slash + 1);
                var tt = slash2 < 0 ? tok.AsSpan(slash + 1) : tok.AsSpan(slash + 1, slash2 - slash - 1);
                // A token that fails to parse reads as 0, outside the 1-based OBJ index space; the line below
                // already turns that into "absent".
                if (tt.Length > 0) _ = int.TryParse(tt, out ti);
                if (slash2 >= 0)
                {
                    var nn = tok.AsSpan(slash2 + 1);
                    if (nn.Length > 0) _ = int.TryParse(nn, out ni);
                }
            }
            vi -= 1; ti = ti > 0 ? ti - 1 : -1; ni = ni > 0 ? ni - 1 : -1;
            return vi >= 0 && vi < pos.Count;
        }

        // OBJ vt is bottom-left origin (Unity/OpenGL). Store glTF top-left (V flipped) so the Unity loader's
        // (1-v) flip restores the raw OBJ vt exactly (shared by merged + diverted).
        Vector2 Vt(int ti) => ti >= 0 && ti < uvs.Count ? new Vector2(uvs[ti].X, 1f - uvs[ti].Y) : Vector2.Zero;
        Vector3 Vn(int ni) => ni >= 0 && ni < normals.Count ? normals[ni] : Vector3.Zero;

        int MeshVert(string tok)
        {
            if (!ParseTok(tok, out int vi, out int ti, out int ni)) return -1;
            var key = new ObjVert(vi, ti, ni);
            if (vmap.TryGetValue(key, out int idx)) return idx;
            idx = wPos.Count;
            wPos.Add(pos[vi]); wNrm.Add(Vn(ni)); wUv.Add(Vt(ti)); wCol.Add(curCol);
            // y stores 1 - ordinal: the Unity loader flips every UV set's V (1-v), which restores the
            // raw ordinal exactly (same convention as Vt above). x (the cell id) is not flipped.
            wUv1.Add(curCrowdCell >= 0 ? new Vector2(curCrowdCell, 1f - instOrdinal) : Vector2.Zero);
            vmap[key] = idx;
            return idx;
        }

        // Show-off merged mesh (PropsShowoff) - same dedup, its own pools.
        int MeshVertS(string tok)
        {
            if (!ParseTok(tok, out int vi, out int ti, out int ni)) return -1;
            var key = new ObjVert(vi, ti, ni);
            if (vmapS.TryGetValue(key, out int idx)) return idx;
            idx = wPosS.Count;
            wPosS.Add(pos[vi]); wNrmS.Add(Vn(ni)); wUvS.Add(Vt(ti)); wColS.Add(curCol);
            vmapS[key] = idx;
            return idx;
        }

        int MeshVertR(string tok)
        {
            if (!ParseTok(tok, out int vi, out int ti, out int ni)) return -1;
            var key = new ObjVert(vi, ti, ni);
            if (vmapR.TryGetValue(key, out int idx)) return idx;
            idx = wPosR.Count;
            wPosR.Add(pos[vi]); wNrmR.Add(Vn(ni)); wUvR.Add(Vt(ti)); wColR.Add(curCol);
            vmapR[key] = idx;
            return idx;
        }

        int DivVert(DivAccum d, string tok)
        {
            if (!ParseTok(tok, out int vi, out int ti, out int ni)) return -1;
            var key = new ObjVert(vi, ti, ni);
            if (d.Vmap.TryGetValue(key, out int idx)) return idx;
            idx = d.Pos.Count;
            d.Pos.Add(pos[vi]); d.Nrm.Add(Vn(ni)); d.Uv.Add(Vt(ti)); d.SrcV.Add(vi);
            d.Vmap[key] = idx;
            return idx;
        }

        foreach (var line in File.ReadLines(objPath))
        {
            if (line.Length < 2) continue;
            char c0 = line[0], c1 = line[1];
            if (c0 == 'v' && c1 == ' ')
            {
                var p = line.Split(' ', System.StringSplitOptions.RemoveEmptyEntries);
                if (p.Length >= 4) pos.Add(new Vector3(-PF(p[1]), PF(p[2]), PF(p[3])));
            }
            else if (c0 == 'v' && c1 == 't')
            {
                var p = line.Split(' ', System.StringSplitOptions.RemoveEmptyEntries);
                if (p.Length >= 3) uvs.Add(new Vector2(PF(p[1]), PF(p[2])));
            }
            else if (c0 == 'v' && c1 == 'n')
            {
                var p = line.Split(' ', System.StringSplitOptions.RemoveEmptyEntries);
                if (p.Length >= 4)
                {
                    Vector3 n = new(-PF(p[1]), PF(p[2]), PF(p[3]));
                    normals.Add(n.LengthSquared() > 1e-12f ? Vector3.Normalize(n) : Vector3.Zero);
                }
            }
            else if (c0 == 'o' && c1 == ' ')
            {
                placed++;
                instOrdinal++;
                curCol = new Vector4(1, 1, 1, 1); curVisible = true; curShowoff = false; curRace = false; curDiv = null; curInst = null;
                int us = line.IndexOf("inst", System.StringComparison.Ordinal);
                    if (us >= 0)
                    {
                        int s = us + 4, e = s;
                        while (e < line.Length && line[e] >= '0' && line[e] <= '9') e++;
                        if (e > s && int.TryParse(line.AsSpan(s, e - s), out int n) && n >= 0 && n < instances.Count)
                        {
                            var inst = instances[n];
                            curInst = inst;
                            curVisible = inst.Visable;
                            string model = (e + 1) < line.Length ? line.Substring(e + 1).Trim() : "";

                            // Animated props (AnimatedPropsBundle) ship as their own MODEL-LOCAL segment nodes -
                            // the merged Props.obj group bakes the rest pose into world space, so merging it too
                            // would draw the bridge twice. Keep them out of the merge and the divert kinds.
                            if (animSet.Contains(n)) { curVisible = false; animSkipped++; continue; }

                            // Classify. Breakable takes precedence (a screen/fence is never a spinner/body) and matches
                            // REGARDLESS of Visable - the broken _Junk twin ships invisible and is force-emitted. Spin /
                            // physics only when visible. This is the single authority; the importer reads the result.
                            // LCD logos stay NAME-matched (LogoRole, the proven path); every OTHER breakable (fences,
                            // hole covers, tree branches) comes from the SSF break classifier (Unity docs/036), keyed by
                            // instance index, consulted only when the name match misses so logos are untouched.
                            // Pose-only LOCATOR for a designated prop (the start gate): record its authored pose so
                            // the importer can place an empty anchor the post row aligns to. The prop STAYS in the
                            // merged mesh (no divert); skip the Cover/Light overlays so the locator takes the gate
                            // STRUCTURE's pose. MeshPt/MirrorQuat apply the same X-negation the geometry gets, so the
                            // anchor lands on the gate with its true yaw.
                            if (IsLocator(model, o, out string? locKey)
                                && model.IndexOf("Cover", System.StringComparison.Ordinal) < 0
                                && model.IndexOf("Light", System.StringComparison.Ordinal) < 0)
                                locators.Add(new BundleManifest.LocatorInfo
                                {
                                    Key = locKey!,
                                    Center = BundleSpace.Xyz(BundleSpace.MeshPt(inst.Location)),
                                    Rotation = MirrorQuat(inst.Rotation),
                                });

                            bool isSpin = curVisible && o.AnimateSpinners && gemInstances != null && gemInstances.Contains(n);
                            bool isPhys = curVisible && o.BuildPhysicsProps
                                          && rollerPhysics != null && rollerPhysics.Contains(n)
                                          && !PhysicsModelExcluded(model, o);
                            bool isMover = splineMovers != null && splineMovers.Contains(n);   // spline mover: divert even when INVISIBLE (the subway template)
                            bool isFlag  = softFlags != null && softFlags.Contains(n);         // soft-prop wind: pull out of the merge into the combined wind mesh
                            bool isFence = softFences != null && softFences.Contains(n);
                            // Scripted-break obstacles - fences/hole-covers/branches (inline M7) AND LCD jumbotrons
                            // (MainType-21 BreakLogo function) - all come from the SSF break classifier, keyed by
                            // instance index. Yields to spinner/physics: a trick-gem also "hides the source" on pickup
                            // (so the classifier flags it), but it's a SPINNER pickup, not a breakable.
                            string? role = null;
                            string? cluster = null;
                            float[]? throwParams = null;
                            float[]? burstColor = null;
                            float breakDelay = 0f;
                            int breakSound = -1;
                            float crackStrength = 0f, crackLifetime = 0f;
                            int crackSound = -1;
                            if (o.BuildBreakableLogos && !isSpin && !isPhys && breakMap.TryGetValue(n, out var bm)
                                // A cracked pane's "support" twin is COLLISION-ONLY (Unity docs/036): the invisible solid
                                // slab holding the rider up until the glass gives way. It has no render job at all,
                                // so diverting it would build a second, hidden copy of the pane inside the cluster -
                                // and one that BuildBreakableLogos would give a renderer and hide on break. It
                                // reaches Unity as its own collision bucket instead (CollisionBundle), keyed by the
                                // same cluster.
                                && bm.Role != "support")
                            {
                                role = bm.Role; cluster = bm.ClusterKey; throwParams = bm.Throw; burstColor = bm.BurstColor;
                                breakDelay = bm.BreakDelay; breakSound = bm.BreakSound;
                                crackStrength = bm.CrackStrength; crackLifetime = bm.CrackLifetime; crackSound = bm.CrackSound;
                            }
                            bool isBreak = role != null;
                            // A knock body whose OWN collision chain ALSO throws a hidden contents twin (a city map's
                            // garbage cans / news boxes / mail boxes, Unity docs/036): the kind stays "physics" - it IS a
                            // Roller body and must keep its Rigidbody, impact sound and knock - but it carries the
                            // cluster it throws so the importer can fire those pieces off the knock. Without this the
                            // spill is the one authored response the single-valued kind silently drops.
                            string? spillCluster = isPhys && o.BuildBreakableLogos && spillSources.TryGetValue(n, out var sc) ? sc : null;
                            // Speed/trick boost pads (Unity docs/040): divert the decal so the runtime can pop + regrow it
                            // on a cross. Lowest precedence - a pad is never also a spinner/body/breakable, so this
                            // only ever fires for a genuine pad, and it keeps the established kinds untouched.
                            bool isPad = curVisible && !isBreak && !isSpin && !isPhys && !isMover && !isFlag && !isFence
                                         && boostPads != null && boostPads.Contains(n);
                            // Ride-over BUTTONS (Unity docs/008): a trigger volume's collision chain briefly pulses this
                            // instance's two-frame material. It has to leave the merged mesh because the pulse is PER
                            // INSTANCE - retail builds the node its own private material override table, so only the
                            // button you crossed changes, and a merged prim has no way to address one. Lowest
                            // precedence, like the pads: a button is never another kind.
                            bool isButton = curVisible && !isBreak && !isSpin && !isPhys && !isMover && !isFlag && !isFence
                                            && !isPad && pulses != null && pulses.ContainsKey(n);
                            if (isBreak || isSpin || isPhys || isMover || isFlag || isFence || isPad || isButton)
                            {
                                int modeMask = ModeMaskForInstance(inst.LTGState == 2, hiddenInstances.Contains(n), raceHiddenInstances.Contains(n));
                                curDiv = new DivAccum
                                {
                                    Index = n, Model = model, Inst = inst,
                                    ModeMask = modeMask,
                                    Kind = isBreak ? "breakable" : isSpin ? "spinner" : isPhys ? "physics" : isMover ? "mover" : isFlag ? "softflag" : isFence ? "softfence" : isPad ? "boostpad" : "button",
                                    Triggers = isButton ? PulseTriggers(pulses![n], pulseBoxes) : null,
                                    PulseFrames = isButton && pulseTimelines != null && pulseTimelines.TryGetValue(n, out var tl) ? tl.frames : null,
                                    PulseHolds = isButton && pulseTimelines != null && pulseTimelines.TryGetValue(n, out var tl2) ? tl2.holds : null,
                                    Role = isBreak ? role : null,
                                    ClusterKey = isBreak ? cluster : null,
                                    SpillCluster = spillCluster,
                                    Throw = isBreak ? throwParams : null,
                                    BurstColor = isBreak ? burstColor : null,
                                    BreakDelay = isBreak ? breakDelay : 0f,
                                    BreakSound = isBreak ? breakSound : -1,
                                    CrackStrength = isBreak ? crackStrength : 0f,
                                    CrackLifetime = isBreak ? crackLifetime : 0f,
                                    CrackSound = isBreak ? crackSound : -1,
                                    PhysicsMass = isPhys && rollerMasses != null && rollerMasses.TryGetValue(n, out float rollerMass)
                                        ? rollerMass : null,
                                    SoundClip = inst.SoundClip,
                                };
                                diverts.Add(curDiv);
                            }
                            else if (curVisible)
                            {
                                int modeMask = ModeMaskForInstance(inst.LTGState == 2,
                                    hiddenInstances.Contains(n), raceHiddenInstances.Contains(n));
                                if (modeMask == 2)
                                {
                                    curShowoff = true; gatedOut++;
                                    if (lighting) curCol = LightColour(inst, o);
                                    if (doStaticDir) staticLitS.Add((wPosS.Count, inst));
                                }
                                else if (modeMask == 1)
                                {
                                    curRace = true; raceOut++;
                                    if (lighting) curCol = LightColour(inst, o);
                                    if (doStaticDir) staticLitR.Add((wPosR.Count, inst));
                                }
                                else if (modeMask == 0) curVisible = false;
                                else if (lighting) { curCol = LightColour(inst, o); lit++; }
                            }
                        }
                }
                if (curDiv == null && !curVisible) hidden++;
                if (doStaticDir && curDiv == null && curVisible && !curShowoff && !curRace) staticLit.Add((wPos.Count, curInst));
            }
            else if (c0 == 'u' && line.StartsWith("usemtl ", System.StringComparison.Ordinal))
            {
                curSlot = line.Substring(7).Trim();
                // Per-cell crowd slots ("mat_crowd_c<NN>") fold into ONE "mat_crowd" prim; the cell id +
                // stand ordinal ride TEXCOORD_1 instead, so the merged mesh keeps a single crowd draw
                // while the shader can still animate the 16 retail cells independently.
                if (curSlot.StartsWith("mat_crowd", System.StringComparison.Ordinal))
                {
                    curCrowdCell = 0;
                    int c = curSlot.IndexOf("_c", 9, System.StringComparison.Ordinal);
                    if (c >= 0 && int.TryParse(curSlot.AsSpan(c + 2), out int cell)) curCrowdCell = cell & 15;
                    curSlot = "mat_crowd";
                    anyCrowd = true;
                }
                else curCrowdCell = -1;
            }
            else if (c0 == 'f' && c1 == ' ')
            {
                var p = line.Split(' ', System.StringSplitOptions.RemoveEmptyEntries);
                if (p.Length < 4) continue;
                if (curDiv != null)
                {
                    // diverted instance (force-emit, incl. the invisible broken-logo twin)
                    if (!curDiv.TriBySlot.TryGetValue(curSlot, out var dt)) { dt = new List<int>(); curDiv.TriBySlot[curSlot] = dt; }
                    int v0 = DivVert(curDiv, p[1]);
                    for (int k = 2; k < p.Length - 1; k++)
                    {
                        int v1 = DivVert(curDiv, p[k]), v2 = DivVert(curDiv, p[k + 1]);
                        if (v0 >= 0 && v1 >= 0 && v2 >= 0) { dt.Add(v0); dt.Add(v1); dt.Add(v2); }
                    }
                }
                else if (curShowoff)                            // show-off rail model -> the separate PropsShowoff mesh
                {
                    if (!triBySlotS.TryGetValue(curSlot, out var tris)) { tris = new List<int>(); triBySlotS[curSlot] = tris; }
                    int v0 = MeshVertS(p[1]);
                    for (int k = 2; k < p.Length - 1; k++)
                    {
                        int v1 = MeshVertS(p[k]), v2 = MeshVertS(p[k + 1]);
                        if (v0 >= 0 && v1 >= 0 && v2 >= 0) { tris.Add(v0); tris.Add(v1); tris.Add(v2); }
                    }
                }
                else if (curRace)                               // race-only prop -> the separate PropsRace mesh
                {
                    if (!triBySlotR.TryGetValue(curSlot, out var tris)) { tris = new List<int>(); triBySlotR[curSlot] = tris; }
                    int v0 = MeshVertR(p[1]);
                    for (int k = 2; k < p.Length - 1; k++)
                    {
                        int v1 = MeshVertR(p[k]), v2 = MeshVertR(p[k + 1]);
                        if (v0 >= 0 && v1 >= 0 && v2 >= 0) { tris.Add(v0); tris.Add(v1); tris.Add(v2); }
                    }
                }
                else
                {
                    if (!curVisible) continue;                  // merged invisible volume - draw nothing
                    if (!triBySlot.TryGetValue(curSlot, out var tris)) { tris = new List<int>(); triBySlot[curSlot] = tris; }
                    int v0 = MeshVert(p[1]);
                    for (int k = 2; k < p.Length - 1; k++)
                    {
                        int v1 = MeshVert(p[k]), v2 = MeshVert(p[k + 1]);
                        if (v0 >= 0 && v1 >= 0 && v2 >= 0) { tris.Add(v0); tris.Add(v1); tris.Add(v2); }
                    }
                }
            }
        }

        if (wPos.Count == 0) throw new InvalidOperationException("Props.obj produced no static geometry.");

        var result = new Result();
        result.Locators.AddRange(locators);

        // ---- merged static mesh ------------------------------------------------------------------------
        // Finalize a merged static mesh (outward normals + per-instance directional bake, Unity docs/unity/010) into a node.
        // Shared by the main "Props" mesh and the separate "PropsShowoff" free-ride mesh.
        void FinishStatic(GltfMeshWriter.Node node, List<Vector3> wp, List<Vector3> wn, List<Vector2> wu, List<Vector4> wc,
                          Dictionary<string, List<int>> tbs, List<(int start, SsxInstance? inst)> sl,
                          List<Vector2>? wu1 = null)
        {
            if (wp.Count == 0) return;
            var fallback = OutwardNormals(wp, tbs.Values);
            var nn = new Vector3[wp.Count];
            for (int i = 0; i < nn.Length; i++)
                nn[i] = i < wn.Count && wn[i].LengthSquared() > 1e-12f ? Vector3.Normalize(wn[i]) : fallback[i];
            if (doStaticDir)
            {
                Vector3 ws = o.PropDirLightDir;
                Vector3 meshSun = Vector3.Normalize(new Vector3(ws.X, -ws.Z, ws.Y));
                for (int k = 0; k < sl.Count; k++)
                {
                    int start = sl[k].start;
                    int end = (k + 1 < sl.Count) ? sl[k + 1].start : wp.Count;
                    var inst = sl[k].inst;
                    if (inst == null || end <= start) continue;
                    for (int v = start; v < end && v < wp.Count; v++)
                        wc[v] = PropLighting.Evaluate(inst, nn[v], meshSun);
                }
            }
            var nList = new List<Vector3>(nn);
            foreach (var kv in tbs)
                node.Prims.Add(new GltfMeshWriter.Prim
                {
                    Material = kv.Key,                       // the OBJ usemtl slot (e.g. "mat_10") = MaterialID
                    Positions = wp, Normals = nList, Uv0 = wu, Uv1 = wu1,
                    Colors = lighting ? wc : null, Indices = kv.Value,
                });
        }

        FinishStatic(result.Static, wPos, wNrm, wUv, wCol, triBySlot, staticLit, anyCrowd ? wUv1 : null);
        if (wPosS.Count > 0)
        {
            result.ShowoffStatic = new GltfMeshWriter.Node { Name = "PropsShowoff" };
            FinishStatic(result.ShowoffStatic, wPosS, wNrmS, wUvS, wColS, triBySlotS, staticLitS);
        }
        if (wPosR.Count > 0)
        {
            result.RaceStatic = new GltfMeshWriter.Node { Name = "PropsRace" };
            FinishStatic(result.RaceStatic, wPosR, wNrmR, wUvR, wColR, triBySlotR, staticLitR);
        }

        // Per throw-cluster (Sub20 mesh-throw, Unity docs/036): the member whose mesh gets SPLIT into thrown pieces -
        // the revealed "broken" twin when one exists (hole covers / fences / LCD logos), else the source itself
        // (tree branches, whose Sub20 animates the intact prop directly).
        //
        // The broken TWIN is always a piece source: its connected components ARE the shattered pieces, whether or
        // not the break carries a Sub20. SSF-classified breakables (fences/hole-covers) ship a Sub20 throw; the
        // name-matched LCD logos (Mdl_Lcd_ScreenLogoBroken*) ship none, but their broken twin is the same kind of
        // real multi-shard model - split it the same way so the screen shatters into its actual pieces instead of
        // falling back to the sprite-debris burst. Pieces with no Sub20 throw with BreakableLogoU's default
        // mesh-throw (Sub20) params (PropBuilder keeps the component defaults when the record's Throw is null). A twin that
        // is a single welded sheet won't split (EmitPieces' component guard) and keeps the plain hide/reveal path.
        // The SOURCE-self case (tree branches) still requires a real Sub20 - it has no twin to split.
        var pieceSourceByCluster = new Dictionary<string, DivAccum>(System.StringComparer.Ordinal);
        foreach (var d in diverts)
        {
            if (d.Kind != "breakable" || d.ClusterKey == null) continue;
            if (d.Role == "broken") pieceSourceByCluster[d.ClusterKey] = d;
            else if (d.Role == "intact" && d.Throw != null && !pieceSourceByCluster.ContainsKey(d.ClusterKey)) pieceSourceByCluster[d.ClusterKey] = d;
        }

        // ---- diverted instances --------------------------------------------------------------------
        int spin = 0, phys = 0, brk = 0, pieces = 0;
        foreach (var d in diverts)
        {
            if (d.Pos.Count == 0 || d.TriBySlot.Count == 0) continue;
            if (d.Kind == "physics" || d.Kind == "spinner") continue;   // GPU-instanced by model in the dedicated pass below

            var dn = ResolveNormals(d.Pos, d.Nrm, d.TriBySlot.Values);
            var dnList = new List<Vector3>(dn);

            bool isPieceSource = d.ClusterKey != null && pieceSourceByCluster.TryGetValue(d.ClusterKey, out var ps) && ReferenceEquals(ps, d);
            int emitted = isPieceSource ? EmitPieces(d, dnList, o, result) : 0;
            pieces += emitted;
            // A split "broken" twin is fully replaced by its pieces (same union geometry; one record each).
            // A split "intact" source still emits its normal record below - it's the visible prop until the break.
            if (emitted > 0 && d.Role == "broken") { brk++; continue; }

            // Pivot: spinners recentre on the vertex centroid (the importer subtracts it + sets it as
            // localPosition, so the geometry stays put but rotates/sits about its own centre); breakable stays
            // absolute (Center 0) so a screen's intact/broken/scanline meshes line up at a shared localPos 0.
            // A spline MOVER rides its MODEL ORIGIN down the spline - the engine drops the spline point straight
            // into its matrix's translation and leaves the vertices model-local - so its pivot is the instance
            // origin, not the centroid. Centroid here would sink the prop by its own half-height and drag it off
            // the rails by the offset from its origin to its middle.
            Vector3 center = Vector3.Zero;
            if (d.Kind == "mover")
            {
                center = BundleSpace.MeshPt(d.Inst.Location);
            }
            else if (d.Kind != "breakable")
            {
                for (int i = 0; i < d.Pos.Count; i++) center += d.Pos[i];
                center /= d.Pos.Count;
            }

            var node = new GltfMeshWriter.Node { Name = $"Divert_{d.Index}" };
            foreach (var kv in d.TriBySlot)
                node.Prims.Add(new GltfMeshWriter.Prim
                {
                    Material = kv.Key, Positions = d.Pos, Normals = dnList, Uv0 = d.Uv, Indices = kv.Value,
                });
            result.Diverted.Add(node);

            var rec = new BundleManifest.DivertInfo
            {
                Index = d.Index, Kind = d.Kind, Node = node.Name, Model = d.Model,
                ModeMask = d.ModeMask,
                Role = d.Role, ClusterKey = d.ClusterKey, SpillCluster = d.SpillCluster,
                Center = BundleSpace.Xyz(center),
                DynamicMass = d.Kind == "physics" ? PhysicsMass(d) : 0f,
                Bounce = d.Inst.PlayerBounceAmmount, CollisonSound = d.Inst.CollisonSound,
                SoundClip = d.SoundClip,
                BurstColor = d.BurstColor,
                BreakDelay = d.BreakDelay,
                BreakSound = d.BreakSound,
                CrackStrength = d.CrackStrength,
                CrackLifetime = d.CrackLifetime,
                CrackSound = d.CrackSound,
                // A balloon animal's POP particles - the 2 authored emitters on its DeadNodeMode-4 collision header
                // (Unity docs/036). BurstColor stays as the fallback tint for the hand-rolled star burst on bundles /
                // props that carry no layers.
                Layers = burstLayers != null && burstLayers.TryGetValue(d.Index, out var bl) && bl.Count > 0 ? bl : null,
                Triggers = d.Triggers,
                PulseFrames = d.PulseFrames?.ToList(),
                PulseHolds = d.PulseHolds?.ToList(),
            };
            ApplyLighting(rec, d.Inst, o);
            result.Records.Add(rec);
            brk++;   // movers / soft-bodies (spinners are GPU-instanced in the pass below); breakables count here too
        }

        // ---- physics + spinner diverts: GPU-instanced by model (Unity docs/012) --------------------------
        // A row of identical props (parking meters, pylons, a level's trick gems) is ONE model
        // placed with per-instance rotation. EmitInstanced emits the model's geometry ONCE and gives every copy a
        // record that SHARES that node with its own centroid + relative rotation, so the importer draws the row
        // GPU-instanced from a single mesh (self-verified; a copy that can't be reconstructed falls back to a baked
        // node). amb/key ride each record, so shared geometry keeps per-instance light.
        EmitInstanced(diverts, "physics", o, result, out int physInstanced, out int physBaked, out int physModels);
        EmitInstanced(diverts, "spinner", o, result, out int spinInstanced, out int spinBaked, out int spinModels, burstLayers);
        phys += physInstanced + physBaked;
        spin += spinInstanced + spinBaked;

        result.Stats = $"{placed} instances ({hidden} hidden, {result.Records.Count} diverted: " +
                       $"{spin} spinner ({spinInstanced} instanced/{spinModels} model(s), {spinBaked} baked) / " +
                       $"{phys} physics ({physInstanced} instanced/{physModels} model(s), {physBaked} baked) / {brk} breakable" +
                       (pieces > 0 ? $" incl. {pieces} thrown break pieces" : "") +
                       (animSkipped > 0 ? $"; {animSkipped} animated" : "") +
                       (gatedOut > 0 ? $"; {gatedOut} show-off-only models -> PropsShowoff" : "") +
                       (raceOut > 0 ? $"; {raceOut} race-only models -> PropsRace" : "") + "), " +
                       $"merged {wPos.Count:n0} verts / {triBySlot.Count} submeshes" +
                       (lighting ? $", per-instance lighting on {lit} ({(doStaticDir ? "directional N.L" : "flat")})" : ", lighting off") +
                       (locators.Count > 0 ? $", {locators.Count} locator(s)" : "") + ".";
        return result;
    }

    // Split a throw-breakable's mesh into its CONNECTED COMPONENTS - the individual boards/planks the engine's
    // mesh-throw (it animates the model's render objects; connected components recover them from the merged
    // OBJ group). Verts weld by OBJ v index (SrcV) so (v,vt)-split seams don't break a board apart. Each piece
    // becomes its own "Divert_{i}_p{k}" node + a Role="piece" record recentred on the piece centroid (the
    // importer's existing pivot path), carrying the cluster's Sub20 throw params. Returns pieces emitted
    // (0 = don't split: degenerate or implausibly fragmented - the caller falls back to the plain record).
    static int EmitPieces(DivAccum d, List<Vector3> normals, Opts o, Result result)
    {
        // Union-find over the diverted vert pool, welded by source OBJ v.
        var parent = new int[d.Pos.Count];
        for (int i = 0; i < parent.Length; i++) parent[i] = i;
        int Find(int x) { while (parent[x] != x) x = parent[x] = parent[parent[x]]; return x; }
        void Union(int a, int b) { a = Find(a); b = Find(b); if (a != b) parent[a] = b; }

        var byObjV = new Dictionary<int, int>();
        for (int i = 0; i < d.SrcV.Count; i++)
        {
            if (byObjV.TryGetValue(d.SrcV[i], out int first)) Union(first, i);
            else byObjV[d.SrcV[i]] = i;
        }
        foreach (var tris in d.TriBySlot.Values)
            for (int t = 0; t + 2 < tris.Count; t += 3) { Union(tris[t], tris[t + 1]); Union(tris[t], tris[t + 2]); }

        var compOf = new Dictionary<int, int>();   // root -> piece id
        for (int i = 0; i < parent.Length; i++) { int r = Find(i); if (!compOf.ContainsKey(r)) compOf[r] = compOf.Count; }
        int count = compOf.Count;
        // Reject an implausible split (a mesh shattered into stray triangles) and keep the plain single record.
        // A Sub20-AUTHORED break trusts its piece count - sewer brick walls legitimately shatter
        // into many individual bricks - so the cap is generous there; a twin with NO authored throw (the LCD
        // screens' welded broken twin, whose break is a swap + shard burst) keeps the tighter guard untouched.
        int cap = d.Throw != null ? 128 : 48;
        if (count < 1 || count > cap) return 0;

        int emitted = 0;
        for (int k = 0; k < count; k++)
        {
            // Gather this piece's verts + per-slot triangles, reindexed.
            var remap = new Dictionary<int, int>();
            var pPos = new List<Vector3>(); var pUv = new List<Vector2>(); var pNrm = new List<Vector3>();
            int Remap(int src)
            {
                if (remap.TryGetValue(src, out int n)) return n;
                n = pPos.Count; remap[src] = n;
                pPos.Add(d.Pos[src]); pUv.Add(d.Uv[src]); pNrm.Add(normals[src]);
                return n;
            }
            var node = new GltfMeshWriter.Node { Name = $"Divert_{d.Index}_p{k}" };
            foreach (var kv in d.TriBySlot)
            {
                List<int>? pt = null;
                for (int t = 0; t + 2 < kv.Value.Count; t += 3)
                {
                    if (compOf[Find(kv.Value[t])] != k) continue;
                    pt ??= new List<int>();
                    pt.Add(Remap(kv.Value[t])); pt.Add(Remap(kv.Value[t + 1])); pt.Add(Remap(kv.Value[t + 2]));
                }
                if (pt != null)
                    node.Prims.Add(new GltfMeshWriter.Prim { Material = kv.Key, Positions = pPos, Normals = pNrm, Uv0 = pUv, Indices = pt });
            }
            if (node.Prims.Count == 0) continue;

            Vector3 center = Vector3.Zero;
            for (int i = 0; i < pPos.Count; i++) center += pPos[i];
            center /= pPos.Count;

            result.Diverted.Add(node);
            var rec = new BundleManifest.DivertInfo
            {
                Index = d.Index, Kind = "breakable", Node = node.Name, Model = d.Model,
                ModeMask = d.ModeMask,
                Role = "piece", ClusterKey = d.ClusterKey,
                Center = BundleSpace.Xyz(center),
                Bounce = d.Inst.PlayerBounceAmmount, CollisonSound = d.Inst.CollisonSound,
                Throw = d.Throw,
            };
            ApplyLighting(rec, d.Inst, o);
            result.Records.Add(rec);
            emitted++;
        }
        return emitted;
    }

    // Preserve native normals where present; custom/no-vn OBJ vertices fall back to an area-weighted solve.
    static Vector3[] ResolveNormals(List<Vector3> p, List<Vector3> stored, IEnumerable<List<int>> triLists)
    {
        var fallback = OutwardNormals(p, triLists);
        var result = new Vector3[p.Count];
        for (int i = 0; i < result.Length; i++)
            result[i] = i < stored.Count && stored[i].LengthSquared() > 1e-12f ? Vector3.Normalize(stored[i]) : fallback[i];
        return result;
    }

    // Legacy fallback: area-weighted face-normal sum, normalized, then negated (the X-mirrored geometry's
    // geometric winding points opposite the reflected authored shading normal).
    static Vector3[] OutwardNormals(List<Vector3> p, IEnumerable<List<int>> triLists)
    {
        var nrm = new Vector3[p.Count];
        foreach (var t in triLists)
            for (int i = 0; i + 2 < t.Count; i += 3)
            {
                int a = t[i], b = t[i + 1], c = t[i + 2];
                Vector3 fn = Vector3.Cross(p[b] - p[a], p[c] - p[a]);
                nrm[a] += fn; nrm[b] += fn; nrm[c] += fn;
            }
        for (int i = 0; i < nrm.Length; i++)
            nrm[i] = nrm[i].LengthSquared() > 1e-12f ? -Vector3.Normalize(nrm[i]) : new Vector3(0, 1, 0);
        return nrm;
    }

    // ---- GPU-instanced divert helpers (Unity docs/012) ----
    // Group the diverts of one KIND by ModelID; emit each model's geometry ONCE (a reference instance's centered mesh)
    // + a per-copy record that SHARES that node with its own centroid + relative rotation, so the importer draws the
    // row GPU-instanced. Self-verified per copy (reconstruct from the reference); a copy that can't be reconstructed
    // (different scale/topology/vertex order) falls back to its own baked node. amb/key ride each record.
    static void EmitInstanced(List<DivAccum> diverts, string kind, Opts o, Result result,
                              out int instanced, out int baked, out int models,
                              Dictionary<int, List<BundleManifest.EmitterLayerInfo>>? burstLayers = null)
    {
        instanced = 0; baked = 0; models = 0;
        var byModel = new Dictionary<int, List<DivAccum>>();
        foreach (var d in diverts)
            if (d.Kind == kind && d.Pos.Count > 0 && d.TriBySlot.Count > 0)
            {
                if (!byModel.TryGetValue(d.Inst.ModelID, out var lst)) byModel[d.Inst.ModelID] = lst = new List<DivAccum>();
                lst.Add(d);
            }
        foreach (var kv in byModel)
        {
            var group = kv.Value;
            DivAccum refd = group[0];                     // reference: its centered geometry is the mesh every copy reuses
            Vector3 cref = Centroid(refd.Pos);
            var refNormals = new List<Vector3>(ResolveNormals(refd.Pos, refd.Nrm, refd.TriBySlot.Values));
            string refNode = $"Divert_{refd.Index}";
            var qref = MeshQuat(refd.Inst.Rotation);
            float ext = Extent(refd.Pos);
            bool nodeEmitted = false;

            foreach (var d in group)
            {
                Vector3 cd = Centroid(d.Pos);
                Quaternion? qrel = d.Pos.Count == refd.Pos.Count
                    ? FitRotation(refd.Pos, cref, d.Pos, cd, qref, MeshQuat(d.Inst.Rotation), ext)
                    : null;

                var rec = new BundleManifest.DivertInfo
                {
                    Index = d.Index, Kind = kind, Model = d.Model,
                    ModeMask = d.ModeMask,
                    SpillCluster = d.SpillCluster,   // a Roller body that also throws a contents twin (Unity docs/036)
                    Center = BundleSpace.Xyz(cd),
                    DynamicMass = kind == "physics" ? PhysicsMass(d) : 0f,
                    Bounce = d.Inst.PlayerBounceAmmount, CollisonSound = d.Inst.CollisonSound,
                    SoundClip = d.SoundClip,
                };
                ApplyLighting(rec, d.Inst, o);
                // Trick gems carry their own collect burst (2 authored MainType-2 emitters on the pickup's
                // collision header). Instanced gems SHARE one geometry node but each keeps its OWN layers, since
                // the baked origins are per-instance world positions.
                if (burstLayers != null && burstLayers.TryGetValue(d.Index, out var gl) && gl.Count > 0) rec.Layers = gl;
                if (qrel != null)
                {
                    if (!nodeEmitted) { result.Diverted.Add(MakeNode(refNode, refd, refNormals)); nodeEmitted = true; }
                    var q = qrel.Value;
                    rec.Node = refNode;
                    rec.Rotation = new[] { q.X, q.Y, q.Z, q.W };
                    instanced++;
                }
                else
                {
                    string bn = $"Divert_{d.Index}";
                    result.Diverted.Add(MakeNode(bn, d, new List<Vector3>(ResolveNormals(d.Pos, d.Nrm, d.TriBySlot.Values))));
                    rec.Node = bn;
                    baked++;
                }
                result.Records.Add(rec);
            }
            if (nodeEmitted) models++;
        }
    }

    static Vector3 Centroid(List<Vector3> p)
    {
        if (p.Count == 0) return Vector3.Zero;
        Vector3 c = Vector3.Zero;
        for (int i = 0; i < p.Count; i++) c += p[i];
        return c / p.Count;
    }

    // Bounding-box diagonal of a vertex pool - the scale for a RELATIVE reconstruction tolerance.
    static float Extent(List<Vector3> p)
    {
        if (p.Count == 0) return 0f;
        Vector3 mn = p[0], mx = p[0];
        for (int i = 1; i < p.Count; i++) { mn = Vector3.Min(mn, p[i]); mx = Vector3.Max(mx, p[i]); }
        return (mx - mn).Length();
    }

    // The instance's authored SSX quaternion in MESH space (the X-mirror conjugation MirrorQuat applies to the geometry).
    static Quaternion MeshQuat(float[]? raw) { var m = MirrorQuat(raw); return new Quaternion(m[0], m[1], m[2], m[3]); }

    // One glb node from a diverted accumulator's welded pool + given normals (a per-material prim each).
    static GltfMeshWriter.Node MakeNode(string name, DivAccum d, List<Vector3> normals)
    {
        var node = new GltfMeshWriter.Node { Name = name };
        foreach (var kv in d.TriBySlot)
            node.Prims.Add(new GltfMeshWriter.Prim { Material = kv.Key, Positions = d.Pos, Normals = normals, Uv0 = d.Uv, Indices = kv.Value });
        return node;
    }

    // The relative rotation that maps the REFERENCE model's centered geometry onto this copy's, or null if no rigid
    // rotation reconstructs it within tolerance (different scale / topology / vertex order -> caller bakes a per-instance
    // mesh instead). Convention-agnostic: both quaternion composition orders are tried and VERIFIED against the real
    // vertices, so the shared placement is correct regardless of the numerics library's multiply convention.
    static Quaternion? FitRotation(List<Vector3> refPos, Vector3 cref, List<Vector3> dPos, Vector3 cd,
                                   Quaternion qref, Quaternion qd, float ext)
    {
        var inv = Quaternion.Inverse(qref);
        var cands = new[] { Quaternion.Concatenate(inv, qd), Quaternion.Concatenate(qd, inv) };
        float tol = MathF.Max(1e-2f, 0.01f * ext);
        foreach (var raw in cands)
        {
            var q = Quaternion.Normalize(raw);
            float maxErr = 0f;
            for (int i = 0; i < refPos.Count; i++)
            {
                Vector3 got = Vector3.Transform(refPos[i] - cref, q) + cd;
                float e = (got - dPos[i]).Length();
                if (e > maxErr) { maxErr = e; if (maxErr > tol) break; }
            }
            if (maxErr <= tol) return q;
        }
        return null;
    }

    // ---- classification (the single authority; the importer consumes the result) ----
    // A prop that gets a pose-only locator: the first LocatorModelMatches entry the model name contains is the key.
    internal static bool IsLocator(string model, Opts o, out string? key)
    {
        key = null;
        if (string.IsNullOrEmpty(model) || o.LocatorModelMatches == null) return false;
        foreach (var m in o.LocatorModelMatches)
            if (!string.IsNullOrEmpty(m) && model.Contains(m, System.StringComparison.Ordinal)) { key = m; return true; }
        return false;
    }
    // SSX X-negation for an authored quaternion: negate y,z (the same mirror the verts get). [x,-y,-z,w].
    // A button's trigger volumes as boxes, in the volume order the classifier found them. A volume whose model
    // carries no mesh has no box and is dropped - it could never have been crossed.
    static List<BundleManifest.AnimTriggerBox>? PulseTriggers(TriggeredFlipClassifier.Pulse pulse,
                                                             Dictionary<int, BundleManifest.AnimTriggerBox>? boxes)
    {
        if (boxes == null) return null;
        List<BundleManifest.AnimTriggerBox>? outv = null;
        foreach (int vi in pulse.Volumes)
            if (boxes.TryGetValue(vi, out var box)) (outv ??= new List<BundleManifest.AnimTriggerBox>()).Add(box);
        return outv;
    }

    static float[] MirrorQuat(float[]? r) => r is { Length: >= 4 } ? new[] { r[0], -r[1], -r[2], r[3] } : new[] { 0f, 0f, 0f, 1f };
    // Missing Roller mass stays explicitly unknown. Falling back to instance response mass would violate the independent
    // response-mass/body-mass fields in [Trailmap: 130-collision-data, 370-world-interaction].
    static float PhysicsMass(DivAccum d) => d.Kind == "physics" && d.PhysicsMass is float mass ? mass : -1f;
    static bool PhysicsModelExcluded(string model, Opts o)
    {
        foreach (var ex in o.PhysicsExcludeModels)
            if (!string.IsNullOrEmpty(ex) && model.Contains(ex, System.StringComparison.Ordinal)) return true;
        return false;
    }

    // ---- lighting (the single authority; the importer applies the exact payload) ----
    static Vector3 MeshSun(Opts o)
    {
        Vector3 ws = o.PropDirLightDir;
        Vector3 m = new(ws.X, -ws.Z, ws.Y);
        return m.LengthSquared() > 1e-12f ? Vector3.Normalize(m) : Vector3.UnitZ;
    }

    static Vector4 LightColour(SsxInstance it, Opts o) => PropLighting.Flat(it);

    static void ApplyLighting(BundleManifest.DivertInfo record, SsxInstance instance, Opts o)
    {
        Vector3 fallback = MeshSun(o);
        Vector3 ambient = PropLighting.Ambient(instance);
        var k1 = PropLighting.GetKey(instance, 0, fallback);
        var k2 = PropLighting.GetKey(instance, 1, fallback);
        var k3 = PropLighting.GetKey(instance, 2, fallback);
        Vector4 flat = PropLighting.Flat(instance);
        record.Ambient = A(ambient);
        record.Key1 = A(k1.Colour); record.Key2 = A(k2.Colour); record.Key3 = A(k3.Colour);
        record.Direction1 = A(k1.MeshDirection); record.Direction2 = A(k2.MeshDirection); record.Direction3 = A(k3.MeshDirection);
        record.Light = new[] { flat.X, flat.Y, flat.Z };
    }

    static float[] A(Vector3 v) => new[] { v.X, v.Y, v.Z };
    static float PF(string s) => float.Parse(s, CultureInfo.InvariantCulture);
}
