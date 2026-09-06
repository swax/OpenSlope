#if UNITY_EDITOR
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UdonSharpEditor;

namespace OpenSlope.VrcPlugin
{

    // OpenSlope/Optimize/Consolidate Animated Props - fold every per-prop AnimatedPropU Update into ONE
    // AnimatedPropManager, the per-frame Udon-dispatch fix (each UdonBehaviour with an Update costs an
    // interpreted VM dispatch per frame; a city authors ~21 animated props). A SCENE retrofit, no re-import:
    //  1. gathers the scene's AnimatedPropU instances (disabled ones too - their serialized data is the
    //     consolidation source, so re-running the menu is idempotent),
    //  2. concatenates their clip/segment/curve arrays into the manager's parallel arrays, rebasing each prop's
    //     segment indices and cubic-segment (curveData/6) indices into the shared arrays,
    //  3. re-routes every AnimTriggerU / AnimPokerU volume to (manager, prop index) - their `target(s)`
    //     stay wired as the consolidation source + legacy fallback,
    //  4. disables the per-prop behaviours (proxy + backing UdonBehaviour), which stops their Update dispatch.
    // The manager host is OpenSlope_Map/Level/OpenSlope_AnimatedProps, so it's wiped with the map it refers into (see the parenting
    // note below).
    // SetupAll.RunSteps calls this (right after the chunker), so a normal Load -> Setup All leaves the scene
    // consolidated; run the menu by hand only when you've re-Loaded props without a full Setup All, since that lays
    // down fresh, individually-ticking per-prop behaviours. See docs/038-animated-props.md and AnimatedPropManager.
    public static class ConsolidateAnimatedProps
    {
        const string HostName  = "OpenSlope_AnimatedProps";   // OpenSlope_Map/Level/OpenSlope_AnimatedProps - dies with the map, as it must
        const string LevelName = "Level";

