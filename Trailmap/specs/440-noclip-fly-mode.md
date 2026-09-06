# 440 — Noclip fly mode (ELF patch)

A **byte patch to the boot executable** that adds an in-game fly mode for
inspecting levels: TRIANGLE+CIRCLE toggles it, the left stick flies
camera-relative (forward = into the screen, left/right = screen strafe),
SQUARE/X ascend/descend, R1 holds 4x speed, and the boost meter pins full
as the "active" lamp. Local human rider only; AI riders are unaffected.
Applied to any pipeline ISO by `snowknife noclip <iso>` from the emitted
patch file; authored by `tools/patches/noclip_patch.py` (this workspace).
[[440-overview]]()

> [[440-overview]]() db:input; db:elf;
> map:"Noclip fly-mode patch points and the structures it rides";
> boot ELF SLES_505.45 (PAL) and SLUS_203.26 (NTSC-U).

## Per-build targets

The patch is authored against two builds, PAL and NTSC-U. Their **class layouts are
identical**: the boarder fields the cave writes (boost meter, position, velocity, the
local-human flag), the world fields it gates on (active camera index, world object), the
camera record it reads, and the pad decode's port and output fields all sit at the same
offsets in both. That was established by walking each of the four hooked functions in
both executables and classifying every divergence — all of them are absolute references
(a jump target, a `lui` half, or the low half of a global paired with one), and none is a
load/store displacement, which is what a moved field would look like. Only the hook,
cave, dispatch and singleton addresses differ between the builds, and the generator
identifies which build it holds from the hook-site instructions themselves.
[[440-targets]]()

> [[440-targets]]() db:elf; map:"Noclip hook, cave and singleton addresses per build";
> PAL SLES_505.45 vs NTSC-U SLUS_203.26 — pad decode 0x0017B104 / 0x0017B0EC;
> BoarderMotion_SharedUpdate 0x001171F4 / 0x001171EC; control-input feed
> 0x00117B7C / 0x00117B74; Boarder_EnterWipeOut 0x0011D838 / 0x0011D830;
> control-state dispatch 0x0011C9A8 / 0x0011C9A0; registry singleton
> 0x00338E58 / 0x00337C58; dead-code cave 0x002B4C40..0x002B50C0 /
> 0x002B3A68..0x002B3EE8 (1152 B in both). Shared field offsets: boarder +0x1C boost,
> +0x140 position, +0x150 velocity, +0x41C local-human; world +0x290 camera index,
> +0x730 world object; camera record +0xB0; pad +0x3C port, +0x18 / +0x24 outputs.

## Code cave

A **1152-byte dead-code blob** (three unnamed library-area functions) hosts
a data block (toggle state, captured pad state) and four cave routines in its
first 632 B; ~520 B remain free for future features. Cave deadness demands a
**full reference scan**, not just jump-target absence: no jal/j targets, no
branch targets of any form, no lui+lo16 address pairs, no 32-bit pointer
constants anywhere in the file (data included — C++ vtables hold code
pointers in `.data`), and entry-unreachability (the run sits behind an
unconditional `jr`/`j` with no referenced word inside, so neither
fall-through nor any branch can enter). Tiny `jr ra` stubs that look dead can
be live default no-op **virtual methods**: the shared no-op stub row is held
by ~32 boarder-motion vtables and is called at level start. [[440-cave]]()

> [[440-cave]]() db:elf; cave blob 0x002b4c40..0x002b50c0 (1152 B, three
> unnamed library-area functions); the live no-op stub row
> 0x00122d68..0x00122d98 (held by ~32 boarder-motion vtables, called at
> level start).

## Patch points (all j-detours over two-instruction pairs)

| Function | Purpose |
| --- | --- |
| pad decode (the sole scePadRead caller) | capture the raw held mask + left-stick bytes for pad port 0 every frame |
| BoarderMotion_SharedUpdate, past its enable/pause gates | toggle edge-detect, world-alive gates, boost-meter pin, camera-relative velocity write |
| SharedUpdate control dispatch (input word on its stack, sp+48) | zero the packed control-input word while active |
| Boarder_EnterWipeOut prologue | return immediately while active — object bumps, wall crashes, and hard landings all funnel through this one entry |

[[440-hooks]]()

> [[440-hooks]]() db:input; db:elf; hook sites (all j-detours over
> two-instruction pairs): pad decode 0x0017b104 (sole scePadRead caller
> 0x0017b098), BoarderMotion_SharedUpdate 0x001171f4, SharedUpdate control
> dispatch 0x00117b7c, Boarder_EnterWipeOut prologue 0x0011d838.

## Engine structures it rides

- A **registry singleton** (with its constructor and null destructor) holds
  the **world object**; both are the world-alive gates — noclip force-disarms
  when either is null.
- The **active camera position** is read from the camera-centred
  render-gather grid-query record hung off the world object (floats, x,y,z-up).
- The **local boarder** is reached off the world object and identified by a
  per-record local-human marker; its velocity, position, and boost meter each
  live at a fixed offset on that record.
- Raw held mask (active-high nor of pad bytes 2..3): low byte
  L2/R2/L1/R1/TRI/CIR/X/SQ = 01/02/04/08/10/20/40/80, high byte
  SEL/L3/R3/START/UP/RIGHT/DOWN/LEFT.
- Movement writes **velocity, not position** — the chase camera aims from
  velocity and the integrator re-caps speed — and the world is **Z-up**.

[[440-structs]]()

> [[440-structs]]() db:input; db:elf; registry singleton 0x00338E58 (ctor
> 0x0017c608, dtor-null 0x0017c764), world object at *(registry+0x730);
> active camera position = worldObj + *(worldObj+0x290)*128 + 0xB0; local
> boarder = worldObj+0xA4 (local-human marker +0x41C == 1), velocity +0x150,
> position +0x140, boost meter +0x1C.

## Assembly caution

R5900 `SQRT.S` (and `RSQRT.S`) source from the **ft field** (fs must be 0),
unlike every other unary COP1 op — standard-MIPS encodings compute
`sqrt(f0)` silently. Cross-check hand assembly against the game's own
instruction stream. [[440-sqrt]]()

> [[440-sqrt]]() db:elf.
