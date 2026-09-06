#if UNITY_EDITOR
using System.Collections.Generic;
using System.Reflection;
using UnityEngine;
using UnityEditor;
using OpenSlope.Importer;

namespace OpenSlope.BasisPlugin
{

    // The Basis wiring pass - the BasisVR analogue of VRC's VrcWiring. The SAME neutral importer (Assets/OpenSlope/Importer)
    // builds the scene and leaves an *Marker on every object that needs a runtime behaviour; this realizes those markers
    // into Basis behaviours (plain C# MonoBehaviours - no Udon). See docs/basis/061.
    //
    // PARTIAL by design: Basis runtime behaviours are ported one subsystem at a time. What HAS a Basis behaviour today is
    // realized (PASS 1) and its markers are stripped (PASS 3); every other marker is left in place and REPORTED, so the
    // neutral data survives for its future realizer. This differs from VrcWiring, which realizes everything and strips
    // all markers. As each behaviour lands, add a Realize<Marker, BasisBehaviour> line + a ClearMarkers<Marker> line.
    //
    // Ported so far: the FX + audio pass - FireworkMarker (fireworks), AmbientEmitterMarker (collision dust/spark/
    // fire bursts), SpatialAudio (positional AudioSources) - the gem pickups (SpinnerMarker -> the shared spin
    // manager, GemMarker -> the collect behaviour), the grind-rail network (RailMarker -> BasisRailNetwork, the
    // data the rideable board queries), and the course-flow triggers (ResetZoneMarker -> BasisResetZone,
    // TeleportMarker -> BasisTeleport, BoostPadMarker -> BasisBoostPad, BoostVolumeMarker ->
    // BasisBoostVolume, the MainType-0 boost family that pushes / lifts / launches a rider held inside a volume), the placed-object range culler
    // (ObjectCullerMarker -> BasisObjectCuller, the mountain-top prop-draw perf gate), and the knock-and-tumble
    // physics props (PhysicsPropMarker -> BasisPhysicsProp, crash bags / path markers), and the breakable logos /
    // signs / balloons (BreakableLogoMarker -> BasisBreakableLogo, the ride-through mesh-swap + piece throw), the
    // animated model-clip props (AnimatedPropMarker -> BasisAnimatedProp: the free-run bridge + the break-owned
    // roll-aways; the door/kicker TRIGGER volumes, AnimTriggerMarker/AnimPokerMarker, are still unported), and the
    // animated textures (FlipbookMarker -> BasisFlipbookAnimator, the crowd / sign / LCD flipbooks). The field-copy
    // mirrors VrcWiring.CopyFieldsByName exactly (the marker seam is platform-agnostic), minus the Udon proxy push - a
    // Basis behaviour is a plain component.
    public static class BasisWiring
    {
        public static void Wire()
        {
            var root = GameObject.Find("OpenSlope_Map");
            if (root == null) { Debug.LogError("OpenSlope(Basis): 'OpenSlope_Map' not found - import a level first."); return; }

            // PASS 1: realize the markers that have a Basis behaviour today.
            RealizeSpatialAudio(root);
            Realize<ProximityAudioMarker, BasisProximityAudio>(root);
            Realize<FireworkMarker, BasisFirework>(root);
            Realize<AmbientEmitterMarker, BasisAmbientEmitter>(root);
            Realize<ModeVisibilityMarker, BasisModeVisibility>(root);
            Realize<SpinnerMarker, BasisSpinnerManager>(root);   // gems: the one-Update spin manager
            Realize<GemMarker, BasisGemPickup>(root);            // gems: per-gem pop/chime/regrow on contact
            Realize<RailMarker, BasisRailNetwork>(root);         // grind rails (+ course path) the board queries
            Realize<ResetZoneMarker, BasisResetZone>(root);      // authored OOB boundary volumes (reset the rider)
            Realize<TeleportMarker, BasisTeleport>(root);        // teleport portals (warp player/board to the exit)
            Realize<BoostPadMarker, BasisBoostPad>(root);        // speed/trick pads (timed board boost + cosmetic)
            Realize<BoostVolumeMarker, BasisBoostVolume>(root);  // the MainType-0 boost family (push / lift / lap / tube-end)
            Realize<ObjectCullerMarker, BasisObjectCuller>(root);// range-cull placed-object renderers (mountain-top perf)
            Realize<PhysicsPropMarker, BasisPhysicsProp>(root);  // knock-and-tumble props (crash bags / path markers)
            Realize<PropBounceMarker, BasisPropBounce>(root);    // static prop restitution + material feel
            Realize<ContactSoundMarker, BasisContactSound>(root);// pass-through authored prop hit sounds
            Realize<BreakableLogoMarker, BasisBreakableLogo>(root);// breakable logos / signs / balloons (ride-through mesh-swap + throw)
            Realize<AnimatedPropMarker, BasisAnimatedProp>(root);// model-clip props (bridge free-run; break-owned roll-aways, docs/036/038)
            Realize<FlipbookMarker, BasisFlipbookAnimator>(root);// animated textures (crowd / signs / LCD flipbooks, grouped by material)

            // PASS 2: resolve each roll-away breakable's rollAnimObject (docs/036 - the globe sign) to the realized
            // animated prop on it, so the breakable can Trigger() the roll at the hit and ResetToStart() it on respawn.
            // (AnimTriggerMarker / AnimPokerMarker / ButtonMarker stay unported: the door/kicker/button trigger
            // volumes are reported below. A Basis button still reads its rest colour - that is the shared material.)
            foreach (var mk in root.GetComponentsInChildren<BreakableLogoMarker>(true))
            {
                if (mk.rollAnimObject == null) continue;
                var brk = mk.GetComponent<BasisBreakableLogo>();
                if (brk == null) continue;
                var prop = mk.rollAnimObject.GetComponent<BasisAnimatedProp>();
                if (prop == null) { Debug.LogWarning($"OpenSlope(Basis) wiring: roll-away breakable '{mk.name}' could not resolve its animated prop - it will swap without rolling."); continue; }
                brk.rollAnim = prop;
            }

            // PASS 2: resolve each knock body's spillObject (docs/036) to the realized breakable on that cluster, so the
            // body's knock throws its contents - a garbage can rolls away AND sprays its trash off one hit.
            foreach (var mk in root.GetComponentsInChildren<PhysicsPropMarker>(true))
            {
                if (mk.spillObject == null) continue;
                var body = mk.GetComponent<BasisPhysicsProp>();
                if (body == null) continue;
                var brk = mk.spillObject.GetComponent<BasisBreakableLogo>();
                if (brk == null) { Debug.LogWarning($"OpenSlope(Basis) wiring: knock body '{mk.name}' could not resolve its spill cluster - it will topple without spilling."); continue; }
                body.spill = brk;
            }

            // PASS 3: strip ONLY the markers we realized (the un-ported ones stay for the report + their future realizer).
            int cleared = 0;
            cleared += ClearMarkers<FireworkMarker>(root);
            cleared += ClearMarkers<AmbientEmitterMarker>(root);
            cleared += ClearMarkers<ModeVisibilityMarker>(root);
            cleared += ClearMarkers<SpatialAudio>(root);
            cleared += ClearMarkers<ProximityAudioMarker>(root);
            cleared += ClearMarkers<SpinnerMarker>(root);
            cleared += ClearMarkers<GemMarker>(root);
            cleared += ClearMarkers<RailMarker>(root);
            cleared += ClearMarkers<ResetZoneMarker>(root);
            cleared += ClearMarkers<TeleportMarker>(root);
            cleared += ClearMarkers<BoostPadMarker>(root);
            cleared += ClearMarkers<BoostVolumeMarker>(root);
            cleared += ClearMarkers<ObjectCullerMarker>(root);
            cleared += ClearMarkers<PhysicsPropMarker>(root);
            cleared += ClearMarkers<PropBounceMarker>(root);
            cleared += ClearMarkers<ContactSoundMarker>(root);
            cleared += ClearMarkers<BreakableLogoMarker>(root);
            cleared += ClearMarkers<AnimatedPropMarker>(root);
            cleared += ClearMarkers<FlipbookMarker>(root);

            // Report whatever markers remain unrealized (the scaffold), so it's obvious what's left to port.
            ReportUnrealized(root, cleared);
        }

