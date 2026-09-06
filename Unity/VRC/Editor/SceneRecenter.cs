#if UNITY_EDITOR
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using VRC.SDK3.Components;

namespace OpenSlope.VrcPlugin
{

    // Post-import tool (docs/vrchat/027). The importer can recenter the whole level so the mountain's MIDDLE is
    // the world origin instead of the summit (ImportConfig.RecenterToOrigin) - Quest loses precision far from
    // 0,0,0, so the bottom of the run wobbles/z-fights until the level is pulled in toward the origin. Everything
    // the importer builds rides along automatically because it's parented under OpenSlope_Map/Level; this menu brings the
    // few SCENE-ROOT objects the importer doesn't own along with it:
    //   - the VRChat spawn point(s) on the scene's VRCSceneDescriptor,
    //   - anything you've SELECTED (stray test boards, a flight rig, etc.).
    // (The OpenSlope_StartGate is NOT handled here - its own menu is recenter-aware and rebuilds in the right frame.)
    //
    // The shift is the DELTA since this menu last ran in this scene (stored in EditorPrefs), so it's idempotent:
    // run it as often as you like and objects only ever move by what's actually changed. The importer's offset is
    // deterministic (computed from the terrain bounds), so in practice you run this ONCE after first enabling the
    // recenter and never again.
    public static class SceneRecenter
    {
        const string RootName = Map.RootName;           // "OpenSlope_Map" (identity); the recenter offset is on its Level child
        const string PrefPrefix = "OpenSlope_RecenterApplied_"; // + scene path -> last-applied total offset

        [MenuItem("OpenSlope/Tools/Recenter Scene Objects", false, 721)]
        public static void Recenter()
        {
            var root = GameObject.Find(RootName);
            if (root == null) { Debug.LogError($"OpenSlope: '{RootName}' not found - run OpenSlope/Load first."); return; }

            // The importer's recenter offset lives on the OpenSlope_Map/Level child (OpenSlope_Map itself stays at the origin).
            // With Locations baked + the spawn auto-pointed by the importer, this is usually a no-op; it remains for
            // bringing stray SELECTED scene-root objects into the recentered frame.
            Transform lvl = root.transform.Find("Level");
            Vector3 offset = lvl != null ? lvl.position : root.transform.position;
            var scene = EditorSceneManager.GetActiveScene();
            string key = PrefPrefix + scene.path;
            Vector3 last = ReadVec(key);
            Vector3 delta = offset - last;

            if (delta.sqrMagnitude < 1e-6f)
            {
                Debug.Log($"OpenSlope: scene objects already aligned to the recentered world (offset {offset}). Nothing to move.");
                return;
            }

            int moved = 0;

            // VRChat spawn point(s).
            var desc = Object.FindObjectOfType<VRCSceneDescriptor>();
            if (desc != null && desc.spawns != null)
            {
                foreach (var s in desc.spawns)
                {
                    if (s == null) continue;
                    Undo.RecordObject(s, "Recenter spawn");
                    s.position += delta;
                    moved++;
                }
            }
            else
            {
                Debug.LogWarning("OpenSlope: no VRCSceneDescriptor spawn points found - set your spawn point, then re-run this.");
            }

            // Any scene-root objects you've selected (e.g. a standalone test board) - skip the import root and the
            // gate (the gate is owned by its own recenter-aware menu).
            foreach (var go in Selection.gameObjects)
            {
                if (go == null || go.transform.parent != null) continue;       // root-level only
                if (go.name == RootName || go.name == Map.StartGate) continue; // owned elsewhere
                Undo.RecordObject(go.transform, "Recenter selected");
                go.transform.position += delta;
                moved++;
            }

            WriteVec(key, offset);
            EditorSceneManager.MarkSceneDirty(scene);
            Debug.Log($"OpenSlope: shifted {moved} scene object(s) by {delta} to match the recentered world (total offset {offset}). " +
                      "Re-run 'OpenSlope/Setup/Start Gate Boards' to place the gate in the same frame.");
        }

        [MenuItem("OpenSlope/Tools/Recenter Scene Objects", true)]
        static bool RecenterEnabled() => GameObject.Find(RootName) != null;

        static Vector3 ReadVec(string key)
        {
            string s = EditorPrefs.GetString(key, "");
            var p = s.Split(';');
            if (p.Length == 3 &&
                float.TryParse(p[0], out float x) && float.TryParse(p[1], out float y) && float.TryParse(p[2], out float z))
                return new Vector3(x, y, z);
            return Vector3.zero;
        }

        static void WriteVec(string key, Vector3 v)
            => EditorPrefs.SetString(key, $"{v.x:R};{v.y:R};{v.z:R}");
    }
}
#endif
