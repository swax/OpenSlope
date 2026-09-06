#if UNITY_EDITOR
using System.Collections.Generic;
using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;
using OpenSlope.Importer;

namespace OpenSlope.BasisPlugin
{

    // Spawns rideable boards (BasisBoard) into a loaded SSX level in the Basis project. The Basis analogue of the
    // VRChat RideableBoardSetup + the start-gate placement, pared to the MVP: no networked dispenser / VRCObjectPool
    // (the VRChat BoardSpawner/Manager/Request pool is not ported) - instead a fixed RACK of ready-to-mount boards
    // stands at the start gate, plus a single board for quick testing. Each board is a BasisSeat, so mounting is
    // Basis's built-in "walk up + interact"; the runtime drives the ride physics.
    //
    // SpawnBoardRackAtGate is called by BasisSetupAll.FinalizeScene, so an Import All / Setup All auto-populates the
    // gate with boards - matching the VRChat world where the start gate is dressed with boards on setup.
    //
    // Boards are built at SCENE ROOT with identity parent on purpose: the ride physics works in world metres, so a board
    // must NOT be parented under OpenSlope_Map/Level (which carries the -90X / 0.01 scale) or the collider + physics distort.
    //
    // Board hierarchy:
    //   <name>                   BasisBoard (BasisSeat) + BoxCollider (interact target + own-collider the ride skips)
    //                            + BasisSeatSync + BasisBoardSync (networked pose/occupancy) + grind-scrape AudioSource
    //    +- Heading              the visible deck's facing/bank pivot (runtime sets its world pose)
    //    |   +- Deck             the extracted board / ski model (a box placeholder when no model is on disk)
    //    +- RiderProbe           a trigger CapsuleCollider whose dims drive the obstacle collide-and-slide sweep
    //    +- GrindSparks          a URP-additive spark ParticleSystem the rail grinding Emit()s off the rail seam
    public static class BasisBoardSetup
    {
        const string BoardName = "BasisBoard";      // the single test board
        const string RackPrefix = "BasisBoard_Gate_"; // the gate rack members
        const int RackCount = 5;                        // boards in the gate rack
        const float RackSpacing = 0.9f;                 // metres between rack boards (across the slope)
        const float RackForwardOffset = 2.0f;           // metres downhill of the spawn, so the player doesn't spawn inside one

        // ---- menus ------------------------------------------------------------------------------------------

        // One board at the player spawn, for quick ride testing.
        [MenuItem("OpenSlope Basis/Setup/Rideable Board at Spawn", false, 130)]
        public static void SpawnBoard()
        {
            Transform spawn = FindSpawn();
            Vector3 basePos = spawn != null ? spawn.position : Vector3.zero;
            Quaternion facing = FacingFrom(spawn);
            Vector3 pos = DropToTerrain(basePos);

            var existing = GameObject.Find(BoardName);
            if (existing != null) Object.DestroyImmediate(existing);

            var go = BuildBoardAt(BoardName, pos, facing, FindCollisionRoot(), ComputeOobFloor());
            Selection.activeGameObject = go;
            EditorSceneManager.MarkSceneDirty(go.scene);
            Debug.Log($"[BasisBoard] Spawned '{BoardName}' at {pos}. Walk up and press interact to ride.");
        }

        // A rack of boards at the start gate (the same placement Setup All runs).
        [MenuItem("OpenSlope Basis/Setup/Board Rack at Gate", false, 131)]
        public static void SpawnBoardRackMenu()
        {
            int n = SpawnBoardRackAtGate();
            if (n > 0) Debug.Log($"[BasisBoard] Placed a rack of {n} board(s) at the start gate. Walk up and press interact to ride.");
            else Debug.LogWarning("[BasisBoard] No gate/spawn anchor found - import a level first (OpenSlope Basis/Load/Map...).");
        }

        // ---- rack placement (also called by BasisSetupAll.FinalizeScene) ---------------------------------

