// Off unless OPENSLOPE_RELOAD_DIAG is in Player Settings ▸ Scripting Define Symbols. It installs itself
// through [InitializeOnLoad] and logs on every compile and every domain reload, so left on it would talk
// in the console of every project the importer is synced into. Turn it on while investigating slow
// reloads; leave it off otherwise.
#if UNITY_EDITOR && OPENSLOPE_RELOAD_DIAG
using System;
using System.IO;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Brackets every domain reload with a timestamped START/FINISH, the real wall-time it took, and the best
    // available reason. SessionState carries the start time across the domain swap (statics are wiped, but
    // SessionState survives within an editor session). Pair with the -timestamps launch arg for wall-clock on
    // every other line too.
    [InitializeOnLoad]
    static class ReloadDiagnostics
    {
        const string K_Start = "ReloadDiag.startTicks", K_Reason = "ReloadDiag.reason";
        static bool _compileTriggered;

        static ReloadDiagnostics()
        {
            CompilationPipeline.compilationStarted         += _ => _compileTriggered = true;
            CompilationPipeline.assemblyCompilationStarted += p =>
                Debug.Log($"[ReloadDiag] compiling {Path.GetFileName(p)} @ {DateTime.Now:HH:mm:ss.fff}");
            AssemblyReloadEvents.beforeAssemblyReload += OnBefore;
            AssemblyReloadEvents.afterAssemblyReload  += OnAfter;
        }

        static void OnBefore()
        {
            // isCompiling is unreliable here (the compile has usually finished by the time the reload starts),
            // so we rely on whether compilationStarted fired this domain instead.
            string reason = _compileTriggered ? "script compilation"
                : EditorApplication.isPlayingOrWillChangePlaymode ? "play-mode change"
                : "explicit / asset-driven (RequestScriptReload or ForceDomainReload)";
            SessionState.SetString(K_Start, DateTime.Now.Ticks.ToString());
            SessionState.SetString(K_Reason, reason);
            Debug.Log($"[ReloadDiag] >>> reload START @ {DateTime.Now:HH:mm:ss.fff} — reason: {reason}");
        }

        static void OnAfter()
        {
            var reason = SessionState.GetString(K_Reason, "?");
            string took = long.TryParse(SessionState.GetString(K_Start, ""), out var t)
                ? $"{(DateTime.Now - new DateTime(t)).TotalSeconds:F1}s" : "?";
            Debug.Log($"[ReloadDiag] <<< reload FINISH @ {DateTime.Now:HH:mm:ss.fff} — wall-time {took} (reason: {reason})");
        }
    }
}
#endif
