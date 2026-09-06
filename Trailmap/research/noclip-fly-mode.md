# Noclip / fly-mode ELF patch (Triangle+Circle)

`tools/patches/noclip_patch.py` patches SLES_505.45 with an in-game fly mode for
inspecting levels in PCSX2 (or hardware). Same-size in-place patch — pairs
with `snowknife iso-replace <iso> SLES_505.45 <patched elf>` on any ISO from
the repack pipeline.

## Controls

| Input | Effect |
| --- | --- |
| TRIANGLE + CIRCLE (press together) | toggle noclip; boost meter pins full while active |
| Left stick up/down | fly into / away from the screen (camera-relative) |
| Left stick left/right | strafe screen-left / screen-right |
| SQUARE | ascend |
| X | descend |
| R1 (hold) | 4x speed |

Ride-tested on retail GARI (live PINE session). Flight is
CAMERA-RELATIVE (freecam-style): forward = the horizontalized, normalized
direction from the active camera to the boarder, strafe = its screen
perpendicular — controls always match what the player sees. Camera position
= worldObj + *(worldObj+0x290)*128 + 0xB0 (the camera-centred grid-query
record; live-verified ~160 units behind / ~200 above the rider). The local
boarder pointer lives at worldObj+0xA4 (the +0x41C==1 entry). Earlier
schemes that derived direction from the boarder pose matrix (v4/v5) or a
stored heading (v6) all had failure modes: pose-relative flew vertically or
whirled when the body pitched; a stored heading was invisible and went
stale vs the view. While active, the cave writes the boarder VELOCITY
(+0x150) each frame — 12 m/s (48 with R1) — and the game's own integrator
moves the rider, which keeps the follow camera framing correct
(v3 lesson: writing position with velocity zeroed collapses the chase
camera into a degenerate under-the-rider view). Gravity's per-frame
contribution is overwritten on the next write. Turning composes an exact
unit yaw quaternion onto the orientation quat +0x170 (w,x,y,z) about world
Z. The control-state input feed is zeroed, so the stick does not
spin/jump/boost the rider. The boost meter is pinned to full as the "mode
on" lamp (same field the uber-tier infinite-boost pin writes). Diving into
terrain settles/lands safely. All other systems (race timers, SSF triggers)
keep running; flying into an out-of-bounds reset region still warps you.

**World axes: Z-up.** Position +0x140 = (x, y, z-up); the +0x4AA0 boarder
matrix rows are 0=right, 1=forward, 2=up. (First flight build wrongly used
row 2 as forward and +0x144 as up — symptom: stick moved the rider
vertically, world-Y "vertical" moved them horizontally.)

**Known hazard (unresolved):** engaging noclip during the race-START
sequence hung the EE in a clean infinite loop (no TLB faults; pad polling
stopped; force-disarm did not recover) with the rider hovering ~12m above
the gate — suspected scripted start-camera path solver. Reproduced once on
retail via hot-install. Avoid toggling until the run camera is in normal
follow mode. In-run toggling is stable.

The cave makes NO function calls and writes only boarder fields + its own
data block. An earlier revision played the boost-pad cross sfx on toggle;
that crashed at level load: the effect singleton `*(0x00344250)` is set on
level init but never nulled on teardown, so a toggle outside a live level
enqueued a 24-byte ring event through a dangling pointer, which overwrote
the world registry global `0x00338E58` (its only legit writers are ctor
`0x0017c608` and dtor-null `0x0017c764`) and SharedUpdate then crashed to
pc=0 through the nulled world. Noclip now gates on `*(0x00338E58)` and
`*(registry+0x730)` being non-null and force-disarms otherwise, so leaving
a level (or a mid-load half-built frame) always turns it off.

## Hooks (all j-detours into the dead-code cave)

