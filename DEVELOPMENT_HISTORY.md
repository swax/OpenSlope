# Development history

This historical chronology summarizes the major OpenSlope development milestones from May 2026
through the initial public release in early September 2026, and the changes landed each day since.
Release-to-release detail is recorded in the corresponding GitHub release notes.

## May 2026

- **2026-05-28:** Added one-click Blender launching and corrected the imported world orientation.
- **2026-05-29:** Added animated textures, accurate world scale, surface-aware collision, character measurement, and water and crowd animation fixes.
- **2026-05-30:** Added effect-rate animation, per-pixel terrain lighting, per-instance prop lighting, avatar light probes, and transparent materials.
- **2026-05-31:** Added fog, spinners, knockable physics props, and the first rideable snowboard with gaze steering.

## June 2026

- **2026-06-01:** Added trigger-driven fireworks, separate desktop and VR steering, analytic terrain normals, start-gate board dispensing, and direct Unity setup.
- **2026-06-02:** Improved transparency, ramp launches, airborne landing alignment, VR steering, board audio, and collisions with solid props and walls.
- **2026-06-03:** Added free flight, snow spray and wakes, held boost, collectible gems, rail grinding, optimized gem rendering, and Quest-safe world centering.
- **2026-06-04:** Expanded fireworks and foliage interactions, added long-range flight, refined steering and ollies, improved VR stability, and introduced the demo-map builder.
- **2026-06-05:** Stabilized high-speed grinding and directional rail exits, and allowed dismounted boards to coast naturally.
- **2026-06-06:** Added dynamic prop lighting, course-aware recovery, powder wakes, and surface-specific sink, banking, and pitch.
- **2026-06-07:** Added wall and quarter-pipe riding, a platform-neutral map hierarchy, and full-course respawning.
- **2026-06-08:** Added import validation, stable moving-board stations, correct sky color handling, a portable glTF bundle, and analytic rail riding.
- **2026-06-09:** Generalized level imports, added rideable and breakable props, stabilized lighting-probe baking, and made runtime audio data-driven.
- **2026-06-10:** Established the research/specification boundary and drafted the core data and file-format specifications.
- **2026-06-11:** Drafted behavior and presentation specifications and introduced Slopesmith, the Bézier-patch course editor.
- **2026-06-12:** Added prop-remodel overrides, Blender round-tripping, NURBS terrain tools, and automated project setup.
- **2026-06-13:** Added animated kickers and contact-driven props, reliable material-alpha classification, and correct transparent occlusion.
- **2026-06-14:** Added end-to-end speed and trick boost pads.
- **2026-06-15:** Added URL-driven video billboards.
- **2026-06-16:** Moved board contact to the analytic Bézier terrain surface.
- **2026-06-17:** Expanded video billboards and improved rail, wake, lighting, and menu performance.
- **2026-06-18:** Networked rideable boards as a shared instance-wide pool.
- **2026-06-19:** Made all billboards video-ready through the automated setup workflow.
- **2026-06-20:** Completed shared multiplayer boards, effects, gems, voice, remote movement and trails, recovery, and start-gate synchronization.
- **2026-06-21:** Reworked snow spray by surface type and anchored the start gate to course data.
- **2026-06-22:** Fixed nose-down kicker launches and improved riding performance.
- **2026-06-23:** Reduced idle runtime work and added continuous emitters, ambient snowfall, balloon effects, and an in-world performance panel.
- **2026-06-24:** Added texture-array batching, distance culling, performance diagnostics, automated probe baking, and multimedia and player panels.
- **2026-06-25:** Added a jukebox, Quake-style walking, cell-based scene culling, spatial rail queries, aerial flips, and consolidated information and tuning panels.
- **2026-06-26:** Added scored runs, finish-line placement, and a leaderboard.
- **2026-06-27:** Added an earned boost meter with sustained boost feedback.
- **2026-06-28:** Introduced a foldable Bézier control net, corner-bound terrain UVs, live authored sunlight, and improved sky rendering.
- **2026-06-30:** Added static chunking, a lossless Blender quad-cage bridge, collaborative region planning, animated skies, end-to-end authored lighting, teleport portals, and show-off rail controls; completed the first specification review.

