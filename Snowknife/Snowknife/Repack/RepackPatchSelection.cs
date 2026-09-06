namespace Snowknife.Repack;

/// <summary>
/// Executable features selected for a repack from its comma-separated <c>--patches</c> value.
/// </summary>
internal readonly record struct RepackPatchSelection(bool Noclip, bool HudText)
{
    private const string Choices = "noclip, hud-text";

    public static bool TryParse(string[] args, out RepackPatchSelection selection, out string? error)
    {
        bool noclip = false;
        bool hudText = false;

        for (int i = 0; i < args.Length; i++)
        {
            string? value = null;
            if (args[i] == "--patches")
            {
                if (i + 1 >= args.Length || args[i + 1].StartsWith('-'))
                {
                    selection = default;
                    error = $"--patches needs a comma-separated list ({Choices}).";
                    return false;
                }
                value = args[++i];
            }
            else if (args[i].StartsWith("--patches=", StringComparison.Ordinal))
            {
                value = args[i]["--patches=".Length..];
            }

            if (value == null) continue;
            string[] names = value.Split(',', StringSplitOptions.TrimEntries);
            if (names.Length == 0 || names.Any(string.IsNullOrEmpty))
            {
                selection = default;
                error = $"--patches needs a comma-separated list ({Choices}).";
                return false;
            }

            foreach (string raw in names)
            {
                switch (raw.ToLowerInvariant())
                {
                    case "noclip": noclip = true; break;
                    case "hud-text": hudText = true; break;
                    default:
                        selection = default;
                        error = $"unknown patch '{raw}' in --patches; choose from {Choices}.";
                        return false;
                }
            }
        }

        selection = new(noclip, hudText);
        error = null;
        return true;
    }
}
