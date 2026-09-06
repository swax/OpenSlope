using SSX_Library.FileHandlers.LevelFiles.Tricky.PS2;
using Snowknife.Services;

namespace Snowknife.Tests.Services;

public sealed class EffectsSalvageTests
{
    [Fact]
    public void NeutralizesOnlyDanglingNodeTargets()
    {
        var nodes = new List<SSFHandler.Effect>
        {
            InstanceNode(instance: 0, graph: 0),
            InstanceNode(instance: 8, graph: 0),
            InstanceNode(instance: 0, graph: 9),
            new() { MainType = 21, FunctionRunIndex = 7 },
            new() { MainType = 24, TeleportInstanceIndex = 6 },
            new() { MainType = 25, Spline = new SSFHandler.SplineEffect { SplineIndex = 4 } },
            new()
            {
                MainType = 2,
                type2 = new SSFHandler.Type2
                {
                    SubType = 1,
                    SplineAnimation = new SSFHandler.SplinePathAnimation { SplineIndex = 5 },
                },
            },
        };
        var functionNodes = new List<SSFHandler.Effect> { InstanceNode(instance: 3, graph: 0) };
        var handler = new SSFHandler
        {
            EffectHeaders = new List<SSFHandler.EffectHeaderStruct>
            {
                new() { Effects = nodes, EffectCount = nodes.Count },
            },
            Functions = new List<SSFHandler.Function>
            {
                new() { Effects = functionNodes, Count = functionNodes.Count, FunctionName = "test" },
            },
            InstanceState = new List<int> { 0 },
            Splines = new List<SSFHandler.Spline> { new() },
        };

        IReadOnlyList<string> repaired = EffectsDocumentService.NeutralizeDanglingNodeReferences(handler);

        Assert.Equal(7, repaired.Count);
        Assert.Equal(0, nodes[0].Instance?.InstanceIndex);
        Assert.Equal(0, nodes[0].Instance?.EffectIndex);
        Assert.Equal(-1, nodes[1].Instance?.InstanceIndex);
        Assert.Equal(-1, nodes[2].Instance?.EffectIndex);
        Assert.Equal(-1, nodes[3].FunctionRunIndex);
        Assert.Equal(-1, nodes[4].TeleportInstanceIndex);
        Assert.Equal(-1, nodes[5].Spline?.SplineIndex);
        Assert.Equal(-1, nodes[6].type2?.SplineAnimation?.SplineIndex);
        Assert.Equal(-1, functionNodes[0].Instance?.InstanceIndex);
    }

    private static SSFHandler.Effect InstanceNode(int instance, int graph) => new()
    {
        MainType = 7,
        Instance = new SSFHandler.InstanceEffect { InstanceIndex = instance, EffectIndex = graph },
    };
}
