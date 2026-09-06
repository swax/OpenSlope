using System.Globalization;
using System.Security.Cryptography;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using SSX_Library.FileHandlers.LevelFiles.Tricky.PS2;
using Snowknife.Engine;

namespace Snowknife.Services;

/// <summary>
/// P1 interchange adapter for the engine-neutral Effects.json document. The document retains every
/// semantic SSF table while replacing fragile cross-table array indices with stable string IDs. Array
/// order is still the requested binary export order, but it is never used as identity inside the file.
/// </summary>
internal sealed class EffectsDocumentService
{
    private const int Version = 1;
    private const string Kind = "openslope-effects";
    /// <summary>Pre-rename spelling of <see cref="Kind"/>; accepted on read so Effects.json authored
    /// before the OpenSlope rename still loads. Only <see cref="Kind"/> is ever written.</summary>
    private const string LegacyKind = "swx-effects";
    private readonly ContractValidationService _contracts;

    public EffectsDocumentService(ContractValidationService contracts) => _contracts = contracts;

    public int Export(string[] args)
    {
        if (args.Length < 3)
        {
            Log.Error("effects-export needs <in.ssf> <out.effects.json> [--level NAME] [--executable BOOT-NAME] [--salvage-dangling-references]");
            return 1;
        }

        string input = Path.GetFullPath(args[1]);
        string output = Path.GetFullPath(args[2]);
        string level = Option(args, "--level") ?? Path.GetFileNameWithoutExtension(input).ToUpperInvariant();
        string? bootExecutable = Option(args, "--executable");
        SSFHandler original = LoadSsf(input);
        IReadOnlyList<string> salvaged = HasFlag(args, "--salvage-dangling-references")
            ? NeutralizeDanglingNodeReferences(original)
            : System.Array.Empty<string>();
        if (salvaged.Count != 0)
        {
            const int previewCount = 12;
            string preview = string.Join(", ", salvaged.Take(previewCount));
            string remainder = salvaged.Count > previewCount
                ? $", ... (+{salvaged.Count - previewCount:n0} more; complete list recorded in Effects.json)"
                : string.Empty;
            Log.Warn($"WARNING: salvaged {salvaged.Count:n0} dangling effect-node reference(s) as native nulls: " +
                              preview + remainder);
        }
        RequireValidSsf(original, input);

        JObject document = FromSsf(original, input, level, bootExecutable);
        if (salvaged.Count != 0)
        {
            ((JObject)document["extensions"]!)["snowknifeSalvage"] = new JObject
            {
                ["strategy"] = "null-dangling-node-references",
                ["references"] = new JArray(salvaged),
            };
        }
        string json = document.ToString(Formatting.Indented) + Environment.NewLine;
        _contracts.RequireJson(json, ContractKind.EffectsV1, output);
        SSFHandler reconstructed = ToSsf(document);
        RequireEquivalent(original, reconstructed, "Effects export adapter");

        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        File.WriteAllText(output, json);
        Log.Info(
            $"PASS {input} -> {output}: {original.EffectHeaders.Count:n0} graphs, " +
            $"{original.Functions.Count:n0} functions, {CountNodes(original):n0} nodes, " +
            $"{original.InstanceState.Count:n0} instance bindings");
        return 0;
    }

    public int Import(string[] args)
    {
        if (args.Length < 3)
        {
            Log.Error("effects-import needs <in.effects.json> <out.ssf>");
            return 1;
        }

        string input = Path.GetFullPath(args[1]);
        string output = Path.GetFullPath(args[2]);
        _contracts.RequireFile(input, ContractKind.EffectsV1);
        JObject document = LoadDocument(input);
        SSFHandler expected = ToSsf(document);
        RequireValidSsf(expected, input);

        Directory.CreateDirectory(Path.GetDirectoryName(output)!);
        expected.Save(output);
        SSFHandler actual = LoadSsf(output);
        RequireValidSsf(actual, output);
        RequireEquivalent(expected, actual, "Effects import save/reload");

        Log.Info(
            $"PASS {input} -> {output}: {actual.EffectHeaders.Count:n0} graphs, " +
            $"{actual.Functions.Count:n0} functions, {CountNodes(actual):n0} nodes, " +
            $"{actual.InstanceState.Count:n0} instance bindings");
        return 0;
    }

    public int Check(string[] args)
    {
        if (args.Length < 2)
        {
            Log.Error("effects-check needs <file.effects.json>");
            return 1;
        }

        string input = Path.GetFullPath(args[1]);
        _contracts.RequireFile(input, ContractKind.EffectsV1);
        JObject document = LoadDocument(input);
        SSFHandler expected = ToSsf(document);
        RequireValidSsf(expected, input);

        string temp = Path.Combine(Path.GetTempPath(), $"effects-check-{Guid.NewGuid():N}.ssf");
        try
        {
            expected.Save(temp);
            SSFHandler actual = LoadSsf(temp);
            RequireValidSsf(actual, temp);
            RequireEquivalent(expected, actual, "Effects check save/reload");
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }

        Log.Info(
            $"PASS {input}: version {Version}, {expected.EffectHeaders.Count:n0} graphs, " +
            $"{expected.Functions.Count:n0} functions, {CountNodes(expected):n0} nodes, " +
            $"{expected.InstanceState.Count:n0} instance bindings");
        return 0;
    }

    /// <summary>
    /// The build this document interoperates with, like a patch manifest's target. The boot executable's name is
    /// the disc's own (SYSTEM.CNF), supplied by callers that have the user's image open; a bare
    /// <c>effects-export</c> over a loose SSF has no disc to ask, and says so rather than guessing a region.
    /// </summary>
    private static JObject TargetBlock(string level, string? bootExecutable)
    {
        var target = new JObject { ["game"] = "ssx-tricky", ["platform"] = "ps2" };
        // SLxx_nnn.nn on disc -> SLxx-nnnnn, the disc-serial spelling.
        string? serial = bootExecutable is null
            ? null
            : System.Text.RegularExpressions.Regex.Replace(bootExecutable.Trim().ToUpperInvariant(), "[^A-Z0-9]", "");
        if (serial is { Length: > 4 }) serial = serial[..4] + "-" + serial[4..];
        target["region"] = serial switch
        {
            null => "unspecified",
            _ when serial.StartsWith("SLES", StringComparison.Ordinal) => "pal",
            _ when serial.StartsWith("SLUS", StringComparison.Ordinal) => "ntsc-u",
            _ when serial.StartsWith("SLPS", StringComparison.Ordinal) || serial.StartsWith("SLPM", StringComparison.Ordinal) => "ntsc-j",
            _ => "unspecified",
        };
        if (serial is not null) target["executable"] = serial;
        target["level"] = level;
        return target;
    }

