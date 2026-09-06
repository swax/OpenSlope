using Newtonsoft.Json.Linq;

namespace Snowknife.Repack;

/// <summary>
/// Compiles a Slopesmith export's authored effect attachments into a repacked level's SSF logic
/// (docs/repack-technical-reference.md; the P4 half of the Effects.json contract — EffectsDocumentService is the P1 adapter).
///
/// The export's <c>Effects.json</c> is an openslope-effects-v1 document whose node payloads are the exact
/// Newtonsoft shape of the library's SSF JSON dialect (each node = <c>{ mainType, payload: { typeN … } }</c>,
/// a superset-with-nulls of an <c>SSFLogic.json</c> EffectHeaders entry). Its
/// <c>extensions.slopesmith.attachments</c> join effect slots to placement stable ids, and
/// <c>extensions.slopesmith.bakedGroups</c> (written by the exporter) joins those ids to the
/// <c>o &lt;group&gt;</c> names the placements baked as in <c>Props.obj</c>.
///
/// <see cref="Compile"/> appends each ATTACHED slot's circumstance graphs to the work dir's
/// <c>SSFLogic.json</c> (EffectHeaders + EffectSlots — the file the level build's SSFGenerate compiles into
/// the .ssf) and returns per-group wiring for <see cref="CanonicalMapProps.Append"/> to remap on the packed
/// instances: <c>EffectSlotIndex</c> = the appended slot, <c>UVScroll</c> = true when a graph carries a
/// type-0 SubType-10/19 UV-scroll node (the library turns it into ObjectProperties BitFlags bit 13), and
/// touchability when the slot has a collision-circumstance graph. The mapping follows
/// [Trailmap: 130-collision-data, 150-logic, 170-materials].
///
/// Unattached slots/graphs in the document are ignored — only what an attachment references is compiled.
/// Slopesmith-managed spline references are resolved through the document resource's
/// <c>originalIndex</c>; the same ordered authored course-spline list has already replaced work/Splines.json.
///
/// A MainType-21 node names a document FUNCTION, which compiles the same way a graph does but appends to the
/// work logic's <c>Functions</c> table instead of <c>EffectHeaders</c>, and the appended row's index is written
/// into the node as <c>FunctionRunIndex</c>. Appending leaves the donor's own functions in place, so an
/// authored index is always past them. A function body is an ordinary node list: it may hop, teleport, carry
/// splines, and call further functions, and everything below that talks about "an owner" applies to both
/// tables. The engine runs a called body on a THREAD OF ITS OWN with the caller's rider, so a call does not
/// change what the calling chain does next [Trailmap: 150-logic].
///
/// Two node kinds name ANOTHER instance, and their payload is a raw index into the level instance table —
/// one u32 per Instances.json row, in row order [Trailmap: 230-level-ssf]. MainType 7 runs a graph over there;
/// MainType 24 puts the RIDER there. That index does not exist yet when this runs: the authored rows are
/// appended afterwards by <see cref="CanonicalMapProps.Append"/>. So the document's instance rows name a
/// Slopesmith PLACEMENT, compilation emits the node with a -1 index and records it, and
/// <see cref="ResolveHops"/> back-patches the packed indices in the window between the prop append and the
/// level build. Getting this wrong is silent — both opcodes go through the same resolver, which bounds-checks,
/// so a bad index is an invisible no-op — hence the compiler refuses a reference it cannot resolve rather than
/// shipping a plausible one. For the teleport the stakes are higher than for the hop, because an in-range
/// WRONG index does not do nothing: it drops the rider somewhere the author never placed anything.
/// </summary>
internal static class AuthoredEffects
{
    /// <summary>Which work-logic table an appended node list landed in. Both hold the same node shape and are
    /// addressed identically; only the array they live in differs.</summary>
    internal enum OwnerTable { EffectHeaders, Functions }

    /// <summary>
    /// A node awaiting the packed index of the instance it names.
    ///
    /// <paramref name="MainType"/> is carried because the two kinds store the resolved index in different
    /// shapes — 7 in a nested <c>Instance</c> pair, 24 in a bare <c>TeleportInstanceIndex</c> word — and
    /// patching the wrong shape would leave the node at -1 while reporting success. <paramref name="Table"/>
    /// is carried for the same reason: an index into <c>Functions</c> read against <c>EffectHeaders</c> names
    /// a real but unrelated node, and the MainType check below would then reject a hop that was fine.
    /// </summary>
    internal sealed record Hop(OwnerTable Table, int OwnerIndex, int NodeIndex, string InstanceName,
        string TargetId, int MainType);

