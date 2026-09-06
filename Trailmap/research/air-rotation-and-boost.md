# Air rotation, gravity, and boost

How the board rotates and accelerates in the air, and what a boost actually
changes — the porting-relevant numbers for spin/flip rate, gravity, and the
trick-boost. ELF trace of SSX Tricky (PAL `SLES_505.45`); addresses are EE
virtual addresses, confidence tagged per claim. Companion to spec
[`../specs/340-jump-air-landing.md`](../specs/340-jump-air-landing.md) and
[`../specs/360-speed-and-boost.md`](../specs/360-speed-and-boost.md); DB topics
`air`, `trick-boost`, `boost`.

## Air rotation — one rate, all directions

In the air the stick rotates the **board's orientation quaternion directly**, in
every direction: **left/right = yaw** (the 360 spin), **up/down = pitch** (nose
over/under, the flip rotation), and **diagonals = a tilted axis** (corks). It is
one apply about a stick-selected axis, not separate per-axis systems, and it does
**not** route through the `boarder+0x1d0/+0x1d4` angle accumulators (those are
written only by the rail spin integrator). **high**

Applied each tick by `ControlState9_AirSpinApply 0x001062b0`: it rotates the quat
`boarder+0x180` by an angle `= riderFactor × spinScalar(boarder+0x1c8)` about an
axis built from the velocity/stick basis (VU0 macro block at `0x00106324`, ending
in a `cop2` rotate). The charge half is `ControlState8_AirSpinCharge 0x00105f58`,
which slews the spin progress/target `boarder+0x238/+0x23c/+0x240` from the stick.

**Rate:**
```
spinRate = riderFactor × 555.5556              // spinScalar floor = 555.5556 (0x440ae38e)
riderFactor = 0.4875571 + (statByte/255) × 0.71808594   // statByte = rider+0x15
```

| Rider stat | Rate | Time per full rotation |
|---|---|---|
| min (0) | **≈ 271 deg/s** | ~1.33 s |
| max (255) | **≈ 670 deg/s** | ~0.54 s |

- A **stick-flick at release** raises the scalar above the 555.56 floor
  (`Δextrema × 2024.8037 × (1−prewind)/(timer+1)`, `0x00106140`), so a snappy
  flick spins faster.
- **Yaw, pitch and roll rotate at the same rate; the stick direction only sets
  the axis.** `ControlState13_AirborneJumpControl 0x001000e0` reads a **2D stick**
  (packed 6-bit axes) into the prewind axes `+0x220/+0x22c`; `sub_001055f0` takes
  their `atan2` (`0x00251628`) to get the stick *direction angle*. The rotation
  **rate scalar `+0x1c8` is a single magnitude field, seeded direction-
  independently** to the 555.56 floor — so the stick angle chooses the rotation
  direction and the scalar fixes the speed. (The rail-side digital `+0x1d0/+0x1d4`
  accumulators are **not** the air path — `field-refs` confirms only the rail
  integrator, the transition-clear, and init write those boarder fields; the
  `AirMotion` writes to those offsets are `sp` stack scratch.) Confirm the
  absolute deg/s by timing a flip vs a spin in-game — they should match.
- **Flips** are this same physics rotation about the pitch axis, with the named
  trick's grab/pose animation layered on top (the up/down digital directions also
  feed trick-pose bitmask builders `0x00127920`/`0x00127d10`). There is no
  separate "flip-rate" constant — a flip is a pitch rotation at the spin rate.

