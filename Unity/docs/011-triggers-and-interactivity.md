# 011 — Triggers & VRChat Interactivity

> Fireworks, reset zones, collision-triggered particle graphs, and speed/trick pads are now built and wired.
> See [019 — Fireworks](019-fireworks.md) and [040 — Boost Pads](040-boost-pads.md). This doc records the
> shared native contact contract plus the remaining logo/race roadmap. Checkpoint time awards are now
> realized from SOP path events, not from prop contact. The importer hides a
> `Visable=false` host's render mesh ([003 gotcha 4](unity/003-props.md)) while its specialized builder keeps
> any valid trigger geometry.
> Developed against a locally converted level.

> **Normative behavior:** this realization follows [Trailmap:
> 130-collision-data, 150-logic, 370-world-interaction]. The spec defines the
> shared contact result used by Slopesmith and Unity and cites the RE/PCSX2
> evidence; this document records Unity's realization and approximations.

## Native contact-state contract (current)

Trigger realization follows the shared state split required by the spec:

| State | Native data | Unity realization | Behavior |
|---|---|---|---|
| detached / persistent-only host | `PlayerCollision=false`, `None` (0) | no trigger collider | cannot dispatch collision logic |
| authored contact trigger | `TriangleProxy` (1), generated box, `responseMass=0` | exact-size `BoxCollider(isTrigger)` | overlap dispatches; rider passes through |
| extracted box trigger/pad | `BoundingBox` (2), zero response mass | bundle AABB `BoxCollider(isTrigger)` | overlap dispatches; rider passes through |
| physics-body prop | `PhysicsBodySpheres` (3), valid `PhysicsIndex` | decoded body boxes / Rigidbody path | solid, hollow, or movable body behavior |

`Visable` is not a collision state: it only controls rendering. Mode 1 needs a
proxy and mode 3 needs a real body; choosing either number without its required
shape produces no native contact. Unity’s authored `EffectTrigger_` volumes keep
their Slopesmith-authored size exactly, while retail thin-pad inflation remains
an importer approximation for fast riders.

The red walls that appear to block the course are never scenery: they're SSX's
**invisible marker volumes** — triggers, reset zones, phantom collision boxes — wearing a red no-entry
placeholder texture. The game obeys their `Visable=false` flag and never draws them; the importer does
too. Each one is a live wire into the game's scripted-effect and race-logic system: in the original they
fire fireworks, reset out-of-bounds players, break logos, and switch race modes. In VRChat those same
wires can re-point at Udon behaviour. The same `EffectSlotIndex` hook also appears on a tier of *visible*
props (boost pads, checkpoint *signs*, crash bags, hazard signs), so this isn't only about the hidden volumes.
This doc catalogs their current realization and the remaining interaction opportunities.

## What we have (the volumes, and what each links to)

All are `Visable=false` instances in `Instances.json`, so their placeholder render geometry is skipped by
`PropBuilder`; trigger/reset/body builders consume the relevant data separately. The join key into the logic
layer is each instance's **`EffectSlotIndex`** (and, for physics-body shapes, `PhysicsIndex`).

| Model | ×  | Today it's… | Links via | Could become (VRChat) |
|---|---|---|---|---|
| `Mdl_FWTrigger` | 23 | firework / event **trigger** | `EffectSlotIndex` → `Effects.json` `slots[].circumstances.collision` | pyro, crowd cheers, audio stingers as you pass |
| `Mdl_ResetZone_40x40` | 20 | out-of-bounds **reset** volume | `EffectSlotIndex` (45) + `AIP/SOP.RaceLines` / `StartPosList` | respawn the player to the course |
| `Mdl_Radiotower_PhantomBox` | 5 | invisible **collision** box | `PhysicsIndex` (geometry, not a trigger) | keep as an invisible wall (already does — [009](009-collision.md)) |
| `Mdl_Lcd_ScreenLogoBroken[Red]` | 10 | hidden "broken screen" **render variant** | `Effects.json` `functions[]` `BreakLogo*` | swap in when a player smacks the jumbotron |

The `FWTrigger` volumes carry **sequential** effect slots (55, 56, 57 …), one per trigger — so each is
an individually addressable event, not a shared one.

## The visible side: props that carry the same triggers

The `EffectSlotIndex` hook isn't only on the invisible volumes — a tier of **visible, collidable** props
carries it too, so they're the in-plain-sight half of the same collision-effect system. These render
normally today (they're `Visable=true`, so the [003 gotcha 4](unity/003-props.md) skip doesn't touch them); the
specialized builders act on the decoded fireworks, ambient-emitter, and boost/reset subsets; other links remain
available for later behaviors.