    internal sealed class Wiring
    {
        public int SlotIndex;          // merged EffectSlots index for the instance's EffectSlotIndex
        public bool UvScroll;          // slot carries a UV-scroll property node -> instance UVScroll (BitFlags bit 13)
        public bool Collision;         // slot has a collision-circumstance graph -> instance must be touchable
        public bool SplineMover;       // slot creates spline-mover copies; the packed source host stays hidden
        public bool Roller;            // slot activates a knock body; wins ownership if also (invalidly) a mover
        public string SlotId = "";
    }

    private static readonly (string DocKey, string LogicKey)[] CircumstanceMap =
    {
        ("persistent", "PersistantEffectSlot"),
        ("collision", "CollisionEffectSlot"),
        ("slot3", "Slot3"),
        ("slot4", "Slot4"),
        ("trigger", "EffectTriggerSlot"),
        ("slot6", "Slot6"),
        ("slot7", "Slot7"),
    };

    /// <summary>SSF main type 12: the Show message node ([Trailmap: 443-debug-text]).</summary>
    const int HudTextMainType = 12;

    /// <summary>
    /// Drop every Show message node from the document before it is compiled.
    /// </summary>
    /// <remarks>
    /// Done on the document rather than inside the SSF compiler so the build flag stays out of the
    /// compiler entirely, and so this is one transform that can be tested on its own. The nodes are only
    /// meaningful on an image carrying the debug-text executable patch: without it the engine sends main
    /// type 12 to its dispatcher's inert default, so leaving them in would cost a level bytes and a reader
    /// somewhere a puzzle, to do nothing.
    /// </remarks>
    static void StripHudText(JObject doc)
    {
        int dropped = 0;
        foreach (string table in new[] { "graphs", "functions" })
        {
            foreach (JObject owner in (doc[table] as JArray ?? new JArray()).OfType<JObject>())
            {
                if (owner["nodes"] is not JArray nodes) continue;
                foreach (JObject node in nodes.OfType<JObject>().ToList())
                {
                    if ((int?)node["mainType"] != HudTextMainType) continue;
                    node.Remove();
                    dropped++;
                }
            }
        }
        if (dropped > 0)
        {
            Log.Info($"  dropped {dropped} Show message node(s) — rebuild with --patches hud-text to keep them");
        }
    }

