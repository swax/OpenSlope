using System.Reflection;
using System.Text.Json;
using Json.Schema;

namespace Snowknife.Services;

internal enum ContractKind
{
    BundleManifestV3,
    PatchesV1,
    SplinesV1,
    SoundIndexV1,
    EnvironmentAudioV1,
    BoardSoundIndexV1,
    SkyRingV1,
    BillboardsV1,
    EffectsV1,
    PropOverrideV1,
    RepackManifestV1,
    WorldV1,
    OriginV1,
}

internal sealed class ContractValidationException : Exception
{
    public ContractValidationException(string message) : base(message) { }
    public ContractValidationException(string message, Exception innerException) : base(message, innerException) { }
}

/// <summary>
/// Loads the canonical JSON Schemas embedded in snowknife and applies them at every portable JSON
/// boundary. Schema validation establishes document shape; format-specific semantic checks still
/// run afterwards (stable references, file existence, SSF round trips, and so on).
/// </summary>
internal sealed class ContractValidationService
{
    private sealed record Definition(ContractKind Kind, string SchemaName, string ResourceSuffix);
    private sealed record ContractError(string Path, string Keyword, string Message);
    private sealed record Report(Definition Definition, IReadOnlyList<ContractError> Errors)
    {
        public bool IsValid => Errors.Count == 0;
    }

    private static readonly Definition[] Definitions =
    {
        new(ContractKind.BundleManifestV3, "bundle-manifest-v3.schema.json", ".schemas.bundle.bundle-manifest-v3.schema.json"),
        new(ContractKind.PatchesV1, "patches-v1.schema.json", ".schemas.course.patches-v1.schema.json"),
        new(ContractKind.SplinesV1, "splines-v1.schema.json", ".schemas.course.splines-v1.schema.json"),
        new(ContractKind.SoundIndexV1, "sound-index-v1.schema.json", ".schemas.course.sound-index-v1.schema.json"),
        new(ContractKind.EnvironmentAudioV1, "environment-audio-v1.schema.json", ".schemas.course.environment-audio-v1.schema.json"),
        new(ContractKind.BoardSoundIndexV1, "board-sound-index-v1.schema.json", ".schemas.shared.board-sound-index-v1.schema.json"),
        new(ContractKind.SkyRingV1, "sky-ring-v1.schema.json", ".schemas.course.sky-ring-v1.schema.json"),
        new(ContractKind.BillboardsV1, "billboards-v1.schema.json", ".schemas.course.billboards-v1.schema.json"),
        new(ContractKind.EffectsV1, "openslope-effects-v1.schema.json", ".schemas.authoring.openslope-effects-v1.schema.json"),
        new(ContractKind.PropOverrideV1, "prop-override-v1.schema.json", ".schemas.tooling.prop-override-v1.schema.json"),
        new(ContractKind.RepackManifestV1, "repack-manifest-v1.schema.json", ".schemas.tooling.repack-manifest-v1.schema.json"),
        new(ContractKind.WorldV1, "world-v1.schema.json", ".schemas.course.world-v1.schema.json"),
        new(ContractKind.OriginV1, "origin-v1.schema.json", ".schemas.course.origin-v1.schema.json"),
    };

    private readonly Dictionary<ContractKind, Definition> _definitions = Definitions.ToDictionary(d => d.Kind);
    private readonly Dictionary<ContractKind, Lazy<JsonSchema>> _schemas;

    public ContractValidationService()
    {
        _schemas = Definitions.ToDictionary(
            d => d.Kind,
            d => new Lazy<JsonSchema>(() => LoadSchema(d), LazyThreadSafetyMode.ExecutionAndPublication));
    }

    public void RequireFile(string path, ContractKind kind)
    {
        path = Path.GetFullPath(path);
        if (!File.Exists(path)) throw new ContractValidationException($"Contract document not found: {path}");
        try
        {
            using JsonDocument document = ParseContractFile(path, kind);
            Require(document.RootElement, kind, path);
        }
        catch (JsonException ex)
        {
            throw new ContractValidationException($"{path} is not valid JSON: {ex.Message}", ex);
        }
    }

