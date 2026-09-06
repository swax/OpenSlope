#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;
// Unity 6 renamed the physics collision material + Rigidbody drag APIs. These aliases keep the SAME source compiling
// on both the VRChat project (Unity 2022.3: PhysicMaterial / rb.drag) and the Basis project (Unity 6: PhysicsMaterial
// / rb.linearDamping) with no editor API-updater prompt. The rb.drag pair is guarded inline at its use site below.
#if UNITY_6000_0_OR_NEWER
using PhysMat = UnityEngine.PhysicsMaterial;
using PhysMatCombine = UnityEngine.PhysicsMaterialCombine;
#else
using PhysMat = UnityEngine.PhysicMaterial;
using PhysMatCombine = UnityEngine.PhysicMaterialCombine;
#endif

namespace OpenSlope.Importer
{

    // Build of the placed-object (prop) meshes from the snowknife gltf (props.glb + manifest), see Snowknife docs/034.
    // snowknife parses Props.obj, classifies instances, and computes per-instance lighting ONCE and bakes the
    // result into the bundle (mirroring that classification here would be a drift hazard); PropBuilder is a
    // pure consumer:
    //
    //   - the MERGED STATIC render mesh (submesh per material, per-instance lighting baked into vertex colour +
    //     outward normals) is the props.glb "Props" node, loaded straight into one GameObject (MeshFromNode).
    //   - the DIVERTED instances (spinning gems / knock-and-tumble physics bodies / breakable LCD logos) each
    //     come as their own props.glb "Divert_{index}" node + a manifest record (kind/role/cluster/pivot/lighting/
    //     physics). PropBuilder reads the records, builds each instance's mesh from its node (MeshFromDivert -
    //     recentres spinners/physics on the recorded pivot, fills the lighting the record carries), and gives it
    //     the GameObjects + Udon + colliders the engine needs (it's the GameObjects/Udon that keep these
    //     engine-side; the geometry + classification + lighting are the bundle's).
    //
    // Invisible volumes (Visable=false trigger/reset/phantom boxes) are already excluded from props.glb by
    // snowknife, so nothing draws walls the engine never shows. Collision comes from the separate bundle path
    // (CollisionBuilder). See docs/unity/003-props.md, docs/unity/010-object-lighting.md, docs/012-spinning-pickups.md,
    // docs/016-physics-props.md and docs/028-breakable-signs.md.
    public class PropBuilder
    {
        readonly ImportConfig _cfg;
        readonly MaterialFactory _materials;
        readonly CollisionBuilder _collision;
        // The shared native-emitter builder (docs/019). Every prop that flashes on a hit - a gem's collect sparkle, a
        // balloon's pop - renders its OWN authored MainType-2 layers through this, exactly like the boost pads,
        // fireworks and ambient bursts. The hand-tuned bursts remain only as fallbacks for bundles carrying no layers.
        readonly P6EmitterBuilder _p6;

        public PropBuilder(ImportConfig cfg, MaterialFactory materials, CollisionBuilder collision)
        {
            _cfg = cfg; _materials = materials; _collision = collision;
            _p6 = new P6EmitterBuilder(cfg);
        }

        // A diverted instance, fully built from its bundle node + record: the recentred mesh, its per-submesh
        // materials, and the local position (the recorded pivot) the GameObject sits at.
        struct PropLightData
        {
            public Color Ambient, Key1, Key2, Key3;
            public Vector3 Direction1, Direction2, Direction3; // Unity-world TOWARD-light directions
        }

        class SpinnerInst { public int Index; public int ModeMask = 2; public string Model; public Mesh Mesh; public Material[] Mats; public Vector3 Center;
                            // GPU-instanced (a shared model mesh): its localRotation + exact per-instance light payload.
                            public bool Instanced; public Quaternion Rotation = Quaternion.identity; public PropLightData Lighting;
                            // The gem's own authored collect burst (2 MainType-2 layers, per-instance origins). Null on a
                            // bundle baked before gems carried layers - AttachGemPickup then falls back to BuildGemSparkle.
                            public List<BundleManifestReader.EmitterLayer> Layers; }
        class PhysicsInst { public int Index; public int ModeMask = 7; public string Model; public Mesh Mesh; public Material[] Mats; public Vector3 Center; public float Mass; public float Bounce; public int CollisonSound; public string SoundClip;
                            // GPU-instanced (a shared model mesh): its localRotation + exact per-instance light payload.
                            public bool Instanced; public Quaternion Rotation = Quaternion.identity; public PropLightData Lighting;
                            // The breakable cluster this knock body ALSO throws on the hit (docs/036 - a garbage can's trash). Null = plain body.
                            public string SpillCluster; }
        // Breakable LCD jumbotron logo (docs/028): the intact lit screen, its pre-modelled broken twin, and the
        // scanline overlay are each their own node + record, toggled by the breakable behaviour on the break.
        // Smash is the megaplex glass panes' fourth member (docs/036 §Cracked glass): an invisible pass-through volume
        // beneath the pane whose own chain breaks the same glass. It renders nothing - only its BOUNDS matter, folded
        // into the cluster's trigger so a rider reaching the glass from underneath still breaks it.
        enum LogoRole { None, Intact, Broken, Scanline, Piece, Smash }
        class BreakInst { public int Index; public int ModeMask = 7; public string Model; public Mesh Mesh; public Material[] Mats; public string[] Slots; public Vector3 Center; public LogoRole Role; public string ClusterKey; public int CollisonSound; public string SoundClip; public float[] Throw; public float[] BurstColor;
                          // Role="intact" roll-aways (docs/036 - the globe): the sequenced break's wait + raw-slot crash.
                          public float BreakDelay; public int BreakSound = -1;
                          // Role="intact" fragile surfaces (docs/036 §Cracked glass): the impact pool, the crack's own
                          // lifetime, and the glancing-hit crack's raw slot. CrackStrength 0 = an ordinary instant break.
                          public float CrackStrength; public float CrackLifetime; public int CrackSound = -1;
                          // Role="intact" only: the prop's OWN authored pop emitters (a balloon animal's 2 layers off its
                          // DeadNodeMode-4 collision header). Null = pre-layers bundle; BurstColor then drives the fallback.
                          public List<BundleManifestReader.EmitterLayer> Layers; }

        // A ride-over button (docs/008): its own renderer, the volumes whose crossing pulses its material, and the
        // replayed pulse. Slots names the submeshes so the build can find which one carries the state frames.
        class ButtonInst { public int Index; public int ModeMask = 7; public string Model; public Mesh Mesh; public Material[] Mats; public string[] Slots;
                           public Vector3 Center; public List<BundleManifestReader.AnimTriggerBox> Triggers;
                           public List<int> PulseFrames; public List<float> PulseHolds; }

        public void Build(Transform parent, FlipbookAccum flip)
        {
            bool lighting = _cfg.PropLighting;

            string glb = Path.Combine(Path.GetDirectoryName(Application.dataPath), _cfg.LevelFolder + "/gltf/props.glb");
            if (!File.Exists(glb)) { Debug.LogError("OpenSlope: props - gltf/props.glb missing; run `snowknife gltf`."); return; }
            var nodes = GlbMeshLoader.Load(glb, _cfg.WorldScale);
            var byName = new Dictionary<string, GlbMeshLoader.Node>(StringComparer.Ordinal);
            foreach (var n in nodes) if (!byName.ContainsKey(n.Name)) byName[n.Name] = n;

            // ---- merged static mesh (the "Props" node) ----------------------------------------------------
            if (!byName.TryGetValue("Props", out var pnode) || pnode.Prims.Count == 0)
            { Debug.LogError("OpenSlope: props - gltf/props.glb has no 'Props' node; run `snowknife gltf`."); return; }
            Mesh mesh = MeshFromNode(pnode, out string[] slotKeys);

            var matsOut = new Material[slotKeys.Length];
            for (int s = 0; s < slotKeys.Length; s++)
            {
                // The crowd slot takes the shader-scheduled texture-array material (_CROWD): its cells animate
                // per-vertex off the UV1 identity MeshFromNode piped through. Everything else resolves normally.
                if (_materials.IsCrowd(slotKeys[s])) { matsOut[s] = _materials.BuildCrowd(slotKeys[s], lighting); continue; }
                _materials.Resolve(slotKeys[s], out string tex, out List<string> frames, out MaterialFactory.ScrollSpec? scroll, out _, out _);
                matsOut[s] = _materials.Build(tex, frames, scroll, propLighting: lighting);
            }

            AssetDatabase.DeleteAsset(_cfg.PropsMeshPath);
            AssetDatabase.CreateAsset(mesh, _cfg.PropsMeshPath);

            // Idempotent rebuild (the partial OpenSlope/Dev/Load Props (gltf test) path re-runs this on a live scene): replace the
            // section roots we own instead of stacking duplicates next to them.
            DestroyPrev(parent, "Props");
            DestroyPrev(parent, "Spinners");
            DestroyPrev(parent, "Physics");
            DestroyPrev(parent, "BreakableLogos");
            DestroyPrev(parent, "AnimatedProps");
            DestroyPrev(parent, "Locators");

            var go = new GameObject("Props");
            go.transform.SetParent(parent, false);
            go.AddComponent<MeshFilter>().sharedMesh = mesh;
            var r = go.AddComponent<MeshRenderer>();
            r.sharedMaterials = matsOut;

            // Draw-call batching (perf): collapse the per-texture submeshes into Texture2DArray draws. Returns the
            // old->new submesh remap so the flipbook registration below targets the right post-collapse slot.
            // Flipbook / UV-scroll submeshes are left as their own submeshes (kept), so their remap is always >= 0.
            int[] slotRemap = null; string batchInfo = "";
            if (_cfg.BatchDrawCalls)
            {
                var res = TextureArrayPacker.Collapse(r, _cfg.MatFolder + "/TexArrays", markBatchingStatic: false);
                slotRemap = res.oldToNew;
                batchInfo = $". Batched props {res.subBefore}->{res.subAfter} submeshes ({res.arraysBuilt} array(s))";
            }

            // Animated material slots -> drive _MainTex at runtime (crowd / signs / LCD), at their own fps.
            if (flip != null)
            {
                for (int s = 0; s < slotKeys.Length; s++)
                {
                    _materials.Resolve(slotKeys[s], out _, out List<string> frames, out _, out float flipFps, out Vector2? dwell);
                    if (frames == null || frames.Count < 2) continue;
                    int slot = (slotRemap != null && s < slotRemap.Length) ? slotRemap[s] : s;
                    if (slot >= 0) flip.Add(r, slot, _materials.LoadFrames(frames), flipFps, dwell);  // Add() guards >=2 frames / non-null
                }
            }

            // ---- statically merged mode-only props (docs/026) ---------------------------------------------
            // Keep both nodes in the scene: SettingsBoard switches them at runtime from the authored mode effects.
            // GateShowoffRails remains the editor preview override: on = Freeride; off/default = Showoff.
            DestroyPrev(parent, "PropsShowoff");
            DestroyPrev(parent, "PropsRace");
            string showoffMeshPath = _cfg.LevelFolder + "/PropsShowoff.mesh";
            string raceMeshPath = _cfg.LevelFolder + "/PropsRace.mesh";
            AssetDatabase.DeleteAsset(showoffMeshPath);
            AssetDatabase.DeleteAsset(raceMeshPath);
            int showoffTris = 0, raceTris = 0;
            if (byName.TryGetValue("PropsShowoff", out var snode) && snode.Prims.Count > 0)
            {
                Mesh smesh = MeshFromNode(snode, out string[] sSlots);
                var sMats = new Material[sSlots.Length];
                for (int s = 0; s < sSlots.Length; s++)
                {
                    _materials.Resolve(sSlots[s], out string tex, out List<string> frames, out MaterialFactory.ScrollSpec? scroll, out _, out _);
                    sMats[s] = _materials.Build(tex, frames, scroll, propLighting: lighting);
                }
                AssetDatabase.CreateAsset(smesh, showoffMeshPath);
                var sgo = new GameObject("PropsShowoff");
                sgo.transform.SetParent(parent, false);
                sgo.AddComponent<MeshFilter>().sharedMesh = smesh;
                var sr = sgo.AddComponent<MeshRenderer>();
                sr.sharedMaterials = sMats;
                if (_cfg.BatchDrawCalls) TextureArrayPacker.Collapse(sr, _cfg.MatFolder + "/TexArraysShowoff", markBatchingStatic: false);
                MarkMode(sgo, 2);
                showoffTris = (int)(smesh.triangles.Length / 3);
            }
            if (byName.TryGetValue("PropsRace", out var rnode) && rnode.Prims.Count > 0)
            {
                Mesh rmesh = MeshFromNode(rnode, out string[] rSlots);
                var rMats = new Material[rSlots.Length];
                for (int s = 0; s < rSlots.Length; s++)
                {
                    _materials.Resolve(rSlots[s], out string tex, out List<string> frames, out MaterialFactory.ScrollSpec? scroll, out _, out _);
                    rMats[s] = _materials.Build(tex, frames, scroll, propLighting: lighting);
                }
                AssetDatabase.CreateAsset(rmesh, raceMeshPath);
                var rgo = new GameObject("PropsRace");
                rgo.transform.SetParent(parent, false);
                rgo.AddComponent<MeshFilter>().sharedMesh = rmesh;
                var rr = rgo.AddComponent<MeshRenderer>();
                rr.sharedMaterials = rMats;
                if (_cfg.BatchDrawCalls) TextureArrayPacker.Collapse(rr, _cfg.MatFolder + "/TexArraysRace", markBatchingStatic: false);
                MarkMode(rgo, 1);
                raceTris = (int)(rmesh.triangles.Length / 3);
            }

            // ---- diverted instances (the "Divert_{index}" nodes + manifest records) ------------------------
            var reader = new BundleManifestReader(_cfg);
            var spinners = new List<SpinnerInst>();
            var physicsProps = new List<PhysicsInst>();
            var movers = new List<PhysicsInst>();   // spline-path movers (the subway; docs/053) - reuse the physics record shape
            var boostPads = new List<PhysicsInst>();   // speed/trick pad decals (docs/040) - diverted so they can pop + regrow
            var softFlags = new List<PhysicsInst>();   // soft-prop wind: flags (ripple)
            var softFences = new List<PhysicsInst>();  // soft-prop wind: fences (shimmer)
            var breakables = new List<BreakInst>();
            var buttons = new List<ButtonInst>();      // ride-over buttons (docs/008) - diverted so each latches alone
            // GPU-instanced physics: many copies SHARE a mesh without light streams; each exact seven-value record
            // rides a MaterialPropertyBlock. Cache by shared node so the model is built once.
            var sharedPhys = new Dictionary<string, (Mesh mesh, Material[] mats)>();
            int missing = 0;
            foreach (var rec in reader.Diverted)
            {
                if (!byName.TryGetValue(rec.Node, out var dnode) || dnode.Prims.Count == 0) { missing++; continue; }
                switch (rec.Kind)
                {
                    case "spinner":
                    {
                        Mesh gm; Material[] mats;
                        if (rec.Instanced)
                        {
                            // Shared model mesh + instanced exact-light material; the spinner manager reapplies each
                            // ambient/three-key/three-direction record at runtime.
                            if (!sharedPhys.TryGetValue(rec.Node, out var sh))
                            {
                                var built = MeshFromDivert(dnode, rec, lighting, directional: true, mesh, $"Spin_{rec.Node}", instanced: true);
                                sh = (built.mesh, built.mats); sharedPhys[rec.Node] = sh;
                            }
                            gm = sh.mesh; mats = sh.mats;
                        }
                        else
                        {
                            var (m, ms, _) = MeshFromDivert(dnode, rec, lighting, _cfg.PropDirLight, mesh, $"Spin_{rec.Index}");
                            gm = m; mats = ms;
                        }
                        // Spinner diverts are the native multiplier-gem set. Force the engine-side Showoff mask here
                        // too so older bundles (whose optional ModeMask defaults to 7) import with the corrected rule.
                        spinners.Add(new SpinnerInst { Index = rec.Index, ModeMask = 2, Model = rec.Model, Mesh = gm, Mats = mats, Center = rec.Center,
                                                       Instanced = rec.Instanced, Rotation = rec.Rotation, Lighting = LightData(rec),
                                                       Layers = rec.Layers });
                        break;
                    }
                    case "physics":
                    {
                        Mesh gm; Material[] mats;
                        if (rec.Instanced)
                        {
                            // Shared model mesh: build once without constant light streams; every copy
                            // reuses it and lights itself via the MaterialPropertyBlock set in BuildPhysics. Directional is
                            // forced on - the shared mesh has no baked colour, so MPB + _DIRLIGHT_INST is the only lit path.
                            if (!sharedPhys.TryGetValue(rec.Node, out var sh))
                            {
                                var built = MeshFromDivert(dnode, rec, lighting, directional: true, mesh, $"Phys_{rec.Node}", instanced: true);
                                sh = (built.mesh, built.mats); sharedPhys[rec.Node] = sh;
                            }
                            gm = sh.mesh; mats = sh.mats;
                        }
                        else
                        {
                            var (m, ms, _) = MeshFromDivert(dnode, rec, lighting, _cfg.PropDirLight, mesh, $"Phys_{rec.Index}");
                            gm = m; mats = ms;
                        }
                        physicsProps.Add(new PhysicsInst { Index = rec.Index, ModeMask = rec.ModeMask, Model = rec.Model, Mesh = gm, Mats = mats, Center = rec.Center,
                                                           Mass = MassFor(rec.DynamicMass), Bounce = BounceFor(rec.Bounce), CollisonSound = rec.Sound, SoundClip = rec.SoundClip,
                                                           Instanced = rec.Instanced, Rotation = rec.Rotation, Lighting = LightData(rec),
                                                           SpillCluster = rec.SpillCluster });
                        break;
                    }
                    case "breakable":
                    {
                        // Exact directional lighting for the intact swap and its thrown pieces. The former remains still;
                        // the latter tumbles beneath the fixed per-instance light directions just like physics props.
                        var (gm, mats, slots) = MeshFromDivert(dnode, rec, lighting, directional: true, mesh, rec.Role == "piece" ? rec.Node : $"Logo_{rec.Index}");
                        breakables.Add(new BreakInst { Index = rec.Index, ModeMask = rec.ModeMask, Model = rec.Model, Mesh = gm, Mats = mats, Slots = slots, Center = rec.Center,
                                                       Role = ParseRole(rec.Role), ClusterKey = rec.ClusterKey, CollisonSound = rec.Sound, SoundClip = rec.SoundClip, Throw = rec.Throw, BurstColor = rec.BurstColor,
                                                       BreakDelay = rec.BreakDelay, BreakSound = rec.BreakSound,
                                                       CrackStrength = rec.CrackStrength, CrackLifetime = rec.CrackLifetime, CrackSound = rec.CrackSound,
                                                       Layers = rec.Layers });
                        break;
                    }
                    case "mover":
                    {
                        var (gm, mats, _) = MeshFromDivert(dnode, rec, lighting, _cfg.PropDirLight, mesh, $"Mover_{rec.Index}");
                        movers.Add(new PhysicsInst { Index = rec.Index, ModeMask = rec.ModeMask, Model = rec.Model, Mesh = gm, Mats = mats, Center = rec.Center });
                        break;
                    }
                    case "boostpad":
                    {
                        // The speed/trick arrow decal, pulled out of the merged mesh so the pad can pop + regrow on a
                        // cross (docs/040). Flat lighting like the other decals; its UV scroll rides the material, so
                        // the arrow keeps scrolling exactly as it did inside the merge.
                        var (gm, mats, _) = MeshFromDivert(dnode, rec, lighting, _cfg.PropDirLight, mesh, $"Pad_{rec.Index}");
                        boostPads.Add(new PhysicsInst { Index = rec.Index, ModeMask = rec.ModeMask, Model = rec.Model, Mesh = gm, Mats = mats, Center = rec.Center });
                        break;
                    }
                    case "softflag":
                    case "softfence":
                    {
                        var (gm, mats, _) = MeshFromDivert(dnode, rec, lighting, _cfg.PropDirLight, mesh, $"Soft_{rec.Index}");
                        var si = new PhysicsInst { Index = rec.Index, ModeMask = rec.ModeMask, Model = rec.Model, Mesh = gm, Mats = mats, Center = rec.Center };
                        if (rec.Kind == "softflag") softFlags.Add(si); else softFences.Add(si);
                        break;
                    }
                    case "button":
                    {
                        // A ride-over button (docs/008), pulled out of the merged mesh so it can flash ALONE - retail
                        // gives its flip node a private material override table, so only the button you crossed changes.
                        // Flat lighting like the other decals; Slots carries the slot names so the build below can find
                        // which submesh holds the state frames.
                        var (gm, mats, slots) = MeshFromDivert(dnode, rec, lighting, _cfg.PropDirLight, mesh, $"Button_{rec.Index}");
                        buttons.Add(new ButtonInst { Index = rec.Index, ModeMask = rec.ModeMask, Model = rec.Model, Mesh = gm, Mats = mats, Slots = slots,
                                                     Center = rec.Center, Triggers = rec.Triggers,
                                                     PulseFrames = rec.PulseFrames, PulseHolds = rec.PulseHolds });
                        break;
                    }
                }
            }

            // ---- spinning pickups / physics bodies / breakable logos: GameObjects + Udon engine-side --------
            int spinObjs = BuildSpinners(parent, spinners, lighting);
            int physObjs = BuildPhysics(parent, mesh, physicsProps, lighting);
            int moverObjs = BuildMovers(parent, movers);
            int padObjs = BuildBoostPadDecals(parent, boostPads);
            int buttonObjs = BuildButtons(parent, buttons);
            int flagObjs = _cfg.EmitSoftBodies ? BuildSoftBodies(parent, mesh, softFlags, "Flags", _cfg.WindFlagStrength, _cfg.WindFlagSpeed, _cfg.WindFlagFreq) : 0;
            int fenceObjs = _cfg.EmitSoftBodies ? BuildSoftBodies(parent, mesh, softFences, "Fences", _cfg.WindFenceStrength, _cfg.WindFenceSpeed, _cfg.WindFenceFreq) : 0;
            // Animated BEFORE breakables: a roll-away cluster (docs/036 - the globe) renders its intact via the
            // break-owned animated prop, so BuildBreakableLogos needs the built Anim_* objects to wire against.
            int animObjs = BuildAnimated(parent, reader, byName, lighting, mesh);
            int breakObjs = BuildBreakableLogos(parent, breakables, lighting, flip);
            int locObjs = BuildLocators(parent, reader);

            // Camera-range cull of the placed objects just built (gems/balloons/crash-bags/animated props): reproduces
            // SSX's ~300 m placed-object range gather so the mountain-top view doesn't draw the whole course at once.
            // Two-tier cull (docs/unity/006): OFF widens the range instead of switching the culler off. controlFog only
            // when this level uses fog at all (a fog-disabled level keeps whatever it has); the culler then drives the fog
            // end from the active cull range at runtime.
            int culled = _cfg.RangeCullObjects
                ? ObjectCullerSetup.Build(parent, _cfg.ObjectCullRangeQuest, _cfg.ObjectCullRangePC,
                                             _cfg.ObjectCullRangeQuestOff, _cfg.ObjectCullRangePCOff,
                                             _cfg.Fog, _cfg.FogStartDistance)
                : 0;

            Debug.Log($"OpenSlope: props built from bundle - merged {mesh.vertexCount:n0} verts / {slotKeys.Length} submeshes, " +
                      $"{reader.Diverted.Count} diverted ({spinObjs} spinning, {physObjs} physics, {breakObjs} breakable-logo, {animObjs} animated, {buttonObjs} button), {locObjs} locator(s)" +
                      (showoffTris > 0 ? $", PropsShowoff {showoffTris:n0} tris" : "") +
                      (raceTris > 0 ? $", PropsRace {raceTris:n0} tris" : "") +
                      (missing > 0 ? $", {missing} record(s) with no glb node (skipped)" : "") +
                      (lighting ? "" : " (lighting OFF)") +
                      (spinObjs > 0 ? $". Spinners @ {_cfg.SpinnerDegreesPerSec} deg/s" : "") +
                      " (collision from the bundle.)" + batchInfo +
                      (culled > 0 ? $". Range-culling {culled} placed-object renderers @ {_cfg.ObjectCullRangeQuest}m Quest / {_cfg.ObjectCullRangePC}m PC." : ""));
        }