    /// <summary>
    /// Merge the export's attached effect slots into <c>&lt;workDir&gt;/SSFLogic.json</c> and return the
    /// baked-group → wiring map. Null when the
    /// export carries no compilable attachments; the work file is only rewritten when something compiled.
    /// </summary>
    public static Dictionary<string, Wiring>? Compile(string customDir, string workDir, out List<Hop> hops,
        bool keepHudText = false)
    {
        hops = new List<Hop>();
        string fxPath = Path.Combine(customDir, "Effects.json");
        if (!File.Exists(fxPath)) return null;
        JObject doc;
        try { doc = JObject.Parse(File.ReadAllText(fxPath)); }
        catch (Exception e) { Log.Warn($"  WARN: Effects.json unreadable ({e.Message}) — authored effects skipped."); return null; }

        if (!keepHudText) StripHudText(doc);

        var ext = doc["extensions"]?["slopesmith"] as JObject;
        if (ext?["attachments"] is not JArray attachments || attachments.Count == 0) return null;
        if (ext["bakedGroups"] is not JObject bakedGroups)
        {
            Log.Warn("  WARN: Effects.json has attachments but no bakedGroups join (older export) — re-export to compile authored effects into the ISO.");
            return null;
        }

        var slotById = (doc["slots"] as JArray ?? new JArray()).OfType<JObject>()
            .Where(s => s["id"] is not null).ToDictionary(s => (string)s["id"]!, s => s);
        var graphById = (doc["graphs"] as JArray ?? new JArray()).OfType<JObject>()
            .Where(g => g["id"] is not null).ToDictionary(g => (string)g["id"]!, g => g);
        var functionById = (doc["functions"] as JArray ?? new JArray()).OfType<JObject>()
            .Where(f => f["id"] is not null).ToDictionary(f => (string)f["id"]!, f => f);
        var splineById = (doc["splines"] as JArray ?? new JArray()).OfType<JObject>()
            .Where(s => s["id"] is not null).ToDictionary(s => (string)s["id"]!, s => s);
        // An instance-naming node names a document instance row; that row names a Slopesmith placement through
        // its extensions, and bakedGroups joins the placement to the Props.obj group the append names the packed
        // instance after. Resolve that whole chain here — only the packed array INDEX has to wait.
        var hopTargets = new Dictionary<string, (string InstanceName, string TargetId)>(StringComparer.Ordinal);
        foreach (var instance in (doc["instances"] as JArray ?? new JArray()).OfType<JObject>())
        {
            if ((string?)instance["id"] is not { Length: > 0 } instanceId) continue;
            if ((string?)instance["extensions"]?["slopesmith"]?["placement"] is not { Length: > 0 } placement) continue;
            var targetGroups = (bakedGroups[placement] as JArray)?
                .Select(t => (string?)t).Where(s => !string.IsNullOrEmpty(s)).ToList();
            if (targetGroups == null || targetGroups.Count == 0)
            { Log.Warn($"  WARN: hop target {placement} has no baked Props.obj group — graphs acting on it are skipped."); continue; }
            if (targetGroups.Count > 1)
                Log.Warn($"  WARN: hop target {placement} baked as {targetGroups.Count} groups — the node names ONE instance; using {targetGroups[0]}.");
            hopTargets[instanceId] = (SanitizeGroupName(targetGroups[0]!), placement);
        }

        int splineCount = 0;
        string splinesPath = Path.Combine(workDir, "Splines.json");
        if (File.Exists(splinesPath))
        {
            try { splineCount = (JObject.Parse(File.ReadAllText(splinesPath))["Splines"] as JArray)?.Count ?? 0; }
            catch { /* the level build will report a malformed Splines.json; keep effect compilation conservative */ }
        }

        string logicPath = Path.Combine(workDir, "SSFLogic.json");
        if (!File.Exists(logicPath))
        { Log.Warn("  WARN: work SSFLogic.json missing — authored effects skipped."); return null; }
        var logic = JObject.Parse(File.ReadAllText(logicPath));
        if (logic["EffectSlots"] is not JArray effectSlots || logic["EffectHeaders"] is not JArray effectHeaders)
        { Log.Warn("  WARN: SSFLogic.json has no EffectSlots/EffectHeaders — authored effects skipped."); return null; }
        // A donor with no named functions still has the table; a document that authors the first one needs it
        // to exist before anything can be appended.
        var effectFunctions = logic["Functions"] as JArray;
        if (effectFunctions == null) logic["Functions"] = effectFunctions = new JArray();

        var appendedGraph = new Dictionary<string, int>(StringComparer.Ordinal);
        var appendedFunction = new Dictionary<string, int>(StringComparer.Ordinal);
        var appendedSlot = new Dictionary<string, Wiring>(StringComparer.Ordinal);
        var wiring = new Dictionary<string, Wiring>(StringComparer.Ordinal);
        // Aliased so the local function below can add to it without capturing the out parameter.
        var pendingHops = hops;
        // An owner appends the owners it reaches — a hop dispatches a graph, a call runs a function — and
        // either can reach back. Held across both tables because a cycle can run through them alternately.
        var inFlight = new HashSet<string>(StringComparer.Ordinal);

        // Compile one owner's node list into the EffectHeaders node dialect, with the instance-naming nodes
        // left at -1 and recorded. Null = refused (warned); the caller drops its slot. `graphId` is the
        // owner named the way the warnings should read it ("graph graph:0002", "function function:0000").
        (JArray Nodes, List<(int NodeIndex, string InstanceName, string TargetId, int MainType)> Hops)?
            CompileNodes(string graphId, JObject graph)
        {
            var effects = new JArray();
            var graphHops = new List<(int NodeIndex, string InstanceName, string TargetId, int MainType)>();
            // A spline-animation node is not a useful standalone persistent thread. Every retail mover
            // recovered (SNOW gondolas and MERQUER trains) enters through the same guard/yield pair: construct
            // the spline mover only while the host has no live node, then debounce forever. Without that
            // prefix the payload is present in RAM but no persistent mover allocation survives the frame.
            if (GraphHasSplineMover(graph) && !GraphHasNativeSplinePreamble(graph))
            {
                effects.Add(new JObject
                {
                    ["MainType"] = 5,
                    ["type5"] = new JObject { ["U0"] = 3, ["U1"] = 0.0, ["U2"] = 0 },
                });
                effects.Add(new JObject
                {
                    ["MainType"] = 0,
                    ["type0"] = new JObject { ["SubType"] = 2, ["Debounce"] = -1.0 },
                });
            }
            foreach (var node in (graph["nodes"] as JArray ?? new JArray()).OfType<JObject>())
            {
                if (node["mainType"]?.Type != JTokenType.Integer || node["payload"] is not JObject payload)
                { Log.Warn($"  WARN: graph {graphId} has a malformed node — its slot is skipped."); return null; }
                int mainType = (int)node["mainType"]!;
                var refs = node["references"] as JObject;
                // A teleport names only where the rider goes; there is no graph to run over there.
                bool hopRef(JProperty p) => (mainType == 7 && p.Name is "instance" or "effectGraph")
                    || (mainType == 24 && p.Name == "instance")
                    || (mainType == 21 && p.Name == "function");
                if (refs != null && refs.Properties().Any(p =>
                        p.Value.Type != JTokenType.Null && p.Name != "spline" && !hopRef(p)))
                { Log.Warn($"  WARN: graph {graphId} node carries a reference this compiler cannot resolve — its slot is skipped."); return null; }
                var compiledPayload = (JObject)payload.DeepClone();
                if (refs?["spline"]?.Type == JTokenType.String)
                {
                    string splineId = (string)refs["spline"]!;
                    if (!splineId.StartsWith("spline:path:", StringComparison.Ordinal)
                        || !splineById.TryGetValue(splineId, out var resource)
                        || resource["originalIndex"]?.Type != JTokenType.Integer)
                    { Log.Warn($"  WARN: graph {graphId} references unresolved authored spline {splineId} — its slot is skipped."); return null; }
                    int splineIndex = (int)resource["originalIndex"]!;
                    if (splineIndex < 0 || splineIndex >= splineCount)
                    { Log.Warn($"  WARN: graph {graphId} spline {splineId} resolves to {splineIndex}, outside {splineCount} authored splines — its slot is skipped."); return null; }
                    if (mainType == 2 && compiledPayload["type2"] is JObject type2
                        && (int?)type2["SubType"] == 1 && type2["SplineAnimation"] is JObject animation)
                        animation["SplineIndex"] = splineIndex;
                    else if (mainType == 25 && compiledPayload["Spline"] is JObject spline)
                        spline["SplineIndex"] = splineIndex;
                    else
                    { Log.Warn($"  WARN: graph {graphId} carries a spline reference on unsupported MainType {mainType} — its slot is skipped."); return null; }
                }
                if (mainType == 7)
                {
                    // Both halves have to resolve. A hop that ships a plausible-but-wrong index is worse than
                    // one that is refused: the runtime resolver bounds-checks and then silently does nothing,
                    // so the mistake is invisible on hardware [Trailmap: 230-level-ssf].
                    string named = (string?)refs?["instance"] ?? "<none>";
                    if ((string?)refs?["instance"] is not { Length: > 0 } instanceId
                        || !hopTargets.TryGetValue(instanceId, out var target))
                    { Log.Warn($"  WARN: graph {graphId} acts on instance {named}, which no placement-bound instance row resolves — its slot is skipped."); return null; }
                    if ((string?)refs?["effectGraph"] is not { Length: > 0 } hopGraphId)
                    { Log.Warn($"  WARN: graph {graphId} acts on an instance but names no graph to run on it — its slot is skipped."); return null; }
                    int hopGraph = AppendGraph(hopGraphId);
                    if (hopGraph < 0) return null;
                    // -1 stands in until ResolveHops knows the packed row. The pair is written whole so a
                    // half-populated payload can never fall back to the "instance 0, graph 0" the native
                    // struct's defaults would produce.
                    compiledPayload["Instance"] = new JObject
                    {
                        ["InstanceIndex"] = -1,
                        ["EffectIndex"] = hopGraph,
                    };
                    graphHops.Add((effects.Count, target.InstanceName, target.TargetId, mainType));
                }
                if (mainType == 21)
                {
                    // A call with no body is not a node that does less: FunctionRunIndex is read as an index
                    // with only a negative test in front of it, so any in-range leftover runs SOME function of
                    // the donor's — the countdown, a screen break — on the rider who touched this prop.
                    string named = (string?)refs?["function"] ?? "<none>";
                    if ((string?)refs?["function"] is not { Length: > 0 } calledId)
                    { Log.Warn($"  WARN: graph {graphId} calls function {named}, which it does not name — its slot is skipped."); return null; }
                    int called = AppendFunction(calledId);
                    if (called < 0) return null;
                    compiledPayload["FunctionRunIndex"] = called;
                }
                if (mainType == 24)
                {
                    // The teleport carries a destination and nothing else, so an unresolved one is not a node
                    // that does less — it is a node that moves the rider to whatever instance 0 happens to be.
                    // Refusing the slot is the only safe failure: [Trailmap: 390-pickups-and-race] has the
                    // runtime offsetting ~3 m from the target and deriving a heading, with no validity test of
                    // its own beyond the shared resolver's bounds check.
                    string named = (string?)refs?["instance"] ?? "<none>";
                    if ((string?)refs?["instance"] is not { Length: > 0 } instanceId
                        || !hopTargets.TryGetValue(instanceId, out var target))
                    { Log.Warn($"  WARN: graph {graphId} teleports to instance {named}, which no placement-bound instance row resolves — its slot is skipped."); return null; }
                    compiledPayload["TeleportInstanceIndex"] = -1;
                    graphHops.Add((effects.Count, target.InstanceName, target.TargetId, mainType));
                }
                // MainType + the payload verbatim, minus explicit nulls: the exact EffectHeaders node dialect.
                var entry = new JObject { ["MainType"] = mainType };
                foreach (var property in compiledPayload.Properties())
                {
                    var value = StripNulls(property.Value);
                    if (value != null) entry[property.Name] = value;
                }
                effects.Add(entry);
            }
            return (effects, graphHops);
        }

        // one authored graph -> one appended EffectHeaders entry (shared across slots); -1 = refused (warned)
        int AppendGraph(string graphId)
        {
            if (appendedGraph.TryGetValue(graphId, out int cached)) return cached;
            if (!graphById.TryGetValue(graphId, out var graph))
            { Log.Warn($"  WARN: authored effect graph {graphId} missing from Effects.json — its slot is skipped."); return -1; }
            if (!inFlight.Add(graphId))
            { Log.Warn($"  WARN: graph {graphId} is reached from inside itself — its slot is skipped."); return -1; }
            var compiled = CompileNodes($"graph {graphId}", graph);
            inFlight.Remove(graphId);
            if (compiled == null) return -1;
            var (effects, graphHops) = compiled.Value;
            effectHeaders.Add(new JObject
            {
                ["EffectName"] = (string?)graph["name"] is { Length: > 0 } n ? n : graphId,
                ["Effects"] = effects,
            });
            // After the Add, and after any nested hop graph appended its own header — an index taken before
            // the recursion would name whichever graph the hop pulled in.
            int graphIndex = effectHeaders.Count - 1;
            foreach (var (nodeIndex, instanceName, targetId, nodeMainType) in graphHops)
                pendingHops.Add(new Hop(OwnerTable.EffectHeaders, graphIndex, nodeIndex, instanceName, targetId, nodeMainType));
            return appendedGraph[graphId] = graphIndex;
        }

        // The same for a named function, into the other table. Appending keeps the donor's own functions in
        // place, so an authored index is always past them and the donor's callers are undisturbed.
        //
        // That has a consequence worth knowing rather than discovering: the engine ALSO finds a function by
        // name, and `SsfFunctionTable_FindByName` returns the FIRST match [Trailmap: 150-logic]. The donor's
        // own `RaceMode` / `ShowoffMode` / `FreerideMode` are still in the table and still ahead, so an
        // authored function sharing one of those names is compiled, callable by index, and never the one the
        // mode switch finds. Reaching those hooks would mean replacing the donor's entry, not adding one.
        int AppendFunction(string functionId)
        {
            if (appendedFunction.TryGetValue(functionId, out int cached)) return cached;
            if (!functionById.TryGetValue(functionId, out var function))
            { Log.Warn($"  WARN: called function {functionId} missing from Effects.json — its slot is skipped."); return -1; }
            if (!inFlight.Add(functionId))
            { Log.Warn($"  WARN: function {functionId} calls into a cycle — its slot is skipped."); return -1; }
            var compiled = CompileNodes($"function {functionId}", function);
            inFlight.Remove(functionId);
            if (compiled == null) return -1;
            var (effects, functionHops) = compiled.Value;
            effectFunctions.Add(new JObject
            {
                ["FunctionName"] = FunctionName((string?)function["name"], functionId),
                ["Effects"] = effects,
            });
            int functionIndex = effectFunctions.Count - 1;
            foreach (var (nodeIndex, instanceName, targetId, nodeMainType) in functionHops)
                pendingHops.Add(new Hop(OwnerTable.Functions, functionIndex, nodeIndex, instanceName, targetId, nodeMainType));
            return appendedFunction[functionId] = functionIndex;
        }

        // The three instance-wiring flags below are asked of a slot's graph, and a called function runs on the
        // SAME instance — so a UV scroll or a mover the author put in a shared body has to count for the host
        // exactly as one in the graph does. Hops are deliberately not followed: those run on somebody else.
        bool ReachesThrough(JObject? owner, Func<JObject, bool> test, HashSet<string>? seen = null)
        {
            if (owner == null) return false;
            if (test(owner)) return true;
            seen ??= new HashSet<string>(StringComparer.Ordinal);
            foreach (var node in (owner["nodes"] as JArray ?? new JArray()).OfType<JObject>())
            {
                if ((int?)node["mainType"] != 21) continue;
                if ((string?)node["references"]?["function"] is not { Length: > 0 } calledId) continue;
                if (!seen.Add(calledId)) continue;
                if (functionById.TryGetValue(calledId, out var called) && ReachesThrough(called, test, seen)) return true;
            }
            return false;
        }

        Wiring? AppendSlot(string slotId)
        {
            if (appendedSlot.TryGetValue(slotId, out var cached)) return cached;
            if (!slotById.TryGetValue(slotId, out var slot))
            { Log.Warn($"  WARN: effect attachment references missing slot {slotId} — skipped."); return null; }
            var circumstances = slot["circumstances"] as JObject ?? new JObject();
            var entry = new JObject { ["EffectSlotName"] = $"EffectSlot {effectSlots.Count} (authored {slotId})" };
            var result = new Wiring { SlotId = slotId };
            foreach (var (docKey, logicKey) in CircumstanceMap)
            {
                string? graphId = (string?)circumstances[docKey];
                int index = -1;
                if (graphId != null)
                {
                    index = AppendGraph(graphId);
                    if (index < 0) return null;
                    if (docKey == "collision") result.Collision = true;
                    result.UvScroll |= ReachesThrough(graphById[graphId], GraphHasUvScroll);
                    result.SplineMover |= ReachesThrough(graphById[graphId], GraphHasSplineMover);
                    result.Roller |= ReachesThrough(graphById[graphId], GraphHasRoller);
                }
                entry[logicKey] = index;
            }
            effectSlots.Add(entry);
            result.SlotIndex = effectSlots.Count - 1;
            return appendedSlot[slotId] = result;
        }

        foreach (var attachment in attachments.OfType<JObject>())
        {
            if ((bool?)attachment["enabled"] == false) continue;
            string slotId = (string?)attachment["slot"] ?? "";
            string targetId = (string?)attachment["target"]?["id"] ?? "";
            var groups = (bakedGroups[targetId] as JArray)?
                .Select(t => (string?)t).Where(s => !string.IsNullOrEmpty(s)).ToList();
            if (groups == null || groups.Count == 0)
            { Log.Warn($"  WARN: effect attachment target {targetId} has no baked Props.obj group — skipped."); continue; }
            var slot = AppendSlot(slotId);
            if (slot == null) continue;
            foreach (string? group in groups)
            {
                string key = SanitizeGroupName(group!);
                var groupWiring = new Wiring
                {
                    SlotIndex = slot.SlotIndex,
                    UvScroll = slot.UvScroll,
                    Collision = slot.Collision,
                    SplineMover = slot.SplineMover,
                    Roller = slot.Roller,
                    SlotId = slot.SlotId,
                };
                if (!wiring.TryAdd(key, groupWiring))
                    Log.Warn($"  WARN: {key} carries more than one effect attachment — an instance has ONE effect slot; keeping {wiring[key].SlotId}.");
            }
        }

        if (wiring.Count == 0) return null;
        File.WriteAllText(logicPath, logic.ToString(Newtonsoft.Json.Formatting.None));
        int scrolls = wiring.Values.Count(w => w.UvScroll), touch = wiring.Values.Count(w => w.Collision),
            movers = wiring.Values.Count(w => w.SplineMover);
        Log.Info($"  authored effects: {appendedSlot.Count} slot(s) / {appendedGraph.Count} graph(s)"
            + (appendedFunction.Count > 0 ? $" / {appendedFunction.Count} function(s)" : "")
            + " appended to the ssf logic"
            + $" -> {wiring.Count} instance wiring(s) ({scrolls} uv-scroll, {touch} collision-circumstance, {movers} spline-mover)");
        return wiring;
    }

