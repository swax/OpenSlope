using System.Numerics;
using Snowknife.Engine;

namespace Snowknife.Bundle;

/// <summary>Preserve per-instance lifecycle commands outside the specialized break/pickup paths.</summary>
public static class EffectLifecycleBundle
{
    public static BundleManifest.EffectLifecycleInfo? Build(string levelDir, List<SsxInstance> instances,
        HashSet<int> specialized)
    {
        var root = SsfLogic.Load(levelDir);
        if (root?.EffectSlots == null) return null;
        var info = new BundleManifest.EffectLifecycleInfo();
        for (int i = 0; i < instances.Count; i++)
        {
            int slot = instances[i].EffectSlotIndex;
            if (slot < 0 || slot >= root.EffectSlots.Length) continue;
            var commands = EffectTimeline.Read(root, root.EffectSlots[slot].CollisionEffectSlot, i);
            var actions = commands.Where(c => c.Target >= 0 && c.Target < instances.Count
                && c.Node.MainType == SsfMainType.Property
                && c.Node.type0 is { SubType: SsfType0Sub.DeadNode, DeadNodeMode: >= 0 and <= 4 }
                && (!specialized.Contains(c.Target) || c.Node.type0.DeadNodeMode <= 1 || c.Node.type0.DeadNodeMode == 3))
                .Select(c => new BundleManifest.EffectActionInfo { Target = c.Target, Delay = c.Delay,
                    Mode = c.Node.type0!.DeadNodeMode }).ToList();
            // A hidden trigger killing only itself has no visual/installed receiver to retire here.
            if (actions.Count == 0 || actions.All(a => a.Target == i && a.Mode >= 2 && !instances[i].Visable)) continue;
            info.Triggers.Add(new BundleManifest.EffectTriggerInfo { Index = i, Name = instances[i].InstanceName ?? "",
                Actions = actions, OneShot = commands.Any(c => c.Target == i && c.Node.MainType == SsfMainType.Property
                    && c.Node.type0 is { SubType: SsfType0Sub.DeadNode, DeadNodeMode: >= 2 and <= 4 }) });
        }
        if (info.Triggers.Count == 0) return null;
        var bounds = ParticleBundle.WalkPropsGroups(levelDir, i => info.Triggers.Any(t => t.Index == i));
        foreach (var trigger in info.Triggers)
        {
            (trigger.Center, trigger.Size) = Bounds(instances[trigger.Index], bounds.GetValueOrDefault(trigger.Index));
        }
        info.Targets = info.Triggers.SelectMany(t => t.Actions).Select(a => a.Target).Distinct().Order()
            .Select(i => new BundleManifest.EffectTargetInfo { Index = i, Name = instances[i].InstanceName ?? "" }).ToList();
        return info;
    }

    internal static (float[] center, float[] size) Bounds(SsxInstance instance, List<Vector3>? vertices)
    {
        if (vertices == null || vertices.Count == 0)
            return (BundleSpace.Xyz(BundleSpace.MeshPt(instance.Location)), new[] { 400f, 400f, 400f });
        Vector3 min = vertices[0], max = min;
        foreach (var p in vertices) { min = Vector3.Min(min, p); max = Vector3.Max(max, p); }
        return (BundleSpace.Xyz((min + max) * .5f), BundleSpace.Xyz(max - min));
    }
}
