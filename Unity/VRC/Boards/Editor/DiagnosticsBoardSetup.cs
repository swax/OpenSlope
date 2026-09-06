#if UNITY_EDITOR
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.Events;
using UnityEngine;
using UnityEngine.UI;
using UdonSharp;
using UdonSharpEditor;

namespace OpenSlope.VrcPlugin
{

    // Library setup step: stand up the in-world TUNING BOARD (DiagnosticsBoard) - the workbench panel of the start-gate
    // row, holding the knobs you flip while WATCHING a frame counter. See DiagnosticsBoard for what each row does. The
    // panel title is TUNING; the class + scene object keep the older Diagnostics name.
    //
    //   DIAGNOSTICS -> the two readouts: the head-following FPS/debug overlay this board builds, and the ride telemetry
    //                  log (pushed onto every pooled board). Both default OFF.
    //   PERF        -> every claw-back the world has: particles (persistent + ambient + fireworks in ONE row) / fog
    //                  banks / distance cull / the two per-frame board-FX pipelines, so one panel answers "what can I
    //                  turn off to get frames back".
    //
    // The perf rows RESOLVE + WIRE the systems present in the loaded map - anything absent simply gets no row (the board is
    // happy with any subset). The telemetry + board-FX rows need the board pool, so they're skipped when there isn't one.
    //
    // ALWAYS VISIBLE: a standalone panel in the start-gate board row (bench slot 4, see Map.BenchSlot). Its own
    // "Show FPS / debug" row drives the head-following FPS overlay this board builds, so nothing gates the panel
    // itself. Run it AFTER everything it wires (Setup All runs it last). Idempotent: deletes + rebuilds its object each run.
    //
    // Self-contained (its own small UI helpers) on purpose - it grew out of a debug panel kept deliberately independent.
    // Same two-step Udon bootstrap as the sibling setups (a freshly created U# program asset can't be attached in the
    // same call). Local + per-client (sync None).
    public static class DiagnosticsBoardSetup
    {
        const string ObjName     = "DiagnosticsBoard";   // OpenSlope_Map/GateBench/DiagnosticsBoard (titled TUNING in-world)
        const string LegacyName  = "RideTuneBoard";      // what this board was called before it grew the perf section
        const string RetiredPerfName = "PerfBoard";      // the retired Performance Board - cleared off the bench here (this board is its heir)
        const string PoleMatPath = Map.AssetsFolder + "/DiagBoardPole.mat";

        const int   Slot        = 4;      // bench order: 0 Info · 1 Settings · 2 Players · 3 Jukebox · 4 Diagnostics (Map.BenchSlot)
        const int   SlotCount   = 5;
        const float PostBehind  = 6.0f;   // metres uphill (behind) the matching snowboard at the gate
        const float PostHeight  = 1.4f;
        const float PostDiam    = 0.10f;
        const float PanelBottom = 1.05f;
        const float PanelClear  = 0.18f;

        const float CanvasW = 700f;   // ~1.11 m wide at PanelScale (matches the sibling boards)
        const float TitleH  = 96f;
        const float RowH    = 74f;
        const float SectH   = 46f;
        const float Pad     = 24f;
        const float PanelScale = 0.00158f;

        [MenuItem("OpenSlope/Setup/Diagnostics Board", false, 192)]
        public static void Setup()
        {
            // Two-step bootstrap: a just-created U# program asset can't have a component attached in the same call.
            bool firstTime = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(DiagnosticsBoard)) == null
                          || UdonSharpProgramAsset.GetProgramAssetForClass(typeof(DiagnosticsToggle)) == null
                          || UdonSharpProgramAsset.GetProgramAssetForClass(typeof(DebugHud)) == null;
            if (UdonTools.EnsureProgramAsset<DiagnosticsBoard>(out _) == null)
            {
                Debug.LogError("OpenSlope: could not create/find the DiagnosticsBoard program asset; aborting.");
                return;
            }
            UdonTools.EnsureProgramAsset<DiagnosticsToggle>(out _);
            UdonTools.EnsureProgramAsset<DebugHud>(out _);
            if (firstTime)
            {
                Debug.Log("OpenSlope: created the Udon program asset(s). UdonSharp finalizes them on the next editor tick - " +
                          "run 'OpenSlope/Setup/Diagnostics Board' again to build the board.");
                return;
            }

