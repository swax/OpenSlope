# Scoring — trick events, race events, gems, rails, sounds

How SSX Tricky (PAL `SLES_505.45`) turns a run into a number: the per-player
trick-score state, the point formula and its components, gems and rails, the
race-result metric, and every sound the scoring system makes. ELF-side trace;
all addresses are EE virtual addresses. Confidence is tagged per claim. The
authored side (per-course score targets, `trickdef.dat`) is reconciled at the
end. Companion: `elf-map.md`, spec
[`../specs/390-pickups-and-race.md`](../specs/390-pickups-and-race.md) and
[`../specs/430-music-and-announcer.md`](../specs/430-music-and-announcer.md).
DB topics: `scoring`, `scoring-sound`; struct `TrickScoreState`.

## The trick-score state (`boarder+0x5820`)

Every rider owns a **trick-score sub-object** at `boarder+0x5820` (call it `S`),
built by `TrickScore_InitState` `0x001553c0` at boarder construction. The
scoring code module is roughly `0x00155000`–`0x00159000`. Key fields:

| Offset | Meaning | Conf |
|---|---|---|
| `S+0x24` | **style/rotation accumulator** (the raw magnitude that becomes points) | high |
| `S+0x28` | **active gem multiplier** (1.0 / 2 / 3 / 5) | high |
| `S+0x44` | airborne frame counter (`÷60` → airtime seconds) | high |
| `S+0x84` | tricks banked this run | high |
| `S+0x88` | uber/Tricky tier (`== boarder+0x58a8`; `≥6` ⇒ meter pinned full) | med |
| `S+0xb0/0xb4/0xb8` | ×2 / ×3 / ×5 gems collected (counts) | high |
| `S+0xc4` | accumulated big-air time | med |
| `S+0xe4` | best single-trick score | high |
| `S+0xf0` | **run/combo total score** (persists across the run) | high |
| `S+0xf4` | held-grab frame counter → grab tier | high |
| `S+0x15c` | 12 × `0x14`-byte active HUD score-event slots | high |

A HUD slot entry: `+0`=type, `+4`=value, `+8`=lifetime(s), `+0xc`=elapsed,
`+0x10`=aux/base. Managed by `TrickScore_AddHudScoreEvent` `0x00157348`. Slot
types: `1`=final landed score, `2`=spin popup, `3`=flip popup, `5`=landed
marker, `12`=gem-multiplier badge (lifetime −1 = persistent), `15`=held-grab,
`16`=big-air.

## What a trick is worth — the formula

Each scoring tick (`TrickScore_UpdatePerFrame` `0x001569c8`, driven by the air
and rail motion states) banks a value `s2`:

```
s2 = TrickScore_StyleToPoints(S) / (flips + 1)   # rotation/style, gem-multiplied
   + TrickScore_GrabHoldTierPts(S+0xf4)          # flat grab-hold bonus
   + TrickScore_BigAirTimeBonus(airtime)         # flat big-air bonus
S+0xf0 += s2                                      # run total
```

**Style → points** (`TrickScore_StyleToPoints` `0x00155458`, verified):

```
points = round_to_nearest_10( style[S+0x24] * gemMult[S+0x28] * 0.67869 * 10000 + 5 )
```
(returns 0 if the product is negative). Constants: `0.67869`=`0x3f2dbc4d`,
`10000.0`=`0x461c4000`, `5.0`=`0x40a00000`; the round is `v - v%10`. The
"base" value shown next to the popup is the same minus the multiplier term
(`TrickScore_StyleToPointsBase` `0x001554d8`). **high**

The style accumulator builds from rotation: **+0.25 per full 360° spin**
(`0x3e7ffd53`, `TrickScore_AccrueFullSpin` `0x00155e80`) and **+0.06995 per
180°** (`0x3d8f4436`, `TrickScore_AccrueHalfSpin` `0x00155e18`). So a bare 360
≈ `0.25 × 1 × 6787 ≈ 1700` pts; with a ×2 gem ≈ 3400. The two spin scorers are
**shared by air and rail** — spins score identically in the air and on a rail.
**high**

