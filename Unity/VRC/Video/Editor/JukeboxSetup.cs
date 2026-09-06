#if UNITY_EDITOR
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.Events;
using UnityEngine;
using UnityEngine.UI;
using UnityEngine.EventSystems;
using UdonSharp;
using UdonSharpEditor;

namespace OpenSlope.VrcPlugin
{
    using VRC.SDK3.Components;   // VRCUrlInputField

    // Library setup step: stand up the in-world JUKEBOX (Jukebox) - a SHARED video jukebox by the start gate.
    // Anyone can "Add video" (it pops VRChat's keyboard); the URL joins a synced, round-robin-fair QUEUE everyone sees;
    // when a video ends the next is popped and played FOR EVERYONE; a draggable scrub bar moves the shared playhead; and a
    // moderator can cycle a 3-way Lock (Unlocked / Queue unlocked / Locked) that gates adding + seek/skip. See docs/vrchat/049.
    //
    // What it does + how the synced jukebox works lives in the Jukebox header. This setup builds the panel + wires
    // the fixed widgets, and cross-links the queue to the local AVPro renderer (VideoBillboards) it drives. Layout
    // top-down: title, a now-playing line, a draggable scrub Slider + time readout, an [Add video | Skip] row, a "QUEUE"
    // section, a paged stack of queue rows (each with a [x] remove button shown only to who may remove it), a page readout,
    // a [Prev | Next] nav row, and a [Screens (local) | Lock (moderator)] row.
    //
    // INPUT. Push buttons use VRChat Interact (a BoxCollider + JukeboxButton), the proven path the sibling boards use. The
    // scrub bar is the one exception: it's a real draggable UI Slider driven by VRChat's world-space laser - an
    // EventTrigger marks the drag start/end so the queue commits ONE seek on release. The
    // "Add video" button reuses UrlBox to focus an always-active (but invisible) VRCUrlInputField (the keyboard-pop
    // recipe UrlBox provides).
    //
    // Lives under OpenSlope_Map/GateBench (cleared when a map is switched) - re-run after loading a map AND after Video Billboards (it holds
    // a live ref to that renderer). Idempotent: it deletes + rebuilds its object each run. Same two-step Udon bootstrap as
    // the sibling setups (a freshly created U# program asset can't be attached in the same call). See docs/vrchat/013.
    public static class JukeboxSetup
    {
        const string ObjName     = "Jukebox";   // OpenSlope_Map/GateBench/Jukebox
        const string PoleMatPath = Map.AssetsFolder + "/JukeboxPole.mat";

        const int   VisibleRows = 6;      // page size: queue rows shown at once (paged with Prev/Next)

        const int   Slot        = 3;      // bench order: 0 Info · 1 Settings · 2 Players · 3 Jukebox · 4 Diagnostics (Map.BenchSlot)
        const int   SlotCount   = 5;
        const float PostBehind  = 6.0f;   // metres uphill (behind) the matching snowboard at the gate
        const float PostHeight  = 1.4f;
        const float PostDiam    = 0.10f;
        const float PanelBottom = 1.05f;
        const float PanelClear  = 0.18f;

        // Canvas-space (pixels); localScale maps the width to ~1.14 m in world (a touch wider than the sibling boards - URLs).
        const float CanvasW = 720f;
        const float TitleH  = 96f;
        const float NowH    = 104f;   // the now-playing line (title + queued-by)
        const float SeekH   = 40f;    // the scrub bar
        const float TimeH   = 34f;    // the m:ss / m:ss readout
        const float CtrlH   = 74f;    // the [Add video | Skip] row
        const float SectH   = 46f;    // the "QUEUE" sub-header
        const float RowH    = 70f;    // a queue row
        const float PageH   = 50f;    // the page / count readout
        const float NavH    = 74f;    // the [Prev | Next] row
        const float BotH    = 74f;    // the [Screens | Lock] row
        const float Pad     = 24f;
        const float PanelScale = 0.00158f;