    /// <summary>
    /// Back-patch the packed instance index into every instance-naming node <see cref="Compile"/> left at -1.
    ///
    /// Must run AFTER <see cref="CanonicalMapProps.Append"/> (the authored rows only exist then) and BEFORE the
    /// level build's SSFGenerate reads SSFLogic.json. The SSF instance table is one u32 per Instances.json row
    /// in row order, so the packed array index IS the index the node carries [Trailmap: 230-level-ssf].
    ///
    /// An unresolved hop is left at -1 on purpose: the runtime resolver bounds-checks, so -1 does nothing,
    /// whereas any in-range guess would quietly act on whichever object happened to land there.
    /// </summary>
    public static int ResolveHops(string workDir, IReadOnlyList<Hop> hops)
    {
        if (hops.Count == 0) return 0;
        string instancesPath = Path.Combine(workDir, "Instances.json");
        string logicPath = Path.Combine(workDir, "SSFLogic.json");
        if (!File.Exists(instancesPath) || !File.Exists(logicPath))
        { Log.Warn("  WARN: work Instances.json/SSFLogic.json missing — instance references stay unresolved."); return 0; }

        var instances = JObject.Parse(File.ReadAllText(instancesPath))["Instances"] as JArray;
        var logic = JObject.Parse(File.ReadAllText(logicPath));
        if (instances == null || logic["EffectHeaders"] is not JArray headers)
        { Log.Warn("  WARN: work tables unreadable — instance references stay unresolved."); return 0; }
        var functions = logic["Functions"] as JArray ?? new JArray();

        var indexByName = new Dictionary<string, int>(StringComparer.Ordinal);
        for (int i = 0; i < instances.Count; i++)
            if ((string?)instances[i]?["InstanceName"] is { Length: > 0 } name) indexByName.TryAdd(name, i);

        int resolved = 0;
        foreach (var hop in hops)
        {
            if (!indexByName.TryGetValue(hop.InstanceName, out int target))
            { Log.Warn($"  WARN: hop target {hop.TargetId} baked as {hop.InstanceName}, which is not among the packed instances — the hop stays -1 and will do nothing."); continue; }
            var owners = hop.Table == OwnerTable.Functions ? functions : headers;
            if (hop.OwnerIndex < 0 || hop.OwnerIndex >= owners.Count
                || owners[hop.OwnerIndex]?["Effects"] is not JArray nodes
                || hop.NodeIndex < 0 || hop.NodeIndex >= nodes.Count
                || nodes[hop.NodeIndex] is not JObject node
                || (int?)node["MainType"] != hop.MainType)
            { Log.Warn($"  WARN: hop for {hop.TargetId} no longer addresses a MainType-{hop.MainType} node — left unresolved."); continue; }
            // The index is the same number in both; only where it is stored differs.
            if (hop.MainType == 24) node["TeleportInstanceIndex"] = target;
            else if (node["Instance"] is JObject instance) instance["InstanceIndex"] = target;
            else { Log.Warn($"  WARN: hop for {hop.TargetId} has no Instance pair to patch — left unresolved."); continue; }
            resolved++;
        }

        if (resolved > 0) File.WriteAllText(logicPath, logic.ToString(Newtonsoft.Json.Formatting.None));
        Log.Info($"  authored effects: {resolved}/{hops.Count} instance hop(s) resolved to packed instances");
        return resolved;
    }

