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

        var commandsByInstance = new Dictionary<int, List<EffectTimeline.Command>>();
        for (int i = 0; i < instances.Count; i++)
        {
            int slot = instances[i].EffectSlotIndex;
            if (slot < 0 || slot >= root.EffectSlots.Length) continue;
            var commands = EffectTimeline.Read(root, root.EffectSlots[slot].CollisionEffectSlot, i)
                .Where(c => c.Node.MainType == SsfMainType.ToggleRail && c.Node.Spline != null
                    && splineToRail.ContainsKey(c.Node.Spline.SplineIndex)).ToList();
            if (commands.Count > 0) commandsByInstance[i] = commands;
        }
        if (commandsByInstance.Count == 0) return null;

        var groups = ParticleBundle.WalkPropsGroups(levelDir, commandsByInstance.ContainsKey);

        var info = new BundleManifest.RailGatesInfo();
        foreach (var (inst, commands) in commandsByInstance.OrderBy(kv => kv.Key))
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
                Rails = commands.Select(c => splineToRail[c.Node.Spline!.SplineIndex]).ToArray(),
                Delays = commands.Select(c => c.Delay).ToArray(),
                Enabled = commands.Select(c => c.Node.Spline!.Effect != 0).ToArray(),
            });
        }
        if (info.Gates.Count == 0) return null;
        Log.Info($"  Rail gates: {info.Gates.Count} MainType-25 toggle trigger(s) " +
                          $"({info.Gates.Sum(g => g.Rails.Length)} gated rail(s)).");
        return info;
    }
}
