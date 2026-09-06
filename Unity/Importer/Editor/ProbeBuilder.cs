#if UNITY_EDITOR
using System.Collections.Generic;
using System.Runtime.InteropServices;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Avatar light probes: a LightProbeGroup sampled from the same per-instance SSX lights as the props, so a
    // moving VRChat avatar darkens in shade in an uploaded build. Static geometry uses the lightmap / prop
    // vertex colours; a moving avatar is lit by baked LIGHT PROBES instead. Probes only work after a BAKE, so
    // Build (during import) only places the group; BakeAndApply runs a probe-only CPU bake then stamps our
    // authored SH over it. See docs/unity/010-object-lighting.md (the bake gotchas live there).
    public class ProbeBuilder
    {
        readonly ImportConfig _cfg;
        readonly InstanceLighting _lighting;

        // The Progressive Lightmapper does NOT fail on out-of-memory: it retries the skipped probe-init job forever,
        // spamming "Initialize light probe data job skipped - out of memory" ~3/s at 0% progress - and on the
        // SYNCHRONOUS bake below that loop runs inside Bake() on the blocked main thread, i.e. a hard editor hang
        // (End-Task to recover). The trigger is Windows COMMIT memory (physical+pagefile), not physical RAM - seen
        // with the commit charge at 98.6% while 19 GB of RAM sat free. The gate is Unity's own UP-FRONT
        // availability check, not a real allocation (the bake itself commits <0.1 GB once running): measured by
        // ballast bisection, it refuses at <=4.5 GB available and runs at >=8.5 GB. So BakeAndApply asks an
        // are-you-sure below ~9 GB instead of walking into the hang.

        [StructLayout(LayoutKind.Sequential)]
        struct MemoryStatusEx
        {
            public uint dwLength, dwMemoryLoad;
            public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile,
                         ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx buffer);

        // ullAvailPageFile = remaining commit headroom (see the block comment above for the measured 9 GB floor).
        static bool CommitHeadroomTooLow(out float availGB)
        {
            availGB = -1f;
            if (Application.platform != RuntimePlatform.WindowsEditor) return false;
            try
            {
                var ms = new MemoryStatusEx { dwLength = (uint)Marshal.SizeOf<MemoryStatusEx>() };
                if (!GlobalMemoryStatusEx(ref ms)) return false;
                availGB = ms.ullAvailPageFile / (1024f * 1024f * 1024f);
                return availGB < 9f;
            }
            catch { return false; }
        }

        public ProbeBuilder(ImportConfig cfg, InstanceLighting lighting)
        {
            _cfg = cfg; _lighting = lighting;
        }

        public void Build(Transform parent)
        {
            var prev = parent.Find(_cfg.ProbeGroupName);
            if (prev != null) Object.DestroyImmediate(prev.gameObject);

            // Probe POSITIONS come from the bundle (snowknife de-dupes the same grid; manifest.Probes). The SH
            // AUTHORING + CPU bake stay engine-side - BakeAndApply recomputes positions+SH together from the
            // instances so they always line up by index; Build only PLACES the group.
            var bundle = new BundleManifestReader(_cfg);
            if (!(bundle.Exists && bundle.ProbePositions != null && bundle.ProbePositions.Length > 0))
            { Debug.LogWarning("OpenSlope: probes - no positions in the bundle; run `snowknife gltf`."); return; }
            Vector3[] localPos = bundle.ProbePositions;

            var go = new GameObject(_cfg.ProbeGroupName);
            go.transform.SetParent(parent, false);
            go.AddComponent<LightProbeGroup>().probePositions = localPos;
            Debug.Log($"OpenSlope: '{_cfg.ProbeGroupName}' placed {localPos.Length} probes (bundle, min spacing {bundle.ProbeMinSpacing}). " +
                      "Run OpenSlope/Setup/Bake & Apply Probes to light the avatar in shade (needed for the VRChat upload).");
        }

        // De-duped probe positions in the root's LOCAL space (X negated, raw SSX units; the root's
        // rotation+scale place them with the props) + the authored SH per probe. Deterministic, so Build
        // (positions) and BakeAndApply (SH) line up by index.
        bool ComputeProbes(out Vector3[] positions, out UnityEngine.Rendering.SphericalHarmonicsL2[] sh, out int instCount)
        {
            positions = null; sh = null; instCount = 0;
            var instances = _lighting.Load();
            if (instances == null || instances.Count == 0) { Debug.LogWarning("OpenSlope: no instances for light probes."); return false; }
            instCount = instances.Count;

            float q = Mathf.Max(1f, _cfg.ProbeMinSpacing);
            Vector3 sun = _cfg.PropDirLightDir.sqrMagnitude > 1e-6f ? _cfg.PropDirLightDir.normalized : Vector3.up;
            var seen = new HashSet<long>();
            var pos = new List<Vector3>();
            var shList = new List<UnityEngine.Rendering.SphericalHarmonicsL2>();
            foreach (var it in instances)
            {
                if (it.Location == null || it.Location.Length < 3) continue;
                var p = new Vector3(-it.Location[0], it.Location[1], it.Location[2]);
                long key = ((long)Mathf.RoundToInt(p.x / q) * 73856093)
                         ^ ((long)Mathf.RoundToInt(p.y / q) * 19349663)
                         ^ ((long)Mathf.RoundToInt(p.z / q) * 83492791);
                if (!seen.Add(key)) continue;
                pos.Add(p);

                // Per-instance SH. Directional (default): L0 (DC) = the isotropic LightColour, so the board
                // (reads the DC only) and the avatar's surface-AVERAGE match it exactly. Then
                // add ONLY the directional light's L1 (the linear gradient), not its L0 or L2, so the avatar gets a
                // clean sunny-side/shaded-side tilt around that average with no DC shift and no L2 ringing (the L2
                // zonal would otherwise leak into the board's ShadeSH9(0,0,0,1)). We copy L1 from a temp
                // AddDirectionalLight to avoid hand-deriving the SH basis constants. Direction is TO-LIGHT (verified).
                var s = new UnityEngine.Rendering.SphericalHarmonicsL2();
                s.Clear();
                if (_cfg.ProbeDirLight)
                {
                    s.AddAmbientLight(_lighting.LightColour(it));   // L0 = the DC (board + average preserved)
                    _lighting.Split(it, out _, out Color keyc);
                    if (keyc.r + keyc.g + keyc.b > 1e-3f)
                    {
                        var d = new UnityEngine.Rendering.SphericalHarmonicsL2();
                        d.Clear();
                        d.AddDirectionalLight(sun, keyc, _cfg.ProbeDirIntensity);
                        for (int c = 0; c < 3; c++) { s[c, 1] += d[c, 1]; s[c, 2] += d[c, 2]; s[c, 3] += d[c, 3]; }
                    }
                }
                else s.AddAmbientLight(_lighting.LightColour(it));
                shList.Add(s);
            }
            if (pos.Count == 0) return false;

            positions = pos.ToArray();
            sh = shList.ToArray();
            return true;
        }

        // True if the scene's baked probe structure matches the authored positions index-for-index, in which case
        // the authored SH is stamped + saved with NO lightmapper run (zero extra memory). Any mismatch - no bake
        // yet, count drift, moved positions, a different map's structure - returns false and the caller runs the
        // full bake. The per-index position check (not just count) also refuses a permuted structure, where an
        // index-wise stamp would put the wrong SH on every probe.
        static bool TryRestampExisting(Transform grpT, Vector3[] localPos, UnityEngine.Rendering.SphericalHarmonicsL2[] sh)
        {
            var lp = LightmapSettings.lightProbes;
            if (lp == null || lp.bakedProbes == null || lp.bakedProbes.Length != sh.Length) return false;
            Vector3[] baked = lp.positions;                  // world space, index-aligned with bakedProbes
            if (baked == null || baked.Length != localPos.Length) return false;
            // 5 cm tolerance: the baked structure stores positions slightly quantized (~1.7 cm observed at Mesa's
            // ~550 m coordinates), but probes are metres apart, so 5 cm can never match the WRONG probe.
            for (int i = 0; i < localPos.Length; i++)
                if ((grpT.TransformPoint(localPos[i]) - baked[i]).sqrMagnitude > 0.0025f) return false;

            lp.bakedProbes = sh;   // safe: the group is flattened to the OpenSlope_Map identity-root top
            UnityEditor.SceneManagement.EditorSceneManager.MarkAllScenesDirty();
            UnityEditor.SceneManagement.EditorSceneManager.SaveOpenScenes();
            Debug.Log($"OpenSlope: probe positions unchanged - re-stamped the authored SH over the existing baked structure " +
                      $"({sh.Length} probes) and saved. NO lightmapper bake was needed.");
            return true;
        }

        // interactive=true (the menu / Setup All from the OpenSlope menu) prompts before baking when commit headroom is low;
        // interactive=false (an automation/MCP-driven Setup All) skips the bake with a warning instead, because a modal
        // would block the driving editor command mid-call. The bake itself is identical on both paths.
        public void BakeAndApply(bool interactive = true)
        {
            var root = GameObject.Find(_cfg.RootName);
            if (root == null) { Debug.LogError("OpenSlope: no " + _cfg.RootName + " - run OpenSlope/Load first."); return; }
            // The probe group MUST sit at the OpenSlope_Map identity-root TOP, NOT nested under the scaled Level. Unity's native
            // LightProbes.bakedProbes setter (SetBakedCoefficientsSubset) HARD-CRASHES (SIGSEGV) when the LightProbeGroup is
            // under the nested scaled Level, but writes fine when the group's scaled transform is a DIRECT child of the
            // identity root - confirmed by crash dumps + a flatten test. The importer re-exposes it at the top; self-heal
            // here (re-parent, worldPositionStays) in case an older import left it nested under Level.
            var grpT = root.transform.Find(_cfg.ProbeGroupName);
            if (grpT == null)
            {
                var level = root.transform.Find(_cfg.LevelName);
                var nested = level != null ? level.Find(_cfg.ProbeGroupName) : null;
                if (nested != null) { nested.SetParent(root.transform, worldPositionStays: true); grpT = nested; }
            }
            if (grpT == null) { Debug.LogError("OpenSlope: no " + _cfg.ProbeGroupName + " - run OpenSlope/Load first."); return; }

            // Keep ONLY the canonical top group. A scene can end up with a stale duplicate (e.g. an old
            // OpenSlope_Map/Level/LightProbes alongside the exposed top copy): every probe position is then an exactly
            // coincident PAIR, and that degenerate input wedges the Progressive Lightmapper's probe-init job in an
            // endless "Initialize light probe data job skipped - out of memory" retry loop at 0% (hangs the editor);
            // it would also fail the authored-SH count check below even if the bake survived.
            foreach (var dup in Object.FindObjectsOfType<LightProbeGroup>())
                if (dup.transform != grpT)
                {
                    Debug.LogWarning($"OpenSlope: destroying duplicate LightProbeGroup under '{dup.transform.parent.name}' " +
                                     $"({dup.probePositions.Length} probes) - only '{_cfg.RootName}/{_cfg.ProbeGroupName}' should exist.");
                    Object.DestroyImmediate(dup.gameObject);
                }

            if (!ComputeProbes(out Vector3[] pos, out var sh, out _)) return;

            // If the scene's baked structure already matches these positions, the lightmapper has nothing to add -
            // it would only rebuild the structure we already have (and demand its ~9 GB commit headroom to start,
            // see the gate comment up top). Re-stamp the authored SH over the existing structure instead; the full
            // bake then only runs when the probe positions actually change (fresh import / different map).
            if (TryRestampExisting(grpT, pos, sh)) return;

            // Guard when commit headroom is below the lightmapper's measured ~9 GB gate: a refused probe-init job retries
            // forever inside the synchronous Bake() = frozen editor, End-Task to recover. The interactive path asks an
            // are-you-sure (click-through, not a hard stop - the gate was measured on one machine and headroom shifts
            // minute to minute); the non-interactive path can't pop a modal (it would block the MCP/automation call), so
            // it skips the bake with a warning and leaves it for a manual OpenSlope/Setup/Bake & Apply Probes.
            if (CommitHeadroomTooLow(out float availGB))
            {
                if (!interactive)
                {
                    Debug.LogWarning($"OpenSlope: skipping probe bake - only {availGB:F1} GB commit headroom (lightmapper needs " +
                        "~9 GB or it retries forever and freezes the editor). Free memory, then run OpenSlope/Setup/Bake & Apply Probes.");
                    return;
                }
                if (!EditorUtility.DisplayDialog(
                    "Probe bake - low memory",
                    $"Only {availGB:F1} GB of Windows commit memory (RAM + pagefile) is available; the lightmapper " +
                    "usually refuses to start below ~9 GB and instead retries forever at 0% - and this bake is " +
                    "synchronous, so that would FREEZE the editor until you kill it from Task Manager.\n\n" +
                    "Free memory first (close other Unity editors, browsers, WSL) or enlarge the pagefile.\n\n" +
                    "Bake anyway?",
                    "Bake anyway", "Cancel"))
                {
                    Debug.LogWarning($"OpenSlope: probe bake cancelled at the low-memory prompt ({availGB:F1} GB commit headroom).");
                    return;
                }
            }

            grpT.GetComponent<LightProbeGroup>().probePositions = pos;

            // Probe-only bake. We OVERWRITE every probe's SH with our own authored values afterwards (below), so the
            // lightmapper's actual irradiance result is DISCARDED - we only need it to build the probe STRUCTURE
            // (tetrahedralization + a bakedProbes array we can write into). So crank every quality knob to the floor:
            // 0 bounces, minimum samples, AO off, tiny lightmaps. On a big level (e.g. Mesa) the full-quality probe bake
            // could run for 10+ minutes / never visibly converge; with the result thrown away that work is pure waste.
            var ls = new LightingSettings { name = "SSX Probe-Only (min)" };
            ls.bakedGI = true;
            ls.realtimeGI = false;
            ls.lightmapper = LightingSettings.Lightmapper.ProgressiveCPU;
            ls.ao = false;
            ls.lightmapMaxSize = 32;
            ls.maxBounces = 0;                          // no GI bounces - we don't keep the lighting
            ls.directSampleCount = 8;                   // floor the sample counts (result discarded -> noise is irrelevant)
            ls.indirectSampleCount = 8;
            ls.environmentSampleCount = 8;
            ls.lightProbeSampleCountMultiplier = 1f;
            Lightmapping.lightingSettings = ls;
            Lightmapping.Clear();

            // SYNCHRONOUS bake, deliberately: it blocks the editor for the few seconds this min-quality probe-only
            // bake takes (keep the window focused - Unity throttles an unfocused bake), and the LightingDataAsset is
            // fully settled when Bake() returns, so the SH stamp below can't race it. The async version (BakeAsync +
            // a static pending-SH handoff + a bakeCompleted callback + an OOM watchdog cancelling the retry loop)
            // was three pieces of machinery for hazards the headroom prompt above already covers.
            Debug.Log($"OpenSlope: probe bake starting (sync, min-quality, {sh.Length} probes) - the editor blocks until it finishes.");
            if (!Lightmapping.Bake()) { Debug.LogError("OpenSlope: probe bake (sync) did not run."); return; }

            var lp = LightmapSettings.lightProbes;
            if (lp == null || lp.bakedProbes == null)
            { Debug.LogError("OpenSlope: probe bake produced no LightProbes (check the console); authored SH NOT applied."); return; }
            if (lp.bakedProbes.Length != sh.Length)
            { Debug.LogError($"OpenSlope: probe count mismatch (baked {lp.bakedProbes.Length} vs authored {sh.Length}); authored SH NOT applied."); return; }

            lp.bakedProbes = sh;   // safe: the group is flattened to the OpenSlope_Map identity-root top
            UnityEditor.SceneManagement.EditorSceneManager.MarkAllScenesDirty();
            UnityEditor.SceneManagement.EditorSceneManager.SaveOpenScenes();
            Debug.Log($"OpenSlope: baked + applied authored per-instance SH on {sh.Length} probes. Avatar now darkens in shade.");
        }
    }
}
#endif