    /// <summary>
    /// The 16-byte ASCII name the .ssf function table stores, kept as close to the authored one as the field
    /// allows.
    ///
    /// The name is behaviour, not documentation. The engine reaches a level function by name as well as by
    /// index — `SsfFunctionTable_FindByName` strcmps this field and `SsfFunction_RunByName` runs the match on
    /// an unowned thread, which is how the game-mode switch dispatches `RaceMode` / `ShowoffMode` /
    /// `FreerideMode` [Trailmap: 150-logic]. So this preserves what the author typed rather than normalizing
    /// it, and 15 characters is the ceiling because the level writer pads the field without terminating it and
    /// `strcmp` needs the zero byte inside the 16. Retail's longest is 14.
    /// </summary>
    private static string FunctionName(string? authored, string fallback)
    {
        string source = string.IsNullOrWhiteSpace(authored) ? fallback : authored!;
        var chars = source.Where(c => c is >= (char)0x20 and < (char)0x7f).Take(15).ToArray();
        return chars.Length > 0 ? new string(chars) : "Function";
    }

    private static bool GraphHasUvScroll(JObject graph) =>
        (graph["nodes"] as JArray ?? new JArray()).OfType<JObject>().Any(node =>
            (int?)node["mainType"] == 0
            && node["payload"]?["type0"] is JObject type0
            && (int?)type0["SubType"] is 10 or 19);

