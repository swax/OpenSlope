#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.Profiling;
using UnityEngine.SceneManagement;

namespace OpenSlope.Importer
{

    // In-editor build-size analysis - the same picture as cracking open the built .vrcw, but computed live on the
    // active scene so you can read it before uploading. A VRChat world ships as ONE asset bundle containing only the
    // objects reachable from the scene's dependency graph, so "Analyze Scene Size" walks
    // EditorUtility.CollectDependencies over the scene roots (exactly the closure the bundle packs) and reports
    // Profiler.GetRuntimeMemorySizeLong per object, grouped by type with the biggest individual assets called out.
    //
    // Two different size numbers - know which you want:
    //   - RUNTIME memory (this tool's Scene/Audio reports): VRAM for textures, the decompressed PCM for
    //     DecompressOnLoad audio, vertex/index buffers for meshes. This is what drives the VRChat performance rank
    //     and headset RAM/VRAM budget. It is NOT the same as the download size.
    //   - DOWNLOAD size: the compressed .vrcw on disk. "List World Builds" reports that straight from the VRChat
    //     client cache. For a per-asset breakdown of the actual bundle, Unity/tools/diagnostics/analyze_vrcw.py decodes it with UnityPy.
    public static class BuildSizeAnalyzer
    {
        [MenuItem("OpenSlope/Tools/Analyze Scene Size", false, 740)]
        public static void AnalyzeSceneSize()
        {
            var scene = SceneManager.GetActiveScene();
            var roots = scene.GetRootGameObjects();
            if (roots.Length == 0) { Debug.LogWarning("[BuildSize] Active scene has no root objects."); return; }

            // Dependency closure of the scene == the set of objects the bundle packs.
            var deps = EditorUtility.CollectDependencies(roots.Cast<UnityEngine.Object>().ToArray());

            var seen = new HashSet<UnityEngine.Object>();
            var typeBytes = new Dictionary<string, long>();
            var typeCount = new Dictionary<string, int>();
            var assets = new List<(long size, string type, string name, string path)>();
            long total = 0;

            foreach (var o in deps)
            {
                if (o == null || !seen.Add(o)) continue;
                long size = Profiler.GetRuntimeMemorySizeLong(o);
                string type = o.GetType().Name;
                typeBytes.TryGetValue(type, out long b); typeBytes[type] = b + size;
                typeCount.TryGetValue(type, out int c); typeCount[type] = c + 1;
                total += size;
                if (size >= 64 * 1024 && EditorUtility.IsPersistent(o))
                    assets.Add((size, type, o.name, AssetDatabase.GetAssetPath(o)));
            }

            var sb = new StringBuilder();
            sb.AppendLine($"=== OpenSlope Build Size  -  scene '{scene.name}' ===");
            sb.AppendLine($"Objects in dependency closure: {seen.Count}");
            sb.AppendLine($"Total runtime memory (VRAM+RAM estimate): {MB(total)}");
            sb.AppendLine("  (runtime footprint, NOT the compressed .vrcw download - use 'List World Builds' for that)");
            sb.AppendLine();
            sb.AppendLine("By type:");
            foreach (var kv in typeBytes.OrderByDescending(k => k.Value))
                sb.AppendLine($"  {MB(kv.Value),12}   {typeCount[kv.Key],6} x  {kv.Key}");
            sb.AppendLine();
            sb.AppendLine("Top assets (>= 64 KB):");
            foreach (var a in assets.OrderByDescending(a => a.size).Take(30))
                sb.AppendLine($"  {MB(a.size),12}   {a.type,-14}  {a.name}    {a.path}");
            Debug.Log(sb.ToString());
        }

