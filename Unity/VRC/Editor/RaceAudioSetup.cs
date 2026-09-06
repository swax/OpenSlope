#if UNITY_EDITOR
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UdonSharp;
using UdonSharpEditor;
using VRC.SDK3.Components;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    // VRChat post-import step: the RACE soundtrack + the MC announcer (docs/039).
    //
    // Music: loads one PathFinder song graph (`snowknife race-music` output - graph.json + chunk WAVs under
    // <level>/Audio/Music/<song>/) into RaceMusicDirector's flattened arrays. The director walks the
    // graph while you ride; the boards feed it speed/boost/air and it ducks the off-board-bed director
    // (MusicDirector) like the game's INTRODUCK.
    //
    // Announcer: loads the MC event banks (`snowknife speech` output under Assets/OpenSlope/Maps/Shared/speech/mc/)
    // into AnnouncerU; the boards fire its events (big air, landings, wipeouts, slow, boost, go).
    //
    // Both behaviours are wired into EVERY RideableBoard in the scene (the boards are the event
    // source), with CopyProxyToUdon so existing instances' backing data picks the new fields up.
    // Same two-step program-asset bootstrap as the other setups (docs/vrchat/013). Re-run after re-import.
    public static class RaceAudioSetup
    {
        const string RootName  = Map.RootName;   // "OpenSlope_Map"
        const string ChildName = "RaceAudio";
        const string SpeechMc  = MapLayout.SharedFolder + "/speech/mc";

        const float MusicVolume = 0.42f;
        const float VoiceVolume = 0.85f;

        [MenuItem("OpenSlope/Setup/Race Audio", false, 132)]
        public static void Setup()
        {
            var rootGo = GameObject.Find(RootName);
            if (rootGo == null) { Debug.LogError($"OpenSlope: '{RootName}' not found - run OpenSlope/Load first."); return; }

            bool firstMusic = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(RaceMusicDirector)) == null;
            bool firstVoice = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(AnnouncerU)) == null;
            var paMusic = EnsureProgramAsset(typeof(RaceMusicDirector), "RaceMusicDirector");
            var paVoice = EnsureProgramAsset(typeof(AnnouncerU), "AnnouncerU");
            if (paMusic == null || paVoice == null) { Debug.LogError("OpenSlope: race-audio program assets missing; aborting."); return; }
            if (firstMusic || firstVoice)
            {
                Debug.Log("OpenSlope: created the race-audio Udon program asset(s). UdonSharp finalizes them on the next " +
                          "editor tick - run 'OpenSlope/Setup/Race Audio' again to attach.");
                return;
            }

            var cfg = ImportConfig.Current();

            var existing = rootGo.transform.Find(ChildName);
            if (existing != null) Object.DestroyImmediate(existing.gameObject);
            var go = new GameObject(ChildName);
            go.transform.SetParent(rootGo.transform, false);

            // ---- race-music director (OPTIONAL: skipped when the level has no decoded PathFinder song). The announcer
            // below ALWAYS sets up - it uses the SHARED speech banks that ship with every project - so a level without
            // race music still gets its announcer + board wiring (run `snowknife race-music` to add the race soundtrack). ----
            RaceMusicDirector director = null;
            int chunkCount = 0;
            string musicRoot = cfg.LevelFolder + "/Audio/Music";
            string songDir = FindSongDir(musicRoot);
            if (songDir != null)
            {
                var musicGo = new GameObject("RaceMusic");
                musicGo.transform.SetParent(go.transform, false);
                var srcA = NewSource(musicGo.transform, "ChunkA");
                var srcB = NewSource(musicGo.transform, "ChunkB");
                director = musicGo.AddUdonSharpComponent<RaceMusicDirector>();
                director.sourceA = srcA;
                director.sourceB = srcB;
                director.volume = MusicVolume;
                director.introDirector = Object.FindObjectOfType<MusicDirector>();
                chunkCount = LoadGraph(director, songDir);
                if (chunkCount == 0)
                {
                    Debug.LogWarning($"OpenSlope: song graph at {songDir} loaded 0 chunks - race music skipped.");
                    Object.DestroyImmediate(musicGo); director = null;
                }
                else UdonSharpEditorUtility.CopyProxyToUdon(director);
            }
            else
            {
                Debug.LogWarning($"OpenSlope: no PathFinder song (graph.json) under {musicRoot} - race music skipped " +
                                 "(run `snowknife race-music <iso> <LEVEL> <levelDir>` to add it); the announcer still sets up.");
            }

            // ---- announcer ----
            var mcGo = new GameObject("Announcer");
            mcGo.transform.SetParent(go.transform, false);
            var voiceSrc = NewSource(mcGo.transform, "Voice");
            var mc = mcGo.AddUdonSharpComponent<AnnouncerU>();
            mc.source = voiceSrc;
            mc.volume = VoiceVolume;
            mc.goClips        = LoadBank("Go");
            mc.bigAirClips    = LoadBank("Big_Air");
            mc.landClips      = LoadBank("Land");
            mc.knockdownClips = LoadBank("Knockdown");
            mc.slowClips      = LoadBank("Slow");
            mc.boostClips     = LoadBank("Boost_Icon");
            mc.sweetClips     = LoadBank("Sweet");
            UdonSharpEditorUtility.CopyProxyToUdon(mc);

            // ---- wire every board (they push ride state + fire the events) ----
            int boards = 0;
            var introMusic = Object.FindObjectOfType<MusicDirector>();
            foreach (var board in Object.FindObjectsOfType<RideableBoard>(true))
            {
                board.raceMusic = director;
                board.introMusic = introMusic;
                board.announcer = mc;
                UdonSharpEditorUtility.CopyProxyToUdon(board);
                boards++;
            }

            UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);
            Debug.Log($"OpenSlope: race audio set up - song '{(songDir != null ? Path.GetFileName(songDir) : "(none - no race music decoded)")}' ({chunkCount} chunks), announcer banks " +
                      $"go/{Len(mc.goClips)} bigAir/{Len(mc.bigAirClips)} land/{Len(mc.landClips)} knockdown/{Len(mc.knockdownClips)} " +
                      $"slow/{Len(mc.slowClips)} boost/{Len(mc.boostClips)} sweet/{Len(mc.sweetClips)}, wired into {boards} board(s). " +
                      "Mount a board to hear race music replace the off-board bed. Re-run after every re-import.");
        }

        [MenuItem("OpenSlope/Setup/Race Audio", true)]
        static bool SetupEnabled() => GameObject.Find(RootName) != null;

        static int Len(AudioClip[] a) => a == null ? 0 : a.Length;

        // Pick the level's LEAD race song generically (no per-level song names, so any level we import works):
        // playlist.json[0] - the musicmap playback order snowknife writes - else the first decoded song folder.
        static string FindSongDir(string musicRoot)
        {
            string abs = Path.Combine(Path.GetDirectoryName(Application.dataPath), musicRoot);
            if (!Directory.Exists(abs)) return null;

            string playlist = Path.Combine(abs, "playlist.json");
            if (File.Exists(playlist))
                foreach (var t in JArray.Parse(File.ReadAllText(playlist)))
                {
                    string song = (string)t;
                    if (File.Exists(Path.Combine(abs, song, "graph.json"))) return musicRoot + "/" + song;
                }

            foreach (string dir in Directory.GetDirectories(abs))
                if (File.Exists(Path.Combine(dir, "graph.json")))
                    return musicRoot + "/" + Path.GetFileName(dir);
            return null;
        }

        // graph.json -> the director's flattened arrays + chunk AudioClips. Returns the chunk count (0 = fail).
        static int LoadGraph(RaceMusicDirector d, string songDir)
        {
            string absJson = Path.Combine(Path.GetDirectoryName(Application.dataPath), songDir, "graph.json");
            var j = JObject.Parse(File.ReadAllText(absJson));

            var nodes = (JArray)j["Nodes"];
            var samples = (JArray)j["Samples"];
            int sections = (int?)j["Sections"] ?? 4;

            var clips = new AudioClip[samples.Count];
            for (int i = 0; i < samples.Count; i++)
            {
                string wav = (string)samples[i]["Wav"];
                clips[i] = AssetDatabase.LoadAssetAtPath<AudioClip>(songDir + "/" + wav);
                if (clips[i] == null) { Debug.LogError($"OpenSlope: chunk clip missing: {songDir}/{wav}"); return 0; }
            }

            int n = nodes.Count;
            var nodeSample = new int[n];
            var nodeSection = new int[n];
            var linkStart = new int[n];
            var linkCount = new int[n];
            var linkNext = new List<int>();
            var linkLo = new List<int>();
            var linkHi = new List<int>();

            for (int i = 0; i < n; i++)
            {
                var node = nodes[i];
                nodeSample[i] = (int)node["Sample"];
                int flags = (int)node["Flags"];
                int section = flags & 0x7f;
                nodeSection[i] = section < sections ? section : 0;

                linkStart[i] = linkNext.Count;
                var raw = (JArray)node["LinkRaw"];
                // Sort by range start so the in-range scan is first-match, like the music graph's link selection [Trailmap: 270-music-graph].
                var entries = raw.Select(t => (uint)(long)t)
                                 .Select(r => (lo: (int)(r & 0xff), hi: (int)((r >> 8) & 0xff), next: (int)(r >> 16)))
                                 .OrderBy(e => e.lo).ToArray();
                foreach (var e in entries)
                {
                    linkLo.Add(e.lo);
                    linkHi.Add(e.hi);
                    linkNext.Add(e.next);
                }
                linkCount[i] = entries.Length;
            }

            d.chunks = clips;
            d.nodeSample = nodeSample;
            d.nodeSection = nodeSection;
            d.nodeLinkStart = linkStart;
            d.nodeLinkCount = linkCount;
            d.linkNext = linkNext.ToArray();
            d.linkLo = linkLo.ToArray();
            d.linkHi = linkHi.ToArray();
            d.sections = sections;
            d.entryNode = 0;
            d.eventTable = j["EventTable"] != null
                ? j["EventTable"].ToObject<byte[]>().Select(b => (int)b).ToArray()
                : new int[0];
            d.routers = j["Routers"] != null
                ? ((JArray)j["Routers"]).Select(t => unchecked((int)(uint)(long)t)).ToArray()
                : new int[0];
            return clips.Length;
        }

        // Load every NNN.wav of one MC bank (decoded by `snowknife speech`); empty when not decoded.
        static AudioClip[] LoadBank(string bank)
        {
            string rel = SpeechMc + "/" + bank;
            string abs = Path.Combine(Path.GetDirectoryName(Application.dataPath), rel);
            if (!Directory.Exists(abs)) return new AudioClip[0];
            var clips = new List<AudioClip>();
            foreach (string f in Directory.GetFiles(abs, "*.wav").OrderBy(f => f))
            {
                var c = AssetDatabase.LoadAssetAtPath<AudioClip>(rel + "/" + Path.GetFileName(f));
                if (c != null) clips.Add(c);
            }
            return clips.ToArray();
        }

        static AudioSource NewSource(Transform parent, string name)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            var s = go.AddComponent<AudioSource>();
            s.playOnAwake = false;
            s.loop = false;
            s.spatialBlend = 0f;     // 2D: music + the MC live in your headset
            s.dopplerLevel = 0f;
            s.volume = 0f;
            var sa = go.AddComponent<VRCSpatialAudioSource>();
            sa.EnableSpatialization = false;
            sa.UseAudioSourceVolumeCurve = true;
            return s;
        }

        // Same recipe as MusicDirectorSetup.EnsureProgramAsset, parameterized by class.
        static UdonSharpProgramAsset EnsureProgramAsset(System.Type type, string className)
        {
            var existing = UdonSharpProgramAsset.GetProgramAssetForClass(type);
            if (existing != null) return existing;

            string scriptPath = null;
            foreach (var guid in AssetDatabase.FindAssets(className + " t:MonoScript"))
            {
                var p = AssetDatabase.GUIDToAssetPath(guid);
                if (p.EndsWith("/" + className + ".cs")) { scriptPath = p; break; }
            }
            if (scriptPath == null) { Debug.LogError($"OpenSlope: {className}.cs not found in project."); return null; }

            var script = AssetDatabase.LoadAssetAtPath<MonoScript>(scriptPath);
            var pa = ScriptableObject.CreateInstance<UdonSharpProgramAsset>();
            pa.sourceCsScript = script;
            string assetPath = Path.ChangeExtension(scriptPath, ".asset");
            AssetDatabase.CreateAsset(pa, assetPath);
            AssetDatabase.Refresh();
            UdonSharpProgramAsset.CompileAllCsPrograms(true);
            Debug.Log($"OpenSlope: created UdonSharp program asset {assetPath}");
            return UdonSharpProgramAsset.GetProgramAssetForClass(type);
        }
    }
}
#endif
