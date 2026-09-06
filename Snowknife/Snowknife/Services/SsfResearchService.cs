using System.Globalization;
using System.Reflection;
using Newtonsoft.Json.Linq;
using SSX_Library;
using SSX_Library.FileHandlers.LevelFiles.Tricky.PS2;
using Snowknife.Engine;

namespace Snowknife.Services;

/// <summary>
/// P0 research/conformance tools for the Tricky SSF effect graph. These deliberately operate on the
/// uncompressed binary member so graph authoring can be proven independently of Slopesmith's future UI model.
/// </summary>
internal sealed class SsfResearchService
{
    private readonly IsoService _iso;
    private readonly BigArchiveService _big;
    private readonly RefpackService _refpack;

    public SsfResearchService(IsoService iso, BigArchiveService big, RefpackService refpack)
    {
        _iso = iso;
        _big = big;
        _refpack = refpack;
    }

    public int Check(string[] args)
    {
        if (args.Length < 2)
        {
            Log.Error("ssf-check needs <file.ssf|directory>");
            return 1;
        }

        string input = args[1];
        string[] files = File.Exists(input)
            ? new[] { Path.GetFullPath(input) }
            : Directory.Exists(input)
                ? Directory.GetFiles(input, "*.ssf", SearchOption.AllDirectories)
                    .OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToArray()
                : Array.Empty<string>();
        if (files.Length == 0)
        {
            Log.Error($"No .ssf files found: {input}");
            return 1;
        }

        int failed = 0;
        int emitterCount = 0;
        int emitterNonzeroU9ToU11 = 0;
        int[] emitterNonzeroOffsetComponents = new int[3];
        foreach (string file in files)
        {
            string temp = Path.Combine(Path.GetTempPath(), $"ssf-roundtrip-{Guid.NewGuid():N}.ssf");
            try
            {
                var original = Load(file);
                foreach (SSFHandler.Type2Sub0 emitter in Emitters(original))
                {
                    emitterCount++;
                    if (emitter.U9 != 0.0f || emitter.U10 != 0.0f || emitter.U11 != 0.0f)
                        emitterNonzeroU9ToU11++;
                    if (emitter.U9 != 0.0f) emitterNonzeroOffsetComponents[0]++;
                    if (emitter.U10 != 0.0f) emitterNonzeroOffsetComponents[1]++;
                    if (emitter.U11 != 0.0f) emitterNonzeroOffsetComponents[2]++;
                }
                var originalValidation = Validate(original);
                if (!ReportValidation(file, originalValidation))
                {
                    failed++;
                    continue;
                }

                JToken expected = SemanticSnapshot(original);
                original.Save(temp);
                var rebuilt = Load(temp);
                var rebuiltValidation = Validate(rebuilt);
                if (!ReportValidation(temp, rebuiltValidation))
                {
                    failed++;
                    continue;
                }

                JToken actual = SemanticSnapshot(rebuilt);
                if (!JToken.DeepEquals(expected, actual))
                {
                    (string path, string left, string right) = FirstDifference(expected, actual, "$" );
                    Log.Error($"FAIL {file}: semantic round-trip differs at {path}: {left} != {right}");
                    failed++;
                    continue;
                }

                Log.Info(
                    $"PASS {file}: {original.EffectSlots.Count} slots, {original.EffectHeaders.Count} headers, " +
                    $"{CountEffects(original):n0} nodes, {original.ObjectProperties.Count:n0} shared properties, " +
                    $"{original.InstanceState.Count:n0} instances; " +
                    $"{new FileInfo(file).Length:n0} -> {new FileInfo(temp).Length:n0} bytes");
            }
            catch (Exception ex)
            {
                Log.Error($"FAIL {file}: {ex.Message}");
                failed++;
            }
            finally
            {
                if (File.Exists(temp)) File.Delete(temp);
            }
        }

        Log.Info(
            $"Emitter offset census: {emitterCount:n0} Type2/Sub0 nodes; " +
            $"U9-U11 all-zero {emitterCount - emitterNonzeroU9ToU11:n0}, nonzero {emitterNonzeroU9ToU11:n0}; " +
            $"component nonzero U9/U10/U11={emitterNonzeroOffsetComponents[0]:n0}/" +
            $"{emitterNonzeroOffsetComponents[1]:n0}/{emitterNonzeroOffsetComponents[2]:n0}.");
        Log.Info($"SSF conformance: {files.Length - failed}/{files.Length} passed.");
        return failed == 0 ? 0 : 2;
    }

