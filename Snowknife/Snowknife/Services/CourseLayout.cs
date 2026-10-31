using Newtonsoft.Json.Linq;

namespace Snowknife.Services;

internal static class CourseLayout
{
    public static JObject Ssx3(string course, IEnumerable<string> sections, bool chain = false)
    {
        string id = course.ToUpperInvariant(), section = id[5..];
        bool full = section == "ALL", peak = section.StartsWith("PEAK", StringComparison.Ordinal);
        string kind = full ? "full-mountain" : peak || chain ? "run-chain" : section.Contains('_') ? "connector" : section.Length == 1 ? "hub" : "run";
        var result = new JObject { ["MapType"] = kind, ["WorldId"] = "ssx-3:bam", ["SourceSections"] = new JArray(sections) };
        if (!full) result["ParentMap"] = peak || chain ? "SSX3_ALL" : "SSX3_PEAK" + (section[0] <= 'B' ? "1" : section[0] <= 'D' ? "2" : "3");
        if (kind == "connector") result["Connects"] = new JArray(section.Split('_').Select(part => "SSX3_" + part));
        return result;
    }
}
