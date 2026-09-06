#if UNITY_EDITOR
using System.IO;
using UnityEditor;
using UnityEngine;
using UdonSharp;
using UdonSharpEditor;
using VRC.SDK3.Components;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    // VRChat post-import step: stand up the per-surface board/footstep audio. The crowd / ambient / music
    // beds are placed by the core importer as plain AudioSources (AudioBuilder, docs/015) - they need no
    // logic, so they work in a build with no SDK. The surface SFX are different: they react to where the
    // LOCAL player is standing, which means a runtime behaviour, and in VRChat that has to be Udon. That
    // behaviour already exists - SurfaceDetector (docs/009) - so this just creates a GameObject for it,
    // gives it an AudioSource, attaches the Udon component, and assigns step clips from the decoded
    // zboard.bnk. A separate post-import step (re-run after every re-import, which rebuilds OpenSlope_Map and drops
    // this object).
    //
    // The Udon-attach dance (program asset must exist before AddUdonSharpComponent; first run in a fresh
    // project creates+compiles it and stops, second run attaches) is the same as UdonTools.AddConfigured - see
    // docs/vrchat/013-udon-components.md for the why.
    public static class SurfaceAudioSetup
    {
        const string RootName   = Map.RootName;                // "OpenSlope_Map"
        const string ChildName  = "SurfaceAudio";
        const string SharedAudio = MapLayout.SharedFolder + "/Audio";   // zboard is a SHARED bank (decoded by `snowknife shared`), not per-level

        // First-guess step clips from zboard.bnk (short carves, ~0.3-0.5 s). These are NOT verified to match
        // the surface - the bank is just numbered sounds - so retune by ear: change the index, or reassign the
        // clip on the SurfaceDetector in the inspector. snow/ice are the common surfaces.
        const string Snow    = "SFX/zboard/034.wav";
        const string Ice     = "SFX/zboard/050.wav";
        const string Rock    = "SFX/zboard/065.wav";
        const string Metal   = "SFX/zboard/080.wav";
        const string Default = "SFX/zboard/074.wav";

        // Sits in the OpenSlope/Setup submenu next to Music Director (see the priority scheme in LevelImporter).
        // Greyed out until the level exists.
        [MenuItem("OpenSlope/Setup/Surface Audio", false, 112)]
        public static void Setup()
        {
            var rootGo = GameObject.Find(RootName);
            if (rootGo == null) { Debug.LogError($"OpenSlope: '{RootName}' not found - run OpenSlope/Load first."); return; }

            // Same two-step bootstrap as the other setup steps: a just-created U# program asset can't have a
            // component attached in the same call (UdonSharp finalizes it only on the next editor tick).
            bool firstTime = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(SurfaceDetector)) == null;
            var programAsset = EnsureProgramAsset();
            if (programAsset == null) { Debug.LogError("OpenSlope: could not create/find the SurfaceDetector program asset; aborting."); return; }
            if (firstTime)
            {
                Debug.Log("OpenSlope: created the SurfaceDetector Udon program asset. UdonSharp finalizes it on the next " +
                          "editor tick - run 'OpenSlope/Setup/Surface Audio' again to attach it.");
                return;
            }

            // One child object holding the footstep AudioSource + the detector. Rebuilt fresh each run.
            var existing = rootGo.transform.Find(ChildName);
            if (existing != null) Object.DestroyImmediate(existing.gameObject);
            var go = new GameObject(ChildName);
            go.transform.SetParent(rootGo.transform, false);

            // 2D one-shot source the steps play through (PlayOneShot); not looping, not auto-playing.
            var src = go.AddComponent<AudioSource>();
            src.playOnAwake = false;
            src.loop = false;
            src.spatialBlend = 0f;       // "your own" footsteps - non-positional
            src.dopplerLevel = 0f;
            // Explicit 2D spatial-audio component (spatialization OFF), same as the rideable board + music bed.
            // Without it VRChat auto-adds one at world load (and the validator WARNS "2D audio source found with no
            // VRC spatial audio component"), which would spatialize the rider's OWN footsteps under their feet.
            var sa = go.AddComponent<VRCSpatialAudioSource>();
            sa.EnableSpatialization = false;
            sa.UseAudioSourceVolumeCurve = true;

            var proxy = go.AddUdonSharpComponent<SurfaceDetector>();
            var terrainCol = rootGo.transform.Find(Map.CollisionName);   // OpenSlope_Map/Collision (re-exposed at the top)
            if (terrainCol != null) proxy.collisionRoot = terrainCol;       // else the detector auto-finds it at runtime
            proxy.footstepSource = src;
            proxy.snowStep    = LoadClip(Snow);
            proxy.iceStep     = LoadClip(Ice);
            proxy.rockStep    = LoadClip(Rock);
            proxy.metalStep   = LoadClip(Metal);
            proxy.defaultStep = LoadClip(Default);
            UdonSharpEditorUtility.CopyProxyToUdon(proxy);

            int got = 0; foreach (var c in new[] { proxy.snowStep, proxy.iceStep, proxy.rockStep, proxy.metalStep, proxy.defaultStep }) if (c != null) got++;
            EditorSceneMarkDirty(go);
            Debug.Log($"OpenSlope: surface audio set up on {RootName}/{ChildName} (SurfaceDetector + AudioSource), " +
                      $"{got}/5 step clips assigned from zboard.bnk. Clips are first-guesses - retune by ear. " +
                      (terrainCol == null ? "TerrainCollision not found yet (the detector will auto-find it at runtime). " : "") +
                      "Re-run after every re-import. Enter Play mode (ClientSim) or upload to hear it.");
        }

        [MenuItem("OpenSlope/Setup/Surface Audio", true)]
        static bool SetupEnabled() => GameObject.Find(RootName) != null;

        static AudioClip LoadClip(string rel)
        {
            var c = AssetDatabase.LoadAssetAtPath<AudioClip>(SharedAudio + "/" + rel);
            if (c == null) Debug.LogWarning($"OpenSlope: surface-audio clip not found: {SharedAudio}/{rel} (run `snowknife shared`).");
            return c;
        }

        // Create the UdonSharpProgramAsset for SurfaceDetector if absent, then compile so it carries a
        // serialized Udon program. AddUdonSharpComponent REQUIRES this to already exist. (Same recipe as
        // UdonTools.EnsureProgramAsset.)
        static UdonSharpProgramAsset EnsureProgramAsset()
        {
            var existing = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(SurfaceDetector));
            if (existing != null) return existing;

            string scriptPath = null;
            foreach (var guid in AssetDatabase.FindAssets("SurfaceDetector t:MonoScript"))
            {
                var p = AssetDatabase.GUIDToAssetPath(guid);
                if (p.EndsWith("/SurfaceDetector.cs")) { scriptPath = p; break; }
            }
            if (scriptPath == null) { Debug.LogError("OpenSlope: SurfaceDetector.cs not found in project."); return null; }

            var script = AssetDatabase.LoadAssetAtPath<MonoScript>(scriptPath);
            var pa = ScriptableObject.CreateInstance<UdonSharpProgramAsset>();
            pa.sourceCsScript = script;
            string assetPath = Path.ChangeExtension(scriptPath, ".asset");
            AssetDatabase.CreateAsset(pa, assetPath);
            AssetDatabase.Refresh();
            UdonSharpProgramAsset.CompileAllCsPrograms(true);
            Debug.Log($"OpenSlope: created UdonSharp program asset {assetPath}");
            return UdonSharpProgramAsset.GetProgramAssetForClass(typeof(SurfaceDetector));
        }

        static void EditorSceneMarkDirty(GameObject go)
            => UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);
    }
}
#endif