        // PASS 1 helper: attach behaviour B to every object carrying marker M and copy the marker's fields onto it by name.
        // Idempotent (reuses an existing B), so re-running is safe. Marker is left for PASS 3.
        static void Realize<M, B>(GameObject root) where M : Marker where B : MonoBehaviour
        {
            foreach (var m in root.GetComponentsInChildren<M>(true))
            {
                var b = m.GetComponent<B>();
                if (b == null) b = m.gameObject.AddComponent<B>();
                CopyFieldsByName(m, b);
            }
        }

        // Copy the marker's public instance fields onto the behaviour where the names match and the types are assignable -
        // the per-subsystem "configure" step driven by name. A GameObject cross-reference (name ends Object/Objects) is
        // skipped here (VrcWiring resolves those in a PASS 2; the Basis subsystems ported so far carry none that need
        // resolving), as is an [ImporterOnly] field, which never belonged to a behaviour at all. Any OTHER unmatched /
        // type-mismatched field is logged as likely rename drift. Mirrors VrcWiring.CopyFieldsByName, minus the
        // UdonSharpBehaviour constraint + the Udon heap push.
        static void CopyFieldsByName(Marker from, MonoBehaviour to)
        {
            var toType = to.GetType();
            foreach (var mf in from.GetType().GetFields(BindingFlags.Public | BindingFlags.Instance))
            {
                if (mf.IsDefined(typeof(ImporterOnlyAttribute), false)) continue;            // importer-internal, never wired
                var tf = toType.GetField(mf.Name, BindingFlags.Public | BindingFlags.Instance);
                if (tf == null)
                {
                    if (mf.Name.EndsWith("Object") || mf.Name.EndsWith("Objects")) continue;   // cross-ref (unresolved here)
                    Debug.LogWarning($"OpenSlope(Basis) wiring: {from.GetType().Name}.{mf.Name} has no matching field on " +
                                     $"{toType.Name} (rename drift?) - skipped.");
                    continue;
                }
                if (!tf.FieldType.IsAssignableFrom(mf.FieldType))
                {
                    Debug.LogWarning($"OpenSlope(Basis) wiring: {from.GetType().Name}.{mf.Name} ({mf.FieldType.Name}) is not " +
                                     $"assignable to {toType.Name}.{tf.Name} ({tf.FieldType.Name}) - skipped.");
                    continue;
                }
                tf.SetValue(to, mf.GetValue(from));
            }
        }