            Transform root = Map.ResolveRoot(true);
            Map.ClearBenchBoard(ObjName);
            Map.ClearBenchBoard(LegacyName);       // a scene built before the rename still carries the old RideTuneBoard object
            Map.ClearBenchBoard(RetiredPerfName);  // the Performance Board is gone: every one of its rows is now this board's PERF section

            // Resolve what this map actually has. Absent targets stay null -> no row built for them.
            var mgr = Object.FindObjectOfType<BoardManager>(true);
            bool haveBoards = mgr != null && mgr.boards != null && mgr.boards.Length > 0;
            // ONE "Particles" row over every authored emitter system: the cannon plumes, the flare/lantern loops,
            // collision-triggered ambient bursts and the firework trigger volumes. They're the same kind of thing to a
            // player, so they switch together. Static fog puff renderers stay on their dedicated Fog banks row below.
            var particles = new List<GameObject>();
            Transform emitterRoot = FindDeep(root, "Emitters");
            if (emitterRoot != null)
            {
                Transform cannons = emitterRoot.Find("Cannons"); if (cannons != null) particles.Add(cannons.gameObject);
                Transform flares  = emitterRoot.Find("Flares");  if (flares  != null) particles.Add(flares.gameObject);
            }
            Transform ambientEmitters = FindDeep(root, "AmbientEmitters");
            if (ambientEmitters != null) particles.Add(ambientEmitters.gameObject);
            foreach (var fw in Object.FindObjectsOfType<FireworkTrigger>(true))
                if (fw != null) particles.Add(fw.gameObject);
            var culler = Object.FindObjectOfType<ObjectCuller>(true);
            var fogRenderers = FindFogRenderers();

            // Placement: behind (uphill of) the snowboard at this board's start-gate post, facing downhill at the player.
            var board = new GameObject(ObjName);
            Map.PlaceOnBench(board.transform, Slot, SlotCount, PostBehind);

            var udon = board.GetComponent<DiagnosticsBoard>() ?? board.AddUdonSharpComponent<DiagnosticsBoard>();
            if (haveBoards) udon.manager = mgr;

            // Target refs (order-independent; each row's TOGGLE field is assigned when its row is built below).
            if (culler != null) udon.cullerObject = culler.gameObject;
            if (particles.Count > 0) udon.particleObjects = particles.ToArray();
            if (fogRenderers.Length > 0) udon.fogRenderers = fogRenderers;

            // The head-following FPS/debug HUD lives with the row that shows it (built OFF; the row SetActives it).
            udon.debugHudObject = BuildDebugHud(board.transform, culler, mgr);

            Transform panel = BuildPanel(board.transform, Map.BenchPanelHeight,
                                         "TUNING\n<size=22>local  ·  diagnostics · perf</size>");

            Font font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf") ?? Resources.GetBuiltinResource<Font>("Arial.ttf");
            var toggles = new List<Toggle>();
            float y = -TitleH;

            // DIAGNOSTICS - the two readouts, both default OFF because each costs real per-frame work. The overlay row is
            // always built (the HUD is this board's own object); the telemetry row needs the board pool to push onto.
            BuildSection(panel, y, "Diagnostics", font);
            y -= SectH;
            udon.debugHudToggle = Row(panel, ref y, "Show FPS / debug", false, font, toggles);
            if (haveBoards)
                udon.telemetryToggle = Row(panel, ref y, "Ride telemetry log", false, font, toggles);

