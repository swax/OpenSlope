
using Newtonsoft.Json;

namespace Snowknife.Services;

/// <summary>
/// A course's world-configuration record, as far as we read it — the per-course block the executable carries
/// beside the sky colour ([Trailmap: 442-sky-color]). Today that means the CELESTIAL GLARE: whether the course
/// has a sun, the independent intensity and colour of its fan and lens sprite, where the sun sits and how big it is
/// ([Trailmap: 400-rendering], the celestial-glare section).
///
/// This is the portable form written to <c>Maps/&lt;NAME&gt;/World.json</c>. It exists so the values live in the
/// map beside the geometry that needs them rather than as constants inside a renderer: Slopesmith reads and
/// authors it, the Unity importer reads it, and an authored mountain writes its own without a disc anywhere
/// in the picture. Angles, sizes and distances stay in the game's own units and frame, the way every other
/// file in a map folder does; consumers convert.
/// </summary>
public sealed class WorldConfig
{
    public const string SchemaId = "openslope-world/v1";
    public const string FileName = "World.json";

    [JsonProperty("Schema")] public string Schema { get; set; } = SchemaId;

    /// <summary>The course slot this was read from, for provenance. Absent on an authored mountain.</summary>
    [JsonProperty("Course", NullValueHandling = NullValueHandling.Ignore)] public string? Course { get; set; }

    [JsonProperty("Glare", NullValueHandling = NullValueHandling.Ignore)] public CelestialGlare? Glare { get; set; }

    /// <summary>
    /// The sun and the beams it fans across the view. Nine of the thirteen shipped course slots leave
    /// <see cref="Enabled"/> clear, so a course carrying plausible values is not the same as a course that
    /// shows them — the flag is the only thing that decides.
    /// </summary>
    public sealed class CelestialGlare
    {
        [JsonProperty("Enabled")] public bool Enabled { get; set; }

        /// <summary>Colour of the screen-space triangle fan, 0-255 per channel.</summary>
        [JsonProperty("CoreColour")] public int[] CoreColour { get; set; } = new int[3];

        /// <summary>Per-course multiplier for the triangle fan.</summary>
        [JsonProperty("FanIntensity", Required = Required.Always)] public float FanIntensity { get; set; }

        /// <summary>Colour of the authored-radius soft corona sprite, 0-255 per channel.</summary>
        [JsonProperty("RimColour")] public int[] RimColour { get; set; } = new int[3];

        /// <summary>Per-course multiplier for the single soft corona sprite.</summary>
        [JsonProperty("SpriteIntensity", Required = Required.Always)] public float SpriteIntensity { get; set; }

        /// <summary>Azimuth of the sun in degrees, in the game's own frame.</summary>
        [JsonProperty("AzimuthDegrees")] public float AzimuthDegrees { get; set; }

        /// <summary>Elevation above the horizontal in degrees. Every shipped glare sits within 13° of it.</summary>
        [JsonProperty("ElevationDegrees")] public float ElevationDegrees { get; set; }

        /// <summary>How far along that direction the sun is placed, in game units (a course is ~100 000 across).</summary>
        [JsonProperty("DistanceUnits")] public float DistanceUnits { get; set; }

        /// <summary>World radius / half-extent of the sun corona, in game units. Not the reach of the beams.</summary>
        [JsonProperty("SizeUnits")] public float SizeUnits { get; set; }
    }

    // Field offsets inside the 148-byte record. Recovered in [Trailmap: 400-rendering];
    // the same record's +0x48/+0x4c/+0x50 are the sky colour the skycolor patch already reads.
    private const int OffEnabled = 0x00;
    private const int OffCoreR = 0x04, OffCoreG = 0x08, OffCoreB = 0x0c;
    private const int OffFanIntensity = 0x10;
    private const int OffSize = 0x14;
    private const int OffRimR = 0x18, OffRimG = 0x1c, OffRimB = 0x20;
    private const int OffSpriteIntensity = 0x24;
    private const int OffAzimuth = 0x28, OffElevation = 0x2c, OffDistance = 0x30;

    /// <summary>
    /// Decode one slot's record out of a recovered initializer frame (fp offset → stored 32-bit word).
    /// A field the initializer never wrote is simply absent and reads as zero, which is what the engine sees
    /// too — the frame starts zeroed. Integer and float fields are distinguished by which offset they sit at,
    /// not by how they were stored: a slot that writes a plain integer zero where a float belongs still
    /// decodes to 0.0, because the bit patterns agree.
    /// </summary>
    public static CelestialGlare DecodeGlare(IReadOnlyDictionary<int, uint> frame, int slot, int recordStride)
    {
        uint Word(int off) => frame.TryGetValue(slot * recordStride + off, out uint v) ? v : 0u;
        int Int(int off) => unchecked((int)Word(off));
        float Real(int off) => BitConverter.Int32BitsToSingle(unchecked((int)Word(off)));

        return new CelestialGlare
        {
            Enabled = Int(OffEnabled) != 0,
            CoreColour = new[] { Int(OffCoreR), Int(OffCoreG), Int(OffCoreB) },
            FanIntensity = Real(OffFanIntensity),
            RimColour = new[] { Int(OffRimR), Int(OffRimG), Int(OffRimB) },
            SpriteIntensity = Real(OffSpriteIntensity),
            AzimuthDegrees = Real(OffAzimuth),
            ElevationDegrees = Real(OffElevation),
            DistanceUnits = Real(OffDistance),
            SizeUnits = Real(OffSize),
        };
    }

    /// <summary>Read a map folder's World.json, or null when it has none or (with a warning naming it) cannot be
    /// parsed; every consumer degrades to no glare.</summary>
    public static WorldConfig? Read(string mapDir)
    {
        string path = Path.Combine(mapDir, FileName);
        if (!File.Exists(path)) return null;
        try { return JsonConvert.DeserializeObject<WorldConfig>(File.ReadAllText(path)); }
        catch (Exception e)
        {
            Log.Warn($"  WARN: {path} is unreadable ({e.Message}) — no glare for this map.");
            return null;
        }
    }

    public void Write(string mapDir)
    {
        File.WriteAllText(Path.Combine(mapDir, FileName),
            JsonConvert.SerializeObject(this, Formatting.Indented) + Environment.NewLine);
    }
}
