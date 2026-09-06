# SSX Functional Specification

A functional specification of SSX Tricky (PS2) sufficient to implement an
application that loads and runs SSX levels **without the original game binary**,
optionally with third-party replacement assets.

Start with [`001-overview.md`](001-overview.md): what a level is, the major subsystems, and how
this spec's parts fit together.

## What this spec is

- It describes **the game**: its data model, on-disc formats, and runtime
  behavior. It does not reference any particular reimplementation, engine, or
  project — implementations reference the spec, never the other way around.
- Clean prose only. Every statement must fully specify the behavior on its own.
  Constants and magnitudes are facts and belong in the spec.
- Reverse-engineering provenance (binary addresses, symbol names, field
  offsets, disassembly structure) may appear **only in citations and DIRTY
  blocks**, never in a chapter body. If deleting a citation would gut the
  sentence it supports, the sentence needs rewriting.
- No reproduction of original code, and no line-by-line paraphrase of routine
  control flow. Behavior, requirements, formats, and measured constants only.

## Documentation ownership

This directory is the single source of truth for original SSX data formats,
runtime behavior, measured constants, and observable presentation rules.
Slopesmith, Unity, Snowknife, and other downstream projects may document how
they consume or approximate those rules, but their documentation must link to
the relevant chapter instead of maintaining a second behavioral specification.

When a downstream investigation changes what is known about the game, update
the Trailmap chapter and its evidence first. Downstream documentation then
records only the implementation mapping, supported configuration, deliberate
divergences, and verification specific to that project.

## Scope

- **Core target:** SSX Tricky, PS2 (PAL baseline). Other platforms (GC/Xbox)
  are noted only where a format chapter happens to cover variants.
- **Series addenda (Part 5):** SSX (2000), SSX 3 and On Tour are covered as
  *deltas* against that baseline — what differs, and what was measured to be
  the same.
  They are not standalone specs: read the baseline chapters, then apply the
  addendum. Anything a baseline chapter states and the addendum does not
  contradict was checked and holds.
- **In scope:** world/level data model, on-disc file formats, riding physics,
  world interactivity (triggers, breakables, pickups), effects, audio, and the
  interactive music system.
- **Out of scope:** front-end/menus, character/rider art and animation
  (third-party assets), multiplayer, and the original renderer's
  hardware-specific implementation (only its observable output model is
  specified).

<!-- DIRTY
Prose here is annotated with `[[tag]]()` citations into the Trailmap workspace.
`tools/specs/spec_trace.py check` strips them and fail-closed scans what's left,
so the clean prose has to stand on its own. Citation rules, annotation
forms, and the authoring source-material map: [`AUTHORING.md`](AUTHORING.md).
Why the split exists: [`../research/re-hygiene.md`](../research/re-hygiene.md).
DIRTY -->

## Index

Chapter numbers are stable identifiers grouped by subject range; gaps are reserved and are not missing files.
Other components use their own independent numbering trees.

Status: ☐ not started · ◐ drafting · ✓ drafted. “Drafted” means the chapter has publishable prose, not that
every open question has been resolved; confidence labels within each chapter remain authoritative.

### Part 0 — Orientation

| Spec | Contents | Status |
|---|---|---|
| [`001-overview.md`](001-overview.md) | What an SSX level is (one mountain run: terrain + props + paths + logic + audio); the major subsystems, the per-level file inventory, and how the parts of this spec fit together. | ✓ |
| [`002-conventions.md`](002-conventions.md) | Units (centimeters, named "engine units"), axes (Z-up, handedness), timebase (the "global animation tick"), confidence annotations. | ✓ |

### Part 1 — World data model

