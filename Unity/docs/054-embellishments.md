# 054 — Embellishments: where the port deviates from the game

The port's default posture is fidelity: traced constants, RE-grounded models, `[Trailmap]` citations. This doc is
the **register of every deliberate deviation** — embellishments for feel, accessibility adds, VR-embodiment
necessities — so that (a) a deviation is always a written decision with a rationale, never an accident, and (b) every
OpenSlope port (the VRChat/Udon world, the Basis world, Slopesmith) ships the **same set**, tuned the same way.

## Ground rules

- A deviation ships with an **off switch** wherever practical, and the faithful setting is documented on the knob —
  `0 = off (engine-faithful)` is the house pattern. Defaults may pick the embellished value; the knob preserves the
  faithful behaviour for A/B tests and purist tuning.
- Mark it **at the source** (the tooltip/comment says "embellishment" / "the game has no…") **and** list it here.
  This doc is the cross-port checklist; the tooltips are the per-knob truth.
- Platform **infrastructure is not an embellishment**: multiplayer sync (docs/vrchat/042), board pooling and claims,
  the gate-bench boards (046–049), the leaderboard (050) exist because a persistent social world needs them, not
  because the game played that way. They're out of scope here except where they leak into ride feel.

## Rider embodiment & input

- **Head-look steering** (`headLookSteer`, VR only) — the game steers by stick alone. The gaze turns the heading
  (turn-to-match with a `headLookDeadzone` stop) *and* feeds the game's input→lean slew as a virtual stick, so a
  head-steered turn carves with the real tilt force; the seat stays pinned (self-limiting, comfort). Off = stick-steer
  everywhere.
- **Grounded desktop view damper** (`viewSmoothTime`) — low-passes the seat's follow of heading + bank so the view eases
  while the deck still shudders authentically. Air carries the deck's exact yaw delta and rails follow it at full rate.
  `0` = rigid.
- **Hand-aimed air boost** (`airBoostAccel`) — the engine's air states read no boost field (air boost only sustains
  the raised speed cap). The port thrusts toward the boost hand (VR) / the look (desktop) while airborne, meter-gated
  like held boost. `0` = engine-faithful.
- **Trick-boost air spin ×1.6** (`airTrickBoostSpinMul`) — the game's ×1.6 spin-up is gated to the *rail* spin state;
  the port lifts that same constant onto the air spin/flip while boosting. `1` = faithful.
- **Air flips on stick-Y** (`airTrickEnabled`) — a deck-only somersault under an upright, pinned view: the
  embodiment-safe stand-in for the game's animated trick states. Trajectory stays ballistic; an unfinished flip lands
  crooked and pays the touchdown bands.
- **Jump coyote time** (`jumpCoyoteTime`) — an ollie pressed during a bump-skip still fires. `0` = strict.
- **Airborne boost audio** — the engine's boost cue is ground-only; the port also plays it for the air boost (a
  player-commanded thrust should be heard).

## The board as a free object

The game's board exists only under the rider. Everything a board does **off the rider's feet** is port design, kept
deliberately consistent across ports:

- **Grab & carry** — the VR grip carries the very box the trigger mounts; desktop's one click is spent on riding.
- **Over-the-shoulder summon** (`BoardSummon`) — reach behind the head and grip: your claimed board recalls to the
  hand from anywhere.
- **Hand-to-hand pass** (`handTransferReach`) — gripping the free hand on a held deck takes it into that hand; the
  old grip then opens without a throw.
- **Keep-orientation hold** — every way into the hand keeps the deck's orientation at the grab (native pickup
  `orientation = Any`; the summon hold captures the grip-relative pose) — the board translates to the hand and rides
  the wrist, never snapping to a canned carry pose.
- **Throw** — a released board flies a true ballistic arc, tumbling with the hand's measured spin (capped), until its
  first ground touch; then it is a standard coasting board again.
- **Riderless coast** (`coastAfterDismount`) — a jumped-off or set-down board keeps its speed, falls, slides and
  parks. A jump-off (not a throw) scrubs its horizontal air carry so it drops rather than sails downhill.
