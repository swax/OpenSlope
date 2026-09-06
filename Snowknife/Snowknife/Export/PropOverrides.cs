using System.Text.Json;
using SSXLibrary.JsonFiles.Tricky;
using Snowknife.Services;

namespace Snowknife.Export;

/// <summary>
/// Name-matched prop remodels. A remodel package is a folder with an <c>override.json</c> under the
/// <c>Overrides</c> SIBLING of the level folders (<c>Maps/Overrides/&lt;prop&gt;/override.json</c>),
/// so an `import` rerun never clobbers it. <c>import</c>/<c>props</c>/<c>gltf</c> call
/// <see cref="Apply"/> to install the package into the level's <c>Meshes/Collision/Textures</c>; it
/// resolves each package's ModelName prefix against the level's <c>Models.json</c> and installs the
/// replacement meshes / collision proxies / texture pages over the level-specific file numbers,
/// backing each original up as <c>*.orig_bak</c> once. NOTE: installing into <c>Meshes/Collision/</c>
/// is not enough for STATIC props - their geometry is bundled from the pre-baked world-space
/// <c>Props.obj</c>/<c>PropsCollision.obj</c>, which only <c>level</c>/<c>props</c> regenerate (via
/// <c>PropsExporter</c>). So after editing a static prop's mesh/collision, run <c>props</c> THEN
/// <c>gltf</c>; <c>gltf</c> alone refreshes only texture pages and ANIMATED-prop meshes (read
/// model-local from <c>Meshes/</c>). Mesh files are matched by SLOT (the model's MeshData order) and texture
/// pages by the slot's MaterialID -&gt; <c>Materials.json</c> TexturePath, so ONE package applies to
/// every level that ships the prop, whatever its local numbering. Spec + workflow:
/// Blender/docs/002-prop-remodel-roundtrip.md.
///
/// override.json (paths are relative to the json):
/// <code>
/// {
///   "name":      "MediaTower v4",
///   "match":     "Mdl_MediaTower_Tall",                       // ModelName prefix; picks every chunk variant
///   "meshes":    ["body.obj", "lattice.obj", "mesh.obj"],     // one per MeshData slot, in slot order
///   "collision": "collision.obj",                              // replaces every proxy the instances reference
///   "textures":  { "0": "tex/body.png" },                      // slot -> REPAINT the page it already shares
///   "alpha":     { "0": "cutout" },                            // slot -> TextureAlpha.overrides.json mode
///   "privatePages": {                                          // slot -> a NEW page owned only by these models
///     "0": { "texture": "tex/skin.png", "page": "tower_priv.png", "alpha": "cutout" }
///   },                                                         //   (clones the slot material + repoints it;
///   "alphaPages": { "0037.png": "opaque" },                    // force a mode on ANY page (e.g. the freed one)
///   "levels":    ["MYLEVEL"]                                   //    leaves the shared page vanilla for siblings)
/// }
/// </code>
/// </summary>
internal static class PropOverrides
{
    private sealed class Spec
    {
        public string? Name { get; set; }
        public string Match { get; set; } = "";
        public List<string> Meshes { get; set; } = new();
        public string? Collision { get; set; }
        public Dictionary<string, string>? Textures { get; set; }  // slot index -> source png
        public Dictionary<string, string>? Alpha { get; set; }     // slot index -> opaque/cutout/blend
        public List<string>? Levels { get; set; }                  // optional level-name allow-list
        public Dictionary<string, PrivatePage>? PrivatePages { get; set; }  // slot -> a page owned by these models
        public Dictionary<string, string>? AlphaPages { get; set; }         // page name -> forced alpha mode (any page)
    }

    // A dedicated texture page for the matched models' slot. Unlike <see cref="Spec.Textures"/> (which
    // repaints the page the slot ALREADY shares with other props), this clones the slot's material onto a
    // NEW page and repoints only the matched models there - leaving the shared page vanilla for everyone else.
    private sealed class PrivatePage
    {
        public string Texture { get; set; } = "";  // source image (relative to override.json)
        public string Page { get; set; } = "";      // new page filename installed into Textures/
        public string? Alpha { get; set; }           // opaque/cutout/blend mode for the new page
    }

