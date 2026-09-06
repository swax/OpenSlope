using Newtonsoft.Json;

namespace Snowknife.Services;

/// <summary>
/// The engine-neutral, map-local environment-bed declaration. This is OpenSlope playback policy rather
/// than a claim about a retail map record: consumers use it only as the off-board fallback when the map has
/// no intro-music stems. Keeping the bank, slot, clip and mix in Maps means Unity and Slopesmith never need
/// their own Wind1 special case.
/// </summary>
public sealed class EnvironmentAudioDocument
{
    public const string FileName = "Environment.json";
    public const string SchemaId = "openslope-environment-audio/v1";
    public string Schema { get; set; } = SchemaId;
    public EnvironmentAudioBed? Bed { get; set; } = DefaultBed();

    public static EnvironmentAudioBed DefaultBed() => new()
    {
        Bank = "Wind1",
        Slot = 0,
        Clip = "Audio/SFX/Wind1/000.wav",
        Volume = 0.15f,
    };

    public static EnvironmentAudioDocument? Load(string levelDir)
    {
        string path = Path.Combine(levelDir, "Audio", FileName);
        if (!File.Exists(path)) return null;
        try
        {
            EnvironmentAudioDocument? document =
                JsonConvert.DeserializeObject<EnvironmentAudioDocument>(File.ReadAllText(path));
            return document?.Schema == SchemaId ? document : null;
        }
        catch (Exception e)
        {
            Log.Warn($"  WARN: {path} is unreadable ({e.Message}) — read as absent.");
            return null;
        }
    }

    public static void WriteDefault(string levelDir)
    {
        string audioDir = Path.Combine(levelDir, "Audio");
        Directory.CreateDirectory(audioDir);
        string path = Path.Combine(audioDir, FileName);
        string json = JsonConvert.SerializeObject(new EnvironmentAudioDocument(), Formatting.Indented)
            + Environment.NewLine;
        new ContractValidationService().RequireJson(json, ContractKind.EnvironmentAudioV1, path);
        File.WriteAllText(path, json);
    }
}

public sealed class EnvironmentAudioBed
{
    public string Bank { get; set; } = "";
    public int Slot { get; set; }
    public string Clip { get; set; } = "";
    public float Volume { get; set; }
}
