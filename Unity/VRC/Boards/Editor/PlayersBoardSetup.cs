#if UNITY_EDITOR
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;
using UdonSharp;
using UdonSharpEditor;

namespace OpenSlope.VrcPlugin
{

    // Library setup step: stand up the in-world PLAYERS BOARD (PlayersBoard) - the third panel by the start gate,
    // in the middle of the start-gate board row, between the Settings and Jukebox panels. It lists everyone in the instance,
    // lets each visitor WARP to any of them with a look-and-Use, and carries one "Hide me on the board" checkbox that takes
    // you off everyone else's list. See docs/vrchat/048.
    //
    // What it does + how the (mostly local, one networked bit) design works lives in the PlayersBoard header. This setup
    // only builds the panel and wires the fixed widgets - it resolves nothing from the map (the player list is a pure
    // runtime thing), so unlike the map-driven sibling boards it always builds the same layout: a "Hide me" checkbox, a paged stack
    // of VisibleRows player rows, a page/count readout, and ◀ Prev / Next ▶ nav buttons.
    //
    // Input is VRChat Interact, NOT the world-space UI laser (the same lesson as the sibling boards): every interactive
    // element gets a BoxCollider + a PlayersButton whose Interact() calls back into the board. Lives under
    // OpenSlope_Map/GateBench (cleared when a map is switched) - re-run after loading a map. Idempotent: it deletes + rebuilds its object each run.
    // Same two-step Udon bootstrap as the sibling setups (a freshly created U# program asset can't be attached in the same
    // call). See docs/vrchat/013-udon-components.md.
    public static class PlayersBoardSetup
    {
        const string ObjName     = "PlayersBoard";   // OpenSlope_Map/GateBench/PlayersBoard
        const string PoleMatPath = Map.AssetsFolder + "/PlayersBoardPole.mat";

        const int   VisibleRows = 8;      // page size: how many player rows are shown at once (paged with Prev/Next)

        const int   Slot        = 2;      // bench order: 0 Info · 1 Settings · 2 Players · 3 Jukebox · 4 Diagnostics (Map.BenchSlot)
        const int   SlotCount   = 5;
        const float PostBehind  = 6.0f;   // metres uphill (behind) the matching snowboard at the gate
        const float PostHeight  = 1.4f;   // m, the support pole height
        const float PostDiam    = 0.10f;  // m
        const float PanelBottom = 1.05f;  // m, height of the panel's BOTTOM edge on the pole (rows stack upward from here)
        const float PanelClear  = 0.18f;  // push the panel toward the player so the pole doesn't poke through it

        // Canvas-space (pixels) layout; localScale below maps the panel width to ~1.11 m in world (matches the sibling boards).
        const float CanvasW = 700f;
        const float TitleH  = 96f;
        const float RowH    = 74f;   // a player row / the hide checkbox / a nav button
        const float SectH   = 46f;   // the "Warp to player" sub-header
        const float PageH   = 50f;   // the page / count readout line
        const float Pad     = 24f;
        const float PanelScale = 0.00158f;   // 700 px * 0.00158 ~= 1.11 m wide

        [MenuItem("OpenSlope/Setup/Players Board", false, 170)]
        public static void Setup()
        {
            // Two-step bootstrap: a just-created U# program asset can't have a component attached in the same call.
            bool firstTime = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(PlayersBoard)) == null
                          || UdonSharpProgramAsset.GetProgramAssetForClass(typeof(PlayersButton)) == null;
            if (UdonTools.EnsureProgramAsset<PlayersBoard>(out _) == null)
            {
                Debug.LogError("OpenSlope: could not create/find the PlayersBoard program asset; aborting.");
                return;
            }
            UdonTools.EnsureProgramAsset<PlayersButton>(out _);
            if (firstTime)
            {
                Debug.Log("OpenSlope: created the Udon program asset(s). UdonSharp finalizes them on the next editor tick - " +
                          "run 'OpenSlope/Setup/Players Board' again to build the board.");
                return;
            }

            Transform root = Map.ResolveRoot(true);
            Map.ClearBenchBoard(ObjName);

