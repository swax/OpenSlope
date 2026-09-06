# 350 — Rails

Grinding is its own motion/control state pair. The rider attaches to an
authored rail spline (`140-paths.md` defines the data), travels by **slewing
velocity onto the analytic curve tangent** with the speed magnitude
preserved, under a dedicated gentle slope gravity and **zero friction**.
Player input on a rail spins the deck for tricks; it is not a balance meter,
and falling off is a **contact-acceptance** failure, not a balance failure.
[[350-overview]]()

> [[350-overview]]() db:rail; map:"Rail slide — resolved" — rail travel
> = motion state 3 (@0x0010b0d0), on-rail control = state 15 (@0x001073e0,
> set by the accepted entry @0x00126224); state 16 (@0x00100908) is the
> launched-air trick state the rail's lost-contact exit @0x0010bfb0 enters
> with motion 1 (`300-rider-states.md` `[[300-control-states]]()`);
> db:balance (no balance meter found).

## The rail is ridden as a true curve

Each tick, the grind queries for the nearest rail: a broad-phase walk of the
world grid with generous (±3 m) bounds tests, then **a per-candidate
admission bit** before any curve math runs — a segment whose linked scene
object has its candidacy bit clear is skipped outright. The bit's initial
value is **authored**: it is the second small integer of the behavior file's
spline record (`230-level-ssf.md`), which every retail grind rail ships as 1,
so an untoggled rail is eligible from load; the logic graph's spline-toggle
(`140-paths.md`) is the only thing that clears or re-sets it afterwards —
used both to hold a spline *off* until an event enables it and to gate a
class of rails *off* by game mode. Segments
that pass get a **closest-point search on
the actual cubic** — the curve is sampled at five parameter values, the
query point is projected onto the four chords only to *bracket* the nearest
span, and a golden-section search (up to 24 iterations, parameter tolerance
≈ 5×10⁻⁴) refines on the true curve. The travel direction is the **exact
derivative tangent** at the refined parameter. Heading
therefore varies continuously along a curved rail — there are no per-segment
heading steps. [[350-analytic]]()

The rail carries its own surface type, and while grinding it **replaces**
the terrain's in the rider's contact fields, so ride feel keys off the
rail's material rather than whatever passes underneath. Whether ride
*audio* follows the same swap is a traced open lead, not yet confirmed
[inferred] (`420-audio-runtime.md`). [[350-railsurface]]()

> [[350-analytic]]() db:rail-geometry —
> `RailQuery_FindNearestRailCandidate` @0x00259860: grid broad-phase with
> ±300-unit AABB gates; coarse t ∈ {0,.25,.5,.75,1} chord bracket; golden
> section @0x00259fd0 (0.61803/0.38197, ≤24 iters, tol 5e-4) on the cubic;
> analytic tangent @0x0025a3e0 (derivative basis [3t²,2t,1,0]); admission
> bit read at `0x00259bf8` — `*(segment+0x58)+0x18` bit 0, accepted when set,
> rejected when clear — the same field `RailMan_ApplyRailFlagToSceneObject`
> `0x00148ee0` sets (`Effect≠0`: `ori v1,0x0001` @0x00148f3c) or clears
> (`Effect=0`: `and v1,~1` @0x00148f50) from the `cRailMan` entry flag
> written by `RailMan_RegisterRailEffectCandidate` `0x00149038`. The bit's
> load-time value is the SSF spline record's second i16, stored into both
> halves of `sceneObject+0x18` by the loader at `0x0025fe04–0x0025fe18`
> (`230-level-ssf.md` `[[230-splines]]()`; retail rails ship 1, movers −2), so
> the gate defaults to accept for every shipped rail and only
> an authored `MainType 25` toggle changes it (`140-paths.md`
> `[[140-rail-toggle]]`). The query reads the flag straight off the candidate's
> own scene object rather than re-consulting the `cRailMan` registry at query
> time (that registry has no other reader); map:"Rail geometry — resolved
> (analytic cubic spline, NOT straight edges)".