        // Make the importer's positional AudioSources spatial. The importer builds bare Unity AudioSources with their 3D
        // curve already set (spatialBlend / Linear rolloff / min-max); Basis's spatializer is Steam Audio, which pans a
        // source by position + distance once spatialization is enabled - no VRChat-style pairing component needed. So we
        // just flip spatialize on for a positional source (spatialBlend > 0) and leave a 2D bed (spatialBlend 0) alone.
        static void RealizeSpatialAudio(GameObject root)
        {
            foreach (var tag in root.GetComponentsInChildren<SpatialAudio>(true))
            {
                var src = tag.GetComponent<AudioSource>();
                if (src == null) { Debug.LogWarning($"OpenSlope(Basis) wiring: SpatialAudio on '{tag.name}' has no AudioSource - skipped."); continue; }
                if (src.spatialBlend > 0f)
                {
                    src.spatialize = true;
                    src.spatializePostEffects = true;
                }
            }
        }

        // Strip every marker of type M under root; returns how many were removed.
        static int ClearMarkers<M>(GameObject root) where M : Marker
        {
            int n = 0;
            foreach (var m in root.GetComponentsInChildren<M>(true)) { Object.DestroyImmediate(m); n++; }
            return n;
        }

        static void ReportUnrealized(GameObject root, int cleared)
        {
            var counts = new Dictionary<string, int>();
            foreach (var m in root.GetComponentsInChildren<Marker>(true))
            {
                string t = m.GetType().Name;
                counts[t] = counts.TryGetValue(t, out int c) ? c + 1 : 1;
            }

            if (counts.Count == 0)
            {
                Debug.Log($"OpenSlope(Basis) wiring: realized + cleared {cleared} FX/audio marker(s); no markers left to port.");
                return;
            }

            var sb = new System.Text.StringBuilder($"OpenSlope(Basis) wiring: realized + cleared {cleared} FX/audio marker(s). " +
                                                    "Markers still awaiting a Basis behaviour:\n");
            foreach (var kv in counts) sb.AppendLine($"  {kv.Value,4}  {kv.Key}  (no Basis behaviour ported yet)");
            sb.Append("Port the matching Basis behaviour + add a Realize<> line to attach it (see VrcWiring).");
            Debug.Log(sb.ToString());
        }
    }
}
#endif
