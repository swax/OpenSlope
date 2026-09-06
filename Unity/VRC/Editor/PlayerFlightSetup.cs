#if UNITY_EDITOR
using System.IO;
using UnityEditor;
using UnityEngine;
using UdonSharp;
using UdonSharpEditor;

namespace OpenSlope.VrcPlugin
{

    // Library setup step: stand up the free-standing "trigger jetpack" flight (PlayerFlight - jump + hold the
    // trigger to thrust where your hand points; see docs/vrchat/024-player-flight.md). It's a single always-on object at the
    // standard path OpenSlope_Map/PlayerFlight that runs on the local player only - no clips, no per-instance wiring. The
    // rideable boards auto-find it by that path at Start and suppress it while ridden (the board's triggers are
    // ollie/boost), so this just needs to exist in the scene.
    //
    // Works in ANY OpenSlope world (no game level required): it find-or-creates the neutral OpenSlope_Map root (Map) and drops
    // the flight under it. Lives under OpenSlope_Map, so loading/switching a map (which clears OpenSlope_Map) removes it and it
    // must be re-run - same as the other post-load setup steps. The transform is irrelevant: the runtime works off the
    // player's world position + raycasts and never reads its own transform.
    //
    // The Udon-attach dance (program asset must exist before AddUdonSharpComponent; first run in a fresh project
    // creates+compiles it and stops, second run attaches) is the same recipe as MusicDirectorSetup - see
    // docs/vrchat/013-udon-components.md.
    public static class PlayerFlightSetup
    {
        const string ChildName = Map.PlayerFlight;   // OpenSlope_Map/PlayerFlight

        [MenuItem("OpenSlope/Setup/Player Flight", false, 111)]
        public static void Setup()
        {
            // Two-step bootstrap: a just-created U# program asset can't have a component attached in the same call
            // (UdonSharp finalizes it on the next editor tick).
            bool firstTime = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(PlayerFlight)) == null;
            var programAsset = EnsureProgramAsset();
            if (programAsset == null) { Debug.LogError("OpenSlope: could not create/find the PlayerFlight program asset; aborting."); return; }
            if (firstTime)
            {
                Debug.Log("OpenSlope: created the PlayerFlight Udon program asset. UdonSharp finalizes it on the next " +
                          "editor tick - run 'OpenSlope/Setup/Player Flight' again to attach it.");
                return;
            }

            Transform root = Map.ResolveRoot(true);   // find-or-create OpenSlope_Map (works in any world)
            var existing = root.Find(ChildName);
            if (existing != null) Object.DestroyImmediate(existing.gameObject);
            var go = new GameObject(ChildName);
            go.transform.SetParent(root, false);

            var proxy = go.AddUdonSharpComponent<PlayerFlight>();
            UdonSharpEditorUtility.CopyProxyToUdon(proxy);

            EditorSceneMarkDirty(go);
            Debug.Log($"OpenSlope: player flight set up at {Map.RootName}/{ChildName} (PlayerFlight). Free-standing " +
                      "players jump + hold the RIGHT trigger (VR) / Use (desktop) to fly where they point; boards " +
                      "suppress it while ridden. Tune the feel knobs on the component. Re-run after loading a map. " +
                      "Enter Play mode (ClientSim) or upload to try it.");
        }

        // Create the UdonSharpProgramAsset for PlayerFlight if absent, then compile so it carries a serialized
        // Udon program. AddUdonSharpComponent REQUIRES this to already exist. (Same recipe as MusicDirectorSetup.)
        static UdonSharpProgramAsset EnsureProgramAsset()
        {
            var existing = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(PlayerFlight));
            if (existing != null) return existing;

            string scriptPath = null;
            foreach (var guid in AssetDatabase.FindAssets("PlayerFlight t:MonoScript"))
            {
                var p = AssetDatabase.GUIDToAssetPath(guid);
                if (p.EndsWith("/PlayerFlight.cs")) { scriptPath = p; break; }
            }
            if (scriptPath == null) { Debug.LogError("OpenSlope: PlayerFlight.cs not found in project."); return null; }

            var script = AssetDatabase.LoadAssetAtPath<MonoScript>(scriptPath);
            var pa = ScriptableObject.CreateInstance<UdonSharpProgramAsset>();
            pa.sourceCsScript = script;
            string assetPath = Path.ChangeExtension(scriptPath, ".asset");
            AssetDatabase.CreateAsset(pa, assetPath);
            AssetDatabase.Refresh();
            UdonSharpProgramAsset.CompileAllCsPrograms(true);
            Debug.Log($"OpenSlope: created UdonSharp program asset {assetPath}");
            return UdonSharpProgramAsset.GetProgramAssetForClass(typeof(PlayerFlight));
        }

        static void EditorSceneMarkDirty(GameObject go)
            => UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);
    }
}
#endif
