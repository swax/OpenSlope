using Newtonsoft.Json.Linq;
using Snowknife.Bundle;
using Snowknife.Engine;
using static Snowknife.Tests.Bundle.EffectsFixture;

namespace Snowknife.Tests.Bundle;

public class CollisionEmitterBundleTests
{
    static int Bits(float value) => BitConverter.SingleToInt32Bits(value);

    // UNTRACK Effect 10, expressed semantically and converted back to the raw integer words its legacy
    // Type2Sub2 decoder writes to Effects.json. Keeping the recognizable values here catches numeric casts:
    // 1128792064 must become 200.0f, never a two-billion-unit particle.
    static JObject SnowGhostPayload()
    {
        var raw = new JObject();
        for (int i = 0; i <= 50; i++) raw[$"U{i}"] = 0;
        raw["U0"] = 50;
        raw["U1"] = 0;
        float[] values =
        {
            0.01f, 1f, 200f, 2f, 100f, 1f, 0.03f,
            33.3f, 1243f, -44f,
            0f, 0f, 500f, 500f, 0f, 0f,
            0f, 0f, 800f,
            0f, 0f, 150f, 800f, 0f, 0f, 0f, -800f, 0f,
            0f, 0f, 300f,
            0.04f, 0.74f, 0.84f, 0.97f,
            0f, 0f, 0f, 0.4f,
            0.1f, 0.1f, 0.1f, 0.1f,
            0f, 0f, 0f, 0f,
        };
        for (int i = 0; i < values.Length; i++) raw[$"U{i + 2}"] = Bits(values[i]);
        raw["U49"] = 2; // clod: the shared snow-burst sprite
        raw["U50"] = 0; // remaps to native additive blend mode 5

        return new JObject
        {
            ["type2"] = new JObject
            {
                ["SubType"] = (int)SsfType2Sub.CollisionEmitter,
                ["type2Sub2"] = raw,
            },
        };
    }

    [Fact]
    public void OneSharedCollisionEmitterSlotExportsAllThirtyFourSnowTrees()
    {
        using var temp = new TempDir();
        var effectInstances = new JArray();
        var properties = new JArray();
        var nativeInstances = new JArray();
        for (int i = 0; i < 34; i++)
        {
            string instanceId = $"instance:{i:D6}";
            string propertyId = $"property:{i:D4}";
            effectInstances.Add(new JObject
            {
                ["id"] = instanceId,
                ["originalIndex"] = i,
                ["property"] = propertyId,
            });
            properties.Add(new JObject
            {
                ["id"] = propertyId,
                ["references"] = new JObject { ["effectSlot"] = "slot:snow-ghost" },
            });
            nativeInstances.Add(new JObject
            {
                ["InstanceName"] = $"Mdl_Tree_SnowGhost_{2000 + i}",
                ["Location"] = new JArray(100f + i, 200f, 300f),
                ["Rotation"] = new JArray(0f, 0f, 0f, 1f),
                ["Scale"] = new JArray(1f, 1f, 1f),
                ["PlayerCollision"] = true,
                ["CollsionMode"] = NativeCollisionMode.BoundingBox,
            });
        }

        var slot = Row("slot:snow-ghost", 0);
        slot["circumstances"] = new JObject { ["collision"] = "graph:snow-ghost" };
        var doc = Document(
            slots: new JArray(slot),
            graphs: new JArray(Graph("graph:snow-ghost", 0,
                Node(SsfMainType.Emitter, SnowGhostPayload()))),
            instances: effectInstances,
            objectProperties: properties);
        WriteLevel(temp, doc);
        temp.Write("Instances.json", new JObject { ["Instances"] = nativeInstances }.ToString());

        var result = ParticleBundle.BuildAmbientEmitters(temp.Path);

        Assert.NotNull(result);
        Assert.Equal(34, result!.Emitters.Count);
        Assert.Equal(Enumerable.Range(0, 34), result.Emitters.Select(e => e.Index));
        Assert.All(result.Emitters, e =>
        {
            Assert.True(e.Repeatable);
            Assert.True(e.ContactDriven);
            Assert.Equal(0.5f, e.MinInterval);
            Assert.Single(e.Layers);
        });

        var first = result.Emitters[0];
        var layer = first.Layers[0];
        Assert.Equal(new[] { -100f, 200f, 300f }, first.Muzzle);
        Assert.Equal(first.Muzzle, first.TriggerCenter); // no Props.obj in the fixture: documented fallback
        Assert.Equal(new[] { 800f, 800f, 800f }, first.TriggerSize);
        Assert.Equal(50, layer.ParticleCount);
        Assert.Equal(0.01f, layer.EmissionWindow);
        Assert.Equal(1f, layer.TimeScale);
        Assert.Equal(200f, layer.SizeCenter);
        Assert.Equal(2f, layer.ParticleLifeCenter);
        Assert.Equal(new[] { -133.3f, 1443f, 256f }, layer.Origin);
        Assert.Equal(new[] { 0f, 0f, 500f }, layer.SpawnAxisA);
        Assert.Equal(new[] { -500f, 0f, 0f }, layer.SpawnAxisB);
        Assert.Equal(new[] { 0f, 0f, 800f }, layer.VelocityBase);
        Assert.Equal(new[] { 0f, 0f, 300f }, layer.Gravity);
        Assert.Equal(new[] { 0.74f, 0.84f, 0.97f, 0.04f }, layer.ColorStops[0]);
        Assert.Equal(2, layer.SpriteIndex);
        Assert.Equal(5, layer.BlendMode);
    }
}
