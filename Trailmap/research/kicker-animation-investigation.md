# Kicker animation (Elysium `Mdl_Dynkicker_Event1`) — RESOLVED mechanism

> Status: **RESOLVED.** Retail observation reconciled: the ramps were seen
> moving from riding distance, after the observer had crossed the landing triggers —
> the traced code fully matches retail. Port implemented and ride-verified.
> Labels/notes persisted in `analysis.sqlite` topic `anim-delta-kicker`.

Elysium's three up/down "kicker" ramps (instances 153 / 154 / 179, ModelID 23)
hinge ~27° about their base on a 1.0 s ping-pong Y-rotation clip. In retail races
they move mutually out of phase. The phase is **emergent from gameplay pokes** —
there is no authored phase, no randomness, and no free-run.

## The delta-gated player

Each kicker's persistent header installs a `type0 Sub257` **AnimDelta** node:

| Address | Name | Behaviour |
|---:|---|---|
| `0x0019a208` | `AnimDeltaNode_Init` | delta(`+0x68`) = 0, clock-gate `+0xc` = 0 → starts **frozen** (overrides `AnimObjectNode_Init@0x00198fe4`'s gate = 1, the Sub256 free-run) |
| `0x0019a2b0` | `AnimDeltaNode_Update` | if delta>0: burn `delta -= |step|` (clamp ≥0), advance clip; gate `+0xc = (delta>0)` @`0x0019a348/54` |
| `0x00199550` | `AnimObjectNode_Update` | gate @`0x00199588`: with the clock-gate clear the clip does not advance at all — the pose is held |
| `0x0019a3a4` | `AnimDeltaNode_AddDelta` (vtbl `+0xc4`) | op `a1==2`: `delta += f12/30` (seconds). Other ops via `0x00199d48`: 1 = hold counter `+0x14` = f12·60, 4 = seek clock = f12/30, 7/8 = instance flag 0x800 clear/set |

Delta writers are **exhaustive** (whole-.text `sw/swc1 →0x68(reg)` sweep): Init,
Update's burn, AddDelta, plus the world-state save/restore pair (`0x0019a260`
deserializing ctor / vtbl `+0x44` `0x0019a3d8`, the race-restart snapshot path).
Nothing else seeds delta; no "start" broadcast exists.

**A +1.0 s grant = exactly one half-cycle of the 1 s ping-pong window** (reflect
negates the rate) — **each poke toggles the ramp** up or down.

## The MainType-3/9 dispatch is single-target

`EffectPayload op 3` at `0x0013c070` (op **9** at `0x0013c084` differs only by a
null guard) delivers the command to **exactly one node**: the thread's bound
instance holds a single installed property/effect node slot, which every node
ctor overwrites on attach (`0x0013a848`), so the last one installed is the only
one reachable. The slot is
not animation-specific: the command meaning comes from the receiver's vtable
(`AnimDelta` here, `TexFlip` for the start lights, and Counter/UVScroll/AnimCombo
elsewhere). No list, no model-share, no global walk — **kicker 153's grant
physically cannot reach 154/179.** MainType-9 is proven in the wild: Elysium
Function 0 "CountDownStart" selects the start-light texture frame digit-by-digit
with four M9 `{U0:2, U1:1..4}` + Waits.

## Persistent threads are region-activated one-shots

- `PersistentEffect_ActivateCellInstances @0x00260400`: entering a world-grid
  cell starts each instance's `PersistantEffectSlot` effect **once**, on that
  frame (the thread is created and immediately ticked, so frame 0 lands on the
  activation frame). An instance that already has a live node is left running
  untouched — activation never restarts or re-seeds it.
- `EffectRegionFIFO_UpdatePerFrame @0x00115e28` (RTTI "CircFIFOBuff", 108-entry
  FIFO): inserts the **3×3 cell neighborhood around every player AND the camera**
  (`0x00115f8c–0x00115fb8`, gated `playersStruct+0x1c < 2`) — the pre-race flyby
  wakes course cells as it pans. Cell countdown 1, aged −1 per pass → deactivates
  one pass after everyone leaves.
- `EffectThread_Tick @0x0013be80` advances the header index forward only; at
  end-of-list the thread **dies** (`0x0013bd28` → teardown). So header 67's
  `[Sub257][M3 +1s]` is **one +1.0 s pulse per activation**, not a per-frame
  self-poke: persistent headers do not re-run every frame, and 153 does not
  free-run.
- Deactivation (`0x00260638` → vtbl `+0xbc` `0x001996f8`) restores the instance
  flags and **destroys the anim node** → the model reverts to rest pose; phase is
  not preserved. Re-approach recreates it at t=0 (re-pulsing 153).

## The poke topology (SSFLogic.json, re-verified byte-exact)

| Kicker | Inst | Persistent header | At-rest behaviour |
|---|---|---|---|
| centre `_1000` | 153 | 67 = `[Sub257][M3 {U0:2,U1:30}]` | one half-swing per region activation |
| outside `_1001` | 179 | 68 = `[Sub257]` bare | frozen until poked |
| outside `_1002` | 154 | 69 = `[Sub257]` bare | frozen until poked |

Four `Mdl_Trigger_landingtrigger3` volumes (inst 68/77/92/105; y=6105 and y=9453,
i.e. 5.2 km and 1.8 km upcourse of the kickers at y≈11291) share collision slot
26 → header 70 = `Debounce 1.0 s` + M7×3 → headers 71/72/73, each a bare
`M3 {U0:2,U1:30}` — **any rider crossing any volume grants +1.0 s to all three
kickers simultaneously**. This is the exhaustive poke set (full-file sweep incl.
Functions and PhysicsHeaders).

## Why retail looks out of phase

The outside pair is only ever granted together → **mutually locked**. The centre
gets the same trigger grants **plus** one per region (re)activation → typically
anti-phased against the pair (each extra grant is a half-cycle). A six-racer pack
strung down the course crosses the landing zones and churns the cells continuously
→ all three pump at gameplay-driven times. Matches the observation
("outside pair up when the centre is down").

## How OpenSlope implements it

`AnimatedPropsBundle` classifies Sub257 as **DeltaGated** (SelfPulse when its own
header carries an M3/M9; poke triggers from collision headers whose M7 targets
bare AddDelta headers) → manifest `Props.Animated[]` `DeltaGated/SelfPulse/
PokeSeconds` + the landing volumes as `Triggers`. `AnimatedPropU` runs the
budget law (Poke() grants, clock advances while budget > 0, half-swing toggles;
local-player distance emulates region activation: approach pulses a SelfPulse
prop, leaving snaps to rest). `AnimTriggerU` poke mode grants on rider
crossings; `AnimPokerU` ("AnimPoker") stands in for the AI pack — random
cadence, all targets granted together, preserving pair-lockstep + centre
anti-phase; `pokeEnabled=false` = strict data-faithful. `Unity/docs/038`.

Cross-refs: `analysis.sqlite` topic `anim-delta-kicker` (labels
`PersistentEffect_ActivateCellInstances`, `EffectRegionFIFO_UpdatePerFrame`,
`EffectThread_FinalizeAndFree`, `EffectNodeBase_CtorBindEntity`); spec
`120-objects.md` (playback modes), `150-logic.md` (region activation, worked
example), `230-level-ssf.md` (M3/M9, Sub257).