**Held tricks accrue style over time** (grabs included):
`TrickScore_NamedTrickBegin` `0x00155f00` fires on trick recognition (code
rebased −632 → 0..99), bumps **style += 0.0425 × string position**, zeroes the
held counter `S+0x38`, and sets the trick's authored **style rate** `S+0x2c`
from jump table `0x00371ea0` (observed constants 1.0 / 1.25 / 1.5 / 1.75 /
2.0 / 2.5 / 3.0 / 4.0 / 5.0). `TrickScore_HeldTrickTick` `0x00156e98` (from
the boarder update `0x00117c98`) then adds **style += rate × 0.00075/tick**
(= rate × 0.045/s) each held tick. A held grab therefore earns style — and,
through style, boost meter — at its authored rate: ≈ 305 pts + 0.03 meter
per second for a rate-1.0 grab, five times that for a rate-5.0 uber. The
**flat hold-tier bonus** (4000..16000 from `S+0xf4`) is separate: score only,
never meter. **high**

**Grab-hold tier → flat points** (`TrickScore_GrabHoldTierPts` `0x001568c8`,
jump table `0x00372350`, verified):

| held-grab tier (from `S+0xf4`) | points |
|---|---|
| 0, 1 | 0 |
| 2 | **4000** |
| 3 | **8000** |
| 4 | **12000** |
| ≥ 5 | **16000** |

Holding a grab longer steps the tier up; the bonus is a flat add on top of the
style points. **high**

**Big-air bonus** (`TrickScore_BigAirTimeBonus` `0x00156980`, verified): for
airtime ≥ **4.0 s**, `(airtime − 3) × 1000` points (1000 @ 4 s, 2000 @ 5 s, …);
under 4 s, nothing. **high**

The gem multiplier scales the **style/rotation** term only; grab-hold and
big-air are flat additions. Score-popup colour / announcer-excitement tiers are
bucketed by total score (`TrickScore_ClassifyPopupTier` `0x0019ec98`, table
`0x00339320`): thresholds **0 / 1001 / 2501 / 4001 / 7501 / 11501**. **med**

## Gems = score multipliers (×2 / ×3 / ×5)

Floating gems are SSF effect **MainType 14** targets (dispatcher `0x0013c3cc` →
`GemMultiplier_ApplyAndChime` `0x0011e668`, multiplier = effect payload `+0x08`
= 2.0/3.0/5.0). When the game mode is 3 or 5 it calls
`TrickScore_ApplyGemMultiplier` `0x00155ce8`, which:

- increments the matching collect count (`S+0xb0`/`+0xb4`/`+0xb8`), and
- sets `S+0x28 = max(S+0x28, gemValue)` — **MAX, never stacks/adds** — and posts
  the persistent type-12 HUD badge.

The multiplier is **consumed by the next banked trick**, then reset to ×1 by
`TrickScore_ResetCombo` (on the next land or bail). So a gem multiplies the
trick you bank while it is active, not your whole run. **high**

The same collision hit that scores the gem also despawns it: the SSF header
chains a `type0 Sub5 DeadNode` (mode 2) after the MainType-14 node, which
tears down the gem's free-running spin animation and tombstones the slot so
it can't fire again — see elf-map.md "DeadNode mode dispatch" for the
full trace. No respawn was found. **high** (the spin-kill); **open** (whether
the model is additionally hidden)

## Rails score continuously while you ride them

A grind **banks points every frame, with no input** — game-tested. Being on the
rail is itself a held trick. The rail-accepted continuation
(`Boarder_TryEnterRailMotionCandidate +0x53c` `0x001261fc`, which runs every
frame the rail contact holds) calls the **full per-frame trick scorer**
`TrickScore_UpdatePerFrame(S, dirCode, …)` with `a1 = dirCode` computed as **1,
3, or 4 — never 0**, so the classifier always sees an active trick. Each scoring
pass the **hold counter `S+0xf4` increments** (`0x00156a20`) and the **style
`S+0x24` accrues** (`+0.20`/`+0.18`, `0x3e4cc6d7`/`0x3e3854cc` at `0x00156a30`),
and the run total grows by `StyleToPoints` (`style × ~6,787`). The same path also
fills the **Tricky meter** every frame (`Boarder_AddBoostMeter` `0x0011b020`).

**Measured** (game test): a plain grind with no spins scores **~1,000 pts/sec,
roughly linear** (~5,000 for 5 s → ~2,000 for 2 s). That reconciles with the
formula — 5 s ⇒ ~0.74 accumulated style ⇒ `0.74 × 6,787 ≈ 5,030` — and shows the
`+0.20/+0.18` style adds are **not** applied on every 60 Hz frame (the banking
cadence is gated; the net is ~0.15 style/sec on a stationary grind). A gem
multiplier scales the whole rate, and spins/grabs accrue on top through the
shared spin scorers (`0x00155e18`/`0x00155e80`, used by air and rail alike).
Leaving the rail resolves
the string via `TrickScore_ResolveTrickString` `0x00156630` (its `S+0x20 == 0`
early-out is the jump/string *boundary* resolver, not the per-frame grind
scoring). **high**

