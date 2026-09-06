#if UNITY_EDITOR
using System;
using System.IO;
using UnityEditor;
using UnityEngine;
using UdonSharp;
using UdonSharpEditor;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    // Shared helpers for attaching UdonSharp behaviours straight from the importer, so the imported scene is
    // upload-ready. Wraps the UdonSharp attach recipe:
    //   1. A working Udon component is THREE linked objects - a UdonSharpProgramAsset (compiled program), a
    //      backing VRC.Udon.UdonBehaviour pointing at it, and the proxy UdonSharpBehaviour. AddComponent alone
    //      gives only the proxy, which does nothing in-world.
    //   2. The supported builder GameObject.AddUdonSharpComponent<T>() (an extension in namespace UdonSharpEditor)
    //      wires the backing UdonBehaviour - but it THROWS unless the program asset already exists.
    //   3. So we create + compile the program asset ourselves (EnsureProgramAsset). Because these source files are
    //      authored for the installed U# format, new assets are seeded at CurrentVersion instead of entering the
    //      legacy source-rewrite upgrader as version 0.
    //   4. Public field values only reach the running program after CopyProxyToUdon serialises the proxy's fields
    //      into the UdonBehaviour's heap.
    // A freshly-created program asset can't be attached in the SAME call (UdonSharp finalizes a new program's
    // compiled version only on the next editor tick), so the importer calls EnsureAllProgramAssets up front and
    // bails-with-rerun if any were created - a once-per-fresh-project two-click. See docs/vrchat/013-udon-components.md.
    public static class UdonTools
    {
        // Every UdonSharp behaviour the importer attaches. EnsureAllProgramAssets bootstraps these; keep in sync
        // with the AddConfigured<T> call sites (PropBuilder spinners/physics, TriggerBuilder fireworks,
        // LevelImporter flipbooks).
        static readonly Type[] BehaviourTypes =
        {
            typeof(SpinnerManager), typeof(GemPickup), typeof(PhysicsProp), typeof(PropBounce), typeof(ContactSound),
            typeof(FireworkTrigger), typeof(FlipbookAnimator), typeof(RailNetwork), typeof(TerrainPatches),
            typeof(BreakableLogoU), typeof(AnimatedPropU), typeof(AnimTriggerU), typeof(BoostPad),
            typeof(Teleport), typeof(RailGate), typeof(SnowfallU), typeof(ObjectCuller),
            typeof(AmbientEmitter), typeof(ResetZone), typeof(BoostVolume), typeof(SplineMover),
            typeof(AnimPokerU), typeof(AnimatedPropManager), typeof(GlintFade), typeof(SunGlareFade), typeof(ProximityAudio),
            typeof(HitGatedLoops), typeof(ButtonU), typeof(ModeVisibility),
            typeof(HudMessageDisplay), typeof(HudMessageTrigger),
        };

        // Create + compile any missing program assets; returns true if ANY were created this call. The importer
        // bails (and asks for a re-run) on a true result, because those just-created assets can't be attached
        // until UdonSharp finalizes them on the next editor tick. All creations share a SINGLE compile pass at the
        // end - on a fresh project every BehaviourType is missing, so this is one CompileAllCsPrograms instead of
        // one per type.
        public static bool EnsureAllProgramAssets()
        {
            bool any = false;
            foreach (var t in BehaviourTypes) any |= CreateProgramAssetIfMissing(t);
            if (any) CompileNewProgramAssets();
            return any;
        }

        public static UdonSharpProgramAsset EnsureProgramAsset<T>(out bool created) where T : UdonSharpBehaviour
            => EnsureProgramAsset(typeof(T), out created);

        // Find the UdonSharpProgramAsset for a behaviour type, creating + compiling it if absent (sets `created`).
        // Single-call sites get an immediate compile; to bootstrap several at once prefer EnsureAllProgramAssets so
        // they share one compile pass.
        public static UdonSharpProgramAsset EnsureProgramAsset(Type type, out bool created)
        {
            created = CreateProgramAssetIfMissing(type);
            if (created) CompileNewProgramAssets();
            return UdonSharpProgramAsset.GetProgramAssetForClass(type);
        }

        // Create (but do NOT compile) the program asset for `type` unless it already exists; returns true iff it
        // created one. Deferring the compile lets a batch of creations share a single CompileNewProgramAssets pass.
        static bool CreateProgramAssetIfMissing(Type type)
        {
            if (UdonSharpProgramAsset.GetProgramAssetForClass(type) != null) return false;

            string scriptPath = null;
            foreach (var guid in AssetDatabase.FindAssets(type.Name + " t:MonoScript"))
            {
                var p = AssetDatabase.GUIDToAssetPath(guid);
                if (p.EndsWith("/" + type.Name + ".cs")) { scriptPath = p; break; }
            }
            if (scriptPath == null) { Debug.LogError($"OpenSlope: {type.Name}.cs not found in project."); return false; }

            var script = AssetDatabase.LoadAssetAtPath<MonoScript>(scriptPath);
            var pa = ScriptableObject.CreateInstance<UdonSharpProgramAsset>();
            pa.sourceCsScript = script;
            // A default program asset starts at version 0. That makes UdonSharp's next editor tick run its legacy
            // whole-project source upgrader before the normal compiler. During a just-finished Unity domain reload,
            // that upgrader can observe an incomplete Roslyn reference set and emit thousands of bogus errors such
            // as "System.Int32 is not defined" across otherwise-valid scripts. OpenSlope's checked-in sources are
            // already current-format, so opt them out of source rewriting and let CompileNewProgramAssets perform
            // the only required operation: generating their serialized Udon programs.
            pa.ScriptVersion = UdonSharpProgramVersion.CurrentVersion;
            string assetPath = Path.ChangeExtension(scriptPath, ".asset");
            AssetDatabase.CreateAsset(pa, assetPath);
            Debug.Log($"OpenSlope: created UdonSharp program asset {assetPath}");
            return true;
        }

        // Refresh + force-compile after one or more program assets were created. One pass covers any number of new
        // assets, so batch creators call this once at the end.
        static void CompileNewProgramAssets()
        {
            AssetDatabase.SaveAssets();
            AssetDatabase.Refresh();
            UdonSharpProgramAsset.CompileAllCsPrograms(true);            // forceCompile -> serialized Udon program
        }

        // Attach a fully-wired UdonSharp behaviour of type T to `go`, run the field-setting callback on the proxy,
        // then push those values into the backing UdonBehaviour's heap. Requires the program asset to exist
        // (EnsureAllProgramAssets at import start guarantees that). Reuses an existing T on `go` rather than stacking
        // a second backing UdonBehaviour, so re-running a setup menu over an already-wired object is idempotent.
        public static T AddConfigured<T>(GameObject go, Action<T> configure) where T : UdonSharpBehaviour
        {
            var proxy = go.GetUdonSharpComponent<T>() ?? go.AddUdonSharpComponent<T>();
            configure?.Invoke(proxy);
            Push(proxy);
            return proxy;
        }

        // Re-serialise an already-attached proxy's fields into its backing UdonBehaviour, then mark that behaviour
        // dirty so the pushed heap actually persists on save (a bare CopyProxyToUdon can be lost if nothing else
        // dirties the scene). Use when a field has to be set AFTER the initial AddConfigured - e.g. cross-references
        // between two behaviours that don't both exist yet at attach time (a gem's `spinner` ref needs the manager,
        // which is built after the gems).
        public static void Push<T>(T proxy) where T : UdonSharpBehaviour
        {
            UdonSharpEditorUtility.CopyProxyToUdon(proxy);
            var backing = UdonSharpEditorUtility.GetBackingUdonBehaviour(proxy);
            if (backing != null) EditorUtility.SetDirty(backing);
        }
    }
}
#endif