        // Stand a row of ready-to-mount boards at the start gate, centred across the slope and set a little downhill of the
        // spawn so the player lands beside them. Reconciles: any prior rack is removed first, so re-running (or a re-import)
        // never piles boards up. Returns how many were placed (0 if there's no gate/spawn anchor yet).
        public static int SpawnBoardRackAtGate()
        {
            Transform gate = FindGate();
            if (gate == null) return 0;

            Vector3 fwd = FlatForward(gate);
            Quaternion facing = Quaternion.LookRotation(fwd, Vector3.up);
            Vector3 right = Vector3.Cross(Vector3.up, fwd).normalized;
            Vector3 center = gate.position + fwd * RackForwardOffset;

            RemoveRack();
            Transform coll = FindCollisionRoot();
            float oob = ComputeOobFloor();

            GameObject first = null;
            for (int i = 0; i < RackCount; i++)
            {
                float off = (i - (RackCount - 1) * 0.5f) * RackSpacing;   // centred: -1.8, -0.9, 0, 0.9, 1.8 (for 5)
                Vector3 pos = DropToTerrain(center + right * off);
                var go = BuildBoardAt(RackPrefix + i, pos, facing, coll, oob, i);
                if (first == null) first = go;
            }
            if (first != null)
            {
                Selection.activeGameObject = first;
                EditorSceneManager.MarkSceneDirty(first.scene);
            }
            return RackCount;
        }

        // Remove any previously-placed rack boards (so re-running reconciles instead of stacking).
        static void RemoveRack()
        {
            foreach (var b in Object.FindObjectsByType<BasisBoard>(FindObjectsInactive.Include, FindObjectsSortMode.None))
                if (b.gameObject.name.StartsWith(RackPrefix, System.StringComparison.Ordinal))
                    Object.DestroyImmediate(b.gameObject);
        }

        // ---- the shared board build ------------------------------------------------------------------------

        // Build one ride-ready board at a world pose and return it. The Basis analogue of the VRChat BuildBoardAt, pared to
        // the MVP (no station/pool/audio/FX children): a unit-scale ride frame whose BoxCollider is the interact target +
        // the body the ground probe skips, a Heading pivot carrying the visible deck, and the RiderProbe sweep capsule.
        public static GameObject BuildBoardAt(string name, Vector3 pos, Quaternion facing, Transform collisionRoot, float oobFloorY, int poolIndex = 0)
        {
            var go = new GameObject(name);
            Undo.RegisterCreatedObjectUndo(go, "Spawn Rideable Board");
            go.transform.SetPositionAndRotation(pos, facing);

            // Interact target + the body the ride raycasts past (skipped as _ownCollider). Solid so the interact raycast
            // finds it; sized to the deck footprint.
            var box = go.AddComponent<BoxCollider>();
            box.center = new Vector3(0f, 0.08f, 0f);
            box.size = new Vector3(0.44f, 0.16f, 1.5f);

            var board = go.AddComponent<BasisBoard>();
            board.InteractRange = 2.5f;                 // easy to mount from a step away
            board.collisionRoot = collisionRoot;
            board.oobFloorY = oobFloorY;

            // Heading pivot + the visible deck: the real extracted SSX board (or On Tour ski) model wearing a random rider
            // skin, built by BuildBoardVisual. poolIndex spreads the board/ski split evenly across the rack. Models absent
            // (snowknife board/skis output not copied in) -> a thin-box placeholder.
            var pivot = new GameObject("Heading");
            pivot.transform.SetParent(go.transform, false);
            board.headingPivot = pivot.transform;
            BuildBoardVisual(pivot, poolIndex);

            // Rider probe: a trigger capsule whose dims drive the obstacle sweep (not a physics body).
            var probe = new GameObject("RiderProbe");
            probe.transform.SetParent(go.transform, false);
            var cap = probe.AddComponent<CapsuleCollider>();
            cap.isTrigger = true;
            cap.radius = 0.28f;
            cap.height = 1.7f;
            cap.center = new Vector3(0f, 0.92f, 0f); // pelvis: the engine poses its body sphere here, and the
                                                   // capsule is already the same 1.70 m tall, so this aligns the two

            // Grind FX: the spark ParticleSystem + scrape AudioSource the rail grinding drives.
            BuildGrindFx(go, board);

            // Board sound: the glide/carve/boost loop sources (the local rider's own board, so 2D).
            BuildBoardAudio(go, board);

            // Networking companions - the Basis "networked piloted seat" recipe (like BasisNetworkedVehicle): BasisSeatSync
            // broadcasts WHO is sitting + drives each remote rider's avatar onto this moving seat, and BasisBoardSync
            // streams the board's pose (the rider takes ownership on mount). Both are inert offline / single-client, so this
            // doesn't change local riding; they activate once connected.
            var seatSync = go.AddComponent<BasisSeatSync>();
            seatSync.Seat = board;
            var boardSync = go.AddComponent<BasisBoardSync>();
            boardSync.deckPivot = pivot.transform;

            return go;
        }