| Spec | Contents | Status |
|---|---|---|
| [`110-terrain.md`](110-terrain.md) | Terrain as a quilt of bicubic Bézier patches (16 control points each); per-patch surface type, texture UV corner-binding convention, lightmap tile reference; analytic surface normals. | ✓ |
| [`120-objects.md`](120-objects.md) | Shared models + per-instance placement; instance transform, lighting, visibility/flags, effect-slot reference; invisible utility volumes. | ✓ |
| [`130-collision-data.md`](130-collision-data.md) | Collision proxies vs render meshes; exact-zero/nonzero response mass; independent Roller-driven body activation; per-instance restitution tiers; inertia tensors; occupancy-tree bodies (hollow structures). | ✓ |
| [`140-paths.md`](140-paths.md) | Race lines (ordered course spine, distance-to-finish metric), AI/respawn paths, six-slot start-path assignment, grind-rail splines (cubic). | ✓ |
| [`150-logic.md`](150-logic.md) | The effect-slot logic graph: circumstances, lifetime/suppression, trigger volumes, dispatch types (sound, functions, particles, mesh state/animation, movers), and instance/receiver routing. | ✓ |
| [`160-lighting-data.md`](160-lighting-data.md) | Per-patch lightmap tiles; per-instance ambient + up to 3 directional keys; the global sun; light-record-driven lamp glints. | ✓ |
| [`170-materials.md`](170-materials.md) | Alpha modes (opaque / cutout / blend), half-bright color storage, material flipbooks, UV-scroll effects. | ✓ |
| [`180-particles-data.md`](180-particles-data.md) | Puff-cluster definitions, the shared sprite bank, emitter parameter blocks (count/trails, spawn and velocity bases, gravity, color controls), the EE/VU1 emitter runtime split, and ambient snowfall ownership. | ✓ |
| [`190-audio-data.md`](190-audio-data.md) | Sound banks and slot semantics (global vs per-level vs course banks), music stems, the interactive-music graph data, announcer speech bank. | ✓ |

### Part 2 — On-disc file formats

| Spec | Contents | Status |
|---|---|---|
| [`200-archives.md`](200-archives.md) | Disc layout; BIG archive variants; compression (RefPack, chunked). | ✓ |
| [`210-textures-ssh.md`](210-textures-ssh.md) | SSH texture banks: palettes, bit depths, the half-bright convention, lightmap variant. | ✓ |
| [`220-level-pbd.md`](220-level-pbd.md) | PBD level file: patches, instances, models, materials, lights, cameras, splines, texture flipbooks. | ✓ |
| [`230-level-ssf.md`](230-level-ssf.md) | SSF level file: object properties, effect slots, node payloads (boosts, throws, animation, movers, wind), physics bodies, collision models, and functions. | ✓ |
| [`240-models-mpf.md`](240-models-mpf.md) | MPF model format: meshes, skeleton, materials, morphs, animation clips. | ✓ |
| [`250-paths-aip-sop.md`](250-paths-aip-sop.md) | AIP/SOP path files: waypoints, events, bounding data, path types. | ✓ |
| [`260-audio-files.md`](260-audio-files.md) | SCHl stream and BNKl bank containers; EA-XA ADPCM, PS-ADPCM, signed 8-bit PCM, and MicroTalk speech codecs; the `.adl` collision-sound sidecar and `BANKS.INF`. | ✓ |
| [`270-music-graph.md`](270-music-graph.md) | Interactive-music graph file (node/link tables, events) and its paired chunked audio stream. | ✓ |

### Part 3 — Runtime behavior

