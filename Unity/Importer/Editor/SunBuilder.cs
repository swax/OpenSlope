#if UNITY_EDITOR
using UnityEngine;
using UnityEditor;

namespace OpenSlope.Importer
{

    // Orients the scene's realtime Directional Light from the level's own authored sun (manifest.Sun, resolved
    // onto ImportConfig in For()). The terrain is lit by baked lightmaps; this aligns the one thing that's
    // NOT per-level otherwise - the realtime sun that shades moving avatars/board (and matches the props' +
    // probes' PropDirLightDir) - so a custom mountain, or a re-baked original level, lights from its own sun
    // instead of the hand-tuned default. No-op when the level didn't author a sun.
    public class SunBuilder
    {
        readonly ImportConfig _cfg;
        public SunBuilder(ImportConfig cfg) { _cfg = cfg; }

        public void Apply()
        {
            if (!_cfg.HasManifestSun) return;
            Light sun = null;
            foreach (var l in Object.FindObjectsOfType<Light>(true))
                if (l.type == LightType.Directional) { sun = l; break; }
            if (sun == null) { Debug.Log("OpenSlope: sun - no Directional Light in the scene to orient."); return; }

            // PropDirLightDir is the TO-LIGHT vector; the light shines along its negative (propagation).
            sun.transform.rotation = Quaternion.LookRotation(-_cfg.PropDirLightDir.normalized, Vector3.up);
            sun.color = _cfg.PropDirLightColor;
            EditorUtility.SetDirty(sun);
            Debug.Log($"OpenSlope: oriented '{sun.name}' to the level sun (to-light {_cfg.PropDirLightDir}, colour {_cfg.PropDirLightColor}).");
        }

        [MenuItem("OpenSlope/Refresh/Sun", false, 321)]
        public static void Menu() => new SunBuilder(ImportConfig.Current()).Apply();
        [MenuItem("OpenSlope/Refresh/Sun", true)]
        static bool MenuEnabled() => GameObject.Find(ImportConfig.Current().RootName) != null;
    }
}
#endif
