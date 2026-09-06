# 027 — World Recenter (origin at the middle of the mountain)

> **Status: first implementation (local, untested on-device).** The importer can shift the whole level so the
> mountain's **centre** sits on the world origin instead of the summit, to fix Quest precision artifacts at the
> bottom of the run. Default **on** (`ImportConfig.RecenterToOrigin`). Developed against a locally converted level.

## The problem

SSX authored the level from the **summit at world ~0** down to roughly **−3000 m** at the base. On **desktop** the
level renders clean everywhere (fp32 has ~0.4 mm of precision even at 3000 m). On **Quest** the bottom of the
run visibly **wobbles / z-fights** while the top stays crisp.

That split — *fine near the origin, glitchy far from it* — is the classic **large-coordinate VR precision**
problem. The dominant effect on mobile GPUs is **catastrophic cancellation in the camera transform**: when the
player is thousands of metres from the world origin, every vertex of nearby geometry is computed as the tiny
difference of two large, nearly-equal numbers (`vertex_world − camera_world`), and Quest has far less headroom
for that than desktop. Standard VRChat-on-Quest guidance is to keep the playable area within roughly **±1 km**
of the origin.

## The fix

Shift the whole level so the terrain's bounding-box **centre** is the origin: a 0…−3000 m range becomes about
**±1500 m**, halving the worst-case magnitude. All three axes are centred by default — the error grows with
distance on *every* axis, not just the vertical drop (`RecenterAxisMask` can restrict it, e.g. `(0,1,0)` for
vertical-only).

This is **one translation** because of how the importer is structured: terrain, props, rails, gems, triggers,
audio and light probes are all built **under one root** (`OpenSlope_Map`) in **local** space. Moving the root's
**world** position translates the entire level in lockstep — no per-subsystem re-baking:

- **Rails** (`RailNetwork`) store points in local space and `transform.TransformPoint` them at runtime, so
  they follow the root.
- **Child AudioSources / probes / colliders** are descendants, so they move with the parent regardless of
  whether they were positioned in local or world space.
- **Board physics** integrate from the board's *current* position and respawn via VRChat's `_player.Respawn()`
  — no hardcoded absolute coordinate (no kill-plane) that a shift would break.

`LevelImporter.RecenterRoot` runs **last**, after every child is built. With the root still at position 0 it
transforms the terrain mesh's AABB centre to world space and sets `root.position` to its negation. The offset
is **deterministic** (same terrain → same offset every import), so the one-time scene-object shift below never
has to be redone.

## Objects outside the root

Two things live at **scene root**, not under `OpenSlope_Map`, so they don't ride along automatically:

| Object | How it's brought along |
|---|---|
| `StartGate` (posts + spawn anchors + board pool) | Its menu (**OpenSlope/Setup/Start Gate Boards**) is **recenter-aware**: it adds the root's current world offset to the hardcoded `LineCenter` and to the ground-raycast start height, so re-running it rebuilds the gate on the moved terrain. |
| VRChat spawn point(s) + any stray world-space objects | **OpenSlope/Tools/Recenter Scene Objects** (`SceneRecenter`) shifts the `VRCSceneDescriptor` spawns (and the current selection) by the **delta since it last ran** (tracked in `EditorPrefs` per scene), so it's idempotent. |

## Workflow

1. **OpenSlope/Load/Map...** — recenters the world (logs the offset).
2. **OpenSlope/Tools/Recenter Scene Objects** — once, to move the spawn point (+ select any stray objects first).
3. Re-run **OpenSlope/Setup/Start Gate Boards** — to place the gate in the new frame.

## Caveats / open items

- A 3 km course centred is still **±1500 m** — beyond the ~1 km comfort zone, so this **halves** the error
  rather than eliminating it. If the extremes still glitch on-device, the next levers are reducing `WorldScale`
  or splitting the run. **Not yet tested on Quest.**
- `RecenterToOrigin` defaults **on**; set it false on `ImportConfig` to keep the legacy summit-at-0 frame.