| Spec | Contents | Status |
|---|---|---|
| [`300-rider-states.md`](300-rider-states.md) | The rider state machine (ground / air / rail), timestep, state transitions. | ✓ |
| [`310-surface-response.md`](310-surface-response.md) | The per-surface-type response table: contact acceleration, turn, carve drag, speed gain/target, sink budget, spray rate — and how each feeds the model. | ✓ |
| [`320-ground-contact.md`](320-ground-contact.md) | Soft contact: one-sided capped spring vs gravity, per-surface penetration budgets (snow ≈ 2.5 cm, powder ≈ 30 cm), visual ride-height lift, smooth (analytic) contact normal. | ✓ |
| [`330-carving.md`](330-carving.md) | Heading/yaw model (speed-ramped, per-tick cap, self-centering), lean, carve vs skid. | ✓ |
| [`340-jump-air-landing.md`](340-jump-air-landing.md) | Ollie charge/launch (normal↔tangent blend), two-stage gravity (≈8.5 rising / 19 falling m·s⁻²), air control and damping, speed cap, landing absorption. | ✓ |
| [`350-rails.md`](350-rails.md) | Grind state: analytic closest-point attach, exact-tangent travel, grind gravity, zero friction, free yaw window, junction chaining, exit/ollie-off. | ✓ |
| [`360-speed-and-boost.md`](360-speed-and-boost.md) | Cruise drive toward per-surface speed targets; held boost; boost/trick pads; directional, lift, lap-gated, and tube-end boost volumes. | ✓ |
| [`370-world-interaction.md`](370-world-interaction.md) | Prop collision response, breakable swaps and mesh throws, fragile glass, ride-through hollow structures, animated props, and Roller-driven physics bodies/spills. | ✓ |
| [`380-carve-effects.md`](380-carve-effects.md) | Snow spray (per-surface rate, quadratic in lean, sideways aim), carved wake (carve gate, per-surface width, sign-flip restart), sink. | ✓ |
| [`390-pickups-and-race.md`](390-pickups-and-race.md) | Gems/multipliers, reset and on-course respawn, teleport portals, fireworks, lap/finish flow, race lines as position metric, and scoring magnitudes (as known). | ✓ |
| [`395-ai-riders.md`](395-ai-riders.md) | AI racers as ordinary riders driven by a synthesized control word: pure-pursuit steering (8 m lookahead, proportional heading gain), path-chain choice by line rating vs mood, skill, and catch-up as a per-rider time-scale (0.70×–1.50×). | ✓ |

### Part 4 — Presentation

| Spec | Contents | Status |
|---|---|---|
| [`400-rendering.md`](400-rendering.md) | Observable render model: adaptive terrain, blend/color rules, fog and infinite backdrop, glints and celestial glare, chase camera, and ambient snowfall. | ✓ |
| [`410-texture-animation.md`](410-texture-animation.md) | Flipbook timing, UV-scroll tick, crowd/sign/LCD behaviors. | ✓ |
| [`420-audio-runtime.md`](420-audio-runtime.md) | SFX event → bank-slot resolution, per-surface ride audio, foliage swish, spatialization expectations. | ✓ |
| [`430-music-and-announcer.md`](430-music-and-announcer.md) | Intro-stem intensity tiers (A/B/C), race music as a graph walk (link selection by path level, event-driven jumps), announcer event/excitement gating. | ✓ |

#### Executable patch contracts

| Spec | Contents | Status |
|---|---|---|
| [`440-noclip-fly-mode.md`](440-noclip-fly-mode.md) | PAL/NTSC-U boot-ELF patch contract for a local, camera-relative level-inspection fly mode. | ✓ |
| [`442-sky-color.md`](442-sky-color.md) | Per-course zenith-color storage, load/render behavior, and the supported override contract. | ✓ |
| [`443-debug-text.md`](443-debug-text.md) | PAL/NTSC-U patch contract that realizes an otherwise inert SSF node as authored in-race HUD text. | ✓ |

### Part 5 — Series addenda

Deltas against the Tricky baseline, not standalone specs. Each states what
differs and what was measured to be unchanged; where an addendum is silent,
the baseline chapter holds.

| Spec | Contents | Status |
|---|---|---|
| [`500-series-ssx-2000.md`](500-series-ssx-2000.md) | SSX (2000), PS2: the world file as a pre-chunked spatial grid; object properties inline on the instance; the behavior file as four of the SSF's eight sections; a fifteen-kind node vocabulary with no counter, timer or named functions; one path file with eight start slots and no line rating; model format id 3; the texture-bank terminator exception. | ✓ |
| [`510-series-ssx-3.md`](510-series-ssx-3.md) | SSX 3, PS2: one streamed mountain of typed bins addressed by resource id; the patch, spline and path records that survive intact; a shared surface-type value space with re-assigned labels; instances that carry no behavior at all; the absence of an authored logic graph, and where the authoring layer went instead. | ✓ |
| [`520-series-ssx-on-tour.md`](520-series-ssx-on-tour.md) | SSX On Tour, PS2: SSX 3's architecture iterated again — a fixed-block, day/night-masked world container (fully reassembled; bin census matching the streaming database), terrain still a bicubic patch quilt, the path record surviving under a three-property lead, instances that reference their collision proxy directly, behaviour as compiled scripts bound to instances from outside, modular text-configured riders, and day/night as a record-level axis. | ✓ |