| Site | Displaced pair | Purpose |
| --- | --- | --- |
| `0x0017b104` | `sh v1,0x18(s2)` / `sw a3,0x24(s2)` | pad decode (device port 0 only): capture raw held mask + LX/LY into cave data every frame, works while paused |
| `0x001171f4` | `lui at,0x4270` / `mtc1 at,f3` | BoarderMotion_SharedUpdate, past the +0x46B0 enable and registry pause gates: world-alive gates, toggle edge-detect, boost-meter pin, freeze velocity `+0x150`, move position `+0x140` relative to the active camera on the world XY plane, vertical |
| `0x00117b7c` | `lw a0,0x5AE0(s1)` / `jal 0x0011c9a8` | zero the packed input word (SharedUpdate sp+48) before the control-state dispatch while active |
| `0x0011d838` | `addiu sp,sp,-80` / `sd s0,0(sp)` | Boarder_EnterWipeOut prologue: while active, return immediately for the local human — object bumps, wall crashes, and hard landings no longer wipe out (AI riders unaffected) |

Cave: dead blob `0x002b4c40..0x002b50c0` (1152 B usable, 632 B occupied —
caves A `0x002b4c60` / B `0x002b4c90` / C `0x002b4e40` / D `0x002b4e80`).
Data block at `0x002b4c40`: active, prevButtons, mask, LX, LY, heading.
Deadness is vetted by a FULL reference scan — j/jal targets, all branch
forms, lui+lo16 pairs, and 32-bit pointer constants anywhere in the file —
plus entry-unreachability (the run sits behind an unconditional `jr`/`j`
and contains no referenced word, so nothing can jump or fall into it).
Jump-target absence alone is NOT deadness: `jr ra` stubs can be default
no-op virtual methods reached only through `.data` vtables (the row
`0x00122d68..0x00122d98` is exactly that — ~32 boarder-motion vtables call
into it at level start).
Gates: everything requires boarder`+0x41C`==1 (local human), so AI riders are
unaffected.

Raw held-mask layout (active-high `nor` of rdata[2..3], see
`PadDevice_ConnectionStateMachineAndRead` in the DB): low byte
L2/R2/L1/R1/TRI/CIR/X/SQ = 01/02/04/08/10/20/40/80; high byte
SEL/L3/R3/START/UP/RIGHT/DOWN/LEFT.

Tunables (`noclip_patch.py`): `F_MOVE_K` 0x3E40 (24 units/frame full stick,
~12 m/s at 50fps), `F_VERT` 0x4190 (18 units/frame), `F_DEADZONE` 0x41D0
(26/128 ≈ 20%). All lui-encoded float halves.

Forward-sign caveat: "forward" uses matrix row 2 with stick-up positive; if
in-game movement turns out inverted, negate the `neg_s(2, 2)` in
`build_cave_b`.

## Build

```
python tools/patches/noclip_patch.py            # writes extracted/SLES_505.45.noclip, self-verifies
cp discs/ssx-tricky.iso discs/ssx-tricky-noclip.iso
snowknife iso-replace discs/ssx-tricky-noclip.iso SLES_505.45 extracted/SLES_505.45.noclip
```

## Live iteration via PINE

With PCSX2's PINE enabled (TCP 127.0.0.1:28011), the patch can be developed
against a RUNNING game — this is how the flight model was tuned:

- `tools/instrumentation/pine_hooks.py status|on|off|a/b/c on/off|save N|load N` — flip the
  three detour sites between stock and hooked words in EE RAM, inspect cave
  state, drive savestates.
- `tools/instrumentation/pine_install.py install|revert` — write every word that differs
  between the stock and patched ELF into RAM (hot-install into an unpatched
  retail session, or hot-upgrade a cave). Safe sequence for replacing a live
  cave: write `active=0`, `pine_hooks off` (detours to stock), install, done
  — PCSX2's recompiler picks up PINE code writes (verified).

PINE protocol: request = u32 packetSize, u8 opcode, payload; opcodes 2/6 =
read32/write32 (u32 addr [, u32 value]), 9/10 = save/loadstate (u8 slot);
reply = u32 size, u8 result (0=ok), data.
