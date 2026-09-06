#if UNITY_EDITOR
using System.Collections.Generic;
using System.Reflection;
using UnityEngine;
using UnityEditor;
using UdonSharp;
using UdonSharpEditor;
using VRC.SDK3.Components;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    // The VRChat wiring pass. The neutral importer (Assets/OpenSlope/Importer) builds the scene and leaves an *Marker on
    // every object that needs a runtime behaviour; this turns those markers into live UdonSharp components, so an
    // imported map is upload-ready. The Basis project carries the parallel BasisWiring, which attaches Basis behaviours
    // to the SAME markers. This is where all the VRChat/Udon-specific attach knowledge lives - none of it is in the importer.
    //
    // Runs in three passes over everything under OpenSlope_Map:
    //   PASS 1  realize - attach each marker's UdonSharp behaviour (idempotent, via UdonTools.AddConfigured) and copy the
    //           marker's fields onto it by name (CopyFieldsByName), then push to the Udon heap.
    //   PASS 2  resolve cross-references - a few behaviours point at OTHER realized behaviours (a rail gate -> its rail
    //           network, an anim trigger -> its prop). A neutral marker can't hold those typed refs, so it stores a
    //           GameObject and we resolve it to the now-attached component here, once every behaviour exists.
    //   PASS 3  clear - strip the consumed markers so the built scene carries only the live behaviours (no duplicate
    //           data, smaller upload).
    //
    // Called by ImportAll AFTER LevelImporter.Import(cfg). The UdonSharp program assets it attaches must already
    // exist + be finalized - ImportAll runs UdonTools.EnsureAllProgramAssets first (the once-per-fresh-project
    // two-click bootstrap). See docs/vrchat/013-udon-components.md.
    public static class VrcWiring
    {
        public static void Wire()
        {
            var rootGo = GameObject.Find(Map.RootName);
            if (rootGo == null) { Debug.LogError($"OpenSlope wiring: '{Map.RootName}' not found - import a level first."); return; }
            var root = rootGo;

            // PASS 1: realize each marker into its UdonSharp behaviour. Add a Realize<Marker, Behaviour>(root) line here
            // as each subsystem is migrated off the importer's inline attach.
            RealizeSpatialAudio(root);
            Realize<ProximityAudioMarker, ProximityAudio>(root);
            Realize<HitGatedLoopsMarker, HitGatedLoops>(root);    // hit-gated interactive loops (hydrant spray / car alarm / police siren)
            Realize<FireworkMarker, FireworkTrigger>(root);
            Realize<ModeVisibilityMarker, ModeVisibility>(root);
            Realize<RailMarker, RailNetwork>(root);       // both the grind "Rails" and the "CoursePath" networks
            Realize<RailGateMarker, RailGate>(root);      // scalar fields; the network cross-ref is resolved in PASS 2
            Realize<ResetZoneMarker, ResetZone>(root);
            Realize<BoostVolumeMarker, BoostVolume>(root);
            Realize<SplineMoverMarker, SplineMover>(root);
            Realize<BoostPadMarker, BoostPad>(root);
            Realize<TeleportMarker, Teleport>(root);
            Realize<AmbientEmitterMarker, AmbientEmitter>(root);   // scalar/particle fields; roller lids resolved in PASS 2
            Realize<SpinnerMarker, SpinnerManager>(root);
            Realize<GemMarker, GemPickup>(root);
            Realize<PhysicsPropMarker, PhysicsProp>(root);
            Realize<BreakableLogoMarker, BreakableLogoU>(root);
            Realize<PropBounceMarker, PropBounce>(root);
            Realize<ContactSoundMarker, ContactSound>(root);
            Realize<AnimatedPropMarker, AnimatedPropU>(root);
            Realize<AnimTriggerMarker, AnimTriggerU>(root);   // poke bool; the prop cross-ref is resolved in PASS 2
            Realize<ButtonMarker, ButtonU>(root);            // ride-over buttons: latch a button's material red -> green
            Realize<AnimPokerMarker, AnimPokerU>(root);       // the prop cross-refs are resolved in PASS 2
            Realize<FlipbookMarker, FlipbookAnimator>(root);
            Realize<ObjectCullerMarker, ObjectCuller>(root);
            Realize<TerrainPatchesMarker, TerrainPatches>(root);
            Realize<GlintFadeMarker, GlintFade>(root);    // light-glint source-visibility fade (LightGlows root)
            Realize<SunGlareFadeMarker, SunGlareFade>(root);   // sun-glare source-visibility fade (SunGodRays object)
            Realize<HudMessageDisplayMarker, HudMessageDisplay>(root);
            Realize<HudMessageMarker, HudMessageTrigger>(root);

            // PASS 2: resolve the GameObject cross-references onto the realized behaviours (every network/prop now exists).
            ResolveRailGates(root);
            ResolveAmbientEmitters(root);
            ResolveBreakableRolls(root);
            ResolvePropSpills(root);
            ResolveAnimTriggers(root);
            ResolveAnimPokers(root);
            WireBoardTerrainPatches(root);
            WireBoardHitGatedLoops(root);
            ResolveHudMessages(root);

            // PASS 3: strip the consumed markers.
            int cleared = 0;
            foreach (var m in root.GetComponentsInChildren<Marker>(true)) { Object.DestroyImmediate(m); cleared++; }

            AssetDatabase.SaveAssets();
            if (cleared > 0) Debug.Log($"OpenSlope wiring: realized + cleared {cleared} marker(s).");
        }

        // PASS 1 helper: attach behaviour B to every object carrying marker M and copy the marker's fields onto it. The
        // attach is idempotent (UdonTools.AddConfigured reuses an existing B), so re-running is safe. Marker is left in
        // place for PASS 2 / PASS 3.
        static void Realize<M, B>(GameObject root) where M : Marker where B : UdonSharpBehaviour
        {
            foreach (var m in root.GetComponentsInChildren<M>(true))
            {
                var marker = m;
                UdonTools.AddConfigured<B>(marker.gameObject, b => CopyFieldsByName(marker, b));
            }
        }

        // Copy the marker's public instance fields onto the behaviour proxy where the names match and the types are
        // assignable. This IS the per-subsystem "configure" step, driven by field name
        // - so a marker field named identically to the behaviour field carries across with no per-type code. Fields the
        // behaviour keeps at its own default (e.g. FireworkTrigger.networked) simply aren't on the marker, so they're
        // untouched. A GameObject cross-reference (name ends `Object`/`Objects`) is intentionally not matched here - PASS
        // 2 resolves it, and an [ImporterOnly] field never belonged to a behaviour at all. Any OTHER unmatched or
        // type-mismatched field is logged as likely rename drift, so it surfaces at import time rather than silently
        // in-world.
        public static void CopyFieldsByName(Marker from, UdonSharpBehaviour to)
        {
            var toType = to.GetType();
            foreach (var mf in from.GetType().GetFields(BindingFlags.Public | BindingFlags.Instance))
            {
                if (mf.IsDefined(typeof(ImporterOnlyAttribute), false)) continue;            // importer-internal, never wired
                var tf = toType.GetField(mf.Name, BindingFlags.Public | BindingFlags.Instance);
                if (tf == null)
                {
                    if (mf.Name.EndsWith("Object") || mf.Name.EndsWith("Objects")) continue;   // cross-ref, resolved in PASS 2
                    Debug.LogWarning($"OpenSlope wiring: {from.GetType().Name}.{mf.Name} has no matching field on {toType.Name} " +
                                     "(rename drift?) - skipped.");
                    continue;
                }
                if (!tf.FieldType.IsAssignableFrom(mf.FieldType))
                {
                    Debug.LogWarning($"OpenSlope wiring: {from.GetType().Name}.{mf.Name} ({mf.FieldType.Name}) is not assignable to " +
                                     $"{toType.Name}.{tf.Name} ({tf.FieldType.Name}) - skipped.");
                    continue;
                }
                tf.SetValue(to, mf.GetValue(from));
            }
        }

        // PASS 2: resolve each rail gate's GameObject reference to the realized rail network on that object, and set the
        // gate behaviour's typed railNetwork field. Runs after PASS 1 so every RailNetwork already exists.
        static void ResolveRailGates(GameObject root)
        {
            foreach (var mk in root.GetComponentsInChildren<RailGateMarker>(true))
            {
                var gate = mk.GetComponent<RailGate>();
                if (gate == null) continue;
                var net = mk.railNetworkObject != null ? mk.railNetworkObject.GetComponent<RailNetwork>() : null;
                if (net == null) { Debug.LogWarning($"OpenSlope wiring: rail gate '{mk.name}' could not resolve its rail network - it will do nothing."); continue; }
                gate.railNetwork = net;
                UdonTools.Push(gate);
            }
        }

        // PASS 2: resolve each ambient emitter's fire-hydrant lid GameObjects to the realized physics-prop behaviours on
        // those objects, and set the emitter's typed RollerLids field. Runs after PASS 1 so every PhysicsProp exists.
        static void ResolveAmbientEmitters(GameObject root)
        {
            foreach (var mk in root.GetComponentsInChildren<AmbientEmitterMarker>(true))
            {
                var emitter = mk.GetComponent<AmbientEmitter>();
                if (emitter == null) continue;
                var objs = mk.rollerLidObjects;
                if (objs == null || objs.Length == 0) continue;
                var lids = new List<PhysicsProp>(objs.Length);
                foreach (var o in objs)
                {
                    if (o == null) continue;
                    var pp = o.GetComponent<PhysicsProp>();
                    if (pp != null) lids.Add(pp);
                }
                emitter.RollerLids = lids.ToArray();
                UdonTools.Push(emitter);
            }
        }

        // PASS 2: resolve each roll-away breakable's rollAnimObject (docs/036 - the globe sign) to the realized
        // animated-prop behaviour on it, so the breakable can Trigger() the roll clip at the hit and ResetToStart()
        // it on the respawn. Runs after PASS 1 so the break-owned AnimatedPropU exists.
        static void ResolveBreakableRolls(GameObject root)
        {
            foreach (var mk in root.GetComponentsInChildren<BreakableLogoMarker>(true))
            {
                if (mk.rollAnimObject == null) continue;
                var brk = mk.GetComponent<BreakableLogoU>();
                if (brk == null) continue;
                var prop = mk.rollAnimObject.GetComponent<AnimatedPropU>();
                if (prop == null) { Debug.LogWarning($"OpenSlope wiring: roll-away breakable '{mk.name}' could not resolve its animated prop - it will swap without rolling."); continue; }
                brk.rollAnim = prop;
                UdonTools.Push(brk);
            }
        }

        // PASS 2: resolve each knock body's spillObject (docs/036) to the realized breakable behaviour on that cluster, so
        // the body's knock throws its contents - a garbage can rolls away AND sprays its trash off one hit. Runs after
        // PASS 1 so both the PhysicsProp and the cluster's BreakableLogoU exist.
        static void ResolvePropSpills(GameObject root)
        {
            foreach (var mk in root.GetComponentsInChildren<PhysicsPropMarker>(true))
            {
                if (mk.spillObject == null) continue;
                var body = mk.GetComponent<PhysicsProp>();
                if (body == null) continue;
                var brk = mk.spillObject.GetComponent<BreakableLogoU>();
                if (brk == null) { Debug.LogWarning($"OpenSlope wiring: knock body '{mk.name}' could not resolve its spill cluster - it will topple without spilling."); continue; }
                body.spill = brk;
                UdonTools.Push(body);
            }
        }

        // PASS 2: resolve each animated-prop trigger's target GameObject to the realized animated-prop behaviour on it.
        static void ResolveAnimTriggers(GameObject root)
        {
            foreach (var mk in root.GetComponentsInChildren<AnimTriggerMarker>(true))
            {
                var trig = mk.GetComponent<AnimTriggerU>();
                if (trig == null) continue;
                trig.target = mk.targetObject != null ? mk.targetObject.GetComponent<AnimatedPropU>() : null;
                UdonTools.Push(trig);
            }
        }

        // PASS 2: resolve the idle poker's target GameObjects to the realized animated-prop behaviours on them.
        static void ResolveAnimPokers(GameObject root)
        {
            foreach (var mk in root.GetComponentsInChildren<AnimPokerMarker>(true))
            {
                var poker = mk.GetComponent<AnimPokerU>();
                if (poker == null) continue;
                var objs = mk.targetObjects;
                var list = new List<AnimatedPropU>(objs != null ? objs.Length : 0);
                if (objs != null)
                    foreach (var o in objs)
                    {
                        if (o == null) continue;
                        var p = o.GetComponent<AnimatedPropU>();
                        if (p != null) list.Add(p);
                    }
                poker.targets = list.ToArray();
                UdonTools.Push(poker);
            }
        }

        // Pair every message trigger with the one local head-following display built by HudMessageBuilder. The neutral
        // marker stores a GameObject because it cannot reference this platform's UdonSharp type directly.
        static void ResolveHudMessages(GameObject root)
        {
            foreach (var mk in root.GetComponentsInChildren<HudMessageMarker>(true))
            {
                var trigger = mk.GetComponent<HudMessageTrigger>();
                if (trigger == null) continue;
                trigger.display = mk.displayObject != null ? mk.displayObject.GetComponent<HudMessageDisplay>() : null;
                if (trigger.display == null)
                    Debug.LogWarning($"OpenSlope wiring: HUD message trigger '{mk.name}' could not resolve its display.");
                UdonTools.Push(trigger);
            }
        }

        // Hand every rideable board the hit-gated loop manager, so a wall impact can arm the nearest interactive
        // ambient loop (car alarm / police siren / hydrant spray) - retail's rule is that playing a prop's impact
        // one-shot enables its loop [Trailmap: 420-audio-runtime]. Same shape as WireBoardTerrainPatches.
        static void WireBoardHitGatedLoops(GameObject root)
        {
            var mgr = root.GetComponentInChildren<HitGatedLoops>(true);
            if (mgr == null) return;   // no gated loops on this map
            var mgrUdon = UdonSharpEditorUtility.GetBackingUdonBehaviour(mgr);
            foreach (var o in Resources.FindObjectsOfTypeAll<RideableBoard>())
            {
                if (EditorUtility.IsPersistent(o)) continue;
                o.hitGatedLoops = mgr;
                UdonSharpEditorUtility.CopyProxyToUdon(o);
                var bu = UdonSharpEditorUtility.GetBackingUdonBehaviour(o);
                object v;
                bool got = bu != null && bu.publicVariables.TryGetVariableValue("hitGatedLoops", out v) && v != null && !v.Equals(null);
                if (!got && bu != null && mgrUdon != null) bu.publicVariables.TrySetVariableValue("hitGatedLoops", mgrUdon);
                EditorUtility.SetDirty(o);
            }
        }

        // Point every rideable board at the realized analytic terrain-patches holder (docs/021), so the board Newton-refines
        // the exact bicubic surface instead of the faceted collider. Not a per-object marker cross-ref (the boards aren't
        // built by the importer) - a scene-wide wire of the single holder onto all boards, run at import end and on the
        // Refresh menu. No-op on a level that authored no patches (or before any board exists).
        static void WireBoardTerrainPatches(GameObject root)
        {
            var holder = root.GetComponentInChildren<TerrainPatches>(true);
            if (holder == null) return;
            var holderUdon = UdonSharpEditorUtility.GetBackingUdonBehaviour(holder);
            foreach (var o in Resources.FindObjectsOfTypeAll<RideableBoard>())
            {
                if (EditorUtility.IsPersistent(o)) continue;
                o.terrainPatches = holder;
                UdonSharpEditorUtility.CopyProxyToUdon(o);
                var bu = UdonSharpEditorUtility.GetBackingUdonBehaviour(o);
                object v;
                bool got = bu != null && bu.publicVariables.TryGetVariableValue("terrainPatches", out v) && v != null && !v.Equals(null);
                if (!got && bu != null && holderUdon != null) bu.publicVariables.TrySetVariableValue("terrainPatches", holderUdon);
                EditorUtility.SetDirty(o);
            }
        }

        // Realize a SpatialAudio tag as VRChat's spatial-audio component on the same object, reading the pairing
        // straight off the sibling AudioSource (the importer set its curve). Positional sources (spatialBlend > 0) get
        // spatialization on with the source's own volume curve + range; a 2D source (spatialBlend 0, the teleport chime)
        // gets it off so VRChat doesn't re-spatialize it. Covers every ConfigureSpatial variant needed.
        static void RealizeSpatialAudio(GameObject root)
        {
            foreach (var tag in root.GetComponentsInChildren<SpatialAudio>(true))
            {
                var src = tag.GetComponent<AudioSource>();
                if (src == null) { Debug.LogWarning($"OpenSlope wiring: SpatialAudio on '{tag.name}' has no AudioSource - skipped."); continue; }
                var sa = tag.GetComponent<VRCSpatialAudioSource>() ?? tag.gameObject.AddComponent<VRCSpatialAudioSource>();
                bool spatial = src.spatialBlend > 0f;
                sa.EnableSpatialization = spatial;
                sa.UseAudioSourceVolumeCurve = spatial;               // honour our Linear rolloff / min-max, not VRChat's 40 m default
                sa.Near = src.minDistance;
                sa.Far = Mathf.Max(src.minDistance, src.maxDistance);
            }
        }
    }
}
#endif
