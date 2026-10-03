using Newtonsoft.Json.Linq;
using Snowknife.Bundle;
using Snowknife.Engine;
using static Snowknife.Tests.Bundle.EffectsFixture;

namespace Snowknife.Tests.Bundle;

public class EffectLifecycleTests
{
    static JObject Wait(float seconds) => Node(SsfMainType.Wait, new JObject { ["WaitTime"] = seconds });
    static JArray Slots() => new(new JObject { ["id"] = "slot0", ["circumstances"] = new JObject { ["collision"] = "hit" } });

    [Fact]
    public void CallsKeepTheirOwnWaitClockAndRepeatedRailChangesRemainOrdered()
    {
        var doc = Document(instances: new JArray(Row("host", 0), Row("target", 1)),
            splines: new JArray(Row("rail", 0)),
            graphs: new JArray(Graph("hit", 0, Wait(1), ActOnInstance("target", "child"), Wait(2.56f), ToggleRail("rail", 1)),
                Graph("child", 1, Wait(.5f), DeadNode(3), Node(SsfMainType.CallFunction, references: new JObject { ["function"] = "fn" }))),
            functions: new JArray(Function("fn", 0, "RailOff", Wait(.25f), ToggleRail("rail", 0))));
        var commands = EffectTimeline.Read(SsfLogic.FromEffectsDocument(doc)!, 0, 0);
        Assert.Equal(new[] { 1, 1, 0 }, commands.Select(c => c.Target));
        Assert.Equal(1.5f, commands[0].Delay, 4);
        Assert.Equal(1.75f, commands[1].Delay, 4);
        Assert.Equal(3.56f, commands[2].Delay, 4);
        Assert.Equal(0, commands[1].Node.Spline!.Effect);
        Assert.Equal(1, commands[2].Node.Spline!.Effect);
    }

    [Fact]
    public void ConditionalTailsAreNotBakedAsUnconditionalKillsAndCyclesTerminate()
    {
        var doc = Document(instances: new JArray(Row("host", 0)),
            graphs: new JArray(Graph("hit", 0, ActOnInstance("host", "hit"), DeadNode(0),
                Node(SsfMainType.ConditionalGate), DeadNode(3))));
        var commands = EffectTimeline.Read(SsfLogic.FromEffectsDocument(doc)!, 0, 0);
        Assert.Single(commands);
        Assert.Equal(0, commands[0].Node.type0!.DeadNodeMode);
    }

    [Theory]
    [InlineData(0)] [InlineData(1)] [InlineData(2)] [InlineData(3)] [InlineData(4)]
    public void ASeparateTriggerPreservesTargetAndLifecycleMode(int mode)
    {
        using var temp = new TempDir();
        var doc = Document(slots: Slots(), instances: new JArray(Row("host", 0), Row("pot", 1)),
            graphs: new JArray(Graph("hit", 0, DeadNode(2), Wait(.25f), ActOnInstance("pot", "stop")), Graph("stop", 1, DeadNode(mode))));
        var instances = new List<SsxInstance> { new() { EffectSlotIndex = 0 }, new() { Visable = true } };
        var result = EffectLifecycleBundle.Build(WriteLevel(temp, doc), instances, new());
        var trigger = Assert.Single(result!.Triggers);
        Assert.True(trigger.OneShot);
        var action = Assert.Single(trigger.Actions, a => a.Target == 1);
        Assert.Equal(mode, action.Mode); Assert.Equal(.25f, action.Delay);
        Assert.Contains(result.Targets, t => t.Index == 1);
    }

    [Fact]
    public void SpecializedBreakTargetsAreNotHiddenTwiceButFlaggedKillsStillReachDetachedWork()
    {
        using var temp = new TempDir();
        var doc = Document(slots: Slots(), instances: new JArray(Row("host", 0), Row("glass", 1)),
            graphs: new JArray(Graph("hit", 0, ActOnInstance("glass", "stop")), Graph("stop", 1, DeadNode(2), DeadNode(3))));
        var result = EffectLifecycleBundle.Build(WriteLevel(temp, doc),
            new List<SsxInstance> { new() { EffectSlotIndex = 0 }, new() { Visable = true } }, new() { 1 });
        Assert.Equal(3, Assert.Single(Assert.Single(result!.Triggers).Actions).Mode);
    }

    [Fact]
    public void GlassWithAThrownTwinKeepsItsAuthoredImpactDelay()
    {
        using var temp = new TempDir();
        var doc = Document(slots: Slots(), instances: new JArray(Row("host", 0), Row("shards", 1)),
            graphs: new JArray(Graph("hit", 0, Wait(.05f), DeadNode(2), ActOnInstance("shards", "throw")),
                Graph("throw", 1, Node(SsfMainType.Property, new JObject { ["type0"] = new JObject { ["SubType"] = 20 } }))));
        var map = BreakableClassifier.Build(WriteLevel(temp, doc), new List<SsxInstance>
            { new() { EffectSlotIndex = 0, Visable = true, PlayerCollision = true }, new() { Visable = false } }, out _);
        Assert.Equal(.05f, map[0].BreakDelay);
        Assert.Equal("broken", map[1].Role);
    }
}