- **Park raise-to-surface** — a parked board lifts onto the visible faceted surface so it never rests buried under
  the render mesh in an analytic dip (powder bowls).
- **Avatar-fit deck** (`fitBoardToAvatar`) — the visible deck + collider scale to the rider's eye height; the
  hand-integrated physics reads no scale, so feel is identical for everyone.

## Mount / dismount continuity

The game never leaves the board mid-run; the port does, and keeps the run coherent through it:

- **Airborne exits keep your arc** (`carryAirDismountVelocity`) — a station passenger has no velocity of their own,
  so stepping off mid-air hands you the board's. Grounded dismounts untouched.
- **Airborne mounts keep your arc** — every seat path samples the player's live velocity just before seating, so a
  flying or falling player rides on instead of stopping dead.
- **The mid-air deck grab is a trick, not a dismount** — grip pulls the deck off your feet (air-only by default),
  the trigger puts it back; the run clock keeps going off-board, an airborne catch resumes the run untouched, and the
  run really ends on a foot landing, a board park, an eject or a recycle. The announcer's "GO" fires only on the
  run-starting gate mount.
- **On-foot trigger flight** (docs/vrchat/024) — the point-to-fly jetpack for getting around the mountain on foot; a
  pure embellishment the board suppresses while ridden or held.

## Rails

- **Rail brake** (`railBrakeStrength`) — the game has no rail brake; an accessibility add for tight bends. `0` = none.
- **Deck-reach catch** (`railDeckReach`) — the game catches on the rider point only; the long visible VR deck also
  catches by nose/tail. `0` = centre-only (game-faithful).
- **Rail drag** (`railFriction`) — the game has none; leave `0` (>0 is a non-faithful scrub).
- **Curve fling** (`railFlingEnabled`, default off) — a geometric over-speed throw the game doesn't have; opt-in.

## Hazard & landing defaults

Faithful mechanisms whose *defaults* are softened; each knob restores the game's behaviour:

- **Wall crash off** (`wallCrashSpeed = 0`) — the engine wipes out on the bounce/wall surfaces past a speed
  threshold; the port's wall-ride goal is to *stick*. Raise (~20) for the SSX hard-slam bail.
- **Hard-landing bail off** (`landBail = false`) — the touchdown orientation bands still price a crooked landing;
  the eject is opt-in.
- **Bad landing wipes the trick, not the rider** (`badLandingZerosTrick`) — no eject, score only.
- **Race-only out-of-bounds carry-back** (`resetToTrackOnOOB`, docs/031) — the reset *volumes* are the game's;
  carrying the rider back onto the course line during a timed run is port design. Free-roam is left alone.
- **Race-only wedge reset** (`resetWhenWedged`, docs/031) — the bump integrator itself is the game's, constants and
  all ([Trailmap: 395-reset-arm]); gating it to a timed run is the same port design as the carry-back above, so a
  free-rider leaning on a fence is never warped off it.

## Meters & scoring

- **Boost meter, simplified** — "full is full": no Tricky/uber tiers. Free-riding's unlimited boost *is* the game's
  own meter-pinned infinite-boost state; `boostMeter01` stands in for the engage-whoosh tier pick.
- **No grab-hold trick tier** — the board has no grab control, so the engine's flat grab-hold add is the one scoring
  component dropped. Spins, flips, grind accrual and big-air use the traced constants.

## World dressing

- **Snowfall on every map** (docs/044) — the game rolls weather at course init and the level data carries no snow
  flag, so the port builds the snow field everywhere, on by default, per-player toggle (docs/vrchat/047).
- **Breakable-logo impact particles** (`BreakableLogoU`) — an engine-plausible burst the original omits (the
  source levels author no collision-particle emitter).
- **Snow spray, distilled** (docs/vrchat/032) — the five engine spray rings run as two systems (surface fan + soft
  cloud) tuned to the table's own numbers: a particle-budget adaptation, not a look change.

## Porting checklist

Bringing up a new OpenSlope port: implement this list — same behaviours, same knob names where the platform allows, same
defaults. When a new deviation is invented in *any* port, it lands here first (what deviates, why, the off switch),
then in that port's tooltips; the other ports pick it up from this register.
