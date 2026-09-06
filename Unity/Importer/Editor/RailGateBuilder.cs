#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Emits SSX's MainType-25 rail TOGGLES as Unity trigger volumes that make a gated grind rail grindable (spec
    // 350-rails, docs/026). A few splines aren't grindable until an effect chain runs;
    // A level may do it once - e.g. two Spline_FallenTree_* rails turn on after the tree's fall sequence. snowknife bakes those
    // rails into the rail network but marks them start-disabled (Paths.Rails.Gated), and records each toggle's trigger
    // volume + which rail indices it enables (manifest.RailGates).
    //
    // Here we overlay each toggle's trigger volume with an invisible BoxCollider(isTrigger) - like the firework / teleport
    // triggers - carrying a RailGateMarker naming the grind rail network + the rail indices to enable. The platform
    // wiring pass realizes the runtime gate behaviour and resolves the network reference. Crossing it turns those rails on
    // for everyone. The volume sits where the SSX trigger fires (up-course of the fallen tree, the same box that fells it),
    // so a rider crosses it before reaching the log - exactly when the log becomes grindable.
    public class RailGateBuilder
    {
        readonly ImportConfig _cfg;
        public RailGateBuilder(ImportConfig cfg) { _cfg = cfg; }

        public void Build(Transform root)
        {
            if (!_cfg.EmitRailGates) return;

            var old = root.Find("RailGates"); if (old != null) Object.DestroyImmediate(old.gameObject);

            var reader = new BundleManifestReader(_cfg);
            if (!reader.Exists || reader.RailGates.Count == 0) return;   // no bundle / level has no rail toggles

            // The grind rail network the gates enable (the "Rails" node, not the "CoursePath" one). Built by RailBuilder
            // before this runs; search the scene so it's found whether it sits under Level (import) or the root (refresh).
            GameObject netObj = FindGrindNetworkObject();
            if (netObj == null)
            {
                Debug.LogWarning("OpenSlope: rail gates skipped - no grind rail network found (build rails first).");
                return;
            }

            var gateRoot = new GameObject("RailGates");
            gateRoot.transform.SetParent(root, false);

            int made = 0, wired = 0;
            foreach (var g in reader.RailGates)
            {
                var go = new GameObject($"RailGate_{g.Index}_{g.Name}");
                go.transform.SetParent(gateRoot.transform, false);
                go.transform.localPosition = g.Center;

                var box = go.AddComponent<BoxCollider>();
                box.center = Vector3.zero;
                box.size = g.Size + Vector3.one * (2f * _cfg.RailGateTriggerInflate);
                box.isTrigger = true;

                var mk = go.AddComponent<RailGateMarker>();
                mk.railNetworkObject = netObj;
                mk.rails             = g.Rails;
                mk.Cooldown          = _cfg.RailGateCooldown;
                made++;
                wired += g.Rails != null ? g.Rails.Length : 0;
            }

            Debug.Log($"OpenSlope: rail gates -> {made} MainType-25 toggle trigger(s) under RailGates, enabling {wired} gated rail(s) " +
                      "on cross. Each tagged with RailGateMarker for the platform wiring pass.");
        }

        // The grind-rail network object (the "Rails" node), distinct from the CoursePath node. Match by GameObject name
        // so it works whether rails sit under OpenSlope_Map/Level (during import) or re-exposed at OpenSlope_Map (via Refresh). The
        // rail data lives on a RailMarker until the wiring pass realizes it, so match the marker's object.
        static GameObject FindGrindNetworkObject()
        {
            var markers = Object.FindObjectsOfType<RailMarker>();
            foreach (var m in markers)
            {
                string nm = m.gameObject.name;
                if (nm == "Rails" || nm == "OpenSlope_Rails") return m.gameObject;
            }
            // Fallback: the one that isn't the course path (the course marker carries DistToFinish, the rails don't).
            foreach (var m in markers)
                if (!m.gameObject.name.Contains("Course")) return m.gameObject;
            return null;
        }
    }
}
#endif