## Combo lifecycle — bank on a clean land, lose on a bail

- **Clean landing** (`TrickScore_FinalizeTrick` `0x00156df8`, from ground
  contact): emits a landed marker (slot 5) then the final score (slot 1 =
  `StyleToPoints`, gem-multiplied), then `TrickScore_ResetCombo`. **high**
- **Bail / crash**: the per-frame updater gates banking on `owner+0x418`
  (`bltz` at `0x00156b14`): `≥ 0` (**grounded**) → `TrickScore_ResetCombo` +
  force `S+0x28 = 1.0` and skip banking (return 0 to the meter), `< 0`
  (airborne/rail) → bank — i.e. `+0x418` is the air/ground state field, the
  same sign test that freezes the passive meter bleed on the ground, not a
  landing-validity flag (an earlier reading here had the polarity inverted).
  A wipeout's trick loss comes from the crash-contact path routing through
  finalize without a clean award. **med**
- `TrickScore_ResetCombo` `0x00157020` zeroes the in-progress fields (`+0x24`
  style, `+0x44` airframes=−1, rotation block) and forces the multiplier back to
  ×1, and clears the HUD slot array. It does **not** clear the run total
  (`+0xf0`), trick count (`+0x84`) or gem counts — those persist for the run.
  **high**

## Tricky meter, uber tiers, big air

- **Meter** = boost energy `boarder+0x1c` (0..1). Fills via
  `Boarder_AddBoostMeter` `0x0011b020` (inc × riderScalar 0.979–1.338). The
  increment is **decoded exactly**: `TrickScore_StyleToMeterFill` `0x00155428`
  returns `max(0, style[S+0x24] × 0.67869)` — the points formula **without**
  the ×10000 and **without** the gem multiplier — divided by `(flips+1)` in
  the per-frame updater (`div.s` `0x00156b80`), undivided from
  `TrickScore_ResolveTrickString` (jump launch / rail exit). So the meter
  gains **base style points ÷ 10 000**: a clean 360 ≈ +0.17, a plain grind
  ≈ +0.10/s; gem multipliers and the flat grab-hold/big-air point bonuses fill
  **nothing**. Body bumps pass `TrickScore_FinalizeTrick`'s constant −0.09999
  return (a bump costs the same as a crash; light bump −0.02 `0x00124e18`;
  placement reset −0.12 via `0x00155ac0`); the 500/2000/5000 score pickups
  add a flat +0.04 each (`TrickScore_ScorePickupCollect` `0x00155b28`).
  Drains slowly per tick (`Boarder_DrainBoostMeter`
  `0x0011b200`), but while the uber-tier field `boarder+0x58a8 ≥ 6` the meter is
  **pinned full = effectively unlimited boost**. **high**
- **Full** (= "It's Tricky") swaps in the It's-Tricky song
  (`MusicSys_EnterTrickySong` `0x00226138`, music path-level 127, or 90 mid-uber)
  and fires the announcer line. **Empty** restores the race song
  (`Music_OnTrickyMeterEmpty` `0x0021cbb8`). **high**
- **Uber tiers 1/2/3** are not a separate point pool — uber tricks
  (`exNNNUber`/`bxNNNUber`/`frNNNUber` animations) are high-value trick entries
  that set the rider game-event bits 2/4/6 and bump the tier field, scoring
  through the same path. The tier bits drive the music/announcer (game events
  2/4/6 enter → song events 1/3/5; 3/5/7 exit) and the pinned-meter grant.
  **med**

## Race events = time + placement (not points)

Trick points still accrue **during** a race (modes 3 and 5 are the scored race
modes, gem multipliers and meter all work), but the **race result is finishing
order and time**, not the trick total. **high**

- **Placement / standings metric** = per-rider progress counter `rider+0x20`,
  incremented at each checkpoint/finish crossing by `RaceCheckpoint_Handler`
  `0x0011e700` (rider game-event 12). The leader is the rider whose `+0x20` is
  strictly highest over all riders (loop over `GetRider` `0x00181560`). **high**
- **Race clock** is stored in **centiseconds** (HUD formatter `0x001a7188`:
  `%d:%02d.%02d`, cap `0x57e3f` = `59:59.99`; a signed `-%d:%02d.%02d` variant is
  used for split/behind deltas — implying a best-time/record comparison). No
  time-based *score* was found; the clock is the result value. **high**