        // Build the grind FX on a board: a small URP-additive spark ParticleSystem the runtime Emit()s off the rail seam,
        // plus a looping spatial AudioSource for the grind scrape (its clip isn't in the Basis project yet, so it's silent
        // until one is assigned - the runtime rides its volume/pitch on speed regardless).
        static void BuildGrindFx(GameObject boardGo, BasisBoard board)
        {
            var sparksGo = new GameObject("GrindSparks");
            sparksGo.transform.SetParent(boardGo.transform, false);
            var ps = sparksGo.AddComponent<ParticleSystem>();
            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);

            var main = ps.main;
            main.loop = true;
            main.playOnAwake = false;
            main.startLifetime = 0.35f;
            main.startSpeed = 2.2f;
            main.startSize = 0.05f;
            main.startColor = new Color(1f, 0.75f, 0.28f);              // warm orange sparks
            main.gravityModifier = 0.7f;                                // they arc down off the seam
            main.maxParticles = 128;
            main.simulationSpace = ParticleSystemSimulationSpace.World; // trail the moving contact, not the board
            var emission = ps.emission;
            emission.rateOverTime = 0f;                                 // script-driven Emit() only
            var shape = ps.shape;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Cone;
            shape.angle = 18f;
            shape.radius = 0.02f;

            var rend = sparksGo.GetComponent<ParticleSystemRenderer>();
            Shader sh = Shader.Find("OpenSlope/ParticleAdditive");
            if (sh == null) sh = Shader.Find("Universal Render Pipeline/Particles/Unlit");
            if (sh != null) rend.sharedMaterial = new Material(sh);
            rend.renderMode = ParticleSystemRenderMode.Billboard;
            board.sparks = ps;

            var snd = boardGo.AddComponent<AudioSource>();
            snd.playOnAwake = false;
            snd.loop = true;
            snd.spatialBlend = 1f;
            snd.minDistance = 3f;
            snd.maxDistance = 40f;
            snd.rolloffMode = AudioRolloffMode.Linear;
            board.grindSource = snd;
        }

        // Build the board's glide / carve / boost / big-air loop sources - the local rider's OWN board sound, so they're 2D (you always
        // hear your own board, like footsteps; a remote board never mounts locally so these never play for it). Loops with no
        // clip assigned (the extracted snow-audio banks aren't in the Basis project yet) - the runtime drives volume/pitch on
        // the ride signals, so dropping the clips into glideClips/carveClips/boostClip makes it sound with no code change.
        static void BuildBoardAudio(GameObject boardGo, BasisBoard board)
        {
            board.glideSource = AddLoop2D(boardGo);
            board.carveSource = AddLoop2D(boardGo);
            board.boostSource = AddLoop2D(boardGo);
            board.bigAirWindSource = AddLoop2D(boardGo);
            string bigAirFolder = MapLayout.SharedFolder + "/Audio/SFX/zbxsfx/";
            string bigAirPath = bigAirFolder + "032.loop.wav";
            board.bigAirWindClip = AssetDatabase.LoadAssetAtPath<AudioClip>(bigAirPath);
            if (board.bigAirWindClip == null)
            {
                bigAirPath = bigAirFolder + "032.wav";
                board.bigAirWindClip = AssetDatabase.LoadAssetAtPath<AudioClip>(bigAirPath);
            }
            if (board.bigAirWindClip == null)
                Debug.LogWarning($"OpenSlope: Basis big-air wind clip not found: {bigAirPath} " +
                                 "(run `snowknife shared` to decode MAIN/032).");
        }

