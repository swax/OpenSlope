#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;
using OpenSlope.Importer;

namespace OpenSlope.BasisPlugin
{

    // The Basis "Setup All" - the Basis analogue of VRC's SetupAll. On the VRChat side Setup All attaches the
    // UdonSharp gameplay components (boards, board, flight, probes, chunker); the Basis pass runs the scene
    // FINALIZATION the platform owns - point BasisScene's spawn at the importer's PlayerSpawn anchor and pin the
    // environment (ambient / sun shadows / fog) the neutral SkyboxBaker set - then stands the start-gate board rack,
    // the on-foot flight singleton, and the Performance + Info boards. Import All calls FinalizeScene at the end of a
    // load; this menu re-runs it on an already-loaded map. Avatar light probes and static chunking have no Basis pass.
    public static class BasisSetupAll
    {
        [MenuItem("OpenSlope Basis/Setup All", false, 100)]
        public static void All()
        {
            var cfg = ImportConfig.Current();
            if (GameObject.Find(cfg.RootName) == null)
            {
                Debug.LogError($"Basis: '{cfg.RootName}' not found - run OpenSlope Basis/Load/Map... first.");
                return;
            }
            FinalizeScene(cfg);
            Debug.Log("Basis: Setup All finished (spawn + environment finalized).");
        }
        [MenuItem("OpenSlope Basis/Setup All", true)]
        static bool AllEnabled() => GameObject.Find(ImportConfig.Current().RootName) != null;

        // Point the BasisScene spawn at the importer's PlayerSpawn anchor + drop the respawn floor below the mountain, and
        // re-assert the environment settings (the neutral SkyboxBaker already sets skybox/ambient/fog/shadows at import;
        // this pins them so a re-run is deterministic). BasisScene is referenced by component name (no hard Basis-assembly
        // dependency in this file), matching how the wiring stays decoupled from any one behaviour.
        public static void FinalizeScene(ImportConfig cfg)
        {
            var root = GameObject.Find(cfg.RootName);
            if (root == null) return;

            // The importer's ExposeLibraryAnchors builds OpenSlope_Map/Locations/PlayerSpawn (on the terrain, faced downhill).
            var playerSpawn = root.transform.Find(MapLayout.LocationsName + "/" + MapLayout.PlayerSpawn);

            // Respawn floor: below the terrain's lowest point (mirrors Map.SetRespawnHeightFromMap's floor - 120).
            float respawn = -100000f;
            var terrain = root.transform.Find(cfg.LevelName + "/Terrain") ?? FindTerrain(root.transform);
            if (terrain != null)
            {
                var mr = terrain.GetComponent<MeshRenderer>();
                if (mr != null) respawn = mr.bounds.min.y - 120f;
            }

            var basisScene = FindBasisScene();
            if (basisScene != null)
            {
                var so = new SerializedObject(basisScene);
                var sp = so.FindProperty("SpawnPoint");
                if (sp != null && playerSpawn != null) sp.objectReferenceValue = playerSpawn;
                var rh = so.FindProperty("RespawnHeight");
                if (rh != null) rh.floatValue = respawn;
                so.ApplyModifiedProperties();
                Debug.Log($"Basis: BasisScene spawn -> {(playerSpawn != null ? playerSpawn.name : "unchanged")}, respawn floor {respawn:F0}.");
            }
            else Debug.LogWarning("Basis: no BasisScene component found - spawn not wired (add a BasisScene to the scene).");

            // Re-assert the environment the importer set (idempotent pin).
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Skybox;
            RenderSettings.ambientIntensity = cfg.SkyAmbientIntensity;
            if (cfg.SunShadowsOff)
                foreach (var l in Object.FindObjectsOfType<Light>(true))
                    if (l.type == LightType.Directional) l.shadows = LightShadows.None;

            // Stand a rack of ready-to-mount rideable boards at the start gate - the Basis analogue of dressing the VRChat
            // start gate with boards on setup (there's no networked dispenser/pool in the MVP). Reconciles a prior rack, so
            // a re-run / re-import doesn't pile them up.
            int boards = BasisBoardSetup.SpawnBoardRackAtGate();
            if (boards > 0) Debug.Log($"Basis: placed {boards} rideable board(s) at the start gate (walk up + interact to ride).");

            // Trigger-jetpack flight for the on-foot player (BasisPlayerFlight): one always-on singleton, suppressed while
            // riding a board. A player-follow behaviour with no scene dependencies, so it lives at scene root.
            EnsurePlayerFlight();

            // The UI boards (Performance toggles + Info/controls panel) standing at the start gate.
            if (BasisBoardsSetup.SetupUiBoards()) Debug.Log("Basis: built the Performance + Info boards at the start gate.");

            var scene = root.scene;
            UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(scene);
        }

        // Drop (or reuse) the single BasisPlayerFlight object at scene root so the on-foot player can trigger-fly. Also a
        // menu so it can be added to an already-loaded scene. Idempotent: reuses the existing one.
        [MenuItem("OpenSlope Basis/Setup/Player Flight", false, 111)]
        public static void EnsurePlayerFlight()
        {
            var existing = Object.FindFirstObjectByType<BasisPlayerFlight>(FindObjectsInactive.Include);
            if (existing != null) return;
            var go = new GameObject("PlayerFlight");
            go.AddComponent<BasisPlayerFlight>();
            Undo.RegisterCreatedObjectUndo(go, "Setup Player Flight");
            Debug.Log("Basis: added PlayerFlight (jump + hold trigger to fly on foot; the board suppresses it while riding).");
        }

        // Find the BasisScene component anywhere in the loaded scene, by component type NAME (so this file needs no
        // compile-time reference to the Basis assembly).
        static Component FindBasisScene()
        {
            foreach (var go in Object.FindObjectsOfType<GameObject>())
            {
                var c = go.GetComponent("BasisScene");
                if (c != null) return c;
            }
            return null;
        }

        static Transform FindTerrain(Transform root)
        {
            foreach (var mf in root.GetComponentsInChildren<MeshFilter>(true))
                if (mf.gameObject.name == "Terrain") return mf.transform;
            return null;
        }
    }
}
#endif
