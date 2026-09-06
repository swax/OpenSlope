#if UNITY_EDITOR
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UdonSharp;
using UdonSharpEditor;
using VRC.SDK3.Components;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{
    // NOTE: deliberately NOT `using VRC.SDKBase` - it also defines VRCStation, which would make the VRCStation below
    // ambiguous against VRC.SDK3.Components.VRCStation. VRCPickup inherits its AutoHold/orientation enums, so we reach
    // them through the derived type instead.

    // Shared board-builder for the rideable snowboard (docs/vrchat/017, docs/018). Not a menu step of its own: the
    // start gate (StartGateSetup, 'OpenSlope/Setup/Start Gate Boards') builds each board through BuildBoardAt here.
    // The runtime is RideableBoard (UdonSharp). BuildBoardAt produces a ready-to-ride GameObject - the exported SSX
    // board model under a unit-scale ride frame (a BoxCollider that is both the Interact gaze target and the body the
    // board raycasts past), a configured VRCStation, and the Udon component wired to the station + terrain root.
    //
    // Kept at SCENE ROOT with identity scale on purpose: the board works in world space, so callers must NOT parent it
    // under the scaled level node (which carries the -90 X / 0.01 scale, docs/unity/004) or the box would be crushed and the physics distorted.
    //
    // The Udon-attach dance (program asset must exist before AddUdonSharpComponent; first run creates+compiles it and
    // stops, second run attaches) is handled by EnsureProgramAsset, the same recipe as MusicDirectorSetup (docs/vrchat/013).
    public static class RideableBoardSetup
    {
        const string PivotName = "Heading";
        const string DeckName  = "Deck";

        // The visible deck is the game's own snowboard model + skin, extracted by `snowknife board` (docs/018): the three
        // real deck SHAPES, plus the per-rider 'bord' skins. Each spawn picks a RANDOM deck shape and a RANDOM rider's
        // skin, so the start gate fills with a variety of recognisable SSX boards. The deck UVs already map onto the
        // 'bord' atlas, so the skin lands correctly. Absent (CLI not run) -> a thin box fallback.
        static readonly string[] BoardModels =
        {
            MapLayout.SharedFolder + "/chars/board_Al.obj",
            MapLayout.SharedFolder + "/chars/board_Bx.obj",
            MapLayout.SharedFolder + "/chars/board_Fr.obj",
        };
        const string BoardTexFolder = MapLayout.SharedFolder + "/chars/BoardTextures";  // <id>.png decoded from TEXPS2.BIG
        const string BoardMatFolder = MapLayout.SharedFolder + "/chars/BoardMaterials"; // one generated .mat per skin we pick
        const string BoardShader    = "OpenSlope/BoardProbeLit";                    // probe-lit deck: darkens in shade with the rider (docs/unity/010)
        // The board model is exported in raw SSX units (cm, 100 u = 1 m). Scale each deck by that same world scale as all
        // other geometry, so it keeps its TRUE in-game size (the decks are genuinely different shapes/sizes, not LODs).
        // The decks are bigger than the fixed BoardColliderSize gaze/ray box - intentional (size is cosmetic; the physics
        // works in absolute world metres and ignores deck scale).
        const float  BoardModelScale = 0.01f; // m per SSX unit (= ImportConfig.WorldScale)
        static readonly Vector3 BoardColliderSize = new Vector3(0.30f, 0.12f, 1.60f); // ~footprint, forward = +Z
        // VRChat's Pickup layer (13). The one layer property that matters here: Pickup does NOT collide with the Player
        // layers, and Default DOES - so a board on Default shoves the player whose capsule it overlaps. See BuildBoardAt.
        const int PickupLayer = 13;

        // The runtime random pool = EVERY extracted rider skin under BoardTexFolder (the 144 boards `snowknife board`
        // decodes) minus the two non-rider specials. Enumerated from disk (BoardSkinIds) so it tracks whatever was
        // decoded, and cached after first use.
        static readonly System.Collections.Generic.HashSet<string> SkinExclude =
            new System.Collections.Generic.HashSet<string> { "mallora", "mmm1" }; // announcer/test atlases, not rider decks
        static string[] _boardSkins; // cached list of skin ids (cleared on domain reload / recompile)

        // SKIS (SSX On Tour, `snowknife skis`): the same spawn flow can dress the ride frame as a pair of skis instead of a
        // snowboard. Skis ride IDENTICALLY (the physics ignores the deck), so this is purely the visible model + skin: the
        // On Tour ski 'vehicle' decks (ski_SkisA/P_H.obj) wearing a brand 'skis' atlas from SkiTextures. Present only if
        // `snowknife skis ssx-on-tour.iso Assets/OpenSlope/Maps/Shared/chars` was run; absent -> the pool stays boards-only (backward compatible).
        static readonly string[] SkiModels =
        {
            MapLayout.SharedFolder + "/chars/ski_SkisA_H.obj",
            MapLayout.SharedFolder + "/chars/ski_SkisP_H.obj",
        };
        const string SkiTexFolder = MapLayout.SharedFolder + "/chars/SkiTextures";  // skis_<brand>_NNN.png decoded from TEXPS2.BIG
        const string SkiMatFolder = MapLayout.SharedFolder + "/chars/SkiMaterials"; // one generated .mat per ski skin we pick
        const string SkiMeshFolder = MapLayout.SharedFolder + "/chars/SkiMeshes";   // the split left/right ski half-meshes (shared assets)
        // Pre-bank (deg) baked into each ski's REST pose, about its own long axis - so neutral (carve bank 0) sits FLAT,
        // top-sheet up with the tips curling UP (the raw model lies on its edge, tips down). +90 verified correct by the
        // tip-curl geometry; the runtime's per-ski carve roll adds ON TOP of this. Flip the sign / zero it to re-tune.
        const float SkiRestBankDeg = 90f; // about the forward (length) axis
        // Fraction of the pool that comes up SKIS rather than a snowboard, when ski models are present (both kinds in the
        // pool): 0 = never skis, 1 = always skis, 0.5 = an even mix. Applied as an EVEN split across the pool index (not an
        // independent per-board roll), so the gate - which dispenses the lowest-index boards in order - always shows a mix.
        const float SkiSpawnChance = 0.5f;
        static string[] _skiSkins; // cached list of ski skin ids (cleared on domain reload / recompile)

        // Generated board-FX materials (snow/wake/spark particle materials) live here - a NEUTRAL library folder (created
        // on demand), so the board builds in any world without an Assets/OpenSlope/Maps data tree. The sprites they reference are
        // optional shared content from `snowknife shared` (SnowSprite/SparkSprite below) - absent in a clean world, the material just renders untextured.
        const string MatFolder = Map.GeneratedFolder;
        const string SnowMatPath = MatFolder + "/ssx_snow_particle.mat"; // shared soft-white material for the snow FX
        static Material _snowMat;                                          // cached so all boards share one snow material
        const string SnowSprite  = MapLayout.SharedFolder + "/Textures/Particles/clod.png"; // the game's soft snow-burst 'clod' (docs/unity/014)
        const string WakeMatPath = MatFolder + "/ssx_board_wake_mesh.mat"; // shared material for the carved-snow wake ribbon
        const string WakeShader  = "OpenSlope/WakeRibbon";                       // unlit vertex-colour alpha shader the wake mesh draws with
        static Material _wakeMat;                                          // cached so all boards share one wake material
        const string SparkMatPath = MatFolder + "/ssx_rail_spark.mat";    // shared additive material for the grind sparks
        const string SparkSprite = MapLayout.SharedFolder + "/Textures/Particles/str3.png"; // the game's 4-point twinkle for grind sparks (docs/unity/014)
        static Material _sparkMat;                                         // cached so all boards share one spark material

        // Board-snow SFX, decoded from the game's SHARED zboard.bnk (docs/015). It's level-independent, so `snowknife shared`
        // exports it to Assets/OpenSlope/Maps/Shared/Audio/SFX/zboard/NNN.wav (gitignored). The GLIDE/CARVE loops live at
        // zboard[group*8+4] / [group*8+3]; 9 of the 10 groups are wired (RAIL stays the grind path's own GrindWav),
        // ordered to match AudioGroupFor: [0]=PACK [1]=POWDER [2]=ICE [3]=ROCK [4]=CHUTE [5]=WOOD (the bridge-deck
        // planks, SurfaceType 12) [6]=METAL (13, the rail-scrape row) [7]=GLASS (14) [8]=LOOSE (off-track 2).
        const string SharedAudio = MapLayout.SharedFolder + "/Audio"; // the level-independent board carve bank (snowknife shared)
        static readonly string[] GlideWavs = { "004", "012", "028", "060", "076", "044", "036", "068", "020" }; // group*8+4
        static readonly string[] CarveWavs = { "003", "011", "027", "059", "075", "043", "035", "067", "019" }; // group*8+3
        // Traced primary-rider BOARD-family transients: +2 on air entry, +1 on landing/contact.
        const string OllieWav = "002";
        const string LandWav  = "001";
        // Grind scrape loop: the zboard RAIL group's glide loop (group 6 -> slot 052), the continuous metal slide
        // (docs/026). First-guess - swap to 051 (the RAIL carve/edge loop) by ear.
        const string GrindWav = "052";
        // Boost-engage WHOOSH: the SSX held-boost 'Boost' sound. It lives in the global MAIN bank (zbxsfx, NOT zboard) at
        // slots 120/121/122 - the three boost-meter tiers (full/mid/low) the game picks between
        // ([Trailmap: 420-audio-runtime]). zbxsfx is a SHARED bank (snowknife shared), so it sits beside zboard under
        // Assets/OpenSlope/Maps/Shared/Audio/SFX/zbxsfx/. Order matches boostClips: [0]=120 full, [1]=121 mid, [2]=122 low.
        static readonly string[] BoostWavs = { "120", "121", "122" };
        const string BigAirWindWav = "032"; // focused-rider >1.5 s flight loop, MAIN bank; not map ambience

        // Build a complete, ride-ready board at a world pose and return it (one per start-gate post). Keep the caller at
        // scene root or under an identity-scale parent - never under the scaled level node's -90X/0.01 scale (docs/unity/004).
        //
        // The ride frame is a UNIT-scale GameObject whose BoxCollider is the Interact target + the body the board
        // raycasts past. The visible deck is a child under the "Heading" pivot so the frame can carry the downhill facing
        // + a non-distorting unit scale while the deck holds its own model orientation/scale (a non-uniform scale here
        // would shear the rotated mesh). The Heading pivot carries the VISIBLE board's facing/bank, kept separate from
        // the seat (the frame, which holds an upright, stable orientation).
        //
        // REQUIRES the RideableBoard Udon program asset to already exist - call EnsureProgramAsset first and bail on
        // the first-time create like StartGateSetup does.
        public static GameObject BuildBoardAt(string boardName, Vector3 pos, Quaternion facing, Transform collisionRoot, int poolIndex)
        {
            var go = new GameObject(boardName);
            var box = go.AddComponent<BoxCollider>();
            box.size = BoardColliderSize;
            go.transform.SetPositionAndRotation(pos, facing);

            var pivot = new GameObject(PivotName);
            pivot.transform.SetParent(go.transform, false);
            Vector2 deckFootprint = BuildBoardVisual(pivot, poolIndex); // (width, length) m of the real deck, for the wake width

            // Rider trigger PROBE: an invisible capsule where the standing rider's body actually is. Two problems it
            // solves - the deck box is thin and rides at ankle height (it can miss a volume), and while you're a VRCStation
            // passenger VRChat stops raising OnPlayerTriggerEnter (you're carried, not walking a capsule through anything),
            // so the firework / crash-bag volumes go silent on the board. This capsule sweeps those same volumes; their
            // Udon detects it via its RideableBoard parent + IsRiding. Kinematic Rigidbody so the sweep raises trigger
            // events without PhysX integrating it; Ignore Raycast layer so the board's own down-ray never grabs it. See docs/vrchat/017.
            var probe = new GameObject("RiderProbe");
            probe.transform.SetParent(go.transform, false);
            probe.layer = 2; // Ignore Raycast - out of Physics.RaycastAll's default mask, still collides for triggers
            var cap = probe.AddComponent<CapsuleCollider>();
            cap.isTrigger = true;
            cap.direction = 1;                       // upright (Y)
            cap.radius = 0.30f;
            cap.height = 1.70f;
            cap.center = new Vector3(0f, 0.92f, 0f); // pelvis: the engine poses its body sphere here, and the
                                                   // capsule is already the same 1.70 m tall, so this aligns the two // base at the deck, reaching ~1.7 m up where the standing rider is
            var prb = probe.AddComponent<Rigidbody>();
            prb.isKinematic = true;                  // PhysX never integrates it; we move it by carrying the board
            prb.useGravity = false;
            prb.collisionDetectionMode = CollisionDetectionMode.ContinuousSpeculative; // catch fast passes of thin volumes

            // The station the rider locks into. ImmobilizeForVehicle (NOT plain Immobilize): this board is a MOVING
            // station - we teleport the station transform every frame to carry the rider - and ImmobilizeForVehicle is
            // VRChat's mode tuned for exactly that (plain Immobilize is documented for static chairs/beds and desyncs the
            // rider from a per-frame-moved station, e.g. the board locking up when you open the menu). Either way it pins
            // the avatar so walking doesn't fight us. DISABLE the built-in exit (else VRChat lets an immobilized player
            // "struggle out" on movement input, so WASD ejects you instead of steering); RideableBoard owns the
            // dismount (Jump -> ExitStation).
            var station = go.AddComponent<VRCStation>();
            station.PlayerMobility = VRCStation.Mobility.ImmobilizeForVehicle;
            station.disableStationExit = true;
            station.canUseStationFromStation = false;
            // seated = false -> the rider STANDS on the board (VRChat keeps them upright with feet planted, upper body
            // driven by their own head/hand IK), not the default sitting pose. The immobilize still pins them; we hand-move
            // the station transform each frame to carry them down the hill. (A custom Animator Controller for a sideways
            // stance won't work here - the station ignores the clip's root rotation and standing-mode IK owns the
            // legs; only full-body-tracking riders stand sideways. See docs/vrchat/022.)
            station.seated = false;

            // Chase-view test seat: the transform the station places the rider at. Built at the board origin (= normal
            // first-person); RideableBoard.ApplyChaseSeat moves it up+behind when chaseCamSeat is on, so the runtime
            // flag is a pure toggle. The board's physics origin is never moved, so handling is identical either way.
            var seat = new GameObject("SeatPoint");
            seat.transform.SetParent(go.transform, false);
            station.stationEnterPlayerLocation = seat.transform;

            // GRAB: the same box the trigger mounts, the grip carries. VRChat routes the two actions apart on its own -
            // trigger = Use/Interact = mount, grip = Grab = this pickup - so one collider carries both verbs with no
            // separate handle to aim at. (Desktop has only the one click, so the runtime spends it on riding and leaves the
            // board un-grabbable there; see RideableBoard.Grab.cs.)
            //
            // The board lives on VRChat's PICKUP layer, and that is load-bearing, not cosmetic: Default COLLIDES with the
            // Player layer and Pickup does not. On Default, a board in your hand is a kinematic box being waved around
            // inside your own player capsule - PhysX resolves the overlap by shoving YOU, so moving the board at the wrong
            // angle drags your body with it. The Pickup layer is exactly the layer that doesn't push players (it's also what
            // stops a board lying on the snow from body-checking anyone who walks into it). Nothing in the ride depends on
            // the board's layer: the contact probe and the obstacle sweep both exclude the board's own colliders by
            // IDENTITY, not by mask, and the board is kinematic so it never resolves a PhysX contact of its own.
            //
            // KINEMATIC rigidbody on purpose. The ride is hand-integrated transform writes, and a PhysX-driven body would
            // fight them. It also means VRChat can't throw the board for us (a kinematic body carries no velocity), so the
            // runtime measures the hand off the transform delta and hands the throw to its own riderless coast - which is
            // the model we want anyway: it's the same fall/slide/park a board jumped off mid-run already uses.
            go.layer = PickupLayer;

            var rb = go.AddComponent<Rigidbody>();
            rb.isKinematic = true;
            rb.useGravity = false;

            var pickup = go.AddComponent<VRCPickup>();
            pickup.pickupable = true;                            // per-client policy is re-decided at runtime (RefreshPickupable)
            pickup.AutoHold = VRCPickup.AutoHoldMode.No;         // hold the grip to carry, release to set it down - leaves the trigger free to mount
            pickup.orientation = VRCPickup.PickupOrientation.Any;
            pickup.allowManipulationWhenEquipped = false;
            pickup.DisallowTheft = true;                         // no yanking a board out of someone else's hands
            pickup.proximity = 1.5f;                             // reach (m) - a board is grabbed from arm's length, not across the gate

            var proxy = go.AddUdonSharpComponent<RideableBoard>();
            proxy.station = station;
            proxy.collisionRoot = collisionRoot;
            proxy.pickup = pickup;
            proxy.bodySphereCollision = true; // shipping mode; remains an inspector/code fallback when explicitly disabled
            AttachBoardAudio(go, proxy); // glide/carve loop sources + ollie/land one-shots, clips from zboard.bnk
            AttachBoardEffects(go, proxy); // snow spray rooster-tail + landing puff (Emit-driven, like the sound)
            AttachBoardWake(go, proxy);    // the carved wake ribbon left in the snow (procedural mesh, runtime-driven)
            // Size the wake to the deck that actually spawned (trailWidthMin = deck width, trailWidthMax = deck length),
            // derived from the real mesh bounds in BuildBoardVisual, so each random board carves a ribbon scaled to its
            // own footprint rather than the fixed defaults.
            proxy.trailWidthMin = deckFootprint.x;
            proxy.trailWidthMax = deckFootprint.y;
            UdonSharpEditorUtility.CopyProxyToUdon(proxy);
            return go;
        }

        // Build the visible deck as a child of the ride frame from the exported board model. SSX authors the deck with
        // length->local X, width->local Y, thickness->local Z (docs/vrchat/017); we remap onto forward(+Z)/right(+X)/up(+Y),
        // scale by the world scale (game-true size), and recentre it. No deck model -> a thin-box placeholder.
        //
        // Returns the deck's FOOTPRINT on the frame's ground axes as (width, length) in metres - the caller bakes it into
        // the wake's trailWidthMin/Max so the carved ribbon sizes itself to whichever random deck spawned.
        static Vector2 BuildBoardVisual(GameObject frame, int poolIndex)
        {
            // The spawn pool = whichever deck models are on disk. With BOTH boards and skis present, a fraction SkiSpawnChance
            // of the pool comes up skis (the rest boards); with only one kind exported, always that kind; neither -> the box
            // fallback below. So adding skis to the pool is just `snowknife skis ...` having been run.
            //
            // The board-vs-ski split is spread EVENLY across the pool INDEX (a Bresenham step on SkiSpawnChance), not rolled
            // independently per board. VRCObjectPool.TryToSpawn hands boards out in array order and the start gate only ever
            // dispenses the first few (one per post), so an independent random roll could (and did) put a run of all-skis at
            // the front and make the gate monotype. Even distribution guarantees any contiguous prefix is a mix. The deck
            // MODEL + SKIN stay fully random below, so variety is preserved - only the TYPE is de-clumped.
            bool skisOk   = AnyAssetExists(SkiModels);
            bool boardsOk = AnyAssetExists(BoardModels);
            bool wantSki = Mathf.FloorToInt((poolIndex + 1) * SkiSpawnChance) > Mathf.FloorToInt(poolIndex * SkiSpawnChance);
            bool useSki = skisOk && (!boardsOk || wantSki);

            // Skis are built as TWO independently-banking ski objects (BuildSkiVisual, below); a snowboard is a single
            // centred deck (the rest of this method). If the ski build can't run, fall through to a board so the post still
            // gets a rideable deck.
            if (useSki && BuildSkiVisual(frame, out Vector2 skiFootprint)) return skiFootprint;

            string modelPath = BoardModels[Random.Range(0, BoardModels.Length)];
            Mesh mesh = LoadBoardMesh(modelPath, out Material objMat);

            var deck = new GameObject(DeckName);
            deck.transform.SetParent(frame.transform, false);
            var mf = deck.AddComponent<MeshFilter>();
            var mr = deck.AddComponent<MeshRenderer>();

            // A random rider's real 'bord' deck skin; fall back to the model's own (default) material.
            var deckMat = PickRandomBoardSkin() ?? objMat;

            if (mesh == null)
            {
                // Fallback: a thin box, as a child so the frame stays unit-scale.
                var prim = GameObject.CreatePrimitive(PrimitiveType.Cube);
                mf.sharedMesh = prim.GetComponent<MeshFilter>().sharedMesh;
                mr.sharedMaterial = deckMat != null ? deckMat : prim.GetComponent<MeshRenderer>().sharedMaterial;
                Object.DestroyImmediate(prim);
                deck.transform.localScale = BoardColliderSize;
                Debug.LogWarning($"OpenSlope: deck model '{modelPath}' not found - using a box placeholder. Run " +
                                 "'snowknife board ssx-tricky.iso Assets/OpenSlope/Maps/Shared/chars' (and/or 'snowknife skis " +
                                 "ssx-on-tour.iso Assets/OpenSlope/Maps/Shared/chars') to export the real decks, then re-run Spawn Start Gate Boards.");
                // Placeholder box: scaled directly (no remap), so its footprint is X(width) x Z(length).
                return new Vector2(BoardColliderSize.x, BoardColliderSize.z);
            }

            mf.sharedMesh = mesh;
            if (deckMat != null) mr.sharedMaterial = deckMat;

            // Axis remap mesh -> ride frame: length->forward, width->right, thickness->up. SSX authors the deck NOSE toward
            // model -X, so length maps to ride -Z (nose forward / downhill) and width to -X to keep this a pure 180-yaw
            // rotation (det +1, no mirror, so the skin isn't flipped). Mapping length to +Z instead rides tail-first.
            var m = new Matrix4x4();
            m.SetColumn(0, new Vector4(0, 0, -1, 0)); // model X (length)    -> ride -Z (nose forward)
            m.SetColumn(1, new Vector4(-1, 0, 0, 0)); // model Y (width)     -> ride -X
            m.SetColumn(2, new Vector4(0, 1, 0, 0));  // model Z (thickness) -> ride +Y (up)
            m.SetColumn(3, new Vector4(0, 0, 0, 1));
            deck.transform.localRotation = m.rotation;

            float s = BoardModelScale; // game-true: raw SSX units (cm) -> metres, the same world scale as everything else
            deck.transform.localScale = new Vector3(s, s, s);

            // Recentre the model on the frame: P = -s * (R * meshCenter), R being the axis remap above.
            deck.transform.localPosition = -s * m.MultiplyVector(mesh.bounds.center);

            // Footprint on the frame's ground axes for the wake width. model X(length)->frame Z and Y(width)->frame X, * s.
            return new Vector2(mesh.bounds.size.y * s, mesh.bounds.size.x * s); // (width, length)
        }

        // Build a pair of skis under the Heading pivot as TWO independently-banking ski objects, so the runtime can edge
        // each ski about its OWN centreline (RideableBoard ski mode) instead of rolling them as one rigid unit. The On
        // Tour ski model holds both skis in one mesh, separated across the model's WIDTH axis (model Z); we split it into a
        // left + right half-mesh and hang each under its own "SkiBank_L/R" roll pivot placed on that ski's centreline, with
        // a "Deck" child (named so the runtime's deck-length measure + this whole convention match the board). Returns the
        // pair FOOTPRINT (width, length) in metres for the wake, or false if the model/geometry can't be built (caller then
        // falls back to a board). Orientation (skis flat, nose -Z, top +Y) was verified against the real model in-editor.
        static bool BuildSkiVisual(GameObject frame, out Vector2 footprint)
        {
            footprint = default;
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

            // Split the combined mesh at the WIDTH (model Z) midpoint - the gap between the two skis.
            float zMid = (mesh.bounds.min.z + mesh.bounds.max.z) * 0.5f;
            Mesh leftMesh  = GetOrCreateSkiHalf(modelPath, mesh, zMid, true);
            Mesh rightMesh = GetOrCreateSkiHalf(modelPath, mesh, zMid, false);
            if (leftMesh == null || rightMesh == null || leftMesh.vertexCount == 0 || rightMesh.vertexCount == 0)
                return false;

            Vector3 pairCenterRide = R.MultiplyPoint3x4(mesh.bounds.center); // pair centre in ride space (recentre to origin)
            BuildOneSki(frame.transform, "SkiBank_L", leftMesh,  R, pairCenterRide, deckMat);
            BuildOneSki(frame.transform, "SkiBank_R", rightMesh, R, pairCenterRide, deckMat);

            float s = BoardModelScale;
            footprint = new Vector2(mesh.bounds.size.z * s, mesh.bounds.size.x * s); // (width=Z, length=X) of the whole pair
            return true;
        }

        // One ski: a roll pivot (named SkiBank_L/R) on that ski's centreline, carrying a "Deck" with the half-mesh centred
        // on the pivot origin. The runtime rolls the pivot about its local forward (Z) by the carve angle, so the ski edges
        // about its own long axis. The pair is recentred on the frame by offsetting each pivot by -pairCentre.
        static void BuildOneSki(Transform heading, string name, Mesh half, Matrix4x4 R, Vector3 pairCenterRide, Material mat)
        {
            float s = BoardModelScale;
            Vector3 centerRide = R.MultiplyPoint3x4(half.bounds.center); // this ski's centre in ride space

            var pivot = new GameObject(name);
            pivot.transform.SetParent(heading, false);
            pivot.transform.localPosition = s * (centerRide - pairCenterRide); // this ski's lateral/length offset from the pair centre
            pivot.transform.localRotation = Quaternion.identity;               // runtime sets this each frame (the carve roll)

            var deck = new GameObject(DeckName);
            deck.transform.SetParent(pivot.transform, false);
            deck.AddComponent<MeshFilter>().sharedMesh = half;
            var mr = deck.AddComponent<MeshRenderer>();
            if (mat != null) mr.sharedMaterial = mat;
            // Pre-bank the rest pose about the ski's own long axis (forward/Z) so neutral sits flat; the runtime's carve
            // roll on the SkiBank pivot adds on top of this.
            Quaternion preBank = Quaternion.AngleAxis(SkiRestBankDeg, Vector3.forward);
            deck.transform.localRotation = preBank * R.rotation;
            deck.transform.localScale = new Vector3(s, s, s);
            // Centre the half-mesh on the pivot origin (its centreline). The recentre uses the FULL deck rotation (incl. the
            // pre-bank) - otherwise a non-zero pre-bank shifts each ski off its pivot and the pair collapses on top of each other.
            deck.transform.localPosition = -s * (preBank * centerRide);
        }

        // Get-or-create one half of a ski mesh, split at the width midpoint and saved as a shared asset so all spawned skis
        // reference the same two sub-meshes (not a fresh embedded copy per board). Returns null if the split yields nothing.
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

        // Build a new mesh from the triangles of `src` whose centroid falls on one side of `zMid` along model Z (the axis
        // separating the two skis). Vertices/UVs/normals are copied and re-indexed compactly. Null if no triangles qualify.
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

        // True if at least one of the given asset paths resolves to an imported asset (the deck models were exported).
        static bool AnyAssetExists(string[] paths)
        {
            foreach (var p in paths)
                if (AssetDatabase.LoadMainAssetAtPath(p) != null) return true;
            return false;
        }

        // First Mesh + first Material sub-asset of an exported board OBJ (null if it hasn't been exported).
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

        // One random deck skin (null if no skins are on disk / the shader is missing - the caller then keeps the model's
        // default material). Boards draw from the rider 'bord' pool, skis from the brand 'skis' pool; both build + cache
        // the .mat the first time each skin is picked.
        static Material PickRandomBoardSkin() => PickRandomSkin(BoardSkinIds(), BoardTexFolder, BoardMatFolder);
        static Material PickRandomSkiSkin()   => PickRandomSkin(SkiSkinIds(),   SkiTexFolder,   SkiMatFolder);

        static Material PickRandomSkin(string[] skins, string texFolder, string matFolder)
        {
            if (skins.Length == 0) return null;
            return GetOrCreateDeckMaterial(skins[Random.Range(0, skins.Length)], texFolder, matFolder);
        }

        // The pool of skin ids = every <id>.png under the bank folder (minus any excluded specials), enumerated from the
        // asset database and cached for the session. Boards exclude the two non-rider specials; skis exclude nothing.
        static string[] BoardSkinIds() => _boardSkins ??= EnumerateSkinIds(BoardTexFolder, SkinExclude);
        static string[] SkiSkinIds()   => _skiSkins   ??= EnumerateSkinIds(SkiTexFolder, null);

        static string[] EnumerateSkinIds(string texFolder, System.Collections.Generic.HashSet<string> exclude)
        {
            var ids = new System.Collections.Generic.List<string>();
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

        // Get-or-create a material for one deck skin: <texFolder>/<id>.png on the board shader, saved to
        // <matFolder>/<id>.mat so every deck wearing that skin shares one material. Returns null (and warns once) if the
        // texture isn't imported (CLI not run) or the shader is missing. Boards and skis share the probe-lit board shader.
        static Material GetOrCreateDeckMaterial(string id, string texFolder, string matFolder)
        {
            string matPath = matFolder + "/" + id + ".mat";
            var existing = AssetDatabase.LoadAssetAtPath<Material>(matPath);
            if (existing != null)
            {
                // Heal a stale/broken shader reference: a saved .mat whose shader has been renamed falls back to
                // Hidden/InternalErrorShader and renders PINK. Re-point it at the current shader.
                var cur = Shader.Find(BoardShader);
                if (cur != null && existing.shader != cur) { existing.shader = cur; EditorUtility.SetDirty(existing); }
                return existing;
            }

            var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(texFolder + "/" + id + ".png");
            if (tex == null)
            {
                Debug.LogWarning($"OpenSlope: deck skin '{id}.png' not found in {texFolder} - using the model default. " +
                                 "Run the matching `snowknife board`/`skis` export to decode the deck skins.");
                return null;
            }

            var shader = Shader.Find(BoardShader);
            if (shader == null) { Debug.LogWarning($"OpenSlope: shader '{BoardShader}' not found - deck skin not built."); return null; }

            EnsureFolder(matFolder);
            var mat = new Material(shader) { name = id, mainTexture = tex };
            AssetDatabase.CreateAsset(mat, matPath);
            Debug.Log($"OpenSlope: built deck skin material {id}.");
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

        // ---- Board sound: AudioSources + clips (mirrors SurfaceAudioSetup's footstep recipe) ------------
        //
        // Four 2D sources, one per child of a "BoardAudio" node (local rider's own board, sync None): three looping
        // (glide + carve + grind, driven per frame by the Udon) and one one-shot (ollie + land). One source PER
        // GameObject because each carries its own VRCSpatialAudioSource (ConfigSpatial2D), which VRChat pairs 1:1 with
        // the AudioSource on its object. The clips are first-guesses; the board exposes every clip + volume to retune.
        // Missing WAVs (bank not exported) just leave the refs null and the board falls back to silence.
        static void AttachBoardAudio(GameObject go, RideableBoard proxy)
        {
            var audioGo = new GameObject("BoardAudio");
            audioGo.transform.SetParent(go.transform, false);

            var glide = NewBoardSource(audioGo, "Glide"); ConfigLoopSource(glide);
            var carve = NewBoardSource(audioGo, "Carve"); ConfigLoopSource(carve);
            var grind = NewBoardSource(audioGo, "Grind"); ConfigLoopSource(grind); // RAIL grind scrape loop (docs/026)
            var boost = NewBoardSource(audioGo, "Boost"); ConfigLoopSource(boost); // held-boost sound (volume-enveloped loop, zbxsfx 120/121/122)
            var bigAir = NewBoardSource(audioGo, "BigAirWind"); ConfigLoopSource(bigAir); // focused-rider MAIN/032
            var evt   = NewBoardSource(audioGo, "Event");
            evt.playOnAwake = false; evt.loop = false; evt.spatialBlend = 0f; evt.dopplerLevel = 0f;
            ConfigSpatial2D(evt); // the one-shot is 2D too - tag it so VRChat keeps it flat (no spatialize, no warning)

            proxy.glideSource = glide;
            proxy.carveSource = carve;
            proxy.eventSource = evt;
            proxy.grindSource = grind;
            proxy.boostSource = boost;
            proxy.bigAirWindSource = bigAir;
            proxy.glideClips  = LoadClips(GlideWavs);
            proxy.carveClips  = LoadClips(CarveWavs);
            proxy.ollieClip   = LoadBoardClip(OllieWav);
            proxy.landClip    = LoadBoardClip(LandWav);
            proxy.grindClip   = LoadBoardClip(GrindWav);
            proxy.boostClips  = LoadMainClips(BoostWavs); // boost-engage whoosh, MAIN bank (zbxsfx) 120/121/122
            proxy.bigAirWindClip = LoadMainLoopClip(BigAirWindWav, "big-air wind");
        }

        // One child GameObject per AudioSource: VRChat pairs a VRCSpatialAudioSource 1:1 with the source on its object,
        // so stacking sources on one object can't give each its own spatial config.
        static AudioSource NewBoardSource(GameObject parent, string name)
        {
            var g = new GameObject(name);
            g.transform.SetParent(parent.transform, false);
            return g.AddComponent<AudioSource>();
        }

        // A 2D, non-positional looping source (board sound is "your own", like the footsteps); silent + stopped until the
        // runtime spins it up on mount.
        static void ConfigLoopSource(AudioSource s)
        {
            s.playOnAwake = false; s.loop = true; s.spatialBlend = 0f; s.dopplerLevel = 0f; s.volume = 0f;
            ConfigSpatial2D(s);
        }

        // Tag a board source as a true 2D layer for VRChat. VRChat force-spatializes every bare AudioSource at world load
        // (and the build validator WARNS about it); the board is the local rider's own sound, so we add the component
        // ourselves with spatialization OFF - it stays flat 2D and the warning clears. Same recipe as the music/footstep beds.
        static void ConfigSpatial2D(AudioSource s)
        {
            var sa = s.gameObject.AddComponent<VRCSpatialAudioSource>();
            sa.EnableSpatialization = false;
            sa.UseAudioSourceVolumeCurve = true;
        }

        static AudioClip[] LoadClips(string[] wavs)
        {
            var clips = new AudioClip[wavs.Length];
            for (int i = 0; i < wavs.Length; i++) clips[i] = LoadBoardClip(wavs[i]);
            return clips;
        }

        static AudioClip LoadBoardClip(string wav)
        {
            string path = SharedAudio + "/SFX/zboard/" + wav + ".wav";
            var c = AssetDatabase.LoadAssetAtPath<AudioClip>(path);
            if (c == null) Debug.LogWarning($"OpenSlope: board-audio clip not found: {path} (run `snowknife sfx`).");
            return c;
        }

        // Load a slot from the global MAIN bank (zbxsfx), the shared SFX bank that also holds the gem/pad chimes - distinct
        // from the board's own zboard bank. Used for the boost-engage whoosh (120/121/122). Same shared export folder.
        static AudioClip[] LoadMainClips(string[] wavs)
        {
            var clips = new AudioClip[wavs.Length];
            for (int i = 0; i < wavs.Length; i++)
            {
                string path = SharedAudio + "/SFX/zbxsfx/" + wavs[i] + ".wav";
                clips[i] = AssetDatabase.LoadAssetAtPath<AudioClip>(path);
                if (clips[i] == null) Debug.LogWarning($"OpenSlope: boost-audio clip not found: {path} " +
                                                        "(run `snowknife shared` to decode the MAIN bank zbxsfx).");
            }
            return clips;
        }

        static AudioClip LoadMainLoopClip(string wav, string label)
        {
            string folder = SharedAudio + "/SFX/zbxsfx/";
            string path = folder + wav + ".loop.wav";
            var clip = AssetDatabase.LoadAssetAtPath<AudioClip>(path);
            if (clip == null)
            {
                path = folder + wav + ".wav";
                clip = AssetDatabase.LoadAssetAtPath<AudioClip>(path);
            }
            if (clip == null) Debug.LogWarning($"OpenSlope: {label} clip not found: {path} " +
                                               "(run `snowknife shared` to decode the MAIN bank zbxsfx).");
            return clip;
        }

        // ---- Board snow particles: spray rooster-tail + landing puff + grind sparks (mirrors AttachBoardAudio) -----
        //
        // ParticleSystems under a "BoardFX" node, parented to the ride FRAME (NOT the Heading pivot) so the avatar-fit
        // scale never touches the snow size, at unit scale so World-space particles come out world-sized. All built
        // playOnAwake OFF, loop ON, rate 0: the runtime keeps them alive (Play on mount) and hand-Emit()s them. Local
        // rider's own FX. The spray/puff use the soft round material; the sparks are additive.
        static void AttachBoardEffects(GameObject go, RideableBoard proxy)
        {
            var fxGo = new GameObject("BoardFX");
            fxGo.transform.SetParent(go.transform, false);

            // Two board-spray systems distilled from the game's five ([Trailmap: 380-carve-effects]),
            // hand-Emit()'d from ride state (RideableBoard.Fx.cs). The surface spray THROWS its sprites with a real velocity
            // and swaps material per surface class (blb1/swp2/str3/cnf2); the cloud is one soft 'ex06' puff system (box-scattered
            // so it batch-Emits) standing in for the sys1/sys2 carve veil AND the sys5 powder cloud.
            proxy.surfaceSpray  = BuildSurfaceSpray(fxGo);  // 40-slot ring - the per-surface carve fan (the main spray)
            proxy.surfSprayRenderer = proxy.surfaceSpray.GetComponent<ParticleSystemRenderer>();
            // Per-surface spray sprite = the surface record's spray asset index resolved against the runtime sprite
            // name-table order ([Trailmap: 380-carve-effects] - the ONE index space the board spray raw-indexes).
            // snow 16=blb1, off-track 13=swp2, powder 20=str3, ice 15=cnf2.
            proxy.surfSprayMats = new[]
            {
                GetSprayMaterial("blb1"),  // 0: standard snow (asset 16) - snow chunk
                GetSprayMaterial("swp2"),  // 1: off-track     (asset 13) - soft puff
                GetSprayMaterial("str3"),  // 2: powder        (asset 20) - 4-point twinkle
                GetSprayMaterial("cnf2"),  // 3: ice           (asset 15) - crystal shard
            };
            proxy.cloud = BuildCloud(fxGo); // one soft system: carve veil (sys1/sys2) + powder cloud (sys5), box-scattered + batch-Emit
            proxy.sparks = BuildSparks(fxGo); // metal grind sparks (docs/026), same Emit-driven shell as the spray
        }

        // The grind sparks: a tight, fast spray of tiny ADDITIVE warm points the runtime aims back/down off the rail and
        // Emit()s each frame while grinding. Short-lived, gravity-arced, world sim so they trail behind the moving board.
        static ParticleSystem BuildSparks(GameObject parent)
        {
            var go = new GameObject("Sparks");
            go.transform.SetParent(parent.transform, false);
            var ps = go.AddComponent<ParticleSystem>();
            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);

            var main = ps.main;
            main.duration = 5f;
            main.loop = true;
            main.playOnAwake = false;
            main.startLifetime = new ParticleSystem.MinMaxCurve(0.15f, 0.45f); // brief flecks
            main.startSpeed = new ParticleSystem.MinMaxCurve(3f, 7f);          // shoot off fast
            main.startSize = new ParticleSystem.MinMaxCurve(0.025f, 0.07f);    // tiny points
            main.startColor = new Color(1f, 0.82f, 0.4f, 1f);                  // warm metal-spark orange/white
            main.gravityModifier = 1.2f;       // arc down quickly
            main.maxParticles = 400;
            main.simulationSpace = ParticleSystemSimulationSpace.World;        // detach + trail behind the moving board
            main.scalingMode = ParticleSystemScalingMode.Local;

            var emission = ps.emission;
            emission.enabled = true;
            emission.rateOverTime = 0f;        // runtime hand-Emit()s; no auto stream

            var shape = ps.shape;
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Cone;
            shape.angle = 18f;                 // a fanned shower, not a needle
            shape.radius = 0.04f;

            FadeOutOverLife(ps);               // wink out (white throughout the fade)
            ShrinkOverLife(ps);

            var rend = go.GetComponent<ParticleSystemRenderer>();
            rend.renderMode = ParticleSystemRenderMode.Billboard;
            rend.alignment = ParticleSystemRenderSpace.View;
            rend.allowRoll = false;
            rend.sharedMaterial = SparkParticleMaterial();
            return ps;
        }

        // A shared ADDITIVE warm spark material - the soft round dot on a stock additive shader so sparks GLOW over snow.
        // Saved under MatFolder + cached; falls back to the built-in Default-Particle material (never magenta).
        static Material SparkParticleMaterial()
        {
            if (_sparkMat != null) return _sparkMat;
            _sparkMat = AssetDatabase.LoadAssetAtPath<Material>(SparkMatPath);
            if (_sparkMat != null) return HealParticleTex(_sparkMat, SparkSprite);

            var builtin = AssetDatabase.GetBuiltinExtraResource<Material>("Default-Particle.mat");
            // Prefer the game's own twinkle sprite over Unity's generic dot; fall back to the dot if the bank isn't decoded yet.
            Texture dot = AssetDatabase.LoadAssetAtPath<Texture2D>(SparkSprite)
                          ?? (builtin != null ? builtin.mainTexture : null);

            Shader sh = Shader.Find("Legacy Shaders/Particles/Additive")
                        ?? Shader.Find("Mobile/Particles/Additive")
                        ?? Shader.Find("Sprites/Default");
            if (sh == null) { _sparkMat = builtin; return _sparkMat; }

            _sparkMat = new Material(sh) { name = "ssx_rail_spark" };
            if (dot != null) _sparkMat.mainTexture = dot;
            _sparkMat.color = Color.white;
            EnsureFolder(MatFolder);
            AssetDatabase.CreateAsset(_sparkMat, SparkMatPath);
            return _sparkMat;
        }

        // 40-slot SURFACE SPRAY ([Trailmap: 380-carve-effects]): the main carve fan. The
        // runtime emits each sprite with a real THROW velocity (up out of the snow, toward the carve edge) and per-surface
        // size/lifetime/alpha via EmitParams, and swaps the renderer material per surface class (snow dot / off-track /
        // powder clod / ice streak) - so size/life here are just fallbacks. Constant size for life (the fan look is the
        // velocity spread, not sprite growth); linear alpha fade like the game's (0.9 - age)*1.111 envelope.
        static ParticleSystem BuildSurfaceSpray(GameObject parent)
        {
            var ps = NewSpraySystem(parent, "SurfaceSpray", 0.6f, 0.18f, 96, "part");
            var col = ps.colorOverLifetime; col.enabled = true;
            col.color = FadeGradient();                                          // linear 1 -> 0 (peak alpha set per-emit)
            return ps;
        }

        // The soft additive CLOUD [Trailmap: 380-carve-effects]: ONE system represents the sys1/sys2
        // carve veil AND the sys5 powder cloud. All are soft frozen 'ex06' puffs accumulating along the path, so a BOX shape
        // scatters them and the runtime batch-Emits (one Emit call, no per-particle loop). The runtime sets size/alpha/velocity
        // per emit: powder = big (~0.45 m, live-measured) puffs ANCHORED to the board; veil = puffs whose alpha scales with carve
        // hardness. The size curve billows each puff open then holds; alpha fades linearly over the 0.6 s life. Additive.
        static ParticleSystem BuildCloud(GameObject parent)
        {
            var ps = NewSpraySystem(parent, "Cloud", 0.6f, 0.45f, 64, "ex06"); // 64-slot ring ~ the game's ~28-40 drawn powder puffs
            var shape = ps.shape;                                                // re-enable + size the emit shape (NewSpraySystem disables it)
            shape.enabled = true;
            shape.shapeType = ParticleSystemShapeType.Box;
            shape.scale = new Vector3(0.9f, 0.2f, 0.9f);                         // ~0.9 m lateral scatter, thin vertically (hugs the deck)
            var sol = ps.sizeOverLifetime; sol.enabled = true;
            var billow = new AnimationCurve(new Keyframe(0f, 0.6f), new Keyframe(0.2f, 1f), new Keyframe(1f, 1.3f)); // pop open then drift wider
            sol.size = new ParticleSystem.MinMaxCurve(1f, billow);
            var col = ps.colorOverLifetime; col.enabled = true;
            col.color = FadeGradient();                                          // linear 1 -> 0 over life (peak alpha set per-emit)
            return ps;
        }

        // Shared shell for a spray ParticleSystem: additive, World-sim, age-only (no gravity, no shape spread - the runtime
        // sets each particle's position/velocity/colour explicitly), playOnAwake off / loop on so the runtime keeps it alive
        // and hand-Emit()s. startSize + startLifetime are the base; sizeOverLifetime/colorOverLifetime shape the rest.
        static ParticleSystem NewSpraySystem(GameObject parent, string name, float life, float size, int maxParticles, string spriteId)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent.transform, false);
            var ps = go.AddComponent<ParticleSystem>();
            ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);

            var main = ps.main;
            main.duration = 5f;
            main.loop = true;
            main.playOnAwake = false;
            main.startLifetime = life;
            main.startSpeed = new ParticleSystem.MinMaxCurve(0f, 0f); // runtime sets velocity per-emit (0 default = frozen)
            main.startSize = size;
            main.startColor = Color.white;                           // runtime sets the peak alpha per-emit
            main.gravityModifier = 0f;
            main.maxParticles = maxParticles;
            main.simulationSpace = ParticleSystemSimulationSpace.World; // detach + accumulate along the path
            main.scalingMode = ParticleSystemScalingMode.Local;

            var emission = ps.emission; emission.enabled = true; emission.rateOverTime = 0f; // hand-Emit() only
            var shape = ps.shape; shape.enabled = false;             // the runtime places each particle explicitly (transform)

            var rend = go.GetComponent<ParticleSystemRenderer>();
            rend.renderMode = ParticleSystemRenderMode.Billboard;
            rend.alignment = ParticleSystemRenderSpace.View;
            rend.allowRoll = false;
            rend.sharedMaterial = GetSprayMaterial(spriteId);
            return ps;
        }

        // Linear alpha fade 1 -> 0 over life (peak alpha carried by the per-emit startColor).
        static ParticleSystem.MinMaxGradient FadeGradient()
        {
            var g = new Gradient();
            g.SetKeys(
                new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) },
                new[] { new GradientAlphaKey(1f, 0f), new GradientAlphaKey(0f, 1f) });
            return new ParticleSystem.MinMaxGradient(g);
        }

        // A shared ADDITIVE particle material for one spray sprite (surface 'blb1'/'swp2'/'str3'/'cnf2', sys2 'spry', the
        // ex0x soft puffs), built from the game's PARTICLE.SSH sprite, saved under MatFolder + cached per sprite so every
        // board shares one material per sprite.
        // Falls back to the built-in Default-Particle (never magenta).
        //
        // ADDITIVE, not alpha (the board spray sprite is drawn additive = Unity's
        // SrcAlpha One; docs/vrchat/032, [Trailmap: 400-rendering]). Additive accumulation of soft sprites gives the translucent cloud; per-particle alpha
        // (startColor) modulates the glow so a dusting is faint and a hard carve blooms brighter.
        static readonly System.Collections.Generic.Dictionary<string, Material> _sprayMats =
            new System.Collections.Generic.Dictionary<string, Material>();
        static Material GetSprayMaterial(string spriteId)
        {
            if (_sprayMats.TryGetValue(spriteId, out var cached) && cached != null) return cached;
            string spritePath = MapLayout.SharedFolder + "/Textures/Particles/" + spriteId + ".png";
            string matPath    = MatFolder + "/ssx_spray_" + spriteId + ".mat";
            var existing = AssetDatabase.LoadAssetAtPath<Material>(matPath);
            if (existing != null) { existing = HealParticleTex(existing, spritePath); _sprayMats[spriteId] = existing; return existing; }

            var builtin = AssetDatabase.GetBuiltinExtraResource<Material>("Default-Particle.mat");
            Texture dot = AssetDatabase.LoadAssetAtPath<Texture2D>(spritePath)
                          ?? (builtin != null ? builtin.mainTexture : null);
            Shader sh = Shader.Find("Legacy Shaders/Particles/Additive")
                        ?? Shader.Find("Mobile/Particles/Additive")
                        ?? Shader.Find("Particles/Additive")
                        ?? Shader.Find("Sprites/Default");
            if (sh == null) { _sprayMats[spriteId] = builtin; return builtin; } // last resort: the built-in additive dot

            var mat = new Material(sh) { name = "ssx_spray_" + spriteId };
            if (dot != null) mat.mainTexture = dot; // legacy particle shader tints via _TintColor (left at default unity) - leave _Color
            EnsureFolder(MatFolder);
            AssetDatabase.CreateAsset(mat, matPath);
            _sprayMats[spriteId] = mat;
            return mat;
        }

        // Back-compat shim: the wake material falls back to a snow particle material when its own shader is missing.
        static Material SnowParticleMaterial() => GetSprayMaterial("clod");

        // Heal a cached particle material whose sprite was MISSING when it was first created (the sprite asset - clod/str3 -
        // got imported only later, e.g. a fresh `snowknife shared` run): an additive particle shader with a null texture
        // renders a hard SQUARE quad instead of the soft round puff/spark. Re-point mainTexture if it's absent and the
        // sprite is now on disk. Mirrors the shader-heal in GetOrCreateDeckMaterial. No-op once the texture is set.
        static Material HealParticleTex(Material mat, string spritePath)
        {
            if (mat != null && mat.mainTexture == null)
            {
                var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(spritePath);
                if (tex != null) { mat.mainTexture = tex; EditorUtility.SetDirty(mat); }
            }
            return mat;
        }

        // Fade alpha to 0 over each flake's life so the snow melts out instead of popping off (white throughout).
        static void FadeOutOverLife(ParticleSystem ps)
        {
            var col = ps.colorOverLifetime;
            col.enabled = true;
            var grad = new Gradient();
            grad.SetKeys(
                new[] { new GradientColorKey(Color.white, 0f), new GradientColorKey(Color.white, 1f) },
                new[] { new GradientAlphaKey(1f, 0f), new GradientAlphaKey(1f, 0.5f), new GradientAlphaKey(0f, 1f) });
            col.color = new ParticleSystem.MinMaxGradient(grad);
        }

        // Shrink each flake toward nothing over its life (a kicked-up fleck thins as it disperses). Used by the grind
        // sparks.
        static void ShrinkOverLife(ParticleSystem ps)
        {
            var sol = ps.sizeOverLifetime;
            sol.enabled = true;
            sol.size = new ParticleSystem.MinMaxCurve(1f, AnimationCurve.Linear(0f, 1f, 1f, 0f));
        }

        // Bloom each particle OUTWARD over its life (start compact, expand as it dissolves) - the SSX snow cloud-puff look.
        // Paired with FadeOutOverLife so the cloud expands as it fades.
        static void GrowOverLife(ParticleSystem ps)
        {
            var sol = ps.sizeOverLifetime;
            sol.enabled = true;
            sol.size = new ParticleSystem.MinMaxCurve(1f, AnimationCurve.Linear(0f, 0.5f, 1f, 1.7f));
        }

        // ---- Board wake trail: the carved ribbon left in the snow (the SSX 'tral' wake, docs/vrchat/017) ----------
        //
        // A MeshFilter + MeshRenderer on a "Wake" child of the ride FRAME. The runtime (UpdateWakeTrail) rebuilds a
        // procedural ribbon MESH into it each frame - a FIFO ring of cross-sections, the way the engine builds its
        // carved-wake ribbon of quads. The depression's light/dark sides live in PER-VERTEX COLOUR, drawn by the unlit
        // OpenSlope/WakeRibbon shader. The child is named "Wake" so the runtime AUTO-FINDS it at Start (which lets the menu
        // below add a wake to an already-placed board without touching its Udon vars).
        static void AttachBoardWake(GameObject go, RideableBoard proxy)
        {
            var mf = BuildWakeChild(go);
            proxy.wakeMeshFilter = mf;
            proxy.wakeMeshRenderer = mf != null ? mf.GetComponent<MeshRenderer>() : null;
        }

        // Create the "Wake" child carrying a MeshFilter + MeshRenderer and return the filter. No mesh is assigned here;
        // the runtime makes one per-instance and rebuilds it each frame. The child is named "Wake" so the runtime
        // auto-finds it at Start.
        static MeshFilter BuildWakeChild(GameObject go)
        {
            var wakeGo = new GameObject("Wake");
            wakeGo.transform.SetParent(go.transform, false);
            wakeGo.transform.localPosition = Vector3.zero;
            wakeGo.transform.localRotation = Quaternion.identity;
            var mf = wakeGo.AddComponent<MeshFilter>();
            var mr = wakeGo.AddComponent<MeshRenderer>();
            mr.sharedMaterial = WakeMaterial();
            mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            mr.receiveShadows = false;
            // No probe lighting: OpenSlope/WakeRibbon MODULATES the snow it lies on (overlay blend), so it auto-matches shade
            // without sampling probes (and the sun-direction light/dark split reads against the real surface).
            mr.lightProbeUsage = UnityEngine.Rendering.LightProbeUsage.Off;
            mr.reflectionProbeUsage = UnityEngine.Rendering.ReflectionProbeUsage.Off;
            mr.motionVectorGenerationMode = MotionVectorGenerationMode.ForceNoMotion;
            return mf;
        }

        // Shared material for the wake ribbon: the unlit, double-sided, alpha-blended vertex-colour shader OpenSlope/WakeRibbon.
        // The carved twin-groove + age fade live in the mesh's PER-VERTEX COLOUR, so the material itself is just white (no
        // texture). Cached so every board shares one. Falls back to the snow material if the shader is missing.
        static Material WakeMaterial()
        {
            if (_wakeMat != null) return _wakeMat;
            _wakeMat = AssetDatabase.LoadAssetAtPath<Material>(WakeMatPath);
            Shader sh = Shader.Find(WakeShader);
            if (_wakeMat == null)
            {
                if (sh == null) return _wakeMat = SnowParticleMaterial(); // last resort: reuse the snow material
                _wakeMat = new Material(sh) { name = "ssx_board_wake_mesh", color = Color.white };
                EnsureFolder(MatFolder);
                AssetDatabase.CreateAsset(_wakeMat, WakeMatPath);
            }
            if (sh != null && _wakeMat.shader != sh) _wakeMat.shader = sh; // upgrade an older cached material to the wake shader
            _wakeMat.mainTexture = null;                                   // white default -> vertex colour is the output
            EditorUtility.SetDirty(_wakeMat);
            return _wakeMat;
        }

        // Create the UdonSharpProgramAsset for RideableBoard if absent, then compile so it carries a serialized Udon
        // program. AddUdonSharpComponent REQUIRES this to already exist. (Same recipe as MusicDirectorSetup.)
        public static UdonSharpProgramAsset EnsureProgramAsset()
        {
            var existing = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(RideableBoard));
            if (existing != null) return existing;

            string scriptPath = null;
            foreach (var guid in AssetDatabase.FindAssets("RideableBoard t:MonoScript"))
            {
                var p = AssetDatabase.GUIDToAssetPath(guid);
                if (p.EndsWith("/RideableBoard.cs")) { scriptPath = p; break; }
            }
            if (scriptPath == null) { Debug.LogError("OpenSlope: RideableBoard.cs not found in project."); return null; }

            var script = AssetDatabase.LoadAssetAtPath<MonoScript>(scriptPath);
            var pa = ScriptableObject.CreateInstance<UdonSharpProgramAsset>();
            pa.sourceCsScript = script;
            string assetPath = System.IO.Path.ChangeExtension(scriptPath, ".asset");
            AssetDatabase.CreateAsset(pa, assetPath);
            AssetDatabase.Refresh();
            UdonSharpProgramAsset.CompileAllCsPrograms(true);
            Debug.Log($"OpenSlope: created UdonSharp program asset {assetPath}");
            return UdonSharpProgramAsset.GetProgramAssetForClass(typeof(RideableBoard));
        }
    }
}
#endif