        [MenuItem("OpenSlope/Tools/Analyze Audio", false, 741)]
        public static void AnalyzeAudio()
        {
            var scene = SceneManager.GetActiveScene();
            var deps = EditorUtility.CollectDependencies(scene.GetRootGameObjects().Cast<UnityEngine.Object>().ToArray());

            var seen = new HashSet<UnityEngine.Object>();
            var loadType = new Dictionary<string, (int n, long bytes)>();
            var format = new Dictionary<string, (int n, long bytes)>();
            var clips = new List<(long size, string name, string load, string fmt)>();
            long total = 0; int decompressOnLoad = 0;

            foreach (var o in deps)
            {
                if (!(o is AudioClip) || !seen.Add(o)) continue;
                long size = Profiler.GetRuntimeMemorySizeLong(o);
                total += size;
                string path = AssetDatabase.GetAssetPath(o);
                string lt = "?", fmt = "?";
                if (AssetImporter.GetAtPath(path) is AudioImporter imp)
                {
                    var s = imp.defaultSampleSettings;
                    lt = s.loadType.ToString();
                    fmt = s.compressionFormat.ToString();
                    if (s.loadType == AudioClipLoadType.DecompressOnLoad) decompressOnLoad++;
                }
                Accum(loadType, lt, size); Accum(format, fmt, size);
                clips.Add((size, o.name, lt, fmt));
            }

            var sb = new StringBuilder();
            sb.AppendLine("=== OpenSlope Audio ===");
            sb.AppendLine($"Clips: {clips.Count}    Total runtime (decompressed) memory: {MB(total)}");
            if (decompressOnLoad > 0)
                sb.AppendLine($"  WARNING: {decompressOnLoad} clip(s) are DecompressOnLoad - decompressed to PCM in RAM. " +
                              "Short SFX -> 'Compressed In Memory', music/long stems -> 'Streaming' to cut RAM.");
            sb.AppendLine();
            sb.AppendLine("By load type:");
            foreach (var kv in loadType.OrderByDescending(k => k.Value.bytes))
                sb.AppendLine($"  {MB(kv.Value.bytes),12}   {kv.Value.n,5} x  {kv.Key}");
            sb.AppendLine("By compression format:");
            foreach (var kv in format.OrderByDescending(k => k.Value.bytes))
                sb.AppendLine($"  {MB(kv.Value.bytes),12}   {kv.Value.n,5} x  {kv.Key}");
            sb.AppendLine();
            sb.AppendLine("Largest clips:");
            foreach (var c in clips.OrderByDescending(c => c.size).Take(20))
                sb.AppendLine($"  {MB(c.size),12}   {c.name,-10}  {c.load} / {c.fmt}");
            Debug.Log(sb.ToString());
        }

        [MenuItem("OpenSlope/Tools/List World Builds (.vrcw)", false, 742)]
        public static void ListWorldBuilds()
        {
            string profile = Environment.GetEnvironmentVariable("USERPROFILE");
            string dir = Path.Combine(profile ?? "", "AppData", "LocalLow", "VRChat", "VRChat", "Worlds");
            if (!Directory.Exists(dir)) { Debug.LogWarning($"[BuildSize] VRChat Worlds cache not found: {dir}"); return; }

            var files = new DirectoryInfo(dir).GetFiles("*.vrcw")
                .OrderByDescending(f => f.LastWriteTime).Take(15).ToList();

            var sb = new StringBuilder();
            sb.AppendLine("=== Built world bundles (compressed .vrcw download size) ===");
            sb.AppendLine($"From: {dir}");
            foreach (var f in files)
            {
                string platform = f.Name.Contains("android") ? "Quest/Android" : "PC";
                sb.AppendLine($"  {f.Length / 1024f / 1024f,8:0.00} MB   {f.LastWriteTime:yyyy-MM-dd HH:mm}   {platform,-13}  {f.Name}");
            }
            Debug.Log(sb.ToString());
        }

        static void Accum(Dictionary<string, (int n, long bytes)> d, string key, long size)
        {
            d.TryGetValue(key, out var v); d[key] = (v.n + 1, v.bytes + size);
        }

        static string MB(long bytes) => (bytes / 1024f / 1024f).ToString("0.00") + " MB";
    }
}
#endif