    private static readonly JsonSerializerOptions Js = new()
    {
        PropertyNameCaseInsensitive = true,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
    };

    /// <summary>
    /// Install every matching override package into <paramref name="levelDir"/>. Returns the number
    /// of packages applied (0 when there is no Overrides sibling - silent, so vanilla workspaces
    /// don't see a new pipeline step). <paramref name="dry"/> previews without touching files.
    /// </summary>
    public static int Apply(string levelDir, ContractValidationService contracts, bool dry = false)
    {
        levelDir = Path.GetFullPath(levelDir);
        string overridesDir = Path.Combine(Path.GetDirectoryName(levelDir) ?? levelDir, "Overrides");
        if (!Directory.Exists(overridesDir)) return 0;
        string[] specPaths = Directory.GetFiles(overridesDir, "override.json", SearchOption.AllDirectories);
        if (specPaths.Length == 0) return 0;
        // Validate every package before applying the first one so a malformed later package cannot leave the
        // level half-modified.
        foreach (string specPath in specPaths)
            contracts.RequireFile(specPath, ContractKind.PropOverrideV1);

        string modelsPath = Path.Combine(levelDir, "Models.json");
        string instPath = Path.Combine(levelDir, "Instances.json");
        if (!File.Exists(modelsPath) || !File.Exists(instPath))
        {
            Log.Warn($"Prop overrides: {levelDir} has no Models.json/Instances.json - skipped.");
            return 0;
        }

        string levelName = new DirectoryInfo(levelDir).Name;
        var models = ModelJsonHandler.Load(modelsPath).Models ?? new();
        var instances = InstanceJsonHandler.Load(instPath).Instances ?? new();
        string matPath = Path.Combine(levelDir, "Materials.json");
        var materials = File.Exists(matPath)
            ? (MaterialJsonHandler.Load(matPath).Materials ?? new())
            : new List<MaterialJsonHandler.MaterialsJson>();

        Log.Info($"Prop overrides ({overridesDir}){(dry ? " [dry run]" : "")}:");
        int applied = 0;
        foreach (string specPath in specPaths.OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
            applied += ApplyOne(specPath, levelDir, levelName, models, instances, materials, dry) ? 1 : 0;
        if (applied == 0) Log.Info("  (no package matched this level.)");
        return applied;
    }

    private static bool ApplyOne(string specPath, string levelDir, string levelName,
                                 List<ModelJsonHandler.ModelJson> models,
                                 List<InstanceJsonHandler.InstanceJson> instances,
                                 List<MaterialJsonHandler.MaterialsJson> materials, bool dry)
    {
        Spec? spec;
        try { spec = JsonSerializer.Deserialize<Spec>(File.ReadAllText(specPath), Js); }
        catch (Exception ex) { Log.Warn($"  ! {specPath}: unreadable ({ex.Message})"); return false; }
        string pkgDir = Path.GetDirectoryName(specPath)!;
        string label = spec?.Name ?? Path.GetFileName(pkgDir);
        if (spec == null || string.IsNullOrWhiteSpace(spec.Match) || spec.Meshes.Count == 0)
        {
            Log.Warn($"  ! {label}: override.json needs at least \"match\" + \"meshes\" - skipped.");
            return false;
        }
        if (spec.Levels is { Count: > 0 } && !spec.Levels.Contains(levelName, StringComparer.OrdinalIgnoreCase))
        {
            Log.Info($"  - {label}: levels filter excludes {levelName} - skipped.");
            return false;
        }

        // ---- resolve the package's source files (relative to override.json) --------------------
        string Resolve(string rel) => Path.GetFullPath(Path.Combine(pkgDir, rel));
        var missing = spec.Meshes.Select(Resolve).Where(p => !File.Exists(p)).ToList();
        if (spec.Collision != null && !File.Exists(Resolve(spec.Collision))) missing.Add(Resolve(spec.Collision));
        if (spec.Textures != null) missing.AddRange(spec.Textures.Values.Select(Resolve).Where(p => !File.Exists(p)));
        if (spec.PrivatePages != null) missing.AddRange(spec.PrivatePages.Values.Select(p => Resolve(p.Texture)).Where(p => !File.Exists(p)));
        if (missing.Count > 0)
        {
            Log.Warn($"  ! {label}: missing source file(s) - skipped:");
            foreach (string m in missing) Log.Info($"      {m}");
            return false;
        }

        // ---- match models by ModelName prefix ---------------------------------------------------
        // Prefix (not substring) so e.g. "Mdl_MediaTower_Tall" never catches "Mdl_MediaTower_Fat".
        var matchedIds = new List<int>();
        for (int i = 0; i < models.Count; i++)
            if (models[i].ModelName is { } n && n.StartsWith(spec.Match, StringComparison.OrdinalIgnoreCase))
                matchedIds.Add(i);
        if (matchedIds.Count == 0)
        {
            Log.Info($"  - {label}: no '{spec.Match}*' models in {levelName} - skipped.");
            return false;
        }

        // Every matched variant must expose the same mesh slots the package was authored against.
        var slotsPerModel = new Dictionary<int, List<(string path, int mat)>>();
        foreach (int id in matchedIds)
        {
            var slots = (models[id].ModelObjects ?? new())
                .SelectMany(o => o.MeshData ?? new())
                .Select(md => (md.MeshPath, md.MaterialID)).ToList();
            if (slots.Count != spec.Meshes.Count)
            {
                Log.Warn($"  ! {label}: {models[id].ModelName} has {slots.Count} mesh slot(s), package has {spec.Meshes.Count} - skipped (nothing installed).");
                return false;
            }
            slotsPerModel[id] = slots;
        }

        // ---- meshes: package slot i -> Meshes/<MeshPath> of every matched variant ---------------
        int meshFiles = 0;
        foreach (int id in matchedIds)
            for (int s = 0; s < spec.Meshes.Count; s++)
            {
                Install(Resolve(spec.Meshes[s]), Path.Combine(levelDir, "Meshes", slotsPerModel[id][s].path), dry);
                meshFiles++;
            }

        // ---- collision: every proxy referenced by an instance of a matched model ----------------
        int proxyFiles = 0;
        if (spec.Collision != null)
        {
            var ids = new HashSet<int>(matchedIds);
            var mine = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
            var theirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var inst in instances)
                foreach (string p in inst.CollsionModelPaths ?? Array.Empty<string>())
                    (ids.Contains(inst.ModelID) ? (ICollection<string>)mine : theirs).Add(p);
            foreach (string p in mine)
            {
                if (theirs.Contains(p))
                    Log.Warn($"      ! collision proxy {p} is shared with non-matching instances - replacing it changes those too.");
                Install(Resolve(spec.Collision), Path.Combine(levelDir, "Collision", p), dry);
                proxyFiles++;
            }
        }

        // ---- textures + alpha: slot -> MaterialID -> TexturePath (per level) --------------------
        // Pages the matched models' own materials reference; warn when another material shares one.
        var myMatIds = new HashSet<int>(slotsPerModel.Values.SelectMany(s => s).Select(s => s.mat));
        List<string> PagesForSlot(int slot)
        {
            var pages = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (int id in matchedIds)
            {
                int mat = slotsPerModel[id][slot].mat;
                if (mat >= 0 && mat < materials.Count && materials[mat].TexturePath is { Length: > 0 } page)
                    pages.Add(page);
            }
            return pages.ToList();
        }
        void WarnShared(string page)
        {
            for (int m = 0; m < materials.Count; m++)
                if (!myMatIds.Contains(m) && string.Equals(materials[m].TexturePath, page, StringComparison.OrdinalIgnoreCase))
                {
                    Log.Warn($"      ! page {page} is shared with other props' materials (e.g. mat {m}) - repainting it changes those too.");
                    return;
                }
        }

        var pageNames = new List<string>();
        if (spec.Textures != null)
            foreach (var (slotKey, src) in spec.Textures)
            {
                if (!int.TryParse(slotKey, out int slot) || slot < 0 || slot >= spec.Meshes.Count)
                { Log.Warn($"      ! textures key '{slotKey}' is not a mesh slot index - ignored."); continue; }
                foreach (string page in PagesForSlot(slot))
                {
                    WarnShared(page);
                    Install(Resolve(src), Path.Combine(levelDir, "Textures", page), dry);
                    pageNames.Add(page);
                }
            }

        var alphaSet = new List<string>();
        if (spec.Alpha != null)
        {
            var merged = new Dictionary<string, string>();
            foreach (var (slotKey, mode) in spec.Alpha)
            {
                if (!int.TryParse(slotKey, out int slot) || slot < 0 || slot >= spec.Meshes.Count)
                { Log.Warn($"      ! alpha key '{slotKey}' is not a mesh slot index - ignored."); continue; }
                foreach (string page in PagesForSlot(slot))
                { merged[page] = mode; alphaSet.Add($"{page}={mode}"); }
            }
            if (merged.Count > 0) MergeAlphaOverrides(levelDir, merged, dry);
        }

        // ---- private pages: give the matched models their OWN copy of a slot's texture page, so a page
        // still SHARED with other props (e.g. a sibling model that wasn't remodelled) stays vanilla. We
        // clone the slot's material onto a new page and repoint every matched model's MeshData[slot].
        // MaterialID to it, then rewrite Models/Materials.json. Idempotent: keyed by the clone's
        // MaterialName, so a re-apply (or a fresh extract that regenerated vanilla json) yields exactly one
        // private material + one repoint. (Models/Materials are snowknife-internal and skipped by `unity`.)
        var privateSet = new List<string>();
        bool modelsChanged = false, materialsChanged = false;
        if (spec.PrivatePages != null)
        {
            // Walk the matched model's FLATTENED mesh slots to the (ModelObject, MeshData) holding `flatSlot`
            // and set its MaterialID. MeshData is a reference-type list shared with `models`, so the write
            // lands in the data saved below. No-op in dry mode (preview only).
            void RepointSlot(int modelId, int flatSlot, int newMat)
            {
                if (dry) return;
                var objs = models[modelId].ModelObjects;
                if (objs == null) return;
                int acc = 0;
                foreach (var o in objs)
                {
                    var md = o.MeshData;
                    if (md == null) continue;
                    if (flatSlot < acc + md.Count)
                    {
                        int local = flatSlot - acc;
                        var mh = md[local];
                        if (mh.MaterialID != newMat) { mh.MaterialID = newMat; md[local] = mh; modelsChanged = true; }
                        return;
                    }
                    acc += md.Count;
                }
            }

            foreach (var (slotKey, pp) in spec.PrivatePages)
            {
                if (!int.TryParse(slotKey, out int slot) || slot < 0 || slot >= spec.Meshes.Count)
                { Log.Warn($"      ! privatePages key '{slotKey}' is not a mesh slot index - ignored."); continue; }
                if (pp == null || string.IsNullOrWhiteSpace(pp.Page) || string.IsNullOrWhiteSpace(pp.Texture))
                { Log.Warn($"      ! privatePages[{slot}] needs \"texture\" + \"page\" - ignored."); continue; }

                // 1) install the private page image (a brand-new page file, referenced by these models only).
                Install(Resolve(pp.Texture), Path.Combine(levelDir, "Textures", pp.Page), dry);

                // 2) ensure exactly one private material exists (clone the slot's CURRENT material the first
                //    time; on re-apply it's already there, so we never clone the clone).
                string privName = "OpenSlopePriv_" + Path.GetFileNameWithoutExtension(pp.Page);
                int privIdx = materials.FindIndex(m => string.Equals(m.MaterialName, privName, StringComparison.OrdinalIgnoreCase));
                if (privIdx < 0)
                {
                    int srcMat = slotsPerModel[matchedIds[0]][slot].mat;
                    var clone = (srcMat >= 0 && srcMat < materials.Count)
                        ? materials[srcMat] : new MaterialJsonHandler.MaterialsJson();
                    clone.MaterialName = privName;
                    clone.TexturePath = pp.Page;
                    if (dry) privIdx = materials.Count;
                    else { materials.Add(clone); privIdx = materials.Count - 1; materialsChanged = true; }
                }
                else if (!string.Equals(materials[privIdx].TexturePath, pp.Page, StringComparison.OrdinalIgnoreCase) && !dry)
                {
                    var fix = materials[privIdx]; fix.TexturePath = pp.Page; materials[privIdx] = fix; materialsChanged = true;
                }

                // 3) repoint every matched model's slot to the private material.
                foreach (int id in matchedIds) RepointSlot(id, slot, privIdx);

                // 4) alpha mode for the new page (e.g. cutout for the frosted windows).
                if (!string.IsNullOrWhiteSpace(pp.Alpha))
                    MergeAlphaOverrides(levelDir, new Dictionary<string, string> { [pp.Page] = pp.Alpha! }, dry);

                privateSet.Add($"{pp.Page}<-slot{slot}" + (string.IsNullOrWhiteSpace(pp.Alpha) ? "" : $"/{pp.Alpha}"));
            }

            if (!dry && materialsChanged)
                new MaterialJsonHandler { Materials = materials }.CreateJson(Path.Combine(levelDir, "Materials.json"));
            if (!dry && modelsChanged)
                new ModelJsonHandler { Models = models }.CreateJson(Path.Combine(levelDir, "Models.json"));
        }

        // ---- alpha for arbitrary pages: force a classification on a page this package does NOT repaint -
        // e.g. the shared page it just FREED via privatePages (a sibling model still uses it and needs its
        // original mode, which auto-classification may get wrong - SSX stores ~0x80 "opaque" alpha that
        // reads as half-transparent). Keyed by page name directly, unlike the slot-keyed `alpha`.
        if (spec.AlphaPages is { Count: > 0 })
        {
            var pages = spec.AlphaPages.Where(kv => !string.IsNullOrWhiteSpace(kv.Value))
                                       .ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.OrdinalIgnoreCase);
            if (pages.Count > 0) MergeAlphaOverrides(levelDir, pages, dry);
            foreach (var (pg, md) in pages) alphaSet.Add($"{pg}={md}");
        }

