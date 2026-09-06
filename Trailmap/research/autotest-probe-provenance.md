# Autotest probe provenance

> spec:150-dispatch-runtime; spec:150-control-state;
> spec:230-deadnode-modes; spec:230-splinemover;
> spec:360-pads-duration; spec:360-pads-ownership;
> spec:390-gems; spec:390-teleport; spec:410-flip-runtime

This note owns the runtime layouts, address-level derivations, failed probes,
and measured values used by Slopesmith's authored autotest courses. The
Slopesmith source retains only semantic watch names, executable numeric probe
configuration, observed outcomes, and references to the clean specs.

## Instance and rider observations

The harness finds an authored instance by name hash and confirms it against
the instance translation at `entity+0x30`. Its universal dispatch observation
is the live effect-node slot at `entity+0xe4`; the instance status word is at
`entity+0xe8`. A live-node slot must be sampled as a history because short
nodes can install and release between ordinary host samples.

Rider observations used by the fixtures are:

- speed-cap request countdown at `boarder+0x134`;
- trick-window countdown and companion flag at `boarder+0x138/+0x13c`;
- trick-score multiplier at `TrickScoreState+0x28`, reached from
  `boarder+0x5848`;
- velocity at `boarder+0x150`; and
- sample-to-sample position displacement for course resets and teleports.

These layouts are probe implementation details. Their behavioral meaning is
specified by `spec:360-pads-duration`, `spec:390-gems`, and
`spec:390-teleport`.

## Adjusted node pointers

The live-node slot does not always hold the allocation base. The control
dispatcher takes a this-adjust from the vtable before calling a receiver.
For the animation-delta family the registered effect-node subobject begins at
allocation `+0x30`, so the receiver's allocation-relative `+0x68` field is
read at slot-relative `+0x38`. The AnimObject clock and finished flag likewise
sit before the registered pointer and are watched at `-0x0c/-0x20`.

The original unadjusted animation probe read past a 108-byte allocation and
returned allocator poison. This negative result is retained because a
plausible but unverified receiver offset otherwise looks exactly like a
command that never arrived.

## Effect-thread ownership

A collision effect thread records its host instance at `thread+0xe4` and its
owner boarder at `thread+0xe8`. Rider-acting immediate opcodes receive that
owner rather than resolving the touching rider themselves. The thread is not
reachable through the instance's live-node slot; treating the smaller node as
the thread returned allocator poison.

The working probe therefore heap-searches for a block whose `+0xe4` equals the
cell's instance address, then watches `+0xe8`. It carries proof fields too:
`+0x40` is a deliberately ticking Wait countdown, `+0xe4` is read back as the
search key, and ctor-written `+0xe0` must not retain poison.

For the three adjacent dispatcher cases, the native evidence was that each one
passes the thread owner read from `+0xe8` straight into its handler:

| Dispatcher site | Handler | Case |
|---|---|---|
| `0x0013c3a8` | `0x00118f18` | main 13, course reset |
| `0x0013c410` | `0x0011e918` | main 17, speed pad |
| `0x0013c434` | `0x0011e938` | main 18, trick pad |

The speed-pad store is in the return delay slot at `0x0011e934`; the trick
pad has the same always-store shape. Putting reset, speed pad, and trick pad
on one chain gives them one thread and one owner. Reset movement is the
control that proves whether that owner is the measured rider.

Forty-two race passes produced three cases where both separate pad cells wrote
and thirty-nine where neither did. A later same-chain probe showed the gate is
per contact, not per pass: the owner matched the local rider exactly when the
requests appeared and was a different real boarder when they did not. Showoff
mode, with one rider, makes all three pad cells deterministic. Direct reads of
absolute `0x134/0x138/0x13c` stayed zero, ruling out a null owner; those were
the addresses a null-based write would have touched.

## Texture, lifetime, and mover watches

The texture-flip probe watches slot-relative words `+0x14`, `+0x5c`, `+0x60`,
`+0x64`, and `+0x2d0`: subtype, applied frame, captured material count, frame
count, and enable state. The renderer receives a node-local override table;
the source material record is not rewritten. See `spec:410-flip-runtime` for
the behavioral contract.

DeadNode modes are distinguished through ordered live-slot histories and
instance-status histories. The destroy/stop operation dispatches through the
installed node's vtable, so a single sampled value cannot distinguish the
outcomes. See `spec:230-deadnode-modes`.

The first spline-mover probe tried slot-relative mappings for native
`cSplinePathNode` fields and failed: neither candidate host word matched the
known instance, and one candidate was allocator poison. The mover is found by
heap-searching for the host at `node+0x78`, then watching travel advance
`node+0x4c`, distance `node+0x50`, end distance `node+0x74`, and pause
`node+0x40`. Three passes each found one moving candidate at a different heap
address. Advance held 33.3333, distance rose about 2000 units/s at 60 Hz, and
wrapped near the 12715.74 end distance. See `spec:230-splinemover`.

## Teleport measurement

Three authored MainType-24 passes moved the rider 132.9 m between adjacent
samples, arrived 3.00 m from the target, and reduced 23.9 m/s to zero. The
native handler `Boarder_WarpNearInstance` at `0x0011a0a0` scales a direction
by literal `300.0f` before adding the target translation; the shared placement
call zeroes `boarder+0x150`. `spec:390-teleport` owns the resulting behavior.

The first verdict missed the warp because displacement needs the sample before
dispatch while other rider signals are peaks beginning at dispatch. Giving
the jump observation one lead-in sample recovered 132.9 m from all three saved
runs without changing the control cell.
