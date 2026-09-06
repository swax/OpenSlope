# Slopesmith documentation

The top-level [Slopesmith README](../README.md) covers installation and the normal editor workflow.
This index collects design decisions, implementation contracts, and specialist runbooks.
Original SSX formats, behavior, measured constants, and presentation rules are
defined only in [Trailmap](../../Trailmap/specs/README.md). A Slopesmith document
may explain which chapter its code implements, but owns only editor data flow,
UI, project-authored behavior, deliberate divergences, and verification.

Document numbers are stable identifiers across this directory and `ideas/`, not a completeness count.
Gaps preserve proposal, retired, or reserved identifiers; other components may reuse the same numbers in
their own documentation trees.

## Foundations

- [001 — Design](001-design.md) — product goals and course-grammar thesis.
- [002 — Course Model](002-course-model.md) — racing line, control mesh, and Bézier quilt.
- [003 — Export Contract](003-export-contract.md) — portable map shape, coordinates, and conventions.
- [006 — Surface Net](006-surface-net.md) — the editable Bézier control net.
- [024 — Source Layout](024-source-layout.md) — module ownership and dependency rules.

## Terrain and editing

- [004 — Sculpt Mode](004-sculpt-mode.md)
- [005 — Texture Paint](005-texture-paint.md)
- [017 — Topology Surgery](017-topology-surgery.md)
- [018 — Density Transitions](018-density-transitions.md)
- [020 — Patch Finish](020-patch-finish.md)
- [023 — Splines, Loft, and Track](023-spline-loft-track.md) — the loft generator and edge-runs-as-rails behind
  Create Trail, the target-weld gesture, and the spline and track objects staged after them.
- [043 — Contour-flow Retopology](043-contour-flow-retopology.md)
- [044 — Semantic Labels](044-semantic-labels.md)
- [045 — Retopology Benchmark](045-retopology-benchmark.md)
- [054 — Merqury City Trail Study](054-merqury-city-trail-study.md) — measured rules for running a trail between
  buildings, with a village before/after.

## Scene content

- [008 — Lighting Study](008-lighting-study.md)
- [009 — Blender Evaluation](009-blender-evaluation.md) — and [046](046-blender-bridge.md) for the prop round trip it argues for.
- [012 — Props](012-props.md)
- [013 — Lights and Sound Sources](013-lights.md)
- [014 — Rails, Motion Paths, and Gems](014-rails.md)
- [015 — Group Props](015-groups.md)
- [025 — Skybox](025-skybox.md)
- [026 — Effects Editor](026-effects-editor.md)
- [027 — Reference Effects](027-reference-effects.md)
- [028 — Tiled Props (authored models)](028-authored-models.md) — one tile, mapping computed, editable here.
- [032 — Imported Props (textured props)](032-imported-props.md) — their own UV layout, across many materials.
- [033 — Generated Textures](033-generate-texture.md)
- [046 — Blender Bridge](046-blender-bridge.md) — the round trip out to Blender and back onto the same model.
- [047 — Light Glints](047-light-glints.md) — the halo/star sparkle a glow light draws, ported from Unity.
- [049 — Sun God-Rays](049-sun-god-rays.md) — the course sun and its flat-screen/WebXR glare presentations.
- [050 — Ambient Snowfall](050-snowfall.md) — the camera-wrapped weather field a ride is taken through, ported from Unity.
- [051 — Video Screens](051-video-screens.md) — the rectangles a runtime plays video over, authored or read off a course.

## Ride, audio, and references

- [016 — Test Ride](016-ride.md)
- [022 — Ride Model Contract](022-ride-model-rework.md) — the analytic ground-contact behaviour the fixed-step
  ride implements, pinned to Trailmap and the shared `ride-v1.json`.
- [030 — Character Models](030-character-models.md)
- [031 — Custom Race Music](031-custom-race-music.md)
- [034 — Board Sound](034-board-sound.md)
- [036 — Authored Map References](036-authored-map-references.md)

## Hosting and collaboration

- [038 — Hosted Servers](038-hosted-sessions.md) — one server per group, a member as username and password, the
  browser as the whole client.
- [039 — Concurrent Editing](039-concurrent-editing.md) — the register as the unit of concurrency; last-writer-wins
  for everything but topology.
- [040 — History and Recovery](040-history-and-recovery.md) — whole-document checkpoints, thinned with age, restored
  forward rather than rewound.
- [048 — Voice Chat](048-voice-chat.md) — self-hosted LiveKit, network ports, credentials, and operations.
- [063 — Jukebox Playback](063-video-bridge.md) — the shared video queue on YouTube's embedded player, the
  browser trust boundary, and the optional local media server that puts a movie on in-course screens.

## Operation and automation

- [011 — Export Preflight and Disc Split](011-export-target.md)
- [037 — Export on the Client, Discs in Snowknife](037-export-and-disc-split.md) — why the browser assembles the
  portable folder and only `snowknife` knows a disc.
- [029 — Agent Layer](029-agent-layer.md)
- [035 — Local Projects](035-local-projects.md)
- [041 — Production Deployment](041-production-deployment.md)
- [052 — HATEOAS API](052-hateoas-api.md) — the discoverable REST surface an AI agent authors a mountain through.
- [Original-course authoring](authoring/README.md) — vocabulary and scored build workflows.
- [`ideas/`](ideas/README.md) — staged proposals and superseded assessments that are not product contracts; its
  index says where each one stands.

Retail-game behavior belongs in [Trailmap](../../Trailmap/specs/README.md); conversion contracts belong in
[Snowknife](../../Snowknife/docs/README.md); Unity realization belongs in
[Unity](../../Unity/docs/README.md). If an implementation investigation changes
what is known about SSX, promote the finding to Trailmap first and keep only the
Slopesmith-specific consequence here.
