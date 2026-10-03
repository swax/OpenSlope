using Snowknife.Engine;

namespace Snowknife.Bundle;

/// <summary>Timed, unconditional collision-chain commands. Calls start a child chain at the caller's
/// current time; a child's wait does not stall its caller. Conditional tails cannot be baked as
/// unconditional actions. [Trailmap: 150-logic, 230-level-ssf]</summary>
internal static class EffectTimeline
{
    internal readonly record struct Command(int Target, float Delay, SsfNode Node);

    internal static List<Command> Read(SsfRoot root, int graph, int host)
    {
        var result = new List<Command>();
        var active = new HashSet<(bool function, int index, int host)>();
        void Walk(bool function, int index, int target, float at, int depth)
        {
            SsfHeader[]? table = function ? root.Functions : root.EffectHeaders;
            if (depth > 32 || table == null || index < 0 || index >= table.Length
                || !active.Add((function, index, target))) return;
            foreach (var node in table[index].Effects ?? Array.Empty<SsfNode>())
            {
                if (node.MainType == SsfMainType.ConditionalGate) break;
                if (node.MainType == SsfMainType.Wait) at += Math.Max(0, node.WaitTime);
                else if (node.MainType == SsfMainType.ActOnInstance && node.Instance is { } call)
                    Walk(false, call.EffectIndex, call.InstanceIndex, at, depth + 1);
                else if (node.MainType == SsfMainType.CallFunction)
                    Walk(true, node.FunctionRunIndex, target, at, depth + 1);
                else result.Add(new Command(target, at, node));
            }
            active.Remove((function, index, target));
        }
        Walk(false, graph, host, 0, 0);
        return result.OrderBy(c => c.Delay).ToList();
    }
}