        [MenuItem("OpenSlope/Setup/Jukebox", false, 153)]
        public static void Setup()
        {
            // Two-step bootstrap: a just-created U# program asset can't have a component attached in the same call. The
            // board uses Jukebox (brain), JukeboxButton (push buttons) and UrlBox (the Add field focus), so ensure all.
            bool firstTime = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(Jukebox)) == null
                          || UdonSharpProgramAsset.GetProgramAssetForClass(typeof(JukeboxButton)) == null
                          || UdonSharpProgramAsset.GetProgramAssetForClass(typeof(UrlBox)) == null;
            if (UdonTools.EnsureProgramAsset<Jukebox>(out _) == null)
            {
                Debug.LogError("OpenSlope: could not create/find the Jukebox program asset; aborting.");
                return;
            }
            UdonTools.EnsureProgramAsset<JukeboxButton>(out _);
            UdonTools.EnsureProgramAsset<UrlBox>(out _);
            if (firstTime)
            {
                Debug.Log("OpenSlope: created the Udon program asset(s). UdonSharp finalizes them on the next editor tick - " +
                          "run 'OpenSlope/Setup/Jukebox' again to build the board.");
                return;
            }

            // The renderer the queue drives. Without billboards there's nothing to play, so the board would be pointless.
            var billboards = Object.FindObjectOfType<VideoBillboards>(true);
            if (billboards == null)
            {
                Debug.LogWarning("OpenSlope: Jukebox needs the Video Billboards (the AVPro renderer) - none found. Run " +
                                 "OpenSlope/Setup/Video Billboards (or Setup All) first, then re-run this.");
                return;
            }

            Map.ClearBenchBoard(ObjName);

            // Placement: behind (uphill of) the snowboard at this board's start-gate post, facing downhill at the player.
            var board = new GameObject(ObjName);
            Map.PlaceOnBench(board.transform, Slot, SlotCount, PostBehind);

            var udon = board.GetComponent<Jukebox>() ?? board.AddUdonSharpComponent<Jukebox>();
            udon.video = billboards;

            Transform panel = BuildPanel(board.transform, Map.BenchPanelHeight);   // identical height across the board row
            Font font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf") ?? Resources.GetBuiltinResource<Font>("Arial.ttf");

            // Interactive push buttons to attach a JukeboxButton to after the proxy is pushed: (GameObject, command, slot, tooltip).
            var btnGos = new List<GameObject>();
            var btnCmds = new List<int>();
            var btnSlots = new List<int>();
            var btnTips = new List<string>();

            float y = -TitleH;

            // Now-playing line (rich text; the queue rewrites it).
            udon.nowLabel = BuildLabel(panel, y, NowH, 34, TextAnchor.MiddleCenter, true, font);
            udon.nowLabel.text = "<b>Nothing playing</b>\n<size=20>press ▶ Add video</size>";
            y -= NowH;

            // The draggable scrub bar + the m:ss readout under it.
            Slider seek = BuildSeekSlider(panel, y, udon);
            udon.seekSlider = seek;
            y -= SeekH;
            udon.timeLabel = BuildLabel(panel, y, TimeH, 22, TextAnchor.MiddleCenter, false, font);
            udon.timeLabel.text = "—";
            y -= TimeH;

            // The [Add video | Skip] row. Add focuses the URL field (UrlBox); Skip is a normal JukeboxButton.
            VRCUrlInputField addField;
            GameObject addGo = BuildAddButton(panel, y, true, font, udon, out addField);
            udon.addField = addField;
            GameObject skipGo = BuildBandButton(panel, y, false, CtrlH, "⏭ Skip", new Color(0.40f, 0.24f, 0.30f, 0.92f), font, out _);
            btnGos.Add(skipGo); btnCmds.Add(4); btnSlots.Add(-1); btnTips.Add("Skip the current video");
            y -= CtrlH;

            BuildSection(panel, y, "Queue", font);
            y -= SectH;

            // The paged stack of queue rows; each carries a [x] remove button the queue shows only to who may remove it.
            var rowLabels = new Text[VisibleRows];
            var rowRoots = new GameObject[VisibleRows];
            var rowRemoves = new GameObject[VisibleRows];
            for (int i = 0; i < VisibleRows; i++)
            {
                Text lab; GameObject removeGo;
                GameObject rowGo = BuildQueueRow(panel, y, font, out lab, out removeGo);
                rowLabels[i] = lab; rowRoots[i] = rowGo; rowRemoves[i] = removeGo;
                btnGos.Add(removeGo); btnCmds.Add(1); btnSlots.Add(i); btnTips.Add("Remove from queue");
                y -= RowH;
            }
            udon.rowLabels = rowLabels; udon.rowRoots = rowRoots; udon.rowRemoveRoots = rowRemoves;

