# 002 — Conventions

Conventions used throughout this specification. Spec text states behavior in
these terms; implementations map them onto their own engine's conventions.

## Units and coordinate system

World geometry is authored in **centimeters** — this spec calls them
**engine units**: 100 engine units = 1 m. Rider characters stand 175 units
(1.75 m) tall. [[002-units]]()

The world is **Z-up**: gravity acts along −Z, terrain "up" normals point
toward +Z, and the ground plane is X-Y. The coordinate system is
left-handed relative to the common right-handed Y-up convention; mapping
onto a right-handed Y-up engine takes a mirrored X axis plus a −90°
rotation about X (source Z becomes the engine's up axis). [[002-axes]]()

The baseline disc for every byte offset and measured constant in this spec
is the **PS2 PAL** release.

> [[002-units]]() db:orientation; doc:../research/extracted-data.md —
> rider height read from character config; patch extents in level data.

> [[002-axes]]() db:orientation; spec:250-accumulation. Measured: raw `gari.aip`
> step vectors have `sqrt(X²+Y²) = 1.000000` for all 2,105 points while Z is
> an unbounded slope (up to 37) — i.e. X-Y is the ground plane, not X-Z.
> GARI `Patches.json` terrain normals are dominantly along Z (mean
> component −0.87 Z vs −0.44 Y), and race lines descend monotonically in Z
> (86% of steps), matching the course drop. Raw terrain and path evidence is
> sufficient to establish the source convention; downstream engine transforms
> are implementation mappings and are intentionally not evidence for it.

## Timebase

Gameplay simulation advances at a fixed **60 ticks per second**; per-tick
constants in this spec are stated against that rate, and rate-like constants
are given in SI units (m/s, m/s²) where possible. **Texture animation shares
that tick**: UV scroll and flipbook stepping both advance per simulation tick
(60 Hz), so a flip's `speed / 60` per-tick phase step puts its on-screen rate
at `speed` fps. [[002-timestep]]()

> [[002-timestep]]() db:timestep; map:"Timestep clues". The scroll tick is
> observed at 60 Hz: a 2026-07-16 side-by-side of the shipped game against
> an external preview advancing the same extracted per-tick rates at
> 30 ticks/s showed the game's river scrolling at exactly twice the
> preview. The flipbook list is pinned to the same rate by a triggered
> flip's first advance timed against retail (`410-texture-animation.md`,
> `[[410-tick]]`).

## Surface types

Terrain patches and collision surfaces carry a small-integer **surface type**
that selects every per-surface behavior in this spec (friction, sink, spray,
audio, …). Types observed across levels include: powder, snow, ice, rock,
ramp/jump, walls, reset zones, and no-collision decoration; the full
numbered enumeration is given in `110-terrain.md`. The response table
itself is specified in `310-surface-response.md`. [[002-surfacetypes]]()

> [[002-surfacetypes]]() db:surface-types; db:surface-table;
> doc:../research/extracted-data.md SurfaceType labels.

## Confidence annotations

Statements are facts unless marked otherwise:

- **[measured]** — read directly from game data files; exact.
- **[observed]** — derived from watching the running game; approximate.
- **[inferred]** — consistent with observation but not directly confirmed;
  implementations should treat these as tunable defaults.
- **[open]** — not yet established; a known gap rather than a claim.
