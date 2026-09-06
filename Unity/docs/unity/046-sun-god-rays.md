# 046 — Sun God-Rays (Unity port)

The original celestial-glare record, fan/corona behavior, transfer law, and
compositing are specified in [Trailmap: 400-rendering]. This document covers the
Unity builder, shader modes, visibility component, and refresh workflow.

## Build pipeline

`Importer/Editor/SunGodRaysBuilder.cs` creates one `SunGodRays` object under the
map root. It reads the portable glare settings from `<LevelFolder>/World.json`,
builds a fan plus corona mesh, assigns `OpenSlope/SunGodRays`, and attaches a
`SunGlareFadeMarker`.

The builder uses a deterministic project-authored 32-spoke pattern shared with
Slopesmith rather than embedding the source spoke table. It tags fan and corona
vertices separately so one shader can apply their independent colours,
intensities, and texture paths. Four diagonal spokes cover the screen corners
for the baked mesh approximation.

The corona selects the staged `Textures/Particles/lens.png` atlas when present.
A project-owned procedural profile is the fallback. Renderer bounds are made
deliberately large because the shader relocates the mesh relative to the active
camera; ordinary object-local bounds would cull it incorrectly.

The built-in-render-pipeline shader lives under `VRC/Shaders/`; the Basis/URP
equivalent lives under `Basis/Shaders/`.

## Flat and stereo modes

The shader has two presentation paths:

| Mode | Unity realization |
|---|---|
| flat/desktop | screen-filling fan placed from the projected sun |
| stereo/VR | finite sky-anchored disc with a faded rim |

Stereo matrices force the second path even if the material was authored for
screen fill. This is an intentional comfort divergence: both eyes project one
distant direction instead of receiving a depthless overlay fixed to each lens.
The corona remains an authored-radius billboard in either mode.

## Visibility

The material itself is depth-blind. `SunGlareFadeMarker` and its platform
realizations decide whether the source is visible by sampling a small cone of
sight lines and easing `_Visibility`.

The marker also runs in edit mode so the Scene view and plain Unity/Basis
projects can inspect visibility. VRChat wiring replaces it with the Udon
behavior so a built world never runs both. `OnWillRenderObject` supplies the
camera that is actually drawing, including editor and auxiliary cameras.

The cone size, fade rate, range, occluder mask, and minimum visibility are Unity
settings. They approximate source visibility but do not redefine the canonical
rendering rule.

## Portable inputs

The extraction and authored-map pipelines stage the same `World.json` contract.
`SunGodRaysBuilder` consumes its enable state, core/rim colours, independent
intensities, celestial angles, distance, and corona size. A disabled or absent
record produces no object on automatic import.

The glare's direction is independent of the map's lighting sun. The builder
uses the portable celestial angles when present and falls back to the imported
lighting direction only when an authored glare record does not provide them.
`ToSunFromAzEl` performs the raw-to-Unity direction mapping described by
[004 — Orientation & World Scale](004-orientation-and-scale.md).

`Material.SetVector` and ShaderLab `Vector` properties preserve the portable
display-domain RGB values in linear-colour projects. Do not change those
properties to `Color` without re-running the importer smoke comparison.

## Refresh and verification

`OpenSlope ▸ Refresh ▸ Sun God Rays` rebuilds the object from the currently open
level. Re-run it after changing `World.json` or updating the builder/shader.

Verification should cover:

- absent, disabled, and enabled portable records;
- raw-vector colour delivery in gamma and linear projects;
- flat and stereo mode selection;
- missing-atlas fallback;
- Scene-view and runtime visibility fading; and
- no frustum loss as the camera crosses the course.

## Deliberate divergences

- The spoke selection is project-authored and contains 32 generated entries.
- The screen-corner splice is baked at diagonals rather than rebuilt each frame.
- Stereo uses a finite disc instead of the flat screen-filling fan.
- The visibility sampler and procedural corona fallback are OpenSlope-authored.

Use [Trailmap: 400-rendering] to judge source fidelity. Newly recovered behavior
is promoted there before this port or document changes. The Slopesmith sibling
is [Slopesmith: 049-sun-god-rays].