            // Placement: behind (uphill of) the snowboard at this board's start-gate post, facing downhill at the player.
            var board = new GameObject(ObjName);
            Map.PlaceOnBench(board.transform, Slot, SlotCount, PostBehind);

            var udon = board.GetComponent<PlayersBoard>() ?? board.AddUdonSharpComponent<PlayersBoard>();

            // Build the world-space panel sized to the fixed block (title + hide row + section + N player rows + page line +
            // nav row), then lay it out top-down. y is the running TOP edge offset from the canvas top (negative).
            Transform panel = BuildPanel(board.transform, Map.BenchPanelHeight);   // identical height across the board row

            Font font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf") ?? Resources.GetBuiltinResource<Font>("Arial.ttf");

            // Interactive elements to attach a PlayersButton to after the proxy is pushed: (GameObject, slot, command, tooltip).
            var btnGos = new List<GameObject>();
            var btnSlots = new List<int>();
            var btnCmds = new List<int>();
            var btnTips = new List<string>();

            float y = -TitleH;

            // "Hide me" checkbox (default OFF = visible). The board reads/writes its checkmark; the row's Interact flips it.
            Toggle hideToggle = BuildToggleRow(panel, y, "Hide me on the board", font);
            udon.hideToggle = hideToggle;
            btnGos.Add(hideToggle.gameObject); btnSlots.Add(-1); btnCmds.Add(3); btnTips.Add("Hide me on the board");
            y -= RowH;

            BuildSection(panel, y, "Warp to player", font);
            y -= SectH;

            // The paged stack of player rows (label-only buttons). The board paints names onto rowLabels and SetActive()s
            // rowRoots for empty slots.
            var rowLabels = new Text[VisibleRows];
            var rowDtf = new Text[VisibleRows];
            var rowRoots = new GameObject[VisibleRows];
            for (int i = 0; i < VisibleRows; i++)
            {
                Text lab, dtf;
                GameObject rowGo = BuildButtonRow(panel, y, font, out lab, out dtf);
                rowLabels[i] = lab;
                rowDtf[i] = dtf;
                rowRoots[i] = rowGo;
                btnGos.Add(rowGo); btnSlots.Add(i); btnCmds.Add(0); btnTips.Add("Warp to player");
                y -= RowH;
            }
            udon.rowLabels = rowLabels;
            udon.rowDtf = rowDtf;
            udon.rowRoots = rowRoots;

            // Wire the course-progress network so the rows show each player's live distance-to-finish + sort by it (docs/050).
            var cpT = root.Find(Map.CoursePath);
            udon.coursePath = cpT != null ? cpT.GetComponent<RailNetwork>() : null;
            if (udon.coursePath == null)
                Debug.LogWarning("OpenSlope: Players Board - no OpenSlope_Map/CoursePath in the scene; the DTF / standings column will " +
                                 "show '—'. Build it (OpenSlope/Refresh/Course Path) and re-run this setup.");

            // The page / count readout (non-interactive).
            Text pageText = BuildCenterText(panel, y, PageH, 26, "Players", font);
            udon.pageText = pageText;
            y -= PageH;

            // The nav row: two half-width Interact buttons (◀ Prev | Next ▶).
            GameObject prevGo = BuildHalfButton(panel, y, true, "◀ Prev", font);
            GameObject nextGo = BuildHalfButton(panel, y, false, "Next ▶", font);
            btnGos.Add(prevGo); btnSlots.Add(-1); btnCmds.Add(1); btnTips.Add("Previous page");
            btnGos.Add(nextGo); btnSlots.Add(-1); btnCmds.Add(2); btnTips.Add("Next page");
            y -= RowH;

            // Push the proxy fields into the backing UdonBehaviour BEFORE attaching the buttons (each button's `board` ref
            // must point at a board whose heap is already populated).
            UdonSharpEditorUtility.CopyProxyToUdon(udon);

            // Attach a PlayersButton on every interactive element (its BoxCollider was added by the row builder).
            for (int k = 0; k < btnGos.Count; k++)
            {
                int slot = btnSlots[k], cmd = btnCmds[k];
                var pb = UdonTools.AddConfigured<PlayersButton>(btnGos[k], x => { x.board = udon; x.slot = slot; x.command = cmd; });
                var pso = new SerializedObject(UdonSharpEditorUtility.GetBackingUdonBehaviour(pb));
                var itp = pso.FindProperty("interactText"); if (itp != null) itp.stringValue = btnTips[k];
                var pxp = pso.FindProperty("proximity"); if (pxp != null) pxp.floatValue = 4f;
                pso.ApplyModifiedProperties();
            }

