using System.Numerics;
using Snowknife.Engine;

namespace Snowknife.Bundle;

/// <summary>
/// The SSX MainType-25 rail TOGGLES (spec 350-rails, Unity docs/026): a collision trigger whose effect promotes a spline
/// to a grind candidate when it fires. PathBundle bakes those splines as rails but marks them <c>Rails.Gated</c>
/// (start not grindable); here we find, per toggle, the TRIGGER VOLUME that enables it and which rail-network
/// indices it turns on, so the importer can overlay a trigger carrying RailGate.
///
/// Data-derived (no name match): for each SSF effect header carrying a MainType-25 ENABLE (Spline.Effect != 0), the
/// trigger volume is the instance whose EffectSlot's CollisionEffectSlot is that header (the ride-through volume that
/// fires the chain); its box comes from its Props.obj geometry (like the firework/teleport triggers). A level may
/// author such a pair - e.g. a fallen-tree trunk enabled by the same header + trigger that fells the
/// tree, so the gate fires alongside the tree-fall AnimDelta. Most levels author none.
/// </summary>
public static class RailGateBundle
{
    public static BundleManifest.RailGatesInfo? Build(string levelDir, Dictionary<int, int> splineToRail)
    {
        if (splineToRail.Count == 0) return null;   // no rails emitted, or no toggle mapping - nothing to gate
        var instances = SsxInstances.Load(levelDir);
        if (instances == null) return null;

        var root = SsfLogic.Load(levelDir);
        if (root?.EffectSlots == null || root.EffectHeaders == null) return null;

        // header index -> the rail-network indices its MainType-25 enables turn on (only splines that became rails).
        var railsByHeader = new Dictionary<int, List<int>>();
        for (int h = 0; h < root.EffectHeaders.Length; h++)
        {
            var effs = root.EffectHeaders[h].Effects;
            if (effs == null) continue;
            foreach (var e in effs)
            {
                if (e == null || e.MainType != SsfMainType.ToggleRail || e.Spline == null || e.Spline.Effect == 0) continue;
                if (!splineToRail.TryGetValue(e.Spline.SplineIndex, out int rail)) continue;   // enabled a spline that isn't a baked rail - skip
                if (!railsByHeader.TryGetValue(h, out var list)) { list = new List<int>(); railsByHeader[h] = list; }
                if (!list.Contains(rail)) list.Add(rail);
            }
        }
        if (railsByHeader.Count == 0) return null;

        // trigger instance = the one whose EffectSlot's CollisionEffectSlot is a MainType-25 header. Collect the box
        // verts for all such triggers in one Props.obj pass, then AABB them.
        var triggerHeader = new Dictionary<int, int>();   // instance -> the header it fires
        for (int i = 0; i < instances.Count; i++)
        {
            int e = instances[i].EffectSlotIndex;
            if (e < 0 || e >= root.EffectSlots.Length) continue;
            int ce = root.EffectSlots[e].CollisionEffectSlot;
            if (ce >= 0 && railsByHeader.ContainsKey(ce)) triggerHeader[i] = ce;
        }
        if (triggerHeader.Count == 0) return null;

        var groups = ParticleBundle.WalkPropsGroups(levelDir, triggerHeader.ContainsKey);

        var info = new BundleManifest.RailGatesInfo();
        foreach (var (inst, header) in triggerHeader.OrderBy(kv => kv.Key))
        {
            var it = instances[inst];
            Vector3 center, size;
            if (groups.TryGetValue(inst, out var verts) && verts.Count > 0)
            {
                Vector3 min = verts[0], max = verts[0];
                foreach (var p in verts) { min = Vector3.Min(min, p); max = Vector3.Max(max, p); }
                center = (min + max) * 0.5f;
                size = max - min;
            }
            else
            {
                center = BundleSpace.MeshPt(it.Location);   // invisible marker with no drawn box: a small volume at the pivot
                size = new Vector3(400f, 400f, 400f);
            }

            info.Gates.Add(new BundleManifest.RailGateInfo
            {
                Index = inst, Name = it.InstanceName ?? "",
                Center = BundleSpace.Xyz(center), Size = BundleSpace.Xyz(size),
                Rails = railsByHeader[header].ToArray(),
            });
        }
        if (info.Gates.Count == 0) return null;
        Log.Info($"  Rail gates: {info.Gates.Count} MainType-25 toggle trigger(s) " +
                          $"({info.Gates.Sum(g => g.Rails.Length)} gated rail(s)).");
        return info;
    }
}
