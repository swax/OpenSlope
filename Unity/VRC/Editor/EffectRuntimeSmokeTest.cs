#if UNITY_EDITOR
using System;
using UnityEditor;
using UnityEngine;
using UdonSharpEditor;
using UdonSharp;
using OpenSlope.Importer;
using System.Collections.Generic;

namespace OpenSlope.VrcPlugin
{
    // Batch-mode regression entry point; also compiles the real Udon programs, not C# stubs.
    public static class EffectRuntimeSmokeTest
    {
        public static void Run()
        {
            try
            {
                bool compileError = false;
                Application.logMessageReceived += (message, stack, type) => { if (type == LogType.Error || type == LogType.Exception) compileError = true; };
                UdonTools.EnsureAllProgramAssets();
                UdonSharp.Compiler.UdonSharpCompilerV1.CompileSync();
                Require(!compileError, "Udon compilation reported an error");
                var go = new GameObject("LifecycleSmoke");
                var drawn = GameObject.CreatePrimitive(PrimitiveType.Cube);
                drawn.transform.SetParent(go.transform);
                var renderer = drawn.GetComponent<Renderer>();
                var collider = drawn.GetComponent<Collider>();
                renderer.sharedMaterial = new Material(Shader.Find("OpenSlope/UnlitDoubleSided"));
                var mover = UdonTools.AddConfigured<SplineMover>(new GameObject("DetachedMover"), m =>
                { m.Path = new[] { Vector3.zero, Vector3.forward * 20 }; m.Speed = 1f; });
                mover.ResetEffect();
                var emitter = new GameObject("DetachedEmitter").AddComponent<ParticleSystem>();
                emitter.transform.SetParent(go.transform);
                emitter.Play();
                var target = UdonTools.AddConfigured<EffectTarget>(go, t =>
                {
                    t.targetRenderers = new[] { renderer }; t.targetColliders = new[] { collider };
                    t.detachedParticles = new[] { emitter }; t.movers = new[] { mover };
                });
                target.Apply(1);
                Require(renderer.enabled && collider.enabled, "Pause must keep the static pane and collision");
                Require(renderer.sharedMaterial.GetFloat("_EffectTime") >= 0f, "Pause did not freeze the private material clock");
                target.Apply(2);
                Require(!renderer.enabled && !collider.enabled, "Hide must retire render and collision");
                Require(emitter.isPlaying && mover.gameObject.activeSelf, "Hide must leave detached work alive");
                target.Apply(3);
                Require(!emitter.isEmitting && !mover.gameObject.activeSelf, "Flagged kill must retire detached work");
                target.Restore();
                Require(renderer.enabled && collider.enabled && mover.gameObject.activeSelf, "Restore must restore the pane, collision and mover");
                Require(renderer.sharedMaterial.GetFloat("_EffectTime") < 0f, "Restore did not restart the material clock");
                renderer.enabled = false;
                target.Apply(2); target.Restore();
                Require(!renderer.enabled, "Restore must preserve an initially hidden renderer");

                var culler = UdonTools.AddConfigured<ObjectCuller>(new GameObject("CullerSmoke"), c => c.renderers = new[] { renderer });
                // Culling must not resurrect a renderer hidden by an effect, including when disabled.
                typeof(ObjectCuller).GetMethod("OnDisable", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
                    .Invoke(culler, null);
                Require(!renderer.enabled, "Disabling the distance culler resurrected a hidden prop");
                renderer.enabled = true;
                target.Apply(1); int oldGeneration = target.generation;
                target.Apply(2); target.RestoreGeneration(oldGeneration);
                Require(!renderer.enabled, "An older sequence reset overwrote a newer hide");
                target.RestoreGeneration(target.generation);
                Require(renderer.enabled, "The current sequence could not restore its target");
                var segment = new GameObject("TreeSegment").transform;
                var animation = UdonTools.AddConfigured<AnimatedPropU>(new GameObject("TreeAnimation"), a =>
                {
                    a.triggered = true; a.segTransforms = new[] { segment };
                    a.segRestPos = new[] { Vector3.zero }; a.segRestEuler = new[] { Vector3.zero };
                });
                var animationTrigger = UdonTools.AddConfigured<AnimTriggerU>(new GameObject("TreeTrigger"), a =>
                { a.target = animation; a.rearmDelay = 33.56f; });
                animationTrigger.Fire(); animationTrigger.Fire();
                Require(animationTrigger.AutoTestFireCount == 1, "Re-crossing restarted the tree during its rail sequence");
                var network = UdonTools.AddConfigured<RailNetwork>(new GameObject("RailSmoke"), n =>
                {
                    n.LocalPoints = new[] { Vector3.zero, Vector3.forward * 20 };
                    n.RailStart = new[] { 0 }; n.RailCount = new[] { 2 };
                    n.StartDisabledRails = new[] { 0 };
                });
                var gate = UdonTools.AddConfigured<RailGate>(new GameObject("GateSmoke"), g =>
                {
                    g.railNetwork = network; g.rails = new[] { 0, 0 }; g.animations = new[] { animation };
                    g.delays = new[] { 1f, 2f }; g.railEnabled = new[] { true, false };
                });
                gate.Fire();
                Require(!network.IsRailEnabled(0), "Rail enabled before its authored wait");
                var started = typeof(RailGate).GetField("_started", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
                var advance = typeof(RailGate).GetMethod("Advance", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
                started.SetValue(gate, Time.time - 1.5f); advance.Invoke(gate, null);
                Require(network.IsRailEnabled(0), "Delayed rail enable did not fire");
                started.SetValue(gate, Time.time - 2.5f); advance.Invoke(gate, null);
                Require(!network.IsRailEnabled(0), "Authored rail disable did not fire");
                segment.localPosition = Vector3.one;
                gate.Restore();
                Require(segment.localPosition == Vector3.zero, "Rail reset did not reset the tree animation");
                Require(!network.IsRailEnabled(0), "Rail reset lost its initial disabled state");

                // Exercise the neutral builder and platform reference wiring with a detached particle receiver.
                var cfg = ImportConfig.For("Assets/OpenSlope/Maps/OPENSLOPE_IMPORTER_TEST_AUTOTEST1");
                var reader = new BundleManifestReader(cfg);
                reader.EffectTargets.Clear(); reader.EffectTriggers.Clear();
                reader.EffectTargets.Add(new BundleManifestReader.EffectTarget { Index = 9000, Name = "pot" });
                reader.EffectTriggers.Add(new BundleManifestReader.EffectTrigger
                {
                    Index = 9001, Name = "switch", Size = Vector3.one,
                    Actions = new List<BundleManifestReader.EffectAction> { new BundleManifestReader.EffectAction { Target = 9000, Mode = 3, Delay = .05f } }
                });
                go.name = Map.RootName;
                EffectLifecycleBuilder.Tag(drawn, 9000);
                EffectLifecycleBuilder.Tag(emitter.gameObject, 9000, detached: true);
                var originalMaterial = renderer.sharedMaterial;
                var flip = new FlipbookAccum();
                flip.Add(renderer, 0, new[] { new Texture2D(1, 1), new Texture2D(1, 1) }, 2f);
                new EffectLifecycleBuilder(cfg).Build(go.transform, flip, reader);
                Require(flip.Count == 0, "The stoppable flipbook stayed in the shared animator");
                var handoff = go.GetComponentInChildren<EffectTargetMarker>();
                Require(handoff.targetRenderers.Length == 1 && handoff.targetColliders.Length == 1, "Target binding lost render/collision identity");
                Require(handoff.detachedParticles.Length == 1, "Detached emitter was not bound");
                Require(renderer.sharedMaterial != originalMaterial, "Stoppable material was not isolated");
                VrcWiring.Wire();
                var trigger = go.GetComponentInChildren<EffectTrigger>();
                Require(trigger.targets.Length == 1 && trigger.targets[0] != null, "Platform target reference was not wired");
                Require(trigger.targets[0].flipbooks.Length == 1, "The private flipbook receiver was not wired");
                Require(trigger.delays[0] == .05f && trigger.modes[0] == 3, "Platform wiring lost effect timing or mode");
                Debug.Log("OpenSlope EFFECT RUNTIME TEST PASS");
                EditorApplication.Exit(0);
            }
            catch (Exception error) { Debug.LogException(error); EditorApplication.Exit(1); }
        }

        static void Require(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); }
    }
}
#endif