            // Page readout.
            udon.pageLabel = BuildLabel(panel, y, PageH, 26, TextAnchor.MiddleCenter, false, font);
            udon.pageLabel.text = "queue empty";
            y -= PageH;

            // [Prev | Next] nav row.
            GameObject prevGo = BuildBandButton(panel, y, true, NavH, "◀ Prev", new Color(0.22f, 0.30f, 0.46f, 0.9f), font, out _);
            GameObject nextGo = BuildBandButton(panel, y, false, NavH, "Next ▶", new Color(0.22f, 0.30f, 0.46f, 0.9f), font, out _);
            btnGos.Add(prevGo); btnCmds.Add(2); btnSlots.Add(-1); btnTips.Add("Previous page");
            btnGos.Add(nextGo); btnCmds.Add(3); btnSlots.Add(-1); btnTips.Add("Next page");
            y -= NavH;

            // [Screens (local) | Lock (moderator)] row. Both bands carry a label the queue rewrites with the live state.
            Text screensLab, lockLab;
            GameObject scrGo = BuildBandButton(panel, y, true, BotH, "Screens: ON (for me)", new Color(0.20f, 0.34f, 0.30f, 0.92f), font, out screensLab);
            GameObject lockGo = BuildBandButton(panel, y, false, BotH, "🔓 Unlocked", new Color(0.34f, 0.30f, 0.18f, 0.92f), font, out lockLab);
            udon.screensLabel = screensLab; udon.lockLabel = lockLab;
            btnGos.Add(scrGo); btnCmds.Add(5); btnSlots.Add(-1); btnTips.Add("Show/hide the video screens for me (framerate)");
            btnGos.Add(lockGo); btnCmds.Add(6); btnSlots.Add(-1); btnTips.Add("Cycle lock: Unlocked / Queue unlocked / Locked (instance owner only)");

            // Push the proxy heap into the backing UdonBehaviour BEFORE attaching the buttons (each button's `jukebox` ref
            // must point at a board whose heap is already populated), and BEFORE wiring the field/slider events at it.
            UdonSharpEditorUtility.CopyProxyToUdon(udon);
            var backing = UdonSharpEditorUtility.GetBackingUdonBehaviour(udon);

            // Wire the Add field's OnEndEdit + the scrub bar's drag/value events to the queue's backing behaviour.
            if (backing != null)
            {
                UnityEventTools.AddStringPersistentListener(addField.onEndEdit, backing.SendCustomEvent, nameof(Jukebox.OnAddSubmitted));
                WireSeekEvents(seek, backing);
            }

            // Attach a JukeboxButton on every push button (its BoxCollider was added by the band/row builder).
            for (int k = 0; k < btnGos.Count; k++)
            {
                int cmd = btnCmds[k], slot = btnSlots[k];
                var vb = UdonTools.AddConfigured<JukeboxButton>(btnGos[k], x => { x.jukebox = udon; x.command = cmd; x.slot = slot; });
                var vso = new SerializedObject(UdonSharpEditorUtility.GetBackingUdonBehaviour(vb));
                var itp = vso.FindProperty("interactText"); if (itp != null) itp.stringValue = btnTips[k];
                var pxp = vso.FindProperty("proximity"); if (pxp != null) pxp.floatValue = 4f;
                vso.ApplyModifiedProperties();
            }

            // Back-link the renderer to the queue so its OnVideoEnd/Ready/Error notify the queue (owner advances), and persist.
            billboards.jukebox = udon;
            UdonTools.Push(billboards);

            BuildPole(board.transform);

            Selection.activeGameObject = board;
            EditorSceneMarkDirty(board);
            Debug.Log($"OpenSlope: Jukebox ready at {Map.RootName}/{Map.GateBench}/{ObjName} - a SHARED video queue (sync Manual): Add video " +
                      "(keyboard) -> fair-interleaved queue everyone sees; auto-advance; a draggable scrub bar moving the shared " +
                      "playhead; per-player Screens toggle; a moderator 3-way Lock. Upload to use (ClientSim doesn't play AVPro video).");
        }