        // Stamp an authored mode-presence bitset onto a whole prop object. Disabling the GameObject deliberately
        // disables its collider/trigger and behaviour too (not just its renderer), which matters for race-only pads.
        void MarkMode(GameObject go, int modeMask)
        {
            if (go == null || modeMask == 7) return;
            var marker = go.AddComponent<ModeVisibilityMarker>();
            marker.ModeMask = modeMask;
            int previewBit = _cfg.GateShowoffRails ? 4 : 2;
            go.SetActive((modeMask & previewBit) != 0); // Freeride override or the default Showoff preview
        }

        // Load a bundle node (the merged "Props" node) into one Unity mesh: combine its per-material primitives
        // (verts / uv0 / outward normals / baked vertex colour from the glb) into a submesh each. The slot names
        // are the OBJ usemtl ids ("mat_10") = the MaterialFactory.Resolve keys.
        Mesh MeshFromNode(GlbMeshLoader.Node node, out string[] slots)
        {
            var verts = new List<Vector3>(); var uv = new List<Vector2>(); var col = new List<Color>(); var nrm = new List<Vector3>();
            var subTris = new List<int[]>(); slots = new string[node.Prims.Count]; bool anyCol = false;
            // Crowd cell identity (docs/008): the glb's TEXCOORD_1 carries (cell id, stand ordinal) on crowd
            // verts, consumed by the _CROWD shader path. Only piped through when the node actually has a
            // crowd prim, so ordinary prop meshes don't grow an all-zero UV1 channel.
            bool hasCrowd = false;
            for (int s = 0; s < node.Prims.Count; s++) if (node.Prims[s].Material == "mat_crowd") hasCrowd = true;
            var uv1 = hasCrowd ? new List<Vector2>() : null;
            for (int s = 0; s < node.Prims.Count; s++)
            {
                var p = node.Prims[s]; int b = verts.Count;
                verts.AddRange(p.Positions);
                if (p.Normals != null) nrm.AddRange(p.Normals);
                if (p.Uv0 != null) uv.AddRange(p.Uv0);
                if (uv1 != null)
                {
                    if (p.Uv1 != null) uv1.AddRange(p.Uv1);
                    else for (int i = 0; i < p.Positions.Length; i++) uv1.Add(Vector2.zero);
                }
                if (p.Colors != null) { col.AddRange(p.Colors); anyCol = true; }
                var t = new int[p.Indices.Length];
                for (int i = 0; i < t.Length; i++) t[i] = p.Indices[i] + b;
                subTris.Add(t);
                slots[s] = p.Material;
            }
            var mesh = new Mesh { name = "OpenSlope_Props", indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
            mesh.SetVertices(verts);
            if (uv.Count == verts.Count) mesh.SetUVs(0, uv);
            if (uv1 != null && uv1.Count == verts.Count) mesh.SetUVs(1, uv1);
            if (nrm.Count == verts.Count) mesh.SetNormals(nrm);
            if (anyCol && col.Count == verts.Count) mesh.colors = col.ToArray();
            mesh.subMeshCount = subTris.Count;
            for (int s = 0; s < subTris.Count; s++) mesh.SetTriangles(subTris[s], s, calculateBounds: false);
            mesh.RecalculateBounds();
            return mesh;
        }

        // Build a diverted instance's mesh from its bundle node + manifest record, saved as a sub-asset of the
        // Props mesh (so the 170-odd instance meshes persist with the scene without littering the folder). The
        // node geometry is ABSOLUTE (SSX root-local); we recentre on rec.Center (the recorded centroid for
        // spinners/physics, 0 for breakable) so the GameObject sits at the pivot and the prop turns/sits about
        // its own centre while keeping the same world position. Lighting comes from the record, applied exactly
        // by copying ambient + three keys/directions to COLOR + TEXCOORD2..7 for the shader's _DIRLIGHT N.L
        // sweep. The explicitly non-directional case gets the combined colour. Returns the mesh, its per-submesh
        // materials, and the material-slot names (for flipbook wiring).
        (Mesh mesh, Material[] mats, string[] slots) MeshFromDivert(GlbMeshLoader.Node node, BundleManifestReader.Divert rec,
                                                                    bool lighting, bool directional, Mesh container, string name, bool instanced = false)
        {
            var verts = new List<Vector3>(); var uv = new List<Vector2>(); var nrm = new List<Vector3>();
            var subTris = new List<int[]>(); var slots = new string[node.Prims.Count];
            for (int s = 0; s < node.Prims.Count; s++)
            {
                var p = node.Prims[s]; int b = verts.Count;
                verts.AddRange(p.Positions);
                if (p.Normals != null) nrm.AddRange(p.Normals);
                if (p.Uv0 != null) uv.AddRange(p.Uv0);
                var t = new int[p.Indices.Length];
                for (int i = 0; i < t.Length; i++) t[i] = p.Indices[i] + b;
                subTris.Add(t);
                slots[s] = p.Material;
            }

            // Recentre on the pivot (no-op for breakable, whose Center is 0 -> the cluster's meshes stay aligned
            // in absolute root-local space at a shared localPos 0). World position is unchanged.
            Vector3 c = rec.Center;
            if (c != Vector3.zero) for (int i = 0; i < verts.Count; i++) verts[i] -= c;

            bool dir = directional && lighting;
            var gm = new Mesh { name = name, indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
            gm.SetVertices(verts);
            if (uv.Count == verts.Count) gm.SetUVs(0, uv);
            if (nrm.Count == verts.Count) gm.SetNormals(nrm);   // outward normals already baked by snowknife
            // Instanced props leave the mesh lighting channels empty: the exact ambient + three key/direction pairs come
            // from a MaterialPropertyBlock so one shared mesh serves every copy. A non-instanced mover stores that same
            // constant payload in COLOR + TEXCOORD2..7; the shader keeps the directions in world space while normals turn.
            if (dir && !instanced)
                SetLightingStreams(gm, verts.Count, LightData(rec));
            else if (lighting && !instanced)
            {
                int vn = verts.Count;
                var cols = new List<Color>(vn);
                for (int i = 0; i < vn; i++) cols.Add(rec.Light);
                gm.SetColors(cols);
            }
            gm.subMeshCount = subTris.Count;
            for (int s = 0; s < subTris.Count; s++) gm.SetTriangles(subTris[s], s, calculateBounds: false);
            gm.RecalculateBounds();

            var mats = new Material[subTris.Count];
            for (int s = 0; s < slots.Length; s++)
            {
                _materials.Resolve(slots[s], out string tex, out List<string> frames, out MaterialFactory.ScrollSpec? scroll, out _, out _);
                mats[s] = _materials.Build(tex, frames, scroll, propLighting: lighting && !dir, directional: dir, instanced: instanced);
            }
            AssetDatabase.AddObjectToAsset(gm, container);   // sub-asset of Props.mesh
            return (gm, mats, slots);
        }

        // Bundle mesh-space (X mirrored, Z up) -> Unity world under Level(-90 X): (x,z,-y).
        static Vector3 MeshDirectionToWorld(Vector3 d)
        {
            Vector3 w = new Vector3(d.x, d.z, -d.y);
            return w.sqrMagnitude > 1e-12f ? w.normalized : Vector3.zero;
        }

        PropLightData LightData(BundleManifestReader.Divert rec)
        {
            Vector3 d1 = MeshDirectionToWorld(rec.Direction1);
            Vector3 d2 = MeshDirectionToWorld(rec.Direction2);
            Vector3 d3 = MeshDirectionToWorld(rec.Direction3);
            return new PropLightData { Ambient = rec.Ambient, Key1 = rec.Key1, Key2 = rec.Key2, Key3 = rec.Key3,
                                       Direction1 = d1, Direction2 = d2, Direction3 = d3 };
        }

        PropLightData LightData(BundleManifestReader.AnimProp rec)
        {
            Vector3 d1 = MeshDirectionToWorld(rec.Direction1);
            Vector3 d2 = MeshDirectionToWorld(rec.Direction2);
            Vector3 d3 = MeshDirectionToWorld(rec.Direction3);
            return new PropLightData { Ambient = rec.Ambient, Key1 = rec.Key1, Key2 = rec.Key2, Key3 = rec.Key3,
                                       Direction1 = d1, Direction2 = d2, Direction3 = d3 };
        }

        static void SetLightingStreams(Mesh mesh, int count, PropLightData light)
        {
            var ambient = new List<Color>(count);
            var key1 = new List<Vector3>(count); var key2 = new List<Vector3>(count); var key3 = new List<Vector3>(count);
            var dir1 = new List<Vector3>(count); var dir2 = new List<Vector3>(count); var dir3 = new List<Vector3>(count);
            Vector3 k1 = new Vector3(light.Key1.r, light.Key1.g, light.Key1.b);
            Vector3 k2 = new Vector3(light.Key2.r, light.Key2.g, light.Key2.b);
            Vector3 k3 = new Vector3(light.Key3.r, light.Key3.g, light.Key3.b);
            for (int i = 0; i < count; i++)
            {
                ambient.Add(light.Ambient);
                key1.Add(k1); key2.Add(k2); key3.Add(k3);
                dir1.Add(light.Direction1); dir2.Add(light.Direction2); dir3.Add(light.Direction3);
            }
            mesh.SetColors(ambient);
            mesh.SetUVs(2, key1); mesh.SetUVs(3, key2); mesh.SetUVs(4, key3);
            mesh.SetUVs(5, dir1); mesh.SetUVs(6, dir2); mesh.SetUVs(7, dir3);
        }

        static void SetLightingBlock(MaterialPropertyBlock block, PropLightData light)
        {
            block.SetVector("_InstAmbient", new Vector4(light.Ambient.r, light.Ambient.g, light.Ambient.b, 1f));
            block.SetVector("_InstKey1", new Vector4(light.Key1.r, light.Key1.g, light.Key1.b, 1f));
            block.SetVector("_InstKey2", new Vector4(light.Key2.r, light.Key2.g, light.Key2.b, 1f));
            block.SetVector("_InstKey3", new Vector4(light.Key3.r, light.Key3.g, light.Key3.b, 1f));
            block.SetVector("_InstDir1", new Vector4(light.Direction1.x, light.Direction1.y, light.Direction1.z, 0f));
            block.SetVector("_InstDir2", new Vector4(light.Direction2.x, light.Direction2.y, light.Direction2.z, 0f));
            block.SetVector("_InstDir3", new Vector4(light.Direction3.x, light.Direction3.y, light.Direction3.z, 0f));
        }

        // Build a GameObject per spinning instance under a Spinners root. Each carries its pre-built recentred mesh
        // (pivot = the prop's centre) + exact light record + materials; ONE spinner manager on the root then
        // revolves them all from a single Update (docs/vrchat/013).
        int BuildSpinners(Transform parent, List<SpinnerInst> spinners, bool lighting)
        {
            if (spinners.Count == 0) return 0;

            var spinRoot = new GameObject("Spinners");
            spinRoot.transform.SetParent(parent, false);

            // Gem pickups (docs/023): preload the PER-TIER chime clips + the sparkle shader/material cache ONCE, reused
            // across all gems. The gem also becomes collectible - a trigger sphere + kinematic body + the gem-pickup behaviour on
            // top of the spin. The chime isn't an SSF data slot (the gem effect has no sound node); the game
            // code picks it by multiplier (x2->116, x3->117, x5->118 in the MAIN bank zbxsfx), so we load those three. [Trailmap: 390-pickups-and-race]
            var pickupClips = new Dictionary<int, AudioClip>();
            Shader pShader = null;
            var sparkleMats = new Dictionary<string, Material>();
            if (_cfg.GemPickup)
            {
                LoadGemClip(pickupClips, 2, _cfg.GemPickupClipX2);
                LoadGemClip(pickupClips, 3, _cfg.GemPickupClipX3);
                LoadGemClip(pickupClips, 5, _cfg.GemPickupClipX5);
            }
            if (_cfg.GemPickup && _cfg.GemSparkle)
            {
                pShader = _cfg.ResolveParticleShader();
                if (pShader == null) Debug.Log("OpenSlope: no stock particle shader - gems with authored P6 layers are unaffected; any without them get no fallback sparkle.");
            }

            // One spinner manager on Spinners revolves every gem from a single Update (docs/vrchat/013); collect
            // each gem's transform + spin params here and attach the manager once after the loop, instead of a
            // per-gem spinner (79 Udon Updates -> 1). The collect behaviour stays per-gem (AttachGemPickup).
            var spinTargets = new List<Transform>();
            var spinAxes = new List<Vector3>();
            var spinDps = new List<float>();
            var spinPhase = new List<float>();
            var spinAmb = new List<Color>();   // exact per-instance light payload for GPU-instanced gems
            var spinKey1 = new List<Color>(); var spinKey2 = new List<Color>(); var spinKey3 = new List<Color>();
            var spinDir1 = new List<Vector3>(); var spinDir2 = new List<Vector3>(); var spinDir3 = new List<Vector3>();
            int made = 0, pick = 0;
            foreach (var sp in spinners)
            {
                if (sp.Mesh == null) continue;

                var sgo = new GameObject($"Spin_{sp.Index}_{sp.Model}");
                sgo.transform.SetParent(spinRoot.transform, false);
                MarkMode(sgo, sp.ModeMask);
                sgo.transform.localPosition = sp.Center;
                if (sp.Instanced) sgo.transform.localRotation = sp.Rotation;   // shared mesh: this gem's base orientation (the spinner spins on top of it)
                sgo.AddComponent<MeshFilter>().sharedMesh = sp.Mesh;
                var smr = sgo.AddComponent<MeshRenderer>();
                smr.sharedMaterials = sp.Mats;
                // Edit-time per-instance light (for the editor preview); the spinner manager re-applies it at runtime
                // (a MaterialPropertyBlock isn't serialized, so it's lost entering play/build - see SpinnerManager).
                // SetVector, NOT SetColor: SetColor would sRGB->linear-convert the raw /256 factors before the shader's
                // explicit PS2-domain modulation.
                if (sp.Instanced)
                {
                    var mpb = new MaterialPropertyBlock();
                    SetLightingBlock(mpb, sp.Lighting);
                    smr.SetPropertyBlock(mpb);
                }

                int slot = spinTargets.Count;                            // this gem's slot in the manager arrays (used by the pickup flourish)
                spinTargets.Add(sgo.transform);
                spinAxes.Add(Vector3.up);                                // revolve about world vertical (docs/unity/004)
                spinDps.Add(_cfg.SpinnerDegreesPerSec);
                spinPhase.Add((sp.Index * 137.50776f) % 360f);           // golden-angle spread so they're out of sync
                spinAmb.Add(sp.Instanced ? sp.Lighting.Ambient : Color.white); // white/zero payload is ignored for non-instanced meshes
                spinKey1.Add(sp.Instanced ? sp.Lighting.Key1 : Color.black);
                spinKey2.Add(sp.Instanced ? sp.Lighting.Key2 : Color.black);
                spinKey3.Add(sp.Instanced ? sp.Lighting.Key3 : Color.black);
                spinDir1.Add(sp.Lighting.Direction1); spinDir2.Add(sp.Lighting.Direction2); spinDir3.Add(sp.Lighting.Direction3);

                if (_cfg.GemPickup) { AttachGemPickup(sgo, sp, pickupClips, pShader, sparkleMats, spinRoot.transform); pick++; }
                made++;
            }

            if (made == 0) { UnityEngine.Object.DestroyImmediate(spinRoot); return 0; }

            // Tag the shared spin-manager root now that every gem transform exists (one Update for all gems once realized).
            var spinMk = spinRoot.AddComponent<SpinnerMarker>();
            spinMk.Targets = spinTargets.ToArray();
            spinMk.Axes = spinAxes.ToArray();
            spinMk.DegreesPerSecond = spinDps.ToArray();
            spinMk.PhaseDegrees = spinPhase.ToArray();
            spinMk.InstAmbient = spinAmb.ToArray();   // exact per-gem light the realized manager re-applies in Start
            spinMk.InstKey1 = spinKey1.ToArray(); spinMk.InstKey2 = spinKey2.ToArray(); spinMk.InstKey3 = spinKey3.ToArray();
            spinMk.InstDir1 = spinDir1.ToArray(); spinMk.InstDir2 = spinDir2.ToArray(); spinMk.InstDir3 = spinDir3.ToArray();

            if (_cfg.GemPickup)
                Debug.Log($"OpenSlope: gem pickups -> {pick} collectible gems (the gem-pickup behaviour; pop + grow-back on hit, " +
                          $"chime {pickupClips.Count}/3 tiers, sparkle {(_cfg.GemSparkle && pShader != null ? "on" : "off")}).");
            return made;
        }

        // Load one tier's pickup chime into the per-multiplier map (skipped if the path is blank; warns if missing).
        void LoadGemClip(Dictionary<int, AudioClip> into, int mult, string rel)
        {
            if (string.IsNullOrEmpty(rel)) return;
            var clip = AssetDatabase.LoadAssetAtPath<AudioClip>(_cfg.LevelFolder + "/Audio/" + rel);
            if (clip != null) into[mult] = clip;
            else Debug.LogWarning($"OpenSlope: gem x{mult} pickup clip not found '{_cfg.LevelFolder}/Audio/{rel}' - that tier " +
                                  "collects silently. Decode the MAIN bank: `snowknife bnk zbxsfx.bnk <out>/Audio/SFX`.");
        }

        // Make a spinning gem collectible: a trigger sphere + kinematic Rigidbody (so BOTH the walking player's
        // OnPlayerTriggerEnter and the riding board's RiderProbe OnTriggerEnter fire - the same dual path as the
        // physics props, docs/016) plus the gem-pickup behaviour that hides the gem + plays the chime/sparkle on contact and
        // respawns it. The gem still spins (via the spinner manager); this is the sibling collect behaviour. See docs/023.
        void AttachGemPickup(GameObject sgo, SpinnerInst sp, Dictionary<int, AudioClip> clips, Shader pShader,
                             Dictionary<string, Material> sparkleMats, Transform fxParent)
        {
            Mesh gm = sp.Mesh;
            string model = sp.Model;
            int mult = GemMultiplier(model);
            Color tier = GemTierColor(mult);
            AudioClip clip = (clips != null && clips.TryGetValue(mult, out var c)) ? c : null; // per-tier chime (116/117/118)

            // Kinematic body + trigger sphere. A SPHERE (not the mesh-bounds box the physics props use) so the gem's
            // spin never sweeps a thin plate's trigger edge in and out; radius from the mesh half-extent (in SSX units,
            // scaled to world by the root) so the catch volume tracks the icon's size. The trigger callbacks need a
            // Rigidbody on one side - the gem carries a kinematic one (no gravity, won't slide; it's just spun).
            var rb = sgo.AddComponent<Rigidbody>();
            rb.isKinematic = true;
            rb.useGravity = false;

            var sph = sgo.AddComponent<SphereCollider>();
            sph.isTrigger = true;
            sph.center = gm.bounds.center;
            float ext = Mathf.Max(gm.bounds.extents.x, Mathf.Max(gm.bounds.extents.y, gm.bounds.extents.z));
            sph.radius = ext * Mathf.Max(0.05f, _cfg.GemPickupRadiusScale);

            // The collect flash. Preferred path: the gem's OWN authored MainType-2 emitters through the shared P6
            // builder (the same one the boost pads / fireworks / ambient bursts use), parented to the Spinners root
            // rather than the gem - P6 layer origins are level-root-local, and it also keeps the burst from swirling
            // with the spinning gem. Falls back to the hand-tuned additive burst when a bundle carries no layers
            // (authored Slopesmith gems, or a bundle baked before gems carried them).
            ParticleSystem sparkle = null;
            if (_cfg.GemSparkle)
            {
                if (sp.Layers != null && sp.Layers.Count > 0)
                    sparkle = _p6.BuildGroup(fxParent, $"GemFx_{sp.Index}", sp.Layers, continuous: false, interactive: true);
                else if (pShader != null)
                    sparkle = BuildGemSparkle(sgo.transform, gm.bounds.center, tier, pShader, sparkleMats);
            }
            AudioSource src = (clip != null)
                ? _collision.AttachOneShotClip(sgo, clip, _cfg.GemPickupMinDistance, _cfg.GemPickupMaxDistance) : null;

            var gemMk = sgo.AddComponent<GemMarker>();
            gemMk.Multiplier   = mult;
            gemMk.pickupSound  = src;
            gemMk.sparkle      = sparkle;
            gemMk.minRideSpeed = _cfg.GemMinRideSpeed;
            gemMk.pickupVolume = 1f;
            // popHoldDelay / growBackDuration take the behaviour defaults; on a hit the gem pops (instant), holds, then regrows (docs/vrchat/043).
        }

        // Gem tier from the model name (Gem_TrickMultiplier_YellowX2 / _OrangeX3 / _RedX5) -> the trick multiplier it awards.
        static int GemMultiplier(string model)
        {
            if (model == null) return 2;
            if (model.IndexOf("X5", StringComparison.OrdinalIgnoreCase) >= 0 || model.IndexOf("Red", StringComparison.OrdinalIgnoreCase) >= 0) return 5;
            if (model.IndexOf("X3", StringComparison.OrdinalIgnoreCase) >= 0 || model.IndexOf("Orange", StringComparison.OrdinalIgnoreCase) >= 0) return 3;
            return 2; // YellowX2
        }

        static Color GemTierColor(int mult)
        {
            if (mult >= 5) return new Color(1f, 0.28f, 0.22f);  // red
            if (mult >= 3) return new Color(1f, 0.55f, 0.12f);  // orange
            return new Color(1f, 0.88f, 0.22f);                 // yellow
        }

        // A small additive sparkle burst at the gem, reproducing the game's real pickup effect (SSF effect 9/11/13:
        // two MainType-2 emitters, U0 = 150 sparks). Reuses the firework recipe (docs/019) but tuned tiny and tinted to
        // the gem tier. WORLD simulation space (with sizes/speeds pre-scaled to world units) so the burst flies
        // straight out instead of swirling with the spinning gem; playOnAwake off - the gem-pickup behaviour Play()s it on collect.
        ParticleSystem BuildGemSparkle(Transform parent, Vector3 center, Color tint, Shader pShader,
                                       Dictionary<string, Material> matCache)
        {
            var go = new GameObject("Sparkle");
            go.transform.SetParent(parent, false);
            go.transform.localPosition = center;       // centre of the gem (its mesh is recentred on its own pivot)

            var ps = go.AddComponent<ParticleSystem>();
            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);

            float ws = _cfg.WorldScale;                 // SSX units -> world metres (the root's scale)
            var main = ps.main;
            main.duration = 1f;
            main.loop = false;
            main.playOnAwake = false;
            main.startLifetime = Mathf.Max(0.05f, _cfg.GemSparkleLifetime);
            main.startSpeed = _cfg.GemSparkleSpeed * ws;   // pre-scaled: World sim space simulates in world metres
            main.startSize = _cfg.GemSparkleSize * ws;
            main.startColor = Color.white;                 // born white-hot; the hue comes in via colorOverLifetime
            main.gravityModifier = 0f;
            main.maxParticles = Mathf.Max(16, _cfg.GemSparkleCount * 2);
            main.simulationSpace = ParticleSystemSimulationSpace.World; // detach from the spinning gem
            main.scalingMode = ParticleSystemScalingMode.Local;          // ignore the 0.01 root scale; sizes are already world

            var emission = ps.emission;
            emission.enabled = true;
            emission.rateOverTime = 0f;
            emission.SetBursts(new[] { new ParticleSystem.Burst(0f, (short)Mathf.Clamp(_cfg.GemSparkleCount, 1, 1000)) });

            var shape = ps.shape;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Sphere;
            shape.radius = Mathf.Max(0.01f, _cfg.GemSparkleSize * ws);

            var col = ps.colorOverLifetime;
            col.enabled = true;
            var grad = new Gradient();
            grad.SetKeys(
                new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(tint, 0.4f), new GradientColorKey(tint, 1f) },
                new[] { new GradientAlphaKey(1f, 0f), new GradientAlphaKey(1f, 0.6f), new GradientAlphaKey(0f, 1f) });
            col.color = new ParticleSystem.MinMaxGradient(grad);

            var rend = go.GetComponent<ParticleSystemRenderer>();
            rend.renderMode = ParticleSystemRenderMode.Billboard;
            rend.alignment = ParticleSystemRenderSpace.View;
            rend.allowRoll = false;
            rend.sharedMaterial = GetSparkleMaterial(matCache, pShader);
            return ps;
        }

