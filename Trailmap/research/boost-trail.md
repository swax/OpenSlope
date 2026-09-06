# Boost board trail

The coloured boost shape behind the board is a **sampled geometry afterimage**, not one of the shared-particle
sprites. `BoarderRender_Update` owns a seven-record ring; each 64-byte record is four world-space vectors
recovered from the current board pose. The ordinary board render builds one more live record, then a dedicated
draw helper joins it to the history. This is why the effect follows deck roll and airtime rather than sitting on
the snow, and why no `strk` particle-bank handle has a live code reader. [[boost-trail-kind]]()

## Lifecycle

The update is gated by the global game-frame index modulo three, so it advances at **20 Hz** under the 60 Hz
simulation. Its first ring begins at `BoarderRender+0x20`: seven 0x40-byte pose records, then the next-write index
at `+0x1e0` and live count at `+0x1e4`. While either the held-boost amount (`Boarder+0x130`) or speed-pad request
(`+0x134`) is positive, it writes one current pose, advances the head modulo seven, and saturates the count at
seven. When neither is positive it writes nothing and subtracts one from the live count on each 20 Hz update.
The render waits for at least two records, so engage has no isolated one-quad flash; release contracts the
oldest extent one record at a time and is no longer drawable after about 0.30 seconds (the bookkeeping reaches
zero one tick later). [[boost-trail-life]]()

There is **no grounded/contact test** in this gate. The renderer only asks whether held or pad boost is requested,
so the same board-space trail is valid while airborne. [[boost-trail-air]]()

## Colour

Held boost selects one of three RGB tables from the boost meter (`Boarder+0x1c`); the compares are the same
rough thirds used by the cap and engage cue. A speed-pad request bypasses the meter and selects the strongest
red. The runtime initializer writes: [[boost-trail-colour]]()

| condition | RGB |
|---|---:|
| meter ≤ 0.33363 | `(1.000, 0.9645, 0.000)` yellow |
| 0.33363 < meter ≤ 0.66648 | `(1.000, 0.4746, 0.000)` orange |
| meter > 0.66648, or pad boost | `(1.000, 0.0758, 0.002)` red |

## Rendering evidence

`BoarderRender_CaptureBoostTrailPose` writes four 16-byte vectors per slot. `BoarderRender_Draw` captures the
live pose on the stack and calls the trail draw helper only when the ring count is at least two. The helper walks
backward from the ring head (wrapping six → zero), emits two growing vertex sequences, and applies its age ramp
to the one RGB value stored beside the ring. The exact authored board attachment points are folded through VU
matrix operations, but the storage and two-strip topology are explicit; modelling two narrow edge sheets from
the drawn deck pose preserves that recovered contract without pretending the effect is a sprite emitter.
[[boost-trail-geometry]]()

> [[boost-trail-kind]]() `BoarderRender_Draw` @0x001364d8 calls the trail path @0x00136544 before the snow-buffer
> renderer @0x001365b4; `BoarderRender_CaptureBoostTrailPose` @0x00136c50 writes four vectors to `a1+0x00/10/20/30`;
> `research/light-flares.md` records the statically orphaned `strk` handle table.

> [[boost-trail-life]]() `BoarderRender_Update` @0x00136150: frame `% 3` @0x00136178–8c; active tests
> `+0x130/+0x134` @0x00136198–b4; 0x40-byte address and modulo-seven head/count update
> @0x00136284–d4; inactive count decrement @0x001362d8–e8. Ring clear @0x00136ea8.

> [[boost-trail-air]]() inspected complete active gate @0x00136194–2f0: no grounded, surface, rail, or contact
> field is read before the pose-ring update.

> [[boost-trail-colour]]() meter compares @0x001361e4–24c; pad-direct red branch @0x001361cc–e0; RGB runtime
> initializer @0x00136ee8–f8c writes tables 0x003bd530/40/50.

> [[boost-trail-geometry]]() draw gate/current capture/helper call @0x00136544–70;
> `BoostTrail_DrawHistory` @0x001f0dc8 reads count/head and the four-vector records and submits two strips.