            // PERF - every claw-back, world systems first and the two per-frame board-FX pipelines last.
            // No perf-impact suffix on the labels: the rows aren't ranked. All default ON;
            // DiagnosticsBoard.ApplyPlatformDefaults unchecks the two board-FX rows on a Quest build at runtime.
            BuildSection(panel, y, "Perf", font);
            y -= SectH;
            // The longest label on any bench board - it fits the 588 px label column at fontSize 32 with room to spare,
            // but the Text overflows rather than wrapping, so lengthen it further only after re-measuring.
            if (particles.Count > 0)
                                udon.particlesToggle = Row(panel, ref y, "Particles (fireworks, flares, etc.)", true, font, toggles);
            if (fogRenderers.Length > 0)
                                udon.fogToggle       = Row(panel, ref y, "Fog banks",              true, font, toggles);
            if (culler != null) udon.cullToggle      = Row(panel, ref y, "Cull distant geometry",  true, font, toggles);
            if (haveBoards)
            {
                udon.remoteFxToggle = Row(panel, ref y, "Other riders' FX", true, font, toggles);
                udon.myFxToggle     = Row(panel, ref y, "My board FX",      true, font, toggles);
            }

            // Push the proxy fields into the backing UdonBehaviour, THEN wire each toggle's onValueChanged to it.
            UdonSharpEditorUtility.CopyProxyToUdon(udon);
            var backing = UdonSharpEditorUtility.GetBackingUdonBehaviour(udon);
            if (backing != null)
                foreach (var t in toggles)
                    UnityEventTools.AddStringPersistentListener(t.onValueChanged, backing.SendCustomEvent, nameof(DiagnosticsBoard.Apply));

            // Interact-based input (the proven path; the world-space UI laser is unreliable): one toggle helper per row.
            foreach (var t in toggles)
            {
                var rowGo = t.gameObject;
                var tt = UdonTools.AddConfigured<DiagnosticsToggle>(rowGo, x => { x.toggle = t; x.board = udon; });
                var lbl = rowGo.transform.Find("Label");
                string txt = lbl != null && lbl.GetComponent<Text>() != null ? lbl.GetComponent<Text>().text : "Toggle";
                var ptso = new SerializedObject(UdonSharpEditorUtility.GetBackingUdonBehaviour(tt));
                var itp = ptso.FindProperty("interactText"); if (itp != null) itp.stringValue = txt;
                var pxp = ptso.FindProperty("proximity"); if (pxp != null) pxp.floatValue = 4f;
                ptso.ApplyModifiedProperties();
            }

            // Wire this board into every pooled rideable board so they read the two board-FX flags each frame. The boards
            // are pre-placed pool objects, so this editor-time wiring rides along on
            // their serialized state (and on the pool clones). New-field-default gotcha: this is the push that makes their
            // diagnosticsBoard ref non-null.
            if (haveBoards)
            {
                int wired = 0;
                foreach (var b in mgr.boards)
                {
                    if (b == null) continue;
                    b.diagnosticsBoard = udon;
                    UdonTools.Push(b);
                    wired++;
                }
                if (wired > 0) Debug.Log($"OpenSlope: wired the Tuning Board into {wired} pooled board(s) for the board-FX perf rows.");
            }

            BuildPole(board.transform);

            Selection.activeGameObject = board;
            EditorSceneMarkDirty(board);
            Debug.Log($"OpenSlope: Tuning board ready at {Map.RootName}/{Map.GateBench}/{ObjName} - {toggles.Count} row(s) " +
                      (haveBoards ? "" : "(NO board pool found, so no telemetry/board-FX rows - run the Start Gate setup first) ") +
                      "across diagnostics + perf, always visible in the start-gate board row. Turn on 'Show FPS / debug' " +
                      "and flip a row in-world to A/B what it costs.");
        }

        // Setup IS the refresh: it find-or-creates and rebuilds the board in place, so re-running it after a data change
        // is the only entry needed (there is no separate OpenSlope/Refresh item). Greyed out until a map is loaded.
        [MenuItem("OpenSlope/Setup/Diagnostics Board", true)]
        static bool SetupEnabled() => GameObject.Find(Map.RootName) != null;