    public int Canary(string[] args)
    {
        if (args.Length < 3)
        {
            Log.Error(
                "ssf-canary needs <in.ssf> <out.ssf> --host N [--source-header N --source-node N] " +
                "[--mode persistent|collision|trigger] [--set U9=1000 U10=0 ...] [--force-host]");
            return 1;
        }

        CanaryOptions options;
        try { options = ParseCanaryOptions(args); }
        catch (ArgumentException ex)
        {
            Log.Error("Invalid ssf-canary options: " + ex.Message);
            return 1;
        }

        string input = args[1];
        string output = args[2];
        int host = options.Host;
        var handler = Load(input);
        if (host < 0 || host >= handler.InstanceState.Count)
            throw new InvalidDataException($"Host {host} is outside 0..{handler.InstanceState.Count - 1}.");

        int previousProperty = handler.InstanceState[host];
        if (previousProperty < 0 || previousProperty >= handler.ObjectProperties.Count)
            throw new InvalidDataException($"Host {host} points at invalid object-properties record {previousProperty}.");
        var hostProps = handler.ObjectProperties[previousProperty];
        int previousHostSlot = hostProps.EffectSlotIndex;
        if (hostProps.EffectSlotIndex != -1 && !options.ForceHost)
            throw new InvalidOperationException(
                $"Host {host} already uses effect slot {hostProps.EffectSlotIndex}; choose an effectless host or pass --force-host.");

        int sourceHeader = options.SourceHeader;
        int sourceNode = options.SourceNode;
        (sourceHeader, sourceNode) = FindEmitter(handler, sourceHeader, sourceNode);

        SSFHandler.Effect source = handler.EffectHeaders[sourceHeader].Effects[sourceNode];
        var type2 = source.type2!.Value;
        var emitter = type2.type2Sub0!.Value;
        foreach ((int field, string value) in options.Assignments) SetEmitterField(ref emitter, field, value);
        type2.type2Sub0 = emitter;
        source.type2 = type2;
        source.Offset = 0;
        source.ByteSize = 0;

        int newHeader = handler.EffectHeaders.Count;
        handler.EffectHeaders.Add(new SSFHandler.EffectHeaderStruct
        {
            Effects = new List<SSFHandler.Effect> { source },
        });

        string mode = options.Mode.ToLowerInvariant();
        var slot = new SSFHandler.EffectSlot
        {
            Slot1 = -1,
            Slot2 = -1,
            Slot3 = -1,
            Slot4 = -1,
            Slot5 = -1,
            Slot6 = -1,
            Slot7 = -1,
        };
        switch (mode)
        {
            case "persistent": slot.Slot1 = newHeader; break;
            case "collision": slot.Slot2 = newHeader; break;
            case "trigger": slot.Slot5 = newHeader; break;
            default: throw new ArgumentException("--mode must be persistent, collision, or trigger.");
        }

        int newSlot = handler.EffectSlots.Count;
        handler.EffectSlots.Add(slot);
        hostProps.EffectSlotIndex = newSlot;
        int newProperty = handler.ObjectProperties.Count;
        handler.ObjectProperties.Add(hostProps);
        handler.InstanceState[host] = newProperty;

        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(output))!);
        handler.Save(output);

        var verify = Load(output);
        var validation = Validate(verify);
        if (!ReportValidation(output, validation)) return 2;
        if (verify.EffectHeaders.Count != newHeader + 1 || verify.EffectSlots.Count != newSlot + 1 ||
            verify.InstanceState[host] != newProperty || verify.ObjectProperties[newProperty].EffectSlotIndex != newSlot)
            throw new InvalidDataException("Canary save/reload did not preserve the appended header, slot, and host reference.");
        var writtenEmitter = verify.EffectHeaders[newHeader].Effects.Single().type2!.Value.type2Sub0!.Value;
        VerifyEmitterOverrides(emitter, writtenEmitter, options.Assignments);

        var requestedOverrides = new JObject();
        foreach ((int field, _) in options.Assignments)
            requestedOverrides[$"U{field}"] = JToken.FromObject(GetEmitterField(writtenEmitter, field));

        var manifest = new JObject
        {
            ["kind"] = "ssf-emitter-canary",
            ["input"] = EvidencePath(input),
            ["output"] = EvidencePath(output),
            ["mode"] = mode,
            ["hostInstance"] = host,
            ["previousObjectProperties"] = previousProperty,
            ["newObjectProperties"] = newProperty,
            ["previousHostEffectSlot"] = previousHostSlot,
            ["newEffectSlot"] = newSlot,
            ["newEffectHeader"] = newHeader,
            ["sourceEffectHeader"] = sourceHeader,
            ["sourceEffectNode"] = sourceNode,
            ["requestedOverrides"] = requestedOverrides,
            ["emitter"] = JObject.FromObject(writtenEmitter),
        };
        string manifestPath = output + ".canary.json";
        File.WriteAllText(manifestPath, manifest.ToString());

        Log.Info(
            $"PASS canary: host {host} -> new slot {newSlot} ({mode}) -> new header {newHeader}; " +
            $"source {sourceHeader}:{sourceNode}; {options.Assignments.Count} overrides applied; " +
            $"{new FileInfo(input).Length:n0} -> {new FileInfo(output).Length:n0} bytes");
        Log.Info($"Manifest: {manifestPath}");
        return 0;
    }

    /// <summary>
    /// How a file is named inside a manifest. A canary manifest is evidence that gets archived and quoted
    /// in research notes, so it records where a file sat relative to the working directory rather than the
    /// machine that produced it; a path outside that directory keeps only its name.
    /// </summary>
    private static string EvidencePath(string path)
    {
        string full = Path.GetFullPath(path);
        string relative = Path.GetRelativePath(Directory.GetCurrentDirectory(), full);
        return Path.IsPathRooted(relative) || relative.StartsWith("..", StringComparison.Ordinal)
            ? Path.GetFileName(full)
            : relative.Replace('\\', '/');
    }

    public int InstallIso(string[] args)
    {
        if (args.Length < 5)
        {
            Log.Error("ssf-install-iso needs <source.iso> <LEVEL> <file.ssf> <out.iso>");
            return 1;
        }

        string sourceIso = Path.GetFullPath(args[1]);
        string level = args[2].ToUpperInvariant();
        string ssfPath = Path.GetFullPath(args[3]);
        string outputIso = Path.GetFullPath(args[4]);
        if (sourceIso.Equals(outputIso, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("ssf-install-iso requires a distinct output ISO; the source is never edited in place.");
        if (!File.Exists(sourceIso)) throw new FileNotFoundException("Source ISO not found.", sourceIso);
        if (!File.Exists(ssfPath)) throw new FileNotFoundException("SSF not found.", ssfPath);

        var authored = Load(ssfPath);
        var validation = Validate(authored);
        if (!ReportValidation(ssfPath, validation)) return 2;
        JToken expected = SemanticSnapshot(authored);

        string lower = level.ToLowerInvariant();
        string isoMember = $"DATA\\MODELS\\{level}.BIG";
        string scratch = Path.Combine(Path.GetTempPath(), "ssf-install-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(scratch);
        try
        {
            string originalBig = Path.Combine(scratch, lower + ".big");
            string rawOriginal = Path.Combine(scratch, "raw-original");
            string rebuiltBig = Path.Combine(scratch, lower + "-authored.big");
            _iso.ExtractFile(sourceIso, isoMember, originalBig);
            _big.RawExtractC0fb(originalBig, rawOriginal);

            string targetMember = Path.Combine(rawOriginal, "data", "models", lower + ".ssf");
            if (!File.Exists(targetMember))
                throw new FileNotFoundException($"{level}.BIG has no data/models/{lower}.ssf member.", targetMember);
            byte[] rawSsf = File.ReadAllBytes(ssfPath);
            File.WriteAllBytes(targetMember, _refpack.Compress(rawSsf));
            BIG.Create(BigType.C0FB, rawOriginal, rebuiltBig, useCompression: false, useBackslashes: false);

            Directory.CreateDirectory(Path.GetDirectoryName(outputIso)!);
            File.Copy(sourceIso, outputIso, overwrite: true);
            _iso.ReplaceFile(outputIso, isoMember, rebuiltBig);

            string verifyBig = Path.Combine(scratch, lower + "-verify.big");
            string rawVerify = Path.Combine(scratch, "raw-verify");
            string decodedVerify = Path.Combine(scratch, "decoded-verify");
            _iso.ExtractFile(outputIso, isoMember, verifyBig);
            _big.RawExtractC0fb(verifyBig, rawVerify);
            BIG.Extract(verifyBig, decodedVerify);

            string decodedSsf = Path.Combine(decodedVerify, "data", "models", lower + ".ssf");
            var installed = Load(decodedSsf);
            if (!JToken.DeepEquals(expected, SemanticSnapshot(installed)))
                throw new InvalidDataException("The SSF extracted back from the output ISO is not semantically equal to the authored input.");

            string targetRelative = Path.Combine("data", "models", lower + ".ssf");
            string[] originals = Directory.GetFiles(rawOriginal, "*", SearchOption.AllDirectories)
                .Select(p => Path.GetRelativePath(rawOriginal, p)).OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToArray();
            string[] verified = Directory.GetFiles(rawVerify, "*", SearchOption.AllDirectories)
                .Select(p => Path.GetRelativePath(rawVerify, p)).OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToArray();
            if (!originals.SequenceEqual(verified, StringComparer.OrdinalIgnoreCase))
                throw new InvalidDataException("Rebuilt BIG member list differs from the retail archive.");
            foreach (string relative in originals)
            {
                if (relative.Equals(targetRelative, StringComparison.OrdinalIgnoreCase)) continue;
                if (!File.ReadAllBytes(Path.Combine(rawOriginal, relative)).SequenceEqual(File.ReadAllBytes(Path.Combine(rawVerify, relative))))
                    throw new InvalidDataException($"Rebuilt BIG changed unrelated member {relative}.");
            }

            Log.Info(
                $"PASS ISO install: {level} SSF {rawSsf.Length:n0} bytes; all {originals.Length - 1} unrelated BIG members preserved byte-for-byte; " +
                $"verified from {outputIso}");
            return 0;
        }
        finally
        {
            if (Directory.Exists(scratch)) Directory.Delete(scratch, recursive: true);
        }
    }

    private static SSFHandler Load(string path)
    {
        var handler = new SSFHandler();
        handler.Load(path);
        return handler;
    }

    /// <summary>
    /// Drop every effect node that rides a spline the file does not carry: MainType 25 spline follows and
    /// MainType 2 / SubType 1 spline animations. A repack build regenerates the .ssf spline table from
    /// the custom mountain's own Splines.json while retaining the target level's effect graphs, so the
    /// donor's tram/gondola rides reference splines that no longer exist. Dropping the NODE (never the
    /// graph or function) keeps every header/function/slot index stable — an emptied function simply runs
    /// zero nodes. Returns how many nodes were dropped.
    /// </summary>
    public static int DropDanglingSplineNodes(SSFHandler h)
    {
        int splines = h.Splines.Count;
        bool Dangles(SSFHandler.Effect e) =>
            (e.MainType == 25 && e.Spline is { } follow && (follow.SplineIndex < -1 || follow.SplineIndex >= splines))
            || (e.MainType == 2 && e.type2 is { SubType: 1, SplineAnimation: { } anim }
                && (anim.SplineIndex < -1 || anim.SplineIndex >= splines));

        int dropped = 0;
        for (int i = 0; i < h.EffectHeaders.Count; i++)
        {
            var header = h.EffectHeaders[i];
            int removed = header.Effects.RemoveAll(Dangles);
            if (removed == 0) continue;
            header.EffectCount = header.Effects.Count;
            h.EffectHeaders[i] = header;
            dropped += removed;
        }
        for (int i = 0; i < h.Functions.Count; i++)
        {
            var fn = h.Functions[i];
            int removed = fn.Effects.RemoveAll(Dangles);
            if (removed == 0) continue;
            fn.Count = fn.Effects.Count;
            h.Functions[i] = fn;
            dropped += removed;
        }
        return dropped;
    }

    /// <summary>The validation errors ssf-check would report for an already-loaded file — exposed so
    /// repack can refuse to pack an .ssf its own validator would fail.</summary>
    public static IReadOnlyList<string> ValidationErrors(SSFHandler h) => Validate(h).Errors;

    private sealed record Validation(List<string> Errors, List<string> Warnings);

    private static Validation Validate(SSFHandler h)
    {
        var errors = new List<string>();
        var warnings = new List<string>();
        static void Ref(List<string> into, string path, int value, int count)
        {
            if (value < -1 || value >= count) into.Add($"{path}={value} is outside -1..{count - 1}");
        }

        for (int i = 0; i < h.EffectSlots.Count; i++)
        {
            var s = h.EffectSlots[i];
            int[] refs = { s.Slot1, s.Slot2, s.Slot3, s.Slot4, s.Slot5, s.Slot6, s.Slot7 };
            for (int n = 0; n < refs.Length; n++) Ref(errors, $"EffectSlots[{i}].Slot{n + 1}", refs[n], h.EffectHeaders.Count);
        }

        for (int i = 0; i < h.InstanceState.Count; i++)
            Ref(errors, $"InstanceState[{i}]", h.InstanceState[i], h.ObjectProperties.Count);
        for (int i = 0; i < h.ObjectProperties.Count; i++)
        {
            var p = h.ObjectProperties[i];
            Ref(errors, $"ObjectProperties[{i}].EffectSlotIndex", p.EffectSlotIndex, h.EffectSlots.Count);
            if (p.CollsionMode == NativeCollisionMode.PhysicsBodySpheres)
                Ref(errors, $"ObjectProperties[{i}].PhysicsIndex", p.PhysicsIndex, h.PhysicsHeaders.Count);
            else Ref(errors, $"ObjectProperties[{i}].CollisonModelIndex", p.CollisonModelIndex, h.CollisonModelPointers.Count);
        }

        for (int i = 0; i < h.EffectHeaders.Count; i++)
        {
            var header = h.EffectHeaders[i];
            if (header.EffectCount != header.Effects.Count)
                errors.Add($"EffectHeaders[{i}] declared {header.EffectCount} nodes but parsed {header.Effects.Count}");
            ValidateEffects(header.Effects, $"EffectHeaders[{i}]", h, errors, warnings);
        }
        for (int i = 0; i < h.Functions.Count; i++)
        {
            var fn = h.Functions[i];
            if (fn.Count != fn.Effects.Count)
                errors.Add($"Functions[{i}] declared {fn.Count} nodes but parsed {fn.Effects.Count}");
            ValidateEffects(fn.Effects, $"Functions[{i}]", h, errors, warnings);
        }

        return new Validation(errors, warnings);
    }

    private static void ValidateEffects(
        List<SSFHandler.Effect> effects, string owner, SSFHandler h, List<string> errors, List<string> warnings)
    {
        static void Ref(List<string> into, string path, int value, int count)
        {
            if (value < -1 || value >= count) into.Add($"{path}={value} is outside -1..{count - 1}");
        }

        for (int i = 0; i < effects.Count; i++)
        {
            var e = effects[i];
            string path = $"{owner}.Effects[{i}]";
            if (e.MainType == 7 && e.Instance is { } instance)
            {
                Ref(errors, path + ".InstanceIndex", instance.InstanceIndex, h.InstanceState.Count);
                Ref(errors, path + ".EffectIndex", instance.EffectIndex, h.EffectHeaders.Count);
            }
            else if (e.MainType == 21) Ref(errors, path + ".FunctionRunIndex", e.FunctionRunIndex, h.Functions.Count);
            else if (e.MainType == 25 && e.Spline is { } spline)
                Ref(errors, path + ".SplineIndex", spline.SplineIndex, h.Splines.Count);

            if (e.MainType != 2 || e.type2 is not { } type2) continue;
            if (type2.SubType == 1 && type2.SplineAnimation is { } animation)
                Ref(errors, path + ".SplineAnimation.SplineIndex", animation.SplineIndex, h.Splines.Count);
            if (type2.SubType != 0 || type2.type2Sub0 is not { } emitter) continue;
            if (emitter.U0 < 0) warnings.Add(path + $" emitter count U0={emitter.U0} is negative");
            if (emitter.U1 < 0 || emitter.U1 > 10) warnings.Add(path + $" substep U1={emitter.U1} is outside observed 0..10");
            if (emitter.U49 < 0 || emitter.U49 >= 38) warnings.Add(path + $" sprite U49={emitter.U49} is outside the 38-name retail bank");
            if (emitter.U50 < 0 || emitter.U50 > 10) warnings.Add(path + $" blend U50={emitter.U50} is outside observed 0..10");
        }
    }

    private static bool ReportValidation(string path, Validation validation)
    {
        foreach (string warning in validation.Warnings) Log.Warn($"WARN {path}: {warning}");
        foreach (string error in validation.Errors) Log.Error($"ERROR {path}: {error}");
        return validation.Errors.Count == 0;
    }

    private static JObject SemanticSnapshot(SSFHandler h)
    {
        var root = JObject.FromObject(h);
        foreach (string name in new[]
                 {
                     "EffectSlotsOffset", "PhysicsOffset", "CollisonModelOffset", "EffectsOffset",
                     "FunctionOffset", "ObjectPropertiesOffset", "InstanceOffset", "SplineOffset",
                 }) root.Remove(name);

        foreach (JObject header in root["PhysicsHeaders"]?.Children<JObject>() ?? Enumerable.Empty<JObject>())
        {
            header.Remove("Offset");
            header.Remove("ByteSize");
            foreach (JObject data in header["PhysicsDatas"]?.Children<JObject>() ?? Enumerable.Empty<JObject>())
                data.Remove("EndAlignment");
        }
        foreach (JObject pointer in root["CollisonModelPointers"]?.Children<JObject>() ?? Enumerable.Empty<JObject>())
        {
            pointer.Remove("Offset");
            pointer.Remove("ByteSize");
            foreach (JObject model in pointer["Models"]?.Children<JObject>() ?? Enumerable.Empty<JObject>())
                model.Remove("VerticeOffsetAlign");
        }
        foreach (JObject header in root["EffectHeaders"]?.Children<JObject>() ?? Enumerable.Empty<JObject>())
        {
            header.Remove("EffectOffset");
            StripEffectLayout(header["Effects"] as JArray);
        }
        foreach (JObject fn in root["Functions"]?.Children<JObject>() ?? Enumerable.Empty<JObject>())
        {
            fn.Remove("Offset");
            StripEffectLayout(fn["Effects"] as JArray);
        }
        return root;
    }

    private static void StripEffectLayout(JArray? effects)
    {
        if (effects == null) return;
        foreach (JObject effect in effects.Children<JObject>())
        {
            effect.Remove("Offset");
            effect.Remove("ByteSize");
        }
    }

    private static (string path, string left, string right) FirstDifference(JToken left, JToken right, string path)
    {
        if (left.Type != right.Type) return (path, left.Type.ToString(), right.Type.ToString());
        if (left is JObject lo && right is JObject ro)
        {
            foreach (string name in lo.Properties().Select(p => p.Name).Union(ro.Properties().Select(p => p.Name)))
            {
                if (lo[name] == null || ro[name] == null) return ($"{path}.{name}", lo[name]?.ToString() ?? "<missing>", ro[name]?.ToString() ?? "<missing>");
                if (!JToken.DeepEquals(lo[name], ro[name])) return FirstDifference(lo[name]!, ro[name]!, $"{path}.{name}");
            }
        }
        else if (left is JArray la && right is JArray ra)
        {
            if (la.Count != ra.Count) return (path + ".Count", la.Count.ToString(), ra.Count.ToString());
            for (int i = 0; i < la.Count; i++)
                if (!JToken.DeepEquals(la[i], ra[i])) return FirstDifference(la[i]!, ra[i]!, $"{path}[{i}]");
        }
        return (path, left.ToString(), right.ToString());
    }

    private static int CountEffects(SSFHandler h) =>
        h.EffectHeaders.Sum(header => header.Effects.Count) + h.Functions.Sum(fn => fn.Effects.Count);

    private static IEnumerable<SSFHandler.Type2Sub0> Emitters(SSFHandler h) =>
        h.EffectHeaders.SelectMany(header => header.Effects)
            .Concat(h.Functions.SelectMany(fn => fn.Effects))
            .Where(effect => effect.MainType == 2 && effect.type2 is { SubType: 0, type2Sub0: not null })
            .Select(effect => effect.type2!.Value.type2Sub0!.Value);

    private static (int header, int node) FindEmitter(SSFHandler h, int requestedHeader, int requestedNode)
    {
        // User input, not a caller bug: say which option and what the file allows.
        if (requestedHeader >= h.EffectHeaders.Count)
            throw new InvalidDataException($"--source-header {requestedHeader} is outside 0..{h.EffectHeaders.Count - 1}.");
        IEnumerable<int> headers = requestedHeader >= 0 ? new[] { requestedHeader } : Enumerable.Range(0, h.EffectHeaders.Count);
        foreach (int hi in headers)
        {
            var effects = h.EffectHeaders[hi].Effects;
            if (requestedNode >= effects.Count && requestedNode >= 0)
                throw new InvalidDataException($"--source-node {requestedNode} is outside 0..{effects.Count - 1} in header {hi}.");
            IEnumerable<int> nodes = requestedNode >= 0 ? new[] { requestedNode } : Enumerable.Range(0, effects.Count);
            foreach (int ni in nodes)
            {
                var e = effects[ni];
                if (e.MainType == 2 && e.type2 is { SubType: 0, type2Sub0: not null }) return (hi, ni);
            }
            if (requestedNode >= 0) break;
        }
        throw new InvalidDataException("No Type2/SubType0 emitter found at the requested source (or anywhere in the file).");
    }

    private sealed record CanaryOptions(
        int Host,
        int SourceHeader,
        int SourceNode,
        string Mode,
        bool ForceHost,
        IReadOnlyList<(int field, string value)> Assignments);

    private static CanaryOptions ParseCanaryOptions(string[] args)
    {
        int? host = null;
        int sourceHeader = -1;
        int sourceNode = -1;
        string mode = "persistent";
        bool forceHost = false;
        var assignments = new List<(int field, string value)>();
        var assignedFields = new HashSet<int>();

        void AddAssignment(string text)
        {
            (int field, string value) assignment = ParseEmitterAssignment(text);
            if (!assignedFields.Add(assignment.field))
                throw new ArgumentException($"Emitter field U{assignment.field} was assigned more than once.");
            assignments.Add(assignment);
        }

        for (int i = 3; i < args.Length; i++)
        {
            string token = args[i];
            if (token.Equals("--force-host", StringComparison.OrdinalIgnoreCase))
            {
                forceHost = true;
                continue;
            }
            if (TryReadCanaryOption(args, ref i, "--host", out string? value))
            {
                host = int.Parse(value!, NumberStyles.Integer, CultureInfo.InvariantCulture);
                continue;
            }
            if (TryReadCanaryOption(args, ref i, "--source-header", out value))
            {
                sourceHeader = int.Parse(value!, NumberStyles.Integer, CultureInfo.InvariantCulture);
                continue;
            }
            if (TryReadCanaryOption(args, ref i, "--source-node", out value))
            {
                sourceNode = int.Parse(value!, NumberStyles.Integer, CultureInfo.InvariantCulture);
                continue;
            }
            if (TryReadCanaryOption(args, ref i, "--mode", out value))
            {
                mode = value!;
                continue;
            }
            if (token.Equals("--set", StringComparison.OrdinalIgnoreCase))
            {
                int before = assignments.Count;
                while (i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal))
                    AddAssignment(args[++i]);
                if (assignments.Count == before)
                    throw new ArgumentException("--set requires one or more U0=value through U50=value assignments.");
                continue;
            }
            if (token.StartsWith("--set=", StringComparison.OrdinalIgnoreCase))
            {
                AddAssignment(token[6..]);
                continue;
            }
            throw new ArgumentException($"Unrecognized argument '{token}'.");
        }

        if (host == null) throw new ArgumentException("--host N is required.");
        return new CanaryOptions(host.Value, sourceHeader, sourceNode, mode, forceHost, assignments);
    }

    private static (int field, string value) ParseEmitterAssignment(string assignment)
    {
        string[] pair = assignment.Split('=', 2);
        if (pair.Length != 2 || pair[0].Length < 2 || (pair[0][0] != 'U' && pair[0][0] != 'u') ||
            !int.TryParse(pair[0][1..], out int field) || field is < 0 or > 50)
            throw new ArgumentException($"Invalid emitter assignment '{assignment}'; expected U0=value through U50=value.");
        if (pair[1].Length == 0)
            throw new ArgumentException($"Invalid emitter assignment '{assignment}'; the value is empty.");
        return (field, pair[1]);
    }

    private static bool TryReadCanaryOption(string[] args, ref int index, string name, out string? value)
    {
        string token = args[index];
        if (token.Equals(name, StringComparison.OrdinalIgnoreCase))
        {
            if (index + 1 >= args.Length || args[index + 1].StartsWith("--", StringComparison.Ordinal))
                throw new ArgumentException($"{name} requires a value.");
            value = args[++index];
            return true;
        }
        string prefix = name + "=";
        if (token.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            value = token[prefix.Length..];
            if (value.Length == 0) throw new ArgumentException($"{name} requires a value.");
            return true;
        }
        value = null;
        return false;
    }

    private static void VerifyEmitterOverrides(SSFHandler.Type2Sub0 expected, SSFHandler.Type2Sub0 actual,
        IReadOnlyList<(int field, string value)> assignments)
    {
        foreach ((int field, _) in assignments)
        {
            object expectedValue = GetEmitterField(expected, field);
            object actualValue = GetEmitterField(actual, field);
            if (!expectedValue.Equals(actualValue))
                throw new InvalidDataException(
                    $"Canary save/reload changed requested U{field}: expected {expectedValue}, got {actualValue}.");
        }
    }

    private static object GetEmitterField(SSFHandler.Type2Sub0 emitter, int field)
    {
        FieldInfo info = typeof(SSFHandler.Type2Sub0).GetField($"U{field}")
                         ?? throw new InvalidOperationException($"Type2Sub0 has no U{field} field.");
        return info.GetValue(emitter)!;
    }

    private static void SetEmitterField(ref SSFHandler.Type2Sub0 emitter, int field, string text)
    {
        FieldInfo info = typeof(SSFHandler.Type2Sub0).GetField($"U{field}")
                         ?? throw new InvalidOperationException($"Type2Sub0 has no U{field} field.");
        object value = info.FieldType == typeof(int)
            ? int.Parse(text, NumberStyles.Integer, CultureInfo.InvariantCulture)
            : float.Parse(text, NumberStyles.Float, CultureInfo.InvariantCulture);
        object boxed = emitter;
        info.SetValue(boxed, value);
        emitter = (SSFHandler.Type2Sub0)boxed;
    }

}
