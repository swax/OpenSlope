#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;
using UdonSharp;
using UdonSharpEditor;

namespace OpenSlope.VrcPlugin
{

    // Library setup step: stand up the BOARD VOICE CHANNEL (BoardVoiceChannel) - while you ride, you hear/are heard by
    // every other rider across the map (a shared comms channel), with normal proximity voice still layered on for anyone
    // nearby. It's a single always-on, local-only object at OpenSlope_Map/BoardVoiceChannel that reads the shared board pool's
    // BoardManager (built by StartGateSetup) to know who's riding, and sets each client's per-player voice ranges
    // accordingly. See BoardVoiceChannel for the full mechanism.
    //
    // Run AFTER 'Start Gate Boards' (it needs the board manager to exist to wire into). Lives under OpenSlope_Map, so loading/
    // switching a map removes it and it must be re-run - same as the other post-load setup steps. The Udon two-step
    // bootstrap (a just-created program asset can't take a component in the same call) mirrors PlayerFlightSetup.
    public static class BoardVoiceChannelSetup
    {
        const string ChildName = "BoardVoiceChannel";   // OpenSlope_Map/BoardVoiceChannel

        [MenuItem("OpenSlope/Setup/Board Voice Channel", false, 131)]
        public static void Setup()
        {
            // Two-step bootstrap: a just-created U# program asset can't have a component attached in the same call
            // (UdonSharp finalizes it on the next editor tick).
            UdonTools.EnsureProgramAsset(typeof(BoardVoiceChannel), out bool created);
            if (created)
            {
                Debug.Log("OpenSlope: created the BoardVoiceChannel Udon program asset. UdonSharp finalizes it on the next " +
                          "editor tick - run 'OpenSlope/Setup/Board Voice Channel' again to attach it.");
                return;
            }

            var manager = Object.FindObjectOfType<BoardManager>();
            if (manager == null)
                Debug.LogWarning("OpenSlope: no BoardManager in the scene - run 'OpenSlope/Setup/Start Gate Boards' first so the " +
                                 "voice channel has a board pool to read. Wiring it null (the channel stays inert " +
                                 "until a manager is assigned).");

            Transform root = Map.ResolveRoot(true);   // find-or-create OpenSlope_Map (works in any world)
            var existing = root.Find(ChildName);
            if (existing != null) Object.DestroyImmediate(existing.gameObject);
            var go = new GameObject(ChildName);
            go.transform.SetParent(root, false);

            var proxy = go.AddUdonSharpComponent<BoardVoiceChannel>();
            proxy.manager = manager;
            UdonSharpEditorUtility.CopyProxyToUdon(proxy);

            Selection.activeGameObject = go;
            EditorSceneMarkDirty(go);
            Debug.Log($"OpenSlope: board voice channel set up at {Map.RootName}/{ChildName} (BoardVoiceChannel). While " +
                      "riding, every rider hears every other rider across the map; nearby players still hear you normally. " +
                      "Tune the channel range/volume on the component. Needs the boards' multiplayer sync (on by default) " +
                      "and a real instance to hear - re-run after loading a map. Upload to try it.");
        }

        static void EditorSceneMarkDirty(GameObject go)
            => UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);
    }
}
#endif
