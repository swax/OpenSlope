#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;
using UdonSharp;
using UdonSharpEditor;
using VRC.SDK3.Components;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    // Library setup step: build the start gate - a row of clickable red posts at the top of the run, plus ONE shared,
    // networked pool of rideable snowboards they dispense from (docs/vrchat/042, Stage 2). On a multiplayer instance every player
    // sees the same boards ride under each other's avatars, board pickups don't fight, and idle boards are reclaimed so an
    // 80-player server never runs out (or piles up). See also docs/vrchat/017 (the board) and docs/vrchat/025 (performance).
    //
    // Structure built under OpenSlope_Map/StartGate:
    //   BoardPool   - a VRCObjectPool of `BoardCap` boards (pre-placed INACTIVE children) + the BoardManager that, on
    //                 the master, dispenses / reclaims them. The pool is sized to the player cap so it can never run dry.
    //   BoardRequest- the synced BoardRequest mailbox that routes a post click to the master.
    //   GatePost_i  - a red pole (the Interact target) carrying a BoardSpawner that forwards its own index to the
    //                 mailbox. A SpawnAnchor child marks where this post's board is dropped (downhill, on the terrain).
    //
    // PLACEMENT: the post row centres on GateSpawn - the level's own start marker, where riders actually start - and runs ACROSS
    // the slope. ORIENTATION (and, where it lands on the drop-in, position) comes from the level's actual start-gate MODEL
    // via the importer's pose-only LOCATOR (OpenSlope_Map/<Level>/Locators/StartGate; the gate itself stays in the merged mesh):
    // the posts sit across the gate along its own width axis (local X) AND follow its pitch, not just the fall line. The prop
    // is NOT always at the start, though - it's a different prop per level: on some levels it sits on the drop-in (so we
    // centre on it), on others it's authored far off to the SIDE by a banner wall (the funnel where riders start
    // has only crowd stands), so there its position is ignored and the row stays on the drop-in (still using the gate
    // orientation). The model pose is exposed as OpenSlope_Map/Locations/StartGateModel. DOWNHILL (GateSpawn -> PlayerSpawn -> +Z)
    // drives which way boards face. On a level with NO gate model (alpha/demo or non-SSX maps) it centres on GateSpawn,
    // perpendicular to downhill.
    //
    // POST ROW: the posts step along the row's local X only - post_i = post0 + (i*spacing, 0, 0) - so the row stays
    // parallel to the gate (following its width axis + pitch). POST 0's position comes from the SCENE (drag GatePost_0 to place the whole row); a fresh gate seeds it
    // from DefaultFirstLocal. The post COUNT, spacing and pole look are fields on the StartGateConfig component
    // (Inspector-editable, with a "Rebuild gate" button); Spawn() reads post 0 + the config and PRESERVES them across the
    // rebuild. Without a gate model (alpha/demo maps) it falls back to the old terrain-follow row centred on GateSpawn. Re-run
    // after a map reload (it rebuilds StartGate fresh). The Udon two-step bootstrap (a just-created program asset can't take
    // a component in the same call) mirrors RideableBoardSetup.
    public static class StartGateSetup
    {
        const string GateRoot = Map.StartGate;          // OpenSlope_Map/StartGate
        const string MatPath  = Map.AssetsFolder + "/StartGatePost.mat";

        const float Spacing    = 2.5f;  // metres between posts - FALLBACK row only (no gate model)

        // The post row centres on GateSpawn - the level's own start marker, where riders actually start. On levels where the
        // start-gate MODEL sits ON the start point it centres on the model instead for a tighter fit; but where
        // Mdl_StartGate is authored far off to the SIDE it's ignored. (On some levels the prop is ~135m away
        // by a banner wall, while the funnel where riders start has only crowd stands - no gate prop there.) This is the
        // cut-off for "the gate model is ON the drop-in" vs "off to the side".
        const float MaxModelPivotOffset = 50f;

        // The post count, spacing and pole look live on the per-scene StartGateConfig component (Inspector-editable);
        // the FIRST post's position is taken from the SCENE (drag GatePost_0). Spawn() reads/preserves all of it across the
        // rebuild. This is only the seed for post 0 on a brand-new gate (no prior post 0 to read), expressed in the gate
        // LOCATOR's frame: origin = the gate's authored pivot, X = the gate's width axis from its REAL rotation (the
        // importer emits Locators/StartGate per level), so the row follows each gate's true position AND yaw
        // automatically - this seed is just where post 0 sits in that frame, calibrated from one level's gate (post 0
        // aligned by hand). The gate model is identical across levels, so the seed carries over.
        static readonly Vector3 DefaultFirstLocal = new Vector3(-4.1390f, -0.2169f, 1.9751f);

        // The shared pool size = the MAX number of boards that can be live at once (every rider + every dropped board needs
        // a slot). Size it to the expected PEAK, not generously: each entry is a FULL networked board (deck + station +
        // audio + particles + a big SYNCED Udon program), pre-built inactive. An idle/asleep pooled board is NOT free -
        // VRChat's UdonManager bookkeeps every REGISTERED behaviour each frame regardless of active state (profiled at
        // ~0.5 ms per ~90 boards in-editor, amplified on a Quest CPU), on top of the scene weight + memory + build time it
        // adds. Idle-sleep (RideableBoard.sleepWhenParked) only removes a board's OWN per-frame Update cost, not that
        // per-registration tax. 32 comfortably covers a busy instance (6 gate posts dispensing + riders + boards cycling
        // back); raise it only if you genuinely expect more simultaneous riders than that.
        const int   BoardCap   = 32;

        [MenuItem("OpenSlope/Setup/Start Gate Boards", false, 130)]
        public static void Spawn()
        {
            // Two-step bootstrap for the Udon program assets (manager, mailbox, post, board). If we just created any, stop
            // and ask for a second run so UdonSharp can finalize them before we attach components.
            bool firstMgr     = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(BoardManager)) == null;
            bool firstReq     = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(BoardRequest)) == null;
            bool firstSpawner = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(BoardSpawner)) == null;
            bool firstBoard   = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(RideableBoard)) == null;
            bool firstSummon  = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(BoardSummon)) == null;
            EnsureProgram(typeof(BoardManager), "/BoardManager.cs");
            EnsureProgram(typeof(BoardRequest), "/BoardRequest.cs");
            EnsureProgram(typeof(BoardSpawner), "/BoardSpawner.cs");
            EnsureProgram(typeof(BoardSummon), "/BoardSummon.cs");
            RideableBoardSetup.EnsureProgramAsset();
            if (firstMgr || firstReq || firstSpawner || firstBoard || firstSummon)
            {
                Debug.Log("OpenSlope: created the Udon program asset(s) for the start gate. UdonSharp finalizes them on the " +
                          "next editor tick - run 'OpenSlope/Setup/Start Gate Boards' again to build the gate.");
                return;
            }

            Transform mapRoot = Map.ResolveRoot(true);

            // FACING: the map's GateSpawn anchor (forward = downhill). Fall back to PlayerSpawn, then +Z, so the gate
            // still builds in a bare scene.
            Transform anchorLoc = Map.Location(Map.GateSpawn, false) ?? Map.Location(Map.PlayerSpawn, false);
            Vector3 dh = anchorLoc != null ? Vector3.ProjectOnPlane(anchorLoc.forward, Vector3.up) : Vector3.forward;
            dh = dh.sqrMagnitude > 1e-4f ? dh.normalized : Vector3.forward;
            Vector3 right = Vector3.Cross(Vector3.up, dh).normalized;
            if (right.sqrMagnitude < 1e-4f) right = Vector3.right;
            Quaternion downhillRot = Quaternion.LookRotation(dh, Vector3.up);

            // POSITION: the post row centres on the course-top drop-in (GateSpawn) - where riders actually start. When the
            // start-gate MODEL is authored ON the drop-in we centre on the model for a tighter fit and take
            // the row ORIENTATION from it (across the gate). But Mdl_StartGate is a different prop per level and isn't always
            // at the start: on some levels it sits ~135m to the SIDE (by a banner wall), while the funnel where you start has
            // only crowd stands - so when the model is far from GateSpawn we ignore its position and centre on the drop-in
            // (still using the model orientation, which stays valid). A dragged GatePost_0 (read below) fine-tunes from there.
            // The model pose is exposed as OpenSlope_Map/Locations/StartGateModel. With no gate model at all (alpha/demo or non-SSX
            // maps) it centres on GateSpawn facing downhill.
            bool haveModel = TryGetStartGateModel(out Vector3 gateModelPos, out Quaternion gateModelRot);
            Vector3 spawnPos = anchorLoc != null ? anchorLoc.position : Vector3.zero;
            bool modelOnDropIn = haveModel && anchorLoc != null && Vector3.Distance(gateModelPos, spawnPos) <= MaxModelPivotOffset;
            Vector3 center;
            Quaternion frameRot;
            if (haveModel)
            {
                // The row runs along the gate model's OWN width axis (its local X, from the instance's authored rotation),
                // so the posts sit ACROSS the gate however it's turned - not just perpendicular to the fall line. Keep the
                // sign aligned with the downhill-right so the row never flips to the far side.
                Vector3 widthAxis = Vector3.ProjectOnPlane(gateModelRot * Vector3.right, Vector3.up);
                widthAxis = widthAxis.sqrMagnitude > 1e-4f ? widthAxis.normalized : right;
                if (Vector3.Dot(widthAxis, right) < 0f) widthAxis = -widthAxis;
                Vector3 fwd = Vector3.Cross(widthAxis, Vector3.up);
                frameRot = fwd.sqrMagnitude > 1e-4f ? Quaternion.LookRotation(fwd.normalized, Vector3.up) : downhillRot;

                // Account for the gate's PITCH (tilt about its width axis - a gate can lean ~16deg with the slope).
                // Rotate the leveled frame about the width axis by the gate's up-vs-world-up angle, so the row follows the
                // tilted gate plane (post 0's forward/up offset lands ON the slope) instead of sitting flat. A flat gate
                // (0 pitch) is unaffected; an off-to-the-side gate keeps its own pitch too, harmlessly.
                // The bundle is SSX Z-UP (the level root's -90 X maps it to Unity Y-up), so the gate's UP is its LOCAL Z
                // (Vector3.forward), not local Y - using up here would read a ~106deg horizontal, not the ~16deg tilt.
                Vector3 gateUp = gateModelRot * Vector3.forward;
                float pitch = Vector3.SignedAngle(Vector3.up, gateUp, widthAxis);
                frameRot = Quaternion.AngleAxis(pitch, widthAxis) * frameRot;

                // Centre on the gate only when it's on the drop-in; otherwise centre on the drop-in itself.
                center = modelOnDropIn ? gateModelPos : spawnPos;
                if (!modelOnDropIn && anchorLoc != null)
                    Debug.Log($"OpenSlope: the Mdl_StartGate prop is {Vector3.Distance(gateModelPos, spawnPos):F0}m from GateSpawn " +
                              "(off to the side of the drop-in) - centring the post row on the drop-in, keeping the gate orientation.");

                Transform gm = Map.Location(Map.StartGateModel, true);
                gm.SetPositionAndRotation(gateModelPos, frameRot);
            }
            else
            {
                center = spawnPos;
                frameRot = downhillRot;
            }

            Transform collisionRoot = Map.Child(Map.CollisionName, false); // standard terrain colliders (may be null)
            Material redMat = LoadOrCreateRedMaterial();

            // Fresh each run, parented under OpenSlope_Map. Snapshot the tweakable config (StartGateConfig) off the OLD gate
            // before destroying it, so the user's Inspector edits (post count, offsets, pole look) survive the rebuild - the
            // component dies with the object, so capture its values into plain locals first.
            var oldGate = mapRoot.Find(GateRoot);
            var oldCfg  = oldGate != null ? oldGate.GetComponent<StartGateConfig>() : null;
            bool hadCfg = oldCfg != null;
            int sCount = 0; float sSpacing = 0f, sSpawnBehind = 0f; bool sSpawnBehindBoards = true;
            Vector3 sPoleScale = default, sPoleOffset = default, sBoardOffset = default;
            if (hadCfg) { sCount = oldCfg.postCount; sSpacing = oldCfg.spacing; sPoleScale = oldCfg.poleScale; sPoleOffset = oldCfg.poleOffset; sBoardOffset = oldCfg.boardOffset; sSpawnBehindBoards = oldCfg.spawnBehindBoards; sSpawnBehind = oldCfg.spawnBehind; }
            // Post 0's position is taken from the SCENE (drag it to place the row), not stored - snapshot its visible pole's
            // world position before the rebuild. Reading the pole handles dragging EITHER the post root or the pole mesh.
            bool hasPost0 = false; Vector3 sPost0Pole = default;
            if (oldGate != null)
            {
                var op0 = oldGate.Find("GatePost_0/Pole") ?? oldGate.Find("GatePost_0");
                if (op0 != null) { hasPost0 = true; sPost0Pole = op0.position; }
            }
            if (oldGate != null) Object.DestroyImmediate(oldGate.gameObject);
            var gate = new GameObject(GateRoot);
            gate.transform.SetParent(mapRoot, false);

            // The tweakable config lives on the gate (editor-only; the VRChat SDK strips it on upload). A fresh one carries
            // the defaults; if the old gate had one, restore the user's values onto it. (Post 0's position is NOT stored -
            // it comes from the scene above.)
            var cfg = gate.AddComponent<StartGateConfig>();
            if (hadCfg) { cfg.postCount = Mathf.Max(1, sCount); cfg.spacing = sSpacing; cfg.poleScale = sPoleScale; cfg.poleOffset = sPoleOffset; cfg.boardOffset = sBoardOffset; cfg.spawnBehindBoards = sSpawnBehindBoards; cfg.spawnBehind = sSpawnBehind; }
            int count = Mathf.Max(1, cfg.postCount);

            // ---- The shared board pool (BoardCap boards, inactive children of an identity-scale holder) ----------------
            var poolGo = new GameObject("BoardPool");
            poolGo.transform.SetParent(gate.transform, false); // identity under the gate (boards must not sit under a scaled parent)

            var boardGos     = new GameObject[BoardCap];
            var boardProxies = new RideableBoard[BoardCap];
            for (int j = 0; j < BoardCap; j++)
            {
                // Built at the gate centre facing downhill; the pose is irrelevant while inactive - the master poses each
                // board at a post anchor when it dispenses it.
                var bgo = RideableBoardSetup.BuildBoardAt($"Board_{j}", center, downhillRot, collisionRoot, j);
                bgo.transform.SetParent(poolGo.transform, true);
                bgo.SetActive(false); // pooled objects start inactive; VRCObjectPool activates them on spawn
                boardGos[j] = bgo;
                boardProxies[j] = bgo.GetComponent<RideableBoard>();
            }

            var pool = poolGo.AddComponent<VRCObjectPool>();
            pool.Pool = boardGos;

            var manager = poolGo.AddUdonSharpComponent<BoardManager>();
            manager.pool = pool;
            manager.boards = boardProxies;

            // ---- The request mailbox ------------------------------------------------------------------------------------
            var reqGo = new GameObject("BoardRequest");
            reqGo.transform.SetParent(gate.transform, false);
            var request = reqGo.AddUdonSharpComponent<BoardRequest>();
            request.manager = manager;
            UdonSharpEditorUtility.CopyProxyToUdon(request);

            // ---- The over-the-shoulder board summon ----------------------------------------------------------------------
            // Purely local (sync None): it reads the LOCAL player's head/hand tracking, so one in the scene serves everyone.
            // Reach behind your head and grip and your board flies to your hand - the one you last rode if you still have it
            // (boards stay claimed by their last rider), else a fresh one the master dispenses from the pool. See BoardSummon.
            var summonGo = new GameObject("BoardSummon");
            summonGo.transform.SetParent(gate.transform, false);
            var summon = summonGo.AddUdonSharpComponent<BoardSummon>();
            summon.manager = manager;
            summon.request = request;
            UdonSharpEditorUtility.CopyProxyToUdon(summon);

            // ---- The posts + their spawn anchors ------------------------------------------------------------------------
            var anchors = new Transform[count];
            float half = (count - 1) * 0.5f;
            float rayTop = center.y + 60f;   // start ground raycasts well above the gate line

            // Post LAYOUT (gate-model levels): the posts step along the model's local X only - post_i = firstPost +
            // (i*spacing, 0, 0) - so the row stays level and parallel to the gate (no per-post terrain raycast). Without a
            // gate model (alpha/demo maps) keep the old terrain-follow row.
            Matrix4x4 frame = Matrix4x4.TRS(center, frameRot, Vector3.one);
            bool useLayout = haveModel;

            // The FIRST post comes from the scene (drag GatePost_0 to place the row), converted into the frame; the rest step
            // along the row's X from there. Undo the pole's offset so the rebuilt pole lands exactly where it sits now (the
            // rebuilt root is identity-rotated, so the offset is world-space). A fresh gate seeds from DefaultFirstLocal.
            Vector3 firstLocal = DefaultFirstLocal;
            if (hasPost0) firstLocal = frame.inverse.MultiplyPoint3x4(sPost0Pole - cfg.poleOffset);

            for (int i = 0; i < count; i++)
            {
                Vector3 postLocal = firstLocal + new Vector3(i * cfg.spacing, 0f, 0f);
                Vector3 postPos;
                if (useLayout) postPos = frame.MultiplyPoint3x4(postLocal);
                else
                {
                    Vector3 along = right * ((i - half) * Spacing);
                    float px = center.x + along.x, pz = center.z + along.z;
                    postPos = new Vector3(px, Map.GroundYTerrain(px, pz, rayTop, center.y), pz);
                }

                // The post: an identity-scale root carrying the Interact capsule + Udon, with the visible red pole as a
                // scaled child (so the capsule/anchor live in clean world units, not the pole's stretched space).
                var post = new GameObject($"GatePost_{i}");
                post.transform.SetParent(gate.transform, false);
                post.transform.position = postPos;

                var pole = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
                pole.name = "Pole";
                var pc = pole.GetComponent<Collider>();
                if (pc != null) Object.DestroyImmediate(pc); // drop the primitive's collider; the root capsule is the target
                pole.transform.SetParent(post.transform, false);
                pole.transform.localScale = cfg.poleScale;
                pole.transform.localPosition = cfg.poleOffset;
                if (redMat != null) pole.GetComponent<MeshRenderer>().sharedMaterial = redMat;

                var cap = post.AddComponent<CapsuleCollider>();
                cap.direction = 1; // Y
                cap.center = cfg.poleOffset;                                              // wrap the visible pole
                cap.height = cfg.poleScale.y * 2f;                                        // cylinder mesh is 2 units tall
                cap.radius = Mathf.Max(cfg.poleScale.x, cfg.poleScale.z) * 0.5f + 0.05f;  // a touch wider, easy to click

                // Spawn anchor: where this post's board lands - offset from the post by cfg.boardOffset (x=right/between
                // posts, z=downhill, negative z = behind the post), facing downhill. The horizontal offset is in the gate
                // frame (model) or along right/downhill (fallback); the Y is GROUNDED to the snow + boardOffset.y, so the
                // board's deck rests on the surface (and matches the editor gizmo).
                Vector3 anchorPos;
                if (useLayout) anchorPos = frame.MultiplyPoint3x4(postLocal + new Vector3(cfg.boardOffset.x, 0f, cfg.boardOffset.z));
                else anchorPos = postPos + right * cfg.boardOffset.x + dh * cfg.boardOffset.z;
                anchorPos.y = Map.GroundYTerrain(anchorPos.x, anchorPos.z, rayTop, anchorPos.y) + cfg.boardOffset.y;
                var anchor = new GameObject("SpawnAnchor");
                anchor.transform.SetParent(post.transform, false);
                anchor.transform.SetPositionAndRotation(anchorPos, downhillRot);
                anchors[i] = anchor.transform;

                var spawner = post.AddUdonSharpComponent<BoardSpawner>();
                spawner.request = request;
                spawner.postIndex = i;
                UdonSharpEditorUtility.CopyProxyToUdon(spawner);
            }

            // Finish wiring the manager now that the anchors exist, then push the whole proxy to Udon in one copy.
            manager.anchors = anchors;
            UdonSharpEditorUtility.CopyProxyToUdon(manager);

            // Player spawns: one behind each board (uphill), facing downhill toward the board, so a player spawns ready to
            // step on and drop in. Wired into the scene descriptor with RANDOM order. Off -> fall back to the single spawn.
            if (cfg.spawnBehindBoards)
            {
                var spawnRoot = new GameObject("PlayerSpawns");
                spawnRoot.transform.SetParent(gate.transform, false);
                var spawns = new Transform[count];
                for (int i = 0; i < count; i++)
                {
                    Vector3 sp = anchors[i].position - dh * cfg.spawnBehind;        // behind the board (uphill)
                    sp.y = Map.GroundYTerrain(sp.x, sp.z, rayTop, sp.y);          // player stands on the snow
                    var s = new GameObject($"Spawn_{i}");
                    s.transform.SetParent(spawnRoot.transform, false);
                    s.transform.SetPositionAndRotation(sp, downhillRot);            // face downhill = toward the board
                    spawns[i] = s.transform;
                }
                SetSceneSpawns(spawns, true);
            }
            else SetSceneSpawns(null, false);

            // Bake network IDs now that every networked object exists (the pooled boards + pool + request mailbox built here,
            // plus the importer's Manual event-broadcasters already in the scene). The gate rebuild above recreated the
            // boards fresh, so without this they'd ship with NO ID and silently not sync - see BakeNetworkIDs.
            BakeNetworkIDs();

            Selection.activeGameObject = gate;
            EditorSceneManagerMarkDirty(gate);
            Debug.Log($"OpenSlope: built '{Map.RootName}/{GateRoot}' - {count} start-gate posts + a shared networked pool of " +
                      $"{BoardCap} boards centred on {center} (downhill {dh}). On a multiplayer instance the master seeds " +
                      "one board per post and dispenses from the pool on click; idle boards are reclaimed (docs/vrchat/042). Enter " +
                      "Play mode (ClientSim) or upload to try it. NOTE: the pool networking can only be fully verified in a " +
                      "real instance, not ClientSim.");
        }

        // The level's START-GATE pose in world space, so the posts lay out on the real gate. Reads the importer's
        // pose-only LOCATOR (OpenSlope_Map/<Level>/Locators/StartGate) - an empty anchor at the gate's authored position +
        // rotation; the gate itself stays in the merged mesh. The locator carries the gate's TRUE yaw
        // and the recenter-correct position, so the row sits square on the gate per level. Returns
        // false (the caller then centres on GateSpawn) when there's no locator - a level with no start gate / non-SSX map.
        static bool TryGetStartGateModel(out Vector3 worldPos, out Quaternion worldRot)
        {
            worldPos = Vector3.zero; worldRot = Quaternion.identity;
            Transform root = Map.ResolveRoot(false);
            if (root == null) return false;
            Transform level = root.Find(ImportConfig.Current().LevelName);
            Transform loc = level != null ? level.Find("Locators/StartGate") : null;
            if (loc == null) return false;
            worldPos = loc.position; worldRot = loc.rotation;
            return true;
        }

        // The posts, board anchors and player spawns all seat with Map.GroundYTerrain - the library's one ground rule
        // (ignore prop colliders, never seat on a ride-through structure's ceiling). The finish leaderboard uses the same
        // call, so the whole map stands on the snow by the same reasoning.

        // Point the scene's VRChat spawns at the given transforms (RANDOM order) when 'random' - i.e. the per-board spawns;
        // otherwise fall back to the single GateSpawn/PlayerSpawn anchor. No-op without a VRCSceneDescriptor.
        static void SetSceneSpawns(Transform[] spawns, bool random)
        {
            var desc = Object.FindObjectOfType<VRCSceneDescriptor>();
            if (desc == null) return;
            if (random && spawns != null && spawns.Length > 0)
            {
                desc.spawns = spawns;
                desc.spawnOrder = VRC.SDKBase.VRC_SceneDescriptor.SpawnOrder.Random;
            }
            else
            {
                Transform single = Map.Location(Map.PlayerSpawn, false) ?? Map.Location(Map.GateSpawn, false);
                if (single == null) return;
                desc.spawns = new Transform[] { single };
                desc.spawnOrder = VRC.SDKBase.VRC_SceneDescriptor.SpawnOrder.First;
            }
            EditorUtility.SetDirty(desc);
        }

        // CRITICAL - bake network IDs for every networked object in the scene (the boards + pool + request mailbox here,
        // plus the importer's Manual event-broadcasters: gems, fireworks, breakables, boost pads, anim triggers) into the
        // descriptor's NetworkIDCollection. Manual-sync Udon AND SendCustomNetworkEvent need an ID, consistent across
        // clients, in the descriptor to network AT ALL. The VRChat PUBLISH does NOT assign these - in the SDK source the
        // only callers of ConfigureNetworkIDs are the manual Network ID Utility and ClientSim. ClientSim auto-assigns at
        // Play, which MASKS their absence: a green editor run passes even though a published client, getting no such
        // freebie, would silently no-op every board sync (and the voice channel, reading the synced occupied/owner, would
        // then see no remote riders). The gate rebuild above recreated every pooled board fresh, so their old entries now point
        // at destroyed objects (dangling) and the new boards have none - so we re-bake every time the gate is built. Prune
        // the dangling entries first so the collection doesn't bloat across rebuilds. This is the same call the Network ID
        // Utility runs and it KEEPS existing valid IDs (stable), so it doesn't fight a later Utility pass.
        static void BakeNetworkIDs()
        {
            var desc = Object.FindObjectOfType<VRCSceneDescriptor>();
            if (desc == null)
            {
                Debug.LogWarning("OpenSlope: no VRCSceneDescriptor in the scene - can't bake network IDs. The boards won't sync on " +
                                 "a PUBLISHED instance until IDs are baked (Window > VRChat SDK > Utilities > Network ID Utility).");
                return;
            }
            if (desc.NetworkIDCollection != null) desc.NetworkIDCollection.RemoveAll(p => p.gameObject == null); // drop teardown debris
            VRC.SDKBase.Network.NetworkIDAssignment.ConfigureNetworkIDs(
                desc, out System.Collections.Generic.List<VRC.SDKBase.Network.NetworkIDAssignment.SetErrorLocation> idErrors,
                VRC.SDKBase.Network.NetworkIDAssignment.SetError.IncompatibleTypes);
            if (idErrors != null && idErrors.Count > 0)
                Debug.LogWarning($"OpenSlope: network ID assignment reported {idErrors.Count} issue(s) - check the console before publishing.");
            EditorUtility.SetDirty(desc);
            int total = desc.NetworkIDCollection != null ? desc.NetworkIDCollection.Count : 0;
            Debug.Log($"OpenSlope: baked network IDs into the scene descriptor ({total} total). Publish does NOT auto-assign these, " +
                      "so the gate rebuild re-bakes them - SAVE the scene to persist. Verify cross-client sync on a published " +
                      "2-client instance (ClientSim masks missing IDs).");
        }

        // A solid, glowing red material for the posts, saved as an asset so it survives the VRChat upload. Built-in
        // pipeline (VRChat worlds), so the Standard shader is correct.
        static Material LoadOrCreateRedMaterial()
        {
            var existing = AssetDatabase.LoadAssetAtPath<Material>(MatPath);
            if (existing != null) return existing;

            var sh = Shader.Find("Standard");
            if (sh == null) { Debug.LogWarning("OpenSlope: Standard shader not found; posts will use the default material."); return null; }
            var mat = new Material(sh);
            mat.color = new Color(0.85f, 0.06f, 0.06f);
            mat.EnableKeyword("_EMISSION");
            mat.SetColor("_EmissionColor", new Color(0.65f, 0.02f, 0.02f));
            mat.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive;
            AssetDatabase.CreateAsset(mat, MatPath);
            AssetDatabase.SaveAssets();
            return mat;
        }

        // Create the UdonSharpProgramAsset for a U# behaviour if absent, then compile so it carries a serialized
        // program (AddUdonSharpComponent requires it). Same recipe as RideableBoardSetup.EnsureProgramAsset.
        static UdonSharpProgramAsset EnsureProgram(System.Type type, string csFileSuffix)
        {
            var existing = UdonSharpProgramAsset.GetProgramAssetForClass(type);
            if (existing != null) return existing;

            string scriptPath = null;
            foreach (var guid in AssetDatabase.FindAssets(type.Name + " t:MonoScript"))
            {
                var p = AssetDatabase.GUIDToAssetPath(guid);
                if (p.EndsWith(csFileSuffix)) { scriptPath = p; break; }
            }
            if (scriptPath == null) { Debug.LogError($"OpenSlope: {csFileSuffix} not found in project."); return null; }

            var script = AssetDatabase.LoadAssetAtPath<MonoScript>(scriptPath);
            var pa = ScriptableObject.CreateInstance<UdonSharpProgramAsset>();
            pa.sourceCsScript = script;
            string assetPath = System.IO.Path.ChangeExtension(scriptPath, ".asset");
            AssetDatabase.CreateAsset(pa, assetPath);
            AssetDatabase.Refresh();
            UdonSharpProgramAsset.CompileAllCsPrograms(true);
            Debug.Log($"OpenSlope: created UdonSharp program asset {assetPath}");
            return UdonSharpProgramAsset.GetProgramAssetForClass(type);
        }

        static void EditorSceneManagerMarkDirty(GameObject go)
            => UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);
    }
}
#endif
