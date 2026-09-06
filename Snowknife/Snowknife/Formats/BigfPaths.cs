namespace Snowknife.Formats;

/// <summary>
/// Path arithmetic for BIGF member names. Members are stored with backslashes (<c>mus\Song.mus</c>) on
/// every host, so <see cref="System.IO.Path"/> must not be used on them: on Linux and macOS a backslash is
/// an ordinary character and <c>Path.GetFileName(@"mus\Song.mus")</c> returns the whole string. That is how
/// the basename lookups passed on Windows while CI's Linux runner failed them.
/// </summary>
internal static class BigfPaths
{
    private static readonly char[] Separators = { '\\', '/' };

    /// <summary>The last segment of a member path, split on either separator, on any host.</summary>
    public static string FileName(string memberPath)
    {
        int cut = memberPath.LastIndexOfAny(Separators);
        return cut < 0 ? memberPath : memberPath[(cut + 1)..];
    }

    /// <summary>The last segment without its final extension, on any host.</summary>
    public static string FileNameWithoutExtension(string memberPath)
    {
        string name = FileName(memberPath);
        int dot = name.LastIndexOf('.');
        return dot < 0 ? name : name[..dot];
    }
}
