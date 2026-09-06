#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Per-instance object lighting (Instances.json): SSX lit every PLACED object individually - a cool
    // ambient sky-fill plus up to three warm directional "key" lights - independent of the terrain
    // lightmap. This service supplies the aggregate approximation used by avatar light probes and direct-OBJ
    // authoring. Bundle props use PropLighting's exact /256, three-direction payload instead.
    public class InstanceLighting
    {
        // Subset of the library's InstanceJson - just the fields we light from. Newtonsoft fills by name and
        // ignores the rest. Indexed by position, which matches Props.obj's "o inst{N}_..." group names.
        [Serializable] public class Instance
        {
            public float[] Location;
            // SSX's per-instance render flag. The game draws an instance only when this is set; the ones it
            // clears are invisible volumes - firework/event TRIGGERS, out-of-bounds RESET zones, radio-tower
            // PHANTOM collision boxes, hidden "broken screen" jumbotron variants - which carry placeholder art
            // (the red no-entry sheet 0052) that should never render. Default true so a missing field can never
            // hide a real prop. PropBuilder skips the geometry of instances where this is false.
            public bool Visable = true;
            public float[] LightColour1;
            public float[] LightColour2;
            public float[] LightColour3;
            public float[] AmbentLightColour;

            // Raw per-instance collision fields retained for diagnostics and older extraction helpers (docs/016).
            // Their interpretation follows [Trailmap: 130-collision-data, 370-world-interaction].
            // CollsionMode selects the shape. Exact-zero ResponseMass or PlayerBounce=false suppresses physical rider
            // response after contact; live mode-1 and mode-2 flag-off controls both dispatched effects and passed through.
            // Movement is selected separately by a collision Roller
            // effect in the bundle and its mass arrives as Divert.DynamicMass. JsonProperty preserves the raw disc name.
            public string InstanceName;
            public int    CollsionMode        = NativeCollision.TriangleProxy;
            [JsonProperty("U0")] public float ResponseMass = 1e30f;
            public bool   PlayerBounce        = true;
            public float  PlayerBounceAmmount = 0.5f;
            public int    EffectSlotIndex     = -1;
            public int    PhysicsIndex        = -1;
            // Does the player collide with this prop at all (SSX's PlayerCollision flag), and the name(s) of its
            // collision PROXY model(s). A collidable prop with an EMPTY CollsionModelPaths has no proxy mesh - the
            // game collides it via computed bounds, and CollisionBuilder.ImportComputedBoundsColliders gives it a
            // bounds BoxCollider (signs/billboards/jumbotrons). Default: not collidable, so a missing field never
            // invents a solid wall.
            public bool     PlayerCollision    = false;
            public string[] CollsionModelPaths;
            // Per-instance collision SOUND. CollisonSound is a global ADL sound-EVENT id (the game remaps it to a
            // course-bank slot (resolved by Snowknife into the bundle's explicit SoundClip; docs/009); IncludeSound flags that the
            // instance carried an ADL sound row. CollisionBuilder reads CollisonSound to give each computed-bounds
            // prop an impact AudioSource. Default: no sound (-1) so a missing field stays silent.
            public bool     IncludeSound       = false;
            public SoundSet Sounds;
        }
        [Serializable] public class SoundSet { public int CollisonSound = -1; }
        [Serializable] class InstanceFile { public List<Instance> Instances; }

        readonly ImportConfig _cfg;
        readonly string _path;          // absolute path to Instances.json
        List<Instance> _instances;      // lazy-loaded, cached for this import

        public InstanceLighting(ImportConfig cfg)
        {
            _cfg = cfg;
            _path = Path.Combine(Path.GetDirectoryName(Application.dataPath), cfg.LevelFolder + "/Instances.json");
        }

        // Load (and cache) the instance list; null if Instances.json is absent (lighting then disabled).
        public List<Instance> Load()
        {
            if (_instances != null) return _instances;
            if (!File.Exists(_path)) { Debug.LogWarning("OpenSlope: Instances.json not found at " + _path + " - object lighting disabled (copy it next to Props.obj)."); return null; }
            var data = JsonConvert.DeserializeObject<InstanceFile>(File.ReadAllText(_path));
            _instances = data?.Instances;
            return _instances;
        }

        // Probe aggregate: combine ambient + directional key lights into one 0..1 colour.
        // ambient (cool sky fill) + PropKeyFactor * sum(key lights) (warm sun), normalised and clamped.
        // Exact prop rendering does not call this approximation.
        public Color LightColour(Instance it)
        {
            if (it == null) return Color.white;
            Vector3 amb = Vec3(it.AmbentLightColour);
            Vector3 key = Vec3(it.LightColour1) + Vec3(it.LightColour2) + Vec3(it.LightColour3);
            Vector3 c = (amb + _cfg.PropKeyFactor * key) / Mathf.Max(1e-3f, _cfg.PropLightNorm);
            return new Color(Mathf.Clamp01(c.x), Mathf.Clamp01(c.y), Mathf.Clamp01(c.z), 1f);
        }

        // Probe split into two parts, each normalised to 0..1: the AMBIENT floor (cool
        // sky fill) and the FULL directional KEY colour (summed warm suns - NOT scaled by PropKeyFactor: that factor
        // flat-averages the keys for the single LightColour() path, while the directional path scales by N.L
        // instead). Used by the avatar SH approximation. Colour only; exact prop records keep the three source
        // directions separately.
        public void Split(Instance it, out Color ambient, out Color key)
        {
            if (it == null) { ambient = Color.white; key = Color.black; return; }
            float norm = Mathf.Max(1e-3f, _cfg.PropLightNorm);
            Vector3 amb = Vec3(it.AmbentLightColour) / norm;
            Vector3 k   = (Vec3(it.LightColour1) + Vec3(it.LightColour2) + Vec3(it.LightColour3)) / norm;
            ambient = new Color(Mathf.Clamp01(amb.x), Mathf.Clamp01(amb.y), Mathf.Clamp01(amb.z), 1f);
            key     = new Color(Mathf.Clamp01(k.x),   Mathf.Clamp01(k.y),   Mathf.Clamp01(k.z),   1f);
        }

        static Vector3 Vec3(float[] a) => (a != null && a.Length >= 3) ? new Vector3(a[0], a[1], a[2]) : Vector3.zero;
    }
}
#endif
