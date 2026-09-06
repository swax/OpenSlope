using Newtonsoft.Json.Linq;
using Snowknife.Repack;

namespace Snowknife.Tests.Repack;

/// <summary>
/// The MainType-21 half of the authored-effect compiler: an authored document's own named functions, appended
/// to the work logic's <c>Functions</c> table and named by index from the calling chain.
///
/// Everything here is about an INDEX being right, which is the class of mistake the console cannot report. The
/// runtime tests <c>FunctionRunIndex</c> for negative and nothing else, so an off-by-one does not fail — it
/// runs the donor's countdown, or a screen break, on whoever touched the prop. The same is true of a hop
/// inside a function body: back-patch it against the wrong table and the index lands on a real but unrelated
/// node. So these assert the joins rather than that compilation "worked".
/// </summary>
public class AuthoredFunctionTests
{
    /// <summary>A work dir holding the two files <see cref="AuthoredEffects.Compile"/> reads, with the donor
    /// logic carrying <paramref name="donorFunctions"/> functions already so appended indices have to clear
    /// them.</summary>
    static void WriteWork(TempDir dir, int donorFunctions = 0, int donorHeaders = 0)
    {
        var logic = new JObject
        {
            ["EffectSlots"] = new JArray(),
            ["EffectHeaders"] = new JArray(Enumerable.Range(0, donorHeaders)
                .Select(i => new JObject { ["EffectName"] = $"donor{i}", ["Effects"] = new JArray() })),
            ["Functions"] = new JArray(Enumerable.Range(0, donorFunctions)
                .Select(i => new JObject { ["FunctionName"] = $"Donor{i}", ["Effects"] = new JArray() })),
        };
        dir.Write("work/SSFLogic.json", logic.ToString());
    }

    static JObject Node(int mainType, JObject? payload = null, JObject? references = null)
    {
        var node = new JObject { ["mainType"] = mainType, ["payload"] = payload ?? new JObject() };
        if (references != null) node["references"] = references;
        return node;
    }

    static JObject Owner(string id, string name, params JObject[] nodes) =>
        new() { ["id"] = id, ["name"] = name, ["nodes"] = new JArray(nodes.Cast<object>().ToArray()) };

    /// <summary>An Effects.json with one attached slot whose collision graph is <paramref name="graphNodes"/>.</summary>
    static void WriteDocument(TempDir dir, JArray functions, params JObject[] graphs)
    {
        var doc = new JObject
        {
            ["slots"] = new JArray(new JObject
            {
                ["id"] = "slot:0",
                ["circumstances"] = new JObject { ["collision"] = "graph:0" },
            }),
            ["graphs"] = new JArray(graphs.Cast<object>().ToArray()),
            ["functions"] = functions,
            ["instances"] = new JArray(new JObject
            {
                ["id"] = "instance:0",
                ["extensions"] = new JObject { ["slopesmith"] = new JObject { ["placement"] = "prop:target" } },
            }),
            ["splines"] = new JArray(),
            ["extensions"] = new JObject
            {
                ["slopesmith"] = new JObject
                {
                    ["attachments"] = new JArray(new JObject
                    {
                        ["slot"] = "slot:0",
                        ["target"] = new JObject { ["id"] = "prop:host" },
                        ["enabled"] = true,
                    }),
                    ["bakedGroups"] = new JObject
                    {
                        ["prop:host"] = new JArray("Host"),
                        ["prop:target"] = new JArray("Target"),
                    },
                },
            },
        };
        dir.Write("custom/Effects.json", doc.ToString());
    }

    static JObject ReadLogic(TempDir dir) => JObject.Parse(File.ReadAllText(dir.File("work/SSFLogic.json")));

