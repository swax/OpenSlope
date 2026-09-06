#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Emits SSX's speed/trick BOOST PADS as trigger volumes wired to the rideable board (spec 360, docs/040).
    // The pads are VISIBLE arrow decals (gold Mdl_SpeedBoost_Gold_*, red/green Mdl_TrickBoost_RedGreen_*); snowknife
    // bakes each one's footprint AABB + tier + its own particle layers into the bundle (manifest.BoostPads),
    // data-derived from the SSF effect graph (a pad's EffectSlotIndex -> a MainType-17 speed node or MainType-18 trick
    // node). Here we overlay an invisible BoxCollider(isTrigger) over each pad - exactly like the firework triggers
    // (TriggerBuilder) - carrying the boost-pad behaviour that:
    //   - SPEED pad: runs the board's timed boost (raise the top-speed cap + lean-gated forward thrust for a window
    //     scaled from the authored magnitude). This is the game's pad mechanic - it raises the cap + feeds the cruise
    //     drive, no instant velocity write (spec 360). The board's RiderProbe sweeps the volume while ridden.
    //   - TRICK pad: cosmetic only (burst + chime). A free-roam world has no trick/scoring system for the window to
    //     feed, and trick pads apply no upward launch [Trailmap: 360-speed-and-boost], so they don't move you.
    //
    // The CONTACT BURST is the pad's own authored MainType-2 emitters (9 layers on every shipped level), rendered by
    // the shared P6 path (P6EmitterBuilder) that already serves the fireworks, ambient bursts and continuous emitters -
    // so a pad flashes with the game's real particles rather than a hand-tinted stand-in.
    //
    // The pad also POPS on a cross - it snaps to nothing, holds, then grows back, like a gem (docs/023). That is a
    // DELIBERATE DIVERGENCE from the game, whose pads never disappear (their closing node is DeadNodeMode 2, not the
    // 4 that hides the source instance). It needs the decal diverted out of the merged static mesh, which PropsBundle
    // does as divert kind "boostpad" and PropBuilder realizes under BoostPadDecals.
    //
    // The importer tags the volume with a BoostPadMarker the platform wiring pass realizes into the runtime
    // behaviour; the rest are stock components that play with no extra wiring.
    public class BoostPadBuilder
    {
        readonly ImportConfig _cfg;
        public BoostPadBuilder(ImportConfig cfg) { _cfg = cfg; }

        public void Build(Transform root)
        {
            if (!_cfg.EmitBoostPads) return;

            // Replace any prior build so the standalone "OpenSlope/Refresh/Boost Pads" menu is re-runnable.
            var old = root.Find("BoostPads"); if (old != null) Object.DestroyImmediate(old.gameObject);

            var reader = new BundleManifestReader(_cfg);
            if (!reader.Exists || reader.BoostPads.Count == 0) return;   // no bundle / level has no boost pads

            var padRoot = new GameObject("BoostPads");
            padRoot.transform.SetParent(root, false);

            var p6 = new P6EmitterBuilder(_cfg);
            AudioClip speedChime = LoadChime(_cfg.BoostPadSpeedChimeClip);   // zbxsfx 115 (gold speed pad)
            AudioClip trickChime = LoadChime(_cfg.BoostPadTrickChimeClip);   // zbxsfx 114 (red/green trick pad)

            int speed = 0, trick = 0, withSparkle = 0, withChime = 0, withPop = 0, layerCount = 0;
            foreach (var pad in reader.BoostPads)
            {
                var go = new GameObject($"Boost_{pad.Index}_{pad.Name}");
                go.transform.SetParent(padRoot.transform, false);
                go.transform.localPosition = pad.Center;
                if (pad.ModeMask != 7)
                {
                    var mode = go.AddComponent<ModeVisibilityMarker>();
                    mode.ModeMask = pad.ModeMask;
                    int previewBit = _cfg.GateShowoffRails ? 4 : 2; // optional Freeride preview; Showoff by default
                    go.SetActive((pad.ModeMask & previewBit) != 0);
                }

                // Per [Trailmap: 130-collision-data], authored EffectTrigger_ volumes already carry an intentional box
                // size shared with Slopesmith and the ISO triangle proxy, so preserve it exactly. Extracted thin mode-2
                // pad AABBs retain the Unity fast-rider margin.
                bool authoredTrigger = pad.Name != null &&
                    pad.Name.StartsWith("EffectTrigger_", System.StringComparison.Ordinal);
                Vector3 triggerSize = authoredTrigger
                    ? pad.Size
                    : pad.Size + Vector3.one * (2f * _cfg.BoostPadTriggerInflate);
                NativeCollision.AddPassThroughBox(go, Vector3.zero, triggerSize,
                    authoredTrigger ? NativeCollision.TriangleProxy : NativeCollision.BoundingBox);

                // Speed pad -> a boost window scaled from the authored magnitude (5.0 -> 2.5 s at the default 0.5).
                // Trick pad -> no boost (cosmetic).
                float seconds = pad.Trick ? 0f : Mathf.Max(0f, pad.Value * _cfg.BoostPadSecondsPerUnit);

                // The pad's REAL contact burst, straight from its collision header. Parented to padRoot (not the
                // trigger) because P6 layer origins are level-root-local, exactly like the ambient emitters; the tier
                // colour comes from the authored colour ramp.
                ParticleSystem sparkle = null;
                if (_cfg.BoostPadParticles && pad.Layers != null && pad.Layers.Count > 0)
                {
                    sparkle = p6.BuildGroup(padRoot.transform, $"BoostFx_{pad.Index}", pad.Layers,
                        continuous: false, interactive: true);
                    if (sparkle != null) { withSparkle++; layerCount += pad.Layers.Count; }
                }
                AudioClip clip = pad.Trick ? trickChime : speedChime;   // code-driven: trick pad = zbxsfx 114, speed pad = 115 [Trailmap: 360-speed-and-boost]
                AudioSource chime = clip != null ? AttachChime(go, clip) : null;
                if (chime != null) withChime++;

                // The decal to pop. Present only when the pad was diverted out of the merged static mesh (PropsBundle
                // kind "boostpad"); without it the pad still bursts + chimes, it just doesn't vanish.
                Transform visual = _cfg.BoostPadPop ? FindPadVisual(root, pad.Index) : null;
                if (visual != null) withPop++;

                var mk = go.AddComponent<BoostPadMarker>();
                mk.Trick            = pad.Trick;
                mk.BoostSeconds     = seconds;
                mk.Cooldown         = _cfg.BoostPadCooldown;
                mk.MinRideSpeed     = _cfg.BoostPadMinRideSpeed;
                mk.sparkle          = sparkle;
                mk.chime            = chime;
                mk.chimeVolume      = 1f;
                mk.EffectSlotIndex  = pad.Slot;
                mk.padVisual         = visual;
                mk.popHoldDelay      = _cfg.BoostPadPopHoldDelay;
                mk.growBackDuration  = _cfg.BoostPadGrowBack;

                if (pad.Trick) trick++; else speed++;
            }

            Debug.Log($"OpenSlope: boost pads -> {speed} speed (timed auto-boost) + {trick} trick (cosmetic) under BoostPads, " +
                      $"{withSparkle} with an authored P6 burst ({layerCount} layer(s)), {withChime} with a chime, " +
                      $"{withPop} that pop + regrow. Each tagged BoostPadMarker " +
                      $"(speed window = magnitude x {_cfg.BoostPadSecondsPerUnit}s).");
        }

        // The diverted decal for this pad, built by PropBuilder.BuildBoostPadDecals as "Pad_{index}_{model}" under
        // BoostPadDecals. Matched on the index prefix so the model suffix can vary. Null when the level was bundled
        // before boost pads became a divert kind (the pad then stays welded in the merged mesh and simply never pops),
        // so an older bundle degrades to burst + chime instead of throwing.
        static Transform FindPadVisual(Transform root, int index)
        {
            var decals = root.Find("BoostPadDecals");
            if (decals == null) return null;
            string prefix = "Pad_" + index + "_";
            foreach (Transform child in decals)
                if (child.name.StartsWith(prefix, System.StringComparison.Ordinal)) return child;
            return null;
        }

        // A pad-cross chime clip (relative under the level's Audio/, e.g. "SFX/zbxsfx/115.wav"), or null if blank /
        // not decoded. The real slots are code-driven: speed pad = zbxsfx 115, trick pad = 114 [Trailmap: 360-speed-and-boost].
        AudioClip LoadChime(string rel)
        {
            if (string.IsNullOrEmpty(rel)) return null;
            var clip = AssetDatabase.LoadAssetAtPath<AudioClip>(_cfg.LevelFolder + "/Audio/" + rel);
            if (clip == null) Debug.LogWarning("OpenSlope: boost-pad chime clip not found '" + _cfg.LevelFolder + "/Audio/" +
                                               rel + "' - those pads cross silently. Decode the MAIN bank: " +
                                               "`snowknife bnk zbxsfx.bnk <out>/Audio/SFX`.");
            return clip;
        }

        // Hang the chime on the pad as a positional one-shot, tagged SpatialAudio so the platform wiring pass gives it a
        // spatial pairing (VRChat force-spatializes a bare source with a 40 m default that discards our rolloff) - the same
        // 3D recipe as the firework / gem sounds.
        AudioSource AttachChime(GameObject go, AudioClip clip)
        {
            var src = go.AddComponent<AudioSource>();
            src.clip = clip;
            src.playOnAwake = false;
            src.loop = false;
            src.volume = 1f;
            src.spatialBlend = 1f;
            src.dopplerLevel = 0f;
            src.rolloffMode = AudioRolloffMode.Linear;
            src.minDistance = _cfg.BoostPadChimeMinDistance;
            src.maxDistance = Mathf.Max(_cfg.BoostPadChimeMinDistance, _cfg.BoostPadChimeMaxDistance);
            go.AddComponent<SpatialAudio>();
            return src;
        }
    }
}
#endif
