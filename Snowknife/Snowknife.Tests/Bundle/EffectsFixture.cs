using Newtonsoft.Json.Linq;
using Snowknife.Engine;

namespace Snowknife.Tests.Bundle;

/// <summary>
/// Builders for synthetic <c>Effects.json</c> documents. The classifiers read a level directory rather than a
/// parsed graph, so their tests write one of these to a scratch folder — which is also the only way to reach
/// them without a retail extract.
/// </summary>
internal static class EffectsFixture
{
    /// <summary>A document with every table named, so a test only supplies what it cares about.</summary>
    public static JObject Document(
        JArray? graphs = null, JArray? functions = null, JArray? instances = null,
        JArray? splines = null, JArray? slots = null, JArray? objectProperties = null,
        JArray? physics = null) => new()
        {
            ["kind"] = "openslope-effects",
            ["version"] = 1,
            ["slots"] = slots ?? new JArray(),
            ["graphs"] = graphs ?? new JArray(),
            ["functions"] = functions ?? new JArray(),
            ["objectProperties"] = objectProperties ?? new JArray(),
            ["instances"] = instances ?? new JArray(),
            ["physics"] = physics ?? new JArray(),
            ["splines"] = splines ?? new JArray(),
        };

    /// <summary>An ID-bearing table row, optionally pinned to a native index.</summary>
    public static JObject Row(string id, int? originalIndex = null)
    {
        var row = new JObject { ["id"] = id };
        if (originalIndex is { } index) row["originalIndex"] = index;
        return row;
    }

    /// <summary>A graph (or function body) carrying an ordered node list.</summary>
    public static JObject Graph(string id, int? originalIndex, params JObject[] nodes)
    {
        var row = Row(id, originalIndex);
        row["nodes"] = new JArray(nodes.Cast<object>().ToArray());
        return row;
    }

    /// <summary>A named function body — the gating and LCD-break dispatch are both looked up by name.</summary>
    public static JObject Function(string id, int originalIndex, string name, params JObject[] nodes)
    {
        var row = Graph(id, originalIndex, nodes);
        row["name"] = name;
        return row;
    }

    public static JObject Node(SsfMainType mainType, JObject? payload = null, JObject? references = null) => new()
    {
        ["mainType"] = (int)mainType,
        ["payload"] = payload ?? new JObject(),
        ["references"] = references ?? new JObject(),
    };

    /// <summary>A <c>MainType 25</c> rail toggle aimed at a spline; <paramref name="effect"/> 0 turns it OFF.</summary>
    public static JObject ToggleRail(string splineId, int effect = 0) => Node(
        SsfMainType.ToggleRail,
        new JObject { ["Spline"] = new JObject { ["Effect"] = effect } },
        new JObject { ["spline"] = splineId });

    /// <summary>A <c>MainType 7</c> act-on-instance hop, optionally running a sub-graph on the target.</summary>
    public static JObject ActOnInstance(string instanceId, string? effectGraphId = null)
    {
        var references = new JObject { ["instance"] = instanceId };
        if (effectGraphId != null) references["effectGraph"] = effectGraphId;
        return Node(SsfMainType.ActOnInstance, new JObject { ["Instance"] = new JObject() }, references);
    }

    /// <summary>A <c>MainType 0 / Sub 5</c> dead node. Mode 4 is the hard kill a breakable uses.</summary>
    public static JObject DeadNode(int mode = 4) => Node(SsfMainType.Property, new JObject
    {
        ["type0"] = new JObject { ["SubType"] = (int)SsfType0Sub.DeadNode, ["DeadNodeMode"] = mode },
    });

    /// <summary>A <c>MainType 0 / Sub 14</c> fragile-surface crack: an impact pool <paramref name="strength"/> that
    /// contacts drain, and a crack lifetime (-1, every retail pane, never expires).</summary>
    public static JObject Cracked(float strength = 5f, float lifetime = -1f) => Node(SsfMainType.Property, new JObject
    {
        ["type0"] = new JObject
        {
            ["SubType"] = (int)SsfType0Sub.Cracked,
            ["type0Sub14"] = new JObject { ["U0"] = lifetime, ["U1"] = strength },
        },
    });

    /// <summary>A <c>MainType 8</c> sound: a RAW course-bank slot, not the CollisonSound event-id space.</summary>
    public static JObject PlaySound(int slot) =>
        Node(SsfMainType.PlaySound, new JObject { ["SoundPlay"] = slot });

    /// <summary>A <c>MainType 0 / Sub 11</c> texture flip. Length 0 is persistent; above 0 is a fired one-shot.</summary>
    public static JObject TextureFlip(float speed, float length, int direction = 0) =>
        Node(SsfMainType.Property, new JObject
        {
            ["type0"] = new JObject
            {
                ["SubType"] = (int)SsfType0Sub.TextureFlip,
                ["TextureFlip"] = new JObject
                {
                    ["Speed"] = speed,
                    ["Length"] = length,
                    ["Direction"] = direction,
                    ["U4"] = 0,
                },
            },
        });

    /// <summary>Write <paramref name="document"/> as the level's Effects.json and hand back the level dir.</summary>
    public static string WriteLevel(TempDir temp, JObject document)
    {
        temp.Write("Effects.json", document.ToString());
        return temp.Path;
    }
}