    [Fact]
    public void ACallCompilesItsFunctionAndNamesItByAppendedIndex()
    {
        using var dir = new TempDir();
        WriteWork(dir, donorFunctions: 3);
        WriteDocument(dir,
            new JArray(Owner("function:0", "Shared", Node(4, new JObject { ["WaitTime"] = 0.5 }))),
            Owner("graph:0", "Collision", Node(21, references: new JObject { ["function"] = "function:0" })));

        var wiring = AuthoredEffects.Compile(dir.File("custom"), dir.File("work"), out var hops);

        Assert.NotNull(wiring);
        Assert.Empty(hops);
        var logic = ReadLogic(dir);
        var functions = (JArray)logic["Functions"]!;
        // Appended AFTER the donor's own three, and the call has to name the appended row rather than 0.
        Assert.Equal(4, functions.Count);
        Assert.Equal("Shared", (string?)functions[3]["FunctionName"]);
        Assert.Equal(0.5, (double?)functions[3]["Effects"]![0]!["WaitTime"]);
        Assert.Equal(3, (int?)logic["EffectHeaders"]![0]!["Effects"]![0]!["FunctionRunIndex"]);
    }

    [Fact]
    public void TwoCallsOnOneFunctionShareTheAppendedBody()
    {
        using var dir = new TempDir();
        WriteWork(dir);
        WriteDocument(dir,
            new JArray(Owner("function:0", "Shared", Node(4, new JObject { ["WaitTime"] = 1.0 }))),
            Owner("graph:0", "Collision",
                Node(21, references: new JObject { ["function"] = "function:0" }),
                Node(21, references: new JObject { ["function"] = "function:0" })));

        Assert.NotNull(AuthoredEffects.Compile(dir.File("custom"), dir.File("work"), out _));

        var logic = ReadLogic(dir);
        Assert.Single((JArray)logic["Functions"]!);
        var nodes = (JArray)logic["EffectHeaders"]![0]!["Effects"]!;
        Assert.Equal(0, (int?)nodes[0]!["FunctionRunIndex"]);
        Assert.Equal(0, (int?)nodes[1]!["FunctionRunIndex"]);
    }

    [Fact]
    public void AHopInsideAFunctionBodyIsBackPatchedAgainstTheFunctionTable()
    {
        // The failure this guards is silent both ways: recorded against EffectHeaders, the index would land on
        // a real node of an unrelated graph, and the MainType check would then reject a hop that was fine.
        using var dir = new TempDir();
        WriteWork(dir, donorHeaders: 2, donorFunctions: 1);
        WriteDocument(dir,
            new JArray(Owner("function:0", "Break",
                Node(7, new JObject { ["Instance"] = new JObject() },
                    new JObject { ["instance"] = "instance:0", ["effectGraph"] = "graph:1" }))),
            Owner("graph:0", "Collision", Node(21, references: new JObject { ["function"] = "function:0" })),
            Owner("graph:1", "OverThere", Node(4, new JObject { ["WaitTime"] = 2.0 })));

        Assert.NotNull(AuthoredEffects.Compile(dir.File("custom"), dir.File("work"), out var hops));

        var hop = Assert.Single(hops);
        Assert.Equal(AuthoredEffects.OwnerTable.Functions, hop.Table);
        Assert.Equal(1, hop.OwnerIndex);
        Assert.Equal("Target", hop.InstanceName);

        // ...and the resolve half writes into that table rather than into EffectHeaders.
        var instances = new JObject
        {
            ["Instances"] = new JArray(
                new JObject { ["InstanceName"] = "Host" },
                new JObject { ["InstanceName"] = "Target" }),
        };
        dir.Write("work/Instances.json", instances.ToString());

        Assert.Equal(1, AuthoredEffects.ResolveHops(dir.File("work"), hops));

        var logic = ReadLogic(dir);
        Assert.Equal(1, (int?)logic["Functions"]![1]!["Effects"]![0]!["Instance"]!["InstanceIndex"]);
    }

    [Fact]
    public void ACallWithNoFunctionRefusesTheSlotRatherThanShippingALeftoverIndex()
    {
        // FunctionRunIndex is only tested for negative, so any in-range value runs SOME donor function on the
        // rider. There is no safe default, which is why this is a refusal and not a -1.
        using var dir = new TempDir();
        WriteWork(dir, donorFunctions: 2);
        WriteDocument(dir, new JArray(),
            Owner("graph:0", "Collision", Node(21, references: new JObject { ["function"] = null })));

        Assert.Null(AuthoredEffects.Compile(dir.File("custom"), dir.File("work"), out _));
    }