        // One shared particle material (shader + the white/tintable GemSparkleSprite) for every gem - the per-tier
        // colour comes from each system's colorOverLifetime gradient, not the material, so one asset serves all 79.
        Material GetSparkleMaterial(Dictionary<string, Material> cache, Shader pShader)
        {
            string sprite = string.IsNullOrEmpty(_cfg.GemSparkleSprite) ? "str3.png" : _cfg.GemSparkleSprite;
            if (cache.TryGetValue(sprite, out var hit)) return hit;
            string matName = "gemspark_" + Path.GetFileNameWithoutExtension(sprite) + "_add";
            // Sparkles render ADDITIVE in the game (SSF effect 9/11/13 use the additive sprite renderer; the sprite
            // path is always additive; docs/019) [Trailmap: 400-rendering]. The passed pShader is the alpha OpenSlope/Particle billboard shader,
            // which washed the burst flat - so resolve a stock additive particle shader, falling back to pShader.
            Shader sh = Shader.Find("OpenSlope/ParticleAdditive")            // URP (Basis); Legacy = Built-in RP (VRChat), absent in URP
                        ?? Shader.Find("Legacy Shaders/Particles/Additive")
                        ?? Shader.Find("Mobile/Particles/Additive")
                        ?? pShader;
            var mat = new Material(sh) { name = matName };
            var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(_cfg.LevelFolder + "/Textures/Particles/" + sprite);
            if (tex != null) mat.mainTexture = tex;
            else Debug.LogWarning("OpenSlope: gem sparkle sprite not found '" + sprite + "' - run `snowknife import` to decode PARTICLE.SSH into Textures/Particles/.");
            AssetDatabase.CreateAsset(mat, _cfg.MatFolder + "/" + matName + ".mat");
            cache[sprite] = mat;
            return mat;
        }

