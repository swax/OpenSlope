# 017 — Rideable Board (the snowboarding vehicle)

> **Status: first implementation (local, untuned).** A working board exists —
> `VRC/Riding/Board/RideableBoard.cs` (UdonSharp runtime) + `VRC/Editor/RideableBoardSetup.cs`
> (the shared board-builder, placed in-world by the `OpenSlope/Setup/Start Gate Boards` menu step). It's a
> first pass meant to be *ridden and tuned*, not a
> finished feel. This doc is the design rationale + the model the script implements + an honest account of
> which physics the game files hand us versus what we author. The rider sits on **the game's actual board
> model** (extracted from `board.mpf` — its own doc, [018 — Board Model](../018-board-visual.md)). Developed
> against a locally converted level.

The whole project so far imports a level you **walk** through. The next leap is to **ride** it. The plan is
a single placeable object — a board — that the player sits on, turning the avatar into a snowboarding
vehicle. This is not just a feature idea; it's the one design that gets us *real* physics in VRChat, for a
specific engine reason (next section). It also turns a pile of already-decoded-but-cosmetic data — the
[009](../009-collision.md) `SurfaceType` colliders, the [011](../011-triggers-and-interactivity.md) boost vectors,
the [016](../016-physics-props.md) bounce values — into actual game feel.

## Source layout

`RideableBoard` is one UdonSharp behaviour (one Udon program — `partial class`) split across files under
`VRC/Riding/Board/`, plus the editor builder:

| File | Holds |
|---|---|
| `RideableBoard.cs` | Inspector knobs, private runtime state, `Start`, mount/dismount, avatar-fit, input, the per-frame `Update` integration (gravity / ground / air / steering / carve / ollie / land / orientation), riderless coast, the boost-pad API, `RespawnAt`. |
| `.Surface.cs` | The per-`SurfaceType` feel table (`MuFor` / `CarveGripFor` / `SpeedGainFor` / `SpeedMultFor`), the snow-sink contact spring ([033](033-snow-sink.md)), the terrain-collider cache, and `ResolveContact` — the analytic contact tier-select (exact patch → faceted+smooth-normal fallback) + the sink allowance (`SinkAllowance`/`sweepFootClearance`) that lets the deck ride into concave dips ([021](../021-smooth-contact-normal.md)). |
| `.Audio.cs` | The glide + carve loop layers, predicted-big-air wind (MAIN `zbxsfx` 032), and the boost-engage whoosh (`UpdateBoostAudio`, MAIN 120/121/122). |
| `.Fx.cs` | The snow spray + landing puff ([032](032-snow-spray.md)) and `IsSnowSurface`. |
| `.Wake.cs` | The carved wake ribbon ([030](030-carved-wake.md)). |
| `.OutOfBounds.cs` | The breadcrumb trail + three-tier on-course reset ([031](../031-out-of-bounds-reset.md)). |
| `.Rail.cs` | The rail-grinding state ([026](../026-rail-grinding.md)). |
| `Editor/RideableBoardSetup.cs` | `BuildBoardAt` assembles a ride-ready board (frame + `Heading` pivot + `Deck` + `RiderProbe` + `VRCStation` + `SeatPoint` + audio/FX/wake children + the Udon component); called per start-gate post by `StartGateSetup` (not its own menu step). The program-asset bootstrap follows [013](013-udon-components.md). |

The board hand-integrates a world velocity and moves the `VRCStation` transform; the seated rider is carried
along. **Local rider only** (sync `None`). The private fields group into: **caches** built in `Start`
(`_colliders`/`_types`/`_meshTris`/`_meshNorms` terrain + baked normals, `_ownCollider`/`_box`/`_probeCol`, the
reused `_hitBuf[64]` for the `*NonAlloc` casts, `_pivot`/`_seatPoint`/`_flight`); **motion** (`_vel`, `_fwd`,
`_boardUp`/`_contactN`/`_airUp`, `_steer`/`_throttle`/`_lean`/`_bank`, the ollie/coyote scratch, `_speedCap`); and
**per-subsystem** state (sink, the breadcrumb ring, the wake ring, the grind, the riderless coast, the audio/FX
gates). `Probe()` returns its result through instance fields (`_pFound`/`_pNormal`/`_pSurf`/`_pGroundY`) rather
than out-params, to stay Udon-friendly.

## Why a vehicle, and not the avatar

VRChat's player capsule is **engine-controlled and ignores friction** — that's the hard wall behind every
"cosmetic only" caveat in [009](../009-collision.md) (gotcha 5) and [011](../011-triggers-and-interactivity.md).
You cannot make the *walking* avatar slide on ice; the platform won't let you.

A **rideable object dodges this entirely.** When a player sits in a VRChat **station** (`VRCStation`), they're
attached to an object whose motion *we* drive — move the station's transform and the seated player goes with
it. So we integrate a velocity ourselves (gravity, slope, per-surface friction, steering), sweep the board
down the hill, and the rider comes along. Suddenly all the physics we couldn't give the walking avatar is
ours to control. The vehicle *is* the workaround.

We drive it **kinematically** (we integrate and move the transform) rather than as a PhysX `Rigidbody`. A
rigidbody *does* run in-world ([016](../016-physics-props.md)), but letting PhysX integrate a body that's also
carrying a seated player invites the station and the solver to fight; a hand-integrated velocity is more
predictable on VRChat and makes the surface model explicit.

## What the files give us vs. what we author

