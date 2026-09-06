#if UNITY_EDITOR
using UnityEngine;
using UnityEngine.UI;

namespace OpenSlope.Importer
{

    // Builds platform-neutral trigger boxes and a stock world-space Canvas for SSF MainType-12 Show message nodes.
    // The display lives under OpenSlope_Map at identity (it follows a player in world space); the trigger boxes live under
    // Level so the normal SSX scale/orientation/recenter transform places them over their owning collision instances.
    public sealed class HudMessageBuilder
    {
        readonly ImportConfig _cfg;
        public HudMessageBuilder(ImportConfig cfg) { _cfg = cfg; }

        public void Build(Transform level)
        {
            var oldTriggers = level.Find("HudMessages");
            if (oldTriggers != null) Object.DestroyImmediate(oldTriggers.gameObject);
            Transform mapRoot = level.parent != null ? level.parent : level;
            var oldDisplay = mapRoot.Find("HudMessageDisplay");
            if (oldDisplay != null) Object.DestroyImmediate(oldDisplay.gameObject);

            var reader = new BundleManifestReader(_cfg);
            if (!reader.Exists || reader.HudMessages.Count == 0) return;

            GameObject display = BuildDisplay(mapRoot);
            var triggerRoot = new GameObject("HudMessages");
            triggerRoot.transform.SetParent(level, false);

            int sequence = 0;
            foreach (var rec in reader.HudMessages)
            {
                var go = new GameObject($"HudMessage_{rec.Index}_{sequence++}_{SafeName(rec.Name)}");
                go.transform.SetParent(triggerRoot.transform, false);
                go.transform.localPosition = rec.Center;
                var box = go.AddComponent<BoxCollider>();
                box.center = Vector3.zero;
                box.size = rec.Size + Vector3.one * 10f; // five centimetres per face after the Level's 0.01 scale
                box.isTrigger = true;

                var marker = go.AddComponent<HudMessageMarker>();
                marker.Message = rec.Text ?? "";
                marker.MessageColor = rec.Color;
                marker.Duration = rec.Duration > 0f ? rec.Duration : 2.5f;
                marker.Delay = Mathf.Max(0f, rec.Delay);
                marker.displayObject = display;
                marker.EffectSlotIndex = rec.Slot;
            }
            Debug.Log($"OpenSlope: HUD messages -> {reader.HudMessages.Count} local collision-triggered banner(s).");
        }

        static GameObject BuildDisplay(Transform mapRoot)
        {
            var go = new GameObject("HudMessageDisplay");
            go.transform.SetParent(mapRoot, false);

            var panel = new GameObject("Panel", typeof(RectTransform), typeof(Canvas), typeof(CanvasGroup), typeof(Image));
            panel.transform.SetParent(go.transform, false);
            var canvas = panel.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.WorldSpace;
            canvas.sortingOrder = 100;
            var rt = panel.GetComponent<RectTransform>();
            rt.sizeDelta = new Vector2(900f, 180f);
            rt.localScale = Vector3.one * 0.00125f;
            var background = panel.GetComponent<Image>();
            background.color = new Color(0.025f, 0.04f, 0.07f, 0.76f);
            background.raycastTarget = false;

            var textGo = new GameObject("Text", typeof(RectTransform), typeof(Text), typeof(Outline));
            var textRt = textGo.GetComponent<RectTransform>();
            textRt.SetParent(rt, false);
            textRt.anchorMin = Vector2.zero; textRt.anchorMax = Vector2.one;
            textRt.offsetMin = new Vector2(28f, 18f); textRt.offsetMax = new Vector2(-28f, -18f);
            var text = textGo.GetComponent<Text>();
            text.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf")
                     ?? Resources.GetBuiltinResource<Font>("Arial.ttf");
            text.fontSize = 70;
            text.fontStyle = FontStyle.Bold;
            text.alignment = TextAnchor.MiddleCenter;
            text.horizontalOverflow = HorizontalWrapMode.Wrap;
            text.verticalOverflow = VerticalWrapMode.Truncate;
            text.raycastTarget = false;
            text.color = Color.white;
            var outline = textGo.GetComponent<Outline>();
            outline.effectColor = new Color(0f, 0f, 0f, 0.95f);
            outline.effectDistance = new Vector2(3f, 3f);

            var marker = go.AddComponent<HudMessageDisplayMarker>();
            marker.panel = panel;
            marker.messageText = text;
            panel.SetActive(false);
            return go;
        }

        static string SafeName(string name)
        {
            if (string.IsNullOrEmpty(name)) return "Trigger";
            return name.Replace('/', '_').Replace('\\', '_').Replace(':', '_');
        }
    }
}
#endif