            // The visual support pole (no collider - you interact with the rows / buttons, not the pole).
            BuildPole(board.transform);

            Selection.activeGameObject = board;
            EditorSceneMarkDirty(board);
            Debug.Log($"OpenSlope: Players Board ready at {Map.RootName}/{Map.GateBench}/{ObjName} - a paged player list (warp on Use) + a " +
                      "'Hide me on the board' checkbox. The list is local; only the hide flag is networked (sync Manual). " +
                      "Enter Play (ClientSim) with a second client, or upload, to see it populate.");
        }

        // Setup IS the refresh: it find-or-creates and rebuilds the board in place, so re-running it after a data change
        // is the only entry needed (there is no separate OpenSlope/Refresh item). Greyed out until a map is loaded.
        [MenuItem("OpenSlope/Setup/Players Board", true)]
        static bool SetupEnabled() => GameObject.Find(Map.RootName) != null;

        // ---- panel + rows ------------------------------------------------------------------------------------------

        static Transform BuildPanel(Transform boardRoot, float canvasH)
        {
            var canvasGO = new GameObject("Panel", typeof(RectTransform), typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
            canvasGO.transform.SetParent(boardRoot, false);
            canvasGO.GetComponent<Canvas>().renderMode = RenderMode.WorldSpace;
            var crt = canvasGO.GetComponent<RectTransform>();
            crt.sizeDelta = new Vector2(CanvasW, canvasH);
            crt.localRotation = Quaternion.identity;
            crt.localScale = Vector3.one * PanelScale;
            // Pivot bottom-centre so the panel grows UPWARD from PanelBottom on the pole.
            crt.pivot = new Vector2(0.5f, 0f);
            crt.localPosition = new Vector3(0f, Map.BenchPanelBottom, -PanelClear);

            var bg = NewUI("Backdrop", crt, out var bgRt); Stretch(bgRt);
            var bgImg = bg.AddComponent<Image>();
            bgImg.color = new Color(0.05f, 0.06f, 0.09f, 0.78f);
            bgImg.raycastTarget = false;

            var titleGO = NewUI("Title", crt, out var titleRt);
            titleRt.anchorMin = new Vector2(0f, 1f); titleRt.anchorMax = new Vector2(1f, 1f); titleRt.pivot = new Vector2(0.5f, 1f);
            titleRt.anchoredPosition = new Vector2(0f, -Pad * 0.5f); titleRt.sizeDelta = new Vector2(0f, TitleH);
            var title = titleGO.AddComponent<Text>();
            var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf") ?? Resources.GetBuiltinResource<Font>("Arial.ttf");
            title.font = font; title.fontSize = 40; title.fontStyle = FontStyle.Bold; title.color = Color.white;
            title.alignment = TextAnchor.UpperCenter; title.raycastTarget = false; title.supportRichText = true;
            title.text = "PLAYERS\n<size=22>race standings (m to finish)  ·  look + Use to warp</size>";

            return crt;
        }

        static void BuildSection(Transform panel, float yTop, string text, Font font)
        {
            var go = NewUI("Section_" + text, panel, out var rt);
            rt.anchorMin = new Vector2(0f, 1f); rt.anchorMax = new Vector2(0f, 1f); rt.pivot = new Vector2(0f, 1f);
            rt.anchoredPosition = new Vector2(Pad, yTop);
            rt.sizeDelta = new Vector2(CanvasW - 2f * Pad, SectH);
            var t = go.AddComponent<Text>();
            t.font = font; t.fontSize = 26; t.fontStyle = FontStyle.Bold; t.color = new Color(0.62f, 0.74f, 0.95f);
            t.alignment = TextAnchor.LowerLeft; t.raycastTarget = false; t.supportRichText = false;
            t.horizontalOverflow = HorizontalWrapMode.Overflow; t.verticalOverflow = VerticalWrapMode.Truncate;
            t.text = text.ToUpperInvariant();
        }

        // The "Hide me" checkbox row (stock Unity Toggle built in code: invisible full-row Hit + Background box + Checkmark
        // + Label, plus a BoxCollider for VRChat's Use raycast). Default OFF (you start visible). Returns the Toggle.
        static Toggle BuildToggleRow(Transform panel, float yTop, string label, Font font)
        {
            var rowGO = NewUI("HideRow", panel, out var rowRt);
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
            ckImg.color = new Color(0.95f, 0.55f, 0.20f, 1f);   // amber: "checked = I'm hidden" reads as an active opt-out
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
            toggle.isOn = false;   // start visible
            var cb = toggle.colors;
            cb.normalColor = Color.white; cb.highlightedColor = new Color(0.90f, 0.95f, 1f);
            cb.pressedColor = new Color(0.78f, 0.84f, 0.95f); cb.selectedColor = new Color(0.90f, 0.95f, 1f);
            cb.disabledColor = new Color(0.6f, 0.6f, 0.6f, 0.5f); cb.colorMultiplier = 1f; cb.fadeDuration = 0.1f;
            toggle.colors = cb;

            return toggle;
        }

        // One player ROW: a faint clickable band (the full-row Hit image doubles as a list-item background) + a left-padded
        // Label the board fills with a player's name at runtime, plus a BoxCollider for VRChat's Use raycast. Returns the row
        // GameObject (for SetActive + the PlayersButton) and out the Label Text.
        static GameObject BuildButtonRow(Transform panel, float yTop, Font font, out Text label, out Text dtf)
        {
            var rowGO = NewUI("PlayerRow", panel, out var rowRt);
            rowRt.anchorMin = new Vector2(0f, 1f); rowRt.anchorMax = new Vector2(0f, 1f); rowRt.pivot = new Vector2(0f, 1f);
            rowRt.anchoredPosition = new Vector2(Pad, yTop);
            float wRow = CanvasW - 2f * Pad;
            rowRt.sizeDelta = new Vector2(wRow, RowH);

            var col = rowGO.AddComponent<BoxCollider>();
            col.size = new Vector3(wRow, RowH - 6f, 40f);
            col.center = new Vector3(wRow * 0.5f, -RowH * 0.5f, 0f);

            // A faint band that is ALSO the raycast hit target, inset a touch so consecutive rows read as separate items.
            var hitGO = NewUI("Hit", rowRt, out var hitRt); Stretch(hitRt); Inset(hitRt, 3f);
            var hitImg = hitGO.AddComponent<Image>();
            hitImg.color = new Color(1f, 1f, 1f, 0.06f);
            hitImg.raycastTarget = true;

            var labGO = NewUI("Label", rowRt, out var labRt);
            labRt.anchorMin = new Vector2(0f, 0f); labRt.anchorMax = new Vector2(1f, 1f);
            labRt.offsetMin = new Vector2(28f, 0f); labRt.offsetMax = new Vector2(-150f, 0f);   // leave room for the DTF column
            label = labGO.AddComponent<Text>();
            label.font = font; label.fontSize = 32; label.color = Color.white;
            label.alignment = TextAnchor.MiddleLeft; label.raycastTarget = false; label.supportRichText = false;
            label.horizontalOverflow = HorizontalWrapMode.Wrap; label.verticalOverflow = VerticalWrapMode.Truncate;
            label.text = "";

            // The distance-to-finish column: small, right-aligned, soft-green "m to go" (the live race-standings readout).
            var dtfGO = NewUI("Dtf", rowRt, out var dtfRt);
            dtfRt.anchorMin = new Vector2(1f, 0f); dtfRt.anchorMax = new Vector2(1f, 1f); dtfRt.pivot = new Vector2(1f, 0.5f);
            dtfRt.anchoredPosition = new Vector2(-14f, 0f); dtfRt.sizeDelta = new Vector2(140f, 0f);
            dtf = dtfGO.AddComponent<Text>();
            dtf.font = font; dtf.fontSize = 24; dtf.color = new Color(0.62f, 0.80f, 0.62f);
            dtf.alignment = TextAnchor.MiddleRight; dtf.raycastTarget = false; dtf.supportRichText = false;
            dtf.horizontalOverflow = HorizontalWrapMode.Overflow; dtf.verticalOverflow = VerticalWrapMode.Truncate;
            dtf.text = "";

            return rowGO;
        }

        // A centred, non-interactive line (the page / count readout). Returns its Text so the board can rewrite it.
        static Text BuildCenterText(Transform panel, float yTop, float h, int fontSize, string initial, Font font)
        {
            var go = NewUI("PageText", panel, out var rt);
            rt.anchorMin = new Vector2(0f, 1f); rt.anchorMax = new Vector2(0f, 1f); rt.pivot = new Vector2(0f, 1f);
            rt.anchoredPosition = new Vector2(Pad, yTop);
            rt.sizeDelta = new Vector2(CanvasW - 2f * Pad, h);
            var t = go.AddComponent<Text>();
            t.font = font; t.fontSize = fontSize; t.color = new Color(0.75f, 0.82f, 0.92f);
            t.alignment = TextAnchor.MiddleCenter; t.raycastTarget = false; t.supportRichText = false;
            t.horizontalOverflow = HorizontalWrapMode.Overflow; t.verticalOverflow = VerticalWrapMode.Truncate;
            t.text = initial;
            return t;
        }

        // One of the two nav buttons sharing a row: left half (Prev) or right half (Next). A visible rounded band + a centred
        // label + a BoxCollider over its half. Returns its GameObject for the PlayersButton.
        static GameObject BuildHalfButton(Transform panel, float yTop, bool leftHalf, string label, Font font)
        {
            float wRow = CanvasW - 2f * Pad;
            float gap = 16f;
            float wHalf = (wRow - gap) * 0.5f;
            float x = Pad + (leftHalf ? 0f : wHalf + gap);

            var go = NewUI(leftHalf ? "NavPrev" : "NavNext", panel, out var rt);
            rt.anchorMin = new Vector2(0f, 1f); rt.anchorMax = new Vector2(0f, 1f); rt.pivot = new Vector2(0f, 1f);
            rt.anchoredPosition = new Vector2(x, yTop);
            rt.sizeDelta = new Vector2(wHalf, RowH - 14f);

            var col = go.AddComponent<BoxCollider>();
            col.size = new Vector3(wHalf, RowH - 14f, 40f);
            col.center = new Vector3(wHalf * 0.5f, -(RowH - 14f) * 0.5f, 0f);

            var bandGO = NewUI("Band", rt, out var bandRt); Stretch(bandRt);
            var bandImg = bandGO.AddComponent<Image>();
            bandImg.color = new Color(0.22f, 0.30f, 0.46f, 0.9f);
            bandImg.raycastTarget = true;

            var labGO = NewUI("Label", rt, out var labRt); Stretch(labRt);
            var t = labGO.AddComponent<Text>();
            t.font = font; t.fontSize = 30; t.fontStyle = FontStyle.Bold; t.color = Color.white;
            t.alignment = TextAnchor.MiddleCenter; t.raycastTarget = false; t.supportRichText = false;
            t.horizontalOverflow = HorizontalWrapMode.Overflow; t.verticalOverflow = VerticalWrapMode.Truncate;
            t.text = label;

            return go;
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

        // ---- small UI + scene helpers (mirroring the sibling board setups) ------------------------------------------

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

        static Material LoadOrCreatePoleMaterial()
        {
            var existing = AssetDatabase.LoadAssetAtPath<Material>(PoleMatPath);
            if (existing != null) return existing;
            var sh = Shader.Find("Standard");
            if (sh == null) return null;
            var mat = new Material(sh) { name = "PlayersBoardPole", color = new Color(0.14f, 0.18f, 0.16f) };
            mat.EnableKeyword("_EMISSION");
            mat.SetColor("_EmissionColor", new Color(0.06f, 0.18f, 0.12f));
            mat.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive;
            AssetDatabase.CreateAsset(mat, PoleMatPath);
            AssetDatabase.SaveAssets();
            return mat;
        }

        static void EditorSceneMarkDirty(GameObject go)
            => UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);
    }
}
#endif