| We want… | In the files? | Source |
|---|---|---|
| Where each surface is, and what *kind* (snow/ice/rock/ramp) | **Yes** — per-patch `SurfaceType`, already split into `Surf_<type>` colliders | [009](../009-collision.md), `PBDHandler` legend |
| Boost-pad direction + magnitude | **Yes** — `BoostEffect { Mode, BoostAmount, BoostDir }` | [011](../011-triggers-and-interactivity.md), `SSFHandler` |
| Out-of-bounds boundaries + where to put the player back | **Yes** — reset zones, `AIP`/`SOP` race lines, `StartPosList` | [011](../011-triggers-and-interactivity.md) |
| How hard you bounce off obstacles | **Yes** — `PlayerBounceAmmount` (0.03–0.6) | [016](../016-physics-props.md) |
| "Trick zone" patches | **Yes** — `TrickOnlyPatch` flag per patch (`Patches.json`) | this doc |
| The board's per-surface material constants | **Yes** — recovered and wired in ([020](020-surface-physics.md)) | [Trailmap: 310-surface-response] |

The last row is the catch and it's worth stating plainly: **SSX's actual ride model isn't in the level
data.** `SurfaceType` is a *label*; the physics response to that label lived in the game executable. We
have the executable-side per-surface constants, but the surrounding force code is still only partially named,
so the board can accept real values while still keeping a tunable VRChat layer on top.

## Could we recover it instead? (the recovery reality)

