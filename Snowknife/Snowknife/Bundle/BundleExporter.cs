using Snowknife.Services;

namespace Snowknife.Bundle;

/// <summary>
/// Assembles the engine-ready BUNDLE from an already-extracted level folder: standard glTF (.glb)
/// meshes with baked normals / UVs / lightmap UV1 / vertex colour, a lightmap atlas PNG, and a
/// manifest.json sidecar that ties them together and carries the derived, engine-agnostic data the
/// importer would otherwise recompute. The bundle is what makes snowknife a generic tool - the same output
/// opens correctly in Blender and is loaded as-is by the thin Unity importer, which REQUIRES it (there is
/// no client-side recompute fallback; see docs/034).
///
/// Lives ALONGSIDE the raw export (OBJ/JSON/PNG) - those still serve Blender + the single-stage snowknife
/// re-run commands, but the Unity importer reads only the bundle.
/// Output: <levelDir>/gltf/{terrain.glb, props.glb, collision.glb, LightmapAtlas.png, manifest.json}.
/// No texture copies - materials reference PNGs by NAME and every consumer resolves them from the level's
/// finished top-level Textures/ (one folder up from the .glb).
/// </summary>
public static class BundleExporter
{
    internal static int Export(string levelDir, string levelName, ContractValidationService contracts)
    {
        levelDir = Path.GetFullPath(levelDir);
        string bundleDir = Path.Combine(levelDir, "gltf");
        // gltf/ is wholly owned by this step: rebuild it from scratch so a re-run never leaves files
        // from an earlier build's layout behind.
        if (Directory.Exists(bundleDir)) Directory.Delete(bundleDir, recursive: true);
        Directory.CreateDirectory(bundleDir);

        var manifest = new BundleManifest
        {
            Level = levelName.ToLowerInvariant(),
            Provenance = ContentProvenance.Read(levelDir),
        };
        Log.Info($"Content provenance: {manifest.Provenance.PublicDistribution}"
            + (manifest.Provenance.Reasons.Count > 0
                ? $" ({string.Join(", ", manifest.Provenance.Reasons)})" : ""));

        Log.Info("Bundling terrain ...");
        var terrainOpts = new TerrainBundle.Opts();
        var (terrainNodes, lm) = TerrainBundle.Build(levelDir, bundleDir, terrainOpts);
        manifest.Space.Scale = terrainOpts.Scale;
        manifest.Lightmap = lm;

        var writer = new GltfMeshWriter(terrainOpts.Scale);
        string terrainGlb = Path.Combine(bundleDir, "terrain.glb");
        writer.Save(terrainGlb, terrainNodes);
        manifest.Meshes.Add(new BundleManifest.MeshRef { File = "terrain.glb", Kind = "terrain" });
        Log.Info($"  -> {terrainGlb} ({new FileInfo(terrainGlb).Length:n0} bytes)");

        Log.Info("Bundling props ...");
        // Classify the scripted-break obstacle props ONCE (SSF effect graph: fences/hole-covers/tree-branches whose
        // ride-through hides the source / reveals a _Junk twin, PLUS the trigger-driven walls whose break is carried
        // by a separate hidden trigger volume - Unity docs/036). PropsBundle diverts them as breakable; CollisionBundle
        // skips them (they get a pass-through break trigger instead of a solid wall).
        var instances = SsxInstances.Load(levelDir)
            ?? throw new FileNotFoundException($"Instances.json not found in '{levelDir}'. Extract or export the canonical map first.");
        // From here on there is one representation.  Authored and retail maps both bind effects, animation,
        // lighting, collision and audio through native-shaped instance rows.
        var effectInstances = instances;
        var breakMap = BreakableClassifier.Build(levelDir, instances, out var spillSources);
        // Only the INLINE breakables ("brk_": fences/hole-covers/branches/trigger-driven walls) get a pass-through break trigger instead
        // of solid collision. LCD jumbotrons ("lcd_") are diverted for RENDER (the intact/broken/scanline swap) but
        // keep whatever collision they already had (their CollsionMode-2 pass-through / pinned proxies are unchanged).
        // ...with one exception, and it is the whole reason a cracked pane works: the "support" twin (Unity docs/036
        // §Cracked glass) is the invisible SOLID slab that holds the rider up until the glass gives way. Skipping
        // its collision would drop the rider through intact glass on arrival. It keeps a collider - just its OWN,
        // as a single-instance bucket CollisionBundle stamps with the cluster, so the break can disable that one
        // pane's floor and nothing else.
        var breakSet = new HashSet<int>(breakMap
            .Where(kv => kv.Value.ClusterKey.StartsWith("brk_", System.StringComparison.Ordinal) && kv.Value.Role != "support")
            .Select(kv => kv.Key));
        var breakSupports = breakMap.Where(kv => kv.Value.Role == "support")
            .ToDictionary(kv => kv.Key, kv => kv.Value.ClusterKey);
        var propsOpts = new PropsBundle.Opts { Scale = terrainOpts.Scale };
        // Spinning score pickups (trick-multiplier gems), data-derived from the SSF graph (a MainType-14 pickup
        // effect), so a renamed/custom gem is still diverted as a spinner. Shared by the animated-prop exclusion
        // below and PropsBundle's divert classification.
        var gemTargets = ParticleBundle.GemTargets(levelDir, effectInstances);

        // Authored mode gating (Unity docs/026): HideShowOff identifies show-off-only props/rails and HideRace
        // identifies race-only props. Bake and tag both sets so the runtime mode selector can reproduce RaceMode,
        // ShowoffMode and FreerideMode without rebuilding the map. [Trailmap: 140-rail-toggle]
        var gating = RailGating.Load(levelDir);
        if (gating.Any)
            Log.Info($"  Mode tagging: {gating.GatedSplines.Count} show-off rails + " +
                              $"{gating.HiddenInstances.Count} show-off-only props + " +
                              $"{gating.RaceHiddenInstances.Count} race-only props.");

        // Dynamic movement is effect-driven by specification: a collision Roller activates the body's scalar mass
        // [Trailmap: 130-collision-data, 370-world-interaction]. Detect this before animation classification so
        // a Roller body keeps ownership of its dynamic instance.
        var rollerData = ParticleBundle.BuildRollerTargets(levelDir, effectInstances);
        var rollerTargets = rollerData.Targets;

        // Classify + bake the ANIMATED props (the swinging bridge: a persistent SSF AnimObject plays the
        // model's own clip; Unity docs/038). They divert out of the merged props mesh AND the static collision bake -
        // their model-local segment nodes + manifest records carry the hierarchy + cubic channels instead.
        // Yields to the other divert kinds (a gem's spin is also an AnimObject, but gems are spinners).
        var animMap = AnimatedPropsBundle.Classify(levelDir, effectInstances, idx =>
        {
            return breakMap.ContainsKey(idx) || gemTargets.Contains(idx) || rollerTargets.Contains(idx);
        }, out var animTriggered, out var animGated, out var animCombos);
        // Roll-away breakables (Unity docs/036 - the globe sign): a trigger-driven break whose chain PLAYS the intact's
        // own model clip before the swap. The intact is excluded from Classify above (breakables win the divert),
        // so merge its classifier-captured Sub256 payload in as a BREAK-OWNED record: segments+curves bake like
        // any animated prop, but the breakable behaviour owns triggering/reset (no volumes, no colliders) and the
        // instance KEEPS its breakable divert (it stays out of animSet so PropsBundle still emits the cluster).
        var breakRolls = new HashSet<int>();
        foreach (var kv in breakMap)
            if (kv.Value.Anim != null && kv.Value.Role == "intact" && !animMap.ContainsKey(kv.Key))
            { animMap[kv.Key] = kv.Value.Anim; breakRolls.Add(kv.Key); }
        // A breakable can also just IDLE. Aloha's penguins and fan blades and Snowdream's balloon animals carry a
        // persistent Sub256 alongside their mesh-throw collision chain - a waddle/spin that runs until the prop is
        // smashed - and that is a different thing from the roll above, which is played BY the break chain. The
        // roll merge cannot see it (it reads the break chain) and the ordinary pass cannot either (breakables are
        // excluded), so a second walk restricted to breakables picks up the persistent clip. Same break-owned
        // handling - the breakable keeps its divert and owns the smash - but FREE-RUNNING rather than triggered.
        var breakIdle = new HashSet<int>();
        var idleMap = AnimatedPropsBundle.Classify(levelDir, effectInstances,
            idx => !breakMap.ContainsKey(idx) || breakRolls.Contains(idx) || animMap.ContainsKey(idx)
                   || gemTargets.Contains(idx) || rollerTargets.Contains(idx),
            out _, out _, out _);
        foreach (var kv in idleMap)
            if (breakMap.TryGetValue(kv.Key, out var member) && member.Role == "intact")
            { animMap[kv.Key] = kv.Value; breakRolls.Add(kv.Key); breakIdle.Add(kv.Key); }
        var animOpts = new AnimatedPropsBundle.Opts { Scale = terrainOpts.Scale };
        var anim = AnimatedPropsBundle.Build(levelDir, instances, animMap, animTriggered, animGated, animOpts,
                                             breakRolls, animCombos, breakIdle);
        Log.Info($"  Animated: {anim.Stats}"
                          + (breakRolls.Count - breakIdle.Count > 0 ? $" ({breakRolls.Count - breakIdle.Count} break-owned roll(s))" : "")
                          + (breakIdle.Count > 0 ? $" ({breakIdle.Count} break-owned idle(s))" : ""));
        // Only the ones with a real clip divert; a BREAK-OWNED roll stays OUT so PropsBundle keeps its breakable
        // divert (the animated record renders it; the importer skips the intact divert's renderer).
        var animSet = new HashSet<int>(anim.Records.Where(r => !r.BreakOwned).Select(r => r.Index));

        var moverTargets = ParticleBundle.SplineMoverTargets(levelDir, effectInstances);
        var soft = ParticleBundle.SoftBodyTargets(levelDir, effectInstances);
        // Speed/trick boost pads (Unity docs/040): diverted out of the merged static mesh so each decal owns a transform
        // the runtime can pop + regrow on a cross. Data-derived from the same M17/M18 scan that bakes the pads.
        var boostPadTargets = ParticleBundle.BoostPadTargets(levelDir, effectInstances);
        // Per-instance contact bursts (a gem's collect flash, a balloon's pop), hung on the matching divert record
        // so the importer renders them through the same shared P6 path as the boost pads (Unity docs/023, Unity docs/036).
        var burstLayers = ParticleBundle.CollisionBurstLayers(levelDir, effectInstances);
        // Ride-over BUTTONS (Unity docs/008): a trigger volume's collision header MainType-7 plays a Length>0 TextureFlip
        // on a visible button - a brief PULSE of its second material state - and separately plays the AnimObject on
        // the pillars/door the button opens, which is what actually stays open. The button carries no effect slot of
        // its own, so this is the only pass that finds it. They divert so each can pulse alone - a line of buttons
        // shares one prop group, but only the one you rode over changes. Yields to every kind already claimed above.
        var pulses = TriggeredFlipClassifier.Classify(levelDir, effectInstances, idx =>
            breakMap.ContainsKey(idx) || gemTargets.Contains(idx) || rollerTargets.Contains(idx)
            || animSet.Contains(idx) || moverTargets.Contains(idx) || soft.Flags.Contains(idx)
            || soft.Fences.Contains(idx) || boostPadTargets.Contains(idx));
        var pulseBoxes = AnimatedPropsBundle.TriggerBoxes(levelDir, instances, pulses.Values.SelectMany(l => l.Volumes));
        var pulseTimelines = TriggeredFlipClassifier.Timelines(levelDir, effectInstances, pulses);
        var props = PropsBundle.Build(levelDir, propsOpts, breakMap, animSet, gating.HiddenInstances, rollerTargets, rollerData.Masses,
                                      moverTargets, soft.Flags, soft.Fences, gemTargets, boostPadTargets,
                                      burstLayers, spillSources, pulses, pulseBoxes, pulseTimelines,
                                      raceHiddenInstances: gating.RaceHiddenInstances);
        if (pulses.Count > 0)
        {
            var shape = pulseTimelines.Values.Select(t => string.Join("+", t.holds.Select(h => h.ToString("0.##")))).Distinct().ToList();
            Log.Info($"  Buttons: {pulses.Count} ride-over pulse(s) diverted, " +
                              $"{pulses.Values.Sum(l => l.Volumes.Count)} trigger volume(s); " +
                              $"pulse hold(s) {string.Join(" / ", shape)}s then back to the material's own frame.");
        }
        int spillBodies = props.Records.Count(r => r.SpillCluster != null);
        Log.Info($"  Props: {props.Stats} ({breakMap.Count} breakable members from SSF: fences/hole-covers/branches/trigger-driven walls)"
                          + (spillBodies > 0 ? $"; {spillBodies} knock body(s) also spill a contents twin on the hit (Unity docs/036)" : ""));
        var propNodes = new List<GltfMeshWriter.Node> { props.Static };   // "Props" merged + one "Divert_{i}" per diverted instance
        if (props.ShowoffStatic != null) propNodes.Add(props.ShowoffStatic);   // "PropsShowoff": show-off-only static props
        if (props.RaceStatic != null) propNodes.Add(props.RaceStatic);         // "PropsRace": race-only static props
        propNodes.AddRange(props.Diverted);
        propNodes.AddRange(anim.Nodes);                                   // + one "Anim_{i}_o{k}" per animated segment
        manifest.Props = new BundleManifest.PropsInfo
        {
            Diverted = props.Records,
            Animated = anim.Records.Count > 0 ? anim.Records : null,
            Locators = props.Locators.Count > 0 ? props.Locators : null,
        };
        string propsGlb = Path.Combine(bundleDir, "props.glb");
        new GltfMeshWriter(terrainOpts.Scale).Save(propsGlb, propNodes);
        manifest.Meshes.Add(new BundleManifest.MeshRef { File = "props.glb", Kind = "props" });
        Log.Info($"  -> {propsGlb} ({new FileInfo(propsGlb).Length:n0} bytes, {propNodes.Count} nodes)");

        Log.Info("Bundling collision ...");
        // rollerTargets = the knock-and-tumble diverts (PropsBundle gives them a PhysicsProp body); exclude them from
        // every static collision path so a duplicate box/bucket/doorway doesn't block the moving body. Mirrors how
        // breakSet is excluded; instance response mass is not the movement-activation test.
        var (colNodes, colInfo) = CollisionBundle.Build(levelDir, new CollisionBundle.Opts { Scale = terrainOpts.Scale },
                                                        breakSet, animSet, rollerTargets, breakSupports,
                                                        gating.HiddenInstances, gating.RaceHiddenInstances);
        manifest.Collision = colInfo;
        if (colNodes.Count > 0)
        {
            string colGlb = Path.Combine(bundleDir, "collision.glb");
            new GltfMeshWriter(terrainOpts.Scale).Save(colGlb, colNodes);
            manifest.Meshes.Add(new BundleManifest.MeshRef { File = "collision.glb", Kind = "collision" });
            Log.Info($"  -> {colGlb} ({new FileInfo(colGlb).Length:n0} bytes)");
        }

        Log.Info("Bundling paths (rails + course) ...");
        manifest.Paths = PathBundle.Build(levelDir, out var railSplineToIndex, gatedSplines: gating.GatedSplines);
        // Rail toggles (MainType 25): the gated rails (Paths.Rails.Gated) start off; a trigger volume enables them.
        manifest.RailGates = RailGateBundle.Build(levelDir, railSplineToIndex);
        // Authored gem pickups (the trick layer's other half): Slopesmith's Gems.json, straight into the manifest
        // as positions + score values. Absent (extracted levels) → null; those gems ride the SSF-derived spinner path.
        manifest.Gems = GemBundle.Build(levelDir);
        // The course's video screens (Billboards.json - detected by `snowknife billboards`, or authored in
        // Slopesmith): flat rectangles a consumer lays its own video quad over, since a board's ad face is
        // welded into the merged prop mesh and can't be retextured on its own (Unity docs/vrchat/041).
        manifest.Billboards = BillboardBundle.Build(levelDir);
        // The course's native gem crystals (GemModels.obj — the donor's shipped tier models): their own glb, one
        // node per tier, kept OUT of props.glb so each gem instantiates individually (spin + collect). The
        // importer synthesises a stand-in crystal when this is absent (older courses).
        var gemNodes = GemBundle.BuildGeometry(levelDir, manifest.Gems);
        if (gemNodes.Count > 0)
        {
            string gemsGlb = Path.Combine(bundleDir, "gems.glb");
            new GltfMeshWriter(terrainOpts.Scale).Save(gemsGlb, gemNodes);
            manifest.Meshes.Add(new BundleManifest.MeshRef { File = "gems.glb", Kind = "gems" });
            Log.Info($"  -> {gemsGlb} ({new FileInfo(gemsGlb).Length:n0} bytes, {gemNodes.Count} tier node(s))");
        }

        Log.Info("Bundling particles + fireworks + emitters + boost pads + teleports + HUD messages ...");
        var particleOpts = new ParticleBundle.Opts();
        manifest.Particles = ParticleBundle.BuildParticles(levelDir, particleOpts);
        manifest.Fireworks = ParticleBundle.BuildFireworks(levelDir);
        manifest.Emitters = ParticleBundle.BuildEmitters(levelDir, particleOpts);
        manifest.AmbientEmitters = ParticleBundle.BuildAmbientEmitters(levelDir);
        manifest.LightGlows = ParticleBundle.BuildLightGlows(levelDir);
        manifest.BoostPads = ParticleBundle.BuildBoostPads(levelDir);
        if (manifest.BoostPads != null)
            foreach (var pad in manifest.BoostPads.Pads)
                pad.ModeMask = (gating.HiddenInstances.Contains(pad.Index) ? 2 : 7)
                             & (gating.RaceHiddenInstances.Contains(pad.Index) ? 1 : 7);
        manifest.ResetZones = ParticleBundle.BuildResetZones(levelDir);
        manifest.BoostVolumes = ParticleBundle.BuildBoostVolumes(levelDir);
        manifest.SplineMovers = ParticleBundle.BuildSplineMovers(levelDir);
        manifest.Teleports = ParticleBundle.BuildTeleports(levelDir);
        manifest.HudMessages = ParticleBundle.BuildHudMessages(levelDir);

        Log.Info("Bundling audio + probes ...");
        var placementOpts = new ScenePlacementBundle.Opts();
        manifest.Audio = ScenePlacementBundle.BuildAudio(levelDir, placementOpts);
        // Name the course bank explicitly from the map-local extraction result; the importer must not infer it
        // from folder names, and the bundle must not carry its own copy of BANKS.INF's level table.
        string courseBank = SoundIndexDocument.Load(levelDir)?.CourseBank ?? "";
        if (courseBank.Length > 0)
        {
            manifest.Audio ??= new BundleManifest.AudioInfo();
            manifest.Audio.CourseBank = courseBank;
        }
        manifest.Probes = ScenePlacementBundle.BuildProbes(levelDir, placementOpts);
        manifest.Sun = LightsBundle.Build(levelDir);
        manifest.Race = RaceBundle.Build(levelDir, levelName);

        Log.Info("Classifying textures ...");
        manifest.Textures = TextureBundle.Build(levelDir);

        Log.Info("Bundling materials ...");
        // Resolve every material-slot name a consumer can look up to its texture / alpha / flipbook / scroll,
        // so the bundle is self-describing. Terrain slots come from the glb
        // (texture files); prop slots are scanned from Props.obj's usemtl - the COMPLETE set, including the
        // diverted gems/physics/breakable instances the importer builds engine-side from the OBJ (those are
        // excluded from props.glb, so a glb-only scan would miss their materials). Include the actual prop/gem
        // nodes too: canonical authored animation keeps `_objN` aliases in Props.obj, while its segment GLB
        // deliberately uses the base `mat_N` slot. Both names must resolve or the moving mesh imports white.
        var slots = new List<string>();
        foreach (var n in terrainNodes) foreach (var p in n.Prims) slots.Add(p.Material);
        foreach (var n in propNodes) foreach (var p in n.Prims) slots.Add(p.Material);
        foreach (var n in gemNodes) foreach (var p in n.Prims) slots.Add(p.Material);
        foreach (var objName in new[] { "Props.obj", "GemModels.obj" }) // gem tier crystals bake to gems.glb but resolve materials the same way
        {
            string objFile = Path.Combine(levelDir, objName);
            if (File.Exists(objFile))
                foreach (var line in File.ReadLines(objFile))
                    if (line.StartsWith("usemtl ", StringComparison.Ordinal))
                    {
                        string slot = line.Substring(7).Trim();
                        // Per-cell crowd slots ("mat_crowd_c<NN>") share one resolved record: PropsBundle
                        // folds them into a single "mat_crowd" prim, which is the name consumers look up.
                        if (slot.StartsWith("mat_crowd", StringComparison.Ordinal)) slot = "mat_crowd";
                        slots.Add(slot);
                    }
        }
        manifest.Materials = MaterialBundle.Build(levelDir, slots, manifest.Textures, new MaterialBundle.Opts
        {
            // The buttons' materials: a triggered state pair a crossing pulses, so they must never free-run.
            PulsedMaterials = TriggeredFlipClassifier.PulsedMaterials(levelDir, effectInstances, pulses.Keys),
        });
        Log.Info($"  Materials: {manifest.Materials.Count} resolved " +
                          $"({manifest.Materials.Count(m => m.Texture != null)} textured, " +
                          $"{manifest.Materials.Count(m => m.Flipbook != null)} flipbook, " +
                          $"{manifest.Materials.Count(m => m.Scroll != null)} scroll).");

        string manifestPath = Path.Combine(bundleDir, "manifest.json");
        manifest.Save(manifestPath, contracts);
        Log.Info($"  -> {manifestPath}");

        Log.Info($"Bundle written to {bundleDir}");
        return 0;
    }