**Unit caveat:** the apply has no explicit `×dt`; the deg/s reading is inferred
(it matches the rail path's `180/π` conversion and feels correct in-game). The
solid, port-ready facts are the **rider-stat ratio** (max ≈ 2.47× min) and the
**equal-rate-across-axes** model; pin the absolute deg/s by timing a 360 in-game.

## Gravity and the flight arc

Flight integrates velocity with a per-tick `dt = frames/60` and a **two-stage
gravity** (`AirMotion_IntegrateVelocityWithGravityCandidate 0x0012b348`; a second
inlined copy lives at `0x00122c40`, formerly mislabeled "AirControlVector" — it is
the same integrator, not a control function). **high**

| Quantity | Engine | SI |
|---|---|---|
| gravity rising (v↑) | −850.24 u/s² (`0xc4548f73`) | ≈ 8.5 m/s² |
| gravity falling (v↓) | −1900.84 u/s² (`0xc4ed9ac0`) | ≈ 19.0 m/s² |
| horizontal damping | −0.2000248 × h-vel /s (`0xbe4cd34c`) | — |
| total speed cap | 3347.22 u/s | ≈ 33.5 m/s |

Slow up, fast down (the managed "floaty" arc). The cap scales the whole velocity
vector down; horizontal carry is otherwise preserved through to landing. The
engine speed unit is **cm/s** (cap 3347.22 → 33.5 m/s; gravity 850/1900 → 8.5/19
m/s²). **high**

## Trick boost / held boost — what it changes

- **In the air, boost does NOT change rotation.** Air state-1 enter *clears* the
  trick-boost window (`0x00108368` zeroes `boarder+0x138/+0x13c`), and no air-spin
  code reads it. Boost in the air only raises the **speed cap** — tiers ≈ 27.9 →
  30.7 → **33.5 m/s** (engine 2788.8 / 3072.1 / 3347.2 cm/s, selected in
  `BoarderMotion_SharedUpdate 0x00117970`). **high**
- **On rails, the trick boost speeds up the spin ×1.6.** While the trick-boost
  window `boarder+0x138 > 0`, `RailControl_State16EnterTrickBoostSetup 0x00100598`
  multiplies the rail spin-rate fields `ctrl+0x2c/+0x30` by **1.6** (`0x3fcccccd`,
  `0x001005c8`). Rail spin input is clamped to **±80°** (±1.39626 rad) and slews
  at 75°/s. The window decays each tick (`BoarderMotion_SharedUpdate 0x0011794c`)
  and is set by `Boarder_RequestBoostAmount 0x0011e938` / the MainType-18 trick
  pad. **high**
- **Held boost** (`Boarder_HeldBoostChargeUpdate 0x0011d040`) seeds the boost
  amount `+0x130` from meter thresholds 1.0/0.601/0.250; it is a speed effect, not
  a rotation one.

## Pre-landing auto-level

While falling, the air update probes the world along the predicted travel and
rewrites the deck's orientation toward the surface it is about to hit, so the deck
arrives pre-tilted (`AirMotion_State1Update 0x00108378`, basis rebuild
`0x00129010`). This is a geometry-driven alignment assist (no fixed deg/s), not a
player rotation — see spec 340 "Pre-landing alignment". **high**

## Porting recommendation

- **Air rotation:** apply `spinRate` about the stick-direction axis (stick-X →
  yaw, stick-Y → pitch, diagonals combine for corks). Use ~360–450 deg/s for a
  default mid-stat rider, or the rider-scaled 271–670; allow a flick to raise it.
  Flips = pitch rotation at the same rate, with a trick animation on top.
- **Gravity:** two-stage 8.5 m/s² rising / 19 m/s² falling, −0.2 horizontal
  damping, 33.5 m/s cap (already in the board).
- **Boost:** in the air, only raise the speed cap (≤ 33.5 m/s) — do **not** speed
  up air spins. Apply the **×1.6** spin-up only on rails while trick-boosting.

## Port parity (`RideableBoard`) — verified

The Unity rideable board's **air-translation model matches the RE** (checked
against `Unity/VRC/Riding/Board/RideableBoard.cs`):

| Quantity | Engine original | Board field | Match |
|---|---|---|---|
| rising gravity | 8.5 m/s² (−850.24 cm/s²) | `gravityRising = 8.5` | ✓ |
| falling gravity | 19.0 m/s² (−1900.84 cm/s²) | `gravity = 19` | ✓ |
| two-stage select | by sign of vertical velocity | `_vel.y > 0 ? gravityRising : gravity` | ✓ |
| horizontal air damping | linear `−0.2000248 · v_h` /s (∝ `e^(−0.2 t)`) | `airHorizontalDrag = 0.2`, `v_h × 1/(1+0.2·dt)` | ✓ |
| speed cap | 33.5 m/s (3347.22 cm/s) | `maxSpeed = 33.5` | ✓ |

All are written as per-second `×dt`, so they hold framerate-independently. The
horizontal damping uses an implicit-Euler form (`1/(1+0.2·dt)`) vs the original's
explicit (`1−0.2·dt`); they agree to ~5 decimals and both converge to
`e^(−0.2 t)`. The **rotation** model (one rate about a stick-selected axis) is
faithful in shape; the absolute deg/s is best pinned by in-game timing.