The community reverse-engineering project — [`SSXModding/ssxog`](https://github.com/SSXModding/ssxog)
— is a *functional* (not matching) reimplementation that covers only the **system layer**
(`libs/real` = EA's filesystem/memory/thread/timer runtime, `libs/snd` = audio, `bx` = boot). A grep of the
whole tree for `physic|gravity|velocit|friction|slope|carve|board|player` finds **nothing** — there is no
gameplay physics to read, and no symbol map in the repo. It
also targets **SSX (2000)**, not Tricky. So "just read the algorithm" is not on the table; recovering
the *real* coefficients would mean reverse-engineering the player-update yourself or instrumenting
an emulator and measuring. Neither is needed to ship a good-feeling board, so the board is authored and tuned by ear.

The functional spec backs this up. It describes the **boarder state machine** — separate Ground, Air, Rail and
Static states with cruise, jump, air, landing, bump and spin controllers — confirming ground / air / rail / land
are genuinely separate states (our model mirrors the ground/air split; [Trailmap: 300-rider-states]). It also
records the **control map** (`DATA/CONFIG/BTNMAP*.DAT`: Turn = stick X, Brake = stick down, Crouch = stick
up, Boost = Square) and runtime feel signals from `SNOW.INF` (`Slip`, `Dig`, `Lean`, `Bend`).

The **per-`SurfaceType` material/physics table** the motion code reads is indexed by `SurfaceType * 100`.
There is no serialization path; the values are code-authored in the executable, not the level data. The mapped
head fields cover **accel/contact, turn/carve, and speed-response**. Two structural lessons shape the model:
down-slope speed is **not plain `g·sinθ` + one drag term** but a tuned, state-dependent **speed target** with
decay/clamp; and turn/carve is **speed- and contact-basis-scaled**. The direct grounded heading-yaw path is
mapped too: stick X is smoothed into a lean field, then a radians-per-tick quaternion yaw is applied around the
contact normal with a `6 deg/tick` cap. `turn_x` is part of the surface side-force/carve path, not the direct
angular yaw scalar. ([Trailmap: 310-surface-response])

What we *did* extract from our own data is the **boost economy** (real numbers, from the level's `Effects.json`):
speed-boost magnitudes **3.0 / 5.0**, trick-boost (launch) **10.0 / 15.0**, score multipliers **2× / 3× /
5×**. The absolute units are PS2-world and need rescaling, but the *ratios* are authentic — a trick launch is
~2–3× a speed pad, the high tier ~1.5× the low — and the script seeds its boost defaults from them.

**Provenance legend** for the model below: `[real]` = extracted/measured from our data; `[design]` =
documented SSX game design; `[std]` = standard arcade-physics formula; `[tune]` = a coefficient we chose and
expect to retune by ear.

## The surface model to port (the level's real surfaces)

The terrain uses these `SurfaceType`s (patch counts from `Patches.json`). The table's **Authored ride
character** column is a human-readable target; the **real numeric constants** live in
[020 — Surface Physics](020-surface-physics.md), which supplies data-derived `MuFor` (friction ← `speed_gain`)
and `CarveGripFor` (← `carve_drag`). The third column, `turn_x`, does **not** drive heading yaw — the engine's
heading yaw is a separate, surface-independent capped formula (see step 4), and `turn_x` feeds the
carve/side-force instead. The authored ride-character targets:

| Type | Legend name | Patches | Authored ride character |
|---|---|---|---|
| 3 | Powdered Snow | 1321 | the default piste — medium grip, deep carve, moderate drag |
| 1 | Standard Snow | 650 | slightly firmer/faster than powder |
| 9 | Rock / Off-track | 540 | high friction, scrubs speed — the off-course penalty |
| 4 | Slow Powdered Snow | 390 | highest drag — actively bogs you down |
| 5 | Ice Standard | 258 | very low friction — slidey, weak carve authority |
| 18 | Show-off Ramp / Metal | 60 | fast, low drag — launch/booter surface |
| 10 | Wall | 38 | not a ride surface — deflect / scrub along it |
| 0 | Reset | 622 | out of bounds → trigger respawn (not ridden) |
| 17 | No Collision | 6 | excluded from collision entirely ([009](../009-collision.md)) |

`TrickOnlyPatch` is an orthogonal per-patch boolean — a flag we can read at the same raycast to enable a
trick/score window without a separate trigger volume.

### Snow spray, snow sink & the carved wake (per-surface contact FX)

Three cosmetic layers ride on this surface read, each documented on its own:

- **[032 — Snow Spray](032-snow-spray.md)** — the rooster-tail off the deck: a carve effect (blooms with `lean²`,
  nearly nothing when straight), data-driven per surface (powder plumes, ice flecks, most surfaces throw
  nothing), rendered additive.
- **[033 — Snow Sink](033-snow-sink.md)** — the springy per-`SurfaceType` contact: the deck (and so the rider's
  feet) sinks into a soft spring, deepest in powder, bobbing on landings.
- **[030 — Carved Wake](030-carved-wake.md)** — the twin-walled groove the carve cuts in the snow behind the deck.

All three read the [020](020-surface-physics.md) surface table for their per-type behaviour.

## The board update loop (what the script does)

`RideableBoard` runs only on the **local rider** (sync `None`), per frame, while seated. Mount is the
object's `Interact()` → `VRCStation.UseStation`; the station is **Immobilize** so the avatar's own walking
doesn't fight us, with the built-in exit **disabled** (otherwise VRChat lets an immobilized rider "struggle
out" on movement input — so WASD would eject you instead of steering). We read `InputMoveHorizontal/Vertical`
(steer + tuck/brake) and `InputUse` (ollie); **Jump** is our explicit dismount. The **LEFT trigger** is the
held **boost** — `InputUse` with `args.handType == HandType.LEFT` is split off from the right-trigger ollie (on
desktop, which has no left trigger, the **right mouse button** boosts, polled via `Input.GetMouseButton(1)`);
see *Held boost* below.

The key shape (matching SSX's separate Ground and Air states — [Trailmap: 300-rider-states]): **gravity is a full
vector in both states, and the ground is a *constraint*, not a projection.** That's what lets the board carry its
speed over a crest and leave the ground.

1. **Fixed contact probe** `[real]` — whole 60 Hz ticks probe along the previous contact normal while grounded
   (world-down in air), so the same single contact follows floors, banks, walls and quarter-pipes. The faceted
   PhysX hit identifies a bicubic patch and seeds a bounded Newton solve of `patch(u,v) = probeRay(t)`; a point
   is accepted only below the shared 1 mm off-ray tolerance. The signed point-to-deck clearance is the free
   contact error—there is no hover-height snap.
2. **Ground/contact state** `[real]` — a grounded rider stays grounded through the surface's clearance threshold;
   air resumes only on contact (`error ≤ 0`). An airborne penetrating probe that is separating faster than
   0.25 m/s is a far-side crossing, not a touchdown. Bounce/wall rows 6/10 also release a grounded rider already
   separating from the face.
3. **Response + grounded load** `[real]`+`[gold]` — the three-zone per-surface response pushes along the analytic
   normal. Gari ice constrains that normal load to the active row's `A/100`; Snowdream independently constrains
   the effective contact-plane pull to 4.73 m/s². A capped one-sided pushout intervenes
   only past the surface budget. There is no generic grounded quadratic drag; speed is shaped by the shared cap,
   positive-only cruise drive, lateral carve drag, braking and boost.
4. **Carve vs. skid** `[real]`+`[tune]` — the heart of the feel, the **engine model** ([020](020-surface-physics.md)).
   Stick X slews into a **lean** (the lean field's shape ramps in with speed, slower on powder); the lean drives a
   **heading yaw** around the contact normal that *leads* a reference direction — your velocity, or in VR
   head-steer your gaze — by the lean angle, **speed-gated up** (quadratic, ~half by 12 m/s) and **capped at
   `6 deg/tick` = `360 deg/s`**. A self-centering slip term makes that fast cap settle into a bounded carve angle
   instead of spinning out (let go of the stick and the heading homes back onto your travel). Heading yaw is
   **surface-independent** — the per-surface `turn_x` is *not* the yaw scalar; it feeds the carve. Velocity is
   then split **forward** / **lateral** and the lateral part decayed by the surface `carve_drag` grip: high
   (powder) → **tight carve**, low (ice) → **wide drift**. The shared contract owns the 360°/s cap, lead-angle
   strength, grip scale, and `carveBite` conversion.
5. **Ollie** `[real]` — `InputUse` charges (hold) and launches (release) an up-impulse blended off the contact
   normal toward the up-slope tangent on steep ground. Crucially the launch is
   **decoupled from the live ground/air frame**: once an ollie is committed, it launches on its own charge
   countdown and puts the rider airborne, whether or not the board is still touching ground when the charge
   ends ([Trailmap: 340-jump-air-landing]). We mirror that with
   a short **`jumpCoyoteTime`** grace so an ollie pressed/released during a bump-induced air skip still fires
   (using the cached contact normal); beyond the grace you're genuinely airborne and the pending ollie is
   cancelled, so there's no mid-air double-jump (the engine only *starts* an antic from a grounded control state).
   Without this grace, jumps on bumpy terrain drop silently — the launch only runs while `onGround`, and the air
   branch wipes the charge.
6. **Take-off / land** `[real]` — a convex crest leaves naturally when the grounded pull can no longer supply the
   surface curvature; no lip test glues or launches it. The first accepted touchdown seeds response error at zero,
   preserving the arriving speed before penetration builds on following ticks. A **Reset (type 0)** surface ejects
   and respawns.
7. **Orientation** `[gold]` ([Trailmap: 340-jump-air-landing]) — exact analytic normals feed physics directly;
   only faceted fallback normals are low-passed. Visible `boardUp` follows the measured cubic grounded law
   (`min(270°/s, 90·error³ rad/s)`) and neutral air levels at 9°/s. A launch is recognized by either world-up
   speed or outward velocity along the takeoff normal, which preserves pose on downhill lips. There is no Unity-only
   nose/tail pitch bridge or landing look-ahead: the deck follows the measured centre-contact/neutral-air pose law.
   The deck's visual Lean bank (`_lean · 50°`) composes on top without tilting the rider's view.

For comparison captures, the in-world **Diagnostics** board offers a default-off **Ride telemetry log** checkbox.
While enabled, the local ridden board emits parseable
`RIDE_DBG` header/frame records containing the contract schema/version/profile, 60 Hz tick index, position,
velocity, accepted contact/source, analytic ray residual, surface/error/normal speed, trajectory pitch, visible
board pitch, board up, and contact point/normal. Console logging is deliberately expensive and must remain off in
normal play. The default-off **Show FPS / debug** row retains the lightweight head-following FPS, board section timing,
speed, surface, reset, boost, and charge readout for focused in-world checks.

**Boost** comes in two flavours, matching the game. The **boost *pads*** are public methods
(`ApplySpeedBoost` / `ApplyTrickBoost` / `ApplyBoost(dir, amount)`) seeded with the `[real]` 3/5 and 10/15
magnitudes (the boost-pad SSF effect), ready for a future trigger volume
([011](../011-triggers-and-interactivity.md)) to call as the rider crosses a pad. The **held boost** — SSX's
`Boost` control (the disc maps it to **Square**; we put it on the **LEFT trigger** in VR, **right mouse** on
desktop) — is the SSX-Tricky
hold-to-go-faster ([Trailmap: 360-speed-and-boost]), and it does two distinct things:

- **Raises the top-speed cap.** The generated profile lifts `27.888` m/s to `33.472` m/s while boost is active,
  and the airborne state uses that same top tier so jumps never clip carried speed.
- **Adds forward thrust—ground-only, lean-gated.** A 23.5 m/s² tangent shove fades to zero outside the narrow
  ±0.0798 lean window. It is not surface-scaled; surface character reaches speed through the separate cruise
  target/multiplier. During a scored run the boost meter gates the hold; free ride keeps the unlimited hold.

**The boost *sound*.** Engaging held boost plays a **one-shot whoosh** — the SSX `Boost` audio cue. In the game
this is a one-shot from the global **MAIN** bank (`zbxsfx`, group 0, the
same ring template as the gem/pad chimes) fired at the boarder and gated to the local human,
with **which** of three variants playing chosen by the rider's **BOOST/Tricky-meter** level — `> 0.666 →` slot
**120**, `> 0.334 →` slot **121**, else **122** (meatier the more meter you have; the clips are ~1.12 s mono)
[Trailmap: 360-speed-and-boost]. It fires **once on the engage frame, not a loop** — a held boost re-arms only after you release, so the
~1.12 s clip plays out regardless of when you let go (verified in-game). Nothing tracks the voice
afterward: there is no per-frame volume update, and the "held-boost slew" fields are **physics**
(boost-magnitude smoothing), **not** audio. It is also **ground-only** — boost engaged in the air or on a rail
raises the speed cap **silently**, and air-spin (control states 8/9) and jump-release-wait (10) never arm the
chime. It is
**not** a pad chime (slots 114/115, on *crossing* a pad, [040](../040-boost-pads.md)) nor the "It's Tricky" song swap.

**But the clips are FLAT** (~constant amplitude for the full 1.12 s — measured), so a literal fire-and-forget
one-shot would play *steady then cut*. In the real game the boost sound clearly **fades** (quick on release, and
even while held it drops to a faint sustain) — which a flat clip can only do via **external voice-volume control**
the trace doesn't pin. So we **reconstruct the heard envelope** rather than play a bare one-shot:
`UpdateBoostAudio(onGround, dt)` (in `.Audio.cs`) drives a dedicated looping `boostSource` with a **punch → low
sustain → release-fade** envelope — `boostVolume` on the grounded engage edge for `boostPunchSeconds`, decaying to
`boostVolume × boostSustainFrac` while held, fast-fading to 0 + `Stop` on release / takeoff / empty meter (slew
speed reuses `soundFade`). The live run meter (or `boostMeter01` in free-ride) picks the tier (120/121/122). Knobs:
`boostClips`, `boostVolume`, `boostSustainFrac` (0.2), `boostPunchSeconds` (0.22), `boostMeter01`.

**Air boost (embellishment).** While **airborne** with boost held, the board also thrusts toward where the
boost **hand** points — in VR the same **left hand** squeezing the trigger, the trigger-flight's point-to-fly
gesture ([024](024-player-flight.md)) brought onto the deck at ~¼ of its 30 m/s² strength (`airBoostAccel`,
default 8 m/s²); desktop has no tracked hand and aims by **look** instead. It's full 360°: aim up to stretch
the air, down to dive at the landing, sideways to reach a rail. Hand, not head, in VR because the head is
already spoken for — gaze-steer (`HeadFollow`) yaws the board toward where you look in the air, so a head-aimed
thrust could only ever push where you're looking; the hand decouples them, letting you eye the rail while you
retro-thrust toward or away from it. The thrust folds into the air tick's `_tickAccel` (the engine's
explicit-Euler order), and the shared speed cap still clamps at the boost tier, so it shapes the arc rather than
flying you; during a scored run the meter gates + drains it exactly like the held boost. The boost sound runs
while the air thrust fires (`_airBoostActive` extends `UpdateBoostAudio`'s gate); rails stay silent. This is
deliberately past the engine — the game's air states read no boost field (a held boost in the air only sustains
the raised cap, silently) — so `airBoostAccel = 0` restores the faithful behaviour.

**The boost meter (implemented).** A `0..1` energy (`Score.cs`, the decoded SSX boost/Tricky meter,
`Trailmap: 360-speed-and-boost`) — *simplified per design: "full is just full", no "It's Tricky" / uber /
infinite-boost tier*. **Banked tricks fill it** by their **base style points** (no gem multiplier, no big-air —
the game's fill = `style × 0.67869` = base points ÷ 10 000, so
`boostFillPerPoint` defaults to the exact `0.0001`: ~17% per clean 360, ~10%/s on a grind); **holding boost
drains it**
(`boostDrainPerSec`, default the game's `0.045`/s ≈ 22 s per bar); a **bail subtracts** `boostCrashPenalty`
(≈ 0.1). When empty, held boost is unavailable — `BoostActive()` gates on `BoostMeterHasCharge()`, and the engage
sound won't fire either. The meter only governs **during a scored gate run** (`boostMeterEnabled && scoringEnabled
&& a gate run`); **free-riding keeps the unlimited hold**, so cruising is unchanged. It also drives the
engage-sound tier (live meter → slot 120/121/122). Drain is in *every* state while held (a small simplification of
the game's ground-only active drain). Shown on the **run HUD** as a row of **15 dots** in a five-step
**yellow→orange→red** ramp (3 dots per step) along the bottom — a generated sprite on a horizontally-`Filled`
`Image` (`RunHudSetup` bakes `openslope_boost_dots.png`), driven every frame by `RunBoostMeter` and **quantized to
whole dots** (a dot pops on/off as it's earned/spent), no border. Just above it sits the **jump-charge
wedge**: **15** white vertical stripes in a triangle (one centred over each boost dot, no height left → full height
right, `openslope_jump_wedge.png`), Filled by
the ollie charge (`dbgCharge`) and shown **only while a jump is held**. The whole boost/jump readout is **⅓**
width, centered. The whole HUD sits at **0.75 opacity** (a
`CanvasGroup` on the panel). Knobs: `boostMeterEnabled`,
`boostMeterStart` (start charge, default 0.25), `boostFillPerPoint` (0.00005), `boostDrainPerSec` (0.045),
`boostCrashPenalty`.

Obstacle bounce reads imported `PlayerBounceAmmount` metadata from `PropsCollision` buckets; the
`TrickOnlyPatch` scoring window is still a stub hook (see open questions).

Runtime constants and all 20 surface rows come from
`Trailmap/specs/data/ride-v1.json`, generated into `RideableBoard.Contract.Generated.cs` and Slopesmith's
matching TypeScript view. Existing serialized inspector values therefore cannot silently override grounded load,
drag, contact transitions, steering shaping, pose response, or speed caps. Inspector fields remain for orthogonal
platform behavior such as riderless coast, collision queries, tricks, and view comfort. The ground
heading yaw is calibrated directly to the recovered number from [020](020-surface-physics.md) — full-stick
standard snow reaches the `6 deg/tick` = **360 deg/s** cap by ~8 m/s — so the remaining feel tuning is the carve
(`carveBite`) and lead angle recorded in the shared contract, not a Unity-only yaw-rate override.

## Firing trigger volumes while you ride (the rider probe)

The crash-bag knockables ([016](../016-physics-props.md)) and firework triggers ([019](../019-fireworks.md)) detect
you with VRChat's **`OnPlayerTriggerEnter`**, which is raised by the player's *locomotion capsule* sweeping a
volume. **A `VRCStation` passenger doesn't generate it:** you're immobilized and *carried* by the station's
transform, not walking a capsule through the world — so on the board those volumes go silent (you can confirm
it by walking through one, then riding through the same one). The deck's own `BoxCollider` is no help either —
it's thin and rides at ankle height, below where those volumes sit, and could tunnel between physics frames at
speed.

The fix is an invisible **`RiderProbe`**: a child `CapsuleCollider(isTrigger)` sized like a standing rider
(`r 0.30`, `h 1.70`, centered ~0.85 m above the deck) carrying a **kinematic `Rigidbody`** so its sweep raises
trigger events without PhysX integrating it (the board still hand-integrates its own motion). The trigger
scripts grew a second, additive path — `OnTriggerEnter(Collider)` alongside the existing
`OnPlayerTriggerEnter` — that fires only when `other.GetComponentInParent<RideableBoard>()` is non-null
**and** that board's `IsRiding` is set (so a parked board whose probe happens to overlap a volume never trips
it). The crash bag flings itself along the board's `RiderVelocity` (a `VRCStation` passenger reports no player
velocity of its own); the firework reuses its same volley + cooldown. The probe sits on the **Ignore Raycast**
layer so the board's own ground-ray (`Probe`) can never grab it — the same space-elevator guard as
`_ownCollider`. Built in `RideableBoardSetup.BuildBoardAt`, so **re-run `OpenSlope/Setup/Start Gate
Boards`** to give boards already in a scene the probe.

## Colliding with props & walls (collide-and-slide)

Triggers are *volumes you pass through*; **stands, signage and walls are solid colliders the walking capsule is
physically blocked by** (the game's real collision proxies, imported by `CollisionBuilder` from the bundle's
collision proxy meshes). The board is hand-integrated and **kinematic**, so PhysX never blocks
it — a kinematic mover passes through everything regardless of what collider it carries. So the board has to do
the blocking itself, in script.

**What the engine does** (so we match it, not guess): a prop's collision mode alone decides how the rider
meets it. Shape contact and effects can occur without physical response: exact-zero
response mass or `PlayerBounce=false` leaves a shaped instance ride-through. Live mode-1 and mode-2 controls both
confirmed that rule. A response-enabled static prop bounces the rider by its `PlayerBounceAmmount`
(the object-property float, 0.03/0.2/0.5/0.6) and guarantees the native 2 km/h minimum eject. **Finite mode-3
objects (crash bags, path markers, Event5 — the [016](../016-physics-props.md) knockables) behave differently
again.** They are not wall-slid and not bounce-responded against — they're knocked as bodies, so the rider
keeps its speed and passes through. That's why the board excludes `PhysicsProp` colliders from the
collide-and-slide sweep (above). ([Trailmap: 370-world-interaction])

So the runtime (`RideableBoard`, local rider only) does **collide-and-slide** each frame, before the ground
probe:
1. Sweep the rider capsule (the **same `RiderProbe` dims** from the trigger work) along the intended move with
   `Physics.CapsuleCastAll` (Udon-whitelisted, with the `QueryTriggerInteraction.Ignore` overload).
1b. **Push out of anything the sweep starts inside.** A capsule cast that begins overlapping returns distance 0
   and a useless normal, so it cannot drive the slide — and simply skipping it is what let a rider take the whole
   move and sail through the very prop they were embedded in, then stay stuck in it. Those colliders are collected
   during the sweep and resolved afterwards with `Physics.ComputePenetration`, moving the rider along the contact
   normal by **1.1x** the reported depth. That is the engine's own order: a solid prop contact depenetrates first
   and applies restitution second ([Trailmap: 370-depenetrate]). An up-facing push is ignored — that is the ground
   holding the rider up, which the down-probe owns. Only the deepest overlap is resolved per frame.
   `Physics.ComputePenetration` is the one API here whose Udon exposure has not been confirmed by a build; if an
   SDK build rejects it, `Depenetrate` can return `pos` unchanged and the sweep reverts to its previous behaviour.
1c. **A bounding box is met by the BODY SPHERE, not the capsule.** The rider is a different shape per collision
   mode ([Trailmap: 370-probe-modes]): mode-1 proxies and mode-3 bodies are met by the engine's limb spheres,
   which are 0.1–0.3 m and which the ~0.3 m probe capsule stands in for well — but a **mode-2 box is met by one
   ball at the pelvis, radius 0.85 m**, read live off the engine. So bounds colliders get their own
   `Physics.SphereCastNonAlloc` pass. Two things fall out: the ball is larger than the swept capsule everywhere
   the capsule exists, so it always reports the earlier hit and the capsule pass needs no exclusion; and because
   it reaches from ~0.07 m to ~1.77 m it restores deck-level presence against boxes, which the capsule's raised
   foot (`sweepFootClearance`) had removed. Mode-2 colliders are told apart by a parent-reference compare
   against the importer's one `PropsBoundsCollision` root — no per-hit `GetComponent`, and no layer change that
   would alter how the walking player collides. This sphere pass is the default shipping behaviour;
   `bodySphereCollision = false` (or `bodySphereRadius = 0`) disables it in code/the inspector and reverts to
   capsule-for-everything as a fallback.
2. **Filter by hit-normal, not by terrain membership:** a hit counts as an obstacle when its normal points less
   upward than `wallNormalMax` (≈ steeper than 60°) — so vertical **walls (`Surf_10/13/14`) block too**, while
   up-facing ground is left to the down-probe. Triggers are ignored (knock sensors, foliage, volumes);
   the board's own deck box + probe are skipped explicitly. **Mode-3 knockables (crash bags, vents, path
   markers — anything carrying `PhysicsProp`) are also skipped, anchored or flying** — the game
   *physics-routes* mode-3 bodies (finite mode-3 objects route to physics/body handling,
   [Trailmap: 370-world-interaction]), so a crash bag gets knocked and flung but never wall-stops the rider.
   Without this skip the sweep collide-and-slides against the body's solid box (which anchors solid so the
   *walking* player is blocked like scenery, [016](../016-physics-props.md)), bleeding the rider's speed —
   the opposite of the game, where you plow straight through (`PlayerBounceAmmount 0.2`, the
   "soft/absorb" tier).
3. Move up to the nearest such hit (minus a skin), **project the remaining motion onto the wall** and iterate a
   few times so corners resolve; remove the into-wall part of `_vel`.
4. Read `PropBounce` from the hit collider. `CollisionBuilder` parses `PropsCollision.obj`'s
   `o inst{N}_...` groups, maps them back to `Instances.json`, and buckets the invisible MeshColliders by the
   authored `PlayerBounce` / `PlayerBounceAmmount` pair. Native `PlayerBounce=false` contacts are omitted from
   solid buckets; response-enabled buckets carry their authored amount, scaled by `obstacleBounceScale`, plus
   the native 2 km/h minimum outward eject. A legacy/manual collider carrying `PropBounce` with the flag off
   falls back to pure slide, but that is a compatibility behavior rather than the native authored state.

5. **Feed the wedge integrator.** A contact that actually pushed the rider back also banks
   `1 − dot(boardUp, hitNormal)` into the board's **bump integrator** — the engine's "stuck against the level"
   detector, which resets a rider held against an object for ~5 consecutive ticks during a timed run
   ([031](../031-out-of-bounds-reset.md), [Trailmap: 395-reset-arm]). Terrain hits and faces the board is standing
   on feed zero, so only being *driven* into something you can't get past accumulates.

Knobs: `collideWithProps` (on), `bodySphereCollision` (on; inspector/code fallback), `wallNormalMax` (0.5),
`obstacleSkin` (0.05); **`obstacleBounceScale` (1)** —
the multiplier on a response-enabled prop's authored `PlayerBounceAmmount`; and **`obstacleBounce` (0 = slide)** — a flat
fallback only for obstacle colliders with no `PropBounce` (terrain walls, hand-placed colliders). The default now
applies the authored amount literally so Slopesmith's response control is observable end to end; set the scale
to 0 to suppress the restitution term (the native minimum eject still applies to flagged props). The shared
spec defines the exact normal response as `max(b·s, 55.556 cm/s)` with tangential velocity unchanged.
(Requires a level re-import to generate the bucketed colliders + `PropBounce`; the slide itself works against
the plain merged collider with no re-import.)

## Riding walls (contact-normal grounding)

With enough speed SSX lets you ride **up a wall, bank or quarter-pipe and stick to it** — the carve momentum
holds you to the face. **TRAP:** a ground probe cast **straight down** (`Vector3.down` + `if (normal.y <= 0)
continue`) can never find a wall — a wall is *beside* you, not below — and judging "on the ground" by
**world-Y height** (`cur.y <= _pGroundY + stick`) fails the same way: climbing a wall looks like leaving the
ground, so gravity peels the rider off mid-turn unless the probe and the ground test are both normal-relative
(below). Steep terrain also has to be treated as ridable ground, not just a collide-and-slide *obstacle*.

**What the engine does** ([Trailmap: 320-ground-contact]): its contact probe is aimed **along the cached contact
normal**, not down — it offsets endpoints around the
boarder along that normal and *"the previous contact normal aims the next probe."* Walls (`SurfaceType 10/13/14`)
are **ridable terrain rows**, not obstacles, and the engine only wipes you off a wall when the **into-wall
contact speed exceeds a threshold**. The "stick" is
**emergent**: carving along a curved wall, your inertia presses *into* the surface; the contact cancels that
into-surface velocity and redirects it along the wall — that redirect *is* the centripetal force, and it scales
with speed (fast → you climb higher before gravity reverses you).

**What the board does** (faithful port, in `RideableBoard.cs` + `.Surface.cs`):
1. `ProbeContact` casts **along `−_contactN`** (from the contract's 2 m-above endpoint to 1 m below), accepting a front face
   (`dot(hitN, _contactN) > 0.1`), which generalizes to any surface orientation rather than only up-facing
   ground. It **falls back to the straight-down probe** if the contact cast misses, so first contact, seams and
   flat ground are safe. On a steep analytic seam, a bounded six-tick `MarchTo` recovery may continue the last
   mapped patch when the faceted ray alone misses.
   Used while grounded (predicted by `_wasGrounded`); the air branch still probes down to find a floor to land on.
2. `ContactGap(pos) = dot(pos − _pPoint, _pNormal)` — distance to the surface **along its normal** — replaces the
   Y-height tests. Position remains a free integrated state; the surface threshold decides ground/air, and only
   penetration past the sink budget invokes the capped pushout/normal-velocity kill.
3. The three-zone response acts along the analytic normal; surface `A/100` supplies the normal load and the
   shared 4.73 m/s² Snowdream calibration supplies only the effective contact-plane pull. The
   fresh accepted-contact redirect rotates 40% of normal velocity toward the tangent without changing speed; this
   supplies the quiet contact/centripetal turn. A separating type-6/10 broad-band contact is rejected rather than
   catching the rider on the far side.
4. While riding a steep face (`onWall`: `_contactN.y < wallNormalMax`) the collide-and-slide sweep is **skipped**,
   so the obstacle system can't fight the wall-ride; ridable ground (and props on it) still slide as usual. A
   wall you *slam into as a barrier* still blocks via collide-and-slide — it's a wall you *ride up a continuous
   curve onto* that the ground model owns.
5. `SmoothNormal` accepts a side-facing baked fallback normal (`dot(n, flatN) > 0`, not `n.y > 0`).

On **flat ground** `_contactN ≈ up`, so `ProbeContact` casts ≈ down and `ContactGap = cur.y − _pGroundY` — the
model reduces to plain flat-ground contact. Knobs: **`wallRide`** (on; flip to A/B) and
**`wallCrashSpeed`** (0 = off — the goal here is to *stick*; raise it for the engine's hard-slam bail). Limitation:
the flat→wall transition relies on the contact-normal smoothing tracking a **curved** surface (plus the
down-fallback) — tuned for the curved walls / banks / half-pipes SSX actually has; a hard 90° floor→wall seam may
not bootstrap onto the face.

## The board model

The rider sits on the game's actual board mesh (extracted from `board.mpf`), not a primitive — a random one of
the three real deck shapes, wearing a random rider's real `bord` skin. How those models + skins are exported
from the ISO, oriented/scaled onto the ride frame as a `Deck` child, sized, and skinned is its own concern:
**[018 — Board Model](../018-board-visual.md)**. The rest of this doc is the *physics*.

## VRChat caveats (read before building)

- **Station-driven, local-first.** The rider's motion is the board's; this is **local** physics (each visitor
  rides their own sim, like the knockables in [016](../016-physics-props.md)). Networked/synced racing is a later
  step (`VRCObjectSync` + Udon owner), not the first pass.
- **No real player rigidbody.** The avatar isn't a rigidbody even while seated; we move the *board* and the
  station carries the player. Dismount/remount and getting stuck on geometry are the fiddly bits to expect.
- **Velocity changes are damped.** Same constraint boosts hit ([011](../011-triggers-and-interactivity.md)):
  tune impulses to feel like a shove, and lean on slope-gravity for sustained speed rather than scripted
  velocity sets.

## Steering, orientation and audio notes

The deep physics provenance is in [020](020-surface-physics.md); these are the *code*-level behaviours behind
the loop above:

- **Per-state turn rates.** The generated shared profile owns the ground cap (`6°/tick = 360°/s`) and air rate
  (`270°/s`); rail free-steer reuses that same `270°/s` trick-state rate. Ground heading leads the velocity/gaze reference
  by lean, speed-gates up quadratically, and closes through the surface lateral-drag path rather than a second
  heading-response knob. VR steering runs on the **left stick** (`InputMoveHorizontal`, the same stick whose Y is
  accel/brake), leaving the right stick free for the rider's view.
- **Orientation grace for bump-skips.** Riding fast over bumps pops the board airborne for a frame or two;
  snapping the deck orientation on every re-landing reads as roll jitter. The shared 0.15 s grace treats sub-threshold
  air as still-grounded for orientation (ease, don't snap), and `jumpCoyoteTime` lets an ollie pressed during a
  skip still fire — mirroring the engine's jump being a decoupled control state (step 5).
- **Grounded desktop view smoothing + a chase seat.** SSX shudders the board on turns but renders it through a smoothed
  third-person chase camera, so the view stays steady. Rigid-locking the desktop seat to the board heading pipes
  that shudder straight into the view; `viewSmoothTime` low-passes the seat's follow of heading + bank instead
  while grounded (the board still shudders, the view eases), and `viewYawRateMax` rounds off the sharpest grounded
  first-person yaw. **Air and rails bypass both yaw filters**: air applies the deck's exact stick-yaw delta to the
  desktop seat (preserving the grounded offset without a takeoff snap), while rails lock the seat to the deck heading.
  Keyboard/gamepad spins therefore carry the view at the same full state rate as the deck. Normal first person also retains only a quarter of the board's heading
  lead over travel. This is where the former shared `steerStrength = 0.5` comfort intent belongs: view shaping,
  not lean/contact physics. Chase view still follows the full heading. VR does not use this desktop blend: its
  seat stays pinned against board/head-driven yaw, with only the controller carry described below.
  `chaseCamSeat` optionally seats the rider up + behind the deck to watch the
  board and wake while riding (a testing aid; best on desktop, since in VR the offset seat swings on an arc as
  the board yaws).
- **VR controller view carry.** Headset testing fixed grounded stick-to-view carry at **25%**, applied **after** the
  retail yaw clamp. This leaves the board's carve physics alone and stops at takeoff: airborne tricks carry stick spin
  into the upright seat at 100%. VR rails likewise use the shared air/rail rate and full seat/view carry;
  centring the stick hands the rail back to target-based head steering with its pinned seat. Applying the quarter
  multiplier before the ground clamp was not useful:
  full-stick high-speed turns still reached 6 degrees/tick (360 degrees/s).
- **Stick precision curve.** Left-stick X maps to `sign(x) * x²` on the ground, in the air, and on rails. Partial
  deflection gains more usable range near centre, while hard left/right still outputs exactly -1/+1 and reaches 100%
  of each state's steering rate. Head-derived steering is unchanged.
- **Self-healing audio guard.** VRChat doesn't reliably fire `OnStationExited` on a programmatic `ExitStation`,
  which can leave the glide loop droning after a dismount. `Update`'s `!_riding` branch kills any still-flagged
  audio/FX every frame (idempotent), so a loop can't outlive the ride by more than a frame; the explicit dismount
  paths also stop sound immediately rather than waiting on the callback.

The **sideways-stance station animator** was abandoned; see its own write-up ([022](022-snowboard-stance.md)).

## Open questions (post-first-pass)

- **Tuning.** The μ/grip/gravity numbers are first guesses; the whole point of the first pass is to ride it
  and dial them in. The absolute grounded heading-yaw cap is known, but the Unity `turnFalloffSpeed` shape is
  still an approximation. Expect the slope drive vs. friction balance to need the most work (too much μ and you
  stall on shallow pitches; too little and you never reach a terminal speed).
- **Boost trigger volumes.** The boost *methods* exist; nothing calls them yet. Wiring the `SpeedBoost`/
  `TrickBoost` pads ([011](../011-triggers-and-interactivity.md)) as trigger boxes that call `ApplySpeedBoost`/
  `ApplyTrickBoost` is the natural next step.
- **Obstacle bounce tuning.** `PlayerBounceAmmount` ([016](../016-physics-props.md)) is plumbed onto
  `PropsCollision` buckets and read by the board. The remaining question is tuning/confirming the exact
  restitution formula rather than surfacing the data.
- **Mount ergonomics & networking.** Dismount placement, getting un-stuck from geometry, and a synced/owned
  version for others to see you ride ([016](../016-physics-props.md) is local-only too) are all later.

## See also

[009 — Collision](../009-collision.md) (the `Surf_<type>` colliders + the downward-raycast surface read this
reuses; the no-friction wall this design routes around), [011 — Triggers & Interactivity](../011-triggers-and-interactivity.md)
(boost vectors, reset zones, race lines, the velocity-damping caveat), [016 — Physics Props](../016-physics-props.md)
(rigidbodies-in-VRChat precedent, `PlayerBounceAmmount` for obstacle feel), [020 — Surface
Physics](020-surface-physics.md) (the per-`SurfaceType` coefficients this board's μ/turn/carve come
from), [021 — Analytic Terrain Contact](../021-smooth-contact-normal.md) (the true-Bézier contact this board rides —
analytic normal + analytically-evaluated height + the sink allowance), [030 — Carved Wake](030-carved-wake.md) (the snow trail behind the deck), [031 —
Out-of-Bounds Reset](../031-out-of-bounds-reset.md) (the back-onto-course reset), [032 — Snow Spray](032-snow-spray.md)
+ [033 — Snow Sink](033-snow-sink.md) (the per-surface contact FX), [018 — Board Model](../018-board-visual.md) (the deck mesh the rider rides on — export +
import), [022 — Snowboard Stance](022-snowboard-stance.md) (standing the rider sideways on the deck via a station
pose animation — `seated=false` + `animatorController`), [004 — Orientation & Scale](../unity/004-orientation-and-scale.md)
(why downhill already maps to world −Y), [012 — Spinning Pickups](../012-spinning-pickups.md) (the per-instance
extraction pattern).
