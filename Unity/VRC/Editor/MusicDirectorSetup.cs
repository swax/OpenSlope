#if UNITY_EDITOR
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UdonSharp;
using UdonSharpEditor;
using VRC.SDK3.Components;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    // VRChat post-import step: the level's off-board audio. MusicDirector prefers the map-declared EnvironmentBed;
    // without one it shuffles a tier's equal-length intro bars for an evolving fallback arrangement (see docs/015).
    // Sequencing and the mount fade need runtime logic, so in VRChat this has to be Udon - hence this
    // lives in VRC/Editor as its own step, exactly like SurfaceAudioSetup, and must be re-run after every
    // re-import (which rebuilds OpenSlope_Map).
    //
    // The Udon-attach dance (program asset must exist before AddUdonSharpComponent; first run in a fresh project
    // creates+compiles it and stops, second run attaches) is the same as SurfaceAudioSetup / UdonTools (the
    // importer's helper) - see docs/vrchat/013-udon-components.md.
    public static class MusicDirectorSetup
    {
        const string RootName    = Map.RootName;                // "OpenSlope_Map"
        const string ChildName   = "MusicDirector";
        // The fallback stems are derived per-level from <levelAudio>/Music (C by preference, then A, then B), so
        // a map without Environment.json still works without a hardcoded song name. The last loaded level folder
        // supplies both candidates; an EnvironmentBed always takes runtime precedence.
        const float Volume    = 0.30f;   // C runs ~7 dB hotter than the chill A set; trimmed so it doesn't blast
        const float Crossfade = 0.25f;
        const bool  Shuffle   = true;

        // Grouped with Surface Audio in the OpenSlope/Setup submenu (see the priority scheme in LevelImporter).
        // Greyed out until the level exists.
        [MenuItem("OpenSlope/Setup/Music Director", false, 110)]
        public static void Setup()
        {
            var rootGo = GameObject.Find(RootName);
            if (rootGo == null) { Debug.LogError($"OpenSlope: '{RootName}' not found - run OpenSlope/Load first."); return; }

            // Two-step bootstrap: a just-created U# program asset can't have a component attached in the same
            // call (UdonSharp finalizes it on the next editor tick).
            bool firstTime = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(MusicDirector)) == null;
            var programAsset = EnsureProgramAsset();
            if (programAsset == null) { Debug.LogError("OpenSlope: could not create/find the MusicDirector program asset; aborting."); return; }
            if (firstTime)
            {
                Debug.Log("OpenSlope: created the MusicDirector Udon program asset. UdonSharp finalizes it on the next " +
                          "editor tick - run 'OpenSlope/Setup/Music Director' again to attach it.");
                return;
            }

            // One child holding the director + its two crossfade AudioSources. Rebuilt fresh each run.
            var existing = rootGo.transform.Find(ChildName);
            if (existing != null) Object.DestroyImmediate(existing.gameObject);
            var go = new GameObject(ChildName);
            go.transform.SetParent(rootGo.transform, false);

            var srcA = NewSource(go.transform, "TrackA");
            var srcB = NewSource(go.transform, "TrackB");

            string levelAudio = LevelAudioDir();
            var clips = LoadClips(levelAudio, DeriveTracks(levelAudio));
            var fallback = rootGo.GetComponentsInChildren<AudioSource>(true)
                .FirstOrDefault(source => source != null && source.name == "EnvironmentBed");
            var proxy = go.AddUdonSharpComponent<MusicDirector>();
            proxy.tracks = clips;
            proxy.sourceA = srcA;
            proxy.sourceB = srcB;
            proxy.volume = Volume;
            proxy.crossfadeSeconds = Crossfade;
            proxy.shuffle = Shuffle;
            proxy.fallbackBed = fallback;
            proxy.fallbackBedVolume = fallback != null ? fallback.volume : 0f;
            UdonSharpEditorUtility.CopyProxyToUdon(proxy);

            int boards = 0;
            foreach (var board in Object.FindObjectsOfType<RideableBoard>(true))
            {
                board.introMusic = proxy;
                UdonSharpEditorUtility.CopyProxyToUdon(board);
                boards++;
            }

            EditorSceneMarkDirty(go);
            Debug.Log($"OpenSlope: music director set up on {RootName}/{ChildName} (MusicDirector + 2 AudioSources), " +
                      $"{clips.Length} intro-music bar(s) shuffled, "
                      + (fallback != null && fallback.clip != null ? "map environment bed active, " : "")
                      + $"vol {Volume}, {Crossfade:0.00}s crossfade, wired into {boards} board(s). " +
                      "Clips are first-guesses - retune by ear. Re-run after every re-import. " +
                      "Enter Play mode (ClientSim) or upload to hear it.");
        }

        [MenuItem("OpenSlope/Setup/Music Director", true)]
        static bool SetupEnabled() => GameObject.Find(RootName) != null;

        static AudioSource NewSource(Transform parent, string name)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            var s = go.AddComponent<AudioSource>();
            s.playOnAwake = false;   // the director starts them
            s.loop = false;
            s.spatialBlend = 0f;     // 2D bed
            s.dopplerLevel = 0f;
            s.volume = 0f;
            // Explicit 2D spatial-audio component: music is non-positional, so spatialization OFF. Without this
            // VRChat auto-adds one at load (and warns), risking a spatialized music bed. (Matches AudioBuilder.)
            var sa = go.AddComponent<VRCSpatialAudioSource>();
            sa.EnableSpatialization = false;
            sa.UseAudioSourceVolumeCurve = true;
            return s;
        }

        // The current level's audio folder = the last folder OpenSlope/Load imported (same EditorPref the importer writes).
        static string LevelAudioDir()
        {
            string last = EditorPrefs.GetString("OpenSlope.LastLevelFolder", ImportConfig.DefaultLevelFolder);
            return last.Replace('\\', '/').TrimEnd('/') + "/Audio";
        }

        // Derive the stems from the level's own intro music (Music/<Song>-<Tier><N>.wav), preferring the energetic C tier,
        // then A, then B - so any level's stems are found without a hardcoded song name. Returns "Music/<file>" sorted.
        static string[] DeriveTracks(string levelAudioRel)
        {
            string projRoot = Path.GetDirectoryName(Application.dataPath);
            string musicAbs = Path.Combine(projRoot, levelAudioRel, "Music");
            if (!Directory.Exists(musicAbs)) return new string[0];
            var wavs = Directory.GetFiles(musicAbs, "*.wav").Select(Path.GetFileName).ToArray();
            foreach (char tier in new[] { 'C', 'A', 'B' })
            {
                var stems = wavs.Where(f => IsTierStem(f, tier))
                                .OrderBy(f => f, System.StringComparer.OrdinalIgnoreCase).ToArray();
                if (stems.Length > 0) return stems.Select(f => "Music/" + f).ToArray();
            }
            return new string[0];
        }

        // "<song>-<tier><digits>.wav" for the given tier letter (e.g. Song-C3.wav).
        static bool IsTierStem(string file, char tier)
        {
            string name = Path.GetFileNameWithoutExtension(file);
            int dash = name.LastIndexOf('-');
            if (dash < 0 || dash + 2 > name.Length) return false;
            if (char.ToUpperInvariant(name[dash + 1]) != tier) return false;
            for (int i = dash + 2; i < name.Length; i++) if (!char.IsDigit(name[i])) return false;
            return name.Length > dash + 2;
        }

        static AudioClip[] LoadClips(string levelAudio, string[] rels)
        {
            var list = new System.Collections.Generic.List<AudioClip>();
            if (rels.Length == 0) Debug.LogWarning($"OpenSlope: no intro-music stems in {levelAudio}/Music (run `snowknife import`).");
            foreach (var r in rels)
            {
                var c = AssetDatabase.LoadAssetAtPath<AudioClip>(levelAudio + "/" + r);
                if (c == null) Debug.LogWarning($"OpenSlope: music clip not found: {levelAudio}/{r} (run `snowknife import`).");
                else list.Add(c);
            }
            return list.ToArray();
        }

        // Create the UdonSharpProgramAsset for MusicDirector if absent, then compile so it carries a
        // serialized Udon program. AddUdonSharpComponent REQUIRES this to already exist. (Same recipe as
        // SurfaceAudioSetup / UdonTools.EnsureProgramAsset.)
        static UdonSharpProgramAsset EnsureProgramAsset()
        {
            var existing = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(MusicDirector));
            if (existing != null) return existing;

            string scriptPath = null;
            foreach (var guid in AssetDatabase.FindAssets("MusicDirector t:MonoScript"))
            {
                var p = AssetDatabase.GUIDToAssetPath(guid);
                if (p.EndsWith("/MusicDirector.cs")) { scriptPath = p; break; }
            }
            if (scriptPath == null) { Debug.LogError("OpenSlope: MusicDirector.cs not found in project."); return null; }

            var script = AssetDatabase.LoadAssetAtPath<MonoScript>(scriptPath);
            var pa = ScriptableObject.CreateInstance<UdonSharpProgramAsset>();
            pa.sourceCsScript = script;
            string assetPath = Path.ChangeExtension(scriptPath, ".asset");
            AssetDatabase.CreateAsset(pa, assetPath);
            AssetDatabase.Refresh();
            UdonSharpProgramAsset.CompileAllCsPrograms(true);
            Debug.Log($"OpenSlope: created UdonSharp program asset {assetPath}");
            return UdonSharpProgramAsset.GetProgramAssetForClass(typeof(MusicDirector));
        }

        static void EditorSceneMarkDirty(GameObject go)
            => UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);
    }
}
#endif
