#if UNITY_EDITOR
using System.IO;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Emits SSX's MainType-24 TELEPORTS as Unity trigger volumes that warp the rider to a destination (spec
    // 390-teleport, docs/051). A teleport is a collision trigger whose SSF CollisionEffectSlot header carries a
    // MainType-24 node: on cross the game warps the rider to near the payload instance.
    // snowknife bakes each pair into the bundle (manifest.Teleports), data-derived from the effect graph (no name
    // match): the invisible START volume's box, the resolved DESTINATION instance's pivot, and any entry-cue
    // SoundPlay on the same header. A level may author one or more pairs (Mdl_TeleportStart_0 -> Mdl_TeleportExit_0, cue 122);
    // the other levels author none.
    //
    // Here we overlay each START volume with an invisible BoxCollider(isTrigger) - exactly like the firework
    // triggers (TriggerBuilder) and boost pads (BoostPadBuilder) - and drop a destination ANCHOR empty at the exit
    // pivot. Both live under the level root, so the recenter/scale/rotation carries them together and the anchor's
    // world pose stays the true landing spot. The trigger carries a TeleportMarker the platform wiring pass realizes
    // into the runtime teleport behaviour that, on the local rider's cross, warps them there: a walking player via the
    // platform's teleport call, a board rider via the board's own RespawnAt (station carry, no dismount). The chime +
    // anchor are stock objects that upload as-is.
    public class TeleportBuilder
    {
        readonly ImportConfig _cfg;
        public TeleportBuilder(ImportConfig cfg) { _cfg = cfg; }

        public void Build(Transform root)
        {
            if (!_cfg.EmitTeleports) return;

            // Replace any prior build so the standalone "OpenSlope/Refresh/Teleports" menu is re-runnable.
            var old = root.Find("Teleports"); if (old != null) Object.DestroyImmediate(old.gameObject);

            var reader = new BundleManifestReader(_cfg);
            if (!reader.Exists || reader.Teleports.Count == 0) return;   // no bundle / level has no teleports

            var tpRoot = new GameObject("Teleports");
            tpRoot.transform.SetParent(root, false);

            int made = 0, withChime = 0;
            foreach (var tp in reader.Teleports)
            {
                var go = new GameObject($"Teleport_{tp.Index}_{tp.Name}");
                go.transform.SetParent(tpRoot.transform, false);
                go.transform.localPosition = tp.Center;

                // Pass-through trigger over the START volume, optionally grown on each side - center/size are
                // root-local mesh-space units, like the firework/boost-pad volumes.
                var box = go.AddComponent<BoxCollider>();
                box.center = Vector3.zero;
                box.size = tp.Size + Vector3.one * (2f * _cfg.TeleportTriggerInflate);
                box.isTrigger = true;

                // Destination anchor: an empty at the exit pivot (root-local mesh space, sibling of the trigger under
                // Teleports), so its world position/rotation follows the level transform + recenter. the teleport behaviour reads
                // its world pose at cross time. Rotation is left at the level's forward (the exit instance authors no
                // meaningful facing); the teleport behaviour derives a heading along start->exit instead.
                var anchor = new GameObject($"Dest_{tp.Target}_{tp.TargetName}");
                anchor.transform.SetParent(tpRoot.transform, false);
                anchor.transform.localPosition = tp.Dest;

                AudioClip clip = LoadChime(tp.Sound);
                AudioSource chime = clip != null ? AttachChime(go, clip) : null;
                if (chime != null) withChime++;

                var mk = go.AddComponent<TeleportMarker>();
                mk.destination     = anchor.transform;
                mk.UpOffset        = _cfg.TeleportUpOffset;
                mk.Cooldown        = _cfg.TeleportCooldown;
                mk.chime           = chime;
                mk.chimeVolume     = _cfg.TeleportChimeVolume;
                mk.EffectSlotIndex = tp.Slot;
                made++;
            }

            Debug.Log($"OpenSlope: teleports -> {made} portal pair(s) under Teleports " +
                      $"({withChime} with an entry cue from {(_cfg.LevelSfxBank == "" ? "(no bank)" : _cfg.LevelSfxBank)}). " +
                      "Each tagged TeleportMarker (walking player -> TeleportTo, board rider -> RespawnAt).");
        }

        // The entry-cue clip for a teleport's SoundPlay id, from the level's own SFX bank (course-bank-local, the
        // same MainType-8 SoundPlay path the firework firing sounds use - Audio/SFX/<bank>/NNN.wav). -1 / no bank /
        // a missing decode -> null (the portal warps silently).
        AudioClip LoadChime(int sound)
        {
            if (sound < 0 || string.IsNullOrEmpty(_cfg.LevelSfxBank)) return null;
            string clipPath = _cfg.LevelFolder + "/Audio/SFX/" + _cfg.LevelSfxBank + "/" + sound.ToString("000") + ".wav";
            var clip = AssetDatabase.LoadAssetAtPath<AudioClip>(clipPath);
            if (clip == null) Debug.LogWarning("OpenSlope: teleport entry cue not found - " + clipPath + ". Run `snowknife " +
                "level` (or `sfx`) to decode " + _cfg.LevelSfxBank + ".bnk; the portal warps silently until then.");
            return clip;
        }

        // Hang the entry cue on the START volume as a 2D one-shot. It can't be positional: the crossing rider is
        // teleported hundreds of metres away the instant it fires, so a 3D source at the volume would fall out of
        // earshot before the clip finished (you'd hear only its start "at the entrance"). The whole teleport is local -
        // only the crossing client ever plays this - so a world position buys nothing anyway; 2D guarantees the mover
        // hears the full cue through the warp. VRChat force-spatializes a bare AudioSource, so the SpatialAudio tag
        // gives it a pairing that reads this source's 2D curve (spatialBlend 0) and keeps spatialization OFF.
        AudioSource AttachChime(GameObject go, AudioClip clip)
        {
            var src = go.AddComponent<AudioSource>();
            src.clip = clip;
            src.playOnAwake = false;
            src.loop = false;
            src.volume = Mathf.Clamp01(_cfg.TeleportChimeVolume);
            src.spatialBlend = 0f;      // 2D: not attenuated by the listener teleporting away from the volume
            src.dopplerLevel = 0f;
            // Tag it so the platform wiring pass adds a spatial pairing that reads this 2D curve (spatialBlend 0 -> the
            // pairing keeps spatialization OFF, so VRChat doesn't re-spatialize the bare source).
            go.AddComponent<SpatialAudio>();
            return src;
        }
    }
}
#endif
