using Newtonsoft.Json.Linq;
using Snowknife.Bundle;
using Snowknife.Engine;
using static Snowknife.Tests.Bundle.EffectsFixture;

namespace Snowknife.Tests.Bundle;

/// <summary>
/// The normalizer that turns an <c>Effects.json</c> document back into the native-shaped model every gltf-time
/// bundler reads. It is documented as the exact inverse of the export over the DTO-visible surface, which
/// makes it the one place stable IDs become native indices — and a silent -1 here is a rail that never gets
/// gated or a breakable that never finds its twin, several systems downstream of the actual mistake.
/// </summary>
public class SsfLogicTests
{
    [Fact]
    public void StableReferencesResolveToTheOriginalNativeIndex()
    {
        // The whole point of originalIndex: an authored insertion earlier in the array must not shift what a
        // reference means.
        var doc = Document(
            splines: new JArray(Row("spline-a", 7), Row("spline-b", 3)),
            graphs: new JArray(Graph("g0", 0,
                Node(SsfMainType.ToggleRail,
                    payload: new JObject { ["Spline"] = new JObject { ["Effect"] = 0 } },
                    references: new JObject { ["spline"] = "spline-b" }))));

        var root = SsfLogic.FromEffectsDocument(doc);

        Assert.Equal(3, root!.EffectHeaders![0].Effects![0].Spline!.SplineIndex);
    }

    [Fact]
    public void AReferenceFallsBackToArrayPositionWhenNoOriginalIndexIsRecorded()
    {
        var doc = Document(
            splines: new JArray(Row("spline-a"), Row("spline-b")),
            graphs: new JArray(Graph("g0", 0,
                Node(SsfMainType.ToggleRail,
                    payload: new JObject { ["Spline"] = new JObject { ["Effect"] = 0 } },
                    references: new JObject { ["spline"] = "spline-b" }))));

        var root = SsfLogic.FromEffectsDocument(doc);

        Assert.Equal(1, root!.EffectHeaders![0].Effects![0].Spline!.SplineIndex);
    }

    [Fact]
    public void AnAbsentReferenceBecomesMinusOneRatherThanZero()
    {
        // -1 means "none". Defaulting to 0 would silently bind every unset reference to the first row.
        var doc = Document(
            instances: new JArray(Row("inst-a", 0)),
            graphs: new JArray(Graph("g0", 0,
                Node(SsfMainType.ActOnInstance, payload: new JObject { ["Instance"] = new JObject() }))));

        var root = SsfLogic.FromEffectsDocument(doc);

        var instance = root!.EffectHeaders![0].Effects![0].Instance!;
        Assert.Equal(-1, instance.InstanceIndex);
        Assert.Equal(-1, instance.EffectIndex);
    }

    [Fact]
    public void AReferenceToANameThatIsNotInTheTableBecomesMinusOne()
    {
        var doc = Document(
            splines: new JArray(Row("spline-a", 0)),
            graphs: new JArray(Graph("g0", 0,
                Node(SsfMainType.ToggleRail,
                    payload: new JObject { ["Spline"] = new JObject { ["Effect"] = 0 } },
                    references: new JObject { ["spline"] = "spline-does-not-exist" }))));

        var root = SsfLogic.FromEffectsDocument(doc);

        Assert.Equal(-1, root!.EffectHeaders![0].Effects![0].Spline!.SplineIndex);
    }

    [Fact]
    public void ACallFunctionNodeResolvesToItsFunctionIndex()
    {
        var doc = Document(
            functions: new JArray(Row("fn-a", 0), Row("fn-break", 4)),
            graphs: new JArray(Graph("g0", 0,
                Node(SsfMainType.CallFunction, references: new JObject { ["function"] = "fn-break" }))));

        var root = SsfLogic.FromEffectsDocument(doc);

        Assert.Equal(4, root!.EffectHeaders![0].Effects![0].FunctionRunIndex);
    }

    [Fact]
    public void ATeleportNodeResolvesToItsTargetInstance()
    {
        var doc = Document(
            instances: new JArray(Row("inst-a", 0), Row("inst-warp", 12)),
            graphs: new JArray(Graph("g0", 0,
                Node(SsfMainType.Teleport, references: new JObject { ["instance"] = "inst-warp" }))));

        var root = SsfLogic.FromEffectsDocument(doc);

        Assert.Equal(12, root!.EffectHeaders![0].Effects![0].TeleportInstanceIndex);
    }