- **Checkpoints** only advance `rider+0x20` (and feed reset / music intensity);
  they do **not** add or extend time. "Check Point past finish" `0x003673d0` is a
  defensive warning for a checkpoint firing after the rider already finished.
  **high**
- **Ranking** is by placement; `cRiderRanking` / "End Race: User Rank"
  `0x00187b5c` are a RTTI loader and a *debug-menu* item, not the algorithm.
  **med-high**
- **Result overlays** are mode-specific: race mode → rider-ranking
  (placement/time); showoff/trick mode → `cPointDistributionOverlay` (points
  breakdown) and `cHiScoreRecordOverlay` (new record). Both a time and a trick
  total are tracked per run; which surfaces depends on the mode. **med**
- The finish gate also constructs a `cReplayRecordHeader` (crossing the line
  triggers replay recording). The exact 1st/2nd/3rd-assignment + clock-latch
  inside `cFinishLineControl::Update` was not reached (vtable not captured by the
  xref scan) — see open questions. **med**

## Crash, bail, and out-of-bounds — what you actually lose

The run total `S+0xf0` is **monotonic within a run** — it is zeroed at
`TrickScore_InitState`, incremented by `s2` as tricks are recognized, and **no
crash / bail / OOB path decrements it**. So a fall does **not** subtract banked
points. **high**

What a **bail/crash** (`Boarder_EnterWipeOut` `0x0011d838`) actually forfeits:

- the **gem multiplier** — `TrickScore_ResetCombo` forces `S+0x28 = 1.0`, so the
  ×2/×3/×5 you were holding for the landing is gone;
- the **current uncommitted rotation** — it ends with no clean `FinalizeTrick`
  award (only the rotations already recognized in the air were banked);
- the **Tricky/boost meter** — the wipeout cuts `boarder+0x1c` down (the real
  cost of crashing).

It writes only `−1` to `S+0x44` (airframes) in the score state; it does not zero
the total. So "crashing a trick = zero points" is true for **that trick string's
landing award and multiplier**, not for points already banked earlier in the run.
**high** (the player-facing commit point for `S+0xf0` is the one open question.)

**Special case:** the meter drain is gated. The wipeout checks `0x0011f438`
(`boarder+0x58a8 ≥ 6` = an uber/Tricky tier is active) and, when true, **skips
the meter-drain block** — a crash *while you are Tricky/uber does not cost you the
boost meter*. The drain is also skipped on a low-impact spill (crash-severity
scalar or `boarder+0x24` ≤ 0). **high**

**Out-of-bounds / reset** carries **no explicit score or time penalty number**.
The reset repositions you back onto the course (a relative nudge near where you
left, velocity preserved; the Unity port snaps to the nearest course line) and
holds through the get-up animation. The only cost is the **real time lost**
during the reset-wait + recovery — the race clock keeps running while you are
stopped. The recover path is position-only (`WipeOutRecover_RepositionOntoTrack`
`0x0010f178`, single caller `0x0010d628`); it does not touch the trick total.
**med** (no penalty found; OOB-via-reset-zone vs OOB-via-crash differ only in
whether the crash meter-drain applies).

## Showoff-mode score targets (authored)

The HUD/score string block carries the per-course **showoff/trick-mode score
targets** as ASCII numbers (descending gold/silver/bronze triples,
`0x0038f730`+): `55000 / 40000 / 25000`, `95000 / 65000 / 35000`,
`225000 / 150000 / 75000`, `275000 / 175000 / 125000`. These are the "how much
do you need to medal" thresholds. **med** (identity by location + shape).

## Score-related sounds

The hub turning a scoring moment into a sound is `BoarderState_GameEventToAudio`
`0x0011a350` (jump table `0x003671f0`), which edge-detects the rider event
bitmask `boarder+0x388`(cur) / `+0x384`(prev) each tick.