        // Setup IS the refresh: it find-or-creates and rebuilds the board in place, so re-running it after a data change
        // is the only entry needed (there is no separate OpenSlope/Refresh item). Greyed out until a map is loaded.
        [MenuItem("OpenSlope/Setup/Jukebox", true)]
        static bool SetupEnabled() => GameObject.Find(Map.RootName) != null;

        // ---- panel + widgets ---------------------------------------------------------------------------------------

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
            bgImg.color = new Color(0.05f, 0.06f, 0.09f, 0.80f);
            bgImg.raycastTarget = false;

            var titleGO = NewUI("Title", crt, out var titleRt);
            titleRt.anchorMin = new Vector2(0f, 1f); titleRt.anchorMax = new Vector2(1f, 1f); titleRt.pivot = new Vector2(0.5f, 1f);
            titleRt.anchoredPosition = new Vector2(0f, -Pad * 0.5f); titleRt.sizeDelta = new Vector2(0f, TitleH);
            var title = titleGO.AddComponent<Text>();
            var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf") ?? Resources.GetBuiltinResource<Font>("Arial.ttf");
            title.font = font; title.fontSize = 40; title.fontStyle = FontStyle.Bold; title.color = Color.white;
            title.alignment = TextAnchor.UpperCenter; title.raycastTarget = false; title.supportRichText = true;
            title.text = "JUKEBOX\n<size=22>shared  ·  add a video  ·  drag to scrub</size>";

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

        // A non-interactive text line whose TOP edge sits at yTop. Returns its Text so the queue can rewrite it.
        static Text BuildLabel(Transform panel, float yTop, float h, int fontSize, TextAnchor align, bool rich, Font font)
        {
            var go = NewUI("Label", panel, out var rt);
            rt.anchorMin = new Vector2(0f, 1f); rt.anchorMax = new Vector2(0f, 1f); rt.pivot = new Vector2(0f, 1f);
            rt.anchoredPosition = new Vector2(Pad, yTop);
            rt.sizeDelta = new Vector2(CanvasW - 2f * Pad, h);
            var t = go.AddComponent<Text>();
            t.font = font; t.fontSize = fontSize; t.color = new Color(0.92f, 0.95f, 1f);
            t.alignment = align; t.raycastTarget = false; t.supportRichText = rich;
            t.horizontalOverflow = HorizontalWrapMode.Wrap; t.verticalOverflow = VerticalWrapMode.Truncate;
            return t;
        }

        // The draggable scrub bar: a stock Unity Slider (Background track + Fill + Handle), min 0 / max 1. The Background and
        // Handle are raycast targets so VRChat's world-space laser can click + drag it; an EventTrigger (wired separately)
        // tells the queue when a drag starts/ends so it commits the seek on release.
        static Slider BuildSeekSlider(Transform panel, float yTop, Jukebox udon)
        {
            float wRow = CanvasW - 2f * Pad;
            var sliderGO = NewUI("SeekBar", panel, out var rt);
            rt.anchorMin = new Vector2(0f, 1f); rt.anchorMax = new Vector2(0f, 1f); rt.pivot = new Vector2(0f, 1f);
            rt.anchoredPosition = new Vector2(Pad, yTop);
            rt.sizeDelta = new Vector2(wRow, SeekH - 10f);

            var slider = sliderGO.AddComponent<Slider>();

            // Background track (full width, the click area).
            var bgGO = NewUI("Background", rt, out var bgRt); Stretch(bgRt);
            var bgImg = bgGO.AddComponent<Image>();
            bgImg.color = new Color(0.16f, 0.18f, 0.24f, 1f);
            bgImg.raycastTarget = true;

            // Fill area -> fill (the filled portion left of the handle).
            var faGO = NewUI("Fill Area", rt, out var faRt);
            faRt.anchorMin = new Vector2(0f, 0.5f); faRt.anchorMax = new Vector2(1f, 0.5f); faRt.pivot = new Vector2(0.5f, 0.5f);
            faRt.offsetMin = new Vector2(0f, -(SeekH - 10f) * 0.5f); faRt.offsetMax = new Vector2(0f, (SeekH - 10f) * 0.5f);
            var fillGO = NewUI("Fill", faRt, out var fillRt);
            fillRt.anchorMin = new Vector2(0f, 0f); fillRt.anchorMax = new Vector2(0f, 1f); fillRt.pivot = new Vector2(0f, 0.5f);
            fillRt.sizeDelta = new Vector2(10f, 0f);
            var fillImg = fillGO.AddComponent<Image>();
            fillImg.color = new Color(0.30f, 0.70f, 0.95f, 1f);
            fillImg.raycastTarget = false;

            // Handle slide area -> handle.
            var hsGO = NewUI("Handle Slide Area", rt, out var hsRt); Stretch(hsRt);
            hsRt.offsetMin = new Vector2(8f, 0f); hsRt.offsetMax = new Vector2(-8f, 0f);
            var handleGO = NewUI("Handle", hsRt, out var handleRt);
            handleRt.sizeDelta = new Vector2(18f, 0f);
            var handleImg = handleGO.AddComponent<Image>();
            handleImg.color = new Color(0.95f, 0.97f, 1f, 1f);
            handleImg.raycastTarget = true;

            slider.fillRect = fillRt;
            slider.handleRect = handleRt;
            slider.targetGraphic = handleImg;
            slider.direction = Slider.Direction.LeftToRight;
            slider.minValue = 0f; slider.maxValue = 1f; slider.wholeNumbers = false; slider.value = 0f;
            var cb = slider.colors;
            cb.normalColor = Color.white; cb.highlightedColor = new Color(0.90f, 0.95f, 1f);
            cb.pressedColor = new Color(0.78f, 0.84f, 0.95f); cb.selectedColor = new Color(0.90f, 0.95f, 1f);
            cb.disabledColor = new Color(0.45f, 0.47f, 0.52f, 0.6f); cb.colorMultiplier = 1f; cb.fadeDuration = 0.1f;
            slider.colors = cb;

            return slider;
        }