        // A 2D looping AudioSource (silent until the runtime raises its volume and a clip is present).
        static AudioSource AddLoop2D(GameObject go)
        {
            var s = go.AddComponent<AudioSource>();
            s.playOnAwake = false;
            s.loop = true;
            s.spatialBlend = 0f;   // 2D: the local rider's own board
            s.volume = 0f;
            return s;
        }

        // ---- the visible deck: real extracted SSX board / On Tour ski model + rider skin -------------------
        //
        // Ported from the VRChat RideableBoardSetup.BuildBoardVisual (docs/vrchat/017/018): the game's own snowboard model
        // (three real deck SHAPES, board_Al/Bx/Fr.obj from `snowknife board`) or a pair of On Tour skis (ski_SkisA/P_H.obj
        // from `snowknife skis`), wearing a RANDOM rider 'bord' skin (or brand 'skis' skin), so the gate rack fills with a
        // variety of recognisable SSX boards. Same axis remap + world scale as VRChat; the material is the URP
        // OpenSlope/UnlitDoubleSided (the skins are baked-lit, like the terrain) rather than VRChat's built-in-RP BoardProbeLit.
        // The board physics ignores the deck (it runs in absolute world metres), so this is purely cosmetic and the
        // board/ski choice never changes handling. Models absent (the snowknife output isn't under Assets/OpenSlope/Maps/Shared/chars)
        // -> a thin box placeholder.

        const string DeckName = "Deck";
        static readonly string[] BoardModels =
        {
            MapLayout.SharedFolder + "/chars/board_Al.obj",
            MapLayout.SharedFolder + "/chars/board_Bx.obj",
            MapLayout.SharedFolder + "/chars/board_Fr.obj",
        };
        const string BoardTexFolder = MapLayout.SharedFolder + "/chars/BoardTextures";
        const string BoardMatFolder = MapLayout.SharedFolder + "/chars/BoardMaterials";  // URP .mat generated per skin we pick
        static readonly string[] SkiModels =
        {
            MapLayout.SharedFolder + "/chars/ski_SkisA_H.obj",
            MapLayout.SharedFolder + "/chars/ski_SkisP_H.obj",
        };
        const string SkiTexFolder  = MapLayout.SharedFolder + "/chars/SkiTextures";
        const string SkiMatFolder  = MapLayout.SharedFolder + "/chars/SkiMaterials";
        const string SkiMeshFolder = MapLayout.SharedFolder + "/chars/SkiMeshes";        // split left/right ski half-meshes (shared)
        const string DeckShader = "OpenSlope/UnlitDoubleSided";   // URP unlit double-sided (skins are baked-lit)
        const float BoardModelScale = 0.01f;                // m per SSX unit (= ImportConfig.WorldScale) - game-true size
        const float SkiRestBankDeg = 90f;                   // rest pre-bank about each ski's long axis (neutral = flat, tips up)
        const float SkiSpawnChance = 0.5f;                  // fraction of the pool that comes up skis when ski models exist
        static readonly Vector3 FallbackDeckSize = new Vector3(0.32f, 0.06f, 1.5f); // thin box if no models on disk
        static readonly HashSet<string> SkinExclude = new HashSet<string> { "mallora", "mmm1" }; // announcer/test atlases
        static string[] _boardSkins, _skiSkins;