    [Fact]
    public void UnionScalarsIrrelevantToTheNodesMainTypeAreStrippedBackToUnset()
    {
        // The payload serializes the native Effect struct as a superset-with-defaults: every union scalar is
        // present and zero-valued on every node. A zero SoundPlay left on a non-PlaySound node would read as
        // "play course-bank slot 0".
        var payload = new JObject
        {
            ["WaitTime"] = 5f,
            ["SoundPlay"] = 0,
            ["FunctionRunIndex"] = 0,
            ["TeleportInstanceIndex"] = 0,
        };
        var doc = Document(graphs: new JArray(Graph("g0", 0, Node(SsfMainType.Wait, payload))));

        var node = SsfLogic.FromEffectsDocument(doc)!.EffectHeaders![0].Effects![0];

        Assert.Equal(5f, node.WaitTime);              // kept: this IS a Wait node
        Assert.Equal(-1, node.SoundPlay);             // stripped back to "none"
        Assert.Equal(-1, node.FunctionRunIndex);
        Assert.Equal(-1, node.TeleportInstanceIndex);
    }

    [Fact]
    public void APlaySoundNodeKeepsItsCourseBankSlot()
    {
        var doc = Document(graphs: new JArray(Graph("g0", 0,
            Node(SsfMainType.PlaySound, new JObject { ["SoundPlay"] = 64 }))));

        Assert.Equal(64, SsfLogic.FromEffectsDocument(doc)!.EffectHeaders![0].Effects![0].SoundPlay);
    }

    [Fact]
    public void DeadNodeModeSurvivesOnlyOnADeadNode()
    {
        // DeadNodeMode 4 is what distinguishes a real break from a boost pad's Sub5/Dead2, so it must not
        // linger on a sub-type that never authored it.
        var dead = Document(graphs: new JArray(Graph("g0", 0, Node(SsfMainType.Property, new JObject
        {
            ["type0"] = new JObject { ["SubType"] = (int)SsfType0Sub.DeadNode, ["DeadNodeMode"] = 4 },
        }))));
        var flip = Document(graphs: new JArray(Graph("g0", 0, Node(SsfMainType.Property, new JObject
        {
            ["type0"] = new JObject { ["SubType"] = (int)SsfType0Sub.TextureFlip, ["DeadNodeMode"] = 4 },
        }))));

        Assert.Equal(4, SsfLogic.FromEffectsDocument(dead)!.EffectHeaders![0].Effects![0].type0!.DeadNodeMode);
        Assert.Equal(-1, SsfLogic.FromEffectsDocument(flip)!.EffectHeaders![0].Effects![0].type0!.DeadNodeMode);
    }

    [Fact]
    public void ABoostDirectionIsConvertedFromTheNativeVectorObjectToATriple()
    {
        // Native vectors serialize as {X,Y,Z}; the DTO reads [x,y,z]. Get this wrong and the boost pushes
        // along a null axis rather than the authored one.
        var doc = Document(graphs: new JArray(Graph("g0", 0, Node(SsfMainType.Property, new JObject
        {
            ["type0"] = new JObject
            {
                ["SubType"] = (int)SsfType0Sub.Boost,
                ["Boost"] = new JObject
                {
                    ["BoostAmount"] = 30f,
                    ["BoostDir"] = new JObject { ["X"] = 1f, ["Y"] = 2f, ["Z"] = 3f },
                },
            },
        }))));

        var boost = SsfLogic.FromEffectsDocument(doc)!.EffectHeaders![0].Effects![0].type0!.Boost!;

        Assert.Equal(new[] { 1f, 2f, 3f }, boost.BoostDir);
        Assert.Equal(30f, boost.BoostAmount);
    }

    [Fact]
    public void AnEffectSlotResolvesItsPersistentAndCollisionCircumstances()
    {
        var doc = Document(
            graphs: new JArray(Graph("g-persist", 2), Graph("g-collide", 5)),
            slots: new JArray(new JObject
            {
                ["id"] = "slot0",
                ["circumstances"] = new JObject { ["persistent"] = "g-persist", ["collision"] = "g-collide" },
            }));

        var slot = SsfLogic.FromEffectsDocument(doc)!.EffectSlots![0];

        Assert.Equal(2, slot.PersistantEffectSlot);
        Assert.Equal(5, slot.CollisionEffectSlot);
    }

    [Fact]
    public void ASlotWithNoCircumstancesBindsToNothing()
    {
        var doc = Document(graphs: new JArray(Graph("g0", 0)), slots: new JArray(new JObject { ["id"] = "slot0" }));

        var slot = SsfLogic.FromEffectsDocument(doc)!.EffectSlots![0];

        Assert.Equal(-1, slot.PersistantEffectSlot);
        Assert.Equal(-1, slot.CollisionEffectSlot);
    }

    [Fact]
    public void FunctionsKeepTheirNamesBecauseTheGatingLooksThemUpByName()
    {
        var doc = Document(functions: new JArray(
            Graph("fn0", 0, Node(SsfMainType.Wait, new JObject { ["WaitTime"] = 1f })),
            Graph("fn1", 1)));
        doc["functions"]![0]!["name"] = "HideShowOff";
        doc["functions"]![1]!["name"] = "BreakLogo1";

        var functions = SsfLogic.FromEffectsDocument(doc)!.Functions!;

        Assert.Equal(new[] { "HideShowOff", "BreakLogo1" }, functions.Select(f => f.FunctionName));
    }

