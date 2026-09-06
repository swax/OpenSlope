using Newtonsoft.Json.Linq;
using Snowknife.Bundle;
using Snowknife.Engine;
using static Snowknife.Tests.Bundle.EffectsFixture;

namespace Snowknife.Tests.Bundle;

public class HudMessageBundleTests
{
    [Fact]
    public void CollisionHudTextBakesAsATimedTriggerForItsOwningInstance()
    {
        using var temp = new TempDir();
        var graph = Graph("collision", 0,
            Node(SsfMainType.Wait, new JObject { ["WaitTime"] = 1.25f }),
            Node(SsfMainType.HudText, new JObject
            {
                ["HudText"] = "  cell-hud-text  ", ["HudRed"] = 2f, ["HudGreen"] = .4f, ["HudBlue"] = -.2f,
            }));
        var slot = new JObject
        {
            ["id"] = "slot0",
            ["circumstances"] = new JObject { ["collision"] = "collision" },
        };
        temp.Write("Effects.json", Document(graphs: new JArray(graph), slots: new JArray(slot)).ToString());
        temp.Write("Instances.json", new JObject
        {
            ["Instances"] = new JArray(new JObject
            {
                ["InstanceName"] = "EffectTrigger_Hud", ["EffectSlotIndex"] = 0,
                ["Location"] = new JArray(100f, 200f, 300f),
            }),
        }.ToString());

        var result = ParticleBundle.BuildHudMessages(temp.Path);

        var message = Assert.Single(result!.Messages);
        Assert.Equal("cell-hud-text", message.Text);
        Assert.Equal(new[] { 1f, .4f, 0f }, message.Color);
        Assert.Equal(1.25f, message.Delay);
        Assert.Equal(2.5f, message.Duration);
        Assert.Equal(new[] { -100f, 200f, 300f }, message.Center);
        Assert.Equal(new[] { 400f, 400f, 400f }, message.Size);
        Assert.Equal(0, message.Slot);
    }

    [Fact]
    public void ALevelWithoutHudTextAddsNoManifestSection()
    {
        using var temp = new TempDir();
        temp.Write("Effects.json", Document().ToString());
        temp.Write("Instances.json", new JObject { ["Instances"] = new JArray() }.ToString());

        Assert.Null(ParticleBundle.BuildHudMessages(temp.Path));
    }
}
