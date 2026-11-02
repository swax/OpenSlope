namespace Snowknife.Repack;

/// <summary>Course identity for target-relative joins, without mistaking another game's bank for Tricky.</summary>
internal static class TrickyAssetIdentity
{
    public static bool TryLegacyCourse(string level, out string course)
    {
        course = level.ToUpperInvariant();
        if (course.StartsWith("TRICKY_", StringComparison.Ordinal)) course = course[7..];
        if (course is "GARI" or "MESA" or "ELYSIUM" or "SNOW" or "ALASKA" or "ALOHA"
            or "MEGAPLE" or "MERQUER" or "PIPE" or "UNTRACK" or "TRICK") return true;
        course = "";
        return false;
    }

    public static bool SameCourse(string source, string target)
    {
        if (!TryLegacyCourse(target, out string targetCourse)) return false;
        if (source.StartsWith("asset1:", StringComparison.Ordinal) || source.StartsWith("asset2:", StringComparison.Ordinal))
        {
            string[] parts = source.Split(':');
            bool individual = parts[0] == "asset2";
            int hashIndex = individual ? 5 : 3;
            if (parts.Length != (individual ? 6 : 4) || parts[hashIndex].Length != 64
                || !parts[hashIndex].All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f')
                || Uri.UnescapeDataString(parts[1]) != "ssx-tricky") return false;
            if (individual && (parts[3] is not ("prop" or "body")
                || !int.TryParse(Uri.UnescapeDataString(parts[4]), out int key) || key < 0)) return false;
            source = Uri.UnescapeDataString(parts[2]);
        }
        return TryLegacyCourse(source, out string sourceCourse) && sourceCourse == targetCourse;
    }
}