        // Hook the scrub bar's drag start/end (EventTrigger PointerDown/PointerUp) + value change to the queue's backing
        // behaviour: grab/release bracket the user drag (so the per-frame fill steps aside and the seek commits once on
        // release), and the value change drives the live time preview while dragging.
        static void WireSeekEvents(Slider slider, VRC.Udon.UdonBehaviour backing)
        {
            UnityEventTools.AddStringPersistentListener(slider.onValueChanged, backing.SendCustomEvent, nameof(Jukebox.OnSeekChanged));

            var et = slider.gameObject.AddComponent<EventTrigger>();
            var down = new EventTrigger.Entry { eventID = EventTriggerType.PointerDown };
            UnityEventTools.AddStringPersistentListener(down.callback, backing.SendCustomEvent, nameof(Jukebox.OnSeekGrab));
            et.triggers.Add(down);
            var up = new EventTrigger.Entry { eventID = EventTriggerType.PointerUp };
            UnityEventTools.AddStringPersistentListener(up.callback, backing.SendCustomEvent, nameof(Jukebox.OnSeekRelease));
            et.triggers.Add(up);
        }

        // One half-width band button (left or right of a Pad-margined row) with a BoxCollider for VRChat's Use raycast and a
        // centred label. Returns its GameObject (for the JukeboxButton) and out the label Text (the queue rewrites Screens/Lock).
        static GameObject BuildBandButton(Transform panel, float yTop, bool leftHalf, float rowH, string label, Color band, Font font, out Text labelText)
        {
            float wRow = CanvasW - 2f * Pad;
            float gap = 16f;
            float wHalf = (wRow - gap) * 0.5f;
            float h = rowH - 14f;
            float x = Pad + (leftHalf ? 0f : wHalf + gap);

            var go = NewUI(leftHalf ? "BtnL" : "BtnR", panel, out var rt);
            rt.anchorMin = new Vector2(0f, 1f); rt.anchorMax = new Vector2(0f, 1f); rt.pivot = new Vector2(0f, 1f);
            rt.anchoredPosition = new Vector2(x, yTop);
            rt.sizeDelta = new Vector2(wHalf, h);

            var col = go.AddComponent<BoxCollider>();
            col.size = new Vector3(wHalf, h, 40f);
            col.center = new Vector3(wHalf * 0.5f, -h * 0.5f, 0f);

            var bandGO = NewUI("Band", rt, out var bandRt); Stretch(bandRt);
            var bandImg = bandGO.AddComponent<Image>();
            bandImg.color = band; bandImg.raycastTarget = true;

            var labGO = NewUI("Label", rt, out var labRt); Stretch(labRt);
            labelText = labGO.AddComponent<Text>();
            labelText.font = font; labelText.fontSize = 28; labelText.fontStyle = FontStyle.Bold; labelText.color = Color.white;
            labelText.alignment = TextAnchor.MiddleCenter; labelText.raycastTarget = false; labelText.supportRichText = false;
            labelText.horizontalOverflow = HorizontalWrapMode.Overflow; labelText.verticalOverflow = VerticalWrapMode.Truncate;
            labelText.text = label;

            return go;
        }