        // Build a GameObject per knock-and-tumble body under a Physics root. Same recentred mesh + baked light
        // colour as a spinner (docs/012), but instead of spinning it gets a Rigidbody + a SOLID BoxCollider (the
        // prop's only scenery collision - the bundle drops these from the static paths) + an inflated sibling
        // trigger as the knock sensor. We START IT KINEMATIC (PhysicsStartKinematic) so it stays put where the
        // game placed it - a plain dynamic body just slides down a steep slope on spawn, and VRChat players
        // (CharacterControllers) can't push it anyway, so "anchored until the platform hit-handler flips it
        // dynamic" is the honest interim (docs/016). The PhysicMaterial carries the instance's restitution AND
        // the configured friction, so the eventual dynamic state grips the slope without retuning. See docs/016.
        int BuildPhysics(Transform parent, Mesh container, List<PhysicsInst> props, bool lighting)
        {
            if (props.Count == 0) return 0;

            var physRoot = new GameObject("Physics");
            physRoot.transform.SetParent(parent, false);

            // One shared PhysicMaterial per distinct bounciness (friction is one config value, so it doesn't add
            // variants), saved as sub-assets of Props.mesh (like the extracted meshes) so we don't make an asset per prop.
            var bounceMats = new Dictionary<float, PhysMat>();

            int made = 0, withSound = 0;
            foreach (var pp in props)
            {
                if (pp.Mesh == null) continue;

                var pgo = new GameObject($"Phys_{pp.Index}_{pp.Model}");
                pgo.transform.SetParent(physRoot.transform, false);
                MarkMode(pgo, pp.ModeMask);
                pgo.transform.localPosition = pp.Center;
                if (pp.Instanced) pgo.transform.localRotation = pp.Rotation;   // shared mesh: this copy's orientation lives on the transform
                pgo.AddComponent<MeshFilter>().sharedMesh = pp.Mesh;
                var pmr = pgo.AddComponent<MeshRenderer>();
                pmr.sharedMaterials = pp.Mats;
                // Exact per-instance SSX record for a shared mesh, read by _DIRLIGHT_INST. SetVector preserves the raw
                // /256 factors; SetColor would apply an unwanted sRGB->linear conversion.
                if (pp.Instanced)
                {
                    var mpb = new MaterialPropertyBlock();
                    SetLightingBlock(mpb, pp.Lighting);
                    pmr.SetPropertyBlock(mpb);
                }

                // A SOLID box from the (recentred) mesh bounds is cheap and stable - enough for a tumble body.
                // Solid at rest, ALWAYS: the bundle deliberately drops these props from every static-collision path
                // (a static box would double-collide with the moving body), so this box is the prop's only scenery
                // collision - it blocks the WALKING player exactly like the pinned props around it. (The boards'
                // obstacle sweeps skip PhysicsProp/BasisPhysicsProp colliders - the game physics-routes
                // mode-3 knockables: knocked, never walling the rider.) It never flips to a trigger: a
                // trigger-at-rest body is a walk-through ghost, and going solid at the knock materialises a box
                // AROUND the rider, whose overlap resolution launches them skyward (the AirVent bug).
                var box = pgo.AddComponent<BoxCollider>();
                box.center = pp.Mesh.bounds.center;
                box.size = pp.Mesh.bounds.size;

                // The KNOCK SENSOR: a sibling trigger grown past the solid box on every side, so a walking player's
                // crossing fires the knock BEFORE the solid face blocks them. Same GameObject as the behaviour, so
                // OnPlayerTriggerEnter / the board probe's OnTriggerEnter land on it directly; the Basis poll finds
                // it as "the trigger box".
                var sensor = pgo.AddComponent<BoxCollider>();
                sensor.isTrigger = true;
                sensor.center = pp.Mesh.bounds.center;
                sensor.size = pp.Mesh.bounds.size + Vector3.one * (2f * _cfg.PhysicsKnockSensorInflate);

                if (!bounceMats.TryGetValue(pp.Bounce, out var pm))
                {
                    pm = new PhysMat($"PhysBounce_{pp.Bounce:0.00}")
                    {
                        bounciness = pp.Bounce,
                        bounceCombine = PhysMatCombine.Maximum,
                        dynamicFriction = _cfg.PhysicsFriction,
                        staticFriction = _cfg.PhysicsFriction,
                    };
                    AssetDatabase.AddObjectToAsset(pm, container);
                    bounceMats[pp.Bounce] = pm;
                }
                box.sharedMaterial = pm;

                var rb = pgo.AddComponent<Rigidbody>();
                rb.mass = pp.Mass;
    #if UNITY_6000_0_OR_NEWER
                rb.linearDamping = _cfg.PhysicsLinearDrag;
                rb.angularDamping = _cfg.PhysicsAngularDrag;
    #else
                rb.drag = _cfg.PhysicsLinearDrag;
                rb.angularDrag = _cfg.PhysicsAngularDrag;
    #endif
                rb.collisionDetectionMode = CollisionDetectionMode.ContinuousSpeculative; // small props vs terrain
                // Anchored at rest until the Udon hit-handler flips it dynamic - a plain dynamic body just slides
                // down the slope on spawn and players can't push it anyway (docs/016).
                rb.isKinematic = _cfg.PhysicsStartKinematic;

                // Carry the knock tuning to the runtime via the marker. The realized physics-prop behaviour anchors the
                // body (kinematic, set above) until the local player skis through it, then flips it dynamic and flings it
                // (docs/016). The anchor-at-start intent lives in Rigidbody.isKinematic above; the behaviour reads that itself.
                var physMk = pgo.AddComponent<PhysicsPropMarker>();
                physMk.MinPlayerSpeed  = _cfg.PhysicsMinPlayerSpeed;
                physMk.VelInherit      = _cfg.PhysicsKnockVelInherit;
                physMk.UpBias          = _cfg.PhysicsKnockUpBias;
                physMk.ReAnchor        = _cfg.PhysicsReAnchor;
                physMk.SettleSpeed     = _cfg.PhysicsSettleSpeed;
                physMk.SettleTime      = _cfg.PhysicsSettleTime;
                // GPU-instanced shared-mesh prop: the per-instance SSX light the behaviour re-applies at runtime (the
                // edit-time MaterialPropertyBlock below is only for the editor preview - it's not serialized into play/build).
                physMk.Instanced       = pp.Instanced;
                physMk.InstAmbient     = pp.Lighting.Ambient;
                physMk.InstKey1        = pp.Lighting.Key1;
                physMk.InstKey2        = pp.Lighting.Key2;
                physMk.InstKey3        = pp.Lighting.Key3;
                physMk.InstDir1        = pp.Lighting.Direction1;
                physMk.InstDir2        = pp.Lighting.Direction2;
                physMk.InstDir3        = pp.Lighting.Direction3;
                // SPILL (docs/036): this body's collision chain also throws a hidden contents twin (a garbage can's
                // trash, a mail box's letters). Park the marker under its cluster key - BuildBreakableLogos runs after
                // us and points it at the cluster GameObject once that exists, so the knock fires the throw.
                if (!string.IsNullOrEmpty(pp.SpillCluster))
                {
                    if (!_spillSources.TryGetValue(pp.SpillCluster, out var srcs))
                        _spillSources[pp.SpillCluster] = srcs = new List<PhysicsPropMarker>();
                    srcs.Add(physMk);
                }
                // Per-material impact clip (CollisonSound -> course-bank slot; docs/009). The board's obstacle sweep
                // skips these props' colliders (physics-routed, never a wall), so the board can't sound them like a
                // wall - the physics-prop behaviour plays this positional source itself on a knock. The prop has its
                // own GameObject at the real spot, so positional is correct (unlike the merged proxy buckets the
                // board plays on its own 2D source).
                if (_collision.AttachImpactSound(pgo, pp.CollisonSound, pp.SoundClip)) withSound++;
                made++;
            }

            if (made == 0) { UnityEngine.Object.DestroyImmediate(physRoot); return 0; }
            Debug.Log($"OpenSlope: physics props -> {made} knock-and-tumble bodies, {withSound} with a per-material impact " +
                      "clip (the physics-prop behaviour one-shots it on a knock).");
            return made;
        }

        // SSX spline-path movers (docs/053): the diverted mover mesh (the invisible subway TEMPLATE, force-emitted) as a
        // plain renderer at its origin. The SplineMoverBuilder attaches the spline-mover behaviour to walk it along the baked path.
        // No collider - cosmetic + kinematic, so it never blocks/knocks the rider.
        int BuildMovers(Transform parent, List<PhysicsInst> movers)
        {
            if (movers.Count == 0) return 0;
            var root = new GameObject("Movers");
            root.transform.SetParent(parent, false);
            int made = 0;
            foreach (var mv in movers)
            {
                if (mv.Mesh == null) continue;
                var go = new GameObject($"Mover_{mv.Index}_{mv.Model}");
                go.transform.SetParent(root.transform, false);
                MarkMode(go, mv.ModeMask);
                go.transform.localPosition = mv.Center;
                go.AddComponent<MeshFilter>().sharedMesh = mv.Mesh;
                go.AddComponent<MeshRenderer>().sharedMaterials = mv.Mats;
                made++;
            }
            if (made == 0) { UnityEngine.Object.DestroyImmediate(root); return 0; }
            Debug.Log($"OpenSlope: spline movers -> {made} moving prop(s) under Movers (the spline-mover behaviour walks them along the baked path).");
            return made;
        }

        // SSX speed/trick boost pad decals (docs/040): the diverted arrow as its own renderer, so BoostPad can scale it
        // to nothing on a cross and grow it back (the game never hides its pads - this is our deliberate divergence, the
        // gem pop applied to a pad). Named Pad_{index} so BoostPadBuilder can pair each one with its trigger volume. No
        // collider - the pad is a flat decal you ride over; its slope collision lives in the static bake, untouched.
        int BuildBoostPadDecals(Transform parent, List<PhysicsInst> pads)
        {
            if (pads.Count == 0) return 0;
            var root = new GameObject("BoostPadDecals");
            root.transform.SetParent(parent, false);
            int made = 0;
            foreach (var pad in pads)
            {
                if (pad.Mesh == null) continue;
                var go = new GameObject($"Pad_{pad.Index}_{pad.Model}");
                go.transform.SetParent(root.transform, false);
                MarkMode(go, pad.ModeMask);
                go.transform.localPosition = pad.Center;
                go.AddComponent<MeshFilter>().sharedMesh = pad.Mesh;
                go.AddComponent<MeshRenderer>().sharedMaterials = pad.Mats;
                made++;
            }
            if (made == 0) { UnityEngine.Object.DestroyImmediate(root); return 0; }
            Debug.Log($"OpenSlope: boost pad decals -> {made} pad(s) under BoostPadDecals (diverted out of the merged mesh so they pop + regrow).");
            return made;
        }

        // Ride-over BUTTONS (docs/008): each pulsing button as its own renderer under Buttons, plus a
        // BoxCollider(isTrigger) per volume tagged with a ButtonMarker pointing at that renderer. The wiring pass
        // realizes the marker into the runtime behaviour, which walks the button's _MainTex through the pulse snowknife
        // replayed from the engine's flip node and back. The button needs its OWN renderer because retail gives that
        // node a private material override table - only the button you crossed changes - while inside the merged mesh
        // every button on the level shares one material and would flash together.
        //
        // The boxes sit at their own world positions (mesh space under the level root), so like the animated props'
        // triggers they parent under the Buttons root, not the button. No reset knob: the pulse ends on the material's
        // own frame, which is what makes the effect self-restoring in the original too.
        int BuildButtons(Transform parent, List<ButtonInst> buttons)
        {
            if (buttons.Count == 0) return 0;
            var root = new GameObject("Buttons");
            root.transform.SetParent(parent, false);
            int made = 0, vols = 0, noFrames = 0, withPing = 0;
            foreach (var b in buttons)
            {
                if (b.Mesh == null || b.Slots == null) continue;

                // Which submesh carries the state frames. A button model draws one material in every shipped case, but
                // resolve by slot so a multi-material button still pulses the right one.
                int slot = -1; Texture2D[] frames = null;
                for (int s = 0; s < b.Slots.Length; s++)
                    if (_materials.StateFrames(b.Slots[s], out frames)) { slot = s; break; }
                if (slot < 0 || b.PulseFrames == null || b.PulseFrames.Count == 0)
                {
                    // The record says this instance pulses but carries no frames / no replayed pulse - a stale bundle.
                    noFrames++;
                    continue;
                }

                var go = new GameObject($"Button_{b.Index}_{b.Model}");
                go.transform.SetParent(root.transform, false);
                MarkMode(go, b.ModeMask);
                go.transform.localPosition = b.Center;
                go.AddComponent<MeshFilter>().sharedMesh = b.Mesh;
                var mr = go.AddComponent<MeshRenderer>();
                mr.sharedMaterials = b.Mats;
                made++;

                if (b.Triggers == null) continue;
                foreach (var tb in b.Triggers)
                {
                    var tgo = new GameObject($"ButtonTrigger_{b.Index}");
                    tgo.transform.SetParent(root.transform, false);
                    tgo.transform.localPosition = tb.Center;
                    tgo.transform.localRotation = tb.Rotation;
                    var box = tgo.AddComponent<BoxCollider>();
                    box.center = Vector3.zero;
                    box.size = tb.Size;
                    box.isTrigger = true;
                    // The crossing's ping: the VOLUME instance's CollisonSound event id (the button itself is
                    // authored silent), resolved through the same remap the static colliders use and played by the
                    // runtime behaviour on Fire - so everyone the pulse is broadcast to hears it from the pad.
                    AudioSource ping = _collision.AttachImpactSound(tgo, tb.Sound, tb.SoundClip)
                        ? tgo.GetComponent<AudioSource>() : null;
                    if (ping != null) withPing++;
                    var bmk = tgo.AddComponent<ButtonMarker>();
                    bmk.target = mr;
                    bmk.slot = slot;
                    bmk.frames = frames;
                    bmk.pulseFrames = b.PulseFrames.ToArray();
                    bmk.pulseHolds = b.PulseHolds != null ? b.PulseHolds.ToArray() : new float[0];
                    bmk.sound = ping;
                    vols++;
                }
            }
            if (made == 0) { UnityEngine.Object.DestroyImmediate(root); return 0; }
            Debug.Log($"OpenSlope: ride-over buttons -> {made} button(s), {vols} trigger volume(s) ({withPing} with a crossing " +
                      "sound) under Buttons (diverted out of the merged mesh so each flashes alone; a crossing pulses " +
                      "the material and it settles back on its own frame)." +
                      (noFrames > 0 ? $" {noFrames} record(s) had no state frames / pulse - re-export the map." : ""));
            return made;
        }