        // Build the visible deck under the Heading pivot. Board or ski by an even split across the pool index (so any rack
        // prefix is a mix, not a run of one kind). No model on disk -> a thin box placeholder.
        static void BuildBoardVisual(GameObject frame, int poolIndex)
        {
            bool skisOk = AnyAssetExists(SkiModels);
            bool boardsOk = AnyAssetExists(BoardModels);
            bool wantSki = Mathf.FloorToInt((poolIndex + 1) * SkiSpawnChance) > Mathf.FloorToInt(poolIndex * SkiSpawnChance);
            bool useSki = skisOk && (!boardsOk || wantSki);
            if (useSki && BuildSkiVisual(frame)) return;

            string modelPath = BoardModels[Random.Range(0, BoardModels.Length)];
            Mesh mesh = LoadBoardMesh(modelPath, out Material objMat);

            var deck = new GameObject(DeckName);
            deck.transform.SetParent(frame.transform, false);
            var mf = deck.AddComponent<MeshFilter>();
            var mr = deck.AddComponent<MeshRenderer>();
            var deckMat = PickRandomBoardSkin() ?? objMat;   // a random rider deck skin, else the model's own material

            if (mesh == null)
            {
                // Fallback: a thin box, still a child so the frame stays unit scale.
                var prim = GameObject.CreatePrimitive(PrimitiveType.Cube);
                mf.sharedMesh = prim.GetComponent<MeshFilter>().sharedMesh;
                mr.sharedMaterial = deckMat != null ? deckMat : prim.GetComponent<MeshRenderer>().sharedMaterial;
                Object.DestroyImmediate(prim);
                deck.transform.localScale = FallbackDeckSize;
                deck.transform.localPosition = new Vector3(0f, 0.05f, 0f);
                Debug.LogWarning("Basis: deck model not found - using a box placeholder. Copy the snowknife board/skis " +
                                 "output into Assets/OpenSlope/Maps/Shared/chars (board_*.obj + BoardTextures, ski_*_H.obj + SkiTextures).");
                return;
            }

            mf.sharedMesh = mesh;
            if (deckMat != null) mr.sharedMaterial = deckMat;

            // Axis remap mesh -> ride frame: length->forward, width->right, thickness->up. SSX authors the deck NOSE toward
            // model -X, so length maps to ride -Z (nose forward) and width to -X to keep this a pure 180-yaw (det +1, no
            // skin mirror). Verbatim from the VRChat deck build.
            var m = new Matrix4x4();
            m.SetColumn(0, new Vector4(0, 0, -1, 0)); // model X (length)    -> ride -Z (nose forward)
            m.SetColumn(1, new Vector4(-1, 0, 0, 0)); // model Y (width)     -> ride -X
            m.SetColumn(2, new Vector4(0, 1, 0, 0));  // model Z (thickness) -> ride +Y (up)
            m.SetColumn(3, new Vector4(0, 0, 0, 1));
            deck.transform.localRotation = m.rotation;
            float s = BoardModelScale;                // game-true size (raw SSX cm -> metres), same world scale as everything
            deck.transform.localScale = new Vector3(s, s, s);
            deck.transform.localPosition = -s * m.MultiplyVector(mesh.bounds.center); // recentre the model on the frame
        }

        // Build a pair of skis under the Heading pivot as two half-meshes on their own "SkiBank_L/R" pivots (the rig the
        // runtime rolls for the per-ski carve edge). The On Tour ski model holds both skis in one mesh, split across the
        // model's WIDTH (model Z). Returns false if the model/geometry can't be built (caller falls back to a board).
        // Verbatim from the VRChat BuildSkiVisual, minus the wake footprint (the Basis board has no wake).
        static bool BuildSkiVisual(GameObject frame)
        {
            string modelPath = SkiModels[Random.Range(0, SkiModels.Length)];
            Mesh mesh = LoadBoardMesh(modelPath, out Material objMat);
            if (mesh == null) return false;

            var deckMat = PickRandomSkiSkin() ?? objMat;

            // Ski axis remap: model length(X)->ride -Z (nose forward), up(Y)->+Y, width(Z)->+X. det +1 (no skin mirror).
            var R = new Matrix4x4();
            R.SetColumn(0, new Vector4(0, 0, -1, 0));
            R.SetColumn(1, new Vector4(0, 1, 0, 0));
            R.SetColumn(2, new Vector4(1, 0, 0, 0));
            R.SetColumn(3, new Vector4(0, 0, 0, 1));

            float zMid = (mesh.bounds.min.z + mesh.bounds.max.z) * 0.5f; // gap between the two skis
            Mesh leftMesh  = GetOrCreateSkiHalf(modelPath, mesh, zMid, true);
            Mesh rightMesh = GetOrCreateSkiHalf(modelPath, mesh, zMid, false);
            if (leftMesh == null || rightMesh == null || leftMesh.vertexCount == 0 || rightMesh.vertexCount == 0) return false;

            Vector3 pairCenterRide = R.MultiplyPoint3x4(mesh.bounds.center);
            BuildOneSki(frame.transform, "SkiBank_L", leftMesh,  R, pairCenterRide, deckMat);
            BuildOneSki(frame.transform, "SkiBank_R", rightMesh, R, pairCenterRide, deckMat);
            return true;
        }