> [[350-railsurface]]() db:rail — surface type copied from the rail-hit
> result into the rider @0x0010b1b8 (map:"Rail geometry — resolved (analytic
> cubic spline, NOT straight edges)").

## The tube prop is scenery, not the rail

The grindable thing is the invisible spline; the visible tube is an
ordinary prop instance, and what the discs give it for **object collision
varies by level**: GARI and MERQUER ship their rail tubes with no collision
at all (collision mode 0, player collision off) — the rider either grinds
the curve or passes through the metal — while MESA and ELYSIUM give every
tube a **full-size mode-1 mesh collider** (bounce 0.5) and SNOW mixes
mode-1 meshes with mode-2 bounds slabs. Where a collider exists it is the
render tube's own shape, not a slimmer core: the surveyed MESA collider
matches its render mesh's bounds exactly at near-identical triangle count.
MESA's and ELYSIUM's rails grind on the original discs with those solid
tubes in place, so object collision does not veto rail lock-on. Rail
support posts are solid mode-2 bounds slabs on every level. Those posts are
not hidden through a `HideShowOff` effect edge: their instances belong to the
LTG **GemIndex** (`LTGState == 2`), the native object layer loaded only for
Showoff. Consequently Race and Freeride omit both their render model and their
solid bounds contact. [measured] [observed]
[[350-tubeprops]]()

A grind also runs the **narrowest prop probe in the game**. Every motion state
picks which of the rider's collision spheres are live before its object pass
(`370-world-interaction.md`), and the rail state picks two: the **torso and the
head**. Everything below the pelvis is masked off — both legs, both feet, and
all four board spheres — which reads as deliberate rather than incidental. A
grinding board is locked to the spline and its path is already decided, so the
only part of the rider that still has to negotiate the placed world is the
person standing on it. [[350-probe]]()

> [[350-probe]]() db:collision; `370-world-interaction.md` `[[370-probe-mask]]`
> (rail mask = 3, i.e. limbs 0 and 1, written and restored around the object
> pass) and `[[370-probe-volume]]` (those two limbs are joints 2 and 4, the only
> ones posed above the pelvis; measured live against the hip pair and the feet).

> [[350-tubeprops]]() Census over the extracted `Instances.json` of all
> five levels: GARI `Mdl_Rail_Metal` ×98 mode 0 / PlayerCollision false;
> MERQUER `Gem_RailShowOff` ×93 + `Gem_ShowOffRail*` ×72 + `Mdl_Rail*` ×17
> all mode 0; MESA `Gem_Rail_Metal` ×99 mode 1 with a collision model,
> PlayerBounce 0.5; ELYSIUM `Mdl_Rail_Metal` ×99 mode 1; SNOW non-support
> rails 78 mode 1 + 69 mode 2; `Gem_RailSupport` mode 2 with PlayerCollision
> on every level. MESA sample `Gem_Rail_Metal_1000`: render `Meshes/1128.obj`
> vs collider `Collision/44.obj` — identical bounds (78.7 × 276.0 × 150.5),
> 15 verts each, 22 vs 20 faces. GARI's entire `LTGState == 2` census is 157
> placements: 78 `Gem_RailSupport_1000` and 79 `Gem_TrickMultiplier_*`, with
> no other models. The LTG regenerator routes state 2 directly to `GemIndex`;
> live retail verification finds both sets only in Showoff.

## Attaching

Rail acquisition runs from both the air and the ground states through the
same candidate query, accepting when the rider sits inside the rail-local
**snap windows** below scaled by 0.9 (entry is slightly stricter than
staying on). Entry preserves the carried velocity (it is re-aimed, not
reset), clears the carve lean, and switches to the rail state pair.
[[350-entry]]()

> [[350-entry]]() db:rail-entry — `Boarder_TryEnterRailMotionCandidate`
> @0x00125cc0, called from the air and ground updates; thresholds ×0.9
> (0.9·lerp(80,150,b), 64.8, 0.9·lerp(30,72,b)); sets motion 3 + control 15.

## Traveling

The per-tick velocity update has exactly three speed-affecting terms — and no
drag: [[350-travel]]()