    public void RequireJson(string json, ContractKind kind, string label)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            Require(document.RootElement, kind, label);
        }
        catch (JsonException ex)
        {
            throw new ContractValidationException($"{label} is not valid JSON: {ex.Message}", ex);
        }
    }

    public void RequireIfPresent(string path, ContractKind kind)
    {
        if (File.Exists(path)) RequireFile(path, kind);
    }

    public int ValidateCommand(string[] args)
    {
        if (args.Length < 2)
        {
            Log.Error("validate needs <json-file|directory>");
            return 1;
        }

        string target = Path.GetFullPath(args[1]);
        if (!File.Exists(target) && !Directory.Exists(target))
        {
            Log.Error($"validate: path not found: {target}");
            return 1;
        }

        bool explicitFile = File.Exists(target);
        string[] files = explicitFile
            ? new[] { target }
            : Directory.EnumerateFiles(target, "*.json", SearchOption.AllDirectories)
                .Where(IsCandidateFile)
                .OrderBy(p => p, StringComparer.OrdinalIgnoreCase)
                .ToArray();

        if (files.Length == 0)
        {
            Log.Error($"validate: no recognized contract documents under {target}");
            return 1;
        }

        int passed = 0, failed = 0, ignored = 0;
        foreach (string file in files)
        {
            try
            {
                ContractKind? hint = DetectFromFileName(file);
                using JsonDocument document = ParseContractFile(file, hint);
                ContractKind? kind = Detect(document.RootElement, file);
                if (kind == null)
                {
                    if (explicitFile)
                    {
                        Log.Error($"FAIL {file}");
                        Log.Error("  /: document is not a recognized Snowknife contract");
                        failed++;
                    }
                    else ignored++;
                    continue;
                }

                Report report = Evaluate(document.RootElement, kind.Value);
                if (report.IsValid)
                {
                    Log.Info($"PASS {file} ({report.Definition.SchemaName})");
                    passed++;
                }
                else
                {
                    Log.Error($"FAIL {file} ({report.Definition.SchemaName})");
                    PrintErrors(report.Errors);
                    failed++;
                }
            }
            catch (JsonException ex)
            {
                Log.Error($"FAIL {file}");
                Log.Error($"  /: invalid JSON: {ex.Message}");
                failed++;
            }
            catch (Exception ex)
            {
                Log.Error($"FAIL {file}");
                Log.Error($"  /: {ex.Message}");
                failed++;
            }
        }

        Log.Info($"Validated {passed + failed:n0} contract(s): {passed:n0} passed, {failed:n0} failed" +
                          (ignored == 0 ? "." : $", {ignored:n0} ignored."));
        return failed == 0 ? 0 : 2;
    }

    private void Require(JsonElement instance, ContractKind kind, string label)
    {
        Report report = Evaluate(instance, kind);
        if (report.IsValid) return;

        string detail = string.Join(Environment.NewLine,
            report.Errors.Take(20).Select(e => $"  {e.Path}: {e.Message}"));
        if (report.Errors.Count > 20)
            detail += $"{Environment.NewLine}  ... {report.Errors.Count - 20:n0} more error(s)";
        throw new ContractValidationException(
            $"{label} does not match {report.Definition.SchemaName}:{Environment.NewLine}{detail}");
    }

    private Report Evaluate(JsonElement instance, ContractKind kind)
    {
        Definition definition = _definitions[kind];
        var options = new EvaluationOptions { OutputFormat = OutputFormat.List };
        EvaluationResults results = _schemas[kind].Value.Evaluate(instance, options);
        if (results.IsValid) return new Report(definition, Array.Empty<ContractError>());

        var errors = new List<ContractError>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        CollectErrors(results, errors, seen);
        if (errors.Count == 0)
            errors.Add(new ContractError("/", "schema", "document failed schema validation"));
        return new Report(definition, errors);
    }

    private static void CollectErrors(EvaluationResults result, List<ContractError> errors, HashSet<string> seen)
    {
        // List output retains the failed alternatives inside a successful oneOf/anyOf. Once a result is valid,
        // none of its child diagnostics contributed to the document failure; descending into them produces
        // contradictory noise such as "string should be null" beside "null should be string".
        if (result.IsValid) return;

        if (result.Errors is { Count: > 0 })
        {
            string path = result.InstanceLocation.ToString();
            if (string.IsNullOrEmpty(path)) path = "/";
            foreach ((string keyword, string message) in result.Errors)
            {
                string key = $"{path}\n{keyword}\n{message}";
                if (seen.Add(key)) errors.Add(new ContractError(path, keyword, message));
            }
        }

        if (result.Details == null) return;
        foreach (EvaluationResults child in result.Details)
            CollectErrors(child, errors, seen);
    }

    private static void PrintErrors(IReadOnlyList<ContractError> errors)
    {
        const int limit = 20;
        foreach (ContractError error in errors.Take(limit))
            Log.Error($"  {error.Path}: {error.Message}");
        if (errors.Count > limit)
            Log.Error($"  ... {errors.Count - limit:n0} more error(s)");
    }

    private static ContractKind? Detect(JsonElement root, string path)
    {
        ContractKind? byName = DetectFromFileName(path);
        if (byName != null) return byName;

        bool namedManifest = Path.GetFileName(path).Equals("manifest.json", StringComparison.OrdinalIgnoreCase);
        bool underGltf = string.Equals(
            Path.GetFileName(Path.GetDirectoryName(path)), "gltf", StringComparison.OrdinalIgnoreCase);
        if (root.ValueKind != JsonValueKind.Object)
            return namedManifest ? (underGltf ? ContractKind.BundleManifestV3 : ContractKind.RepackManifestV1) : null;
        if (root.TryGetProperty("BundleVersion", out _)) return ContractKind.BundleManifestV3;
        if (root.TryGetProperty("Patches", out _)) return ContractKind.PatchesV1;
        if (root.TryGetProperty("Splines", out _)) return ContractKind.SplinesV1;
        if (root.TryGetProperty("Schema", out JsonElement schema) && schema.ValueKind == JsonValueKind.String &&
            schema.GetString() == SoundIndexDocument.SchemaId) return ContractKind.SoundIndexV1;
        if (root.TryGetProperty("Schema", out schema) && schema.ValueKind == JsonValueKind.String &&
            schema.GetString() == EnvironmentAudioDocument.SchemaId) return ContractKind.EnvironmentAudioV1;
        if (root.TryGetProperty("Schema", out schema) && schema.ValueKind == JsonValueKind.String &&
            schema.GetString() == BoardSoundIndexDocument.SchemaId) return ContractKind.BoardSoundIndexV1;
        if (root.TryGetProperty("Schema", out schema) && schema.ValueKind == JsonValueKind.String &&
            schema.GetString() == Export.SkyRingDocument.SchemaId) return ContractKind.SkyRingV1;
        if (root.TryGetProperty("Schema", out schema) && schema.ValueKind == JsonValueKind.String &&
            schema.GetString() == Export.BillboardsDocument.SchemaId) return ContractKind.BillboardsV1;
        if (root.TryGetProperty("Schema", out schema) && schema.ValueKind == JsonValueKind.String &&
            schema.GetString() == WorldConfig.SchemaId) return ContractKind.WorldV1;
        if (root.TryGetProperty("kind", out JsonElement kind) && kind.ValueKind == JsonValueKind.String &&
            // "swx-effects" is the pre-rename spelling, still on disk in Effects.json authored earlier.
            kind.GetString() is "openslope-effects" or "swx-effects") return ContractKind.EffectsV1;
        if (root.TryGetProperty("InputIso", out _) || root.TryGetProperty("OutputIso", out _))
            return ContractKind.RepackManifestV1;
        if (root.TryGetProperty("match", out _) || root.TryGetProperty("meshes", out _))
            return ContractKind.PropOverrideV1;
        if (namedManifest) return underGltf ? ContractKind.BundleManifestV3 : ContractKind.RepackManifestV1;
        return null;
    }

    private static ContractKind? DetectFromFileName(string path)
    {
        string name = Path.GetFileName(path);
        if (name.Equals("Patches.json", StringComparison.OrdinalIgnoreCase)) return ContractKind.PatchesV1;
        if (name.Equals("Splines.json", StringComparison.OrdinalIgnoreCase)) return ContractKind.SplinesV1;
        if (name.Equals(SoundIndexDocument.FileName, StringComparison.OrdinalIgnoreCase)) return ContractKind.SoundIndexV1;
        if (name.Equals(EnvironmentAudioDocument.FileName, StringComparison.OrdinalIgnoreCase)) return ContractKind.EnvironmentAudioV1;
        if (name.Equals(BoardSoundIndexDocument.FileName, StringComparison.OrdinalIgnoreCase)) return ContractKind.BoardSoundIndexV1;
        if (name.Equals(Export.SkyRingDocument.FileName, StringComparison.OrdinalIgnoreCase)) return ContractKind.SkyRingV1;
        if (name.Equals(Export.BillboardsDocument.FileName, StringComparison.OrdinalIgnoreCase)) return ContractKind.BillboardsV1;
        if (name.Equals("Effects.json", StringComparison.OrdinalIgnoreCase)) return ContractKind.EffectsV1;
        if (name.Equals(WorldConfig.FileName, StringComparison.OrdinalIgnoreCase)) return ContractKind.WorldV1;
        if (name.Equals("override.json", StringComparison.OrdinalIgnoreCase)) return ContractKind.PropOverrideV1;
        return null;
    }

    private static JsonDocument ParseContractFile(string path, ContractKind? kind)
    {
        var options = kind == ContractKind.PropOverrideV1
            ? new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip }
            : default;
        return JsonDocument.Parse(File.ReadAllBytes(path), options);
    }

    private static bool IsCandidateFile(string path)
    {
        string name = Path.GetFileName(path);
        return name.Equals("Patches.json", StringComparison.OrdinalIgnoreCase) ||
               name.Equals("Splines.json", StringComparison.OrdinalIgnoreCase) ||
               name.Equals(SoundIndexDocument.FileName, StringComparison.OrdinalIgnoreCase) ||
               name.Equals(EnvironmentAudioDocument.FileName, StringComparison.OrdinalIgnoreCase) ||
               name.Equals(BoardSoundIndexDocument.FileName, StringComparison.OrdinalIgnoreCase) ||
               name.Equals(Export.SkyRingDocument.FileName, StringComparison.OrdinalIgnoreCase) ||
               name.Equals(Export.BillboardsDocument.FileName, StringComparison.OrdinalIgnoreCase) ||
               name.Equals("Effects.json", StringComparison.OrdinalIgnoreCase) ||
               name.Equals("manifest.json", StringComparison.OrdinalIgnoreCase) ||
               name.Equals("override.json", StringComparison.OrdinalIgnoreCase);
    }

    private static JsonSchema LoadSchema(Definition definition)
    {
        Assembly assembly = typeof(ContractValidationService).Assembly;
        string resource = assembly.GetManifestResourceNames().SingleOrDefault(
            n => n.EndsWith(definition.ResourceSuffix, StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidOperationException(
                $"Embedded schema {definition.SchemaName} was not found. Available resources: " +
                string.Join(", ", assembly.GetManifestResourceNames()));

        using Stream stream = assembly.GetManifestResourceStream(resource)
            ?? throw new InvalidOperationException($"Could not open embedded schema {resource}");
        using JsonDocument document = JsonDocument.Parse(stream);
        JsonElement schemaJson = document.RootElement.Clone();
        return JsonSchema.Build(schemaJson, new BuildOptions
        {
            Dialect = Dialect.Draft202012,
            SchemaRegistry = new SchemaRegistry(),
        });
    }
}