        // One ski: a roll pivot on that ski's centreline carrying a "Deck" with the half-mesh centred on the pivot origin,
        // pre-banked flat about the ski's long axis. Verbatim from the VRChat BuildOneSki; the ride loop rolls the SkiBank
        // pivot for the per-ski carve edge.
        static void BuildOneSki(Transform heading, string name, Mesh half, Matrix4x4 R, Vector3 pairCenterRide, Material mat)
        {
            float s = BoardModelScale;
            Vector3 centerRide = R.MultiplyPoint3x4(half.bounds.center);

            var pivot = new GameObject(name);
            pivot.transform.SetParent(heading, false);
            pivot.transform.localPosition = s * (centerRide - pairCenterRide);
            pivot.transform.localRotation = Quaternion.identity;

            var deck = new GameObject(DeckName);
            deck.transform.SetParent(pivot.transform, false);
            deck.AddComponent<MeshFilter>().sharedMesh = half;
            var mr = deck.AddComponent<MeshRenderer>();
            if (mat != null) mr.sharedMaterial = mat;
            Quaternion preBank = Quaternion.AngleAxis(SkiRestBankDeg, Vector3.forward);
            deck.transform.localRotation = preBank * R.rotation;
            deck.transform.localScale = new Vector3(s, s, s);
            deck.transform.localPosition = -s * (preBank * centerRide);
        }

        // Get-or-create one half of a ski mesh (split at the width midpoint), saved as a shared asset so all spawned skis
        // reference the same two sub-meshes. Null if the split yields nothing.
        static Mesh GetOrCreateSkiHalf(string modelPath, Mesh full, float zMid, bool left)
        {
            string id = System.IO.Path.GetFileNameWithoutExtension(modelPath) + (left ? "_L" : "_R");
            string path = SkiMeshFolder + "/" + id + ".asset";
            var existing = AssetDatabase.LoadAssetAtPath<Mesh>(path);
            if (existing != null) return existing;

            Mesh m = SplitSkiMesh(full, zMid, left);
            if (m == null) return null;
            m.name = id;
            EnsureFolder(SkiMeshFolder);
            AssetDatabase.CreateAsset(m, path);
            return m;
        }

        // Build a mesh from the triangles of `src` on one side of `zMid` along model Z. Vertices/UVs/normals copied and
        // re-indexed compactly. Null if no triangles qualify. Verbatim from the VRChat splitter.
        static Mesh SplitSkiMesh(Mesh src, float zMid, bool left)
        {
            Vector3[] sv = src.vertices;
            Vector2[] su = src.uv;
            Vector3[] sn = src.normals;
            int[] st = src.triangles;
            bool hasUv = su != null && su.Length == sv.Length;
            bool hasN  = sn != null && sn.Length == sv.Length;

            var nv = new List<Vector3>();
            var nu = new List<Vector2>();
            var nn = new List<Vector3>();
            var nt = new List<int>();
            var map = new Dictionary<int, int>();

            for (int t = 0; t + 2 < st.Length; t += 3)
            {
                int a = st[t], b = st[t + 1], c = st[t + 2];
                float cz = (sv[a].z + sv[b].z + sv[c].z) / 3f;
                if ((cz < zMid) != left) continue;
                nt.Add(RemapVertex(a, sv, su, sn, hasUv, hasN, nv, nu, nn, map));
                nt.Add(RemapVertex(b, sv, su, sn, hasUv, hasN, nv, nu, nn, map));
                nt.Add(RemapVertex(c, sv, su, sn, hasUv, hasN, nv, nu, nn, map));
            }
            if (nv.Count == 0) return null;

            var m = new Mesh();
            m.SetVertices(nv);
            if (hasUv) m.SetUVs(0, nu);
            if (hasN) m.SetNormals(nn);
            m.SetTriangles(nt, 0);
            if (!hasN) m.RecalculateNormals();
            m.RecalculateBounds();
            return m;
        }

