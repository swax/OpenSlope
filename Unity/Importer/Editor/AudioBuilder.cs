#if UNITY_EDITOR
using System.IO;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Places the decoded SSX audio into the scene as native Unity AudioSources under Audio, each tagged SpatialAudio
    // so the platform wiring pass gives it a spatial pairing (see ConfigureSpatial - VRChat otherwise auto-adds one with a
    // 40 m Far that discards our rolloff and silences distant emitters). The looping sources are stock components;
    // native ExternalSounds share one small proximity gate, while dynamic music and contact SFX have their own systems.
    //
    // Clips come from the CLI's Audio/ export (Audio/Music/*.wav + Audio/SFX/<bank>/NNN.wav) and authored Sounds/*.wav
    // staging area (both gitignored and auto-imported by Unity as AudioClips). Three source families:
    //   - Crowd: retail maps use their ADL ExternalSounds type-0 emitters (event ids 97..99), preserving the
    //     shipped position offset, radius, crowd-bank clip, and falloff curve. CrowdCentroids is retained only as
    //     a legacy/fan-map fallback when no native crowd records exist.
    //   - Environment: the fixed global-bank programs (birds, animals, machinery, city beds...) resolve to
    //     their named decoded BNK/000 clip and use the same retail placement/radius/falloff contract. The CLI
    //     normalizes both retail record shapes into it: type-0 points directly, and type-1 oriented ellipsoids
    //     as their volume-equivalent sphere, so nothing here is record-type aware.
    //   - Environment bed: the explicit Audio/Environment.json off-board filler, never inferred from event
    //     116/117, a placed emitter, or weather state.
    //   - Placed loops: decoded native ExternalSounds plus Slopesmith ambient emitters at their authored positions/radii.
    // Clip picks are first-guesses from the numbered banks - retune in ImportConfig. See docs/015-audio-runtime.md.
    public class AudioBuilder
    {
        readonly ImportConfig _cfg;
        readonly CollisionBuilder _collision;

        public AudioBuilder(ImportConfig cfg, CollisionBuilder collision) { _cfg = cfg; _collision = collision; }

        public void Build(Transform root)
        {
            if (!_cfg.BuildAudio) return;

            var old = root.Find("Audio");
            if (old != null) Object.DestroyImmediate(old.gameObject);

            var audioRoot = new GameObject("Audio");
            audioRoot.transform.SetParent(root, false);

            var bundle = new BundleManifestReader(_cfg);
            bool hasNativeCrowd = bundle.PlacedLoops.Exists(IsNativeCrowd);
            var proximityLoops = new List<AudioSource>();
            // Early bundle-v2 manifests could contain both decoded ADL crowd records and geometry centroids. Prefer
            // the classified records here too, so importing one of those bundles cannot create duplicate voices.
            int crowd = _cfg.CrowdAudio && !hasNativeCrowd ? BuildCrowd(audioRoot.transform, proximityLoops, bundle) : 0;
            bool environmentBed = BuildEnvironmentBed(audioRoot.transform);
            int placed = BuildPlacedLoops(audioRoot.transform, proximityLoops, bundle, out int nativeCrowd, out int nativeEnvironment);
            crowd += nativeCrowd;

            // SSX only maintains external voices near the listener. One shared, throttled manager reproduces that
            // gate so Quest does not decode/mix every course-wide crowd/environment loop merely because it exists.
            if (proximityLoops.Count > 0)
            {
                var gate = audioRoot.AddComponent<ProximityAudioMarker>();
                gate.sources = proximityLoops.ToArray();
                gate.pollSeconds = 0.5f;
            }

            if (crowd == 0 && !environmentBed && placed == 0)
            {
                Object.DestroyImmediate(audioRoot);
                Debug.Log("OpenSlope: audio - nothing placed (no clips found - run `snowknife sfx`/`import` to decode them).");
                return;
            }

            Debug.Log($"OpenSlope: audio - {crowd} crowd source(s), {nativeEnvironment} native environment source(s), " +
                      $"{placed - nativeCrowd - nativeEnvironment} authored ambient loop(s)"
                      + (environmentBed ? ", environment bed" : "") +
                      $" under Audio (native AudioSources; clips from {_cfg.LevelFolder}/Audio). " +
                      "Footstep/board SFX: run OpenSlope/Setup/Surface Audio; music: OpenSlope/Setup/Music Director.");
        }

        // Per-instance ExternalSounds from retail data and Slopesmith-authored ambient loops. Snowknife resolves
        // native event ids before the bundle boundary, so this importer consumes an explicit Sounds/*.wav or
        // Audio/SFX/<bank>/<slot>.wav clip and carries no event table. U5/radius is already converted to metres.
        int BuildPlacedLoops(Transform audioRoot, List<AudioSource> proximityLoops, BundleManifestReader bundle,
            out int nativeCrowd, out int nativeEnvironment)
        {
            int made = 0; nativeCrowd = 0; nativeEnvironment = 0;
            var gatedLoops = new List<GameObject>(); var gatedOwners = new List<string>();
            foreach (var loop in bundle.PlacedLoops)
            {
                bool isCrowd = IsNativeCrowd(loop);
                bool isEnvironment = IsNativeEnvironment(loop);
                bool isNativeExternal = isCrowd || isEnvironment;
                if (isCrowd && !_cfg.CrowdAudio) continue;
                var clip = _collision.LoadImpactClip(loop.Sound, loop.SoundClip);
                if (clip == null)
                {
                    Debug.LogWarning($"OpenSlope: placed ambient '{loop.Name}' has no resolvable clip (event {loop.Sound}).");
                    continue;
                }
                var go = new GameObject("Placed_" + loop.Name);
                go.transform.SetParent(audioRoot, false);
                go.transform.localPosition = loop.Center;
                var src = go.AddComponent<AudioSource>();
                // Hit-gated loops play-on-awake so the platform wiring can start one with a bare SetActive(true).
                ConfigureLoop(src, clip, isCrowd ? _cfg.CrowdVolume : 1f, spatialBlend: 1f,
                    playOnAwake: !isNativeExternal || loop.HitGated);
                ConfigureRolloff(src, loop.Curve);
                src.minDistance = 0.25f;
                src.maxDistance = Mathf.Max(src.minDistance, loop.Radius);
                if (loop.HitGated)
                {
                    // Interactive ambient (events 16/28/57): retail keeps these SILENT until the rider first hits
                    // the owning prop, then audible forever. The trigger is the impact, not the impact SOUND -
                    // hydrants carry the silent collision sentinel and still spray [Trailmap: 420-interactive-gate].
                    // The object starts inactive and is excluded from the proximity manager; platform wiring realizes
                    // the impact pairing off the marker and activates it (the proximity gate then applies as normal).
                    var mk = go.AddComponent<HitGatedLoopMarker>();
                    mk.source = src; mk.owner = loop.Owner; mk.sound = loop.Sound;
                    go.SetActive(false);
                    gatedLoops.Add(go); gatedOwners.Add(loop.Owner ?? "");
                    nativeEnvironment++;
                }
                else if (isNativeExternal)
                {
                    src.priority = isCrowd ? 200 : 210; // impacts/ride cues win first at the platform real-voice cap
                    proximityLoops.Add(src);            // starts only inside the authored radius
                    if (isCrowd) nativeCrowd++; else nativeEnvironment++;
                }
                ConfigureSpatial(src);
                made++;
            }
            if (gatedLoops.Count > 0) WireHitGatedLoops(audioRoot, gatedLoops, gatedOwners);
            return made;
        }

        // Hit-gated loops need a trigger. Fire hydrants pair EXACTLY: their collision-triggered ambient emitter
        // (built earlier this import, named "Ambient_<idx>_<instance>") activates the spray on its burst and stops
        // it when the lid re-arms. Everything - cars and police included - also goes into one manager marker the
        // platform wiring hands to the rideable boards: a wall impact activates the nearest inactive loop within
        // range, which tracks retail's actual rule (hitting a prop enables its loop, whether or not that hit made
        // any sound of its own) [Trailmap: 420-interactive-gate].
        static void WireHitGatedLoops(Transform audioRoot, List<GameObject> gatedLoops, List<string> gatedOwners)
        {
            int paired = 0;
            var emitters = Object.FindObjectsOfType<AmbientEmitterMarker>(true);
            for (int i = 0; i < gatedLoops.Count; i++)
            {
                if (string.IsNullOrEmpty(gatedOwners[i])) continue;
                foreach (var em in emitters)
                {
                    if (!em.gameObject.name.EndsWith("_" + gatedOwners[i])) continue;
                    em.GatedLoop = gatedLoops[i];
                    EditorUtility.SetDirty(em);
                    paired++;
                    break;
                }
            }
            var holder = new GameObject("HitGatedLoops");
            holder.transform.SetParent(audioRoot, false);
            var mk = holder.AddComponent<HitGatedLoopsMarker>();
            mk.loops = gatedLoops.ToArray();
            mk.activateRadius = 18f;   // covers the largest authored emitter offset (police siren, 14 m)
            mk.activeSeconds = 7f;     // global wind-down for retail-infinite loops - the hydrants' authored SSF cadence
            Debug.Log($"OpenSlope: audio - {gatedLoops.Count} hit-gated loop(s) start silent; {paired} paired to ambient emitters (hydrants), the rest arm on board impact.");
        }

        // Crowd: one looping 3D source at each grandstand centroid the bundle clustered (manifest.Audio.CrowdCentroids).
        int BuildCrowd(Transform audioRoot, List<AudioSource> proximityCrowds, BundleManifestReader bundle)
        {
            var clips = LoadClips(_cfg.CrowdClips);
            if (clips.Count == 0)
            {
                Debug.LogWarning("OpenSlope: audio - no crowd clips found under " + _cfg.LevelFolder + "/Audio/SFX/Crowd (run `snowknife sfx`).");
                return 0;
            }

            // Stand centroids come from the bundle (snowknife clustered the mat_crowd billboards). They're in
            // Props-local space; Props + Audio both sit at the root with identity local transforms, so a local
            // position copies straight across and the root's scale + orientation (docs/unity/004) carry the source
            // into world place.
            if (!bundle.Exists || bundle.CrowdCentroids.Count == 0)
            { Debug.Log("OpenSlope: audio - no crowd centroids in the bundle; skipping crowd loops."); return 0; }
            var centroids = bundle.CrowdCentroids;

            for (int i = 0; i < centroids.Count; i++)
            {
                var clip = clips[i % clips.Count];
                var go = new GameObject($"Crowd_{i:D2}");
                go.transform.SetParent(audioRoot, false);
                go.transform.localPosition = centroids[i];

                var src = go.AddComponent<AudioSource>();
                ConfigureLoop(src, clip, _cfg.CrowdVolume, spatialBlend: 1f, playOnAwake: false);
                src.rolloffMode = AudioRolloffMode.Linear;
                src.minDistance = _cfg.CrowdMinDistance;
                src.maxDistance = _cfg.CrowdMaxDistance;
                src.priority = 200;
                src.time = (i * 1.37f) % Mathf.Max(0.1f, clip.length);   // start each stand at a different offset
                ConfigureSpatial(src);                                   // honour the 10-180 m range in VRChat
                proximityCrowds.Add(src);
            }
            return centroids.Count;
        }

        static bool IsNativeCrowd(BundleManifestReader.PlacedLoop loop) =>
            loop.Kind == "native-crowd" ||
            (string.IsNullOrEmpty(loop.Kind) && loop.Sound >= 97 && loop.Sound <= 99);

        static bool IsNativeEnvironment(BundleManifestReader.PlacedLoop loop) =>
            loop.Kind == "native-environment";

        // Maps owns this choice. The importer reads the declared map-relative clip and gain and carries no
        // Wind1 special case; a null Bed is an authored opt-out. The native source plays on awake as a useful
        // engine-neutral filler. VRChat's MusicDirector takes it over as the preferred off-board layer.
        bool BuildEnvironmentBed(Transform audioRoot)
        {
            string full = Path.Combine(Path.GetDirectoryName(Application.dataPath), _cfg.LevelFolder,
                "Audio", "Environment.json");
            if (!File.Exists(full)) return false;
            try
            {
                var document = JObject.Parse(File.ReadAllText(full));
                if ((string)document["Schema"] != "openslope-environment-audio/v1")
                    throw new InvalidDataException("unsupported Schema");
                var bed = document["Bed"] as JObject;
                if (bed == null) return false;
                string clipPath = (string)bed["Clip"];
                float volume = Mathf.Clamp01((float?)bed["Volume"] ?? 0f);
                if (string.IsNullOrEmpty(clipPath) || !clipPath.StartsWith("Audio/SFX/") ||
                    clipPath.Contains("..") || !clipPath.EndsWith(".wav"))
                    throw new InvalidDataException("invalid Bed.Clip");
                var clip = AssetDatabase.LoadAssetAtPath<AudioClip>(_cfg.LevelFolder + "/" + clipPath);
                if (clip == null)
                {
                    Debug.LogWarning($"OpenSlope: environment bed clip not found: {_cfg.LevelFolder}/{clipPath} " +
                                     "(run `snowknife sfx`/`import`).");
                    return false;
                }
                var go = new GameObject("EnvironmentBed");
                go.transform.SetParent(audioRoot, false);
                var source = go.AddComponent<AudioSource>();
                ConfigureLoop(source, clip, volume, spatialBlend: 0f);
                ConfigureSpatial(source);
                return true;
            }
            catch (System.Exception ex)
            {
                Debug.LogWarning($"OpenSlope: invalid {_cfg.LevelFolder}/Audio/Environment.json ({ex.Message}); " +
                                 "environment bed skipped.");
                return false;
            }
        }

        // Retail BNKl slots carry SPU loop points (0x86/0x87): the voice plays the whole sample once, then
        // sustains only the tagged region. For attack+sustain sounds (the Merqury hydrant hiss sustains 0.27s
        // of its 1.13s clip) looping the full wav re-fires the attack every wrap - it reads as a collision
        // sound repeating forever. The CLI decodes the sustain region to a NNN.loop.wav sibling; every looping
        // bed prefers it when present. (Deliberate simplification: the one-time attack per range-entry is
        // dropped rather than re-played per entry - see docs/015.)
        static AudioClip PreferLoopRegion(AudioClip clip)
        {
            if (clip == null) return null;
            string p = AssetDatabase.GetAssetPath(clip);
            if (string.IsNullOrEmpty(p) || !p.EndsWith(".wav") || p.EndsWith(".loop.wav")) return clip;
            var region = AssetDatabase.LoadAssetAtPath<AudioClip>(p.Substring(0, p.Length - 4) + ".loop.wav");
            return region != null ? region : clip;
        }

        static void ConfigureLoop(AudioSource src, AudioClip clip, float vol, float spatialBlend, bool playOnAwake = true)
        {
            src.clip = PreferLoopRegion(clip);
            src.loop = true;
            src.playOnAwake = playOnAwake;
            src.volume = vol;
            src.spatialBlend = spatialBlend;
            src.dopplerLevel = 0f;      // SSX sources are static beds; no pitch wobble from listener motion
        }

        // An ADL record selects one of six normalized-distance falloff functions (type-0 in U6, type-1 in U11; the
        // CLI resolves either into the manifest's Curve). Retail crowd records use 2 (exact Unity linear rolloff);
        // the other curves do occur on environment records and are sampled into a custom curve here so the manifest
        // does not throw away the traced behavior.
        static void ConfigureRolloff(AudioSource src, int selector)
        {
            if (selector == 2) { src.rolloffMode = AudioRolloffMode.Linear; return; }
            var keys = new Keyframe[17];
            for (int i = 0; i < keys.Length; i++)
            {
                float d = i / (keys.Length - 1f), x = 1f - d, v;
                switch (selector)
                {
                    case 0: v = 1f - d * d; break;
                    case 1: v = 1f - d / (1.5f - 0.5f * d); break;
                    case 3: v = x / (1.5f - 0.5f * x); break;
                    case 4: v = x * x; break;
                    case 5: v = d <= 0.7f ? 1f : x / 0.3f; break;
                    default: v = x; break;
                }
                keys[i] = new Keyframe(d, Mathf.Clamp01(v));
            }
            var curve = new AnimationCurve(keys);
            for (int i = 0; i < keys.Length; i++)
            {
                AnimationUtility.SetKeyLeftTangentMode(curve, i, AnimationUtility.TangentMode.Linear);
                AnimationUtility.SetKeyRightTangentMode(curve, i, AnimationUtility.TangentMode.Linear);
            }
            src.rolloffMode = AudioRolloffMode.Custom;
            src.SetCustomCurve(AudioSourceCurveType.CustomRolloff, curve);
        }

        // Tag the source so the platform wiring pass gives it a spatial pairing. VRChat auto-adds one to every AudioSource
        // at world load with Far = 40 m and UseAudioSourceVolumeCurve = false, which DISCARDS the AudioSource's rolloff /
        // min-max and makes the 3D crowd (max 180 m) inaudible past 40 m. The pairing reads this source's own curve
        // instead: a positional bed (spatialBlend > 0) gets spatialization on with its range, a 2D bed (spatialBlend 0)
        // gets it off so it stays heard everywhere. Editor/ClientSim already use the AudioSource curve; this only changes the upload.
        static void ConfigureSpatial(AudioSource src)
        {
            src.gameObject.AddComponent<SpatialAudio>();
        }

        AudioClip LoadClip(string rel) => AssetDatabase.LoadAssetAtPath<AudioClip>(_cfg.LevelFolder + "/Audio/" + rel);

        List<AudioClip> LoadClips(string[] rels)
        {
            var list = new List<AudioClip>();
            if (rels != null) foreach (var r in rels) { var c = LoadClip(r); if (c != null) list.Add(c); }
            return list;
        }
    }
}
#endif