        /// <summary>The drifting fog-bank puff renderers, for the PERF row that switches them off.
        ///
        /// Matched by NAME PREFIX rather than by "everything under Particles", because that root also carries the
        /// non-fog effects (sparkles, smoke, spray) and a row labelled "Fog banks" must not silently take those with
        /// it. The importer names each effect from its PBD record and every shipped fog cluster is `Fog_*`
        /// (`Fog_Sphere_A_0`, `Fog_DrawInPatch_E_5000`), which is the same prefix ParticleBuilder keys the fog0
        /// sprite off - so the two agree by construction.</summary>
        static Renderer[] FindFogRenderers()
        {
            var found = new List<Renderer>();
            foreach (var renderer in Object.FindObjectsOfType<MeshRenderer>(true))
            {
                var t = renderer.transform;
                if (t.parent == null || t.parent.name != "Particles") continue;
                if (!renderer.name.StartsWith("Fog", System.StringComparison.OrdinalIgnoreCase)) continue;
                found.Add(renderer);
            }
            return found.ToArray();
        }

        // ---- panel + rows (self-contained copies of the perf board's UI helpers) -----------------------------------

        // One row at the cursor, with its starting state; advances the cursor past it.
        static Toggle Row(Transform panel, ref float y, string label, bool initialOn, Font font, List<Toggle> toggles)
        {
            var t = BuildRow(panel, y, label, font, toggles);
            t.isOn = initialOn;
            y -= RowH;
            return t;
        }