        // The "Add video" half button: a band like the others, but instead of a JukeboxButton it carries an always-active
        // (but invisible) VRCUrlInputField + an UrlBox that focuses it on Use to pop VRChat's keyboard. The field's
        // OnEndEdit is wired to the queue later. Returns its GameObject and out the field.
        static GameObject BuildAddButton(Transform panel, float yTop, bool leftHalf, Font font, Jukebox udon, out VRCUrlInputField field)
        {
            GameObject go = BuildBandButton(panel, yTop, leftHalf, CtrlH, "▶ Add video", new Color(0.20f, 0.40f, 0.28f, 0.95f), font, out _);

            // An invisible URL field stretched over the band: the components must exist + be active for ActivateInputField to
            // pop the keyboard, but they're transparent so only the band shows. raycastTarget off so UrlBox's Interact
            // tooltip isn't suppressed by a UI graphic (the UrlBox keyboard-pop recipe).
            var fieldGO = NewUI("AddField", go.transform, out var fieldRt); Stretch(fieldRt);
            var fieldImg = fieldGO.AddComponent<Image>();
            fieldImg.color = new Color(0f, 0f, 0f, 0f); fieldImg.raycastTarget = false;

            var textGO = NewUI("Text", fieldRt, out var textRt); Stretch(textRt); Inset(textRt, 8f);
            var textComp = textGO.AddComponent<Text>();
            textComp.font = font; textComp.fontSize = 22; textComp.color = new Color(0f, 0f, 0f, 0f); textComp.raycastTarget = false;
            textComp.alignment = TextAnchor.MiddleLeft; textComp.supportRichText = false;
            textComp.horizontalOverflow = HorizontalWrapMode.Overflow; textComp.verticalOverflow = VerticalWrapMode.Truncate;

            var phGO = NewUI("Placeholder", fieldRt, out var phRt); Stretch(phRt); Inset(phRt, 8f);
            var ph = phGO.AddComponent<Text>();
            ph.font = font; ph.fontSize = 22; ph.text = ""; ph.color = new Color(0f, 0f, 0f, 0f); ph.raycastTarget = false;
            ph.alignment = TextAnchor.MiddleLeft; ph.supportRichText = false;

            field = fieldGO.AddComponent<VRCUrlInputField>();
            VRCUrlInputField boxField = field;   // local copy: an `out` param can't be captured by the lambda below (CS1628)
            var so = new SerializedObject(field);
            SetObj(so, "m_TargetGraphic", fieldImg);
            SetObj(so, "m_TextComponent", textComp);
            SetObj(so, "m_Placeholder", ph);
            SetString(so, "m_Text", "");
            SetInt(so, "m_CharacterLimit", 0);
            SetBool(so, "m_Interactable", true);
            SetBool(so, "AllowSendingOnEndEdit", true);
            so.ApplyModifiedProperties();

            var box = UdonTools.AddConfigured<UrlBox>(go, x => { x.urlField = boxField; });
            var pso = new SerializedObject(UdonSharpEditorUtility.GetBackingUdonBehaviour(box));
            var itp = pso.FindProperty("interactText"); if (itp != null) itp.stringValue = "Add video to the queue";
            var pxp = pso.FindProperty("proximity"); if (pxp != null) pxp.floatValue = 4f;
            pso.ApplyModifiedProperties();

            return go;
        }