| Model | × | `EffectSlotIndex` | Today it's… | Could become (VRChat) |
|---|---|---|---|---|
| `Mdl_SpeedBoost_Gold` | 2 | 0 | speed-boost pad (scrolling gold arrows, [008](008-texture-animation.md)) | a forward speed burst as you cross it |
| `Mdl_TrickBoost_RedGreen` | 3 | 1 | trick-boost window pad | a temporary trick/control bonus window |
| `Mdl_CheckPoint_Top` | 6 | 27 | flashing checkpoint sign | visual/effect cue only; the type-11 race-line station is the checkpoint |
| `Mdl_Obstacle_PathMarker` | 39 | 46 | on-course path markers (+`PhysicsIndex`) | "wrong way" nudge / off-course warning |
| `Mdl_Barricade_CrashBagA` | 22 | 47 | soft crash-bag barrier (+`PhysicsIndex`) | bounce / knockback instead of a hard wall |
| `Mdl_WarningSign_Jump` / `_Gap` | 22 | 52 | hazard holograms (+`PhysicsIndex`; `_Gap` wears the red `0052` placeholder) | warning ping / HUD cue before a gap |

Unlike the `FWTrigger`s (one sequential slot each), these share a **single slot per visual type** (all speed
boosts → slot 0, all checkpoint signs → slot 27, …). The checkpoint slot animates/presents the sign; it
does not establish the crossing or its seconds. Those come from SOP `RaceLines[].PathEvents` type 11.
And the visible `Mdl_FireworkCylindar_Red` launchers (×47) are the
scenery half of the invisible `FWTrigger`s: they carry no slot themselves (`EffectSlotIndex = -1`), so the
trigger fires the pyro *at* the cylinder.

## The logic layer they plug into

These tables ship in the export today and are otherwise unused by the importer. They are the "what
happens" behind the "where":