    // Inspect a .glb: per-node mesh/primitive/vertex counts + the overall bounding box. A quick
    // sanity check that geometry is well-formed and sits in the expected glTF space (Y-up metres).
    public static int Info(string glbPath)
    {
        var model = SharpGLTF.Schema2.ModelRoot.Load(glbPath);
        Log.Info($"{Path.GetFileName(glbPath)}: {model.LogicalMeshes.Count} meshes, " +
                          $"{model.LogicalMaterials.Count} materials");
        var min = new System.Numerics.Vector3(float.MaxValue);
        var max = new System.Numerics.Vector3(float.MinValue);
        long totalVerts = 0, totalTris = 0;
        foreach (var node in model.DefaultScene.VisualChildren)
        {
            var mesh = node.Mesh;
            if (mesh == null) continue;
            long v = 0, t = 0;
            foreach (var prim in mesh.Primitives)
            {
                var pos = prim.GetVertexAccessor("POSITION")?.AsVector3Array();
                if (pos != null) { v += pos.Count; foreach (var pp in pos) { min = System.Numerics.Vector3.Min(min, pp); max = System.Numerics.Vector3.Max(max, pp); } }
                t += prim.GetIndices()?.Count / 3 ?? 0;
            }
            Log.Info($"  {mesh.Name,-18} {mesh.Primitives.Count,3} prim {v,8:n0} v {t,8:n0} tri" +
                              $"  [{string.Join(",", PrimMaterials(mesh))}]");
            totalVerts += v; totalTris += t;
        }
        Log.Info($"  TOTAL {totalVerts:n0} verts, {totalTris:n0} tris");
        Log.Info($"  bounds min ({min.X:0.##},{min.Y:0.##},{min.Z:0.##}) max ({max.X:0.##},{max.Y:0.##},{max.Z:0.##})");
        Log.Info($"  size  ({max.X - min.X:0.##} x {max.Y - min.Y:0.##} x {max.Z - min.Z:0.##}) metres");
        return 0;
    }

    static IEnumerable<string> PrimMaterials(SharpGLTF.Schema2.Mesh mesh)
    {
        var seen = new HashSet<string>();
        foreach (var p in mesh.Primitives) { var n = p.Material?.Name ?? "?"; if (seen.Add(n)) yield return n; }
    }
}
