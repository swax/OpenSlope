#if UNITY_EDITOR
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Entry points + dependency wiring for the SSX level importer. The actual work lives in the service
    // classes (ImportConfig, AlphaClassifier, InstanceLighting, MaterialFactory, CollisionBuilder,
    // TerrainBuilder, PropBuilder, ParticleBuilder, ProbeBuilder, SkyboxBaker, PreviewRenderer) - each one a system with its
    // dependencies passed in. This file is just the "main": the OpenSlope/* menu items build the object graph they
    // need and run it. The full import is folder-generic (ImportConfig.For(folder), via the "Map…"
    // picker). The why behind each system is in the design docs under ../docs/ (001 CLI export -> 010 object lighting).

    // ---- menu (thin shims that wire up dependencies and run) -------------------
    // Menu items are ordered/grouped by the actual workflow via [MenuItem] priorities. Unity sorts by
    // priority and draws a separator wherever two adjacent priorities differ by >10, so the gaps below
    // are deliberate. The full import + wiring lives in VRC (VRC's import-all drives LevelImporter.Import then
    // the platform wiring pass.Wire); the Setup steps live in VRC too (the platform Setup-All, the surface-audio setup, ...). They use
    // priorities in this same scheme so they slot into the right place in the OpenSlope menu.
    //   0    full import          - VRC's import-all: Load/Map… (pick a folder; do everything, upload-ready)
    //   20   Setup All            - runs every post-import step at once
    //   21-  Setup/*              - the post-import steps individually (Bake & Apply Probes, Surface Audio,
    //                               Music Director, Player Flight, Start Gate Boards)
    //   60-  Refresh/*             - re-run ONE subsystem in a loaded map (Skybox/Particles/Audio/Triggers/Course
    //                                Path/Render Preview); all are already run by the full import - this just skips
    //                                rebuilding everything else.
    // Items that need an imported level have a validate fn (the `true` overload) so they grey out until
    // a loaded map (OpenSlope_Map) exists, instead of erroring at click time. Refresh/Skybox bakes a cubemap
    // asset and needs no loaded map.
    public static class LevelImporterMenu
    {
        [MenuItem("OpenSlope/Setup/Bake & Apply Probes", false, 210)]
        public static void BakeAndApplyProbes()
        {
            var cfg = ImportConfig.Current();
            new ProbeBuilder(cfg, new InstanceLighting(cfg)).BakeAndApply();
        }
        [MenuItem("OpenSlope/Setup/Bake & Apply Probes", true)]
        static bool BakeAndApplyProbesEnabled() => HasRoot();

        [MenuItem("OpenSlope/Refresh/Skybox", false, 320)]
        public static void ImportSkybox()
        {
            var cfg = ImportConfig.Current();
            new SkyboxBaker(cfg, cfg.ResolveShader()).Bake();
        }

        [MenuItem("OpenSlope/Refresh/Particles", false, 322)]
        public static void ImportParticles()
        {
            var cfg = ImportConfig.Current();
            var root = GameObject.Find(cfg.RootName);
            if (root == null) { Debug.LogError("OpenSlope: import a map first (OpenSlope/Load)."); return; }
            var level = root.transform.Find(cfg.LevelName) ?? root.transform;   // sub-objects live under OpenSlope_Map/Level
            var old = level.Find("Particles");
            if (old != null) Object.DestroyImmediate(old.gameObject);
            new ParticleBuilder(cfg, cfg.ResolveParticleShader()).Build(level);
            AssetDatabase.SaveAssets();
        }
        [MenuItem("OpenSlope/Refresh/Particles", true)]
        static bool ImportParticlesEnabled() => HasRoot();

        // Neutral audio rebuild entry point. Platform menus call this and then realize any emitted markers with their
        // own wiring pass (the crowd proximity gate now makes that final step necessary).
        public static void ImportAudio()
        {
            var cfg = ImportConfig.Current();
            var root = GameObject.Find(cfg.RootName);
            if (root == null) { Debug.LogError("OpenSlope: import a map first (OpenSlope/Load)."); return; }
            var level = root.transform.Find(cfg.LevelName) ?? root.transform;   // sub-objects live under OpenSlope_Map/Level
            new AudioBuilder(cfg, new CollisionBuilder(cfg)).Build(level);
            AssetDatabase.SaveAssets();
        }

        // OpenSlope/Refresh/Audio, Triggers, Boost Pads, Teleports, and Ambient Emitters live in VRC (VRC's import-all / the platform Refresh menus):
        // each rebuilds its subsystem then runs the wiring pass to realize the markers - so they can't sit in the neutral
        // importer.

        [MenuItem("OpenSlope/Tools/Render Preview", false, 702)]
        public static void RenderPreview() => new PreviewRenderer(ImportConfig.Current()).Render();
        [MenuItem("OpenSlope/Tools/Render Preview", true)]
        static bool RenderPreviewEnabled() => HasRoot();

        // True once a level has been imported (the menu items above gate on this).
        static bool HasRoot() => GameObject.Find(ImportConfig.Current().RootName) != null;
    }

    // ---- orchestrator: builds everything under one root ------------------------
    // Assembles the textured Terrain + Props (copied into the level folder) into a scene under a single
    // root, corrects the SSX->Unity orientation/scale, bakes the skybox, and renders a preview. One instance
    // per import; every service is constructed here and handed only the dependencies it needs.
    public class LevelImporter
    {
        readonly ImportConfig _cfg;

        public LevelImporter(ImportConfig cfg) { _cfg = cfg; }

        public void Import()
        {
            // Bracket the whole import: a "started" line up front and a "finished in N ms" line at the very
            // end, logged every run. The point is the log alone tells us whether an import ran to completion -
            // a "started" with no matching "finished" means it wedged (or threw) partway.
            Debug.Log("OpenSlope: import started.");
            var swAll = System.Diagnostics.Stopwatch.StartNew();

            AssetDatabase.Refresh();
            EnsureFolder(_cfg.MatFolder);

            Shader sh = _cfg.ResolveShader();
            if (sh == null) { Debug.LogError("OpenSlope: no usable shader found."); return; }

            // The importer REQUIRES the snowknife gltf - all the engine-agnostic work (terrain tessellation,
            // collision bucketing, merged-prop geometry + lighting, particle/firework/audio/probe placement, rail +
            // course polylines, per-texture alpha modes) lives in snowknife and ships in <levelFolder>/gltf/. The
            // builders below consume it, with no recompute-it-here fallback. Fail loud and early with the
            // exact command, instead of each builder erroring separately. (Snowknife docs/034)
            var bundle = new BundleManifestReader(_cfg);
            if (!bundle.Exists)
            {
                Debug.LogError($"OpenSlope: no snowknife gltf at {_cfg.LevelFolder}/gltf/manifest.json - the importer requires it. " +
                               $"Run `snowknife gltf {_cfg.LevelFolder} {Path.GetFileName(_cfg.LevelFolder)}` after exporting the level, then re-import.");
                return;
            }

            // P1 Effects.json is a portable source artifact shared with Slopesmith and Snowknife. Validate it
            // before changing the scene; P3 will compile its supported nodes into Unity objects.
            var effectsDocument = new EffectsDocumentReader(_cfg);
            if (effectsDocument.Exists)
            {
                try
                {
                    var summary = effectsDocument.Load();
                    Debug.Log($"OpenSlope: Effects.json v1 imported ({summary.Graphs} graphs, {summary.Functions} functions, " +
                              $"{summary.Nodes} nodes, {summary.Instances} instance bindings).");
                }
                catch (System.Exception ex)
                {
                    Debug.LogError("OpenSlope: invalid Effects.json: " + ex.Message);
                    return;
                }
            }

            // Wire up the services (Materials loads its JSON tables in its constructor).
            var alpha     = new AlphaClassifier(_cfg);
            var materials = new MaterialFactory(_cfg, sh, alpha);
            var lighting  = new InstanceLighting(_cfg);
            var collision = new CollisionBuilder(_cfg);
            var terrain   = new TerrainBuilder(_cfg, materials);
            var props     = new PropBuilder(_cfg, materials, collision);
            var particles = new ParticleBuilder(_cfg, _cfg.ResolveParticleShader());
            var triggers  = new TriggerBuilder(_cfg);
            var emitters  = new EmitterBuilder(_cfg);
            var ambient   = new AmbientEmitterBuilder(_cfg);
            var lampGlows = new LightGlowBuilder(_cfg);
            var boostPads = new BoostPadBuilder(_cfg);
            var volumes   = new VolumeBuilder(_cfg);
            var movers    = new SplineMoverBuilder(_cfg);
            var teleports = new TeleportBuilder(_cfg);
            var hudMessages = new HudMessageBuilder(_cfg);
            var rails     = new RailBuilder(_cfg);
            var railGates = new RailGateBuilder(_cfg);
            var course    = new CoursePathBuilder(_cfg);
            var gems      = new GemBuilder(_cfg, materials);
            var screens   = new BillboardScreenBuilder(_cfg);
            var audio     = new AudioBuilder(_cfg, collision);
            var probes    = new ProbeBuilder(_cfg, lighting);
            var skybox    = new SkyboxBaker(_cfg, sh);
            var preview   = new PreviewRenderer(_cfg);

            var old = GameObject.Find(_cfg.RootName);
            if (old != null) Object.DestroyImmediate(old);

            // The neutral library root (the platform map helper): OpenSlope_Map at identity @ origin, so the board/gate/anchors can be its
            // direct children. The scaled/rotated SSX geometry goes under a `Level` CHILD that carries the -90X / 0.01
            // transform; the board-facing subsystems (Collision/Rails/CoursePath/Foliage) + Locations are re-exposed at
            // the OpenSlope_Map top after the build (ExposeLibraryAnchors), so every map exposes the same anchor paths.
            var root = new GameObject(_cfg.RootName);             // OpenSlope_Map: identity @ origin
            StampMapIdentity(root);
            var level = new GameObject(_cfg.LevelName);           // OpenSlope_Map/Level: holds the SSX-oriented level geometry
            level.transform.SetParent(root.transform, false);
            level.transform.localEulerAngles = _cfg.RootEuler;
            level.transform.localScale = Vector3.one * _cfg.WorldScale;

            // Terrain: loaded from gltf/terrain.glb (snowknife did the Bezier tessellation, analytic normals,
            // lightmap atlas + UV1, welded vertex colours, and per-SurfaceType collision split).
            terrain.Build(level.transform);

            // Animated flipbook prop textures (crowd, signs, start gate): PropBuilder fills this accumulator as it
            // resolves animated material slots, flattened into the parallel arrays the flipbook marker carries. We tag
            // the Flipbooks object AFTER the build, only if anything animates (see below).
            var flipAccum = new FlipbookAccum();

            // Props: the merged static mesh is loaded from props.glb; the diverted gems / physics bodies / breakable
            // logos are pulled out of the Props.obj parse and Udon-wired here (they need their own GameObjects).
            props.Build(level.transform, flipAccum);

            // Prop collision comes from the bundle (collision.glb proxies + manifest bounce buckets).
            if (_cfg.PropColliders)
            {
                collision.ImportCollision(level.transform);
                // ...and give collidable props that have NO proxy mesh (signs/billboards/jumbotrons) a bounds-box
                // collider, so the rider + walking player block on them instead of passing through (docs/009).
                collision.ImportComputedBoundsColliders(level.transform);
                // Doorway props (arch/scaffold/waterfall/stand): the decoded mode-3 body boxes (docs/037).
                collision.ImportBodyColliders(level.transform);
                // ...and give the zero-response-mass PASS-THROUGH leaf cutouts (tree/bushy leaves) a TRIGGER box each, so the board
                // can play the swish-through sound when you ride through the foliage without ever blocking on it (docs/009).
                collision.ImportFoliageSwishTriggers(level.transform);
                // Authored non-solid props may still carry a hit sound: keep them pass-through and sound once as the
                // walking player or rideable board crosses their volume.
                collision.ImportContactSoundTriggers(level.transform);
            }

            // Authored particle effects (the Fog_* clouds) -> camera-facing billboard quads under
            // Particles, using the shared fog sprite the CLI decoded into Textures/Particles/.
            particles.Build(level.transform);

            // Scripted-effect triggers (the invisible Mdl_FWTrigger volumes) -> invisible trigger
            // BoxColliders under OpenSlope_Triggers, each wired to firework ParticleSystems built at the nearby
            // Mdl_FireworkCylindar_Red launchers under OpenSlope_Fireworks. Each trigger carries the firework-trigger behaviour
            // (attached directly by TriggerBuilder) that fires the volley on the local player. (docs/011, docs/019)
            triggers.Build(level.transform);

            // Continuous SSF emitters (e.g. snow cannons' blown-snow plume, road flares, stone lanterns)
            // -> one looping ParticleSystem per emitter layer under Emitters, aimed up the prop barrel. Data-derived from
            // the persistent-effect-slot graph (manifest.Emitters), so it lights up whatever continuous pyro a level
            // authors, not by name. Sibling of the triggered fireworks above. (docs/019, [Trailmap: 180-particles-data])
            emitters.Build(level.transform);
            ambient.Build(level.transform);
            // The continuous emitters (snow cannons / flares) are built AFTER PropBuilder's range culler, so re-gather now
            // that they exist - otherwise every flare inside the frustum draws at any distance (docs/053). PropBuilder's
            // pass covered the placed props; this rebuild adds the Emitters root (idempotent - it replaces the culler).
            if (_cfg.RangeCullObjects) ObjectCullerSetup.Build(level.transform, _cfg.ObjectCullRangeQuest, _cfg.ObjectCullRangePC);
            // Lamp halos build AFTER the culler re-gather on purpose: a lit lamp is exactly what should stay visible
            // across the course at night, and the 79 static halo quads are cheap (docs/unity/045).
            lampGlows.Build(level.transform);

            // Boost pads (gold speed + red/green trick) -> invisible trigger volumes under BoostPads wired to
            // the rideable board: a speed pad runs the board's timed boost, a trick pad is cosmetic (spec 360, docs/040).
            boostPads.Build(level.transform);
            volumes.Build(level.transform);
            movers.Build(level.transform);

            // Teleports (MainType-24 portal pairs) -> an invisible trigger volume under Teleports + a
            // destination anchor at the exit pivot, carrying the teleport behaviour: crossing the volume warps the local rider to
            // the destination (walking player via TeleportTo, board rider via RespawnAt). Data-derived from the SSF
            // graph (manifest.Teleports), so it lights up whatever teleport a level authors (spec 390, docs/051).
            teleports.Build(level.transform);
            hudMessages.Build(level.transform);

            // Grind rails (style-13 splines in Splines.json) -> sampled polylines baked into one
            // rail network on OpenSlope_Rails. The visible rail/fence props already render (PropBuilder); these are the
            // separate grind centerlines the rideable board snaps onto (docs/026, docs/vrchat/017). No colliders - pure data.
            if (_cfg.BuildRails) rails.Build(level.transform);

            // Rail toggles (the MainType-25 fallen-tree rails) -> invisible trigger volumes under RailGates that
            // enable the gated (start-disabled) rails on cross, wired to the rail network just built. Runs AFTER rails
            // so it can reference the network; no-op on levels that author none (spec 350, docs/026).
            if (_cfg.BuildRails) railGates.Build(level.transform);

            // Course path for the board's out-of-bounds reset (AIP/SOP race lines -> the rail network on OpenSlope_CoursePath).
            // Built after rails so it can sit alongside OpenSlope_Rails under the root; the board auto-finds both.
            if (_cfg.BuildCoursePath) course.Build(level.transform);

            // Authored gem pickups (Slopesmith's Gems.json -> manifest.Gems): synthesised octahedron crystals under
            // Gems, each collectible + revolving via the SAME runtime as the extracted gems. No-op on extracted
            // levels (they have no manifest.Gems; their gems ride the SSF-derived spinner path in PropBuilder). Slopesmith docs/014.
            gems.Build(level.transform);

            // The catalog of video-ready billboard screens (manifest.Billboards): one disabled quad flush over
            // each board's ad face, which a platform's video setup consumes (docs/vrchat/041). Built under Level
            // so the mesh-space rectangles land through the same transform as every other bundle placement, then
            // re-exposed at the map root below - the chunker and the texture-array packer own everything under
            // Level, and neither should see a screen.
            screens.Build(level.transform);

            // Native AudioSources from decoded audio: placed crowd/environment loops plus the map-declared
            // off-board environment filler under OpenSlope_Audio.
            // Needs the built Props mesh (crowd billboards), so run
            // it after props. No Udon - stock AudioSources play in a VRChat upload as-is. (docs/015)
            audio.Build(level.transform);

            // Per-instance avatar lighting: a LightProbeGroup sampled from the same lights as the props.
            if (_cfg.BuildProbes) probes.Build(level.transform);

            // Flipbook animator: tag the Flipbooks object only if any animated slots were found. The targets reference the
            // Props mesh renderer built above, so this must run after props.Build; the platform wiring pass realizes it.
            if (flipAccum.Count > 0)
            {
                var flipGO = new GameObject("Flipbooks");
                flipGO.transform.SetParent(level.transform, false);
                var fmk = flipGO.AddComponent<FlipbookMarker>();
                {
                    fmk.Renderers   = flipAccum.Renderers.ToArray();
                    fmk.Slots       = flipAccum.Slots.ToArray();
                    fmk.Fps         = flipAccum.Fps.ToArray();
                    fmk.FrameCounts = flipAccum.FrameCounts.ToArray();
                    fmk.Frames      = flipAccum.Frames.ToArray();
                    fmk.DwellBase   = flipAccum.DwellBase.ToArray();
                    fmk.DwellFlash  = flipAccum.DwellFlash.ToArray();
                }
            }

            // Recenter the LEVEL so 0,0,0 sits at the MIDDLE of the mountain (not the summit). Done after every child is
            // built: moving Level's position translates the whole level - terrain, props, rails, gems, triggers, audio,
            // probes - in lockstep, since they're all its descendants in local space. OpenSlope_Map itself stays at the origin.
            // (docs/vrchat/027)
            RecenterRoot(level.transform);

            // P6 systems carry their world origin in the serialized Custom1 stream because their shared shader evaluates
            // the native trajectory in world space. RecenterRoot translates their transforms, so finalize every P6 origin
            // only after that translation; standalone refreshes already build against the final transform.
            int p6Origins = P6EmitterBuilder.FinalizeWorldOrigins(level.transform);
            if (p6Origins > 0) Debug.Log($"OpenSlope: finalized {p6Origins} P6 particle origin(s) after world recenter.");

            // Re-expose the board-facing subsystems + spawn anchors at the OpenSlope_Map identity TOP, so the board / flight /
            // start gate find the same standard paths whatever the loaded map is (the platform map helper convention).
            ExposeLibraryAnchors(root.transform, level.transform);

            // Analytic terrain CONTACT (approach A, docs/021): bake the level's bicubic patch control points into an
            // the terrain-patches holder holder under OpenSlope_Map/Collision and wire the boards, so the rideable board Newton-refines
            // the EXACT surface it rides instead of the faceted collider. Reads Patches.json (shipped into the project by
            // `snowknife unity` as a real importer input). Runs AFTER ExposeLibraryAnchors so
            // OpenSlope_Map/Collision is at its final identity-top path. Non-fatal: a level without Patches.json (or a not-yet-
            // bootstrapped program asset) just logs and leaves the faceted fallback - the import still completes.
            string patchResult = TerrainPatchBuilder.Bake(_cfg.RootName, _cfg.LevelFolder + "/Patches.json", _cfg.NoCollisionSurfaceType, _cfg.TerrainRes);
            if (patchResult.StartsWith("OK")) Debug.Log("OpenSlope: " + patchResult);
            else if (patchResult.StartsWith("WARN")) Debug.LogWarning("OpenSlope: analytic terrain patches baked with gaps - " + patchResult); // baked, but some triangles failed to map -> they ride the faceted collider
            else Debug.LogWarning("OpenSlope: analytic terrain patches not baked - " + patchResult);

            // Platform-specific scene finalization (the VRChat respawn floor, the world-settings warning, and pointing the
            // scene spawn at PlayerSpawn) runs in the platform wiring pass after the neutral build - it depends on the
            // platform's scene descriptor, so it can't live in the neutral importer. The neutral build leaves the
            // PlayerSpawn/GateSpawn anchors (ExposeLibraryAnchors) for that pass to read.

            // Orient the scene's realtime Directional Light to the level's own authored sun (manifest.Sun).
            new SunBuilder(_cfg).Apply();

            // The sun's god-rays - the celestial glare fan ([Trailmap: 400-rendering]). Retail authors this
            // on four course slots only, so the automatic path builds nothing elsewhere; OpenSlope/Refresh/
            // Sun God Rays forces it for an authored mountain.
            new SunGodRaysBuilder(_cfg).Build(root.transform);

            AssetDatabase.SaveAssets();
            Selection.activeGameObject = root;

            var fpsSet = new SortedSet<float>();
            foreach (var f in flipAccum.Fps) fpsSet.Add(f);
            Debug.Log($"OpenSlope: import complete. {materials.PropMaterialCount} prop materials built under {_cfg.MatFolder}. " +
                      $"{alpha.CutoutTextures.Count} alpha-cutout: {string.Join(", ", alpha.CutoutTextures)}. " +
                      $"{alpha.BlendTextures.Count} alpha-blend: {string.Join(", ", alpha.BlendTextures)}. " +
                      $"{alpha.GlowTextures.Count} glow: {string.Join(", ", alpha.GlowTextures)}. " +
                      $"{flipAccum.Count} flipbook slots @ per-effect fps {{{string.Join(", ", fpsSet)}}} " +
                      $"(signs Speed*{_cfg.FlipSpeedScale}; crowd = shader _CROWD, no flipbook slot). " +
                      $"{materials.ScrollMaterialCount} UV-scroll materials (resolved by the bundle).");

            skybox.Bake();
            preview.Render();

            Debug.Log($"OpenSlope: import finished in {swAll.ElapsedMilliseconds} ms.");
        }

        // Stamp the source folder onto the root as scene data. The guarded VRChat autotest runner trusts this component,
        // not EditorPrefs or a name convention, when deciding whether an already-loaded map may be replaced.
        void StampMapIdentity(GameObject root)
        {
            var identity = root.AddComponent<MapIdentity>();
            identity.SchemaVersion = MapIdentity.CurrentSchemaVersion;
            identity.LevelFolder = _cfg.LevelFolder.Replace('\\', '/').TrimEnd('/');

            string projectRoot = Path.GetDirectoryName(Application.dataPath);
            string planPath = Path.Combine(projectRoot, identity.LevelFolder, "autotest-plan.json");
            if (!File.Exists(planPath)) return;

            try
            {
                var plan = JObject.Parse(File.ReadAllText(planPath));
                string fixture = (string)plan["name"];
                if (string.IsNullOrWhiteSpace(fixture))
                    throw new InvalidDataException("autotest-plan.json has no non-empty 'name'.");
                identity.AutoTestPlan = true;
                identity.AutoTestFixture = fixture.Trim();
            }
            catch (System.Exception ex)
            {
                Debug.LogWarning("OpenSlope: ignored invalid autotest-plan.json while stamping map identity: " + ex.Message);
            }
        }

        // Shift the level root so the terrain's centre lands on the world origin, minimising every vertex's
        // distance from 0,0,0 (Quest precision, docs/vrchat/027). The terrain mesh AABB centre is the "middle of the
        // mountain"; with root still at position 0, transforming it gives that centre in world space, and we set
        // root.position to its negation (masked per axis). Deterministic - same terrain -> same offset every
        // import - so the matching one-time shift of the spawn point / start gate (OpenSlope/Tools/Recenter Scene
        // Objects + the recenter-aware gate menu) never has to be redone.
        void RecenterRoot(Transform root)
        {
            if (!_cfg.RecenterToOrigin) return;

            var terrain = root.Find("Terrain");
            var mf = terrain != null ? terrain.GetComponent<MeshFilter>() : null;
            if (mf == null || mf.sharedMesh == null)
            {
                Debug.LogWarning("OpenSlope: recenter skipped - no 'Terrain' mesh under the root to centre on.");
                return;
            }

            // root.position is still (0,0,0) here, so this is the terrain centre in WORLD space.
            Vector3 center = terrain.TransformPoint(mf.sharedMesh.bounds.center);
            Vector3 m = _cfg.RecenterAxisMask;
            Vector3 offset = new Vector3(-center.x * m.x, -center.y * m.y, -center.z * m.z);
            if (offset == Vector3.zero) return;

            root.position = offset;
            Debug.Log($"OpenSlope: recentered world origin to the terrain centre (offset {offset}; summit was at 0). " +
                      "Run 'OpenSlope/Tools/Recenter Scene Objects' once and re-run the start-gate menu to bring the " +
                      "spawn point + gate along.");
        }

        // Move the board-facing subsystems from the scaled Level up to the OpenSlope_Map identity TOP, rename them to the
        // the platform map helper standard names, and bake the Locations anchors there. Re-parenting with worldPositionStays:true bakes
        // each object's current WORLD transform into its new local TRS, so the colliders / rail networks stay in the exact
        // same world position (their own transform now carries the -90X/0.01/recenter); the board reads them unchanged.
        void ExposeLibraryAnchors(Transform root, Transform level)
        {
            Reparent(level, root, "TerrainCollision", MapLayout.CollisionName);
            Reparent(level, root, "Rails",        MapLayout.Rails);
            Reparent(level, root, "CoursePath",   MapLayout.CoursePath);
            Reparent(level, root, "PropsFoliage",     MapLayout.Foliage);
            // The screen catalog lives OUTSIDE Level for the same reason the collision does: everything under
            // Level belongs to the optimization passes (static chunking, texture-array packing), and a video
            // screen is neither static world geometry nor an atlas participant.
            Reparent(level, root, BillboardScreenBuilder.RootObjectName, MapLayout.Billboards);
            // The light-probe group MUST be at the identity top, NOT nested under the scaled Level: Unity's native
            // LightProbes.bakedProbes setter SIGSEGVs when the LightProbeGroup is under the nested scaled transform
            // (diagnosed from crash dumps). Flattening it here (worldPositionStays) lets Bake & Apply Probes write the
            // authored SH without crashing. Keep its name (it's not a board-facing standard path).
            Reparent(level, root, _cfg.ProbeGroupName, _cfg.ProbeGroupName);

            // Locations at the START of the run. Default: read the level's own start MARKER, falling back to the
            // course-top endpoint scan, so any level gets a spawn with no per-map coords. A pinned level uses its
            // authored override + the recenter offset (= Level.position) instead. Either way, drop it onto the
            // terrain. The start gate reads GateSpawn; the player spawns at PlayerSpawn.
            Physics.SyncTransforms();                       // the re-parented colliders just moved in the hierarchy
            Vector3 worldStart, dh;
            float maxSeatDrop;
            if (!(_cfg.SpawnFromCourse && TryDeriveCourseSpawn(level, out worldStart, out dh, out maxSeatDrop)))
            {
                worldStart = _cfg.SpawnPosOverride + level.position;
                dh = _cfg.DownhillOverride;
                maxSeatDrop = float.PositiveInfinity;
            }
            dh = Vector3.ProjectOnPlane(dh, Vector3.up);
            dh = dh.sqrMagnitude > 1e-4f ? dh.normalized : Vector3.forward;
            // Onto the SNOW, not onto whatever is overhead: the start marker can sit under a start-tunnel roof or beside
            // the gate's own bounce box, and either would catch a plain first-hit ray. Reparent() just moved the terrain
            // colliders to this name, so they're the column's authority.
            worldStart.y = GroundY(root.Find(MapLayout.CollisionName), worldStart.x, worldStart.z, worldStart.y,
                                   maxSeatDrop);
            Quaternion rot = Quaternion.LookRotation(dh, Vector3.up);
            Transform player = MakeLocation(root, MapLayout.PlayerSpawn); player.SetPositionAndRotation(worldStart, rot);
            Transform gate   = MakeLocation(root, MapLayout.GateSpawn);   gate.SetPositionAndRotation(worldStart, rot);
            // The platform wiring pass points the scene descriptor at PlayerSpawn (VRChat-specific).
        }

        // Re-parent a named child of 'parent' to 'dest' preserving world pose, renaming it. No-op if absent.
        static void Reparent(Transform parent, Transform dest, string childName, string newName)
        {
            var t = parent.Find(childName);
            if (t == null) return;
            t.SetParent(dest, worldPositionStays: true);
            t.name = newName;
        }

        // Find-or-create OpenSlope_Map/Locations/<name>.
        static Transform MakeLocation(Transform root, string name)
        {
            var locs = root.Find(MapLayout.LocationsName);
            if (locs == null) { var go = new GameObject(MapLayout.LocationsName); go.transform.SetParent(root, false); locs = go.transform; }
            var c = locs.Find(name);
            if (c == null) { var go = new GameObject(name); go.transform.SetParent(locs, false); c = go.transform; }
            return c;
        }

        // Seat 'seatY' onto the ground at (x,z). Two things have to be ignored to land on the snow.
        //
        // PROPS. A first-hit raycast takes the nearest collider overhead - the start gate's own bounce box sits ~5 m up -
        // so hits under the terrain collision root win outright. Same rule as StartGateSetup.GroundYTerrain, which the
        // post row needs for the same reason.
        //
        // CEILINGS. SSX terrain has ride-through structures ([Unity docs/037]), so "terrain" overhead is real: a start
        // tunnel's roof is snow you can ride, and the topmost terrain hit in that column is that roof, not the floor the
        // riders stand on. A drop only ever goes DOWN, so take the highest terrain surface that is not above the point we
        // were asked to place - the authored marker height is already the right floor, and this just seats it exactly.
        // Nothing at or below (the point started under all of it) falls through to the nearest terrain above, then to the
        // lowest hit of any kind, then to seatY unchanged.
        const float GroundSeatTolerance = 0.5f;   // m of slack so a point resting ON the snow still claims its own floor
        const float GroundRayLift = 60f;          // m above seatY the ray starts, to clear anything the point sits inside

        // How far the START MARKER may be seated DOWNWARD before the seat is refused and the authored height stands.
        //
        // The seat exists to place an authored point exactly on the snow, so it should only ever be a correction of a
        // metre or two. It becomes a FALL when the start area is a built PLATFORM rather than a slope: Aloha's grid
        // stands on Mdl_startAreaFloor* PROP instances suspended over the mountain, and props are deliberately ignored
        // here (the gate's own bounce box sits ~5 m up), so the column's first terrain is the hillside 685 m below and
        // the riders spawned in the middle of the map. The marker is the engine's own six-rider anchor
        // ([Trailmap: 120-objects]) and its height is already the floor, so past this budget the marker wins. Generous
        // enough for a marker authored well clear of a slope; nowhere near a fall through the world.
        const float StartMarkerSeatDrop = 25f;

        static float GroundY(Transform terrain, float x, float z, float seatY,
                             float maxDrop = float.PositiveInfinity)
        {
            var hits = Physics.RaycastAll(new Vector3(x, seatY + GroundRayLift, z), Vector3.down, 800f);
            if (hits == null || hits.Length == 0) return seatY;
            System.Array.Sort(hits, (a, b) => a.distance.CompareTo(b.distance));   // topmost first
            RaycastHit? highestTerrain = null;
            foreach (var h in hits)
            {
                if (terrain == null) break;
                bool isTerrain = false;
                for (Transform p = h.collider.transform; p != null && !isTerrain; p = p.parent) isTerrain = p == terrain;
                if (!isTerrain) continue;
                if (highestTerrain == null) highestTerrain = h;
                // The floor under the asked-for height - unless reaching it is a fall rather than a seat, in which
                // case the authored height was the floor and nothing in this column improves on it.
                if (h.point.y <= seatY + GroundSeatTolerance)
                    return seatY - h.point.y > maxDrop ? seatY : h.point.y;
            }
            if (highestTerrain != null) return highestTerrain.Value.point.y;        // all of it is above: rise to the lowest snow
            // No terrain in this column: the lowest thing there is, under the same no-falling rule.
            float lowest = hits[hits.Length - 1].point.y;
            return seatY - lowest > maxDrop ? seatY : lowest;
        }

        // Where the run STARTS. Prefer the level's own start marker; fall back to the course-top endpoint scan for a
        // level that ships no marker (an authored map, a non-SSX map). Returns false (caller falls back to the
        // override/terrain) when neither works. 'level' is the scaled+recentered Level the course points bake under -
        // manifest points are root-local mesh space, so TransformPoint yields final world space (recenter incl.).
        bool TryDeriveCourseSpawn(Transform level, out Vector3 worldStart, out Vector3 downhill,
                                  out float maxSeatDrop)
        {
            var reader = new BundleManifestReader(_cfg);
            // Only an ANCHOR carries an authored floor height worth defending; a course-path endpoint is a line
            // vertex that may legitimately hang in the air, so it still seats however far it has to.
            maxSeatDrop = StartMarkerSeatDrop;
            if (TryStartAnchorSpawn(level, reader, StartGateKey, out worldStart, out downhill)) return true;
            if (TryStartAnchorSpawn(level, reader, StartMarkerKey, out worldStart, out downhill)) return true;
            maxSeatDrop = float.PositiveInfinity;
            return TryTopEndpointSpawn(level, reader, out worldStart, out downhill);
        }

        // The engine's own start anchor. Every Tricky course carries a placeholder instance named
        // `Mdl_StageArea_Start_0`; the engine hard-codes that string, hashes it at runtime and transforms a fixed
        // six-rider staging formation through the instance matrix - the active AIP/SOP start-path origins do NOT place
        // the riders ([Trailmap: 120-objects, 390-pickups-and-race]). snowknife emits it as a pose-only locator.
        //
        // This exists because the top of the path network is NOT the start. The endpoint scan below assumes one
        // top-to-bottom run; on a LAP course the network is a loop whose highest point is the lift/tube exit, and the
        // grid sits far below it. Measured against the marker: Tokyo Megaplex 447 m (394 m of it vertical), Garibaldi
        // 19 m, Merqury City 11 m - so the scan is never exactly right and is catastrophic on the lap course.
        //
        // HEADING comes from the course, not the marker: the marker's quaternion is a model basis with no downhill
        // convention we can rely on, whereas the nearest course polyline gives the real travel direction (its nearest
        // point is 16-29 m from the marker on every retail level, always heading downhill).
        // Two anchors, in this order, and the ORDER is the finding.
        //
        // `Mdl_StageArea_Start_0` is the engine's six-rider grid anchor and reads like the obvious choice, but measured
        // against where the AI start paths actually put the riders it is 16-71 m away and up to 16 m out vertically.
        // The GATE is not: it sits 2.6-2.7 m from the grid on six of the seven single-gate retail courses - the same
        // number every time, because it is the authored offset of the grid behind the arch. So the gate is the anchor
        // and the marker is the fallback for the levels that have no gate, which is every authored/test map (they carry
        // the marker and no gate at all).
        const string StartGateKey   = "Mdl_StartGate";
        const string StartMarkerKey = "Mdl_StageArea_Start";

        static bool TryStartAnchorSpawn(Transform level, BundleManifestReader reader, string key,
                                        out Vector3 worldStart, out Vector3 downhill)
        {
            worldStart = Vector3.zero; downhill = Vector3.forward;
            var marker = reader.BestLocator(key);
            var course = reader.Course;
            if (marker == null || course == null || course.Points == null ||
                course.Start == null || course.Count == null) return false;

            // Nearest course point to the marker. Both are root-local mesh space in the manifest, so this runs in the
            // level's own frame and only the result is transformed out.
            float best = float.MaxValue;
            Vector3 dirLocal = Vector3.zero;
            for (int i = 0; i < course.Start.Length && i < course.Count.Length; i++)
            {
                int s = course.Start[i], n = course.Count[i];
                if (n < 2 || s < 0 || s + n > course.Points.Length) continue;
                for (int j = 0; j < n - 1; j++)
                {
                    float d = (course.Points[s + j] - marker.Center).sqrMagnitude;
                    if (d >= best) continue;
                    best = d; dirLocal = course.Points[s + j + 1] - course.Points[s + j];
                }
            }
            if (dirLocal.sqrMagnitude < 1e-6f) return false;

            worldStart = level.TransformPoint(marker.Center);
            downhill = level.TransformVector(dirLocal);
            Debug.Log($"OpenSlope: spawn read from the level's start anchor ({key}) at {worldStart}, " +
                      $"faced down the course line {Mathf.Sqrt(best) * level.lossyScale.x:F0} m away.");
            return true;
        }

        // Fallback for a level with no start marker: the HIGHEST endpoint across all course polylines (the top of the
        // run) in world space, faced down its own line (toward the adjacent interior point = the travel direction away
        // from the top). Only correct for a single top-to-bottom run - see TryStartMarkerSpawn.
        static bool TryTopEndpointSpawn(Transform level, BundleManifestReader reader, out Vector3 worldStart, out Vector3 downhill)
        {
            worldStart = Vector3.zero; downhill = Vector3.forward;
            var course = reader.Course;
            if (course == null || course.Points == null || course.Points.Length == 0 ||
                course.Start == null || course.Count == null) return false;

            float bestY = float.NegativeInfinity;
            Vector3 bestStart = Vector3.zero, bestNext = Vector3.zero;
            bool found = false;
            for (int i = 0; i < course.Start.Length; i++)
            {
                int s = course.Start[i], n = course.Count[i];
                if (n < 2) continue;                                    // need a neighbour to face along
                int head = s, tail = s + n - 1;
                // Both ends are candidates; the higher one is nearer the mountain top. Pair each with its interior neighbour.
                ConsiderEndpoint(level, course.Points[head], course.Points[head + 1], ref bestY, ref bestStart, ref bestNext, ref found);
                ConsiderEndpoint(level, course.Points[tail], course.Points[tail - 1], ref bestY, ref bestStart, ref bestNext, ref found);
            }
            if (!found) return false;

            Vector3 dh = bestNext - bestStart;                          // from the top endpoint INTO the course = downhill
            if (Vector3.ProjectOnPlane(dh, Vector3.up).sqrMagnitude < 1e-6f) return false;  // straight-down line: no heading
            worldStart = bestStart; downhill = dh;
            Debug.Log($"OpenSlope: no start marker in this bundle - spawn derived from the course path's top endpoint at " +
                      $"{bestStart}, facing {Vector3.ProjectOnPlane(dh, Vector3.up).normalized}. Correct only for a " +
                      "single top-to-bottom run; re-extract an SSX level to pick up its Mdl_StageArea_Start_0 marker.");
            return true;
        }

        // Transform a course endpoint (+ its adjacent interior point) to world space; keep it if it's the highest yet.
        static void ConsiderEndpoint(Transform level, Vector3 endLocal, Vector3 interiorLocal,
                                     ref float bestY, ref Vector3 bestStart, ref Vector3 bestNext, ref bool found)
        {
            Vector3 endW = level.TransformPoint(endLocal);
            if (endW.y <= bestY) return;
            bestY = endW.y; bestStart = endW; bestNext = level.TransformPoint(interiorLocal); found = true;
        }

        static void EnsureFolder(string assetFolder)
        {
            if (AssetDatabase.IsValidFolder(assetFolder)) return;
            string parent = Path.GetDirectoryName(assetFolder).Replace('\\', '/');
            string leaf = Path.GetFileName(assetFolder);
            if (!AssetDatabase.IsValidFolder(parent)) EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, leaf);
        }
    }
}
#endif