- **Tangent capture.** Velocity slews toward its projection on the rail
  tangent at a fixed rate of 30/s, **keeping its magnitude** — entry speed
  becomes grind speed.
- **Rail slope gravity.** A clean static down-vector of 980 units/s²
  (= 9.8 m/s²) is dotted with the tangent and applied along the tangent —
  downhill rails accelerate, uphill rails bleed. This is a dedicated, gentler
  rail gravity: about half the airborne falling gravity
  (`340-jump-air-landing.md`).
- **Boost thrust.** While the held boost is active
  (`360-speed-and-boost.md`), 2450.8 × boost units/s² is applied along the
  tangent **signed by the current travel direction** — boost pushes you along
  the rail even uphill. [[350-travel]]()

The shared speed cap still applies and only ever scales speed *down*
(`360-speed-and-boost.md`). A separate lateral attachment correction nudges
the rider's **position** onto the rail (clamped to ≈ ±2.9 m); it does not
change speed. [[350-travel-vals]]()

> [[350-travel]]() db:rail-slope — tangent slew 30.0/s @0x0010b568
> (magnitude-preserving); lazily-initialized static down vector (0,−980,0)
> dotted with the
> tangent, coefficient 1.0; no `v·k` drag term anywhere in the rail motion
> update; db:boost-rail (thrust 2450.823 · boarder+0x130, signed by the
> tangent projection f23).

> [[350-travel-vals]]() db:rail — lateral lean/attach position
> correction @0x0010b700 clamped ±290.15 units, writes position only;
> db:speed-cap (down-only cap in the shared update).

## Steering on the rail: spin, not balance

Rail input is read as quantized direction (−1/0/+1 per axis). Holding a
direction slews a spin rate (at 75/s²) that yaws the deck about the rail,
**clamped to ±80°**, and feeds trick scoring; near-idle spin rates allow a
full-circle direction flick to select rail trick animations in 45° bins. None
of this drives a fall-off meter: no balance accumulator, no
"leaned-too-far" ejection threshold exists. A trick-boost window
(`360-speed-and-boost.md`) scales the rail spin rates by 1.6.
[[350-control]]()

> [[350-control]]() db:rail-control-input; db:rail-balance — 2-bit
> direction decode @0x00100b0c; slew 75.0·dt @0x001011b0; yaw clamp
> ±1.39626336 rad @0x0010097c; 45° trick bins via @0x00102158;
> db:trick-boost (×1.6 on the state-16 spin-rate fields).

## Leaving the rail

The grind continues only while each tick's rail query **re-accepts contact**:
the rider's rail-local offsets must stay inside three windows —
`|c0| < lerp(80, 150, b)`, `|c1| < 72`, `|c2| < lerp(30, 72, b)` — where the
blend `b` is forced to 1.0 (the widest windows) for the first 0.6 s of the
grind as an attach grace. Ways off: [[350-exit]]()

- **no candidate** — the rail ended (or a junction's next segment is out of
  reach): the rider transitions to air with carried velocity;
- **window failure** — drifted/spun off the attachment: same transition;
- **jump** — the ollie fires the shared jump launch from the rail
  (`340-jump-air-landing.md`); there is no rail-specific exit pop;
- an explicit **input-driven exit** bit also leaves the grind.

Chaining onto a following rail is the entry path again: the next tick's
query simply accepts a different candidate. [[350-exit-vals]]()

> [[350-exit]]() db:rail-kickoff — s5 acceptance flag: no-candidate
> branch @0x0010b1b4; window gate @0x0010b3d8; grace `b = 1.0` while the rail
> timer < 0.6 s; tail gate @0x0010bf6c; lost-contact
> transition @0x0010bfb0 clears lean and writes motion/control 1/16.

> [[350-exit-vals]]() db:rail-contact (exit = contact acceptance loss,
> the inspected negative for yaw-angle/lateral-distance/speed thresholds);
> db:rail-control-input (input exit bit 0x0100 @0x0010210c); db:rail (jump
> exit via the shared launch, map:"Rail slide — resolved").