    private static bool GraphHasSplineMover(JObject graph) =>
        (graph["nodes"] as JArray ?? new JArray()).OfType<JObject>().Any(node =>
            (int?)node["mainType"] == 2
            && node["payload"]?["type2"] is JObject type2
            && (int?)type2["SubType"] == 1
            && type2["SplineAnimation"] is JObject);

    private static bool GraphHasRoller(JObject graph) =>
        (graph["nodes"] as JArray ?? new JArray()).OfType<JObject>().Any(node =>
            (int?)node["mainType"] == 0
            && node["payload"]?["type0"] is JObject type0
            && (int?)type0["SubType"] == 0
            && type0["type0Sub0"] is JObject);

    private static bool GraphHasNativeSplinePreamble(JObject graph)
    {
        var nodes = (graph["nodes"] as JArray ?? new JArray()).OfType<JObject>().Take(2).ToArray();
        return nodes.Length == 2
            && (int?)nodes[0]["mainType"] == 5
            && (int?)nodes[0]["payload"]?["type5"]?["U0"] == 3
            && (int?)nodes[1]["mainType"] == 0
            && (int?)nodes[1]["payload"]?["type0"]?["SubType"] == 2;
    }

    /// <summary>The array spelling of an <c>{X,Y,Z}</c> / <c>{X,Y,Z,W}</c> object, or null if it is not one.</summary>
    private static JArray? AsVector(JObject token)
    {
        string[] axes = ["X", "Y", "Z", "W"];
        int count = token.Properties().Count();
        if (count is not (3 or 4)) return null;
        var values = new JArray();
        for (int i = 0; i < count; i++)
        {
            if (token[axes[i]] is not JValue value || value.Type is not (JTokenType.Float or JTokenType.Integer))
                return null;
            values.Add(value.DeepClone());
        }
        return values;
    }

