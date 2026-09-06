using UnityEngine;
using UdonSharp;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// Ambient falling-snow weather for the local player - the SSX ambient snowfall.
    ///
    /// HOW THE REAL GAME DOES IT (see docs/044-snowfall.md): the game keeps a
    /// box of flakes around the active camera, but the flakes are effectively WORLD-FIXED - you ride THROUGH them with
    /// full parallax. Each frame it wraps flakes toroidally across the box faces, so a flake stays put while you
    /// approach it and only jumps when it falls off an edge, reappearing on the opposite face. That is why the snow is
    /// never "left behind" no matter how fast you ride. Flakes are small additive camera-facing sprites (the soft
    /// <c>str2</c> grain) that fall + drift; it's designed for a NIGHT course, so additive white flakes glow against
    /// the dark sky.
    ///
    /// THE PORT is fully SHADER-DRIVEN: one static baked mesh of flake quads whose fall, drift, wrap, and billboarding
    /// are all evaluated in the OpenSlope/Snowfield VERTEX shader from <c>_Time</c> + the camera position (see the shader
    /// header). Flake positions are a pure function of time - no simulation state, no per-frame CPU or Udon work at
    /// all. The wrap centres on the RENDER camera, so mirrors and handheld/stream cameras each get a full snow field
    /// around their own viewpoint (the engine's camera-relative box, generalized). This behaviour is only the on/off
    /// switch: the Settings Board's "Snow effect" row (SnowOn/SnowOff) and the inspector toggle enable/disable the
    /// field's MeshRenderer. One always-on, local-only instance (sync None), the same shape as PlayerFlight /
    /// SurfaceDetector. Built by SnowfallSetup ('OpenSlope/Setup/Snowfall'); all tuning (box size, fall speed, flake
    /// size, brightness) lives on the Snowfield material.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]   // local-only weather, no networking (every client sees their own snow)
    public class SnowfallU : UdonSharpBehaviour
    {
        [Tooltip("The baked snow-field MeshRenderer this switches (built by 'OpenSlope/Setup/Snowfall'). All motion happens " +
                 "in its OpenSlope/Snowfield vertex shader; enabling/disabling the renderer is the whole on/off.")]
        public MeshRenderer snowRenderer;

        [Tooltip("Master on/off (applied at Start and by SnowOn/SnowOff). The field is stateless - position is a " +
                 "function of time - so re-enabling shows the snow exactly where it would have been.")]
        public bool enableSnow = true;

        void Start() { Apply(); }

        // External on/off for the Settings Board's snow row (param-less = an Udon-safe cross-behaviour call).
        public void SnowOff() { enableSnow = false; Apply(); }
        public void SnowOn()  { enableSnow = true;  Apply(); }

        void Apply()
        {
            if (snowRenderer != null) snowRenderer.enabled = enableSnow;
        }
    }
}