        string verb = dry ? "would install" : "installed";
        Log.Info($"  - {label}: '{spec.Match}*' = {matchedIds.Count} model(s) " +
                          $"({string.Join("/", matchedIds.Select(id => models[id].ModelName))}); {verb} " +
                          $"{meshFiles} mesh file(s), {proxyFiles} collision proxy(ies), {pageNames.Count} texture page(s)" +
                          (alphaSet.Count > 0 ? $", alpha {string.Join(" ", alphaSet.Distinct())}" : "") +
                          (privateSet.Count > 0 ? $", private page(s) {string.Join(" ", privateSet)}" : "") + ".");
        return true;
    }

    // Copy src over dest, keeping the level's pristine file beside it as <dest>.orig_bak the first
    // time it is touched - that backup is the way back to vanilla.
    private static void Install(string src, string dest, bool dry)
    {
        if (dry)
        {
            Log.Info($"      {Path.GetFileName(dest)}  <-  {src}");
            return;
        }
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        string bak = dest + ".orig_bak";
        if (File.Exists(dest) && !File.Exists(bak)) File.Copy(dest, bak);
        File.Copy(src, dest, overwrite: true);
    }

    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true };

    // Fold the package's alpha modes into <levelDir>/TextureAlpha.overrides.json (the per-level
    // classify override TextureBundle reads at `gltf` time), preserving entries from other sources.
    private static void MergeAlphaOverrides(string levelDir, Dictionary<string, string> add, bool dry)
    {
        string path = Path.Combine(levelDir, "TextureAlpha.overrides.json");
        Dictionary<string, string> map;
        try
        {
            map = File.Exists(path)
                ? JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(path), Js) ?? new()
                : new();
        }
        catch { map = new(); }
        bool changed = false;
        foreach (var (page, mode) in add)
            if (!map.TryGetValue(page, out string? cur) || !string.Equals(cur, mode, StringComparison.OrdinalIgnoreCase))
            { map[page] = mode; changed = true; }
        if (changed && !dry)
            File.WriteAllText(path, JsonSerializer.Serialize(map, Indented));
    }
}