| Sound | Slot / mechanism | Trigger | Bank | Conf |
|---|---|---|---|---|
| **Gem pickup chime** | **116 / 117 / 118** for ×2 / ×3 / ×5 | `0x0021a268` (tail of gem apply); local human | MAIN `zbxsfx` g0 | high |
| **Trick-boost pad** | slot **114** | `0x00234818` (MainType 18) | MAIN g0 | high |
| **Speed-boost pad** | slot **115** | `0x002345c8` (MainType 17) | MAIN g0 | high |
| **Held-boost meter** | **120 / 121 / 122** by meter level, **one-shot on engage** | `Boost_PlayMeterSfx` `0x002197a0` | MAIN g0 | high |
| **Clean landing** | per-character voice, impact cat 0/1/2 | `BoarderVoice_LandingReact` `0x00218248` (from AirMotion land `0x00109208`) | char voice | med |
| **Bail / crash** | per-character voice, impact cat 0/1/2 | `BoarderVoice_WipeoutReact` `0x002186e0` (from `Boarder_EnterWipeOut` `0x0011d838`) | char voice | med |
| **Big air** announcer | row 11 bark | `Speech_OnBigAir` `0x002343f0` (event 12) | SPEECH | high |
| **"It's Tricky"** | song swap + row 19 bark | `MusicSys_EnterTrickySong` `0x00226138` + `Speech_OnTrickyMeterFull` `0x00233cd8` | music + SPEECH | high |
| **Uber tier 1/2/3** | music song-events 1/3/5 | `MusicTricky_TierEnterDispatch` `0x0021c598` (events 2/4/6) | music graph | high |
| **Finish** | song-event 10 + character finish voice | event 18 | music + char voice | med |
| **Race position** barks | rows 14 / 15 / 18 | `Speech_OnRaceEvent19_20/21/22` | SPEECH | med |

Two notes that matter for faithfulness:

- **The held-boost sound is a one-shot on the *engage* frame, not a loop.**
  `Boost_PlayMeterSfx`'s sole caller (`Boarder_HeldBoostChargeUpdate` @`0x0011d0c0`)
  is gated on `+0x130 == 0` — true only the frame boost activates; `+0x130` is then
  set and persists until release, so it does not re-fire while held. The ~1.12 s
  clip plays out regardless of when you let go. The *meter economy* that picks the
  variant (and the boost itself) is covered in `../specs/360-speed-and-boost.md`
  ("The boost/Tricky meter"). **high**
- **Landing-good vs bail-bad are character voice, not numbered SFX.** Both use
  one per-rider 84-byte voice-record table (`soundMgr+0x4320`), category chosen
  by impact scalar `f20` (`<0.25` cat 0, `<0.65` cat 1, `≥0.65` cat 2) — louder
  the bigger the stomp/crash. There is **no discrete "perfect-landing" one-shot
  slot**; "perfect" is expressed by the score + announcer + the visual landing
  puff. **med**
- **Announcer barks are probability-gated** by `Speech_EventProbabilityGate`
  `0x00236278`: play iff `(rand & 0x3ff) < probTable[row*10 + excitement]`
  (`Announcer_SpeechProbabilityTable` `0x003a4798`). `excitement` (0–9) rises
  through a hot run, so the MC gets chattier as you score. The actual bark
  *wording* per row is data (`eventdat/events.evt` + `SPEECH.*` banks), not in
  the ELF. **high**

## `trickdef.dat` holds no point values

`data/tutorial/trickdef.dat` (extracted, 10080 bytes = **360 records × 28 B**)
maps each trick **code** to its **input / rotation requirements** (button-flag
words; `word0 = code<<8`). It contains **no point values** — every scoring
magnitude lives in the ELF (the formula at `0x00155458` plus the tables at
`0x001568c8` / `0x00156980`). The trick code itself is classified at runtime
from accumulated yaw/pitch via byte tables `0x00321ef0` / `0x00322140`. **high**

## Open questions

- Where `S+0xf0` (run total) is committed to the player's overall result and
  zeroed at run start — the consumer is outside the `0x00155xxx` module.
- The exact 1st/2nd/3rd placement assignment + clock-latch in
  `cFinishLineControl::Update` (vtable not reached; next step: scan `.data` for a
  pointer into the `0x0036xxxx` typeinfo block, or trace who *posts* rider event
  12).
- Whether a spinless straight grind banks any nonzero point (the "no baseline
  grind value" negative).
- ~~Exact per-event meter-fill magnitudes, and the precise `boarder+0x418`
  semantics in the drain gate.~~ **Resolved**: fill = base style points ÷
  10 000 (`TrickScore_StyleToMeterFill` `0x00155428`, no gem/flat-bonus
  contribution); `+0x418` is the grounded(≥0)/airborne(<0) state field (see
  the meter and bail bullets above; db topic `boost-meter`).
- Big air (event 12) adds points via airtime enabling rotation; no separate flat
  air *point* award beyond `TrickScore_BigAirTimeBonus` was found.