        [MenuItem("OpenSlope/Optimize/Consolidate Animated Props", false, 501)]
        public static void Run()
        {
            var props = Object.FindObjectsOfType<AnimatedPropU>(true).OrderBy(HierarchyPath).ToArray();
            if (props.Length == 0) { Debug.Log("OpenSlope: no AnimatedPropU in the scene - nothing to consolidate."); return; }

            bool created;
            UdonTools.EnsureProgramAsset(typeof(AnimatedPropManager), out created);
            if (created)
            {
                Debug.LogWarning("OpenSlope: created the AnimatedPropManager program asset - UdonSharp finalizes a new " +
                                 "program on the next editor tick, so run the menu once more.");
                return;
            }

            // Per-prop params.
            var clipLength = new List<float>(); var loopMode = new List<int>(); var rate = new List<float>();
            var reverse = new List<bool>(); var triggered = new List<bool>(); var autoReset = new List<float>();
            var deltaGated = new List<bool>(); var pokeSeconds = new List<float>(); var activatePulse = new List<bool>();
            var activateRange = new List<float>(); var deactivateRange = new List<float>(); var propPos = new List<Vector3>();
            var combo = new List<bool>(); var comboStart = new List<float>(); var comboEnd = new List<float>();
            var comboRate = new List<float>(); var comboEndMode = new List<int>(); var phaseOffset = new List<float>();
            var propSeg0 = new List<int>(); var propSegCount = new List<int>();
            var propCurve0 = new List<int>(); var propCurveCount = new List<int>();
            // Shared segment + curve arrays.
            var segT = new List<Transform>(); var segP = new List<Vector3>(); var segE = new List<Vector3>();
            var cSeg = new List<int>(); var cTgt = new List<int>(); var curveStarts = new List<int>(); var cCount = new List<int>();
            var cData = new List<float>();

            var index = new Dictionary<AnimatedPropU, int>();
            int skipped = 0;
            foreach (var p in props)
            {
                int nSeg = p.segTransforms == null ? 0 : p.segTransforms.Length;
                int nCur = p.curveSegment == null ? 0 : p.curveSegment.Length;
                if (nSeg == 0 || nCur == 0 || p.clipLength <= 0f)
                {
                    Disable(p); skipped++;   // degenerate: nothing to animate; just silence its Update
                    continue;
                }
                int segBase = segT.Count;
                int cubicBase = cData.Count / 6;
                index[p] = clipLength.Count;

                clipLength.Add(p.clipLength); loopMode.Add(p.loopMode); rate.Add(p.rate); reverse.Add(p.reverse);
                triggered.Add(p.triggered); autoReset.Add(p.autoResetDelay);
                deltaGated.Add(p.deltaGated); pokeSeconds.Add(p.pokeSeconds); activatePulse.Add(p.activatePulse);
                activateRange.Add(p.activateRange); deactivateRange.Add(p.deactivateRange);
                combo.Add(p.combo); comboStart.Add(p.comboStart); comboEnd.Add(p.comboEnd);
                comboRate.Add(p.comboRate); comboEndMode.Add(p.comboEndMode); phaseOffset.Add(p.phaseOffset);
                propPos.Add(p.transform.position);
                propSeg0.Add(segBase); propSegCount.Add(nSeg);
                propCurve0.Add(cSeg.Count); propCurveCount.Add(nCur);

                for (int i = 0; i < nSeg; i++)
                {
                    segT.Add(p.segTransforms[i]);
                    segP.Add(p.segRestPos[i]);
                    segE.Add(p.segRestEuler[i]);
                }
                for (int c = 0; c < nCur; c++)
                {
                    cSeg.Add(p.curveSegment[c] + segBase);       // rebase into the shared segment array
                    cTgt.Add(p.curveTarget[c]);
                    curveStarts.Add(p.curveStart[c] + cubicBase); // rebase into the shared cubic array (curveData/6)
                    cCount.Add(p.curveCount[c]);
                }
                if (p.curveData != null) cData.AddRange(p.curveData);
                Disable(p);
            }

            // The host lives under OpenSlope_Map/Level, beside the props it drives (the same place ObjectCullerSetup puts
            // OpenSlope_ObjectCuller). That's a LIFECYCLE requirement, not tidiness: every segTransforms ref points into this
            // map, and Map.ResetRoot DestroyImmediates OpenSlope_Map on the next Load - a host parked at the scene ROOT
            // survives that wipe as an object full of dead refs still burning the per-frame Update this whole menu exists
            // to remove. Older runs left it unparented, so adopt an existing host wherever it sits (and fold away any
            // duplicate a previous inactive-OpenSlope_Map run created) rather than stacking another one beside it.
            Transform level = Map.Child(LevelName, true);
            GameObject go = null;
            foreach (var existing in Object.FindObjectsOfType<AnimatedPropManager>(true))
            {
                if (existing == null || existing.name != HostName) continue;
                if (go == null) { go = existing.gameObject; continue; }
                if (existing.gameObject != go) Object.DestroyImmediate(existing.gameObject);
            }
            // GameObject.Find skips INACTIVE objects, which is why it can't be the only lookup: it's the fallback for a
            // host that somehow lost its manager component, after the component sweep above has come up empty.
            if (go == null)
            {
                var stray = GameObject.Find(HostName);   // '??' would bypass Unity's overloaded null check - be explicit
                go = stray != null ? stray : new GameObject(HostName);
            }
            if (go.transform.parent != level) go.transform.SetParent(level, false);

            var mgr = UdonTools.AddConfigured<AnimatedPropManager>(go, u =>
            {
                u.clipLength = clipLength.ToArray(); u.loopMode = loopMode.ToArray(); u.rate = rate.ToArray();
                u.reverse = reverse.ToArray(); u.triggered = triggered.ToArray(); u.autoResetDelay = autoReset.ToArray();
                u.deltaGated = deltaGated.ToArray(); u.pokeSeconds = pokeSeconds.ToArray();
                u.activatePulse = activatePulse.ToArray(); u.activateRange = activateRange.ToArray();
                u.deactivateRange = deactivateRange.ToArray(); u.propPos = propPos.ToArray();
                u.combo = combo.ToArray(); u.comboStart = comboStart.ToArray(); u.comboEnd = comboEnd.ToArray();
                u.comboRate = comboRate.ToArray(); u.comboEndMode = comboEndMode.ToArray();
                u.phaseOffset = phaseOffset.ToArray();
                u.propSeg0 = propSeg0.ToArray(); u.propSegCount = propSegCount.ToArray();
                u.propCurve0 = propCurve0.ToArray(); u.propCurveCount = propCurveCount.ToArray();
                u.segTransforms = segT.ToArray(); u.segRestPos = segP.ToArray(); u.segRestEuler = segE.ToArray();
                u.curveSegment = cSeg.ToArray(); u.curveTarget = cTgt.ToArray(); u.curveStart = curveStarts.ToArray();
                u.curveCount = cCount.ToArray(); u.curveData = cData.ToArray();
            });

            // Re-route the trigger volumes + idle pokers onto the manager slots.
            int trig = 0, pok = 0;
            foreach (var tv in Object.FindObjectsOfType<AnimTriggerU>(true))
            {
                int gi;
                if (tv.target == null || !index.TryGetValue(tv.target, out gi)) continue;   // degenerate/unknown target: skips consolidation, leaving the legacy per-prop path as a disabled no-op
                tv.manager = mgr; tv.managerIndex = gi;
                UdonTools.Push(tv); EditorUtility.SetDirty(tv); trig++;
            }
            foreach (var pk in Object.FindObjectsOfType<AnimPokerU>(true))
            {
                if (pk.targets == null) continue;
                var list = new List<int>();
                foreach (var t in pk.targets) { int gi; if (t != null && index.TryGetValue(t, out gi)) list.Add(gi); }
                pk.manager = mgr; pk.managerIndices = list.ToArray();
                UdonTools.Push(pk); EditorUtility.SetDirty(pk); pok++;
            }

            EditorSceneManager.MarkSceneDirty(go.scene);
            Debug.Log($"OpenSlope: consolidated {index.Count} animated props ({skipped} degenerate skipped) into {Map.RootName}/{LevelName}/{HostName} - " +
                      $"{segT.Count} segments, {cSeg.Count} curves, {cData.Count / 6} cubics; re-routed {trig} trigger volume(s) + {pok} poker(s); " +
                      "per-prop behaviours disabled.");
        }

        // Silence a per-prop behaviour: disable BOTH the U# proxy and its backing UdonBehaviour (the backing one is
        // what the runtime dispatches). Serialized data stays in place - it's the consolidation source on re-runs.
        static void Disable(AnimatedPropU p)
        {
            var backing = UdonSharpEditorUtility.GetBackingUdonBehaviour(p);
            if (backing != null && backing.enabled) { backing.enabled = false; EditorUtility.SetDirty(backing); }
            if (p.enabled) { p.enabled = false; EditorUtility.SetDirty(p); }
        }

        static string HierarchyPath(AnimatedPropU p)
        {
            string s = p.name;
            var t = p.transform.parent;
            while (t != null) { s = t.name + "/" + s; t = t.parent; }
            return s;
        }
    }
}
#endif