## July 2026

- **2026-07-01:** Added texture-painting tools, collision-driven emitters, reset and boost volumes, spline movers, and soft-body wind effects.
- **2026-07-02:** Improved runtime dispatch performance, redesigned texture tiling, moved snowfall to the GPU, added export preflight, and made importing platform-neutral.
- **2026-07-03:** Added full Basis/URP import, prop placement, lighting, riding, effects, and audio support.
- **2026-07-04:** Brought grinding, scoring, networking, gems, props, flight, placement, authored rails, and light glints to Basis and Slopesmith.
- **2026-07-05:** Added cage poles, edge-loop tracing, local refinement, and reference handles.
- **2026-07-06:** Unified surface editing and selection, rebuilt board spray and wakes, added the run HUD, and supported trigger-driven breakables.
- **2026-07-07:** Established the general quad-mesh model and citation system; added instanced props, fog-aware particles, scalable snowfall, unified selections, cage-point editing, and accurate finish lines.
- **2026-07-08:** Added edge splitting and exact surface-preserving slides, responsive mobile UI, analytic test riding, canonical quad meshes, and more accurate glints, snowfall, and billboards.
- **2026-07-10:** Added patch drawing, rim extrusion, rail lofting, staged transforms, and more faithful grounded riding physics.
- **2026-07-11:** Matured topology editing, rail riding, course previews, lighting authoring, AI-path tools, sculpt brushes, local transforms, and effect specifications.
- **2026-07-12:** Expanded sculpting and mesh surgery with flattening, pushing, stroke locking, T-junctions, crossing welds, interior extrusion, and improved chase-camera previews.
- **2026-07-13:** Added course-driven mountain generation, authored skies, rider-start alignment, focused cage editing, contextual previews, and rideable spline movers.
- **2026-07-14:** Improved AI riders and board handling, and added end-to-end effect, particle, animation, and fog authoring and preview.
- **2026-07-15:** Added data-driven effect editing across Slopesmith and Unity, telemetry-backed riding, and hand-aimed airborne boost.
- **2026-07-16:** Added high-definition render tessellation, momentum-preserving board interactions, robust run tracking, and polygon-model authoring.
- **2026-07-17:** Added schema-backed contract validation plus higher-resolution terrain, collision-sound authoring, gamepad support, and advanced prop controls.
- **2026-07-18:** Improved ride and reference fidelity, light and sound tools, editor feedback, reload caching, ground picking, and agent integration.
- **2026-07-20:** Added terrain-derived prop lighting, keyed prop previews, self-lit props, custom music and models, and more faithful boost, landing, and movable-prop physics.
- **2026-07-21:** Added generated texture, sky, and prop tools; improved interactive props, effect navigation, and authored spline movers across runtimes.
- **2026-07-22:** Added authored trigger volumes, firework inspection, Effects.json-driven bundles, and improved runtime movers and triggers.
- **2026-07-23:** Added end-to-end prop collision authoring, batched reference props, and Play-mode profiling.
- **2026-07-24:** Expanded effect authoring, crowd and knockable-prop behavior, local projects, authored references, and reference-load performance.
- **2026-07-25:** Introduced the collaborative server architecture with portable browser exports, stable IDs, named assets, conflict handling, project history, multi-user register editing, partial rollback, and incremental terrain rebuilds.
- **2026-07-26:** Hardened concurrent editing and synchronization, added structured CLI help, production deployment, moderator permissions, procedural props, spline trails, and cross-series format documentation.
- **2026-07-27:** Added persistent patch locking, procedural prop recipes, timed UV animation, protected-region retopology, and GLB prop effects.
- **2026-07-28:** Added texture recipes plus spinning authored parts and continuous particles.
- **2026-07-29:** Preserved native animation hierarchies and completed the production retopology workflow.

## August 2026