    [Fact]
    public void ACallOnAFunctionThatIsNotInTheDocumentRefusesTheSlot()
    {
        using var dir = new TempDir();
        WriteWork(dir);
        WriteDocument(dir, new JArray(),
            Owner("graph:0", "Collision", Node(21, references: new JObject { ["function"] = "function:9" })));

        Assert.Null(AuthoredEffects.Compile(dir.File("custom"), dir.File("work"), out _));
    }

    [Fact]
    public void AFunctionThatCallsItselfRefusesTheSlotRatherThanRecursingForever()
    {
        using var dir = new TempDir();
        WriteWork(dir);
        WriteDocument(dir,
            new JArray(Owner("function:0", "Loop",
                Node(21, references: new JObject { ["function"] = "function:0" }))),
            Owner("graph:0", "Collision", Node(21, references: new JObject { ["function"] = "function:0" })));

        Assert.Null(AuthoredEffects.Compile(dir.File("custom"), dir.File("work"), out _));
    }

    [Fact]
    public void AUvScrollInsideACalledFunctionStillFlagsTheHostInstance()
    {
        // The called body runs on the SAME instance, so BitFlags bit 13 has to follow a scroll wherever the
        // author put it. Missing it leaves a material that scrolls in the editor and sits still on the disc.
        using var dir = new TempDir();
        WriteWork(dir);
        var scroll = Node(0, new JObject
        {
            ["type0"] = new JObject
            {
                ["SubType"] = 10,
                ["UVScroll"] = new JObject { ["U0"] = 0, ["U1"] = 0.0, ["U2"] = 0.01 },
            },
        });
        WriteDocument(dir,
            new JArray(Owner("function:0", "Scroll", scroll)),
            Owner("graph:0", "Collision", Node(21, references: new JObject { ["function"] = "function:0" })));

        var wiring = AuthoredEffects.Compile(dir.File("custom"), dir.File("work"), out _);

        Assert.True(wiring!["Host"].UvScroll);
    }

    [Fact]
    public void AnAuthoredNameSurvivesVerbatimWhenItFits()
    {
        // The name is behaviour: the engine resolves a function by strcmp on this field, which is how the mode
        // switch reaches RaceMode. Normalizing it — case, spaces, an id prefix — would silently decide whether
        // an authored function is one the engine calls.
        using var dir = new TempDir();
        WriteWork(dir);
        WriteDocument(dir,
            new JArray(Owner("function:0", "RaceMode", Node(4, new JObject { ["WaitTime"] = 0.0 }))),
            Owner("graph:0", "Collision", Node(21, references: new JObject { ["function"] = "function:0" })));

        Assert.NotNull(AuthoredEffects.Compile(dir.File("custom"), dir.File("work"), out _));

        Assert.Equal("RaceMode", (string?)ReadLogic(dir)["Functions"]![0]!["FunctionName"]);
    }

    [Fact]
    public void AnAuthoredNameIsTrimmedToFitTheNativeFixedWidthField()
    {
        // 16 bytes, padded but never terminated by the writer, and matched with strcmp — so a 16-character
        // name has no zero byte inside its field and the compare runs on into the next record.
        using var dir = new TempDir();
        WriteWork(dir);
        WriteDocument(dir,
            new JArray(Owner("function:0", "A name far longer than the field", Node(4, new JObject { ["WaitTime"] = 0.0 }))),
            Owner("graph:0", "Collision", Node(21, references: new JObject { ["function"] = "function:0" })));

        Assert.NotNull(AuthoredEffects.Compile(dir.File("custom"), dir.File("work"), out _));

        Assert.Equal("A name far long", (string?)ReadLogic(dir)["Functions"]![0]!["FunctionName"]);
    }
}