        // One queue ROW: a faint band + a left-padded Label the queue fills (rank + URL + who), and a small [x] remove button
        // at the right edge (its own BoxCollider; the queue SetActive()s it only for who may remove that item). Returns the row
        // GameObject (for SetActive), out its Label, and out the remove button GameObject (for the JukeboxButton + show/hide).
        static GameObject BuildQueueRow(Transform panel, float yTop, Font font, out Text label, out GameObject removeGo)
        {
            float wRow = CanvasW - 2f * Pad;
            var rowGO = NewUI("QueueRow", panel, out var rowRt);
            rowRt.anchorMin = new Vector2(0f, 1f); rowRt.anchorMax = new Vector2(0f, 1f); rowRt.pivot = new Vector2(0f, 1f);
            rowRt.anchoredPosition = new Vector2(Pad, yTop);
            rowRt.sizeDelta = new Vector2(wRow, RowH);

            var hitGO = NewUI("Band", rowRt, out var hitRt); Stretch(hitRt); Inset(hitRt, 3f);
            var hitImg = hitGO.AddComponent<Image>();
            hitImg.color = new Color(1f, 1f, 1f, 0.06f); hitImg.raycastTarget = false;

            var labGO = NewUI("Label", rowRt, out var labRt);
            labRt.anchorMin = new Vector2(0f, 0f); labRt.anchorMax = new Vector2(1f, 1f);
            labRt.offsetMin = new Vector2(20f, 0f); labRt.offsetMax = new Vector2(-(RowH + 8f), 0f);   // leave room for the [x] at the right
            label = labGO.AddComponent<Text>();
            label.font = font; label.fontSize = 28; label.color = Color.white;
            label.alignment = TextAnchor.MiddleLeft; label.raycastTarget = false; label.supportRichText = false;
            label.horizontalOverflow = HorizontalWrapMode.Wrap; label.verticalOverflow = VerticalWrapMode.Truncate;
            label.text = "";

            // The [x] remove button: a square band at the right edge with its own collider.
            float btn = RowH - 16f;
            removeGo = NewUI("Remove", rowRt, out var rmRt);
            rmRt.anchorMin = new Vector2(1f, 0.5f); rmRt.anchorMax = new Vector2(1f, 0.5f); rmRt.pivot = new Vector2(1f, 0.5f);
            rmRt.anchoredPosition = new Vector2(-4f, 0f); rmRt.sizeDelta = new Vector2(btn, btn);
            var rmCol = removeGo.AddComponent<BoxCollider>();
            rmCol.size = new Vector3(btn, btn, 40f);
            rmCol.center = new Vector3(-btn * 0.5f, 0f, 0f);
            var rmBand = NewUI("Band", rmRt, out var rmBandRt); Stretch(rmBandRt);
            var rmImg = rmBand.AddComponent<Image>();
            rmImg.color = new Color(0.55f, 0.18f, 0.20f, 0.95f); rmImg.raycastTarget = true;
            var rmLabGO = NewUI("X", rmRt, out var rmLabRt); Stretch(rmLabRt);
            var rmLab = rmLabGO.AddComponent<Text>();
            rmLab.font = font; rmLab.fontSize = 30; rmLab.fontStyle = FontStyle.Bold; rmLab.color = Color.white;
            rmLab.alignment = TextAnchor.MiddleCenter; rmLab.raycastTarget = false; rmLab.supportRichText = false;
            rmLab.text = "✕";
            // Visibility is owned by the queue's RebuildUI (it SetActive()s this only on rows the local client may remove);
            // it runs in Start, so an empty/again-non-removable row is hidden before anyone sees it in-world.

            return rowGO;
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
        static void SetObj(SerializedObject so, string name, Object v) { var p = so.FindProperty(name); if (p != null) p.objectReferenceValue = v; }
        static void SetBool(SerializedObject so, string name, bool v) { var p = so.FindProperty(name); if (p != null) p.boolValue = v; }
        static void SetInt(SerializedObject so, string name, int v) { var p = so.FindProperty(name); if (p != null) p.intValue = v; }
        static void SetString(SerializedObject so, string name, string v) { var p = so.FindProperty(name); if (p != null) p.stringValue = v; }

        static Material LoadOrCreatePoleMaterial()
        {
            var existing = AssetDatabase.LoadAssetAtPath<Material>(PoleMatPath);
            if (existing != null) return existing;
            var sh = Shader.Find("Standard");
            if (sh == null) return null;
            var mat = new Material(sh) { name = "JukeboxPole", color = new Color(0.18f, 0.14f, 0.22f) };
            mat.EnableKeyword("_EMISSION");
            mat.SetColor("_EmissionColor", new Color(0.18f, 0.08f, 0.22f));
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