        // SSX soft-prop wind (docs/053): combine the diverted flag/fence meshes into ONE mesh per material under
        // SoftBodies/<name>, baking a per-vertex FLAP WEIGHT (0 at each instance's world base, 1 at its top) into UV0.w,
        // and render with a _WIND variant of the material so the shader sways it (flags ripple, fences shimmer) while
        // the anchored bases stay put. One draw call per distinct material - so hundreds of fences stay cheap.
        int BuildSoftBodies(Transform parent, Mesh container, List<PhysicsInst> parts, string name, float strength, float speed, float freq)
        {
            if (parts.Count == 0) return 0;

            // Group every submesh of every part by its material (bake the flap weight into each part's UV0.w first).
            var byMat = new Dictionary<Material, List<CombineInstance>>();
            foreach (var p in parts)
            {
                if (p.Mesh == null || p.Mats == null) continue;
                BakeFlapWeight(p.Mesh, p.Center, parent);
                var xf = Matrix4x4.Translate(p.Center);
                for (int sm = 0; sm < p.Mesh.subMeshCount && sm < p.Mats.Length; sm++)
                {
                    var mat = p.Mats[sm];
                    if (mat == null) continue;
                    if (!byMat.TryGetValue(mat, out var list)) { list = new List<CombineInstance>(); byMat[mat] = list; }
                    list.Add(new CombineInstance { mesh = p.Mesh, subMeshIndex = sm, transform = xf });
                }
            }
            if (byMat.Count == 0) return 0;

            // Pass 1: per material -> one merged submesh. Pass 2: stitch the per-material meshes into one multi-submesh mesh.
            var groupCombines = new List<CombineInstance>();
            var windMats = new List<Material>();
            foreach (var kv in byMat)
            {
                var gm = new Mesh { indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
                gm.CombineMeshes(kv.Value.ToArray(), true, true);   // mergeSubMeshes + useMatrices
                groupCombines.Add(new CombineInstance { mesh = gm, subMeshIndex = 0, transform = Matrix4x4.identity });
                windMats.Add(WindMaterial(kv.Key, strength, speed, freq));
            }
            var combined = new Mesh { name = "Soft_" + name, indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
            combined.CombineMeshes(groupCombines.ToArray(), false, false);
            combined.RecalculateBounds();
            AssetDatabase.AddObjectToAsset(combined, container);
            foreach (var gc in groupCombines) if (gc.mesh != null) UnityEngine.Object.DestroyImmediate(gc.mesh);

            var sbRoot = parent.Find("SoftBodies");
            if (sbRoot == null) { var g = new GameObject("SoftBodies"); g.transform.SetParent(parent, false); sbRoot = g.transform; }
            var go = new GameObject(name);
            go.transform.SetParent(sbRoot, false);
            int softMode = parts[0].ModeMask;
            for (int i = 1; i < parts.Count; i++) if (parts[i].ModeMask != softMode) { softMode = 7; break; }
            MarkMode(go, softMode);
            go.AddComponent<MeshFilter>().sharedMesh = combined;
            go.AddComponent<MeshRenderer>().sharedMaterials = windMats.ToArray();
            Debug.Log($"OpenSlope: soft-prop wind -> {name}: {parts.Count} part(s) combined into 1 mesh ({windMats.Count} wind material(s)).");
            return parts.Count;
        }

        // Per-vertex flap weight into UV0.w: 0 at the instance's world BASE, 1 at its top, so the wind shader anchors the
        // base and sways the free part. Uses WORLD Y via the level transform (the mesh-local axes are rotated by the -90X).
        void BakeFlapWeight(Mesh m, Vector3 center, Transform parent)
        {
            var verts = m.vertices;
            var uv = new List<Vector4>();
            m.GetUVs(0, uv);
            if (uv.Count != verts.Length) { uv.Clear(); for (int i = 0; i < verts.Length; i++) uv.Add(Vector4.zero); }
            float minY = float.MaxValue, maxY = float.MinValue;
            var wy = new float[verts.Length];
            for (int i = 0; i < verts.Length; i++)
            {
                float y = parent.TransformPoint(center + verts[i]).y;
                wy[i] = y; if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
            float h = Mathf.Max(0.001f, maxY - minY);
            for (int i = 0; i < verts.Length; i++) { var u = uv[i]; u.w = Mathf.Clamp01((wy[i] - minY) / h); uv[i] = u; }
            m.SetUVs(0, uv);
        }

        // A _WIND variant of a prop material (same texture / cutout / lighting), saved under MatFolder + cached per source.
        Material WindMaterial(Material src, float strength, float speed, float freq)
        {
            if (_windMats == null) _windMats = new Dictionary<Material, Material>();
            if (_windMats.TryGetValue(src, out var hit)) return hit;
            var mat = new Material(src) { name = src.name + "_wind" };
            mat.EnableKeyword("_WIND");
            mat.SetFloat("_UseWind", 1f);
            mat.SetFloat("_WindStrength", strength);
            mat.SetFloat("_WindSpeed", speed);
            mat.SetFloat("_WindFreq", freq);
            AssetDatabase.CreateAsset(mat, _cfg.MatFolder + "/" + mat.name + ".mat");
            _windMats[src] = mat;
            return mat;
        }
        Dictionary<Material, Material> _windMats;

        // Break-owned animated props built by BuildAnimated, keyed by instance index. Both kinds render through
        // their Anim_* segments: a triggered roll-away (the globe) starts its clip at the hit, while an ambient
        // break-owned prop (the Snowdream balloons) keeps free-running and must pop immediately.
        readonly Dictionary<int, (GameObject go, float clipLength, bool triggered)> _breakOwnedAnims =
            new Dictionary<int, (GameObject, float, bool)>();

        // SPILL sources (docs/036): the knock bodies whose collision chain ALSO throws a hidden contents twin, filled by
        // BuildPhysics and keyed by the breakable cluster they throw. BuildBreakableLogos (which runs after) points each
        // marker at that cluster's GameObject, so the knock fires the throw and the cluster needs no trigger of its own.
        // A cluster can have SEVERAL sources - a garbage can and its lid both spill the same trash.
        readonly Dictionary<string, List<PhysicsPropMarker>> _spillSources = new Dictionary<string, List<PhysicsPropMarker>>(StringComparer.Ordinal);

        // Build the breakable LCD jumbotron screens (docs/028). Each screen is THREE diverted instances - the intact
        // lit logo, a pre-modelled broken twin (shipped Visable=false, force-emitted by snowknife), and the scanline
        // overlay - which the original game SWAPS on collision (hide intact+scanlines, reveal broken, play the LCD
        // break sound). We group those three back into a cluster (the manifest ClusterKey), build a GameObject +
        // renderer for each (all at a shared localPos 0 so the absolute root-local meshes stay aligned), drop ONE
        // pass-through trigger box over the screen face, hang the break sound + (embellishment) a brk* shard debris
        // burst at the screen, and attach the breakable behaviour that performs the swap on contact - walking player OR
        // the riding board's RiderProbe, local-only (docs/vrchat/013). A cluster with no broken twin can't break, so its
        // renderers are left as static scenery (visually identical to the merged mesh). See docs/028-breakable-signs.md.
        int BuildBreakableLogos(Transform parent, List<BreakInst> breakables, bool lighting, FlipbookAccum flip)
        {
            if (breakables.Count == 0) return 0;

            // Group the flat list into clusters: the intact + broken twin + scanline that share a jumbotron id/colour.
            var clusters = new Dictionary<string, List<BreakInst>>(StringComparer.Ordinal);
            var order = new List<string>();
            foreach (var bk in breakables)
            {
                string key = bk.ClusterKey ?? "_";
                if (!clusters.TryGetValue(key, out var list)) { list = new List<BreakInst>(); clusters[key] = list; order.Add(key); }
                list.Add(bk);
            }

            var root = new GameObject("BreakableLogos");
            root.transform.SetParent(parent, false);

            Shader debrisShader = ResolveDebrisShader();
            var debrisMatCache = new Dictionary<string, Material>(StringComparer.Ordinal);

            int broke = 0, statics = 0, withSound = 0, withDebris = 0, spills = 0, cracked = 0, ci = 0;
            foreach (var key in order)
            {
                var list = clusters[key];

                var cgo = new GameObject("BreakLogo" + key);
                cgo.transform.SetParent(root.transform, false);

                var hideOnBreak = new List<Renderer>();   // intact logo + scanline -> the screen VANISHES on the break
                var showOnBreak = new List<Renderer>();    // the broken twin -> only revealed if BreakLogoRevealBroken (default off; it looks ~identical to intact, so the screen disappearing + shards is the real game look)
                var pieceTfs = new List<Transform>();      // thrown pieces (mesh-throw Sub20, docs/036): boards pivoted at their centroids [Trailmap: 370-world-interaction]
                var pieceRs = new List<Renderer>();
                float[] throwParams = null;                // the cluster's Sub20 params, off any piece record
                float[] burstColor = null;                 // the intact's "explode in stars" colour (balloon pop); null = shard breakable
                List<BundleManifestReader.EmitterLayer> burstLayers = null;   // the intact's OWN authored pop emitters, when the bundle carries them
                bool hasIntact = false; Bounds screenBounds = default; bool haveBounds = false;
                Texture screenTex = null;                  // the intact screen's own image (0061 logo) - the shards are fragments of THIS
                Renderer crackRenderer = null;             // the pane whose material carries the plain/cracked state frames
                int crackSlot = 0;
                Texture2D[] crackFrames = null;
                Bounds smashBounds = default; bool haveSmash = false;   // the pass-through under-volume's reach (docs/036)

                // A break-owned animation renders the intact through the Anim_* prop BuildAnimated already made,
                // so the world-space divert supplies bounds/texture only. Triggered means a true roll-away; an
                // ambient break-owned animation (the balloons) is still an immediate break.
                BreakInst intactBk = null;
                foreach (var bk in list) if (bk.Role == LogoRole.Intact) { intactBk = bk; break; }
                bool animatedIntact = intactBk != null && _breakOwnedAnims.ContainsKey(intactBk.Index);
                bool rolls = animatedIntact && _breakOwnedAnims[intactBk.Index].triggered;
                Vector3 pieceCentroidSum = Vector3.zero;   // roll-aways: the junk pieces' mean centroid = the landing spot (the crash FX anchor)

                int pieceIdx = 0;
                foreach (var bk in list)
                {
                    if (bk.Mesh == null) continue;
                    if (animatedIntact && bk.Role == LogoRole.Intact)
                    {
                        // Bounds/texture only - no GO or renderer; the Anim_* segments render (and hide/restore) it.
                        screenBounds = bk.Mesh.bounds; haveBounds = true; hasIntact = true;
                        if (bk.Mats != null && bk.Mats.Length > 0 && bk.Mats[0] != null) screenTex = bk.Mats[0].mainTexture;
                        if (bk.BurstColor != null && bk.BurstColor.Length >= 3) burstColor = bk.BurstColor;
                        if (bk.Layers != null && bk.Layers.Count > 0) burstLayers = bk.Layers;
                        continue;
                    }

                    // The SMASH volume renders nothing at all - it is an invisible pass-through slab under the glass
                    // whose only job is that touching it breaks the pane. Building it as a renderer would draw a
                    // second, offset copy of the glass; all that travels is its bounds, unioned into the cluster's
                    // one trigger below so a rider arriving from underneath still catches the break.
                    if (bk.Role == LogoRole.Smash)
                    {
                        if (!haveSmash) { smashBounds = bk.Mesh.bounds; haveSmash = true; }
                        else smashBounds.Encapsulate(bk.Mesh.bounds);
                        continue;
                    }

                    var go = new GameObject(bk.Role + (bk.Role == LogoRole.Piece ? pieceIdx.ToString() : "") + "_" + bk.Index + "_" + bk.Model);
                    go.transform.SetParent(cgo.transform, false);     // bk.Center is 0 -> meshes carry absolute root-local coords, aligned at localPos 0
                    MarkMode(go, bk.ModeMask);
                    go.transform.localPosition = bk.Center;            // ...except pieces, recentred on their own centroid so they can tumble
                    go.AddComponent<MeshFilter>().sharedMesh = bk.Mesh;
                    var r = go.AddComponent<MeshRenderer>();
                    r.sharedMaterials = bk.Mats;

                    // Animated material slots (the intact LCD logo flips 0061<->0062) -> drive _MainTex at runtime,
                    // exactly like the merged-mesh path. The slot order is the same one MeshFromDivert built the
                    // submeshes in (bk.Slots), so the submesh index lines up.
                    if (flip != null)
                    {
                        for (int si = 0; si < bk.Slots.Length; si++)
                        {
                            _materials.Resolve(bk.Slots[si], out _, out List<string> frames, out _, out float fps, out Vector2? dwell);
                            if (frames != null && frames.Count >= 2) flip.Add(r, si, _materials.LoadFrames(frames), fps, dwell);
                        }
                    }

                    if (bk.Role == LogoRole.Piece)
                    {
                        r.enabled = false;            // hidden until the break throws it
                        pieceTfs.Add(go.transform);
                        pieceRs.Add(r);
                        if (throwParams == null) throwParams = bk.Throw;
                        pieceCentroidSum += bk.Center;
                        pieceIdx++;
                    }
                    else if (bk.Role == LogoRole.Broken)
                    {
                        r.enabled = false;            // shipped hidden
                        // Reveal the broken twin on break for the GENERAL breakables (cluster "brk_*": fences/hole-covers,
                        // whose _Junk twin IS the visible broken pieces). Logos keep the config (default off) - their twin
                        // looks identical, so the screen VANISHING + shards is the real look there (docs/028, docs/036).
                        if (_cfg.BreakLogoRevealBroken || (key != null && key.StartsWith("brk_", StringComparison.Ordinal)))
                            showOnBreak.Add(r);
                    }
                    else
                    {
                        hideOnBreak.Add(r);           // intact logo + scanline, both hidden on the break (the screen vanishes)
                        // Size the trigger / position the FX + shard burst from the intact screen face; fall back to the scanline.
                        // Grab the intact screen's texture (the logo) - each shard is a fragment of it.
                        if (bk.Role == LogoRole.Intact)
                        {
                            screenBounds = bk.Mesh.bounds; haveBounds = true; hasIntact = true;
                            if (bk.Mats != null && bk.Mats.Length > 0 && bk.Mats[0] != null) screenTex = bk.Mats[0].mainTexture;
                            if (bk.BurstColor != null && bk.BurstColor.Length >= 3) burstColor = bk.BurstColor;
                            if (bk.Layers != null && bk.Layers.Count > 0) burstLayers = bk.Layers;
                            // A fragile surface LOOKS cracked before it gives way, and the effect graph deliberately
                            // carries no flip node for it: the pane's material ships a two-frame plain/cracked state
                            // list that the engine's own crack handler selects frame 1 of, per instance. That is why
                            // the pane needs its own renderer here and reads its frames the way a button does - one
                            // material serves every glass instance on the level, so painting the material itself
                            // would crack all 77 at once ([Trailmap: 410-texture-animation]).
                            if (bk.CrackStrength > 0f && bk.Slots != null)
                                for (int s = 0; s < bk.Slots.Length; s++)
                                    if (_materials.StateFrames(bk.Slots[s], out Texture2D[] frames))
                                    { crackRenderer = r; crackSlot = s; crackFrames = frames; break; }
                        }
                        else if (!haveBounds) { screenBounds = bk.Mesh.bounds; haveBounds = true; }
                    }
                }

                // SPILL cluster (docs/036): the thrown CONTENTS of a knock body - a garbage can's trash, a mail box's
                // letters. There is no intact member, because the prop you hit is a Roller BODY built by BuildPhysics:
                // it keeps rendering and topples away rather than vanishing, and it already owns the trigger the rider
                // crosses. So this cluster is the throw alone - nothing to hide, no trigger of its own, no break sound
                // (the body one-shots its own impact clip). Bounds come from the pieces, for the FX anchor only.
                bool spill = !hasIntact && pieceTfs.Count > 0 && _spillSources.ContainsKey(key);
                if (spill && !haveBounds)
                {
                    var pb = new Bounds(pieceTfs[0].localPosition, Vector3.zero);
                    for (int i = 1; i < pieceTfs.Count; i++) pb.Encapsulate(pieceTfs[i].localPosition);
                    screenBounds = pb; haveBounds = true;
                }

                // Breakable as long as there's an intact screen to vanish (the shards do the visible work); the broken
                // twin is optional. No intact screen and no spill source -> leave what we built as static scenery.
                if ((!hasIntact && !spill) || !haveBounds) { statics++; ci++; continue; }

                // Pass-through trigger over the screen face (the zero-response-mass ride-THROUGH semantics), grown on every side so
                // a fast rider reliably catches the thin panel. center/size are root-local (children sit at localPos 0).
                // A spill cluster gets none - its source body carries the trigger, and a second box over the same spot
                // would fire the throw twice on one hit.
                if (!spill)
                {
                    // A glass pane's authored smash volume sits a little behind the pane, on the far side from its
                    // solid support - the contact a rider makes reaching the glass from underneath. It fires the same
                    // break, so it folds into this one trigger rather than needing a relay of its own.
                    var triggerBounds = screenBounds;
                    if (haveSmash) triggerBounds.Encapsulate(smashBounds);
                    var box = cgo.AddComponent<BoxCollider>();
                    box.isTrigger = true;
                    box.center = triggerBounds.center;
                    box.size = triggerBounds.size + Vector3.one * (2f * _cfg.BreakLogoTriggerInflate);
                }

                // FX anchor at the screen centre (the cluster root sits at the origin, so a positional sound + the
                // debris must live at the real screen spot, not at 0,0,0).
                var fx = new GameObject("Fx");
                fx.transform.SetParent(cgo.transform, false);
                fx.transform.localPosition = screenBounds.center;

                // The LCD/glass break clip (CollisonSound 63 -> the course bank, slot 064): the intact screen carries it.
                int snd = -1;
                string sndClip = null;
                foreach (var bk in list) if (bk.Role == LogoRole.Intact && bk.CollisonSound >= 0) { snd = bk.CollisonSound; sndClip = bk.SoundClip; break; }
                if (snd < 0) foreach (var bk in list) if (bk.CollisonSound >= 0) { snd = bk.CollisonSound; sndClip = bk.SoundClip; break; }
                AudioSource breakSrc = null;
                if (!spill && _collision.AttachImpactSound(fx, snd, sndClip)) { breakSrc = fx.GetComponent<AudioSource>(); withSound++; }
                // Trigger-driven clusters (the megaplex glass panes, the city sewer walls) author the smash on the
                // chain instead: every instance is CollisonSound -1 and the break chain's own MainType-8 raw slot is
                // the sound (manifest BreakSound). A roll-away keeps it at the LANDING below, not here at the hit.
                if (breakSrc == null && !spill && !rolls && intactBk != null && intactBk.BreakSound >= 0)
                {
                    breakSrc = _collision.AttachOneShotClip(fx, LoadBankSlotClip(intactBk.BreakSound), 2f, 40f);
                    if (breakSrc != null) withSound++;
                }

                // Shard burst across the whole screen face - the visible "shatter" the swap can't show. By default each
                // shard is a FRAGMENT of the screen's own texture (the logo split into a tile grid), so the panel looks
                // like it fractured into textured chunks; falls back to the cnf glass sprite if the screen tex is missing.
                // A mesh-throw (Sub20) cluster gets none - its flying pieces ARE the visible break (the game spawns no
                // sprites there either).
                ParticleSystem debris = null;
                if (pieceTfs.Count == 0 && burstLayers != null && _cfg.BalloonBurst)
                {
                    // "Explode in stars": the balloon's OWN authored emitters off its DeadNodeMode-4 collision header
                    // (2 layers, 200 particles each), through the shared P6 path - the same builder the gems, boost
                    // pads, fireworks and ambient bursts use. Parented to the BreakableLogos root because P6 layer
                    // origins are level-root-local (docs/036).
                    debris = _p6.BuildGroup(root.transform, $"PopFx_{ci}", burstLayers, continuous: false, interactive: true);
                    if (debris != null) withDebris++;
                }
                else if (pieceTfs.Count == 0 && burstColor != null && _cfg.BalloonBurst)
                {
                    // Fallback for a bundle baked before breakables carried their layers: the hand-tuned tinted
                    // additive STAR spray, driven off the single reduced BurstColor.
                    debris = BuildBalloonBurst(fx.transform, new Color(burstColor[0], burstColor[1], burstColor[2], 1f), ci, debrisMatCache);
                    withDebris++;
                }
                else if (_cfg.BreakLogoDebris && debrisShader != null && pieceTfs.Count == 0)
                {
                    debris = BuildLogoDebris(fx.transform, screenBounds.size * _cfg.WorldScale, screenTex, ci, debrisMatCache, debrisShader);
                    withDebris++;
                }

                // Every animated intact hides through its Anim_* renderers. Only a triggered break-owned animation
                // is a roll-away with a delayed swap/reset; an ambient one keeps running behind an immediate hide.
                float rollBreakDelay = 0f; GameObject rollGo = null; AudioSource endSrc = null;
                if (animatedIntact)
                {
                    var ra = _breakOwnedAnims[intactBk.Index];
                    foreach (var mr in ra.go.GetComponentsInChildren<MeshRenderer>(true)) hideOnBreak.Add(mr);
                    if (rolls)
                    {
                        rollGo = ra.go;
                        rollBreakDelay = intactBk.BreakDelay > 0f ? intactBk.BreakDelay : ra.clipLength;
                        if (intactBk.BreakSound >= 0 && pieceTfs.Count > 0)
                        {
                            var fxEnd = new GameObject("FxLanding");
                            fxEnd.transform.SetParent(cgo.transform, false);
                            fxEnd.transform.localPosition = pieceCentroidSum / pieceTfs.Count;
                            endSrc = _collision.AttachOneShotClip(fxEnd, LoadBankSlotClip(intactBk.BreakSound), 2f, 60f);
                        }
                    }
                }

                // FRAGILE SURFACE (docs/036 §Cracked glass): the pane is worn down rather than smashed. The pool, the
                // crack's lifetime and the crack sound come straight off the intact record; the plane NORMAL is
                // measured here from the pane's own geometry, because the runtime's carried-vs-impact test is speed
                // ALONG THAT NORMAL. It has to be the real plane: a rider descending a steep course carries several
                // m/s downward while riding perfectly along a sloped pane, so a vertical-speed test reads ordinary
                // riding as a landing and smashes every pane on arrival. The pane is a flat plate, so the
                // area-weighted mean face normal IS its plane - and the plate's own bounds cannot supply it, since a
                // tilted plate's axis-aligned box is a wedge of air whose thinnest axis is not the plane.
                AudioSource crackSrc = null;
                if (intactBk != null && intactBk.CrackStrength > 0f && intactBk.CrackSound >= 0)
                {
                    // Its own anchor rather than the shared Fx one: the crack and the smash are two separate authored
                    // events that can be in flight together (the hit that empties the pool cracks and smashes at once),
                    // and one source cannot hold two clips. Same reason a roll-away's landing crash gets FxLanding.
                    var fxCrack = new GameObject("FxCrack");
                    fxCrack.transform.SetParent(cgo.transform, false);
                    fxCrack.transform.localPosition = screenBounds.center;
                    crackSrc = _collision.AttachOneShotClip(fxCrack, LoadBankSlotClip(intactBk.CrackSound), 2f, 30f);
                }

                var pieceT = pieceTfs.ToArray();
                var pieceR = pieceRs.ToArray();
                var brkMk = cgo.AddComponent<BreakableLogoMarker>();
                brkMk.clusterKey = key;
                if (intactBk != null && intactBk.CrackStrength > 0f)
                {
                    brkMk.crackStrength = intactBk.CrackStrength;
                    brkMk.crackLifetime = intactBk.CrackLifetime;
                    brkMk.crackSound    = crackSrc;
                    brkMk.crackRenderer = crackRenderer;
                    brkMk.crackSlot     = crackSlot;
                    brkMk.crackFrames   = crackFrames;
                    brkMk.crackNormal   = PlaneNormal(intactBk.Mesh);
                    cracked++;
                }
                brkMk.intactRenderers = hideOnBreak.ToArray();
                brkMk.brokenRenderers = showOnBreak.ToArray();
                brkMk.breakSound      = breakSrc;
                brkMk.debris          = debris;
                brkMk.respawn         = _cfg.BreakLogoRespawn;
                brkMk.respawnDelay    = _cfg.BreakLogoRespawnDelay;
                brkMk.minRideSpeed    = _cfg.BreakLogoMinRideSpeed;
                brkMk.breakVolume     = 1f;
                // The star-burst breakables (balloons) grow back from nothing on respawn, like the trick gems; the
                // shard breakables (logos/fences) pop back instantly. Keyed on the burst colour, so it's data-derived.
                brkMk.growBackOnRestore = burstColor != null && _cfg.BalloonGrowBack;
                brkMk.growBackDuration  = _cfg.BalloonGrowBackDuration;
                brkMk.breakDelay      = rollBreakDelay;
                brkMk.endSound        = endSrc;
                brkMk.rollAnimObject  = rollGo;
                brkMk.pieceTransforms = pieceT;
                brkMk.pieceRenderers  = pieceR;
                if (throwParams != null && throwParams.Length >= 10)
                {
                    // The SSF Sub20 mesh-throw params (docs/036): U2 duration, U3-5 authored dir (0 = impact dir),
                    // U6-8 per-axis velocity (SSX cm/s), U9 direction scale. Mesh axes (X-neg) - negate X like verts.
                    brkMk.throwDuration = Mathf.Max(0.25f, throwParams[2]);
                    brkMk.throwDir      = new Vector3(-throwParams[3], throwParams[4], throwParams[5]);
                    brkMk.throwVelScale = new Vector3(throwParams[6], throwParams[7], throwParams[8]);
                    brkMk.throwDirScale = throwParams[9];
                }
                // Point this cluster's spill sources at it (docs/036): the knock body detects the hit and fires the
                // throw, so a garbage can rolls away AND sprays its trash off one contact. Several sources can share a
                // cluster - hitting either the can or its lid spills the same trash, exactly as the chain authors it.
                if (_spillSources.TryGetValue(key, out var spillSrcs))
                {
                    foreach (var mk in spillSrcs) if (mk != null) mk.spillObject = cgo;
                    spills++;
                }
                broke++; ci++;
            }

            if (broke == 0 && statics == 0) { UnityEngine.Object.DestroyImmediate(root); return 0; }

            // Static-batch the intact, drawn logos. They don't move while intact (the break HIDES the intact renderer
            // and throws SEPARATE dynamic piece/shard twins), so they're textbook BatchingStatic candidates: logos
            // sharing a material collapse from one draw call each into ~one per material - the big prop draw-call cut
            // (a dense city map: hundreds of intact logos / ~17 materials -> ~17 batched draws). Per-object renderer toggling still
            // works inside a static batch, so the range-culler (Renderer.enabled) and the break's hide/respawn are
            // unaffected; only the disabled piece/broken twins (which translate when thrown) are left dynamic. Flipbook/
            // UV-scroll logos batch fine too - static batching fixes the MESH, the shader still animates UVs at draw.
            int batched = 0;
            foreach (var r in root.GetComponentsInChildren<MeshRenderer>(true))
                if (r != null && r.enabled)
                {
                    var f = GameObjectUtility.GetStaticEditorFlags(r.gameObject);
                    if ((f & StaticEditorFlags.BatchingStatic) == 0)
                    { GameObjectUtility.SetStaticEditorFlags(r.gameObject, f | StaticEditorFlags.BatchingStatic); batched++; }
                }

            Debug.Log($"OpenSlope: breakable props -> {broke} breakable(s) under BreakableLogos (LCD logos + SSF-classified " +
                      $"fences/hole-covers/tree-branches, docs/036): on contact the prop breaks (intact hidden, broken " +
                      $"twin revealed where it exists, else shards); {withSound} with a break sound, {withDebris} with " +
                      $"debris" +
                      (cracked > 0 ? $"; {cracked} FRAGILE surface(s) - a glass pane cracks under the rider and gives way when its impact pool runs out, rather than breaking on contact (docs/036)" : "") +
                      (spills > 0 ? $"; {spills} cluster(s) also fired by a knock body's hit - the SPILL wiring (garbage cans / news boxes / mail boxes throw their contents, docs/036)" : "") +
                      (statics > 0 ? $"; {statics} had no intact mesh -> left static" : "") +
                      $"; {batched} intact renderer(s) flagged BatchingStatic (shared-material draw-call collapse)" +
                      ". the breakable behaviour attached directly.");
            return broke;
        }

        // The shatter: a burst of shards spawned ACROSS the whole screen face that burst away and fall (docs/028). This
        // is the visible "break" - the model swap alone can't show it (SSX's broken twin looks ~identical to the intact).
        // By DEFAULT each shard is a FRAGMENT of the screen's own texture (screenTex split into a Tiles x Tiles grid via
        // the particle texture-sheet, one random static tile per shard), so the panel reads as fracturing into textured
        // chunks - the game look. Falls back to the cnf glass sprite when screenTex is null / UseScreenTexture is off.
        // Built like the gem sparkle (docs/023): WORLD sim space so shards detach from the screen, a BOX emitter the
        // size of the screen so they originate across the panel, omnidirectional burst, gravity, random tumble.
        // playOnAwake off - the breakable behaviour Play()s it on the break. boxScale = screen world extents in the local frame.
        ParticleSystem BuildLogoDebris(Transform parent, Vector3 boxScale, Texture screenTex, int idx, Dictionary<string, Material> matCache, Shader shader)
        {
            bool useScreen = _cfg.BreakLogoDebrisUseScreenTexture && screenTex != null;

            var go = new GameObject("Debris");
            go.transform.SetParent(parent, false);   // localPos 0 == the FX anchor == the screen centre

            var ps = go.AddComponent<ParticleSystem>();
            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);

            float ws = _cfg.WorldScale;               // SSX units -> world metres
            var main = ps.main;
            main.duration = 1f;
            main.loop = false;
            main.playOnAwake = false;
            main.startLifetime = Mathf.Max(0.05f, _cfg.BreakLogoDebrisLifetime);
            main.startSpeed = new ParticleSystem.MinMaxCurve(_cfg.BreakLogoDebrisSpeed * ws * 0.25f, _cfg.BreakLogoDebrisSpeed * ws);
            main.startSize = new ParticleSystem.MinMaxCurve(_cfg.BreakLogoDebrisSize * ws * 0.5f, _cfg.BreakLogoDebrisSize * ws);
            main.startColor = useScreen ? Color.white : _cfg.BreakLogoDebrisTint;  // screen chunks show true colours; glass sprites get the icy tint
            main.startRotation = new ParticleSystem.MinMaxCurve(0f, 6.2831853f);  // random initial tumble (0..2pi)
            main.gravityModifier = _cfg.BreakLogoDebrisGravity;
            main.maxParticles = Mathf.Max(16, _cfg.BreakLogoDebrisCount * 2);
            main.simulationSpace = ParticleSystemSimulationSpace.World;  // shards detach from the (vanished) screen
            main.scalingMode = ParticleSystemScalingMode.Local;          // ignore the 0.01 root scale; sizes already world

            var emission = ps.emission;
            emission.enabled = true;
            emission.rateOverTime = 0f;
            emission.SetBursts(new[] { new ParticleSystem.Burst(0f, (short)Mathf.Clamp(_cfg.BreakLogoDebrisCount, 1, 500)) });

            var shape = ps.shape;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Box;              // emit across the whole screen face...
            shape.scale = new Vector3(Mathf.Max(0.05f, Mathf.Abs(boxScale.x)),
                                      Mathf.Max(0.05f, Mathf.Abs(boxScale.y)),
                                      Mathf.Max(0.05f, Mathf.Abs(boxScale.z)));
            shape.randomDirectionAmount = 1f;                           // ...and burst the shards away omnidirectionally (the screen shattering)

            var rot = ps.rotationOverLifetime;
            rot.enabled = true;
            rot.z = new ParticleSystem.MinMaxCurve(-2.5f, 2.5f);        // keep tumbling as they fly out

            // Screen-texture fragments: split screenTex into a Tiles x Tiles grid; each shard shows ONE random static
            // tile (startFrame random across the sheet, frameOverTime held at 0 so it doesn't animate). So 16 shards
            // from a 4x4 sheet = roughly the panel broken into its 16 textured pieces.
            if (useScreen)
            {
                int tiles = Mathf.Clamp(_cfg.BreakLogoDebrisTiles, 1, 8);
                var tsa = ps.textureSheetAnimation;
                tsa.enabled = true;
                tsa.numTilesX = tiles;
                tsa.numTilesY = tiles;
                tsa.animation = ParticleSystemAnimationType.WholeSheet;
                tsa.startFrame = new ParticleSystem.MinMaxCurve(0f, tiles * tiles);   // random tile per shard
                tsa.frameOverTime = new ParticleSystem.MinMaxCurve(0f);               // hold that tile (no progression)
            }

            var col = ps.colorOverLifetime;
            col.enabled = true;
            var grad = new Gradient();
            grad.SetKeys(
                new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) },
                new[] { new GradientAlphaKey(1f, 0f), new GradientAlphaKey(1f, 0.75f), new GradientAlphaKey(0f, 1f) });
            col.color = new ParticleSystem.MinMaxGradient(grad);

            var rend = go.GetComponent<ParticleSystemRenderer>();
            rend.renderMode = ParticleSystemRenderMode.Billboard;
            rend.alignment = ParticleSystemRenderSpace.View;
            rend.allowRoll = false;                   // VR-comfort: don't roll with camera roll (the shards tumble via rotationOverLifetime)
            rend.sharedMaterial = useScreen ? GetScreenShardMaterial(matCache, screenTex, shader) : GetDebrisMaterial(matCache, idx, shader);
            return ps;
        }