- **2026-08-03:** Improved authored-prop fidelity and carried exact prop lighting and animation into Unity.
- **2026-08-04:** Added canonical prop export, mixed editing selections, boost-effect authoring, procedural trees, selectable riding styles, and lap-aware boost volumes.
- **2026-08-05:** Added race start and finish anchors, correct particle sizing, and stable riding collisions on flat ground and moving props.
- **2026-08-06:** Expanded course-authoring and runtime parity and added the Europa and Wildcat course packages.
- **2026-08-07:** Expanded both course packages, added contour-flow retopology, and strengthened gameplay, effect, and research validation.
- **2026-08-08:** Expanded effect authoring and cross-runtime automation, added the collision lab, generated local metadata contracts, and introduced semantic authoring labels.
- **2026-08-09:** Added effect navigation, breakable authored props, stable topology synchronization, portable mountains, selectable patch sets, and more robust animation and retopology setup.
- **2026-08-10:** Expanded character and texture tools, added a generated rider and faster moving-prop collision, improved mountain workflows, ride modes, effects, and layered transparency.
- **2026-08-11:** Added Blender prop round-tripping, light glints, hit-reactive animations, fog and sound authoring, dock tabs, aerial flips, switch riding, and shared workflow guides.
- **2026-08-12:** Added WebXR play, effect-aware rails, texture-orientation tools, draw-distance and texture-array performance work, rail visualization, and self-hosted server-wide voice chat.
- **2026-08-13:** Added live multiplayer avatars, PCVR diagnostics, room-scale movement, body calibration, tracked hands, flight, editor authentication, guarded self-updates, and course-authored god rays.
- **2026-08-14:** Improved terrain lighting, sky and god-ray previews, pickups, snowfall, transparency, and breakables; added generated riders, an articulated character, and switchable skis with dedicated poses.
- **2026-08-15:** Added the end-to-end billboard-screen pipeline, a local video bridge, the Alpine Exo character and tracking rig, and mode-specific course content.
- **2026-08-17:** Added Showoff-only props, oriented collision volumes, local board effects, role-aware capacity, mountain ownership, and editor permissions.
- **2026-08-18:** Added a synchronized video queue, member profile pictures, improved VR riding and diagnostics, a procedural nightclub prop, and voice self-testing.
- **2026-08-19:** Added first-person walking, persistent VR boards with grab, throw, and recall, faster VR collision and rendering, expanded ride controls, manual air spins, and predictive big-air wind.
- **2026-08-20:** Added ride music and environmental audio, deep equipment and stance customization, synchronized equipment and world interactions, richer member profiles, player actions, chat bubbles, and contextual help.
- **2026-08-21:** Stabilized ride-time voice playback, added live screen sharing and watching, improved remote play and hosted media fallback, and introduced presence states and configurable voice rooms.
- **2026-08-22:** Added immutable asset caching, more faithful god-ray rendering, and Showoff checkpoint time bonuses.
- **2026-08-23:** Improved billboard and screen tooling, chase-camera fidelity, and material-aware rail authoring and physics.
- **2026-08-24:** Added contact-driven particle emitters and support for importing external map references.
- **2026-08-25:** Recreated board-spray behavior, added saved-equipment editing and the Servo Scout character, overhauled ride controls and the mobile HUD, and consolidated format research.
- **2026-08-26:** Added timed-run trick scoring, boost, results, improved Quest controls, unified lighting, and mountain-aware skies.
- **2026-08-30:** Unified gamepad, touch, and WebXR controls; improved flight, respawning, loose-board physics, boost feedback, fog, and media fallback guidance.
- **2026-08-31:** Refined XR controls, tracked-arm IK, board interaction, reference-mesh editing, collision, HUD, music, and video behavior.

## September 2026

- **2026-09-01:** Added board-directed boost trails, held-board XR flight controls, scored-run recovery, and a discoverable authoring API with schemas, guides, helpers, and an interactive explorer.
- **2026-09-02:** Added configurable update repositories and improved settings persistence and update-source visibility.
- **2026-09-04:** Updated project dependencies, stabilized Slopesmith compatibility, made exports transactional, and restored along-edge slides.
- **2026-09-05:** Hardened Slopesmith server and character-import boundaries, made collision fixtures reproducible, and added a stable CI verification gate.
