#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    // The OpenSlope library's neutral MAP-ROOT convention. Every OpenSlope world - whether built by an authored map
    // or imported from a game level - lives under ONE identity-transform root named "OpenSlope_Map" at
    // the origin. Library tools and setup steps then find standard things at standard paths regardless of which map is
    // loaded: the terrain colliders at OpenSlope_Map/Collision, named anchors at OpenSlope_Map/Locations/<name> (PlayerSpawn,
    // GateSpawn, ...). "Loading" a map CLEARS this root and rebuilds into it, so maps are switchable in place.
    //
    // This is the seam that decouples the OpenSlope runtime/editor scripts from any one map's root: point those at Map
    // paths and they work in any world. Editor-only (find/create scene objects).
    public static class Map
    {
        // The neutral layout constants live in the importer's MapLayout (so the importer names its output without
        // depending on VRC); re-export them here so the VRC setup steps + runtime keep using Map.* unchanged.
        public const string RootName      = MapLayout.RootName;
        public const string CollisionName = MapLayout.CollisionName;
        public const string LocationsName = MapLayout.LocationsName;
        public const string PlayerSpawn   = MapLayout.PlayerSpawn;
        public const string GateSpawn     = MapLayout.GateSpawn;
        public const string PlayerFlight  = MapLayout.PlayerFlight;
        public const string StartGate     = MapLayout.StartGate;
        public const string StartGateModel = MapLayout.StartGateModel;
        public const string Rails         = MapLayout.Rails;
        public const string CoursePath    = MapLayout.CoursePath;
        public const string Foliage       = MapLayout.Foliage;

        // Where the VRChat layer's own generated assets land (pole materials, the baked HUD art). A sibling of
        // the synced VRC/ sources under the same root, so one project folder holds the whole OpenSlope install.
        public const string AssetsFolder  = MapLayout.AssetsRoot + "/VRC";
        public const string GeneratedFolder = AssetsFolder + "/Generated";

        // Find the OpenSlope_Map root, optionally creating it at the origin (identity) if absent.
        public static Transform ResolveRoot(bool create)
        {
            var go = GameObject.Find(RootName);
            if (go == null && create)
            {
                go = new GameObject(RootName);
                go.transform.SetPositionAndRotation(Vector3.zero, Quaternion.identity);
                go.transform.localScale = Vector3.one;
            }
            return go != null ? go.transform : null;
        }

        // Confirm before a map import wipes the loaded map. Returns true to proceed. Every "OpenSlope/Load" entry point
        // calls this first so loading a map can't silently throw away the one you have open. Only prompts when a map is
        // actually loaded - on an empty scene there's nothing to lose, so it just proceeds.
        public static bool ConfirmReplace(string mapLabel)
        {
            if (GameObject.Find(RootName) == null) return true;
            return EditorUtility.DisplayDialog(
                "Replace the loaded map?",
                $"This deletes the current '{RootName}' and loads {mapLabel} in its place.\n\nThis can't be undone.",
                "Replace", "Cancel");
        }

        // Wipe and recreate the OpenSlope_Map root - the "load a fresh map" entry point (an import/build calls this first, so
        // switching maps doesn't stack two on top of each other). Returns the new empty root at the origin.
        public static Transform ResetRoot()
        {
            var existing = GameObject.Find(RootName);
            if (existing != null) Object.DestroyImmediate(existing);
            var go = new GameObject(RootName);
            go.transform.SetPositionAndRotation(Vector3.zero, Quaternion.identity);
            return go.transform;
        }

        // Find-or-create a direct child of OpenSlope_Map by name (e.g. "Collision"), at an identity local transform.
        public static Transform Child(string name, bool create)
        {
            Transform root = ResolveRoot(create);
            if (root == null) return null;
            Transform c = root.Find(name);
            if (c == null && create)
            {
                var go = new GameObject(name);
                go.transform.SetParent(root, false);
                c = go.transform;
            }
            return c;
        }

        // Find-or-create a named anchor transform under OpenSlope_Map/Locations (e.g. "PlayerSpawn", "GateSpawn"). The OpenSlope
        // setup scripts read these for placement instead of hardcoded per-map coordinates.
        public static Transform Location(string name, bool create)
        {
            Transform locs = Child(LocationsName, create);
            if (locs == null) return null;
            Transform c = locs.Find(name);
            if (c == null && create)
            {
                var go = new GameObject(name);
                go.transform.SetParent(locs, false);
                c = go.transform;
            }
            return c;
        }

        // ---- seating anything on the snow --------------------------------------------------------------------------

        // Ground height under (x,z) on the TERRAIN - the ONE ground rule for everything the library stands on the map: the
        // gate posts, the board anchors, the player spawns, the finish leaderboard. Two things have to be ignored to land
        // on the snow.
        //
        // PROPS. A plain downward raycast lands on whatever prop collider is overhead (a gate's own bounce collider, a
        // finish arch, a fence), metres above the snow, which leaves the thing floating in the air. So hits under
        // OpenSlope_Map/Collision win outright.
        //
        // CEILINGS. SSX terrain has ride-through structures (docs/037), so terrain OVERHEAD is real: a start tunnel's roof
        // is snow you can ride, and the topmost terrain hit in that column is that roof, not the floor riders stand on.
        // Seating only ever goes DOWN, so take the highest terrain surface not above 'fallback' - the height the caller
        // asked for, which is already the right storey. Nothing at or below it means the point started under all the
        // terrain: rise to the lowest snow, then to the lowest hit of any kind, then keep 'fallback'.
        public const float SeatTolerance = 0.5f;   // m of slack so a point resting ON the snow still claims its own floor

        public static float GroundYTerrain(float x, float z, float rayStartY, float fallback)
        {
            var hits = Physics.RaycastAll(new Vector3(x, rayStartY, z), Vector3.down, 400f);
            if (hits == null || hits.Length == 0) return fallback;
            System.Array.Sort(hits, (a, b) => a.distance.CompareTo(b.distance));   // topmost first
            Transform coll = Child(CollisionName, false);
            RaycastHit? highestTerrain = null;
            foreach (var h in hits)
            {
                if (coll == null) break;
                bool isTerrain = false;
                for (Transform p = h.collider.transform; p != null && !isTerrain; p = p.parent) isTerrain = p == coll;
                if (!isTerrain) continue;
                if (highestTerrain == null) highestTerrain = h;
                if (h.point.y <= fallback + SeatTolerance) return h.point.y;       // the floor under the asked-for height
            }
            if (highestTerrain != null) return highestTerrain.Value.point.y;       // all of it is above: rise to the lowest snow
            return hits[hits.Length - 1].point.y;                                   // no terrain here: the lowest thing there is
        }

        // ---- the start-gate "bench" of info / control boards -------------------------------------------------------

        // The info / control boards behind the start gate stand in ONE fixed row, each lined up behind a dispensed
        // snowboard, in this order as the PLAYER reads them (their LEFT -> RIGHT):
        //
        //     slot 0 Info  ·  1 Settings  ·  2 Players  ·  3 Jukebox  ·  4 Diagnostics
        //
        // Each board's setup passes its own slot index to PlaceOnBench; change that constant in a setup to reorder the row.
        // The spacing matches the gate's own post pitch (the boards sit behind the rack of real boards), so it's tighter
        // than a hand-tuned offset and tracks StartGateConfig.spacing if that's retuned.
        //
        // HANDEDNESS: the gate posts (GatePost_0..N) are numbered for a RIDER facing downhill, so the index grows to the
        // rider's right. But a player READING these boards stands below them facing UPHILL, so their left/right is the
        // mirror of the rider's - slot 0 (the reader's left) therefore maps to the HIGHEST-numbered post, not post 0.
        public const float BenchSpacing = 1.385f;   // fallback row pitch (StartGateConfig.spacing default) when there's no gate yet

        // Shared vertical layout so every gate board is the SAME rectangle (identical heights, level tops + bottoms). The
        // height is sized to the TALLEST board's content so nothing crops; shorter boards just show
        // blank backdrop below their content. Lower / raise the whole row by nudging BenchPanelBottom.
        // 1160 covers the Info Board's 1117 px cheat-sheet and Settings Board's 1112 px content; the round-up keeps a
        // real bottom margin instead of clipping the last row.
        // Anything added to a board wants this recomputed; it is sized to the tallest board, not to a round number.
        // InfoBoardSetup.ContentHeight() warns on build if the Info Board outgrows this again.
        public const float BenchPanelHeight = 1160f;   // canvas px; >= the tallest board's content so none is cropped
        public const float BenchPanelBottom = 0.60f;   // world m: common BOTTOM edge of every panel (a comfortable reading height)

        // Pose for the control board in bench `slotIndex`: stand it `behind` metres up the fall line from the snowboard
        // dropped at the matching start-gate post, facing downhill so its readable face points at the player. Anchored to
        // the post's SpawnAnchor (where the rideable board actually lands), so the row of boards lines up directly behind
        // the rack at the gate's own spacing, and keeps the whole row level (Y from the post line, not the per-board
        // terrain height). The reader faces uphill, so slot 0 maps to the highest-numbered post (see HANDEDNESS above).
        // Falls back to a row centred on GateSpawn (spread along the reader's left->right by BenchSpacing) when the gate
        // isn't built yet, so the boards still place in a bare scene. `slotCount` only centres that fallback row.
        public static void BenchSlot(int slotIndex, int slotCount, float behind, out Vector3 pos, out Quaternion rot)
        {
            // Downhill = the map's gate anchor forward (the same reference the gate build uses), projected flat.
            Transform a = Location(GateSpawn, false) ?? Location(PlayerSpawn, false);
            Vector3 dh = a != null ? Vector3.ProjectOnPlane(a.forward, Vector3.up) : Vector3.forward;
            dh = dh.sqrMagnitude > 1e-4f ? dh.normalized : Vector3.forward;
            rot = Quaternion.LookRotation(-dh, Vector3.up);   // readable face points downhill -> at the player

            Transform root = ResolveRoot(false);
            Transform gate = root != null ? root.Find(StartGate) : null;
            if (gate != null)
            {
                // Count the posts, then map the reader's left->right slot to the gate's right->left post numbering.
                int n = 0;
                while (gate.Find("GatePost_" + n) != null) n++;
                int postIndex = n - 1 - slotIndex;
                Transform post = (postIndex >= 0 && postIndex < n) ? gate.Find("GatePost_" + postIndex) : null;
                if (post != null)
                {
                    Transform anchor = post.Find("SpawnAnchor");            // where this post's snowboard lands
                    Vector3 col = anchor != null ? anchor.position : post.position;
                    pos = col - dh * behind;                                // step up the fall line, behind the rack
                    pos.y = post.position.y;                                // keep the board row level on the post line
                    return;
                }
            }

            // No gate yet: spread the row around GateSpawn. Posts grow to the rider's right (= the reader's LEFT), so
            // slot 0 (reader's left) sits at the most-positive offset along that axis and slots step toward the right.
            Vector3 center = a != null ? a.position : (root != null ? root.position : Vector3.zero);
            Vector3 right = Vector3.Cross(Vector3.up, dh).normalized;       // rider's right = reader's left
            if (right.sqrMagnitude < 1e-4f) right = Vector3.right;
            float off = ((slotCount - 1) * 0.5f - slotIndex) * BenchSpacing;
            pos = center - dh * behind + right * off;
            RaycastHit hit;
            pos.y = Physics.Raycast(new Vector3(pos.x, center.y + 60f, pos.z), Vector3.down, out hit, 400f) ? hit.point.y : center.y;
        }

        // The whole bench hangs off ONE container, OpenSlope_Map/GateBench, so the row is a single handle: drag / rotate / hide
        // that object and all six boards follow. Cleared with the map like any other OpenSlope_Map child.
        public const string GateBench = "GateBench";

        // The row's DESIGN frame: centred on the slots it holds, facing downhill like the boards themselves. This is the
        // pose a fresh container gets - the move handle lands amid the boards at the gate, and each board's local offset
        // is a small step along the row rather than a full map-scale vector from the origin.
        static void BenchAnchor(int slotCount, float behind, out Vector3 pos, out Quaternion rot)
        {
            Vector3 sum = Vector3.zero;
            rot = Quaternion.identity;
            for (int i = 0; i < slotCount; i++)
            {
                BenchSlot(i, slotCount, behind, out Vector3 p, out Quaternion r);
                sum += p;
                if (i == 0) rot = r;        // every slot shares the one downhill facing
            }
            pos = sum / Mathf.Max(1, slotCount);
        }

        // Find / create OpenSlope_Map/GateBench. A container that still sits at its parent's identity has never been placed, so
        // it's posed on the row; one you've MOVED keeps its pose, because moving the row is the whole point of the handle.
        // (Zero the transform and re-run a setup to snap the row back onto the gate.)
        public static Transform BenchRoot(bool create, int slotCount, float behind)
        {
            Transform root = ResolveRoot(create);
            if (root == null) return null;

            Transform bench = root.Find(GateBench);
            if (bench == null && create)
            {
                var go = new GameObject(GateBench);
                go.transform.SetParent(root, false);
                bench = go.transform;
            }
            if (bench == null) return null;

            if (bench.localPosition == Vector3.zero && bench.localRotation == Quaternion.identity)
            {
                BenchAnchor(slotCount, behind, out Vector3 aPos, out Quaternion aRot);

                // Boards already standing on the row stay exactly where they are - only the handle travels onto them. Their
                // local offsets are rewritten by the move into the design frame, so a single board's setup can re-pose the
                // container without dragging its five siblings across the map.
                int n = bench.childCount;
                var keepPos = new Vector3[n];
                var keepRot = new Quaternion[n];
                for (int i = 0; i < n; i++) { keepPos[i] = bench.GetChild(i).position; keepRot[i] = bench.GetChild(i).rotation; }

                bench.SetPositionAndRotation(aPos, aRot);

                for (int i = 0; i < n; i++) bench.GetChild(i).SetPositionAndRotation(keepPos[i], keepRot[i]);
            }
            return bench;
        }

        // Stand `board` in bench `slotIndex` under BenchRoot. BenchSlot measures the slot off the gate posts in WORLD
        // space; the board is parented to the container carrying that slot's offset IN THE DESIGN FRAME, not in world.
        // So the container's transform positions the row: leave it and the boards land on the gate exactly as measured,
        // move it and the whole row travels rigidly - and re-running one board's setup still drops that board into its
        // slot in the MOVED row, level with its siblings.
        public static void PlaceOnBench(Transform board, int slotIndex, int slotCount, float behind)
        {
            Transform bench = BenchRoot(true, slotCount, behind);
            BenchSlot(slotIndex, slotCount, behind, out Vector3 pos, out Quaternion rot);
            BenchAnchor(slotCount, behind, out Vector3 aPos, out Quaternion aRot);

            Quaternion invAnchor = Quaternion.Inverse(aRot);
            board.SetParent(bench, false);
            board.localPosition = invAnchor * (pos - aPos);
            board.localRotation = invAnchor * rot;
        }

        // Remove the bench board named `objName` from wherever it sits under the map root, so each setup's destroy-and-
        // rebuild leaves exactly one. (A board authored straight under OpenSlope_Map is adopted into the row on its next run.)
        public static void ClearBenchBoard(string objName)
        {
            Transform root = ResolveRoot(false);
            if (root == null) return;

            Transform direct = root.Find(objName);
            if (direct != null) Object.DestroyImmediate(direct.gameObject);

            Transform bench = root.Find(GateBench);
            Transform nested = bench != null ? bench.Find(objName) : null;
            if (nested != null) Object.DestroyImmediate(nested.gameObject);
        }

        // How far below the loaded map's lowest point the VRChat respawn line sits (metres). VRChat respawns the player
        // the instant their Y falls below the scene descriptor's RespawnHeightY (ClientSimPlayerController.Update reads
        // VRC_SceneDescriptor.RespawnHeightY). The default -100 is fine for a flat world but WRONG for an OpenSlope mountain:
        // these maps are tall and CENTRED ON THE ORIGIN (so the run descends far below y=0), so a rider crossing -100
        // partway down gets yanked back to spawn before reaching the bottom. The margin is the only safety buffer against
        // a genuine fall-through-the-world below the lowest terrain - generous enough never to false-trigger on a deep
        // dip or a bouncing board, not so deep that an off-the-edge fall takes forever to reset.
        public const float RespawnMarginBelowMap = 120f;

        // Point the scene's VRChat spawn at the map's PlayerSpawn anchor, so the imported map is immediately spawnable. The
        // neutral importer builds the OpenSlope_Map/Locations/PlayerSpawn anchor; the platform wiring pass calls this after the
        // build to wire the scene descriptor to it. No-op when there's no descriptor or no PlayerSpawn yet.
        public static void PointSceneSpawn()
        {
            var spawn = Location(PlayerSpawn, false);
            if (spawn == null) return;
            var desc = Object.FindObjectOfType<VRC.SDK3.Components.VRCSceneDescriptor>();
            if (desc == null) return;
            desc.spawns = new Transform[] { spawn };
            EditorUtility.SetDirty(desc);
        }

        // Set the scene's VRChat RespawnHeightY from the LOADED map's extent: a margin below the lowest collidable/visible
        // point under OpenSlope_Map. Every importer calls this after the map is built (next to pointing the spawn), so the
        // respawn floor always tracks the geometry that's actually loaded (any imported level or a custom map) - instead of a
        // hardcoded per-map value. No-op when there's no VRCSceneDescriptor yet (the world author adds one) or the root is
        // empty. Uses both colliders (what the rider actually contacts) and renderers (catches any visible-but-trigger
        // geometry); the lowest of either wins, since the goal is "never respawn above the bottom of the world".
        public static void SetRespawnHeightFromMap()
        {
            var desc = Object.FindObjectOfType<VRC.SDK3.Components.VRCSceneDescriptor>();
            if (desc == null) return;
            Transform root = ResolveRoot(false);
            if (root == null) return;

            float minY = float.PositiveInfinity;
            Bounds solid = new Bounds(); bool haveSolid = false;
            // SOLID colliders only. A trigger is not the bottom of the world, and one in particular would wreck this: the
            // importer's OOB floor (docs/031) is a thick trigger slab hung under the map, so counting its bounds would drop
            // the respawn line far below where it belongs and leave a walking player falling for an age. The authored reset
            // volumes (water, back-of-course) would skew it the same way, just less. (The floor still gets a say, but
            // through its top FACE, not its bounds - see below.)
            foreach (var c in root.GetComponentsInChildren<Collider>())
            {
                if (c.isTrigger) continue;
                minY = Mathf.Min(minY, c.bounds.min.y);
                if (!haveSolid) { solid = c.bounds; haveSolid = true; } else solid.Encapsulate(c.bounds);
            }
            // Renderers are the fallback, to catch visible-but-trigger geometry the collider pass misses - but only the
            // LEVEL's renderers. The map root also hosts world SYSTEMS whose bounds mean nothing here: Snowfall is a big
            // shader volume hanging ~350 m below the mountain, and counting it dragged the respawn line down with it. If
            // there's no Level node (a custom map), fall back to every renderer under the root.
            Transform geo = root.Find("Level") ?? root;
            foreach (var r in geo.GetComponentsInChildren<Renderer>()) minY = Mathf.Min(minY, r.bounds.min.y);
            if (float.IsInfinity(minY)) return;   // nothing with bounds under the root yet

            // The OOB floor must WIN THE RACE. It's the net that carries a fallen rider back onto the course; VRChat's
            // respawn is the cruder net that yanks them to spawn and off the board. So the respawn line has to sit BELOW
            // the floor, or a rider falling where the floor hangs low would be respawned before ever reaching it - and the
            // floor is TILTED to the mountain, so it hangs several hundred metres lower at the foot of the run than the
            // terrain minimum does. Take the floor's top FACE (not its thick bounds) sampled at the map's XZ corners.
            float floorY = OobFloorMinTopY(root, solid, haveSolid);
            if (!float.IsInfinity(floorY)) minY = Mathf.Min(minY, floorY);

            float respawnY = minY - RespawnMarginBelowMap;
            desc.RespawnHeightY = respawnY;
            EditorUtility.SetDirty(desc);
            Debug.Log($"OpenSlope: RespawnHeightY set to {respawnY:F1} ({RespawnMarginBelowMap:F0} m below the map floor at " +
                      $"y={minY:F1}), so the whole run is reachable without respawning back to spawn.");
        }

        // The LOWEST point of the OOB floor's TOP FACE over the map's own XZ footprint - i.e. the deepest place a falling
        // rider can still be caught by it. +Infinity when there's no floor (a custom map, or EmitOobFloor off).
        //
        // Its top face is a tilted plane (the floor is fitted parallel to the mountain, docs/031), so we evaluate that plane
        // at the four XZ corners of the map's solid bounds and take the lowest. Two things we deliberately do NOT use: the
        // collider's BOUNDS (it's thick, so its min.y says nothing about where you'd actually cross it) and the face's
        // own corners (the slab overhangs the map by a wide margin, and a tilted plane extrapolated that far out plunges
        // arbitrarily low - well past anywhere a rider could be).
        static float OobFloorMinTopY(Transform root, Bounds map, bool haveMap)
        {
            if (!haveMap) return float.PositiveInfinity;
            Transform floor = root.Find("Level/OobFloor") ?? root.Find("OobFloor");
            if (floor == null) return float.PositiveInfinity;
            var box = floor.GetComponent<BoxCollider>();
            if (box == null) return float.PositiveInfinity;

            Vector3 n = floor.transform.up;                                        // the top face's normal
            if (Mathf.Abs(n.y) < 1e-3f) return float.PositiveInfinity;             // edge-on: not a floor, ignore it
            // A point ON the top face: the box centre, half a (world) thickness along the normal.
            Vector3 top = floor.transform.position + n * (box.size.y * floor.transform.lossyScale.y * 0.5f);

            float lowest = float.PositiveInfinity;
            for (int i = 0; i < 4; i++)
            {
                float x = (i & 1) == 0 ? map.min.x : map.max.x;
                float z = (i & 2) == 0 ? map.min.z : map.max.z;
                float y = top.y - (n.x * (x - top.x) + n.z * (z - top.z)) / n.y;   // solve the plane for y at (x, z)
                lowest = Mathf.Min(lowest, y);
            }
            return lowest;
        }

        // Stock VRChat Udon programs (Worlds package: Samples/UdonExampleScene/UdonProgramSources) that configure the things
        // VRChat has NO scene-descriptor field for: player locomotion and avatar-scaling limits. They run once on join and set
        // them on the local player. A fresh scene or a hand-built VRCWorld can be missing them.
        public static readonly string[] WorldSettingsPrograms = { "VRCWorldSettings", "AvatarScalingSettings" };

        // Warn (loudly, with a dialog) if the loaded scene is missing the world-settings behaviour(s) above. On-foot run/walk
        // speed is NOT a field on VRC_SceneDescriptor - it's applied by VRCWorldSettings on the VRCWorld object - so a scene
        // without it silently falls back to VRChat's default 4 m/s run, which is too slow to traverse an OpenSlope mountain on foot
        // (SurfaceDetector already assumes a cranked-up world run speed). Every importer calls this after building so the
        // author finds out at import time, not in-headset. Detection is by program-asset NAME, so it doesn't care whether the
        // behaviour is the stock graph program or an UdonSharp equivalent (e.g. PlayerModSetter). Warning only - never blocks
        // the import; no-op when nothing is missing.
        public static void WarnIfWorldSettingsMissing()
        {
            var present = new System.Collections.Generic.HashSet<string>();
            foreach (var u in Object.FindObjectsOfType<VRC.Udon.UdonBehaviour>(true))
            {
                // Read programSource via SerializedObject so this doesn't depend on the field's access modifier.
                var ps = new SerializedObject(u).FindProperty("programSource");
                if (ps != null && ps.objectReferenceValue != null) present.Add(ps.objectReferenceValue.name);
            }

            var missing = new System.Collections.Generic.List<string>();
            foreach (var name in WorldSettingsPrograms)
                if (!present.Contains(name)) missing.Add(name);
            if (missing.Count == 0) return;

            // LOG-ONLY (no modal dialog): every importer calls this at the end of Import(), and a modal
            // EditorUtility.DisplayDialog here HANGS a programmatic / Unity-MCP-driven import (it blocks the main thread
            // waiting for a click that never comes). A console warning carries the same heads-up without blocking.
            Debug.LogWarning($"OpenSlope: VRCWorld is missing world-settings behaviour(s): {string.Join(", ", missing)}. " +
                "On-foot run/walk speed + avatar scaling fall back to VRChat defaults until they're added. Fix: add the " +
                "missing Udon program(s) to the VRCWorld GameObject (Add Component → Udon Behaviour, Program Source = the " +
                "matching asset under Packages/VRChat SDK - Worlds/Samples/UdonExampleScene/UdonProgramSources), then set " +
                "runSpeed - or drag in a fresh VRCWorld prefab, which brings both along.");
        }

        // The on-foot locomotion Setup All stamps onto VRCWorldSettings. VRChat's stock defaults (walk 2, run 4, strafe 2,
        // jump 3) are too slow/low to traverse an OpenSlope mountain on foot, so the author shouldn't have to hand-edit the
        // VRCWorld inspector on every fresh map. Run is a shade over twice the stock pace, which is the arcade traversal
        // speed a mountain of this scale wants on foot. Walk and strafe are set to HALF run: a gentler pace for precise
        // positioning on ledges, where matching run overshoots.
        //
        // GRAVITY is deliberately left at VRChat default: VRCWorldSettings has no gravity variable, so setting it would need
        // a runtime SetGravityStrength component, and a heavy fall is wrong for a snowboard world. That constrains the jump
        // impulse, and it is why the figure below is lower than the ~6.9 usually quoted for this feel: that number assumes
        // roughly 2x gravity, so at VRChat's default 1x the same impulse launches about twice as high and floaty. 4.77 is
        // sqrt(2 * 9.81 * 1.16) - the impulse reaching a ~1.16 m apex under default gravity. Hang time runs a touch longer
        // than it would under doubled gravity, but jump HEIGHT is the part that matters here, and it matches.
        public const float RunSpeed    = 8.13f;          // ~2x VRChat's stock run: crosses a mountain without feeling like a sprint
        public const float WalkSpeed   = RunSpeed / 2f;  // half run - gentler low-stick / keyboard precision pace (4.065 m/s)
        public const float StrafeSpeed = WalkSpeed;      // = walk (half run): sideways matches the gentler walk pace
        public const float JumpImpulse = 4.77f;          // sqrt(2 * 9.81 * 1.16): a ~1.16 m apex under VRChat-default gravity

        // Stamp the on-foot speeds + jump impulse onto the scene's VRCWorldSettings Udon behaviour (the program that owns
        // player locomotion - there is no VRC_SceneDescriptor field for it). Setup All calls this so a freshly loaded map
        // gets OpenSlope traversal speed with no inspector fiddling. It writes the variable names the stock VRCWorldSettings
        // graph program exposes (walkSpeed/runSpeed/strafeSpeed/jumpImpulse).
        // No-op + the usual missing-program warning when VRCWorldSettings isn't on the VRCWorld yet - this
        // can't create the graph program for you (see WarnIfWorldSettingsMissing). Returns true if it wrote the values.
        public static bool ApplyPlayerLocomotion()
        {
            var ws = FindWorldSettings();
            if (ws == null) { WarnIfWorldSettingsMissing(); return false; }

            SetUdonFloat(ws, "walkSpeed",   WalkSpeed);
            SetUdonFloat(ws, "runSpeed",    RunSpeed);
            SetUdonFloat(ws, "strafeSpeed", StrafeSpeed);
            SetUdonFloat(ws, "jumpImpulse", JumpImpulse);
            EditorUtility.SetDirty(ws);
            if (PrefabUtility.IsPartOfPrefabInstance(ws))
                PrefabUtility.RecordPrefabInstancePropertyModifications(ws);  // persist on the VRCWorld prefab instance
            Debug.Log($"OpenSlope: stamped on-foot locomotion on VRCWorldSettings (walk {WalkSpeed}, run {RunSpeed}, strafe {StrafeSpeed} m/s, jump {JumpImpulse}).");
            return true;
        }

        // The UdonBehaviour running the stock VRCWorldSettings program, or null if it's not in the scene yet. Matched by
        // program-asset NAME (same detection as WarnIfWorldSettingsMissing), so it finds it wherever it sits on the VRCWorld.
        static VRC.Udon.UdonBehaviour FindWorldSettings()
        {
            foreach (var u in Object.FindObjectsOfType<VRC.Udon.UdonBehaviour>(true))
            {
                var ps = new SerializedObject(u).FindProperty("programSource");
                if (ps != null && ps.objectReferenceValue != null && ps.objectReferenceValue.name == "VRCWorldSettings")
                    return u;
            }
            return null;
        }

        // Set a float public variable on a graph UdonBehaviour, adding it if the program doesn't already expose it.
        static void SetUdonFloat(VRC.Udon.UdonBehaviour u, string name, float value)
        {
            if (u.publicVariables.TrySetVariableValue(name, value)) return;
            if (!u.publicVariables.TryAddVariable(new VRC.Udon.Common.UdonVariable<float>(name, value)))
                Debug.LogWarning($"OpenSlope: could not set {name} on {u.programSource.name}.");
        }
    }
}
#endif
