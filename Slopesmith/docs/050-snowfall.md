# 050 — Ambient Snowfall (Slopesmith port)

The original snowfall enable rule, camera-relative field, wrap behavior,
motion, sprite, and blend are specified in [Trailmap: 400-rendering] and
[Trailmap: 180-particles-data]. This document covers the browser editor and
Test-ride implementation only.

## Architecture

The port renders one instanced quad with per-flake attributes. Fall, drift,
wrapping, edge/near fades, and billboarding are evaluated in the vertex shader
from elapsed ride time and the eye position. The CPU updates two uniforms per
frame and keeps no particle simulation state.

The implementation is split between:

- `core/particles/snowfall.ts`, which owns project tuning, deterministic flake
  data, and CPU mirrors of shader math; and
- `app/viewport/scene/snowfall.ts`, which owns the Three.js geometry, material,
  GLSL, and render lifecycle.

The object lives on `stage.scene` rather than `worldRoot` because the shader
already works in world coordinates. Frustum culling is disabled: the unit quad
at the object origin does not describe where shader-positioned instances draw.
The baked random field uses a fixed seed so identical settings produce the same
inspection scene.

## Rendering constraints

Wrapping is applied to a flake centre before the four billboard corners are
expanded, so a quad cannot tear across the box boundary. Edge shrink hides the
recycle and near shrink bounds close-camera fill. Billboards use world up so a
WebXR headset roll does not roll the flakes.

Desktop and WebXR share the field. In XR the layer supplies one cyclopean eye
position so both eyes agree on the wrap cell. The procedural soft dot is
radially symmetric, so this port omits source-sprite rotation.

`test/snowfall.test.ts` checks the pure motion/wrap helpers and their agreement
with the shader expressions. `test/snowfall-webgl.test.ts` exercises the real
WebGL layer, including parallax and periodic wrap, because CPU tests cannot
prove that the shader compiled or reached the framebuffer.

## Test-ride lifecycle and controls

Snowfall draws only during an active Test ride. It stays hidden while editing
and while watching the AI with the editor orbit camera. Starting a ride resets
the presentation clock; changing the setting during a ride is immediate because
the field is a pure function of time and eye position.

`Test ▸ Snow` is a persisted project-authored 0–10 presentation dial. The
ported stop and the whiteout stop are defined in
`core/particles/snowfall.ts`; `snowfallAt` interpolates the supported settings.
Below the ported stop the control primarily thins the field. Above it the
project deliberately increases density and wind toward a whiteout. That upper
range is an embellishment, not original-game behavior.

## Deliberate divergences

- The browser field uses a larger box and more instances than the source
  presentation so it reads as weather at modern desktop/WebXR view distances.
- It uses project-owned procedural soft dots rather than requiring the original
  particle-bank texture.
- The shader omits visually irrelevant spin for the radial fallback art.
- The Test dial replaces the original course-init enable policy with explicit
  author/player control and extends beyond the source effect at high values.

The canonical values and source rules remain in Trailmap. Keep tuning and
policy here labelled as Slopesmith choices.

## Cost

The field is one draw call with no per-frame buffer upload or CPU particle
update. Instance count and additive fill dominate at the top of the dial; the
near fade removes the worst full-screen flakes. Outside Test mode the layer is
not drawn.

## Related implementation

[047 — Light glints](047-light-glints.md) and
[049 — Sun God-Rays](049-sun-god-rays.md) use the same core-versus-view split.
The Unity realization is [Unity: 044-snowfall].
