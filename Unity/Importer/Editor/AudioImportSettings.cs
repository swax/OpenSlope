#if UNITY_EDITOR
using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Default import settings for SSX audio. snowknife decodes the game audio to WAV (Audio/Music/*.wav,
    // Audio/SFX/<bank>/NNN.wav, speech/mc/<word>/NNN.wav), while Slopesmith stages authored/donor prop clips in
    // Sounds/*.wav. Unity encodes them on import. At Unity's defaults
    // every clip lands as near-max-quality Vorbis in STEREO - which is what made the audio-heavy levels carry
    // ~44 MB of Vorbis in the .vrcw (audio is the ONE thing that doesn't shrink further in the bundle's LZ4 pass,
    // so it maps ~1:1 onto download size). This postprocessor stamps the download levers on every SSX clip
    // as it imports:
    //   - Vorbis @ Quality - the "~q4" point from the codec sweep (~83 kbps stereo), barely audible loss on 22 kHz
    //     game audio yet ~40-55% smaller than the ~max-quality default.
    //   - Force-to-mono for positional SFX/speech: VRChat plays these through VRCSpatialAudioSource (3D), which is
    //     mono at the source anyway, so this is a free ~2x on any stereo SFX. MUSIC stays stereo (the
    //     music director beds are 2D) unless you flip MonoMusic.
    // Load type is intentionally left untouched here - that's a RAM/CPU lever, not a download one, and forcing the
    // hundreds of looping crowd beds to CompressedInMemory would multiply Vorbis decodes. Tune the consts below;
    // "OpenSlope/Tools/Reimport Map Audio" re-stamps clips already in the project (the postprocessor only fires on import).
    public class AudioImportSettings : AssetPostprocessor
    {
        public const float Quality      = 0.5f;   // Unity Vorbis quality 0..1; ~the q4 sweep point (~83 kbps stereo)
        public const bool  MonoSfx      = true;   // force positional SFX/speech to mono (free under VRChat spatialization)
        public const bool  MonoMusic    = false;  // keep music stereo (2D director beds); set true to mono music too
        public const uint  MusicMaxRate = 32000;  // cap MUSIC sample rate (race-song chunks decode at 44.1 kHz); 0 = preserve

        void OnPreprocessAudio()
        {
            if (!IsMapAudio(assetPath)) return;
            var imp = (AudioImporter)assetImporter;
            bool music = assetPath.Contains("/Audio/Music/");

            var s = imp.defaultSampleSettings;
            s.compressionFormat = AudioCompressionFormat.Vorbis;
            s.quality = Quality;
            // Cap music rate so the 44.1 kHz race-song chunks downsample (~27% off). Only ever DOWNSAMPLE - the 22 kHz
            // intro stems stay put (overriding them up to 32 kHz would inflate them), so apply only when source > cap.
            if (music && MusicMaxRate > 0 && assetPath.EndsWith(".wav") && WavSampleRate(assetPath) > MusicMaxRate)
            {
                s.sampleRateSetting = AudioSampleRateSetting.OverrideSampleRate;
                s.sampleRateOverride = MusicMaxRate;
            }
            imp.defaultSampleSettings = s;

            imp.forceToMono = music ? MonoMusic : MonoSfx;
        }

        // Sample rate read straight from a canonical PCM WAV header (snowknife's AudioExporter output); 0 if unreadable.
        static uint WavSampleRate(string assetPath)
        {
            try
            {
                string abs = Path.Combine(Path.GetDirectoryName(Application.dataPath), assetPath);
                using var fs = File.OpenRead(abs);
                var b = new byte[28];
                if (fs.Read(b, 0, 28) < 28) return 0;
                if (b[0] != 'R' || b[1] != 'I' || b[2] != 'F' || b[3] != 'F') return 0;
                return BitConverter.ToUInt32(b, 24);   // 'fmt ' chunk sample rate (canonical layout)
            }
            catch { return 0; }
        }

        // Map clips live under Maps/<map>/Audio (music + SFX banks), Maps/<map>/Sounds (Slopesmith-authored/donor
        // prop hit + ambient clips), or the shared Maps/Shared/speech tree. Sounds/ is positional SFX, so it follows
        // the same mono + Vorbis policy as Audio/SFX rather than the stereo music policy.
        // Scope tightly so unrelated project/SDK audio (and other worlds) keep their own settings.
        public static bool IsMapAudio(string path)
        {
            if (!(path.EndsWith(".wav") || path.EndsWith(".aif") || path.EndsWith(".aiff") ||
                  path.EndsWith(".ogg") || path.EndsWith(".mp3"))) return false;
            return path.Contains("/Maps/") &&
                   (path.Contains("/Audio/") || path.Contains("/Sounds/") || path.Contains("/speech/"));
        }

        [MenuItem("OpenSlope/Tools/Reimport Map Audio", false, 722)]
        public static void ReimportAll()
        {
            var guids = AssetDatabase.FindAssets("t:AudioClip");
            int n = 0;
            try
            {
                AssetDatabase.StartAssetEditing();
                foreach (var g in guids)
                {
                    var p = AssetDatabase.GUIDToAssetPath(g);
                    if (IsMapAudio(p)) { AssetDatabase.ImportAsset(p, ImportAssetOptions.ForceUpdate); n++; }
                }
            }
            finally { AssetDatabase.StopAssetEditing(); }

            Debug.Log($"OpenSlope: re-stamped {n} SSX/staged audio clip(s) - Vorbis q={Quality}, mono SFX={MonoSfx}, mono music={MonoMusic}, " +
                      $"music<={MusicMaxRate}Hz. Rebuild (Build & Test) to see the new download size.");
        }
    }
}
#endif
