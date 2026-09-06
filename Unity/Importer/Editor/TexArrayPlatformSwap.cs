#if UNITY_EDITOR
using System.Linq;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Per-platform texture-array swap (pairs with TextureArrayPacker's dual bake).
    //
    // The packer writes BOTH a BC/DXT array (.../TexArrays/PC) and an ASTC array (.../TexArrays/Mobile) for every
    // batched group - because no single compressed format samples on both desktop (BC) and mobile/ASTC (Quest + iOS).
    // One material samples `_MainTexArray`; this points it at the array matching the build target. It fires when the
    // editor build target CHANGES (which is exactly what VRChat's "build for Windows + Android + iOS" does as it
    // auto-switches) AND as a build preprocessor (belt + suspenders, in case a build doesn't switch the target).
    //
    // Only the referenced array ships in each platform's bundle, so the other format costs disk but not download.
    // Idempotent: a material already on the right folder is skipped.
    public class TexArrayPlatformSwap : IActiveBuildTargetChanged, IPreprocessBuildWithReport
    {
        public int callbackOrder => 0;

        public void OnActiveBuildTargetChanged(BuildTarget previous, BuildTarget next) => SwapAll(next);
        public void OnPreprocessBuild(BuildReport report) => SwapAll(report.summary.platform);

        // Re-assert the active target's arrays once on load/recompile, so the editor view matches after a manual switch.
        [InitializeOnLoadMethod]
        static void OnLoad() => EditorApplication.delayCall += () => SwapAll(EditorUserBuildSettings.activeBuildTarget);

        [MenuItem("OpenSlope/Optimize/Re-sync Texture Arrays to Build Target", false, 503)]
        static void Manual() => SwapAll(EditorUserBuildSettings.activeBuildTarget);

        static bool Mobile(BuildTarget t) => t == BuildTarget.Android || t == BuildTarget.iOS;

        static void SwapAll(BuildTarget target)
        {
            bool mobile = Mobile(target);
            string from = mobile ? "/TexArrays/PC/" : "/TexArrays/Mobile/";
            string to   = mobile ? "/TexArrays/Mobile/" : "/TexArrays/PC/";
            int swapped = 0;

            foreach (var g in AssetDatabase.FindAssets("t:Material"))
            {
                var m = AssetDatabase.LoadAssetAtPath<Material>(AssetDatabase.GUIDToAssetPath(g));
                if (m == null || !m.HasProperty("_MainTexArray")) continue;
                if (!m.IsKeywordEnabled("_TEXARRAY") && !m.IsKeywordEnabled("_CROWD")) continue;   // batched arrays + the crowd's cd array
                var arr = m.GetTexture("_MainTexArray");
                if (arr == null) continue;
                var path = AssetDatabase.GetAssetPath(arr);
                if (string.IsNullOrEmpty(path) || !path.Contains(from)) continue;   // already on the target folder (or not ours)
                var repl = AssetDatabase.LoadAssetAtPath<Texture2DArray>(path.Replace(from, to));
                if (repl != null && repl != arr) { m.SetTexture("_MainTexArray", repl); EditorUtility.SetDirty(m); swapped++; }
            }
            if (swapped > 0)
            {
                AssetDatabase.SaveAssets();
                Debug.Log($"OpenSlope: texture arrays -> {(mobile ? "Mobile/ASTC" : "PC/BC")} for {target} ({swapped} material(s)).");
            }
        }
    }
}
#endif
