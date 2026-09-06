# 049 — Sun God-Rays (Slopesmith port)

The original celestial-glare record, projection, fan, corona, colour transfer,
and compositing rules are specified in [Trailmap: 400-rendering]. This document
covers Slopesmith's authoring, preview, and flat/WebXR realization.

## Implementation

The feature follows the same core/view split as light glints:

- `core/lighting/god-rays.ts` owns the portable `GodRayCourse` shape,
  normalization, project-authored spoke pattern, presentation conversion, and
  pure mesh helpers; and
- `app/viewport/scene/god-rays.ts` owns Three.js rendering, preview lifecycle,
  flat-view fan rebuilds, WebXR presentation, and visibility fading.

Flat rendering builds the fan in clip space each frame because its border and
corner splice move with the projected sun. WebXR uses a sky-anchored disc so
each eye projects a common distant direction rather than receiving a
screen-fixed overlay. That stereo mode is an intentional comfort-oriented port
choice.

The source record supplies colours, intensities, angles, distance, size, and
enable state. The ray-selection pattern is project-authored and deterministic;
Slopesmith does not embed the source's authored spoke table. The corona uses an
extracted lens texture when available and a project-owned radial fallback
otherwise.

Visibility uses a small cone of BVH sight tests from the current eye position.
It fades the whole layer as the sun clears or passes behind terrain. The fan
geometry remains depth-blind. Prop occlusion is not yet included.

## Portable data and authoring

An imported course receives `Maps/<NAME>/World.json` from the extraction
pipeline. An authored mountain stores the same values on `mdoc.glare` and
exports the same `World.json` shape. The preview never selects settings by
course name and never borrows values from the other comparison world.

`Scene ▸ God Rays` presents the editable mountain beside the loaded reference.
The mountain controls enable, core/rim colours, fan/corona intensities,
celestial direction, distance, and sprite size. `take from level` is the only
operation that copies reference values into the mountain.

The shared Preview controls choose My mountain or Reference and independently
toggle skybox and glare. During a Test ride the layer follows the ridden world;
ending the ride returns it to the retained editor preview state.

The glare direction is intentionally independent of the lighting sun. UI
angles are converted through `sceneDirFromGlareAzEl`, including the raw-to-editor
axis mapping and the viewport chirality conversion. The layer hides a sun that
projects behind the camera.

## Verification

- `test/god-rays.test.ts` covers normalization, the deterministic project
  pattern, border/corner construction, and portable settings.
- Compare authored and reference panels row-for-row and verify `take from
  level` is the only mutating bridge.
- Test flat and WebXR views independently; their geometry intentionally differs.
- Exercise terrain occlusion from desktop and XR cameras.
- Export and re-import `World.json` without changing its values.

## Deliberate divergences and remaining work

- The 32-spoke pattern is project-authored. The canonical source pattern and
  its behavior remain documented only in Trailmap.
- WebXR uses a finite sky disc instead of the flat screen-filling fan.
- The fallback corona is procedural rather than copied source art.
- Only terrain participates in Slopesmith's visibility tests; props remain to
  be added.

The Unity sibling is [Unity: 046-sun-god-rays].
