namespace Snowknife.Services;

/// <summary>Keep disc archive slots separate from namespaced map IDs.</summary>
internal static class TrickyCourse
{
    public static string Slot(string course)
    {
        string id = course.ToUpperInvariant();
        return id.StartsWith("TRICKY_", StringComparison.Ordinal) ? id[7..] : id;
    }

    public static string Id(string course) => "TRICKY_" + Slot(course);

    public static string ImportDirectory(string course, string? destination = null) =>
        Path.GetFullPath(destination ?? Path.Combine("Maps", Id(course)));
}