        static Transform BuildPanel(Transform boardRoot, float canvasH, string titleText)
        {
            var canvasGO = new GameObject("Panel", typeof(RectTransform), typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
            canvasGO.transform.SetParent(boardRoot, false);
            canvasGO.GetComponent<Canvas>().renderMode = RenderMode.WorldSpace;
            var crt = canvasGO.GetComponent<RectTransform>();
            crt.sizeDelta = new Vector2(CanvasW, canvasH);
            crt.localRotation = Quaternion.identity;
            crt.localScale = Vector3.one * PanelScale;
            crt.pivot = new Vector2(0.5f, 0f);
            crt.localPosition = new Vector3(0f, Map.BenchPanelBottom, -PanelClear);

            var bg = NewUI("Backdrop", crt, out var bgRt); Stretch(bgRt);
            var bgImg = bg.AddComponent<Image>();
            bgImg.color = new Color(0.09f, 0.05f, 0.06f, 0.80f);   // a warm-dark tint so it reads distinct from the perf board
            bgImg.raycastTarget = false;

            var titleGO = NewUI("Title", crt, out var titleRt);
            titleRt.anchorMin = new Vector2(0f, 1f); titleRt.anchorMax = new Vector2(1f, 1f); titleRt.pivot = new Vector2(0.5f, 1f);
            titleRt.anchoredPosition = new Vector2(0f, -Pad * 0.5f); titleRt.sizeDelta = new Vector2(0f, TitleH);
            var title = titleGO.AddComponent<Text>();
            var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf") ?? Resources.GetBuiltinResource<Font>("Arial.ttf");
            title.font = font; title.fontSize = 40; title.fontStyle = FontStyle.Bold; title.color = Color.white;
            title.alignment = TextAnchor.UpperCenter; title.raycastTarget = false; title.supportRichText = true;
            title.text = titleText;
            return crt;
        }

        static void BuildSection(Transform panel, float yTop, string text, Font font)
        {
            var go = NewUI("Section_" + text, panel, out var rt);
            rt.anchorMin = new Vector2(0f, 1f); rt.anchorMax = new Vector2(0f, 1f); rt.pivot = new Vector2(0f, 1f);
            rt.anchoredPosition = new Vector2(Pad, yTop);
            rt.sizeDelta = new Vector2(CanvasW - 2f * Pad, SectH);
            var t = go.AddComponent<Text>();
            t.font = font; t.fontSize = 26; t.fontStyle = FontStyle.Bold; t.color = new Color(0.95f, 0.72f, 0.55f);
            t.alignment = TextAnchor.LowerLeft; t.raycastTarget = false; t.supportRichText = false;
            t.horizontalOverflow = HorizontalWrapMode.Overflow; t.verticalOverflow = VerticalWrapMode.Truncate;
            t.text = text.ToUpperInvariant();
        }

        static Toggle BuildRow(Transform panel, float yTop, string label, Font font, List<Toggle> toggles)
        {
            var rowGO = NewUI("Row_" + toggles.Count, panel, out var rowRt);
            rowRt.anchorMin = new Vector2(0f, 1f); rowRt.anchorMax = new Vector2(0f, 1f); rowRt.pivot = new Vector2(0f, 1f);
            rowRt.anchoredPosition = new Vector2(Pad, yTop);
            rowRt.sizeDelta = new Vector2(CanvasW - 2f * Pad, RowH);

            var toggle = rowGO.AddComponent<Toggle>();
            toggle.transition = Selectable.Transition.ColorTint;

            float wRow = CanvasW - 2f * Pad;
            var col = rowGO.AddComponent<BoxCollider>();
            col.size = new Vector3(wRow, RowH, 40f);
            col.center = new Vector3(wRow * 0.5f, -RowH * 0.5f, 0f);

            var hitGO = NewUI("Hit", rowRt, out var hitRt); Stretch(hitRt);
            var hitImg = hitGO.AddComponent<Image>();
            hitImg.color = new Color(1f, 1f, 1f, 0f);
            hitImg.raycastTarget = true;

            var boxGO = NewUI("Background", rowRt, out var boxRt);
            boxRt.anchorMin = new Vector2(0f, 0.5f); boxRt.anchorMax = new Vector2(0f, 0.5f); boxRt.pivot = new Vector2(0f, 0.5f);
            boxRt.anchoredPosition = new Vector2(0f, 0f); boxRt.sizeDelta = new Vector2(48f, 48f);
            var boxImg = boxGO.AddComponent<Image>();
            boxImg.color = new Color(0.85f, 0.88f, 0.92f, 1f);

            var ckGO = NewUI("Checkmark", boxRt, out var ckRt); Stretch(ckRt); Inset(ckRt, 9f);
            var ckImg = ckGO.AddComponent<Image>();
            ckImg.color = new Color(0.85f, 0.45f, 0.20f, 1f);   // amber tick (vs the perf board's green) to read as "debug"
            ckImg.raycastTarget = false;

            var labGO = NewUI("Label", rowRt, out var labRt);
            labRt.anchorMin = new Vector2(0f, 0f); labRt.anchorMax = new Vector2(1f, 1f);
            labRt.offsetMin = new Vector2(64f, 0f); labRt.offsetMax = new Vector2(0f, 0f);
            var labTxt = labGO.AddComponent<Text>();
            labTxt.font = font; labTxt.fontSize = 32; labTxt.color = Color.white;
            labTxt.alignment = TextAnchor.MiddleLeft; labTxt.raycastTarget = false; labTxt.supportRichText = false;
            labTxt.horizontalOverflow = HorizontalWrapMode.Overflow; labTxt.verticalOverflow = VerticalWrapMode.Truncate;
            labTxt.text = label;

            toggle.targetGraphic = boxImg;
            toggle.graphic = ckImg;
            toggle.isOn = true;
            var cb = toggle.colors;
            cb.normalColor = Color.white; cb.highlightedColor = new Color(0.90f, 0.95f, 1f);
            cb.pressedColor = new Color(0.78f, 0.84f, 0.95f); cb.selectedColor = new Color(0.90f, 0.95f, 1f);
            cb.disabledColor = new Color(0.6f, 0.6f, 0.6f, 0.5f); cb.colorMultiplier = 1f; cb.fadeDuration = 0.1f;
            toggle.colors = cb;

            toggles.Add(toggle);
            return toggle;
        }

        // The head-following debug HUD: a small world-space panel (dark backdrop + a Text) carrying a DebugHud that
        // re-positions it in front of the local player's head and writes FPS / frame ms / objects-drawn each frame. Built
        // OFF (the "Show FPS / debug" checkbox SetActives it). Parented under the board so it rebuilds with it.
        static GameObject BuildDebugHud(Transform boardRoot, ObjectCuller culler, BoardManager mgr)
        {
            var canvasGO = new GameObject("DebugHud", typeof(RectTransform), typeof(Canvas));
            canvasGO.transform.SetParent(boardRoot, false);
            canvasGO.GetComponent<Canvas>().renderMode = RenderMode.WorldSpace;
            var crt = canvasGO.GetComponent<RectTransform>();
            crt.sizeDelta = new Vector2(440f, 240f);
            crt.localScale = Vector3.one * 0.0009f;   // ~0.40 m wide at the ~1.1 m HUD distance
            crt.pivot = new Vector2(0.5f, 0.5f);
            crt.localPosition = Vector3.zero;

            var bg = NewUI("Backdrop", crt, out var bgRt); Stretch(bgRt);
            var bgImg = bg.AddComponent<Image>();
            bgImg.color = new Color(0.03f, 0.04f, 0.06f, 0.72f);
            bgImg.raycastTarget = false;

            var txtGO = NewUI("Text", crt, out var txtRt); Stretch(txtRt); Inset(txtRt, 20f);
            var txt = txtGO.AddComponent<Text>();
            var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf") ?? Resources.GetBuiltinResource<Font>("Arial.ttf");
            txt.font = font; txt.fontSize = 40; txt.color = Color.white;
            txt.alignment = TextAnchor.UpperLeft; txt.raycastTarget = false;
            txt.horizontalOverflow = HorizontalWrapMode.Overflow; txt.verticalOverflow = VerticalWrapMode.Overflow;
            txt.text = "FPS --";

            UdonTools.AddConfigured<DebugHud>(canvasGO, h => { h.text = txt; h.culler = culler; h.boardManager = mgr; });
            canvasGO.SetActive(false);   // hidden until the checkbox turns it on
            return canvasGO;
        }

        static void BuildPole(Transform boardRoot)
        {
            var pole = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            pole.name = "Pole";
            var pc = pole.GetComponent<Collider>(); if (pc != null) Object.DestroyImmediate(pc);
            pole.transform.SetParent(boardRoot, false);
            float poleTop = Map.BenchPanelBottom + Map.BenchPanelHeight * PanelScale;   // reach the panel top so the pole backs the whole board
            pole.transform.localScale = new Vector3(PostDiam, poleTop * 0.5f, PostDiam);
            pole.transform.localPosition = new Vector3(0f, poleTop * 0.5f, 0f);
            var mat = LoadOrCreatePoleMaterial();
            if (mat != null) pole.GetComponent<MeshRenderer>().sharedMaterial = mat;
        }

        static Material LoadOrCreatePoleMaterial()
        {
            var existing = AssetDatabase.LoadAssetAtPath<Material>(PoleMatPath);
            if (existing != null) return existing;
            var sh = Shader.Find("Standard");
            if (sh == null) return null;
            var mat = new Material(sh) { name = "DiagBoardPole", color = new Color(0.20f, 0.15f, 0.14f) };
            mat.EnableKeyword("_EMISSION");
            mat.SetColor("_EmissionColor", new Color(0.20f, 0.08f, 0.03f));
            mat.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive;
            AssetDatabase.CreateAsset(mat, PoleMatPath);
            AssetDatabase.SaveAssets();
            return mat;
        }

        // ---- small UI + scene helpers ------------------------------------------------------------------------------

        static GameObject NewUI(string name, Transform parent, out RectTransform rt)
        {
            var go = new GameObject(name, typeof(RectTransform));
            rt = go.GetComponent<RectTransform>();
            rt.SetParent(parent, false);
            rt.localScale = Vector3.one; rt.localRotation = Quaternion.identity;
            return go;
        }

        static void Stretch(RectTransform rt) { rt.anchorMin = Vector2.zero; rt.anchorMax = Vector2.one; rt.offsetMin = Vector2.zero; rt.offsetMax = Vector2.zero; }
        static void Inset(RectTransform rt, float pad) { rt.offsetMin = new Vector2(pad, pad); rt.offsetMax = new Vector2(-pad, -pad); }

        // Depth-first search for the first descendant named `name` (exact match, so TerrainCollision can't shadow Terrain).
        static Transform FindDeep(Transform root, string name)
        {
            if (root.name == name) return root;
            for (int i = 0; i < root.childCount; i++)
            {
                var r = FindDeep(root.GetChild(i), name);
                if (r != null) return r;
            }
            return null;
        }

        static void EditorSceneMarkDirty(GameObject go)
            => UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);
    }
}
#endif
