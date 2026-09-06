# 001 — Overview

An SSX level is **one mountain run**: a descent that starts at a gate near
the summit and ends at a finish line far below, ridden in a few minutes on a
snowboard under player control. Everything in a level serves that descent.
The terrain *is* the run; the objects dress and obstruct it; the paths
thread it; the logic graph animates it; the audio scores it. Within the
world-data scope this spec models, the riders are the only free agents — every
other moving thing is data reacting to a rider, or to time. The AI racers are
riders in the fullest sense: they run the same physics from a synthesized
control word, and what they decide (which line to take, how hard to turn, when
to be given faster time) is `395-ai-riders.md`; the standings and rubber-banding
their positions feed are `390-pickups-and-race.md`.

This chapter is orientation. It makes no claims of its own: every statement
here is specified, with its evidence, in the chapter that owns it, and the
chapter references are the load-bearing content.

## Anatomy of a level

**Terrain** (`110-terrain.md`). The course surface is a quilt of bicubic
Bézier patches — the level stores control points, and the surface and its
normals are evaluated parametrically, so rendering and physics both work
from a continuous curved slope rather than from any fixed mesh. Each patch
carries a surface type (snow, ice, powder, …) that selects every
per-surface behavior in the game, and references a texture and a lightmap
tile.

**Objects** (`120-objects.md`). Everything placed on the terrain —
buildings, trees, rails and their supports, ramps, the crowd, pickups,
trigger volumes — is an instance of a shared model: a world transform plus
per-instance lighting, joined to a shared properties record that carries
the behavior many instances have in common.

**Collision** (`130-collision-data.md`). Collision never uses the render
mesh. The properties record selects a collision mode and, where geometry is
needed, points into shared pools of collision proxies and physics bodies;
it also carries the rider-response mass (exact zero suppresses solid response;
nonzero admits it) and the player-bounce magnitude. Dynamic prop movement is
activated separately by the logic graph.

**Paths** (`140-paths.md`). Curves threaded down the mountain: the race
lines that form the course spine and carry the distance-to-finish progress
metric, the AI/respawn paths that mark the racing line and where a fallen
rider is put back, and the grind-rail splines the board locks onto. The
player's start position derives from this data.

**Logic** (`150-logic.md`). Dynamic behavior lives in a level-wide graph of
effect chains built from typed nodes — play a sound, run a function, emit
particles, swap or animate a mesh. Instances reach it through an effect
slot: a bundle of chain references keyed by circumstance (persistent,
player collision, …). Boost pads, breakables, fireworks triggers, scrolling
textures, and the start gate are all expressions of this one mechanism.

**Lighting** (`160-lighting-data.md`). All lighting is baked into the data:
terrain patches reference tiles in shared lightmap pages, and each instance
carries a small baked lighting block (an ambient colour plus a few
directional keys). There is no run-time light solve over the static world.

**Materials** (`170-materials.md`). A material binds an object mesh to a
texture plus its appearance rules — alpha mode (opaque / cutout / blend),
flipbook frame cycling, UV scroll. Terrain bypasses materials and names its
textures directly.

**Particles** (`180-particles-data.md`). Emitter parameter blocks carried
as logic-graph nodes — timer-driven (fireworks, gem sparkles, fog) or
collision-driven (impact debris) — all drawing their sprites from one
shared sprite bank.

**Audio** (`190-audio-data.md`). Sound banks of indexed slots, assigned to
fixed groups by scope (global, board, per-level course, crowd, …); the
intro-music stems; the interactive in-race music graph; and the announcer's
speech bank.

## A level on disc

Original game data is packed in archives; the disc layout, the archive
container, and the compression that wraps most members are
`200-archives.md`. One level is one archive whose members share the
course's name, plus the level's slice of the shared audio data:

| Data | Holds | Format |
|---|---|---|
| `<course>.pbd` (and its skybox sibling) | the world database: patches, instances, models and meshes, materials, lights, splines, cameras, flipbooks | `220-level-pbd.md` |
| `<course>.ssf` | the behavior database: object properties, the logic graph, collision proxies, physics bodies | `230-level-ssf.md` |
| texture, lightmap, and skybox banks | every texture the level draws | `210-textures-ssh.md` |
| `<course>.aip` / `<course>.sop` | race lines, AI/respawn paths, start positions | `250-paths-aip-sop.md` |
| `<course>.ltg` | the world spatial grid (a broad-phase index over patches, instances, splines, and lights, plus per-cell light lists) | `160-lighting-data.md` |
| sound banks and music streams | SFX banks (global + per-level course bank), intro-music stems, announcer speech | `260-audio-files.md` |
| the in-race song files | the interactive-music graph and its chunked audio stream | `270-music-graph.md` |

Rider and board models are not level data; they ship once, in shared
character archives (`240-models-mpf.md`).

## One run, end to end

The rider drops in at a start position derived from the path data, and the
simulation begins advancing on its fixed tick (`002-conventions.md`,
`300-rider-states.md`). Each tick, contact with the terrain is resolved
against the true curved patch surface (`110-terrain.md`) through a soft
contact spring (`320-ground-contact.md`), and the surface type underfoot
selects the whole response — drive, turn, drag, sink
(`310-surface-response.md`, `330-carving.md`). Carving throws snow spray
and cuts a wake into the slope, both per-surface, carve-gated effects
(`380-carve-effects.md`).

Riding over a boost pad fires that instance's player-collision chain in the
logic graph (`150-logic.md`) and arms the boost path of the speed model
(`360-speed-and-boost.md`). Clipping a fence runs a breakable response —
mesh swap, debris, sound (`370-world-interaction.md`); collecting a gem
chimes and despawns it (`390-pickups-and-race.md`). A rail attaches the
board to its spline for the grind (`350-rails.md`); a kicker launches it
into the air model — ollie blend, two-stage gravity, damped air control —
and the landing is absorbed back into ground contact
(`340-jump-air-landing.md`).

Presentation tracks the run throughout: terrain tessellation follows the
camera (`400-rendering.md`), flipbooks animate the crowd and signs
(`410-texture-animation.md`), per-surface ride audio and triggered effects
resolve through the sound banks (`420-audio-runtime.md`), and the
interactive music walks its graph while the announcer reacts to events
(`430-music-and-announcer.md`). Crossing the finish is its own dedicated
game event fired at a placed finish marker — not a reading of the
race-line progress metric that measured the whole descent — and drives the
finish celebration, announcer line, and music cue
(`390-pickups-and-race.md`).

## How this spec fits together

The spec is split into parts that serve different consumers; chapter
numbers encode the part.

- **Part 1 — World data model** defines what a level *is*, independent of
  encoding. Third-party replacement assets target this model directly.
- **Part 2 — On-disc file formats** defines the original encodings, needed
  only to load game data from a disc the user owns. Each format chapter is
  the byte layout behind one or more Part 1 chapters, which it names.
- **Part 3 — Runtime behavior** defines how the world behaves and how
  riding feels.
- **Part 4 — Presentation** defines the observable rendering and audio
  output model.

A useful implementation is Part 1 + Part 3 (+ Part 4), with Part 2 as the
optional original-asset loader. Conventions shared by every chapter —
units, axes, timebase, confidence annotations — are `002-conventions.md`.