        // The "explode in stars" pop: a burst of additive STAR sprites tinted to the authored emitter colour, for a
        // breakable whose SSF collision effect carries a type2Sub0 particle emitter (e.g. balloon-animal props;
        // BurstColor in the bundle). Built like the gem sparkle (docs/023) but bigger - WORLD sim space so the stars
        // fly clear of the (vanished) balloon, a sphere emitter so they spray out every way, gravity arcs them down.
        // playOnAwake off - the breakable behaviour Play()s it on the break. tint = the balloon's star colour (Gator green,
        // Kitty blue, Ian tan); the white-hot start + colorOverLifetime carry the additive glow.
        ParticleSystem BuildBalloonBurst(Transform parent, Color tint, int idx, Dictionary<string, Material> matCache)
        {
            var go = new GameObject("Debris");
            go.transform.SetParent(parent, false);   // localPos 0 == the FX anchor == the balloon centre

            var ps = go.AddComponent<ParticleSystem>();
            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);

            float ws = _cfg.WorldScale;               // SSX units -> world metres
            var main = ps.main;
            main.duration = 1f;
            main.loop = false;
            main.playOnAwake = false;
            main.startLifetime = Mathf.Max(0.05f, _cfg.BalloonBurstLifetime);
            main.startSpeed = new ParticleSystem.MinMaxCurve(_cfg.BalloonBurstSpeed * ws * 0.35f, _cfg.BalloonBurstSpeed * ws);
            main.startSize = new ParticleSystem.MinMaxCurve(_cfg.BalloonBurstSize * ws * 0.5f, _cfg.BalloonBurstSize * ws);
            main.startColor = Color.white;            // born white-hot; the hue comes in via colorOverLifetime
            main.startRotation = new ParticleSystem.MinMaxCurve(0f, 6.2831853f);   // random star orientation
            main.gravityModifier = _cfg.BalloonBurstGravity;
            main.maxParticles = Mathf.Max(16, _cfg.BalloonBurstCount * 2);
            main.simulationSpace = ParticleSystemSimulationSpace.World;  // stars detach from the popped balloon
            main.scalingMode = ParticleSystemScalingMode.Local;          // ignore the 0.01 root scale; sizes already world

