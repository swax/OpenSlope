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

    // Library setup step: stand up the in-world SETTINGS BOARD (SettingsBoard) - the visitor's own preferences panel
    // behind the start gate (the Tuning Board owns the diagnostics + perf claw-backs, the Jukebox owns video). See
    // docs/vrchat/047.
    //
    // What each control does + how "off" is a real change lives in the SettingsBoard header. This setup only builds the
    // panel and RESOLVES + WIRES what's present in the loaded map - anything absent simply gets no row (the board is happy
    // with any subset), except the MODE picker, which needs nothing from the map and is always built:
    //   Ride mode          -> pushed onto every pooled board as RideableBoard.runMode (Race / Trick / Free ride)
    //   Background music   -> MusicDirector.uiMuted             (off-board environment / intro fallback)
    //   Race music         -> RaceMusicDirector.uiMuted
    //   Announcer          -> AnnouncerU.muted
    //   Crowd noise        -> volume-mute the looping Crowd_* grandstand AudioSources (no Udon controller of their own)
    //   Global rider chat  -> BoardVoiceChannel.uiMuted
    //   Snow effect        -> SnowfallU.SnowOn/SnowOff          (the falling-snow master switch)
    //
    // PER-PLAYER + LOCAL (sync None): a click only changes the local client. Defaults are all-ON / mode Trick (Showoff),
    // so an untouched board starts with the retail trick layer. Lives under OpenSlope_Map/GateBench (cleared when a map is switched) - re-run after
    // loading a map AND after the systems it lists (it holds LIVE refs to them, so it must be built AFTER them: Setup All
    // runs it after Snowfall + the Start Gate). Idempotent: it deletes + rebuilds its object each run and re-resolves
    // every target. Same two-step Udon bootstrap as the sibling setups. See docs/vrchat/013-udon-components.md.
    public static class SettingsBoardSetup
    {
        const string ObjName     = "SettingsBoard";   // OpenSlope_Map/GateBench/SettingsBoard
        const string LegacyName  = "SoundBoard";      // what this board was called before it grew the mode + world sections
        const string PoleMatPath = Map.AssetsFolder + "/SettingsBoardPole.mat";

        const int   Slot        = 1;      // bench order: 0 Info · 1 Settings · 2 Players · 3 Jukebox · 4 Diagnostics (Map.BenchSlot)
        const int   SlotCount   = 5;
        const float PostBehind  = 6.0f;   // metres uphill (behind) the matching snowboard at the gate
        const float PostHeight  = 1.4f;
        const float PostDiam    = 0.10f;
        const float PanelBottom = 1.05f;
        const float PanelClear  = 0.18f;

        const float CanvasW   = 700f;   // ~1.11 m wide at PanelScale (matches the sibling boards)
        const float TitleH    = 96f;
        const float RowH      = 74f;
        const float SectH     = 46f;
        const float ModeRowH  = 92f;    // the mode picker's chip row (taller than a checkbox row - it holds 3 buttons)
        const float ModeBtnH  = 64f;
        const float ModeBtnGap = 10f;
        const float Pad       = 24f;
        const float PanelScale = 0.00158f;

        // The mode picker, in board order. Index IS SettingsBoard.ModeRace / ModeTrick / ModeFreeRide.
        static readonly string[] ModeLabels = { "Race", "Trick", "Free ride" };

        [MenuItem("OpenSlope/Setup/Settings Board", false, 191)]
        public static void Setup()
        {
            // Two-step bootstrap: a just-created U# program asset can't have a component attached in the same call.
            bool firstTime = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(SettingsBoard)) == null
                          || UdonSharpProgramAsset.GetProgramAssetForClass(typeof(SettingsToggle)) == null
                          || UdonSharpProgramAsset.GetProgramAssetForClass(typeof(SettingsModeButton)) == null;
            if (UdonTools.EnsureProgramAsset<SettingsBoard>(out _) == null)
            {
                Debug.LogError("OpenSlope: could not create/find the SettingsBoard program asset; aborting.");
                return;
            }
            UdonTools.EnsureProgramAsset<SettingsToggle>(out _);
            UdonTools.EnsureProgramAsset<SettingsModeButton>(out _);
            if (firstTime)
            {
                Debug.Log("OpenSlope: created the Udon program asset(s). UdonSharp finalizes them on the next editor tick - " +
                          "run 'OpenSlope/Setup/Settings Board' again to build the board.");
                return;
            }

            Map.ClearBenchBoard(ObjName);
            Map.ClearBenchBoard(LegacyName);      // a scene built before the rename still carries the old SoundBoard object

            // Resolve the systems present in this map. Absent ones stay null -> no row built for them.
            var musicU    = Object.FindObjectOfType<MusicDirector>(true);
            var raceU     = Object.FindObjectOfType<RaceMusicDirector>(true);
            var mcU       = Object.FindObjectOfType<AnnouncerU>(true);
            AudioSource[] crowd   = ResolveCrowdSources();
            var voiceU    = Object.FindObjectOfType<BoardVoiceChannel>(true); // the board (rider) voice channel
            var snowU     = Object.FindObjectOfType<SnowfallU>(true);         // the falling-snow master switch
            var mgr       = Object.FindObjectOfType<BoardManager>(true);      // the pooled boards the ride mode is pushed to
            bool haveBoards = mgr != null && mgr.boards != null && mgr.boards.Length > 0;
            var modeObjects = new List<GameObject>();
            var modeMasks = new List<int>();
            var mapRoot = GameObject.Find(Map.RootName);
            foreach (var mv in Object.FindObjectsOfType<ModeVisibility>(true))
            {
                if (mv == null || mapRoot == null || !mv.transform.IsChildOf(mapRoot.transform)) continue;
                modeObjects.Add(mv.gameObject);
                modeMasks.Add(mv.ModeMask);
            }
            RailNetwork grindRails = null;
            foreach (var net in Object.FindObjectsOfType<RailNetwork>(true))
                if (net != null && net.name == "Rails") { grindRails = net; break; }

            // Placement: behind (uphill of) the snowboard at this board's start-gate post, facing downhill at the player.
            var board = new GameObject(ObjName);
            Map.PlaceOnBench(board.transform, Slot, SlotCount, PostBehind);

            var udon = board.GetComponent<SettingsBoard>() ?? board.AddUdonSharpComponent<SettingsBoard>();
            udon.mode = SettingsBoard.ModeTrick;
            if (musicU != null) udon.music     = musicU;
            if (raceU != null)  udon.raceMusic = raceU;
            if (mcU != null)    udon.announcer = mcU;
            if (crowd.Length > 0)
            {
                udon.crowdSources = crowd;
                var vols = new float[crowd.Length];
                for (int i = 0; i < crowd.Length; i++) vols[i] = crowd[i].volume;
                udon.crowdVolumes = vols;
            }
            if (voiceU != null) udon.voiceChannel = voiceU;
            if (snowU != null)  udon.snow         = snowU;
            if (haveBoards)     udon.manager      = mgr;
            udon.modeObjects = modeObjects.ToArray();
            udon.modeMasks = modeMasks.ToArray();
            udon.railNetwork = grindRails;

            int audioRows = (musicU != null ? 1 : 0) + (raceU != null ? 1 : 0) + (mcU != null ? 1 : 0)
                          + (crowd.Length > 0 ? 1 : 0) + (voiceU != null ? 1 : 0);
            Transform panel = BuildPanel(board.transform, Map.BenchPanelHeight);   // identical height across the board row

            Font font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf") ?? Resources.GetBuiltinResource<Font>("Arial.ttf");
            var toggles = new List<Toggle>();
            var togDefs = new List<System.Action<Toggle>>();
            var modeButtons = new List<SettingsModeButton>();

            float y = -TitleH;

            // RIDE MODE - the one-of-three picker. Built even on a map with no boards yet (it just has nothing to push to
            // until the Start Gate exists), so the panel always reads the same.
            BuildSection(panel, y, "Ride mode", font);
            y -= SectH;
            BuildModeRow(panel, y, font, udon, modeButtons);
            y -= ModeRowH;

            // SOUND - the per-player mutes (checked = audible).
            if (audioRows > 0)
            {
                BuildSection(panel, y, "Sound", font);
                y -= SectH;
                if (musicU != null)     { BuildRow(panel, y, "Background music",     font, toggles); togDefs.Add(x => udon.musicToggle      = x); y -= RowH; }
                if (raceU != null)      { BuildRow(panel, y, "Race music",           font, toggles); togDefs.Add(x => udon.raceMusicToggle  = x); y -= RowH; }
                if (mcU != null)        { BuildRow(panel, y, "Announcer (MC)",       font, toggles); togDefs.Add(x => udon.announcerToggle  = x); y -= RowH; }
                if (crowd.Length > 0)   { BuildRow(panel, y, "Crowd noise",          font, toggles); togDefs.Add(x => udon.crowdToggle      = x); y -= RowH; }
                if (voiceU != null)     { BuildRow(panel, y, "Global rider chat",    font, toggles); togDefs.Add(x => udon.riderVoiceToggle = x); y -= RowH; }
            }

            // WORLD - the cosmetic effects a visitor might not want.
            if (snowU != null)
            {
                BuildSection(panel, y, "World", font);
                y -= SectH;
                BuildRow(panel, y, "Snow effect", font, toggles); togDefs.Add(x => udon.snowToggle = x); y -= RowH;
            }

            for (int k = 0; k < toggles.Count; k++) togDefs[k](toggles[k]);

            UdonSharpEditorUtility.CopyProxyToUdon(udon);
            var backing = UdonSharpEditorUtility.GetBackingUdonBehaviour(udon);
            if (backing != null)
                foreach (var t in toggles)
                    UnityEventTools.AddStringPersistentListener(t.onValueChanged, backing.SendCustomEvent, nameof(SettingsBoard.Apply));

            // Interact-based input on every checkbox row (its BoxCollider was added in BuildRow): looking at a row and
            // pressing Use flips it - reliable, since VRChat's world-space UI laser often doesn't register on a Canvas Toggle.
            foreach (var t in toggles)
            {
                var rowGo = t.gameObject;
                var pt = UdonTools.AddConfigured<SettingsToggle>(rowGo, x => { x.toggle = t; x.board = udon; });
                var lbl = rowGo.transform.Find("Label");
                string txt = lbl != null && lbl.GetComponent<Text>() != null ? lbl.GetComponent<Text>().text : "Toggle";
                SetInteract(pt, txt);
            }
            // The mode chips take the same Interact path; their board ref is pushed here (the proxy existed at build time,
            // but the push above is what makes the ref live).
            foreach (var mb in modeButtons)
            {
                mb.board = udon;
                UdonTools.Push(mb);
                SetInteract(mb, "Mode: " + ModeLabels[Mathf.Clamp(mb.mode, 0, ModeLabels.Length - 1)]);
            }

            BuildPole(board.transform);

            Selection.activeGameObject = board;
            EditorSceneMarkDirty(board);
            Debug.Log($"OpenSlope: Settings Board ready at {Map.RootName}/{Map.GateBench}/{ObjName} - ride-mode picker" +
                      (haveBoards ? $" (pushed to {mgr.boards.Length} pooled board(s))" : " (no pooled boards yet - re-run after the Start Gate)") +
                      $", {modeObjects.Count} mode-gated prop object(s), show-off rails {(grindRails != null ? "wired" : "absent")}" +
                      $", {audioRows} sound toggle(s), snow effect {(snowU != null ? "wired" : "absent")}. " +
                      "Per-player/local (sync None). Use the controls in-world (look + Use). Upload or enter Play (ClientSim) to use it.");
        }

        // Setup IS the refresh: it find-or-creates and rebuilds the board in place, so re-running it after a data change
        // is the only entry needed (there is no separate OpenSlope/Refresh item). Greyed out until a map is loaded.
        [MenuItem("OpenSlope/Setup/Settings Board", true)]
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
            title.text = "SETTINGS\n<size=22>your own  ·  mode · sound · world</size>";

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

        // The RIDE-MODE picker: three chips across one row, exactly one lit. Each chip is its own Interact target
        // (BoxCollider + SettingsModeButton) that calls SetMode; the board owns the lit/dim painting, so this only
        // builds the widgets and hands it the Image/Text arrays.
        static void BuildModeRow(Transform panel, float yTop, Font font, SettingsBoard udon, List<SettingsModeButton> outButtons)
        {
            var rowGO = NewUI("ModeRow", panel, out var rowRt);
            rowRt.anchorMin = new Vector2(0f, 1f); rowRt.anchorMax = new Vector2(0f, 1f); rowRt.pivot = new Vector2(0f, 1f);
            rowRt.anchoredPosition = new Vector2(Pad, yTop);
            float wRow = CanvasW - 2f * Pad;
            rowRt.sizeDelta = new Vector2(wRow, ModeRowH);

            int n = ModeLabels.Length;
            float bw = (wRow - ModeBtnGap * (n - 1)) / n;
            float top = -(ModeRowH - ModeBtnH) * 0.5f;   // vertically centre the chips in the row

            var images = new Image[n];
            var labels = new Text[n];
            for (int i = 0; i < n; i++)
            {
                var btnGO = NewUI("Mode_" + ModeLabels[i], rowRt, out var btnRt);
                btnRt.anchorMin = new Vector2(0f, 1f); btnRt.anchorMax = new Vector2(0f, 1f); btnRt.pivot = new Vector2(0f, 1f);
                btnRt.anchoredPosition = new Vector2(i * (bw + ModeBtnGap), top);
                btnRt.sizeDelta = new Vector2(bw, ModeBtnH);

                // The chip face. Colour is asserted at runtime by SettingsBoard.PaintModeButtons (this is just a
                // sensible authoring-time look), and it's the raycast target so a UI laser click lands too.
                var img = btnGO.AddComponent<Image>();
                img.color = i == udon.mode ? new Color(0.36f, 0.68f, 1f, 1f) : new Color(0.16f, 0.19f, 0.26f, 1f);
                img.raycastTarget = true;

                // Interact collider covering the chip (pivot top-left -> centre is +halfWidth, -halfHeight).
                var col = btnGO.AddComponent<BoxCollider>();
                col.size = new Vector3(bw, ModeBtnH, 40f);
                col.center = new Vector3(bw * 0.5f, -ModeBtnH * 0.5f, 0f);

                var labGO = NewUI("Label", btnRt, out var labRt); Stretch(labRt);
                var lab = labGO.AddComponent<Text>();
                lab.font = font; lab.fontSize = 30; lab.fontStyle = FontStyle.Bold;
                lab.color = i == udon.mode ? new Color(0.04f, 0.07f, 0.12f) : new Color(0.72f, 0.78f, 0.88f);
                lab.alignment = TextAnchor.MiddleCenter; lab.raycastTarget = false; lab.supportRichText = false;
                lab.horizontalOverflow = HorizontalWrapMode.Overflow; lab.verticalOverflow = VerticalWrapMode.Truncate;
                lab.text = ModeLabels[i];

                images[i] = img;
                labels[i] = lab;

                int captured = i;
                outButtons.Add(UdonTools.AddConfigured<SettingsModeButton>(btnGO, x => { x.mode = captured; x.board = udon; }));
            }

            udon.modeButtons = images;
            udon.modeLabels = labels;
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
            ckImg.color = new Color(0.20f, 0.70f, 0.35f, 1f);
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

        // The in-world Use tooltip + reach on an Interact target (both live on the BACKING UdonBehaviour, not the proxy).
        static void SetInteract(UdonSharpBehaviour proxy, string text)
        {
            var backing = UdonSharpEditorUtility.GetBackingUdonBehaviour(proxy);
            if (backing == null) return;
            var so = new SerializedObject(backing);
            var itp = so.FindProperty("interactText"); if (itp != null) itp.stringValue = text;
            var pxp = so.FindProperty("proximity"); if (pxp != null) pxp.floatValue = 4f;
            so.ApplyModifiedProperties();
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

        static AudioSource[] ResolveCrowdSources()
        {
            var all = Object.FindObjectsOfType<AudioSource>(true);
            var list = new List<AudioSource>();
            foreach (var s in all)
                if (s != null && s.name.StartsWith("Crowd_")) list.Add(s);
            return list.ToArray();
        }

        static Material LoadOrCreatePoleMaterial()
        {
            var existing = AssetDatabase.LoadAssetAtPath<Material>(PoleMatPath);
            if (existing != null) return existing;
            var sh = Shader.Find("Standard");
            if (sh == null) return null;
            var mat = new Material(sh) { name = "SettingsBoardPole", color = new Color(0.16f, 0.14f, 0.20f) };
            mat.EnableKeyword("_EMISSION");
            mat.SetColor("_EmissionColor", new Color(0.14f, 0.06f, 0.20f));
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