- **`Effects.json`** — the scripted-effect system ("SSF logic"). This is the file the gltf-time bundlers
  read (`SsfLogic.Load`) and the one `snowknife unity` copies into the project. (A sibling `SSFLogic.json`
  serves the repack chain only: extraction writes it and the SSF compiler consumes it.) Rows are addressed
  by **stable IDs** (`graph:0119`), with each row's `originalIndex` carrying the native index:
  - `slots` (78): a trigger's `EffectSlotIndex` lands here. A slot's `circumstances` are its firing
    modes — `collision` names the effect graph to fire **on overlap** (e.g. FWTrigger slot 55 →
    `graph:0119`), alongside `persistent`, `trigger`, and `slot3`/`slot4`/`slot6`/`slot7`.
  - `functions` (20): the **named** behaviours — `CountDownStart` / `StartCountDown` / `EndCountDown` /
    `NoCountDown`, `HideStartGate`, `RaceMode` / `ShowoffMode` / `FreerideMode` / `HideRace` /
    `HideShowOff`, and `BreakLogo1000…7000`. This is essentially the level's event API.
  - `graphs` (306) + `physics` (56): the effect/physics payloads the slots reference (a graph's nodes
    under `graphs[].nodes[]`; a physics header's payload under `physics[i].data`).
    The *names* are generic (`Effect N`), but the **contents are not** — a graph is a real,
    parameterised **effect graph** (`MainType 7` nodes name the exact target instances; `MainType 2` nodes
    are particle emitters carrying spark count, gravity, velocity and colour; `MainType 8` plays a sound).
    The fireworks [019](019-fireworks.md) decode it; so we have both the **wiring** *and* the real payload
    values, not just our own guesses.
  - Also here: `objectProperties` + `instances` (the per-instance `effectSlot`/`physics` binding),
    `collisionModels`, `splines`, and `extensions` (where Slopesmith's authored attachments live).
- **`AIP.json` / `SOP.json`** — paths and race lines:
  - `AIPaths` (`Respawnable`, `PathPos`, `PathEvents`) — where a fallen rider gets put back.
  - `RaceLines` (`DistanceToFinish`, `PathPoints`, `PathEvents`) — ordered course spine; the
    `DistanceToFinish` is a ready-made race-position metric. Positive SOP type-11 events are showoff
    checkpoints: `EventStart` is the horizontal station and `EventValue` is seconds.
  - `StartPosList` (6) — spawn points.
- **`ParticleInstances.json` / `ParticleModels.json`** (10 each) — the authored particle effects and
  their prefabs (snow plumes, fireworks), already located in world space.

## What they could trigger in VRChat

VRChat worlds script in **Udon / UdonSharp**. We already ship one runtime behaviour of this shape —
`SurfaceDetector` (per-surface footstep audio + OOB respawn, [009](009-collision.md)) — so these are
incremental, not new infrastructure. Ordered roughly by value-for-effort:

1. **Out-of-bounds respawn**, board-driven. `CoursePathBuilder` bakes
   `AIPaths`(`Respawnable`) + `RaceLines` from `AIP.json`/`SOP.json` into a `RailNetwork` on
   `CoursePath` (`world = PathPos + PathPoint`, the usual `-x,y,z` root transform). The rideable
   board (`RideableBoard.resetToTrackOnOOB`) detects out-of-bounds — riding onto a `Surf_0` Reset
   patch, or a void fall off the world — and snaps the rider to the **nearest course-line point**
   (down-ray to the real terrain under the float-height line, facing down-course), carried back still
   aboard via the station. Purely **local**, loop-proof (you land on the in-bounds course line, not the
   fall-line above the patch), board-only so free-walking is unaffected. A breadcrumb trail is the
   no-path-data fallback (an authored map with no `AIP.json`). This is the path-table feature predicted here — via the
   board rather than standalone `ResetZone` volumes. Full implementation:
   [031 — Out-of-Bounds Reset](031-out-of-bounds-reset.md).
2. **Ambient pyro / fireworks (`FWTrigger`)**: on overlap, play a
   `ParticleSystem` burst at the linked `FireworkCylindar_Red` props (those *are* visible and already placed).
   Cheap, high-impact ambiance. Stays **local** (each visitor sees their own); a **networked** shared
   spectacle is left as a future option (see multiplayer notes). Implementation: [019 — Fireworks](019-fireworks.md).
3. **Crowd reactions & audio stingers** — `FWTrigger`s near the stands → a crowd-cheer one-shot plus a
   temporary bump to the crowd flipbook fps ([008](008-texture-animation.md)). Makes the venue feel
   alive as riders pass.
4. **Logo-break gags (`ScreenLogoBroken` + `BreakLogo*`)** — we import **both** the intact jumbotron
   logo and the broken variant; a trigger (or a thrown-snowball hit) swaps intact→broken, mirroring the
   game's `BreakLogo1000…7000` functions.
5. **Race mode & timing** — implemented: `RaceLines.DistanceToFinish` drives finish/laps/standings;
   positive SOP type-11 stations extend the Trick/showoff countdown; the Settings Board selects
   Race / Trick / Free ride and applies the matching prop/rail mode set.
6. **Synced race start** — `HideStartGate` + the countdown functions → a master-owned, **networked**
   countdown and gate-drop for multiplayer races.
7. **Speed & trick boosts (the visible pads)** — `SpeedBoost` (slot 0) / `TrickBoost` (slot 1). The engine
   distinguishes them [Trailmap: 360-speed-and-boost]: speed pads dispatch effect main type 17 and enable the
   boosted cap / ground speed-response path; trick pads dispatch main type 18, trigger
   feedback, and their one confirmed effect is on rail entry, where two setup values are scaled by `1.6`.
   **A trick pad never writes upward velocity.** For VRChat,
   make speed pads a local forward velocity nudge, and treat trick pads as a local trick/control/scoring
   window; an upward pop would be an adaptation, not confirmed original behavior.

## Current importer/runtime wiring

- **Importer:** bundle trigger records become empty GameObjects with no renderer and an
  exact/native-derived `BoxCollider(isTrigger)`. Neutral marker components carry the slot and decoded payload;
  platform wiring realizes them into runtime behavior. `PhantomBox` remains on the solid collision path
  ([009](009-collision.md)).
- **Visible trigger props:** boost pads keep their renderer and receive a sibling trigger. Retail thin-pad
  AABBs may use the configured fast-rider margin; authored `EffectTrigger_` boxes keep the exact Slopesmith
  dimensions shared by the ISO proxy.
- **Runtime:** the platform-specific wiring maps neutral fireworks, ambient-emitter, reset, and boost markers
  to their Udon behavior. The slot/payload mapping stays in bundle data so each level imports without code edits.
- **Checkpoint runtime:** snowknife interpolates each positive SOP type-11 event into
  `Paths.Course.Checkpoints` (local position, DTF, seconds, route group). `CourseProgressBuilder` stamps these
  onto `CoursePath`; `RaceProgressTick` applies the active forward DTF interval. Route copies share a group and
  the nearest event position supplies one award. `FinishLine.ShowoffSeconds` seeds the Trick countdown, while
  `RunTimeCs` remains elapsed for leaderboard results and `RunClockCs` is the mode-facing HUD clock. This
  realized runtime is Showoff/Trick-only. Retail Race also uses a type-11 station to display **CHECKPOINT** and
  advance a discrete per-rider checkpoint/standing counter without awarding time or points; the current Unity
  port does not model those race-side effects. In both modes, the nearby flashing sign remains presentation,
  not the trigger.

## Multiplayer caveats (VRChat-specific)

- **Local vs networked.** Respawn and personal ambiance are **local** (no ownership, no late-join
  problem). Anything others should see in sync (shared fireworks, a race countdown, a broken logo that
  *stays* broken) needs an Udon **owner** and networked variables — and a late-joiner sync path so the
  world state is correct on entry.
- **No real physics/friction.** As with collision ([009](009-collision.md)), VRChat exposes no
  per-surface friction and players aren't rigidbodies; interactions here are **cosmetic or
  teleport-based** (fire an effect, move the player), not physical forces.
- **Trust the flag, not the art.** The volumes are addressed by `Visable=false` + type + `EffectSlotIndex`,
  not by the red `0052` texture (which real, visible props also use). Keep the join on the data fields.

## See also

[003 — Props](unity/003-props.md) gotcha 4 (why these are hidden today), [009 — Collision](009-collision.md)
(the existing UdonSharp respawn/footstep runtime and the physics caveat), [008 — Texture
Animation](008-texture-animation.md) (crowd/sign flipbooks a trigger could nudge).