            var emission = ps.emission;
            emission.enabled = true;
            emission.rateOverTime = 0f;
            emission.SetBursts(new[] { new ParticleSystem.Burst(0f, (short)Mathf.Clamp(_cfg.BalloonBurstCount, 1, 500)) });

            var shape = ps.shape;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Sphere;            // spray out in every direction
            shape.radius = Mathf.Max(0.01f, _cfg.BalloonBurstSize * ws);

            var col = ps.colorOverLifetime;
            col.enabled = true;
            var grad = new Gradient();
            grad.SetKeys(
                new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(tint, 0.35f), new GradientColorKey(tint, 1f) },
                new[] { new GradientAlphaKey(1f, 0f), new GradientAlphaKey(1f, 0.6f), new GradientAlphaKey(0f, 1f) });
            col.color = new ParticleSystem.MinMaxGradient(grad);

            var rend = go.GetComponent<ParticleSystemRenderer>();
            rend.renderMode = ParticleSystemRenderMode.Billboard;
            rend.alignment = ParticleSystemRenderSpace.View;
            rend.allowRoll = false;
            rend.sharedMaterial = GetStarBurstMaterial(matCache);
            return ps;
        }

        // One shared additive star material for every balloon pop (the per-balloon colour is each system's
        // colorOverLifetime tint, not the material). Star sprite from Textures/Particles (BalloonBurstSprite, e.g.
        // str1.png); additive to match the game's sprite renderer (docs/019). Cached + saved under MatFolder.
        Material GetStarBurstMaterial(Dictionary<string, Material> cache)
        {
            string sprite = string.IsNullOrEmpty(_cfg.BalloonBurstSprite) ? "str1.png" : _cfg.BalloonBurstSprite;
            string key = "starburst_" + sprite;
            if (cache.TryGetValue(key, out var hit)) return hit;
            string matName = "balloonburst_" + Path.GetFileNameWithoutExtension(sprite) + "_add";
            Shader sh = Shader.Find("OpenSlope/ParticleAdditive")            // URP (Basis); Legacy = Built-in RP (VRChat), absent in URP
                        ?? Shader.Find("Legacy Shaders/Particles/Additive")
                        ?? Shader.Find("Mobile/Particles/Additive")
                        ?? Shader.Find("Particles/Additive");
            var mat = sh != null ? new Material(sh) { name = matName } : null;
            if (mat != null)
            {
                var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(_cfg.LevelFolder + "/Textures/Particles/" + sprite);
                if (tex != null) mat.mainTexture = tex;
                else Debug.LogWarning("OpenSlope: balloon burst sprite not found '" + sprite + "' - run `snowknife particles` to decode PARTICLE.SSH into Textures/Particles/.");
                AssetDatabase.CreateAsset(mat, _cfg.MatFolder + "/" + matName + ".mat");
            }
            cache[key] = mat;
            return mat;
        }

        // Material for screen-texture shards: the screen's own image (screenTex), so each particle (showing a random
        // tile of it via the system's texture-sheet) is a fragment of the logo. Cached per texture (the Red jumbotron
        // uses a different screen image -> its own material), saved under MatFolder.
        Material GetScreenShardMaterial(Dictionary<string, Material> cache, Texture screenTex, Shader shader)
        {
            string texName = screenTex != null ? screenTex.name : "none";
            string key = "screen_" + texName;
            if (cache.TryGetValue(key, out var hit)) return hit;
            string matName = "brklogo_" + texName + "_shard";
            var mat = shader != null ? new Material(shader) { name = matName } : null;
            if (mat != null)
            {
                if (screenTex != null) mat.mainTexture = screenTex;
                AssetDatabase.CreateAsset(mat, _cfg.MatFolder + "/" + matName + ".mat");
            }
            cache[key] = mat;
            return mat;
        }

        // Stock particle shader for the break debris, additive or alpha-blended per config. Alpha reads as solid
        // falling glass (the default); additive makes the shards glow. Cached across all screens.
        Shader ResolveDebrisShader()
        {
            if (!_cfg.BreakLogoDebris) return null;
            return _cfg.BreakLogoDebrisAdditive
                ? (Shader.Find("OpenSlope/ParticleAdditive") ?? Shader.Find("Legacy Shaders/Particles/Additive") ?? Shader.Find("Mobile/Particles/Additive") ?? Shader.Find("Particles/Additive"))
                : (Shader.Find("OpenSlope/ParticleAlpha") ?? Shader.Find("Legacy Shaders/Particles/Alpha Blended") ?? Shader.Find("Mobile/Particles/Alpha Blended")
                   ?? Shader.Find("Particles/Alpha Blended") ?? Shader.Find("Sprites/Default"));
        }

        // Debris material for a screen, brk* sprite round-robined across BreakLogoDebrisSprites by cluster index.
        // Cached + saved under MatFolder so screens sharing a sprite share one material; blend mode baked into the name.
        Material GetDebrisMaterial(Dictionary<string, Material> cache, int idx, Shader shader)
        {
            string[] sprites = (_cfg.BreakLogoDebrisSprites != null && _cfg.BreakLogoDebrisSprites.Length > 0)
                ? _cfg.BreakLogoDebrisSprites : new[] { "brk1.png" };
            string sprite = sprites[idx % sprites.Length];
            if (cache.TryGetValue(sprite, out var hit)) return hit;

            string matName = "brklogo_" + Path.GetFileNameWithoutExtension(sprite) + (_cfg.BreakLogoDebrisAdditive ? "_add" : "_alpha");
            var mat = shader != null ? new Material(shader) { name = matName } : null;
            if (mat != null)
            {
                var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(_cfg.LevelFolder + "/Textures/Particles/" + sprite);
                if (tex != null) mat.mainTexture = tex;
                else Debug.LogWarning("OpenSlope: break debris sprite not found " + sprite + " - run `snowknife particles` to decode PARTICLE.SSH into Textures/Particles/.");
                AssetDatabase.CreateAsset(mat, _cfg.MatFolder + "/" + matName + ".mat");
            }
            cache[sprite] = mat;
            return mat;
        }

        // Build the pose-only LOCATORS: an empty GameObject at each named prop's authored pose (the start gate). The prop
        // itself stays in the merged Props mesh - no geometry here, no render cost; this anchor just lets the start-gate setup
        // read the gate's real position + rotation. Placed under a "Locators" group as a child of the level root, so each
        // empty's localPosition/localRotation (mesh space) inherits the level's SSX->Unity transform, landing on the gate
        // with its true yaw.
        int BuildLocators(Transform parent, BundleManifestReader reader)
        {
            if (reader.Locators.Count == 0) return 0;
            var root = new GameObject("Locators");
            root.transform.SetParent(parent, false);
            // A level can author more than one of a key (Alaska's two start gates). The one this course actually
            // leaves through keeps the plain name, so every existing consumer - the start-gate post row above all -
            // finds the right one by name; the rest are suffixed rather than dropped, so the bundle stays inspectable.
            var seen = new Dictionary<string, int>();
            foreach (var lc in reader.Locators)
            {
                string baseName = LocName(lc.Key);
                int n = seen.TryGetValue(baseName, out int prior) ? prior + 1 : 0;
                seen[baseName] = n;
                bool chosen = ReferenceEquals(lc, reader.BestLocator(lc.Key));
                var go = new GameObject(chosen ? baseName : $"{baseName}_{n + 1}");
                go.transform.SetParent(root.transform, false);
                go.transform.localPosition = lc.Center;
                go.transform.localRotation = lc.Rotation;
            }
            Debug.Log($"OpenSlope: locators -> {reader.Locators.Count} pose anchor(s) under Locators (e.g. the start gate the " +
                      "post row aligns to; the gate stays in the merged mesh - no render cost).");
            return reader.Locators.Count;
        }

        // Locator key -> a tidy GameObject name: drop the "Mdl_" prefix (Mdl_StartGate -> StartGate).
        static string LocName(string key)
        {
            if (string.IsNullOrEmpty(key)) return "Locator";
            return key.StartsWith("Mdl_", StringComparison.Ordinal) ? key.Substring(4) : key;
        }

        // ---- animated props (the swinging bridge): segment hierarchies driven by the model clip ---------------
        // A persistent SSF AnimObject plays the model's own object animation (docs/038, type0 Sub256)
        // [Trailmap: 370-world-interaction]. snowknife bakes per instance: the segment hierarchy + rest poses + (already mirrored)
        // piecewise-cubic channels, and each segment's MODEL-LOCAL mesh as a props.glb "Anim_{i}_o{k}" node. Here
        // each record becomes a GameObject chain at the instance pivot; the visible twin's segments get renderers
        // (vertex lighting baked by snowknife), the invisible collision twin's get moving MeshColliders named
        // "PropsCollision_*" (the prefix the board's IsRideableProp rides + the prop-impact sound reads), and one
        // animated-prop behaviour per instance samples the curves - identical clips keep the two twins in sync.
        int BuildAnimated(Transform parent, BundleManifestReader reader, Dictionary<string, GlbMeshLoader.Node> byName,
                          bool lighting, Mesh container)
        {
            if (reader.Animated.Count == 0) return 0;

            var root = new GameObject("AnimatedProps");
            root.transform.SetParent(parent, false);

            int made = 0, segMeshes = 0, withSound = 0, triggerVols = 0;
            var gatedProps = new List<GameObject>();   // delta-gated (kicker) prop objects for the idle poker
            foreach (var rec in reader.Animated)
            {
                int n = rec.Segments != null ? rec.Segments.Count : 0;
                if (n == 0) continue;

                var pgo = new GameObject($"Anim_{rec.Index}_{rec.Name}");
                pgo.transform.SetParent(root.transform, false);
                pgo.transform.localPosition = rec.Center;
                pgo.transform.localRotation = rec.Rotation;

                // A reset host that ANIMATES (the megaplex pinball doors, the small iris doors) can't take the static
                // AABB trigger VolumeBuilder gives a ResetZone wall. The engine's MainType-13 sits on the door's
                // COLLISION slot, so it fires on CONTACT with the door: hit the shut door and you're put back on the
                // course, and once the door is open there is nothing to hit. A box at the rest pose is the doorway
                // itself, so it keeps resetting a rider riding through the OPEN gap; a box that rides each segment
                // still over-covers a thin blade swung on its pivot. So the reset is carried by the door's own
                // collision instead - an "_R" tag the board reads off the collider it actually hits - and
                // VolumeBuilder skips this index. The tag sits AHEAD of any "_T<surface>" tail so both parse.
                bool resetHost = false;
                foreach (var z in reader.ResetZones) if (z.Index == rec.Index) { resetHost = true; break; }
                string colTail = (resetHost ? "_R" : "") + (rec.SurfaceType > 0 ? "_T" + rec.SurfaceType : "");

                // Two passes: create every segment GameObject first, then parent (ParentID can reference any index).
                var segTf = new Transform[n];
                // The GameObjects that end up carrying a MeshCollider. The impact sound has to live on THESE, not on
                // the prop pivot: the board reads the clip off the collider it hit with GetComponent, which does not
                // look at parents, so a source on the pivot is attached and never found.
                var colliderObjs = new List<GameObject>();
                for (int k = 0; k < n; k++) segTf[k] = new GameObject("seg" + k).transform;
                for (int k = 0; k < n; k++)
                {
                    var seg = rec.Segments[k];
                    segTf[k].SetParent(seg.Parent >= 0 && seg.Parent < n && seg.Parent != k ? segTf[seg.Parent] : pgo.transform, false);
                    segTf[k].localPosition = seg.RestPos;
                    segTf[k].localRotation = seg.RestRotation;
                    segTf[k].localScale = seg.RestScale;

                    if (string.IsNullOrEmpty(seg.Node) || !byName.TryGetValue(seg.Node, out var node) || node.Prims.Count == 0)
                        continue;

                    if (rec.Visible)
                    {
                        var (gm, mats) = MeshFromAnimSeg(node, seg.Node, lighting, LightData(rec));
                        AssetDatabase.AddObjectToAsset(gm, container);
                        segTf[k].gameObject.AddComponent<MeshFilter>().sharedMesh = gm;
                        segTf[k].gameObject.AddComponent<MeshRenderer>().sharedMaterials = mats;

                        // A VISIBLE animated prop that's also collidable (the up/down kicker ramp: one instance you
                        // both see and ride, unlike the bridge's separate sway/surface pair) gets a moving collider
                        // too. A child named PropsCollision_*_T<surface> rides the segment's animated transform - the
                        // same prefix the board's IsRideableProp gate + ride-audio surface read (docs/vrchat/035), so the
                        // ramp stays a rideable WOOD surface as it tilts. Its static collision bake is excluded
                        // (animSet), so this is the only collider - no rest-pose ghost.
                        if (rec.PlayerCollision)
                        {
                            var col = new GameObject("PropsCollision_" + seg.Node + colTail);
                            col.transform.SetParent(segTf[k].transform, false);
                            var cgm = CollisionMeshFromNode(node, seg.Node, mirror: true);   // cut from the render node: one winding
                            AssetDatabase.AddObjectToAsset(cgm, container);
                            col.AddComponent<MeshCollider>().sharedMesh = cgm;
                            colliderObjs.Add(col);
                        }
                    }
                    else
                    {
                        // The board rides colliders named PropsCollision_* (its IsRideableProp gate) - the same
                        // prefix the static bucket bake this replaces used. The collider moves with the segment.
                        // A "_T<SurfaceType>" tail carries the ride-audio surface (the bridge's 12 = WOOD): the
                        // board's PropAudioSurfaceType parses it so crossing the planks plays the WOOD loops.
                        segTf[k].gameObject.name = "PropsCollision_" + seg.Node + colTail;
                        var gm = CollisionMeshFromNode(node, seg.Node, mirror: false);   // snowknife already emitted both windings
                        AssetDatabase.AddObjectToAsset(gm, container);
                        segTf[k].gameObject.AddComponent<MeshCollider>().sharedMesh = gm;
                        colliderObjs.Add(segTf[k].gameObject);
                    }
                    segMeshes++;
                }

                // Positional one-shot impact clip on whichever twin owns collision (the invisible bridge-surface, or a
                // visible+collidable kicker) - the same per-material remap every prop uses; no-op when Sound is -1.
                //
                // ON THE COLLIDER, not the pivot. A static prop's collider and its source share one GameObject, so
                // `PlayImpactSound`'s `c.GetComponent<AudioSource>()` finds it; an animated prop's collider is a
                // segment further down the hierarchy, so a source left on the pivot is never found and the prop
                // is silent. Each collidable segment carries its own, which also puts the sound at the part that
                // was actually struck rather than at the prop's origin.
                bool sounded = false;
                foreach (var col in colliderObjs)
                    sounded = _collision.AttachImpactSound(col, rec.Sound, rec.SoundClip) || sounded;
                if (sounded) withSound++;

                // Flatten the curves for the Udon sampler: only segments that actually animate.
                var aTf = new List<Transform>(); var aPos = new List<Vector3>(); var aEul = new List<Vector3>();
                var cSeg = new List<int>(); var cTgt = new List<int>(); var cStart = new List<int>(); var cCount = new List<int>();
                var data = new List<float>();
                for (int k = 0; k < n; k++)
                {
                    var seg = rec.Segments[k];
                    if (seg.Curves == null || seg.Curves.Count == 0) continue;
                    int si = aTf.Count;
                    aTf.Add(segTf[k]); aPos.Add(seg.RestPos); aEul.Add(seg.RestEuler);
                    foreach (var cu in seg.Curves)
                    {
                        if (cu.Segs == null || cu.Segs.Count == 0) continue;
                        cSeg.Add(si); cTgt.Add(cu.Target); cStart.Add(data.Count / 6); cCount.Add(cu.Segs.Count);
                        foreach (var s6 in cu.Segs)
                            for (int j = 0; j < 6; j++) data.Add(j < s6.Length ? s6[j] : 0f);
                    }
                }
                GameObject animPropObj = null;
                if (aTf.Count > 0)
                {
                    var apMk = pgo.AddComponent<AnimatedPropMarker>();
                    apMk.clipLength = rec.ClipLength;
                    apMk.loopMode = rec.LoopMode;
                    apMk.rate = rec.Rate;
                    apMk.reverse = rec.Reverse;
                    apMk.triggered = rec.Triggered;
                    // Hold 8 s after the last pass, then play back to re-arm - EXCEPT a break-owned roll (docs/036),
                    // whose reset belongs to the breakable's respawn (the rolled-away prop is hidden by then anyway).
                    apMk.autoResetDelay = rec.Triggered && !rec.BreakOwned ? 8f : 0f;
                    apMk.deltaGated = rec.DeltaGated;                // AnimDelta (the kickers): budget-gated, starts frozen
                    apMk.pokeSeconds = rec.PokeSeconds > 0f ? rec.PokeSeconds : 1f;
                    apMk.activatePulse = rec.SelfPulse;              // the centre kicker's self-poking header
                    // AnimCombo (the Aloha barriers): the idle window free-runs and a second window of the same clip
                    // plays once over the top of it when the prop is hit [Trailmap: 230-level-ssf sub 258].
                    apMk.combo = rec.Combo;
                    apMk.comboStart = rec.ComboStart;
                    apMk.comboEnd = rec.ComboEnd;
                    apMk.comboRate = rec.ComboRate > 0f ? rec.ComboRate : 1f;
                    apMk.comboEndMode = rec.ComboEndMode;
                    apMk.phaseOffset = rec.PhaseOffset;
                    apMk.segTransforms = aTf.ToArray();
                    apMk.segRestPos = aPos.ToArray();
                    apMk.segRestEuler = aEul.ToArray();
                    apMk.curveSegment = cSeg.ToArray();
                    apMk.curveTarget = cTgt.ToArray();
                    apMk.curveStart = cStart.ToArray();
                    apMk.curveCount = cCount.ToArray();
                    apMk.curveData = data.ToArray();
                    animPropObj = pgo;
                    if (rec.BreakOwned) _breakOwnedAnims[rec.Index] = (pgo, rec.ClipLength, rec.Triggered);
                }

                // Trigger volumes - a BoxCollider(isTrigger) per volume, each tagged with an AnimTriggerMarker naming the
                // prop: a TRIGGERED prop's boxes play its one-shot (the iris door); a DELTA-GATED prop's boxes poke its
                // budget (the kickers' landing triggers). The boxes sit at their own world positions (mesh space under
                // the level root), so they parent under the AnimatedProps root, NOT the prop pivot.
                // A COMBO prop's volume is usually the prop itself - retail sends the trigger from the barrier's own
                // collision chain - so its box comes out of its own geometry and sits over the prop.
                if ((rec.Triggered || rec.DeltaGated || rec.Combo) && animPropObj != null && rec.Triggers != null)
                    foreach (var tb in rec.Triggers)
                    {
                        var tgo = new GameObject($"AnimTrigger_{rec.Index}");
                        tgo.transform.SetParent(root.transform, false);
                        tgo.transform.localPosition = tb.Center;
                        tgo.transform.localRotation = tb.Rotation;
                        var box = tgo.AddComponent<BoxCollider>();
                        box.center = Vector3.zero;
                        box.size = tb.Size;
                        box.isTrigger = true;
                        var tmk = tgo.AddComponent<AnimTriggerMarker>();
                        tmk.targetObject = animPropObj;
                        tmk.poke = rec.DeltaGated;
                        tmk.combo = rec.Combo;
                        triggerVols++;
                    }
                if (rec.DeltaGated && animPropObj != null) gatedProps.Add(animPropObj);
                made++;
            }

            // Idle "race pack" poker for the delta-gated props (docs/038): in the game the AI racers crossing the
            // landing zones keep the kickers pumping, mutually out of phase; with no AI, this pokes every gated prop
            // together on a random cadence (pair lockstep preserved; the centre's activatePulse offsets it).
            if (gatedProps.Count > 0)
            {
                var pk = new GameObject("AnimPoker");
                pk.transform.SetParent(root.transform, false);
                var pmk = pk.AddComponent<AnimPokerMarker>();
                pmk.targetObjects = gatedProps.ToArray();
            }

            if (made == 0) { UnityEngine.Object.DestroyImmediate(root); return 0; }
            Debug.Log($"OpenSlope: animated props -> {made} under AnimatedProps ({segMeshes} segment meshes, {withSound} with " +
                      $"an impact sound, {triggerVols} trigger volume(s) for triggered props). Tagged with AnimatedPropMarker; " +
                      "collision twins ride as PropsCollision_*; triggered props (e.g. the iris door) fire on contact.");
            return made;
        }

        // A visible animated segment's model-local mesh. Native normals survive the GLB; the exact ambient plus three
        // placed directions are installed as live lighting streams so hierarchy animation changes N.L at runtime.
        (Mesh mesh, Material[] mats) MeshFromAnimSeg(GlbMeshLoader.Node node, string name, bool lighting, PropLightData light)
        {
            var verts = new List<Vector3>(); var uv = new List<Vector2>(); var nrm = new List<Vector3>();
            var subTris = new List<int[]>();
            var mats = new Material[node.Prims.Count];
            for (int s = 0; s < node.Prims.Count; s++)
            {
                var p = node.Prims[s]; int b = verts.Count;
                verts.AddRange(p.Positions);
                if (p.Normals != null) nrm.AddRange(p.Normals);
                if (p.Uv0 != null) uv.AddRange(p.Uv0);
                var t = new int[p.Indices.Length];
                for (int i = 0; i < t.Length; i++) t[i] = p.Indices[i] + b;
                subTris.Add(t);
                _materials.Resolve(p.Material, out string tex, out List<string> frames, out MaterialFactory.ScrollSpec? scroll, out _, out _);
                mats[s] = _materials.Build(tex, frames, scroll, propLighting: false, directional: lighting);
            }
            var gm = new Mesh { name = name, indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
            gm.SetVertices(verts);
            if (uv.Count == verts.Count) gm.SetUVs(0, uv);
            if (nrm.Count == verts.Count) gm.SetNormals(nrm);
            if (lighting) SetLightingStreams(gm, verts.Count, light);
            gm.subMeshCount = subTris.Count;
            for (int s = 0; s < subTris.Count; s++) gm.SetTriangles(subTris[s], s, calculateBounds: false);
            gm.RecalculateBounds();
            return (gm, mats);
        }

        // An animated segment's MeshCollider mesh: positions + triangles only, always DOUBLE-SIDED.
        // An invisible collision twin arrives double-sided from snowknife (AnimatedPropsBundle emits both windings for
        // a !Visable instance), so `mirror` is false there. A VISIBLE collidable segment - the kicker ramp, the
        // megaplex doors and pillars - has no collision twin of its own: its collider is cut from the RENDER node,
        // which carries one winding, and SSX's models are wound inconsistently. Unity queries skip back faces
        // (`Physics.queriesHitBackfaces` is false), so a single winding makes the panel solid from one side and
        // absent from the other - the same fault the static prop bake double-sides against ([009](009-collision.md)).
        // Verts are shared; only the index count doubles.
        static Mesh CollisionMeshFromNode(GlbMeshLoader.Node node, string name, bool mirror)
        {
            var verts = new List<Vector3>(); var tris = new List<int>();
            foreach (var p in node.Prims)
            {
                int b = verts.Count;
                verts.AddRange(p.Positions);
                foreach (var i in p.Indices) tris.Add(i + b);
                if (!mirror) continue;
                for (int t = 0; t + 2 < p.Indices.Length; t += 3)
                {
                    tris.Add(p.Indices[t] + b); tris.Add(p.Indices[t + 2] + b); tris.Add(p.Indices[t + 1] + b);
                }
            }
            var gm = new Mesh { name = name + "_col", indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
            gm.SetVertices(verts);
            gm.SetTriangles(tris, 0, calculateBounds: false);
            gm.RecalculateBounds();
            return gm;
        }

        static void DestroyPrev(Transform parent, string name)
        {
            var prev = parent.Find(name);
            if (prev != null) UnityEngine.Object.DestroyImmediate(prev.gameObject);
        }

        // A RAW course-bank slot clip (Audio/SFX/<bank>/NNN.wav) - the SSF MainType-8 PlaySound id space, NOT the
        // CollisonSound event-id remap (the roll-away breakables' landing crash, docs/036; same load the firework
        // trigger sound uses).
        AudioClip LoadBankSlotClip(int slot)
        {
            if (slot < 0 || string.IsNullOrEmpty(_cfg.LevelSfxBank)) return null;
            return AssetDatabase.LoadAssetAtPath<AudioClip>(_cfg.LevelFolder + "/Audio/SFX/" + _cfg.LevelSfxBank + "/" + slot.ToString("000") + ".wav");
        }

        // The plane a flat plate lies in, as an area-weighted mean face normal in the mesh's own (level-local) space.
        // A glass pane is a two-triangle quad, so this is exact for it, and a slightly non-planar plate still lands on
        // the plane its area is in. Zero-area / degenerate meshes fall back to up, which is the right guess for the
        // floor panels this is used on. Used only as the axis the crack runtime measures closing speed along.
        static Vector3 PlaneNormal(Mesh mesh)
        {
            if (mesh == null) return Vector3.up;
            var verts = mesh.vertices;
            var tris = mesh.triangles;
            var sum = Vector3.zero;
            for (int i = 0; i + 2 < tris.Length; i += 3)
            {
                Vector3 a = verts[tris[i]], b = verts[tris[i + 1]], c = verts[tris[i + 2]];
                // Un-normalized, so each face contributes in proportion to twice its area - the weighting.
                sum += Vector3.Cross(b - a, c - a);
            }
            return sum.sqrMagnitude > 1e-12f ? sum.normalized : Vector3.up;
        }

        static LogoRole ParseRole(string role)
        {
            switch (role)
            {
                case "intact":   return LogoRole.Intact;
                case "broken":   return LogoRole.Broken;
                case "scanline": return LogoRole.Scanline;
                case "piece":    return LogoRole.Piece;
                case "smash":    return LogoRole.Smash;
                default:         return LogoRole.None;
            }
        }

        // Rigidbody mass from the collision Roller's U0, carried semantically as DynamicMass in the bundle
        // [Trailmap: 130-collision-data, 370-world-interaction].
        // New bundles emit a physics divert only for a finite positive Roller mass. The fallback remains for an older
        // or hand-authored bundle that reaches this importer without usable semantic mass.
        float MassFor(float dynamicMass)
        {
            bool valid = dynamicMass > 0f && !float.IsNaN(dynamicMass) && !float.IsInfinity(dynamicMass);
            float m = (_cfg.PhysicsMassFromRoller && valid) ? dynamicMass : _cfg.PhysicsDefaultMass;
            return Mathf.Max(_cfg.PhysicsMinMass, m);
        }

        // Restitution for the bounce PhysicMaterial: the instance's authored PlayerBounceAmmount (the knockables
        // read 0.2 - soft), falling back to the configured default if it's out of range.
        float BounceFor(float playerBounceAmmount)
        {
            return (playerBounceAmmount > 0f && playerBounceAmmount <= 1f) ? playerBounceAmmount : _cfg.PhysicsDefaultBounce;
        }
    }
}
#endif
