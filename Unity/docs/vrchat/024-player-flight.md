# 024 — Free-standing trigger flight (the "jetpack" mechanic)

> **Status: BUILT, not yet ride-tested.** A common VRChat world mechanic: while on foot, **jump up and hold the
> trigger** and you get thrust in the direction your hand points — point where you want to go and fly. It runs
> **only when free-standing**; the moment you mount a [rideable board](017-rideable-board.md) it stands down,
> because on the board the triggers already mean ollie (right) and boost (left). One always-on local-only object,
> like the [surface detector](../009-collision.md) / music director. Defaults are a first pass — ride-test and
> retune the feel knobs.

## What it does

`VRC/Riding/PlayerFlight.cs` (UdonSharp, `BehaviourSyncMode.None`, runs on the local player only).

- **Gate — "jump up AND hold the trigger".** Thrust only applies while you're **airborne**. Holding the trigger
  while standing does nothing; you have to leave the ground first (the jump). A fresh upward velocity (the jump
  itself) counts as airborne too, so takeoff engages on the very jump even before you've physically cleared the
  ground probe — otherwise a small jump height could re-ground you before flight kicked in.
- **Jetpack, not noclip.** Gravity always stays on (we never touch gravity strength). Each frame while flying we
  read the player's current velocity — which VRChat has *already* applied gravity to — add `flyAccel` along the
  hand, lightly damp the horizontal, clamp, and write it back. Point up and out-thrust gravity to climb; point
  flat and you glide-and-arc down; let go of the trigger and you just fall and land normally. The
  read-add-write-on-top is exactly what makes it feel like a jetpack rather than free flight.
- **Direction source is platform-split.** VR follows the **right hand's** pointing direction and uses the **right
  trigger** (the left trigger stays free). Desktop has no tracked hand, so it follows the **head/look** direction
  and uses the **Use** action (click) as the trigger (toggle `desktopFlight` off for VR-only).

## Why a separate controller + board suppression

The triggers are overloaded: on the board the right trigger is the ollie and the left is the held boost
([017](017-rideable-board.md)). Udon input events (`InputUse`, `InputJump`) broadcast to *every* behaviour that
overrides them, so the flight controller and the board both hear the right trigger. To keep them from fighting —
and to avoid `SetVelocity` fighting the board's immobilized station carry — the board **suppresses** the flight
controller while ridden:

- The board auto-finds the controller at `Start` by path (`OpenSlope_Map/PlayerFlight`); null = the feature isn't
  set up, and every call no-ops, so old boards / a flight-less scene still work.
- `OnStationEntered` (local) → `SetBoardSuppressed(true)`; `OnStationExited` (local) → `SetBoardSuppressed(false)`.
  Suppressing also clears the held/flying state, so a dismount never leaves you mid-thrust.

No per-board wiring — the board finds the singleton itself.

## Setup

`OpenSlope/Setup/Player Flight` drops a single `OpenSlope_Map/PlayerFlight` object carrying the component (the
same two-step program-asset bootstrap as the music director — run it once to create+compile the program, again to
attach; see [013](013-udon-components.md)). It lives under
`OpenSlope_Map`, so a **re-import rebuilds `OpenSlope_Map` and clears it — re-run after every re-import**, same as the
music director / surface audio steps. The transform is irrelevant: the runtime works off the player's world
position + raycasts and never reads its own transform, so `OpenSlope_Map`'s -90X/0.01 scale ([004](../unity/004-orientation-and-scale.md))
doesn't touch it.

## Feel knobs (on the component, all tunable)

| Knob | Default | What it does |
|---|---|---|
| `enableFlight` | true | Master on/off. |
| `desktopFlight` | true | Let desktop fly along the look direction (Use = trigger); off = VR-only. |
| `flyAccel` | 25 m/s² | Thrust along the hand. Must beat ~9.8 gravity to climb when pointing straight up. |
| `maxHorizontalSpeed` | 14 m/s | Horizontal flight-speed cap (only clamped while flying). |
| `maxVerticalSpeed` | 12 m/s | Climb/descent cap **while flying** (normal falling untouched). |
| `horizontalDrag` | 1.2 /s | Bleeds sideways momentum so you can re-aim; 0 = pure ballistic. |
| `groundProbe` | 0.2 m | How far below the feet still counts as grounded (the airborne gate). |

## Known edges / follow-ups

- The right trigger / desktop click is also VRChat's interact-with-pickups action, so holding it to fly while
  pointing at a pickup can grab it. Acceptable for a free-roam world; noted in case it bites.
- Local-only, like the board — no networked "watch someone fly" state. Fine for a casual world; a follow-up if
  spectating flight ever matters.
