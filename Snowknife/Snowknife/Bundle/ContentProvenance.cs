using System.Text.Json;

namespace Snowknife.Bundle;

/// <summary>
/// Reads the authoring-side provenance guard and decides whether a bundle may enter an explicitly public
/// staging path. This is intentionally conservative: an ordinary extracted or legacy folder remains usable
/// locally, but a publisher has to start from a current Slopesmith export whose asset channels are classified.
/// </summary>
internal static class ContentProvenance
{
    internal const string Allowed = "allowed";
    internal const string ReviewRequired = "rights-review-required";
    internal const string RetailBlocked = "blocked-retail-derived";
    internal const string UnknownBlocked = "blocked-unknown";

    internal static BundleManifest.ProvenanceInfo Read(string levelDir)
    {
        string path = Path.Combine(levelDir, "Slopesmith.json");
        if (!File.Exists(path))
            return Unknown("no-current-slopesmith-provenance");

        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            JsonElement root = document.RootElement;
            if (!root.TryGetProperty("provenance", out JsonElement provenance)
                || provenance.ValueKind != JsonValueKind.Object)
                return Unknown("legacy-slopesmith-provenance");

            string source = provenance.TryGetProperty("source", out var sourceValue)
                ? sourceValue.GetString() ?? "unclassified-map-folder" : "unclassified-map-folder";
            string status = provenance.TryGetProperty("publicDistribution", out var statusValue)
                ? statusValue.GetString() ?? UnknownBlocked : UnknownBlocked;
            if (source != "slopesmith-authored"
                || status is not (Allowed or ReviewRequired or RetailBlocked))
                return Unknown("invalid-slopesmith-provenance");

            var reasons = new List<string>();
            if (provenance.TryGetProperty("reasons", out var reasonValues)
                && reasonValues.ValueKind == JsonValueKind.Array)
                foreach (var reason in reasonValues.EnumerateArray())
                    if (reason.ValueKind == JsonValueKind.String && reason.GetString() is { Length: > 0 } value)
                        reasons.Add(value);

            var result = new BundleManifest.ProvenanceInfo
            {
                Source = source,
                PublicDistribution = status,
                RetailDerived = provenance.TryGetProperty("retailDerived", out var retail)
                    && retail.ValueKind is JsonValueKind.True,
                UserSupplied = provenance.TryGetProperty("userSupplied", out var supplied)
                    && supplied.ValueKind is JsonValueKind.True,
                Reasons = reasons.Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToList(),
            };
            return IsConsistent(result) ? result : Unknown("inconsistent-slopesmith-provenance");
        }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException)
        {
            Log.Warn($"  WARN: Slopesmith.json provenance is unreadable ({error.Message}); public staging is blocked.");
            return Unknown("unreadable-slopesmith-provenance");
        }
    }

    internal static bool CanStagePublic(BundleManifest.ProvenanceInfo? provenance, bool confirmRights,
                                        out string message)
    {
        if (provenance is null || !IsConsistent(provenance))
        {
            message = "content provenance is missing, unknown, or internally inconsistent"
                + ReasonSuffix(provenance?.Reasons ?? []);
            return false;
        }
        if (provenance?.PublicDistribution == Allowed)
        {
            message = "authored-only content classification accepted";
            return true;
        }
        if (provenance?.PublicDistribution == ReviewRequired)
        {
            if (confirmRights)
            {
                message = "user confirmed rights for every user-supplied asset";
                return true;
            }
            message = "user-supplied assets require --confirm-rights";
            return false;
        }
        if (provenance?.PublicDistribution == RetailBlocked)
        {
            message = "retail-derived content must be replaced before public staging"
                + ReasonSuffix(provenance.Reasons);
            return false;
        }
        message = "content provenance is missing or unknown; re-export with the current Slopesmith"
            + ReasonSuffix(provenance?.Reasons ?? []);
        return false;
    }

    internal static BundleManifest.ProvenanceInfo ReadBundle(string manifestPath)
    {
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(manifestPath));
            if (!document.RootElement.TryGetProperty("Provenance", out var provenance)
                || provenance.ValueKind != JsonValueKind.Object)
                return Unknown("missing-bundle-provenance");
            var result = new BundleManifest.ProvenanceInfo
            {
                Source = provenance.TryGetProperty("Source", out var source)
                    ? source.GetString() ?? "unclassified-map-folder" : "unclassified-map-folder",
                PublicDistribution = provenance.TryGetProperty("PublicDistribution", out var status)
                    ? status.GetString() ?? UnknownBlocked : UnknownBlocked,
                RetailDerived = provenance.TryGetProperty("RetailDerived", out var retail)
                    && retail.ValueKind is JsonValueKind.True,
                UserSupplied = provenance.TryGetProperty("UserSupplied", out var supplied)
                    && supplied.ValueKind is JsonValueKind.True,
                Reasons = provenance.TryGetProperty("Reasons", out var reasons)
                    && reasons.ValueKind == JsonValueKind.Array
                    ? reasons.EnumerateArray().Where(x => x.ValueKind == JsonValueKind.String)
                        .Select(x => x.GetString()).Where(x => !string.IsNullOrWhiteSpace(x)).Cast<string>().ToList()
                    : [],
            };
            return IsConsistent(result) ? result : Unknown("inconsistent-bundle-provenance");
        }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException)
        {
            return Unknown($"unreadable-bundle-provenance:{error.GetType().Name}");
        }
    }

    private static BundleManifest.ProvenanceInfo Unknown(string reason) => new()
    {
        Source = "unclassified-map-folder",
        PublicDistribution = UnknownBlocked,
        Reasons = [reason],
    };

    private static bool IsConsistent(BundleManifest.ProvenanceInfo provenance)
    {
        if (provenance.Source != "slopesmith-authored") return false;
        return provenance.PublicDistribution switch
        {
            Allowed => !provenance.RetailDerived && !provenance.UserSupplied
                && provenance.Reasons.Count == 0,
            ReviewRequired => !provenance.RetailDerived && provenance.UserSupplied
                && provenance.Reasons.Count > 0
                && provenance.Reasons.All(reason => reason.StartsWith("user-", StringComparison.Ordinal)),
            RetailBlocked => provenance.RetailDerived
                && provenance.Reasons.Any(reason => reason.StartsWith("retail-", StringComparison.Ordinal)),
            _ => false,
        };
    }

    private static string ReasonSuffix(IEnumerable<string> reasons)
    {
        string joined = string.Join(", ", reasons);
        return joined.Length > 0 ? $" ({joined})" : "";
    }
}