        static int RemapVertex(int idx, Vector3[] sv, Vector2[] su, Vector3[] sn, bool hasUv, bool hasN,
                               List<Vector3> nv, List<Vector2> nu, List<Vector3> nn, Dictionary<int, int> map)
        {
            if (map.TryGetValue(idx, out int ni)) return ni;
            ni = nv.Count;
            nv.Add(sv[idx]);
            if (hasUv) nu.Add(su[idx]);
            if (hasN) nn.Add(sn[idx]);
            map[idx] = ni;
            return ni;
        }

        static bool AnyAssetExists(string[] paths)
        {
            foreach (var p in paths)
                if (AssetDatabase.LoadMainAssetAtPath(p) != null) return true;
            return false;
        }

        // First Mesh + first Material sub-asset of an exported board OBJ (null if it hasn't been imported).
        static Mesh LoadBoardMesh(string modelPath, out Material mat)
        {
            mat = null;
            var objs = AssetDatabase.LoadAllAssetsAtPath(modelPath);
            if (objs == null) return null;
            Mesh mesh = null;
            foreach (var o in objs)
            {
                if (mesh == null && o is Mesh me) mesh = me;
                if (mat  == null && o is Material ma) mat = ma;
            }
            return mesh;
        }

        static Material PickRandomBoardSkin() => PickRandomSkin(BoardSkinIds(), BoardTexFolder, BoardMatFolder);
        static Material PickRandomSkiSkin()   => PickRandomSkin(SkiSkinIds(),   SkiTexFolder,   SkiMatFolder);

        static Material PickRandomSkin(string[] skins, string texFolder, string matFolder)
        {
            if (skins.Length == 0) return null;
            return GetOrCreateDeckMaterial(skins[Random.Range(0, skins.Length)], texFolder, matFolder);
        }

        static string[] BoardSkinIds() => _boardSkins ??= EnumerateSkinIds(BoardTexFolder, SkinExclude);
        static string[] SkiSkinIds()   => _skiSkins   ??= EnumerateSkinIds(SkiTexFolder, null);

        static string[] EnumerateSkinIds(string texFolder, HashSet<string> exclude)
        {
            var ids = new List<string>();
            if (AssetDatabase.IsValidFolder(texFolder))
            {
                foreach (var guid in AssetDatabase.FindAssets("t:Texture2D", new[] { texFolder }))
                {
                    string p = AssetDatabase.GUIDToAssetPath(guid);
                    if (!p.EndsWith(".png", System.StringComparison.OrdinalIgnoreCase)) continue;
                    string id = System.IO.Path.GetFileNameWithoutExtension(p);
                    if (exclude == null || !exclude.Contains(id)) ids.Add(id);
                }
                ids.Sort(System.StringComparer.Ordinal);
            }
            return ids.ToArray();
        }

        // Get-or-create a URP material for one deck skin: <texFolder>/<id>.png on OpenSlope/UnlitDoubleSided, saved to
        // <matFolder>/<id>.mat so every deck wearing that skin shares one material. Null (with a warning) if the texture
        // isn't imported or the shader is missing. Heals a stale shader ref on an existing .mat (renders pink otherwise).
        static Material GetOrCreateDeckMaterial(string id, string texFolder, string matFolder)
        {
            string matPath = matFolder + "/" + id + ".mat";
            var existing = AssetDatabase.LoadAssetAtPath<Material>(matPath);
            if (existing != null)
            {
                var cur = Shader.Find(DeckShader);
                if (cur != null && existing.shader != cur) { existing.shader = cur; EditorUtility.SetDirty(existing); }
                return existing;
            }

            var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(texFolder + "/" + id + ".png");
            if (tex == null)
            {
                Debug.LogWarning($"Basis: deck skin '{id}.png' not in {texFolder} - using the model default material.");
                return null;
            }
            var shader = Shader.Find(DeckShader);
            if (shader == null) { Debug.LogWarning($"Basis: shader '{DeckShader}' not found - deck skin not built."); return null; }

            EnsureFolder(matFolder);
            var mat = new Material(shader) { name = id };
            mat.mainTexture = tex;   // -> _MainTex on OpenSlope/UnlitDoubleSided
            AssetDatabase.CreateAsset(mat, matPath);
            return mat;
        }

