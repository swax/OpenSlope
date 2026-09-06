using System.Globalization;
using System.Linq;
using System.Numerics;
using System.Text;
using SSXLibrary.JsonFiles.Tricky;
using Snowknife.Engine;

namespace Snowknife.Export;

/// <summary>
/// Places the level props into world space. The prop meshes in <c>Meshes/*.obj</c>
/// are model-local (they sit near the origin); the actual world placement lives in
/// <c>Instances.json</c> (per-instance Location/Rotation/Scale + a ModelID) and
/// <c>Models.json</c> (which meshes make up each model, plus an internal object
/// hierarchy via ParentID).
///
/// This reads those JSONs (via the library's own loaders), bakes every instance's
/// referenced meshes through their object-chain + instance transform, and writes a
/// single world-space <c>Props.obj</c>, which overlays the tessellated terrain when
/// both are opened in Blender.
/// </summary>
internal static class PropsExporter
{
    private readonly record struct ScrollProfile(
        int Mode, float U, float V, float ActiveDuration, float PauseDuration, float Lifetime);

    public static int Export(string levelDir)
    {
        string instPath = Path.Combine(levelDir, "Instances.json");
        string modelsPath = Path.Combine(levelDir, "Models.json");
        string meshDir = Path.Combine(levelDir, "Meshes");

        if (!File.Exists(instPath)) throw new FileNotFoundException($"Instances.json not found in '{levelDir}'. Run `snowknife import ...` first.");
        if (!File.Exists(modelsPath)) throw new FileNotFoundException($"Models.json not found in '{levelDir}'.");
        if (!Directory.Exists(meshDir)) throw new DirectoryNotFoundException($"Meshes/ folder not found in '{levelDir}'.");

        var instances = InstanceJsonHandler.Load(instPath).Instances ?? new();
        var models = ModelJsonHandler.Load(modelsPath).Models ?? new();
        if (instances.Count == 0) { Log.Warn("No instances to place."); return 1; }

        var meshCache = new Dictionary<string, CachedMesh?>(StringComparer.OrdinalIgnoreCase);

        // Materials: each MeshHeader.MaterialID indexes Materials.json; each material names a
        // TexturePath ("0000.png") living in Textures/. We emit one OBJ material per *used*
        // MaterialID into Props.mtl so the props import textured (the terrain already does this).
        string matPath = Path.Combine(levelDir, "Materials.json");
        var materials = File.Exists(matPath)
            ? (MaterialJsonHandler.Load(matPath).Materials ?? new())
            : new List<MaterialJsonHandler.MaterialsJson>();
        var usedMats = new SortedDictionary<int, string?>(); // MaterialID -> texture file (null = none/missing)
        bool usedUntextured = false;

        // ---- crowd billboards -----------------------------------------------
        // Grandstand spectator billboards are placed with PLACEHOLDER static materials (unrelated
        // signboard/facade art); the engine swaps in the real spectators at runtime. Those spectators
        // are NOT in this level's texture bank - they are a shared 16-frame animation in the game's
        // DATA\TEXTURES\CROWD.SSH (decoded to Textures/cd00..cd15.png by `snowknife import`). A crowd
        // instance carries a Crowd effect (Type0 SubType-17 "CrowdBox") in its effect slot; TryCrowd
        // reads that from the SSF graph. The specified behavior keeps 16 independent per-cell animation states per
        // stand (one per placeholder material slot; [Trailmap: 410-crowd]), so we tag
        // each cell with a per-cell slot name "mat_crowd_c<NN>" (NN = the placeholder MaterialID's
        // first-seen ordinal within the instance, mod 16 - retail's material-override index).
        // PropsBundle folds these back into ONE "mat_crowd" prim, carrying the cell id per-vertex, and
        // the Unity shader runs each cell's independent frame stream. Keying on the effect (not a
        // model-name substring) catches every spectator model - 4x4_people, 2x8_people grandstands,
        // 4x4_People_Dome - across all levels.
        int crowdInstancesFixed = 0;
        bool usedCrowd = false;

        // ---- UV scroll (water, LCD screens, jumbotrons, boost-pad arrows) --
        // A handful of props animate by scrolling their texture UVs (river water flowing,
        // scanlines, ad boards). SSX flags the instance with InstanceJson.UVScroll and stores
        // the motion profile in the SSF effect system: the instance's EffectSlotIndex -> an EffectSlot,
        // whose Persistant/Collision effect header carries a Type0 SubType-10 "UVScroll" with
        // U0 = mode, U1/U2 = U/V units per tick, and U3/U4/U5 = active/pause/lifetime seconds.
        // We can't bake a moving offset into a static OBJ, so we record the per-instance profile and
        // tag that instance's submeshes with a scroll-variant material
        // name ("mat_<id>_scr<k>"); the Unity shader then scrolls by _Time (works in a build with
        // no script). Profiles are de-duped into a small table written to Scroll.json.
        var ssf = Bundle.SsfLogic.Load(levelDir);
        var slots = ssf?.EffectSlots; var heads = ssf?.EffectHeaders;
        var scrollProfiles = new List<ScrollProfile>();   // index k -> native motion profile, serialized to Scroll.json
        int scrollInstances = 0;

        // Walk an instance's effect slot to its UVScroll motion profile, if any.
        bool TryScroll(int effectSlotIndex, out ScrollProfile profile)
        {
            profile = default;
            if (slots == null || effectSlotIndex < 0 || effectSlotIndex >= slots.Length) return false;
            var sl = slots[effectSlotIndex];
            foreach (int hi in new[] { sl.PersistantEffectSlot, sl.CollisionEffectSlot })
            {
                if (heads == null || hi < 0 || hi >= heads.Length) continue;
                var effs = heads[hi].Effects;
                if (effs == null) continue;
                foreach (var e in effs)
                    if (e.MainType == SsfMainType.Property && e.type0 is { } t && t.SubType == SsfType0Sub.UvScroll && t.UVScroll is { } s)
                    {
                        profile = new ScrollProfile(s.U0, s.U1, s.U2, s.U3, s.U4, s.U5);
                        return true;
                    }
            }
            return false;
        }

        // De-dupe a native motion profile into the table, returning its index k.
        int ScrollIndex(ScrollProfile profile)
        {
            for (int k = 0; k < scrollProfiles.Count; k++)
                if (scrollProfiles[k] == profile) return k;
            scrollProfiles.Add(profile);
            return scrollProfiles.Count - 1;
        }

        // ---- texture flip (LCD logos, directional signs) -------------------
        // The same SSF effect system carries a per-effect FLIP rate for the animated signboards /
        // LCD screens: the instance's effect header has a Type0 SubType-11 "TextureFlip" whose
        // Speed is the game's flip rate (DirectionalSign = 3.5, Lcd_ScreenLogo = 1). The frames
        // themselves come from the material's TextureFlipbook (Materials.json); here we only capture
        // each flipbook material's Speed so the importer can flip it at its true per-effect rate
        // instead of one global guess. (The crowd is a separate CrowdEffect with no Speed - the
        // importer gives it its own rate.) Map: flipbook MaterialID -> Speed, written to Flip.json.
        //
        // Flip.json is the FREE-RUNNING set only: a PERSISTENT flip node, which the data marks with
        // Length (its lifetime) == 0 - it lives as long as its slot, so the material cycles forever.
        // A flip authored with Length > 0 is a collision-fired ONE-SHOT that latches a state pair on
        // its other frame (the megaplex buttons' red->green); those are classified separately by
        // TriggeredFlipClassifier and must NOT reach Flip.json, or the consumer free-runs a material
        // whose frames are a STATE LIST rather than an animation.
        var flipMatSpeed = new Dictionary<int, (float speed, int u4)>();   // + U4 = the TextureFlip "pause/dwell" flag

        // Walk an instance's effect slot to its PERSISTENT TextureFlip speed, if any.
        bool TryFlip(int effectSlotIndex, out float speed, out int u4)
        {
            speed = 0f; u4 = 0;
            if (slots == null || effectSlotIndex < 0 || effectSlotIndex >= slots.Length) return false;
            int hi = slots[effectSlotIndex].PersistantEffectSlot;
            if (heads == null || hi < 0 || hi >= heads.Length) return false;
            var effs = heads[hi].Effects;
            if (effs == null) return false;
            foreach (var e in effs)
                if (e.MainType == SsfMainType.Property && e.type0 is { } t && t.SubType == SsfType0Sub.TextureFlip
                    && t.TextureFlip is { Length: <= 0f } f)
                { speed = f.Speed; u4 = f.U4; return true; }
            return false;
        }

        // Walk an instance's effect slot for a Crowd effect (Type0 SubType-17 "CrowdBox") - the engine's
        // data marker on grandstand spectator billboards. Same slot walk as TryFlip/TryScroll.
        bool TryCrowd(int effectSlotIndex)
        {
            if (slots == null || effectSlotIndex < 0 || effectSlotIndex >= slots.Length) return false;
            var sl = slots[effectSlotIndex];
            foreach (int hi in new[] { sl.PersistantEffectSlot, sl.CollisionEffectSlot })
            {
                if (heads == null || hi < 0 || hi >= heads.Length) continue;
                var effs = heads[hi].Effects;
                if (effs == null) continue;
                foreach (var e in effs)
                    if (e.MainType == SsfMainType.Property && e.type0 is { } t && t.SubType == SsfType0Sub.CrowdBox && t.CrowdEffect is { })
                        return true;
            }
            return false;
        }

        // scroll-variant slot name -> texture file, so WriteMtl can emit "newmtl mat_<id>_scr<k>".
        var usedScrollVariants = new SortedDictionary<string, string?>(StringComparer.Ordinal);

        // Resolve a MaterialID to an OBJ material name, recording it (+ its texture) for the MTL.
        // When scrollK >= 0 the instance scrolls, so we emit a per-speed variant name that the
        // importer maps back to a scrolling material; the base texture is shared with mat_<id>.
        string ResolveMat(int matId, int scrollK = -1)
        {
            string baseName;
            if (matId >= 0 && matId < materials.Count)
            {
                if (!usedMats.ContainsKey(matId))
                {
                    string? tex = materials[matId].TexturePath;
                    bool ok = !string.IsNullOrEmpty(tex)
                              && File.Exists(Path.Combine(levelDir, "Textures", tex));
                    usedMats[matId] = ok ? tex : null;
                }
                baseName = "mat_" + matId.ToString(CultureInfo.InvariantCulture);
            }
            else { usedUntextured = true; baseName = "mat_untextured"; }

            if (scrollK < 0) return baseName;
            string variant = baseName + "_scr" + scrollK.ToString(CultureInfo.InvariantCulture);
            if (!usedScrollVariants.ContainsKey(variant))
                usedScrollVariants[variant] = (matId >= 0 && usedMats.TryGetValue(matId, out var tx)) ? tx : null;
            return variant;
        }

        string objPath = Path.Combine(levelDir, "Props.obj");
        long gV = 0, gVt = 0, gVn = 0; // running 0-based counts of v / vt / vn lines written
        long emittedVerts = 0, emittedTris = 0;
        int placed = 0, skippedNoModel = 0, missingMeshes = 0;

        using (var w = new StreamWriter(objPath, false))
        {
            w.Write("# SSX props baked into world space from Instances.json + Models.json by snowknife\n");
            w.Write("mtllib Props.mtl\n");

            string? lastMat = null; // last usemtl written (OBJ material state persists across objects)
            for (int ii = 0; ii < instances.Count; ii++)
            {
                var inst = instances[ii];
                if (inst.ModelID < 0 || inst.ModelID >= models.Count) { skippedNoModel++; continue; }
                var model = models[inst.ModelID];
                if (model.ModelObjects == null) { skippedNoModel++; continue; }

                Matrix4x4 instMatrix = Compose(inst.Location, inst.Rotation, inst.Scale);

                // Crowd billboards: each cell (placeholder material slot) is tagged "mat_crowd_c<NN>" so
                // the per-cell identity survives into the bundle (retail animates the 16 cells independently).
                bool isCrowd = TryCrowd(inst.EffectSlotIndex);
                Dictionary<int, int>? crowdCellByMat = isCrowd ? new Dictionary<int, int>() : null;

                // UV-scroll props: resolve this instance's native profile -> a profile-table index (or -1).
                int scrollK = -1;
                if (inst.UVScroll && TryScroll(inst.EffectSlotIndex, out ScrollProfile scrollProfile))
                    scrollK = ScrollIndex(scrollProfile);

                // Texture-flip props (LCD logos, directional signs): this instance's flip speed + dwell flag (or 0).
                float instFlipSpeed = 0f;
                int instFlipU4 = 0;
                bool instHasFlip = !isCrowd && TryFlip(inst.EffectSlotIndex, out instFlipSpeed, out instFlipU4);

                bool wroteAnything = false;
                for (int oi = 0; oi < model.ModelObjects.Count; oi++)
                {
                    var obj = model.ModelObjects[oi];
                    if (obj.MeshData == null || obj.MeshData.Count == 0) continue;

                    Matrix4x4 world = ObjectChain(model.ModelObjects, oi) * instMatrix;

                    foreach (var mh in obj.MeshData)
                    {
                        var mesh = GetMesh(meshCache, meshDir, mh.MeshPath);
                        if (mesh == null) { missingMeshes++; continue; }

                        if (!wroteAnything)
                        {
                            w.Write("o inst");
                            w.Write(ii.ToString(CultureInfo.InvariantCulture));
                            w.Write('_');
                            w.Write(Sanitize(inst.InstanceName, ii));
                            w.Write('\n');
                            wroteAnything = true;
                        }

                        string matName;
                        if (isCrowd)
                        {
                            // Cell = the placeholder material's first-seen ordinal in this instance (& 15,
                            // matching retail's fixed 16-slot override array; rows*cols == 16 in shipped data).
                            if (!crowdCellByMat!.TryGetValue(mh.MaterialID, out int cell))
                            { cell = crowdCellByMat.Count & 15; crowdCellByMat[mh.MaterialID] = cell; }
                            matName = "mat_crowd_c" + cell.ToString("00", CultureInfo.InvariantCulture);
                            usedCrowd = true;
                        }
                        else
                        {
                            matName = ResolveMat(mh.MaterialID, scrollK);
                            // Remember the per-effect flip rate for any flipbook material this instance drives.
                            if (instHasFlip && mh.MaterialID >= 0 && mh.MaterialID < materials.Count
                                && materials[mh.MaterialID].TextureFlipbook is { Count: >= 2 })
                                flipMatSpeed[mh.MaterialID] = (instFlipSpeed, instFlipU4);
                        }
                        if (matName != lastMat)
                        {
                            w.Write("usemtl "); w.Write(matName); w.Write('\n');
                            lastMat = matName;
                        }

                        long vBase = gV, vtBase = gVt, vnBase = gVn;

                        foreach (var v in mesh.Verts)
                        {
                            Vector3 p = Vector3.Transform(v, world);
                            w.Write("v "); w.Write(F(p.X)); w.Write(' '); w.Write(F(p.Y)); w.Write(' '); w.Write(F(p.Z)); w.Write('\n');
                        }
                        gV += mesh.Verts.Count;
                        emittedVerts += mesh.Verts.Count;

                        foreach (var uv in mesh.UVs)
                        {
                            w.Write("vt "); w.Write(F(uv.X)); w.Write(' '); w.Write(F(uv.Y)); w.Write('\n');
                        }
                        gVt += mesh.UVs.Count;

                        // Preserve the PBD's authored signed-normal stream and its hard-edge splits. Positions are
                        // baked through the object hierarchy + instance SRT, so normals need that matrix's inverse-
                        // transpose (not a fresh smooth-normal solve after the fact).
                        Matrix4x4 normalMatrix = Matrix4x4.Identity;
                        if (Matrix4x4.Invert(world, out Matrix4x4 invWorld)) normalMatrix = Matrix4x4.Transpose(invWorld);
                        foreach (var normal in mesh.Normals)
                        {
                            Vector3 n = Vector3.TransformNormal(normal, normalMatrix);
                            if (n.LengthSquared() > 1e-12f) n = Vector3.Normalize(n);
                            else n = Vector3.UnitZ;
                            w.Write("vn "); w.Write(F(n.X)); w.Write(' '); w.Write(F(n.Y)); w.Write(' '); w.Write(F(n.Z)); w.Write('\n');
                        }
                        gVn += mesh.Normals.Count;

                        bool hasUv = mesh.UVs.Count > 0;
                        bool hasNormals = mesh.Normals.Count > 0;
                        foreach (var t in mesh.Tris)
                        {
                            w.Write('f');
                            for (int k = 0; k < 3; k++)
                            {
                                long vi = vBase + t.V[k] + 1;
                                w.Write(' ');
                                w.Write(vi.ToString(CultureInfo.InvariantCulture));
                                bool uvHere = hasUv && t.Vt[k] >= 0;
                                bool normalHere = hasNormals && t.Vn[k] >= 0;
                                if (uvHere || normalHere)
                                {
                                    w.Write('/');
                                    if (uvHere) w.Write((vtBase + t.Vt[k] + 1).ToString(CultureInfo.InvariantCulture));
                                    if (normalHere)
                                    {
                                        w.Write('/');
                                        w.Write((vnBase + t.Vn[k] + 1).ToString(CultureInfo.InvariantCulture));
                                    }
                                }
                            }
                            w.Write('\n');
                        }
                        emittedTris += mesh.Tris.Count;
                    }
                }
                if (wroteAnything) { placed++; if (isCrowd) crowdInstancesFixed++; if (scrollK >= 0) scrollInstances++; }
            }
        }

        string mtlPath = Path.Combine(levelDir, "Props.mtl");
        WriteMtl(mtlPath, usedMats, usedUntextured, usedScrollVariants, usedCrowd);
        int withTex = usedMats.Values.Count(t => t != null);

        // Scroll.json: the per-index native UV-scroll motion profile table.
        WriteScrollJson(Path.Combine(levelDir, "Scroll.json"), scrollProfiles);

        // Flip.json: per-material texture-flip Speed the importer turns into a per-flipbook fps.
        WriteFlipJson(Path.Combine(levelDir, "Flip.json"), flipMatSpeed);

        Log.Info($"Props: placed {placed} instances -> {emittedTris:n0} triangles ({emittedVerts:n0} verts).");
        if (skippedNoModel > 0) Log.Warn($"  ({skippedNoModel} instances skipped: no/invalid ModelID.)");
        if (missingMeshes > 0) Log.Warn($"  ({missingMeshes} mesh references not found in Meshes/.)");
        Log.Info($"  -> {objPath}");
        Log.Info($"  -> {mtlPath} ({usedMats.Count} materials, {withTex} textured)");
        Log.Info($"  (crowd: tagged {crowdInstancesFixed} spectator billboards (CrowdBox effect) with per-cell 'mat_crowd_c<NN>' slots -> the Unity shader animates each cell's cd00..cd15 stream.)");
        Log.Info($"  (uv-scroll: tagged {scrollInstances} instances (water/screens/boost) across {scrollProfiles.Count} distinct motion profiles -> Scroll.json.)");
        Log.Info($"  (texture-flip: {flipMatSpeed.Count} flipbook materials carry a per-effect Speed (signs/LCD) -> Flip.json.)");
        return 0;
    }

