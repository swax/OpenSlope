using Newtonsoft.Json;
using Snowknife.Engine;
using Snowknife.Services;

namespace Snowknife.Bundle;

/// <summary>
/// The Instances.json fields the bundle builders read (Newtonsoft binds by name; matches the Unity
/// importer's InstanceLighting/Instance DTO, incl. the game's "Visable"/"Ambent"/"Collsion"/"Ammount"
/// spellings). Defaults are the static/immovable case so a missing field never invents motion or a wall.
/// </summary>
public sealed class SsxInstance
{
    public bool Visable = true;
    public float[]? Location;
    public float[]? Rotation;
    public float[]? Scale;
    public float[]? LightColour1;
    public float[]? LightColour2;
    public float[]? LightColour3;
    public float[]? LightVector1;
    public float[]? LightVector2;
    public float[]? LightVector3;
    public float[]? AmbentLightColour;
    public string? InstanceName;
    public int CollsionMode = NativeCollisionMode.TriangleProxy;
    [JsonProperty("U0")]
    public float ResponseMass = 1e30f;
    public bool PlayerBounce = true;
    public float PlayerBounceAmmount = 0.5f;
    public bool PlayerCollision;
    public string[]? CollsionModelPaths;
    public int EffectSlotIndex = -1;   // firework TRIGGER volumes carry the SSF effect slot they fire (-1 = none)
    public int LTGState;               // 0=common, 1=RaceInstanceIndex, 2=GemIndex/native Showoff layer
    public int PhysicsIndex = -1;
    public int ModelID = -1;           // Models.json index (animated props read the model's clip + per-object meshes)
    public int SurfaceType = -1;       // ride surface audio class (12 = WOOD) [Trailmap: 420-audio-runtime]
    public SsxSoundSet? Sounds;
    // Canonical-map extension fields retain staged WAV identity and the explicit collision-shape gate.
    public string? SoundClip;
    public bool ExactCollisionProfile;

    public int CollisonSound => Sounds?.CollisonSound ?? -1;
}

public sealed class SsxSoundSet
{
    public int CollisonSound = -1;
    public List<SsxExternalSound>? ExternalSounds;
}

public sealed class SsxExternalSound
{
    public int U0;
    public int SoundIndex = -1;
    public float U2;
    public float U3;
    public float U4;
    public float U5;
    public float U6;
    public float U7;
    public float U8;
    public float U9;
    public float U10;
    public float U11;
    public string? SoundClip;
}

public static class SsxInstances
{
    public static List<SsxInstance>? Load(string levelDir)
    {
        string p = Path.Combine(levelDir, "Instances.json");
        if (!File.Exists(p)) return null;
        var instances = JsonConvert.DeserializeObject<InstFile>(File.ReadAllText(p))?.Instances;
        // A retail Instances.json stores an ADL event id, not a WAV. Resolve it once from the map-local index
        // Snowknife generated from this disc, so every downstream bundle record carries an explicit clip path.
        // Authored SoundClip values win: they name staged user WAVs rather than retail bank files.
        var soundIndex = SoundIndexDocument.Load(levelDir);
        if (instances != null && soundIndex != null)
            foreach (var instance in instances)
                if (string.IsNullOrEmpty(instance.SoundClip))
                    instance.SoundClip = soundIndex.CollisionClip(instance.CollisonSound);
        // Effects.json owns the instance→effect binding: the overlay stamps EffectSlotIndex/PhysicsIndex
        // from the document's stable references over the rows' native values.
        SsfLogic.ApplyInstanceBindings(levelDir, instances);
        return instances;
    }
    // Newtonsoft populates this field through reflection; a direct assignment would only add DTO boilerplate.
#pragma warning disable CS0649
    class InstFile { public List<SsxInstance>? Instances; }
#pragma warning restore CS0649
}