        // Make sure an Assets-relative folder exists as a Unity asset folder, creating any missing parents.
        static void EnsureFolder(string assetFolder)
        {
            if (AssetDatabase.IsValidFolder(assetFolder)) return;
            string parent = System.IO.Path.GetDirectoryName(assetFolder).Replace('\\', '/');
            string leaf   = System.IO.Path.GetFileName(assetFolder);
            if (!AssetDatabase.IsValidFolder(parent)) EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, leaf);
        }

        // ---- anchors + helpers -----------------------------------------------------------------------------

        // The player spawn (top-of-run), else a generic Spawn anchor.
        static Transform FindSpawn()
        {
            var go = GameObject.Find("OpenSlope_Map/Locations/PlayerSpawn");
            if (go != null) return go.transform;
            go = GameObject.Find("OpenSlope_Map/Locations/Spawn");
            return go != null ? go.transform : null;
        }

        // The start gate anchor (where the rack stands), falling back to the player spawn (the importer sets both to the
        // same top-of-run pose).
        static Transform FindGate()
        {
            var go = GameObject.Find("OpenSlope_Map/Locations/GateSpawn");
            return go != null ? go.transform : FindSpawn();
        }

        static Transform FindCollisionRoot()
        {
            var go = GameObject.Find("OpenSlope_Map/Collision");
            return go != null ? go.transform : null;
        }

        // A horizontal downhill facing from an anchor's forward (never a zero/vertical vector).
        static Vector3 FlatForward(Transform anchor)
        {
            Vector3 f = anchor != null ? Vector3.ProjectOnPlane(anchor.forward, Vector3.up) : Vector3.forward;
            return f.sqrMagnitude > 1e-4f ? f.normalized : Vector3.forward;
        }

        static Quaternion FacingFrom(Transform anchor) => Quaternion.LookRotation(FlatForward(anchor), Vector3.up);

        // Drop a world point onto the TERRAIN under it, lifting by the board's hover height. Falls back to the point itself
        // if nothing is hit. Uses RaycastAll and PREFERS a hit under OpenSlope_Map/Collision (the terrain surfaces): a plain
        // downward ray at the start gate lands on the gate prop's OWN bounce collider (PropsCollision_*), ~5 m above the
        // snow, which floats the rack up on the gate "roof" (only a board off to the side, clear of the gate footprint,
        // reaches the snow). Prefer the terrain hit; else the LOWEST hit (terrain always sits below any props); else the
        // point itself. The ray starts well above any gate structure so it can't begin inside the prop. Ported from the
        // VRChat StartGateSetup.GroundYTerrain.
        static Vector3 DropToTerrain(Vector3 p)
        {
            Vector3 start = p + Vector3.up * 60f; // above any gate structure, so the ray can't begin below its roof
            var hits = Physics.RaycastAll(start, Vector3.down, 500f);
            if (hits == null || hits.Length == 0) return p;
            System.Array.Sort(hits, (a, b) => a.distance.CompareTo(b.distance));

            Transform coll = FindCollisionRoot();
            if (coll != null)
                foreach (var h in hits)
                    for (Transform t = h.collider.transform; t != null; t = t.parent)
                        if (t == coll) return h.point + Vector3.up * 0.12f; // hoverHeight

            return hits[hits.Length - 1].point + Vector3.up * 0.12f; // lowest hit = the terrain under any props
        }

        // A world Y safely below the whole imported level, so a board that falls off the world resets. Combines the
        // renderer bounds under OpenSlope_Map; returns a very low sentinel (floor check off) if nothing is found.
        static float ComputeOobFloor()
        {
            var map = GameObject.Find("OpenSlope_Map");
            if (map == null) return -1e9f;
            var rends = map.GetComponentsInChildren<Renderer>();
            if (rends == null || rends.Length == 0) return -1e9f;
            float minY = float.PositiveInfinity;
            foreach (var r in rends) if (r.bounds.min.y < minY) minY = r.bounds.min.y;
            return float.IsInfinity(minY) ? -1e9f : minY - 50f;
        }
    }
}
#endif