    private static JObject FromSsf(SSFHandler h, string sourcePath, string level, string? bootExecutable)
    {
        var graphs = new JArray();
        for (int i = 0; i < h.EffectHeaders.Count; i++)
        {
            string id = Id("graph", i);
            graphs.Add(new JObject
            {
                ["id"] = id,
                ["originalIndex"] = i,
                ["name"] = $"Effect {i}",
                ["nodes"] = NodesFromSsf(h.EffectHeaders[i].Effects, id, h),
            });
        }

        var functions = new JArray();
        for (int i = 0; i < h.Functions.Count; i++)
        {
            string id = Id("function", i);
            functions.Add(new JObject
            {
                ["id"] = id,
                ["originalIndex"] = i,
                ["name"] = h.Functions[i].FunctionName,
                ["nodes"] = NodesFromSsf(h.Functions[i].Effects, id, h),
            });
        }

        RefineControlSemanticTypes(h, graphs, functions);

        var slots = new JArray();
        for (int i = 0; i < h.EffectSlots.Count; i++)
        {
            SSFHandler.EffectSlot s = h.EffectSlots[i];
            slots.Add(new JObject
            {
                ["id"] = Id("slot", i),
                ["originalIndex"] = i,
                ["name"] = $"EffectSlot {i}",
                ["circumstances"] = new JObject
                {
                    ["persistent"] = Ref("graph", s.Slot1, h.EffectHeaders.Count),
                    ["collision"] = Ref("graph", s.Slot2, h.EffectHeaders.Count),
                    ["slot3"] = Ref("graph", s.Slot3, h.EffectHeaders.Count),
                    ["slot4"] = Ref("graph", s.Slot4, h.EffectHeaders.Count),
                    ["trigger"] = Ref("graph", s.Slot5, h.EffectHeaders.Count),
                    ["slot6"] = Ref("graph", s.Slot6, h.EffectHeaders.Count),
                    ["slot7"] = Ref("graph", s.Slot7, h.EffectHeaders.Count),
                },
            });
        }

        var properties = new JArray();
        for (int i = 0; i < h.ObjectProperties.Count; i++)
        {
            SSFHandler.ObjectPropertiesStruct p = h.ObjectProperties[i];
            JObject data = JObject.FromObject(p);
            data.Remove("EffectSlotIndex");
            data.Remove("PhysicsIndex");
            data.Remove("CollisonModelIndex");
            properties.Add(new JObject
            {
                ["id"] = Id("property", i),
                ["originalIndex"] = i,
                ["data"] = data,
                ["references"] = new JObject
                {
                    ["effectSlot"] = Ref("slot", p.EffectSlotIndex, h.EffectSlots.Count),
                    ["physics"] = Ref("physics", p.PhysicsIndex, h.PhysicsHeaders.Count),
                    ["collisionModel"] = Ref("collision", p.CollisonModelIndex, h.CollisonModelPointers.Count),
                },
            });
        }

        var instances = new JArray();
        for (int i = 0; i < h.InstanceState.Count; i++)
        {
            instances.Add(new JObject
            {
                ["id"] = Id("instance", i, 6),
                ["originalIndex"] = i,
                ["property"] = Ref("property", h.InstanceState[i], h.ObjectProperties.Count),
            });
        }

        var physics = new JArray();
        for (int i = 0; i < h.PhysicsHeaders.Count; i++)
        {
            JObject data = JObject.FromObject(h.PhysicsHeaders[i]);
            data.Remove("Offset");
            data.Remove("ByteSize");
            data.Remove("Count");
            foreach (JObject item in data["PhysicsDatas"]?.Children<JObject>() ?? Enumerable.Empty<JObject>())
                item.Remove("EndAlignment");
            physics.Add(Resource(Id("physics", i), i, data));
        }

        var collisionModels = new JArray();
        for (int i = 0; i < h.CollisonModelPointers.Count; i++)
        {
            JObject data = JObject.FromObject(h.CollisonModelPointers[i]);
            data.Remove("Offset");
            data.Remove("ByteSize");
            data.Remove("Count");
            foreach (JObject model in data["Models"]?.Children<JObject>() ?? Enumerable.Empty<JObject>())
                model.Remove("VerticeOffsetAlign");
            collisionModels.Add(Resource(Id("collision", i), i, data));
        }

        var splines = new JArray();
        for (int i = 0; i < h.Splines.Count; i++)
            splines.Add(Resource(Id("spline", i), i, JObject.FromObject(h.Splines[i])));

        return new JObject
        {
            ["$schema"] = "openslope-effects-v1.schema.json",
            ["kind"] = Kind,
            ["version"] = Version,
            ["target"] = TargetBlock(level, bootExecutable),
            ["source"] = new JObject
            {
                ["fileName"] = Path.GetFileName(sourcePath),
                ["byteLength"] = new FileInfo(sourcePath).Length,
                ["sha256"] = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(sourcePath))).ToLowerInvariant(),
            },
            ["header"] = new JObject { ["U1"] = h.U1, ["U2"] = h.U2, ["U3"] = h.U3 },
            ["slots"] = slots,
            ["graphs"] = graphs,
            ["functions"] = functions,
            ["objectProperties"] = properties,
            ["instances"] = instances,
            ["physics"] = physics,
            ["collisionModels"] = collisionModels,
            ["splines"] = splines,
            ["extensions"] = new JObject(),
        };
    }

    private static JArray NodesFromSsf(List<SSFHandler.Effect> effects, string ownerId, SSFHandler h)
    {
        var nodes = new JArray();
        for (int i = 0; i < effects.Count; i++)
        {
            SSFHandler.Effect effect = effects[i];
            JObject payload = JObject.FromObject(effect);
            payload.Remove("Offset");
            payload.Remove("ByteSize");
            payload.Remove("MainType");
            var references = new JObject();

            if (effect.MainType == 7 && payload["Instance"] is JObject instance)
            {
                references["instance"] = Ref("instance", instance.Value<int>("InstanceIndex"), h.InstanceState.Count, 6);
                references["effectGraph"] = Ref("graph", instance.Value<int>("EffectIndex"), h.EffectHeaders.Count);
                instance.Remove("InstanceIndex");
                instance.Remove("EffectIndex");
            }
            else if (effect.MainType == 21)
            {
                references["function"] = Ref("function", payload.Value<int>("FunctionRunIndex"), h.Functions.Count);
                payload.Remove("FunctionRunIndex");
            }
            else if (effect.MainType == 24)
            {
                references["instance"] = Ref("instance", payload.Value<int>("TeleportInstanceIndex"), h.InstanceState.Count, 6);
                payload.Remove("TeleportInstanceIndex");
            }
            else if (effect.MainType == 25 && payload["Spline"] is JObject spline)
            {
                references["spline"] = Ref("spline", spline.Value<int>("SplineIndex"), h.Splines.Count);
                spline.Remove("SplineIndex");
            }

            if (effect.MainType == 2 && payload["type2"] is JObject type2 &&
                type2.Value<int>("SubType") == 1 && type2["SplineAnimation"] is JObject animation)
            {
                references["spline"] = Ref("spline", animation.Value<int>("SplineIndex"), h.Splines.Count);
                animation.Remove("SplineIndex");
            }

            nodes.Add(new JObject
            {
                ["id"] = $"{ownerId}/node:{i:D4}",
                ["originalIndex"] = i,
                ["mainType"] = effect.MainType,
                ["semanticType"] = SemanticType(effect),
                ["payload"] = payload,
                ["references"] = references,
            });
        }
        return nodes;
    }

    private static SSFHandler ToSsf(JObject document)
    {
        ValidateDocument(document);
        JArray graphs = Array(document, "graphs");
        JArray functions = Array(document, "functions");
        JArray slots = Array(document, "slots");
        JArray properties = Array(document, "objectProperties");
        JArray instances = Array(document, "instances");
        JArray physics = Array(document, "physics");
        JArray collisions = Array(document, "collisionModels");
        JArray splines = Array(document, "splines");

        Dictionary<string, int> graphIds = Index(graphs, "graphs");
        Dictionary<string, int> functionIds = Index(functions, "functions");
        Dictionary<string, int> slotIds = Index(slots, "slots");
        Dictionary<string, int> propertyIds = Index(properties, "objectProperties");
        Dictionary<string, int> instanceIds = Index(instances, "instances");
        Dictionary<string, int> physicsIds = Index(physics, "physics");
        Dictionary<string, int> collisionIds = Index(collisions, "collisionModels");
        Dictionary<string, int> splineIds = Index(splines, "splines");

        JObject header = Object(document, "header");
        var h = new SSFHandler
        {
            U1 = header.Value<int?>("U1") ?? 1966592,
            U2 = header.Value<int?>("U2") ?? 1053952,
            U3 = header.Value<float?>("U3") ?? 0.006f,
            EffectSlots = new List<SSFHandler.EffectSlot>(),
            EffectHeaders = new List<SSFHandler.EffectHeaderStruct>(),
            Functions = new List<SSFHandler.Function>(),
            ObjectProperties = new List<SSFHandler.ObjectPropertiesStruct>(),
            InstanceState = new List<int>(),
            PhysicsHeaders = new List<SSFHandler.PhysicsHeader>(),
            CollisonModelPointers = new List<SSFHandler.CollisonModelPointer>(),
            Splines = new List<SSFHandler.Spline>(),
        };

        foreach (JObject graph in graphs.Children<JObject>())
        {
            List<SSFHandler.Effect> nodes = NodesToSsf(Array(graph, "nodes"), graphIds, functionIds, instanceIds, splineIds);
            h.EffectHeaders.Add(new SSFHandler.EffectHeaderStruct { EffectCount = nodes.Count, Effects = nodes });
        }
        foreach (JObject function in functions.Children<JObject>())
        {
            List<SSFHandler.Effect> nodes = NodesToSsf(Array(function, "nodes"), graphIds, functionIds, instanceIds, splineIds);
            h.Functions.Add(new SSFHandler.Function
            {
                Count = nodes.Count,
                FunctionName = function.Value<string>("name") ?? string.Empty,
                Effects = nodes,
            });
        }
        foreach (JObject slot in slots.Children<JObject>())
        {
            JObject c = Object(slot, "circumstances");
            h.EffectSlots.Add(new SSFHandler.EffectSlot
            {
                Slot1 = Resolve(c["persistent"], graphIds, "persistent"),
                Slot2 = Resolve(c["collision"], graphIds, "collision"),
                Slot3 = Resolve(c["slot3"], graphIds, "slot3"),
                Slot4 = Resolve(c["slot4"], graphIds, "slot4"),
                Slot5 = Resolve(c["trigger"], graphIds, "trigger"),
                Slot6 = Resolve(c["slot6"], graphIds, "slot6"),
                Slot7 = Resolve(c["slot7"], graphIds, "slot7"),
            });
        }
        foreach (JObject property in properties.Children<JObject>())
        {
            JObject data = (JObject)Object(property, "data").DeepClone();
            JObject refs = Object(property, "references");
            data["EffectSlotIndex"] = Resolve(refs["effectSlot"], slotIds, "effectSlot");
            data["PhysicsIndex"] = Resolve(refs["physics"], physicsIds, "physics");
            data["CollisonModelIndex"] = Resolve(refs["collisionModel"], collisionIds, "collisionModel");
            h.ObjectProperties.Add(Decode<SSFHandler.ObjectPropertiesStruct>(data, "objectProperties.data"));
        }
        foreach (JObject instance in instances.Children<JObject>())
            h.InstanceState.Add(Resolve(instance["property"], propertyIds, "instance.property"));
        foreach (JObject resource in physics.Children<JObject>())
            h.PhysicsHeaders.Add(Decode<SSFHandler.PhysicsHeader>(Object(resource, "data"), "physics.data"));
        foreach (JObject resource in collisions.Children<JObject>())
            h.CollisonModelPointers.Add(Decode<SSFHandler.CollisonModelPointer>(Object(resource, "data"), "collisionModels.data"));
        foreach (JObject resource in splines.Children<JObject>())
            h.Splines.Add(Decode<SSFHandler.Spline>(Object(resource, "data"), "splines.data"));

        NormalizeDerivedCounts(h);
        return h;
    }

    private static void NormalizeDerivedCounts(SSFHandler h)
    {
        h.EffectSlotsCount = h.EffectSlots.Count;
        h.PhysicsCount = h.PhysicsHeaders.Count;
        h.CollisonModelCount = h.CollisonModelPointers.Count;
        h.EffectsCount = h.EffectHeaders.Count;
        h.FunctionCount = h.Functions.Count;
        h.ObjectPropertiesCount = h.ObjectProperties.Count;
        h.InstanceCount = h.InstanceState.Count;
        h.SplineCount = h.Splines.Count;
        for (int i = 0; i < h.PhysicsHeaders.Count; i++)
        {
            SSFHandler.PhysicsHeader header = h.PhysicsHeaders[i];
            header.Count = header.PhysicsDatas?.Count ?? 0;
            h.PhysicsHeaders[i] = header;
        }
        for (int i = 0; i < h.CollisonModelPointers.Count; i++)
        {
            SSFHandler.CollisonModelPointer pointer = h.CollisonModelPointers[i];
            pointer.Count = pointer.Models?.Count ?? 0;
            if (pointer.Models != null)
            {
                for (int n = 0; n < pointer.Models.Count; n++)
                {
                    SSFHandler.CollisonModel model = pointer.Models[n];
                    model.FaceCount = (model.Index?.Count ?? 0) / 3;
                    model.VerticeCount = model.Vertices?.Count ?? 0;
                    pointer.Models[n] = model;
                }
            }
            h.CollisonModelPointers[i] = pointer;
        }
    }

    private static List<SSFHandler.Effect> NodesToSsf(
        JArray nodes,
        Dictionary<string, int> graphIds,
        Dictionary<string, int> functionIds,
        Dictionary<string, int> instanceIds,
        Dictionary<string, int> splineIds)
    {
        var result = new List<SSFHandler.Effect>();
        foreach (JObject node in nodes.Children<JObject>())
        {
            int mainType = node.Value<int>("mainType");
            JObject payload = (JObject)Object(node, "payload").DeepClone();
            JObject refs = node["references"] as JObject ?? new JObject();
            payload["MainType"] = mainType;

            if (mainType == 7)
            {
                JObject instance = payload["Instance"] as JObject ?? new JObject();
                instance["InstanceIndex"] = Resolve(refs["instance"], instanceIds, "node.instance");
                instance["EffectIndex"] = Resolve(refs["effectGraph"], graphIds, "node.effectGraph");
                payload["Instance"] = instance;
            }
            else if (mainType == 21)
                payload["FunctionRunIndex"] = Resolve(refs["function"], functionIds, "node.function");
            else if (mainType == 24)
                payload["TeleportInstanceIndex"] = Resolve(refs["instance"], instanceIds, "node.instance");
            else if (mainType == 25)
            {
                JObject spline = payload["Spline"] as JObject ?? new JObject();
                spline["SplineIndex"] = Resolve(refs["spline"], splineIds, "node.spline");
                payload["Spline"] = spline;
            }

            if (mainType == 2 && payload["type2"] is JObject type2 &&
                type2.Value<int>("SubType") == 1)
            {
                JObject animation = type2["SplineAnimation"] as JObject ?? new JObject();
                animation["SplineIndex"] = Resolve(refs["spline"], splineIds, "node.spline");
                type2["SplineAnimation"] = animation;
            }

            result.Add(Decode<SSFHandler.Effect>(payload, $"node '{node.Value<string>("id")}' payload"));
        }
        return result;
    }

    private static void ValidateDocument(JObject document)
    {
        var errors = new List<string>();
        if (document.Value<string>("kind") is not (Kind or LegacyKind)) errors.Add($"kind must be '{Kind}'");
        if (document.Value<int?>("version") != Version) errors.Add($"version must be {Version}");
        foreach (string name in new[] { "target", "header" })
            if (document[name] is not JObject) errors.Add($"{name} must be an object");
        foreach (string name in new[]
                 {
                     "slots", "graphs", "functions", "objectProperties", "instances", "physics", "collisionModels", "splines",
                 })
            if (document[name] is not JArray) errors.Add($"{name} must be an array");
        if (errors.Count != 0) throw new InvalidDataException("Invalid Effects document: " + string.Join("; ", errors));

        // Index() supplies duplicate/missing-ID checks. ToSsf then resolves every reference and fails on a dangling ID.
        foreach (string name in new[]
                 {
                     "slots", "graphs", "functions", "objectProperties", "instances", "physics", "collisionModels", "splines",
                 })
            _ = Index(Array(document, name), name);
        foreach (JObject graph in Array(document, "graphs").Children<JObject>()) ValidateNodes(graph, "graph");
        foreach (JObject function in Array(document, "functions").Children<JObject>()) ValidateNodes(function, "function");
    }

    private static void ValidateNodes(JObject owner, string ownerKind)
    {
        string ownerId = owner.Value<string>("id") ?? $"<{ownerKind}>";
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (JObject node in Array(owner, "nodes").Children<JObject>())
        {
            string? id = node.Value<string>("id");
            if (string.IsNullOrWhiteSpace(id)) throw new InvalidDataException($"{ownerId} has a node without an id");
            if (!seen.Add(id)) throw new InvalidDataException($"{ownerId} has duplicate node id '{id}'");
            if (node["mainType"]?.Type != JTokenType.Integer)
                throw new InvalidDataException($"node '{id}' mainType must be an integer");
            if (node["payload"] is not JObject)
                throw new InvalidDataException($"node '{id}' payload must be an object");
            if (node["semanticType"] is { } semanticToken)
            {
                if (semanticToken.Type != JTokenType.String || string.IsNullOrWhiteSpace(semanticToken.Value<string>()))
                    throw new InvalidDataException($"node '{id}' semanticType must be a non-empty string");
                string semanticType = semanticToken.Value<string>()!;
                if (!semanticType.StartsWith("x-", StringComparison.Ordinal))
                {
                    IReadOnlyList<string>? compatible = CompatibleSemanticTypes(node);
                    if (compatible != null && !compatible.Contains(semanticType, StringComparer.Ordinal))
                        throw new InvalidDataException(
                            $"node '{id}' semanticType '{semanticType}' is incompatible with its native mainType/payload; " +
                            $"expected {string.Join(" or ", compatible.Select(x => $"'{x}'"))}");
                }
            }
            if (node["references"] is not null and not JObject)
                throw new InvalidDataException($"node '{id}' references must be an object");
        }
    }

    private static IReadOnlyList<string>? CompatibleSemanticTypes(JObject node)
    {
        int mainType = node.Value<int>("mainType");
        JObject payload = (JObject)node["payload"]!;
        if (mainType == 0)
        {
            if (payload["type0"] is not JObject type0 || Integer(type0, "SubType") is not int subType) return null;
            return new[] { PropertySemanticType(subType, Integer(type0, "DeadNodeMode")) };
        }
        if (mainType == 2)
        {
            if (payload["type2"] is not JObject type2 || Integer(type2, "SubType") is not int subType) return null;
            return new[]
            {
                subType switch
                {
                    0 => "particle.timer",
                    1 => "spline.animation",
                    2 => "particle.collision",
                    _ => $"emitter.{subType}",
                },
            };
        }
        if (mainType is 3 or 9)
        {
            string payloadName = mainType == 3 ? "type3" : "type9";
            if (payload[payloadName] is not JObject control || Integer(control, "U0") is not int command) return null;
            var meanings = new List<string> { $"node.control.command-{command}" };
            if (command == 1) meanings.Add("counter.mark");
            if (command == 2) { meanings.Add("animation.delta-grant"); meanings.Add("material.texture-frame"); }
            if (command == 3) { meanings.Add("animation.combo-trigger"); meanings.Add("counter.decrement"); }
            if (command == 6) meanings.Add("material.uv-offset-v");
            if (command == 7) meanings.Add("instance.flag-0x800.clear");
            if (command == 8) meanings.Add("instance.flag-0x800.set");
            return meanings;
        }
        if (mainType == 5)
        {
            if (payload["type5"] is not JObject type5 || Integer(type5, "U0") is not int gate) return null;
            return new[]
            {
                gate switch
                {
                    0 => "condition.speed",
                    1 => "condition.random",
                    2 => "condition.human-rider",
                    3 => "condition.no-live-node",
                    _ => "condition.gate",
                },
            };
        }
        return new[]
        {
            mainType switch
            {
                4 => "wait",
                7 => "instance.state",
                8 => "audio.play",
                13 => "rider.reset",
                14 => "score.multiplier",
                16 => "time.bonus",
                17 => "rider.boost",
                18 => "trick.boost",
                21 => "function.call",
                23 => "camera.operation",
                24 => "rider.teleport",
                25 => "spline.toggle",
                26 => "function.call-detached",
                _ => $"main.{mainType}",
            },
        };
    }

    private static int? Integer(JObject owner, string name) =>
        owner[name]?.Type == JTokenType.Integer ? owner.Value<int>(name) : null;

    private static Dictionary<string, int> Index(JArray array, string name)
    {
        var result = new Dictionary<string, int>(StringComparer.Ordinal);
        for (int i = 0; i < array.Count; i++)
        {
            if (array[i] is not JObject item) throw new InvalidDataException($"{name}[{i}] must be an object");
            string? id = item.Value<string>("id");
            if (string.IsNullOrWhiteSpace(id)) throw new InvalidDataException($"{name}[{i}] has no id");
            if (!result.TryAdd(id, i)) throw new InvalidDataException($"{name} has duplicate id '{id}'");
        }
        return result;
    }

    private static int Resolve(JToken? token, Dictionary<string, int> ids, string path)
    {
        if (token == null || token.Type == JTokenType.Null) return -1;
        if (token.Type != JTokenType.String) throw new InvalidDataException($"{path} reference must be a string or null");
        string id = token.Value<string>()!;
        if (!ids.TryGetValue(id, out int index)) throw new InvalidDataException($"{path} references missing id '{id}'");
        return index;
    }

    private static JObject Resource(string id, int index, JObject data) => new()
    {
        ["id"] = id,
        ["originalIndex"] = index,
        ["data"] = data,
    };

    private static JValue Ref(string prefix, int index, int count, int width = 4)
    {
        if (index == -1) return JValue.CreateNull();
        if (index < 0 || index >= count)
            throw new InvalidDataException($"Cannot export {prefix} reference {index}; valid range is -1..{count - 1}");
        return new JValue(Id(prefix, index, width));
    }

    private static string Id(string prefix, int index, int width = 4) =>
        $"{prefix}:{index.ToString($"D{width}", CultureInfo.InvariantCulture)}";

    private static string SemanticType(SSFHandler.Effect effect)
    {
        if (effect.MainType == 0 && effect.type0 is { } type0) return PropertySemanticType(type0);
        if (effect.MainType == 2 && effect.type2 is { } type2) return type2.SubType switch
        {
            0 => "particle.timer",
            1 => "spline.animation",
            2 => "particle.collision",
            _ => $"emitter.{type2.SubType}",
        };
        if (effect.MainType == 3 && effect.type3 is { } type3) return $"node.control.command-{type3.U0}";
        if (effect.MainType == 5 && effect.type5 is { } type5) return type5.U0 switch
        {
            0 => "condition.speed",
            1 => "condition.random",
            2 => "condition.human-rider",
            3 => "condition.no-live-node",
            _ => "condition.gate",
        };
        if (effect.MainType == 9 && effect.type9 is { } type9) return $"node.control.command-{type9.U0}";
        return effect.MainType switch
        {
            4 => "wait",
            // Main type 12 is not a retail opcode - retail dispatches it to the inert default - but it is a
            // named member of the v1 schema's semanticType enum, so it takes a standard name rather than the
            // x- experimental namespace.
            12 => "hud.message",
            7 => "instance.state",
            8 => "audio.play",
            13 => "rider.reset",
            14 => "score.multiplier",
            16 => "time.bonus",
            17 => "rider.boost",
            18 => "trick.boost",
            21 => "function.call",
            23 => "camera.operation",
            24 => "rider.teleport",
            25 => "spline.toggle",
            26 => "function.call-detached",
            _ => $"main.{effect.MainType}",
        };
    }

    private static string PropertySemanticType(SSFHandler.Type0 type0) =>
        PropertySemanticType(type0.SubType, type0.DeadNodeMode);

    private static string PropertySemanticType(int subType, int? deadNodeMode) => subType switch
    {
        0 => "property.roller",
        2 => "property.debounce",
        5 => deadNodeMode switch
        {
            0 => "property.node-destroy",
            1 => "property.node-pause",
            2 => "property.node-tombstone",
            3 => "property.node-tombstone-flagged",
            4 => "property.breakable-kill",
            _ => "property.dead-node",
        },
        6 => "property.counter",
        7 => "property.boost",
        8 => "property.timer",
        9 => "property.rail",
        10 => "property.uv-scroll",
        11 => "property.texture-flip",
        12 => "property.fence",
        13 => "property.flag",
        14 => "property.cracked",
        15 => "property.lap-boost",
        16 => "property.random-boost",
        17 => "property.crowd-box",
        18 => "property.z-boost",
        19 => "property.uv-scroll-texture-flip",
        20 => "property.mesh-animation",
        21 => "property.trick-trigger",
        22 => "property.particle",
        23 => "property.movie",
        24 => "property.tube-end-boost",
        256 => "property.anim-object",
        257 => "property.anim-delta",
        258 => "property.anim-combo",
        259 => "property.anim-texture-flip",
        _ => $"property.{subType}",
    };

    /// <summary>
    /// Main types 3 and 9 are virtual control messages, not animation opcodes by themselves. The receiver is
    /// whichever property node is installed on the bound instance. Walk the retail graph wiring so the semantic
    /// label records the actual operation (texture frame, counter input, AnimDelta grant, and so on) without
    /// changing the native main type or payload.
    /// </summary>
    private static void RefineControlSemanticTypes(SSFHandler h, JArray graphs, JArray functions)
    {
        var candidates = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        int?[] persistentReceivers = Enumerable.Range(0, h.InstanceState.Count)
            .Select(index => PersistentReceiver(h, index)).ToArray();

        void Candidate(JObject node, SSFHandler.Effect effect, int? receiver)
        {
            int? command = effect.MainType switch
            {
                3 => effect.type3?.U0,
                9 => effect.type9?.U0,
                _ => null,
            };
            if (command is null) return;
            string label = ControlSemanticType(command.Value, receiver);
            string id = node.Value<string>("id")!;
            if (!candidates.TryGetValue(id, out HashSet<string>? labels))
                candidates[id] = labels = new HashSet<string>(StringComparer.Ordinal);
            labels.Add(label);
        }

        int? Walk(List<SSFHandler.Effect> effects, JArray nodes, int? receiver,
            int?[] instanceReceivers, HashSet<string> active)
        {
            int? current = receiver;
            for (int i = 0; i < effects.Count; i++)
            {
                SSFHandler.Effect effect = effects[i];
                JObject node = (JObject)nodes[i]!;
                if (effect.MainType == 0 && effect.type0 is { } property) current = property.SubType;
                else if (effect.MainType is 3 or 9) Candidate(node, effect, current);
                else if (effect.MainType == 7 && effect.Instance is { } instance &&
                         instance.InstanceIndex >= 0 && instance.InstanceIndex < instanceReceivers.Length &&
                         instance.EffectIndex >= 0 && instance.EffectIndex < h.EffectHeaders.Count)
                {
                    int targetInstance = instance.InstanceIndex;
                    string key = $"g:{instance.EffectIndex}:{instanceReceivers[targetInstance]?.ToString(CultureInfo.InvariantCulture) ?? "-"}";
                    if (active.Add(key))
                    {
                        instanceReceivers[targetInstance] = Walk(
                            h.EffectHeaders[instance.EffectIndex].Effects,
                            (JArray)((JObject)graphs[instance.EffectIndex]!)["nodes"]!,
                            instanceReceivers[targetInstance], instanceReceivers, active);
                        active.Remove(key);
                    }
                }
                else if (effect.MainType == 21 && effect.FunctionRunIndex >= 0 && effect.FunctionRunIndex < h.Functions.Count)
                {
                    string key = $"f:{effect.FunctionRunIndex}:{current?.ToString(CultureInfo.InvariantCulture) ?? "-"}";
                    if (active.Add(key))
                    {
                        current = Walk(h.Functions[effect.FunctionRunIndex].Effects,
                            (JArray)((JObject)functions[effect.FunctionRunIndex]!)["nodes"]!,
                            current, instanceReceivers, active);
                        active.Remove(key);
                    }
                }
            }
            return current;
        }

        // A few retail slots are not referenced by an instance-state entry (for example Megaplex slot 21),
        // but their sibling circumstances still target the receiver installed by the persistent graph.
        // Seed those graphs directly from the slot so unattached/reference-only effects receive the same
        // receiver-aware labels as effects reached through an instance.
        foreach (SSFHandler.EffectSlot slot in h.EffectSlots)
        {
            int? receiver = InstalledReceiver(h, slot.Slot1);
            if (receiver is null) continue;
            int[] graphIndices = { slot.Slot1, slot.Slot2, slot.Slot3, slot.Slot4, slot.Slot5, slot.Slot6, slot.Slot7 };
            foreach (int graphIndex in graphIndices)
            {
                if (graphIndex < 0 || graphIndex >= h.EffectHeaders.Count) continue;
                Walk(h.EffectHeaders[graphIndex].Effects,
                    (JArray)((JObject)graphs[graphIndex]!)["nodes"]!, receiver,
                    (int?[])persistentReceivers.Clone(), new HashSet<string>(StringComparer.Ordinal));
            }
        }

        for (int instanceIndex = 0; instanceIndex < h.InstanceState.Count; instanceIndex++)
        {
            int propertyIndex = h.InstanceState[instanceIndex];
            if (propertyIndex < 0 || propertyIndex >= h.ObjectProperties.Count) continue;
            int slotIndex = h.ObjectProperties[propertyIndex].EffectSlotIndex;
            if (slotIndex < 0 || slotIndex >= h.EffectSlots.Count) continue;
            SSFHandler.EffectSlot slot = h.EffectSlots[slotIndex];
            int[] graphIndices = { slot.Slot1, slot.Slot2, slot.Slot3, slot.Slot4, slot.Slot5, slot.Slot6, slot.Slot7 };
            foreach (int graphIndex in graphIndices)
            {
                if (graphIndex < 0 || graphIndex >= h.EffectHeaders.Count) continue;
                var instanceReceivers = (int?[])persistentReceivers.Clone();
                Walk(h.EffectHeaders[graphIndex].Effects,
                    (JArray)((JObject)graphs[graphIndex]!)["nodes"]!,
                    instanceReceivers[instanceIndex], instanceReceivers, new HashSet<string>(StringComparer.Ordinal));
            }
        }

        for (int i = 0; i < h.Functions.Count; i++)
            Walk(h.Functions[i].Effects, (JArray)((JObject)functions[i]!)["nodes"]!, null,
                (int?[])persistentReceivers.Clone(), new HashSet<string>(StringComparer.Ordinal));
        for (int i = 0; i < h.EffectHeaders.Count; i++)
            Walk(h.EffectHeaders[i].Effects, (JArray)((JObject)graphs[i]!)["nodes"]!, null,
                (int?[])persistentReceivers.Clone(), new HashSet<string>(StringComparer.Ordinal));

        foreach (JObject owner in graphs.Children<JObject>().Concat(functions.Children<JObject>()))
        foreach (JObject node in owner["nodes"]?.Children<JObject>() ?? Enumerable.Empty<JObject>())
        {
            string? id = node.Value<string>("id");
            if (id is null || !candidates.TryGetValue(id, out HashSet<string>? labels)) continue;
            string[] specific = labels.Where(label => !label.StartsWith("node.control.", StringComparison.Ordinal)).ToArray();
            if (specific.Distinct(StringComparer.Ordinal).Count() == 1) node["semanticType"] = specific[0];
        }
    }

    private static int? PersistentReceiver(SSFHandler h, int instanceIndex)
    {
        if (instanceIndex < 0 || instanceIndex >= h.InstanceState.Count) return null;
        int propertyIndex = h.InstanceState[instanceIndex];
        if (propertyIndex < 0 || propertyIndex >= h.ObjectProperties.Count) return null;
        int slotIndex = h.ObjectProperties[propertyIndex].EffectSlotIndex;
        if (slotIndex < 0 || slotIndex >= h.EffectSlots.Count) return null;
        return InstalledReceiver(h, h.EffectSlots[slotIndex].Slot1);
    }

    private static int? InstalledReceiver(SSFHandler h, int graphIndex)
    {
        if (graphIndex < 0 || graphIndex >= h.EffectHeaders.Count) return null;
        return h.EffectHeaders[graphIndex].Effects
            .Where(effect => effect.MainType == 0 && effect.type0 is not null)
            .Select(effect => (int?)effect.type0!.Value.SubType).LastOrDefault();
    }

    private static string ControlSemanticType(int command, int? receiver) => (receiver, command) switch
    {
        (257, 2) => "animation.delta-grant",
        (258, 3) => "animation.combo-trigger",
        (11, 2) => "material.texture-frame",
        (10, 6) => "material.uv-offset-v",
        (6, 1) => "counter.mark",
        (6, 3) => "counter.decrement",
        (_, 7) => "instance.flag-0x800.clear",
        (_, 8) => "instance.flag-0x800.set",
        _ => $"node.control.command-{command}",
    };

    private static JObject LoadDocument(string path)
    {
        if (!File.Exists(path)) throw new FileNotFoundException("Effects document not found", path);
        JToken token = JToken.Parse(File.ReadAllText(path));
        return token as JObject ?? throw new InvalidDataException("Effects document root must be an object");
    }

    private static SSFHandler LoadSsf(string path)
    {
        if (!File.Exists(path)) throw new FileNotFoundException("SSF not found", path);
        var h = new SSFHandler();
        h.Load(path);
        return h;
    }

    private static JArray Array(JObject owner, string name) =>
        owner[name] as JArray ?? throw new InvalidDataException($"{name} must be an array");

    private static JObject Object(JObject owner, string name) =>
        owner[name] as JObject ?? throw new InvalidDataException($"{name} must be an object");

    private static T Decode<T>(JObject value, string path)
    {
        try
        {
            var serializer = JsonSerializer.Create(new JsonSerializerSettings
            {
                MissingMemberHandling = MissingMemberHandling.Error,
            });
            using JsonReader reader = value.CreateReader();
            return serializer.Deserialize<T>(reader)!;
        }
        catch (JsonException ex)
        {
            throw new InvalidDataException($"{path} contains a field the SSF adapter cannot preserve: {ex.Message}", ex);
        }
    }

    private static string? Option(string[] args, string option)
    {
        for (int i = 0; i + 1 < args.Length; i++)
            if (args[i].Equals(option, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
        return null;
    }

    private static bool HasFlag(string[] args, string flag) =>
        args.Any(arg => arg.Equals(flag, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Replace only effect-node references whose native targets do not exist with the format's ordinary -1
    /// null. Valid nodes and every surrounding table remain byte-semantically represented. Structural damage
    /// in slots, instance bindings, properties, physics or collision is deliberately left for the strict
    /// validator to reject rather than being mistaken for a safe salvage.
    /// </summary>
    internal static IReadOnlyList<string> NeutralizeDanglingNodeReferences(SSFHandler h)
    {
        var repaired = new List<string>();
        static bool Dangling(int value, int count) => value < -1 || value >= count;

        void Nodes(List<SSFHandler.Effect> nodes, string owner)
        {
            for (int i = 0; i < nodes.Count; i++)
            {
                SSFHandler.Effect effect = nodes[i];
                string path = $"{owner}.nodes[{i}]";
                if (effect.MainType == 7 && effect.Instance is { } instance)
                {
                    if (Dangling(instance.InstanceIndex, h.InstanceState.Count))
                    {
                        repaired.Add(path + $".instance={instance.InstanceIndex}");
                        instance.InstanceIndex = -1;
                    }
                    if (Dangling(instance.EffectIndex, h.EffectHeaders.Count))
                    {
                        repaired.Add(path + $".effectGraph={instance.EffectIndex}");
                        instance.EffectIndex = -1;
                    }
                    effect.Instance = instance;
                }
                else if (effect.MainType == 21 && Dangling(effect.FunctionRunIndex, h.Functions.Count))
                {
                    repaired.Add(path + $".function={effect.FunctionRunIndex}");
                    effect.FunctionRunIndex = -1;
                }
                else if (effect.MainType == 24 && Dangling(effect.TeleportInstanceIndex, h.InstanceState.Count))
                {
                    repaired.Add(path + $".instance={effect.TeleportInstanceIndex}");
                    effect.TeleportInstanceIndex = -1;
                }
                else if (effect.MainType == 25 && effect.Spline is { } spline &&
                         Dangling(spline.SplineIndex, h.Splines.Count))
                {
                    repaired.Add(path + $".spline={spline.SplineIndex}");
                    spline.SplineIndex = -1;
                    effect.Spline = spline;
                }

                if (effect.MainType == 2 && effect.type2 is { SubType: 1, SplineAnimation: { } animation } emitter &&
                    Dangling(animation.SplineIndex, h.Splines.Count))
                {
                    repaired.Add(path + $".spline={animation.SplineIndex}");
                    animation.SplineIndex = -1;
                    emitter.SplineAnimation = animation;
                    effect.type2 = emitter;
                }
                nodes[i] = effect;
            }
        }

        for (int i = 0; i < h.EffectHeaders.Count; i++) Nodes(h.EffectHeaders[i].Effects, $"graphs[{i}]");
        for (int i = 0; i < h.Functions.Count; i++) Nodes(h.Functions[i].Effects, $"functions[{i}]");
        return repaired;
    }

    private static int CountNodes(SSFHandler h) =>
        h.EffectHeaders.Sum(graph => graph.Effects.Count) + h.Functions.Sum(function => function.Effects.Count);

    private static void RequireValidSsf(SSFHandler h, string owner)
    {
        var errors = new List<string>();
        static void Reference(List<string> into, string path, int value, int count)
        {
            if (value < -1 || value >= count) into.Add($"{path}={value} outside -1..{count - 1}");
        }

        for (int i = 0; i < h.EffectSlots.Count; i++)
        {
            SSFHandler.EffectSlot s = h.EffectSlots[i];
            int[] refs = { s.Slot1, s.Slot2, s.Slot3, s.Slot4, s.Slot5, s.Slot6, s.Slot7 };
            for (int n = 0; n < refs.Length; n++) Reference(errors, $"slots[{i}].slot{n + 1}", refs[n], h.EffectHeaders.Count);
        }
        for (int i = 0; i < h.InstanceState.Count; i++)
            Reference(errors, $"instances[{i}]", h.InstanceState[i], h.ObjectProperties.Count);
        for (int i = 0; i < h.ObjectProperties.Count; i++)
        {
            SSFHandler.ObjectPropertiesStruct p = h.ObjectProperties[i];
            Reference(errors, $"properties[{i}].effectSlot", p.EffectSlotIndex, h.EffectSlots.Count);
            if (p.CollsionMode == NativeCollisionMode.PhysicsBodySpheres)
                Reference(errors, $"properties[{i}].physics", p.PhysicsIndex, h.PhysicsHeaders.Count);
            else Reference(errors, $"properties[{i}].collisionModel", p.CollisonModelIndex, h.CollisonModelPointers.Count);
        }

        void Nodes(List<SSFHandler.Effect> nodes, string path)
        {
            for (int i = 0; i < nodes.Count; i++)
            {
                SSFHandler.Effect e = nodes[i];
                string p = $"{path}.nodes[{i}]";
                if (e.MainType == 7 && e.Instance is { } instance)
                {
                    Reference(errors, p + ".instance", instance.InstanceIndex, h.InstanceState.Count);
                    Reference(errors, p + ".effectGraph", instance.EffectIndex, h.EffectHeaders.Count);
                }
                else if (e.MainType == 21) Reference(errors, p + ".function", e.FunctionRunIndex, h.Functions.Count);
                else if (e.MainType == 24) Reference(errors, p + ".instance", e.TeleportInstanceIndex, h.InstanceState.Count);
                else if (e.MainType == 25 && e.Spline is { } spline)
                    Reference(errors, p + ".spline", spline.SplineIndex, h.Splines.Count);
                if (e.MainType == 2 && e.type2 is { SubType: 1, SplineAnimation: { } animation })
                    Reference(errors, p + ".spline", animation.SplineIndex, h.Splines.Count);
            }
        }

        for (int i = 0; i < h.EffectHeaders.Count; i++) Nodes(h.EffectHeaders[i].Effects, $"graphs[{i}]");
        for (int i = 0; i < h.Functions.Count; i++) Nodes(h.Functions[i].Effects, $"functions[{i}]");
        if (errors.Count != 0)
            throw new InvalidDataException($"Invalid SSF graph in {owner}:{Environment.NewLine}  " + string.Join(Environment.NewLine + "  ", errors));
    }

    private static void RequireEquivalent(SSFHandler expected, SSFHandler actual, string operation)
    {
        JToken left = SemanticSnapshot(expected);
        JToken right = SemanticSnapshot(actual);
        if (!JToken.DeepEquals(left, right))
        {
            (string path, string expectedValue, string actualValue) = FirstDifference(left, right, "$");
            throw new InvalidDataException(
                $"{operation} changed SSF semantics at {path}: expected {expectedValue}, got {actualValue}");
        }
    }

    private static JObject SemanticSnapshot(SSFHandler h)
    {
        JObject root = JObject.FromObject(h);
        foreach (string name in new[]
                 {
                     "EffectSlotsOffset", "PhysicsOffset", "CollisonModelOffset", "EffectsOffset",
                     "FunctionOffset", "ObjectPropertiesOffset", "InstanceOffset", "SplineOffset",
                 }) root.Remove(name);
        foreach (JObject header in root["PhysicsHeaders"]?.Children<JObject>() ?? Enumerable.Empty<JObject>())
        {
            header.Remove("Offset"); header.Remove("ByteSize");
            foreach (JObject data in header["PhysicsDatas"]?.Children<JObject>() ?? Enumerable.Empty<JObject>())
                data.Remove("EndAlignment");
        }
        foreach (JObject pointer in root["CollisonModelPointers"]?.Children<JObject>() ?? Enumerable.Empty<JObject>())
        {
            pointer.Remove("Offset"); pointer.Remove("ByteSize");
            foreach (JObject model in pointer["Models"]?.Children<JObject>() ?? Enumerable.Empty<JObject>())
                model.Remove("VerticeOffsetAlign");
        }
        foreach (JObject graph in root["EffectHeaders"]?.Children<JObject>() ?? Enumerable.Empty<JObject>())
        {
            graph.Remove("EffectOffset");
            StripNodeLayout(graph["Effects"] as JArray);
        }
        foreach (JObject function in root["Functions"]?.Children<JObject>() ?? Enumerable.Empty<JObject>())
        {
            function.Remove("Offset");
            StripNodeLayout(function["Effects"] as JArray);
        }
        return root;
    }

    private static void StripNodeLayout(JArray? nodes)
    {
        if (nodes == null) return;
        foreach (JObject node in nodes.Children<JObject>()) { node.Remove("Offset"); node.Remove("ByteSize"); }
    }

    private static (string path, string expected, string actual) FirstDifference(JToken left, JToken right, string path)
    {
        if (left.Type != right.Type) return (path, left.Type.ToString(), right.Type.ToString());
        if (left is JObject lo && right is JObject ro)
        {
            foreach (string name in lo.Properties().Select(p => p.Name).Union(ro.Properties().Select(p => p.Name)))
            {
                if (lo[name] == null || ro[name] == null)
                    return ($"{path}.{name}", lo[name]?.ToString() ?? "<missing>", ro[name]?.ToString() ?? "<missing>");
                if (!JToken.DeepEquals(lo[name], ro[name])) return FirstDifference(lo[name]!, ro[name]!, $"{path}.{name}");
            }
        }
        else if (left is JArray la && right is JArray ra)
        {
            if (la.Count != ra.Count) return ($"{path}.Count", la.Count.ToString(), ra.Count.ToString());
            for (int i = 0; i < la.Count; i++)
                if (!JToken.DeepEquals(la[i], ra[i])) return FirstDifference(la[i]!, ra[i]!, $"{path}[{i}]");
        }
        return (path, left.ToString(Formatting.None), right.ToString(Formatting.None));
    }
}