    internal static string SanitizeGroupName(string name)
    {
        var chars = name.Select(c => char.IsLetterOrDigit(c) || c is '_' or '-' ? c : '_').ToArray();
        return chars.Length > 0 ? new string(chars) : "Prop";
    }

    /// <summary>
    /// Deep-copy a payload token into the compact SSFLogic node shape: null-valued properties dropped, and
    /// vectors respelled as arrays.
    ///
    /// The two JSON dialects disagree about vectors, which is easy to miss because they agree about
    /// everything else. The document carries what <c>JObject.FromObject</c> makes of a
    /// <c>System.Numerics.Vector3</c> — <c>{"X":0,"Y":0,"Z":1}</c> — while the library's SSFLogic reader
    /// declares the same field <c>float[]</c> and rejects the object outright. Only
    /// <c>BoostEffect.BoostDir</c> is spelled this way today, but the mismatch belongs to the dialects rather
    /// than to that field, so it is fixed here rather than at the one call site.
    /// </summary>
    private static JToken? StripNulls(JToken token)
    {
        switch (token.Type)
        {
            case JTokenType.Null:
                return null;
            case JTokenType.Object:
                if (AsVector((JObject)token) is { } vector) return vector;
                var obj = new JObject();
                foreach (var property in ((JObject)token).Properties())
                {
                    var value = StripNulls(property.Value);
                    if (value != null) obj[property.Name] = value;
                }
                return obj;
            case JTokenType.Array:
                return new JArray(((JArray)token).Select(item => StripNulls(item) ?? JValue.CreateNull()));
            default:
                return token.DeepClone();
        }
    }
}