    // Write the de-duped native motion-profile table; index k matches the "mat_<id>_scr<k>" material tag.
    private static void WriteScrollJson(string path, List<ScrollProfile> profiles)
    {
        var sb = new StringBuilder();
        sb.Append("{\"Speeds\":[");
        for (int k = 0; k < profiles.Count; k++)
        {
            if (k > 0) sb.Append(',');
            var p = profiles[k];
            sb.Append("{\"U\":").Append(F(p.U))
              .Append(",\"V\":").Append(F(p.V))
              .Append(",\"Mode\":").Append(p.Mode.ToString(CultureInfo.InvariantCulture))
              .Append(",\"ActiveDuration\":").Append(F(p.ActiveDuration))
              .Append(",\"PauseDuration\":").Append(F(p.PauseDuration))
              .Append(",\"Lifetime\":").Append(F(p.Lifetime)).Append('}');
        }
        sb.Append("]}");
        File.WriteAllText(path, sb.ToString());
    }

    // Write the per-material texture-flip table (flipbook MaterialID -> SSF TextureFlip Speed + U4 dwell flag);
    // the importer turns each Speed into a flipbook fps (Speed * FlipSpeedScale), and expands a U4 dwell.
    private static void WriteFlipJson(string path, Dictionary<int, (float speed, int u4)> flipMatSpeed)
    {
        var sb = new StringBuilder();
        sb.Append("{\"Materials\":[");
        bool first = true;
        foreach (var kv in flipMatSpeed.OrderBy(k => k.Key))
        {
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"Id\":").Append(kv.Key.ToString(CultureInfo.InvariantCulture))
              .Append(",\"Speed\":").Append(F(kv.Value.speed))
              .Append(",\"U4\":").Append(kv.Value.u4.ToString(CultureInfo.InvariantCulture)).Append('}');
        }
        sb.Append("]}");
        File.WriteAllText(path, sb.ToString());
    }

    // ---- transforms --------------------------------------------------------

    /// <summary>Compose an SRT matrix matching the Matrix4x4.Decompose used on export.</summary>
    private static Matrix4x4 Compose(float[]? loc, float[]? rot, float[]? scale)
    {
        Vector3 t = V3(loc);
        Quaternion q = (rot != null && rot.Length >= 4)
            ? new Quaternion(rot[0], rot[1], rot[2], rot[3])
            : Quaternion.Identity;
        Vector3 s = (scale != null && scale.Length >= 3)
            ? new Vector3(scale[0], scale[1], scale[2])
            : Vector3.One;
        return Matrix4x4.CreateScale(s) * Matrix4x4.CreateFromQuaternion(q) * Matrix4x4.CreateTranslation(t);
    }

    /// <summary>Local transform of object <paramref name="index"/> composed up its ParentID chain.</summary>
    private static Matrix4x4 ObjectChain(List<ModelJsonHandler.ObjectHeader> objects, int index)
    {
        Matrix4x4 m = Matrix4x4.Identity;
        int cur = index;
        int guard = objects.Count + 1; // cycle/over-deep safety
        while (cur >= 0 && cur < objects.Count && guard-- > 0)
        {
            var o = objects[cur];
            if (o.IncludeMatrix)
                m *= Compose(o.Position, o.Rotation, o.Scale);
            cur = o.ParentID;
        }
        return m;
    }

    private static Vector3 V3(float[]? a) =>
        (a != null && a.Length >= 3) ? new Vector3(a[0], a[1], a[2]) : Vector3.Zero;

    // ---- mesh cache / OBJ parsing -----------------------------------------

    private sealed class Tri
    {
        public int[] V = new int[3];
        public int[] Vt = { -1, -1, -1 };
        public int[] Vn = { -1, -1, -1 };
    }

    private sealed class CachedMesh
    {
        public List<Vector3> Verts = new();
        public List<Vector2> UVs = new();
        public List<Vector3> Normals = new();
        public List<Tri> Tris = new();
    }

    private static CachedMesh? GetMesh(Dictionary<string, CachedMesh?> cache, string meshDir, string? meshPath)
    {
        if (string.IsNullOrEmpty(meshPath)) return null;
        if (cache.TryGetValue(meshPath, out var hit)) return hit;

        string full = Path.Combine(meshDir, meshPath);
        CachedMesh? mesh = File.Exists(full) ? ParseObj(full) : null;
        cache[meshPath] = mesh;
        return mesh;
    }

    private static CachedMesh ParseObj(string path)
    {
        var mesh = new CachedMesh();
        foreach (var raw in File.ReadLines(path))
        {
            if (raw.Length < 2) continue;
            char c0 = raw[0];
            if (c0 == 'v' && raw[1] == ' ')
            {
                var p = Split(raw);
                if (p.Length >= 4)
                    mesh.Verts.Add(new Vector3(PF(p[1]), PF(p[2]), PF(p[3])));
            }
            else if (c0 == 'v' && raw[1] == 't')
            {
                var p = Split(raw);
                if (p.Length >= 3)
                    mesh.UVs.Add(new Vector2(PF(p[1]), PF(p[2])));
            }
            else if (c0 == 'v' && raw[1] == 'n')
            {
                var p = Split(raw);
                if (p.Length >= 4)
                    mesh.Normals.Add(new Vector3(PF(p[1]), PF(p[2]), PF(p[3])));
            }
            else if (c0 == 'f' && raw[1] == ' ')
            {
                var p = Split(raw);
                if (p.Length < 4) continue;
                var t = new Tri();
                for (int k = 0; k < 3; k++)
                {
                    var bits = p[k + 1].Split('/');
                    t.V[k] = int.Parse(bits[0], CultureInfo.InvariantCulture) - 1;
                    t.Vt[k] = (bits.Length > 1 && bits[1].Length > 0)
                        ? int.Parse(bits[1], CultureInfo.InvariantCulture) - 1
                        : -1;
                    t.Vn[k] = (bits.Length > 2 && bits[2].Length > 0)
                        ? int.Parse(bits[2], CultureInfo.InvariantCulture) - 1
                        : -1;
                }
                mesh.Tris.Add(t);
            }
        }
        return mesh;
    }

    private static string[] Split(string s) =>
        s.Split(' ', StringSplitOptions.RemoveEmptyEntries);

    private static float PF(string s) => float.Parse(s, CultureInfo.InvariantCulture);

    // ---- materials / MTL ---------------------------------------------------

    private static void WriteMtl(string path, SortedDictionary<int, string?> usedMats, bool usedUntextured,
                                 SortedDictionary<string, string?>? usedScrollVariants = null, bool usedCrowd = false)
    {
        var sb = new StringBuilder();
        sb.Append("# SSX prop materials (textures live in ./Textures/) by snowknife\n\n");
        // Crowd cell slots (mat_crowd_c00..c15): every cell shows a frame of the shared cd bank; frame 0
        // (cd00.png) stands in for a plain OBJ viewer. The bundle folds them back into one "mat_crowd" prim.
        if (usedCrowd)
            for (int c = 0; c < 16; c++)
            {
                sb.Append("newmtl mat_crowd_c").Append(c.ToString("00", CultureInfo.InvariantCulture)).Append('\n');
                sb.Append("Ka 1.000 1.000 1.000\n");
                sb.Append("Kd 1.000 1.000 1.000\n");
                sb.Append("map_Kd Textures/cd00.png\n\n");
            }
        foreach (var kv in usedMats)
        {
            sb.Append("newmtl mat_").Append(kv.Key.ToString(CultureInfo.InvariantCulture)).Append('\n');
            sb.Append("Ka 1.000 1.000 1.000\n");
            sb.Append("Kd 1.000 1.000 1.000\n");
            if (kv.Value != null)
                sb.Append("map_Kd Textures/").Append(kv.Value).Append('\n');
            sb.Append('\n');
        }
        // Scroll variants ("mat_<id>_scr<k>"): same texture as the base material; the Unity
        // importer recognises the _scr<k> tag and bakes the matching speed from Scroll.json.
        if (usedScrollVariants != null)
            foreach (var kv in usedScrollVariants)
            {
                sb.Append("newmtl ").Append(kv.Key).Append('\n');
                sb.Append("Ka 1.000 1.000 1.000\n");
                sb.Append("Kd 1.000 1.000 1.000\n");
                if (kv.Value != null)
                    sb.Append("map_Kd Textures/").Append(kv.Value).Append('\n');
                sb.Append('\n');
            }
        if (usedUntextured)
        {
            sb.Append("newmtl mat_untextured\n");
            sb.Append("Ka 0.500 0.500 0.500\n");
            sb.Append("Kd 0.500 0.500 0.500\n\n");
        }
        File.WriteAllText(path, sb.ToString());
    }

    // ---- formatting --------------------------------------------------------

    private static string F(float value) => value.ToString("0.######", CultureInfo.InvariantCulture);

    private static string Sanitize(string? name, int fallback)
    {
        if (string.IsNullOrWhiteSpace(name)) return fallback.ToString();
        Span<char> buf = name.Length <= 64 ? stackalloc char[name.Length] : new char[name.Length];
        for (int i = 0; i < name.Length; i++)
        {
            char c = name[i];
            buf[i] = (char.IsLetterOrDigit(c) || c is '_' or '-' or '.') ? c : '_';
        }
        return new string(buf);
    }
}