    [Fact]
    public void LoadReadsTheDocumentFromALevelDirectory()
    {
        using var temp = new TempDir();
        var doc = Document(graphs: new JArray(Graph("g0", 0,
            Node(SsfMainType.PlaySound, new JObject { ["SoundPlay"] = 43 }))));
        temp.Write("Effects.json", doc.ToString());

        var root = SsfLogic.Load(temp.Path);

        Assert.NotNull(root);
        Assert.Equal(43, root!.EffectHeaders![0].Effects![0].SoundPlay);
    }

    [Fact]
    public void AnAbsentDocumentLoadsAsNullRatherThanThrowing()
    {
        // Every consumer's "no data" path keys off null; an exception here would take out the whole bundle.
        using var temp = new TempDir();

        Assert.Null(SsfLogic.Load(temp.Path));
    }

    [Fact]
    public void AnUnparseableDocumentLoadsAsNull()
    {
        using var temp = new TempDir();
        temp.Write("Effects.json", "{ this is not json");

        Assert.Null(SsfLogic.Load(temp.Path));
    }

    [Fact]
    public void InstanceBindingsAreStampedFromTheDocumentOntoTheInstanceRows()
    {
        // Effects.json owns the instance -> effect binding, not the native values in Instances.json.
        using var temp = new TempDir();
        var doc = Document(
            graphs: new JArray(Graph("g0", 0)),
            slots: new JArray(Row("slot-a", 0), Row("slot-b", 6)),
            objectProperties: new JArray(new JObject
            {
                ["id"] = "prop0",
                ["references"] = new JObject { ["effectSlot"] = "slot-b" },
            }),
            instances: new JArray(new JObject { ["id"] = "inst0", ["originalIndex"] = 1, ["property"] = "prop0" }));
        doc["physics"] = new JArray(Row("phys-a", 3));
        ((JObject)doc["objectProperties"]![0]!["references"]!)["physics"] = "phys-a";
        temp.Write("Effects.json", doc.ToString());

        var instances = new List<SsxInstance> { new(), new() };
        SsfLogic.ApplyInstanceBindings(temp.Path, instances);

        Assert.Equal(-1, instances[0].EffectSlotIndex);   // untouched: the document binds index 1
        Assert.Equal(6, instances[1].EffectSlotIndex);
        Assert.Equal(3, instances[1].PhysicsIndex);
    }

    [Fact]
    public void ABindingPointingPastTheInstanceTableIsIgnored()
    {
        using var temp = new TempDir();
        var doc = Document(
            graphs: new JArray(Graph("g0", 0)),
            slots: new JArray(Row("slot-a", 0)),
            objectProperties: new JArray(new JObject
            {
                ["id"] = "prop0",
                ["references"] = new JObject { ["effectSlot"] = "slot-a" },
            }),
            instances: new JArray(new JObject { ["id"] = "inst0", ["originalIndex"] = 99, ["property"] = "prop0" }));
        temp.Write("Effects.json", doc.ToString());

        var instances = new List<SsxInstance> { new() };
        SsfLogic.ApplyInstanceBindings(temp.Path, instances);

        Assert.Equal(-1, instances[0].EffectSlotIndex);
    }

    [Fact]
    public void ApplyingBindingsWithNoInstancesOrNoDocumentIsANoOp()
    {
        using var temp = new TempDir();

        SsfLogic.ApplyInstanceBindings(temp.Path, null);
        SsfLogic.ApplyInstanceBindings(temp.Path, new List<SsxInstance>());
        SsfLogic.ApplyInstanceBindings(temp.Path, new List<SsxInstance> { new() });
    }

    [Fact]
    public void HudTextSurvivesTheDocumentNormalizer()
    {
        // The message rides in the node's own payload rather than a side table, so it has to make it
        // through this DTO. Before SsfNode carried the field the value was dropped here, silently,
        // between an authored Effects.json and the SSF the repack writes.
        var doc = Document(graphs: new JArray(Graph("g0", 0,
            Node(SsfMainType.HudText, payload: new JObject { ["HudText"] = "flag-set-plain" }))));

        var root = SsfLogic.FromEffectsDocument(doc);

        Assert.Equal("flag-set-plain", root!.EffectHeaders![0].Effects![0].HudText);
    }

    [Fact]
    public void HudTextIsStrippedFromNodesThatAreNotHudText()
    {
        // Same discipline as the other union scalars: the document carries every key on every node,
        // so a payload key that does not belong to this main type must not reach the DTO and be
        // mistaken for authored data.
        var doc = Document(graphs: new JArray(Graph("g0", 0,
            Node(SsfMainType.Wait, payload: new JObject
            {
                ["WaitTime"] = 3.0f,
                ["HudText"] = "not mine",
            }))));

        var root = SsfLogic.FromEffectsDocument(doc);

        Assert.Null(root!.EffectHeaders![0].Effects![0].HudText);
        Assert.Equal(3.0f, root.EffectHeaders[0].Effects![0].WaitTime);
    }
}
