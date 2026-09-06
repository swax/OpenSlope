# 370 — World Interaction

How the rider and the placed world act on each other at runtime. The shapes
and per-instance data are defined in `130-collision-data.md`; the effect-logic
plumbing that scripted reactions ride on is `150-logic.md`. The response
splits by the instance's authored data and live body state into four regimes:
ordinary terrain/ride-surface **slide**, a tuned **bounce** off response-enabled props, a
**rigid-body shove** for effect-activated bodies, and **pass-through**
contacts that exist only to fire logic or sound (breakables, triggers,
pickups, the foliage swish of `420-audio-runtime.md`). [[370-overview]]()

> [[370-overview]]() db:collision; map:"Boarder/body bump and
> prop-bounce paths" — object response pass
> `Boarder_ObjectCollisionProbeAndResponseCandidate` @0x00125090, called from
> the air, ground, rail and surface-material updates.

## The rider's own shape

The rider does not meet a prop as a point, a ray, or a swept deck box. It
carries a **collision volume** — one **body sphere** plus eighteen smaller
**limb spheres**, all re-posed from the character's own skeleton every tick —
and the object pass runs *that* volume against the shapes of
`130-collision-data.md`. The limb spheres map onto the skeleton exactly: the two
joints above the pelvis, then a shoulder–elbow–hand chain and a hip–knee–foot
chain per side, and finally four **board** spheres spaced along the deck axis
off each foot. Their radii are fixed at construction and run from a tenth of a
metre at the hands to three-tenths at the feet.

The body sphere sits at the **midpoint of the two hip joints** — the pelvis —
and takes its radius from the character definition rather than from code. The
radius is **per character**, authored in metres and copied into the rider's
record when the field is assembled, and it spans **0.70 m to 1.00 m** across the
roster (0.85 m for the default rider measured here). Either way it is a coarse
ball around the whole rider: it reaches from just above the deck to over the
head, so it is not a small chest sphere that low or high geometry slips past.
The only override is the hidden character cheat, which forces 0.80 m outside
one game mode. Terrain is untouched by any of this — the ground probe is a
short line stab along the surface normal (`320-ground-contact.md`) — so the
volume is the *prop* probe specifically. [measured] [[370-probe-volume]]()

Which limbs are live is **per motion state**. Each state writes a limb
bitmask before its pass and restores "every limb" afterwards, so the rider is a
different size to the placed world depending on what it is doing: the whole
volume in the air, a subset on the ground, and — while grinding — **the torso
and the head, and nothing else** (`350-rails.md`). The legs, the feet and all
four board spheres are masked off on a rail, which is the sensible reading: the
board is locked to the spline, so the only part of the rider that still has to
meet the placed world is the person standing on it. The mask is what sizes the query's
broad-phase box — the union of the enabled limbs' boxes, or the body sphere's
own box when the mask is empty — so a prop whose bounds miss that box never
reaches a shape test at all. [[370-probe-mask]]()

The narrow-phase shape then depends on the instance's collision mode, and
**not every mode consumes the whole volume**: a triangle proxy is met by the
volume swept over the tick, a physics body is gated on the body sphere and then
tested against every limb sphere in turn, and a **bounding-box instance is met
by the body sphere alone**. Mode 2 is the surprising one — the limb mask never
narrows a box test, because that path's per-limb loop re-tests the body sphere
instead of the limb it selected. A box-collided prop therefore only ever meets
the rider's trunk, wherever the deck is. [[370-probe-modes]]()

### A sphere meets a box on its faces only

The box test is not a true sphere/box overlap. It considers the six faces
independently: a face can register only when the sphere's **centre** lies
inside the two perpendicular slabs, and then accepts when the centre is within
one radius of that face's plane. The admitted region is the box grown by one
radius across each face with the **edges and corners left square**, so a sphere
that overlaps only an edge or a vertex of the box reports nothing at all. The
contact taken is the face with the least clearance: its outward axis is the
normal and the contact point is the sphere centre projected onto that face's
plane, which is why a box contact normal is always one of the six axis
directions. [[370-sphere-box]]()

A consequence worth stating for anyone porting this: **a bounding box around a
flat panel is mostly empty air**, and the engine collides the air. One shipped
course hangs a jumbotron screen authored as a single zero-thickness rectangle,
turned well off the world axes; its box is a slab several metres thick in the
direction the panel has no thickness at all, and its most protruding corners
stand metres clear of any surface a player can see. A grind spline is routed
through the bottom corner of that box, entering it by under five centimetres
over a sixth of a metre of travel, and the rider does not stop. [measured]
[[370-probe-worked]]()

That the rider is a single trunk sphere there rather than a deck-sized swept
volume is a necessary part of the account and demonstrably not the whole of it:
at the deepest sampled point the trunk sphere's own centre is inside the box, so
the rules as specified predict a contact and a depenetration that the original
does not appear to deliver. The stored bounds were the obvious suspect and have
been eliminated — the disc's own box for that instance is the fat axis-aligned
one, to two millimetres. What remains is that the ridden line is not the sampled
curve and misses the few remaining centimetres, or that the grind's limb mask
excludes the instance by a route not yet traced. [open] [[370-probe-worked-open]]()

> [[370-probe-volume]]() db:collision; map:"Rider collision volume (sphere
> set) and the per-state limb mask" — `cCollisionSphereSet` at boarder+0x470:
> body sphere centre +0x10 /
> radius +0x20, limb mask +0x24, limb count +0x28 (18), limb *i* centre
> +0x30+0x20·i / radius +0x40+0x20·i. Ctor @0x00236570 writes mask −1, count
> 18, zeroes 576 B, then radii in world units (100 = 1 m) 25, 20, 15, 15, 15,
> 15, 10, 10, 25, 25, 20, 20, 30, 30, 20, 20, 20, 20, and body radius =
> `arg × 100` read from boarder+0x464 → +0x60 (@0x00116c2c). **Measured live at
> 0.85 m**: `*(float*)(*(u32*)(boarder+0x464) + 0x60)` = 0.850000024, and the
> stored world-unit radius at set+0x20 = 85.0 exactly, two independent reads of
> a paused PAL session (registry 0x00338E58 → +0x730 world → +0xA4 boarder,
> +0x41C == 1). Per-tick re-pose @0x002366d0 (from @0x00126750): the addresses
> `*(set+0x00)` + 0x0b0/0x130/0x1b0/0x2b0/0x1f0/0x2f0/0x230/0x330/0x370/0x430/
> 0x3b0/0x470/0x3f0/0x4b0 are the **translation rows themselves**, so with a
> 0x40 matrix stride and the row at matrix+0x30 the joint indices are 2, 4, 6,
> 10, 7, 11, 8, 12, 13, 16, 14, 17, 15, 18 — two joints above the pelvis, then
> the 6-7-8 / 10-11-12 arm chains and the 13-14-15 / 16-17-18 leg chains, which
> the radii corroborate (hand 10, foot 30). Body centre = midpoint(limb 8, limb
> 9) @0x002367d4, measured live as exactly 10.0 units from each of the hip pair.
> Limbs 14–17 are **two spheres per foot along the board axis at 26.51 and
> 51.51 units** (25.00 apart, exactly symmetric between the feet) — not one pair
> at ±70 as first written. The joint array pointer is installed by @0x00236648.
> **Per character:** the record at boarder+0x464 is row 0 of
> `g_riderTable` `0x0032ed6c` (`{count; 6 × 132-byte rows}` inside the front-end
> session singleton `0x0032c590+0x27dc`; row 0 = `0x0032ed70`, hence no
> immediate for the row itself — 47 sites build the header). Row `+0x60` is
> written only from `CharacterDefTable` `0x003330a8` (12 × 56 B) field `+0x24`
> (`lwc1/swc1` at `0x0016aaa8/0x0016aab0` in `RiderRow_InitHuman` `0x0016a9f0`,
> `0x0016af44/0x0016af4c` in `RiderRow_InitAI` `0x0016ae80`,
> `0x00266838/0x00266840` in the re-apply `0x00266748`). On-disc metres vary by
> character index within 0.70–1.00; the measured session's rider reads 0.85. Cheat override
> `0x0016abe4..0x0016abf8` (0.8) gated by `0x003364b8` and `GameModeGlobal != 6`.
> Two getters derive offsets from the same value: `0x0011e9e0` (75 − 100·r) and
> `0x0011ea08` (90·(r − 1)). map:"Rider table, character definitions and the
> rider row".

> [[370-probe-mask]]() db:collision; map:"Rider collision volume (sphere set)
> and the per-state limb mask" — mask read at @0x00236d88: zero → body-sphere
> box, nonzero → union over `(mask >> i) & 1` limbs (@0x00236e04, the query
> AABB the broad-phase rejects on, @0x0025bf24/@0x0025c010 against query
> +0x10 max / +0x20 min). Writers, each restoring the all-ones default: rail
> @0x0010c008 = 3; ground contact/carve @0x0010c7e0 and surface-material
> contact @0x00110734 = `*0x0031E510` = 0x0FC3; ground board update
> @0x0010aa30 = `*0x0031E500` = 3 (around @0x00126258); air world query
> @0x00108a1c = 0xCF. The air *object* pass @0x001089f8 precedes every write
> in that function, so it runs at the restored default. Both globals sit at
> the head of `.data`, not `.bss`; an exhaustive `.text` scan finds readers
> only.

> [[370-probe-modes]]() db:collision; map:"Prop collision SHAPE by
> `CollsionMode`" — the mode split @0x0025c4c8 dispatches through the *query
> object's* vtable, so the shape is the query's, not the mode's. Sphere-set
> query vtable 0x003a8a48 (installed by ctor @0x00257d40 from the sphere set):
> +0x2c @0x00257eb8 → swept/static triangle (@0x002379a0 when query+0x2f0 is
> set, which @0x001250ec does), +0x3c @0x00258028 → @0x002399c8 sphere tree
> (body-sphere gate @0x00239a3c then every limb @0x00239a70, mask **not**
> read), +0x44 @0x002580d8 → @0x00238b60 box. The line-query sibling vtable
> 0x003a8d18 is what the earlier `WorldLine_IntersectAABBSlab` @0x0025e178 /
> `WorldLine_InitSegmentQuery` @0x0025dd20 trace describes in
> doc:../research/prop-collision-semantics.md §5, whose mode-3 slot @0x0025e170
> cannot hit a body at all. In @0x00238b60 the masked loop @0x00238c10 reloads
> the body centre (set+0x10) and body radius (set+0x20) on every iteration and
> never advances to the limb it selected.

> [[370-sphere-box]]() db:collision; @0x0023bc08 — three unrolled axis blocks,
> each gated on the centre lying within the other two slabs
> (`c.ole` pairs, no radius), then `(centre − min) + r ≥ 0` and
> `(max − centre) + r ≥ 0`; keeps the minimum of the six as the depth
> (accumulator seeded 1e30 at the out-pointer), writes ±unit axis to the normal
> out-pointer and the centre with that one component replaced by the face plane
> to the point out-pointer.

> [[370-probe-worked]]() db:collision; ALOHA instance 1170 `Mdl_Jumbotron_Top_1003`
> (`CollsionMode` 2, `PlayerCollision` true, U0 1e30, bounce 0.03) vs
> `Spline_RailMetalShowOff_1001`. Raw level space is Z-up. Model 113 is
> `Meshes/118.obj`, 28 verts at a constant local Y — a zero-thickness rectangle
> ≈14.6 m wide × 7.58 m high, yawed −31° about Z by the instance. Its world AABB
> min (−8853.5, 1918.0, 52863.6) / max (−7599.4, 2673.2, 53621.7) is therefore
> 12.54 × 7.55 in plan around a 14.6 m LINE, and its most protruding corners
> stand ≈6.5 m off the panel. Sampling the cubic at 400 points per segment puts
> a maximum of 3.5 cm of the spline inside that box over 0.14 m of arc, at the
> bottom `+x/+y/−z` vertex (per-axis clearances 3.5 / 4.1 / 4.8 cm). The
> sibling mode-1 proxy does not intervene: `Collision/35.obj` on instance 1169
> (`Mdl_Jumbotron_Bottom_1003`, 108 tris, vertex-identical to `Meshes/117.obj`
> to 1.6 mm) is an open-fronted cabinet on a pole whose bounds enclose the box
> but whose shell does not, and the spline clears it by 2.17 m. The rail tube
> itself, instance 1176 `Mdl_ShowRailGeom1009_1`, is `CollsionMode` 0 with
> `PlayerCollision` false, as `350-rails.md` `[[350-tubeprops]]` predicts for
> this level family. Instance→properties join independently re-decoded from the
> raw SSF: 298 records × 24 B tile the section exactly, `InstanceState` is
> in-range and fully covering, mode-1 shape indices are contiguous 0…240 against
> `CollisonModelCount` 241 and mode-3 0…6 against `PhysicsCount` 7, mode-0/2
> records all carry −1, and bounce 0.03 occurs on exactly one record shared by
> all 12 jumbotron screens — so `CollsionMode` 2 here is the disc's own value,
> not a decode artefact.

> [[370-probe-worked-open]]() db:collision; measured against
> `Slopesmith/src/core/collision/native-box.ts`: mapping the deepest sample and
> the box into editor metres (`RAW_TO_EDITOR`, editor Y = raw Z / 100) and
> raising the trunk sphere by the rail seat plus its authored height leaves its
> centre inside the box on all three axes, so `sphereVsNativeBox` reports
> contact at depth 0.485 m with an `−x` normal. The stored-bounds candidate is
> **eliminated by direct read** — see `[[230-instance-table]]`, ALOHA instance
> 1170's PBD box agrees with the transformed-model AABB to 0.2 units. The
> surviving candidates are the seated rail line differing from the sampled
> spline by more than the 3.5 cm plan-view margin, and the rail limb mask
> `[[370-probe-mask]]` reaching further than the broad-phase gate it is traced
> to. Neither tested; live probing is blocked while PINE is disabled.

## Sliding on world and ride surfaces

Terrain and admitted ride surfaces feed point, normal, and surface type into
the ordinary contact-basis update: cancel motion into the contact and keep
tangent motion. A **rideable** response-enabled prop (one with a real surface
type) is ridden through the same ground model (`310`–`330`). This does not make
`PlayerBounce=false` a slide selector: live mode-1 and mode-2 flag-off controls
both preserved contact dispatch but suppressed physical response. [[370-slide]]()

> [[370-slide]]() db:collision — mode-1 proxy hits route through the
> generic triangle-list intersection into the shared world-hit result
> (surface type at result+0x34) consumed by @0x00128af0;
> db:rideable-props.

## Bouncing off flagged solids

An instance flagged for player-bounce first **pushes the rider back out**: the
contact's reported penetration, scaled by a tenth again, is added to the
rider's position along the contact normal before anything touches velocity. So
a solid prop resolves as depenetration plus rebound, not rebound alone — which
is why a shallow contact still moves a rider who has stopped against one.
[[370-depenetrate]]()

It then applies a **rebound impulse**
scaled by its authored restitution magnitude (the four-tier table is
specified in `130-collision-data.md`) and by the impact speed. The bounce is
directional contact response plus state side effects — a hard enough body
hit is one of the wipeout triggers (`300-rider-states.md`), so fences kick
you back on course while a jumbotron screen nearly stops you. If `s` is the
incoming normal speed and `b` the authored restitution, the outgoing normal
speed is `max(b·s, 55.556 cm/s)`; tangential velocity is unchanged. The
constant is a universal 2 km/h minimum eject, so even a slow hit on a 0.03
surface pushes the rider away. The total normal velocity delta is
`J = max(s·(1+b), s+55.556)`. The native hard-impact branch enters wipeout
when `J > 1944.444 + 833.333·dot(u,n)`, where `u` is the board-up orientation
row and `n` the outward contact normal. Higher restitution can therefore make
a fall more likely, but speed and orientation matter too. A live six-case trace
crossed the threshold only at `b=0.6`; a slower `b=1.0` hit remained just below
it. A repeat probe counted that bounce caller once and the separate
SurfaceType-6/10 wipeout caller zero times. [[370-bounce]]()

> [[370-depenetrate]]() db:prop-bounce; `Boarder_ObjectPlayerBounceResponseCandidate`
> @0x00125a08 — the immovable branch (`a1 == 0` at @0x00125acc) scales the
> incoming depth argument `f24` by 1.1 (`0x3f8ccccd` @0x00125af0), scales the
> contact normal by it through @0x00102f50, and adds the result into
> boarder+0x140 with `sdc2` @0x00125b18, all before the restitution terms at
> @0x00125b28. The properties record is re-read at the same site
> (`entity+0xec` → U0 at +0x00, `PlayerBounceAmmount` at +0x04, @0x00125a50).
> The nearest-world pass @0x00126258 writes the same pair of fields
> (@0x001263c8 position, @0x00126458 velocity). Consequence for a live probe:
> the noclip patch (`440-noclip-fly-mode.md`) overwrites velocity every tick
> but not position, so prop depenetration survives it and contact remains
> observable under noclip even though the rebound does not.

> [[370-bounce]]() db:prop-bounce —
> `Boarder_ObjectPlayerBounceResponseCandidate` @0x00125a08 reads the
> property float at +0x04; normal response is restitution plus the 55.556 cm/s
> floor; helper @0x00126548 performs the orientation-adjusted hard-impact
> comparison and calls `Boarder_EnterWipeOut` @0x0011d838; flag gate
> entity+0xe8 bit 0x80; tier counts
> doc:../research/extracted-data.md "Prop bounce"; bump/crash side effects
> via @0x00124928 remain a distinct body-contact path (db:crash-bag,
> map:"Boarder/body bump and prop-bounce paths").

## Pass-through contacts

A pass-through instance still needs a native contact shape and
`PlayerCollision=true`; `U0=0` changes the **response**, not contact eligibility.
Crossing the shape therefore produces no wall, slide, bounce, or rigid-body
impulse, but the contact result can dispatch the instance's collision-effect
graph and collision sound. This is the shared state used by hidden triggers,
reset zones, boost/pickup volumes, breakables, and foliage swish proxies.
The observed mode-1 and mode-2 `PlayerBounce=false` controls also take this
contact-only state even when response mass is nonzero.
`Visable` only controls whether the host is drawn. [[370-pass-through]]()

> [[370-pass-through]]() db:collision; `130-collision-data.md`
> `[[130-contact-state]]` / `[[130-movability]]`; collision graph entry and
> live-node re-fire gate `150-logic.md` `[[150-dispatch-runtime]]`; foliage
> sound consumer `420-audio-runtime.md`.

## Shoving live dynamic props

A prop whose collision effect has activated a **live rigid body** can resolve
through the rigid-body impulse instead of the ordinary response path:
[[370-impulse]]()

```text
impulse = 1.3 · closingSpeed
        / (propInverseMass + riderMassTerm + rotationalEffectiveMass)
```

applied along the solved contact normal at the contact offset — the prop
picks up both velocity and angular velocity. Neither the prop's restitution
magnitude nor its instance response U0 is read on this path. Scalar inverse
mass comes from the activating Roller payload; shape and inverse inertia come
from the referenced physics-body data (`130-collision-data.md`). There is no
hard-coded upward kick: loft comes from the contact geometry.
[[370-impulse-vals]]()

The shoved body then simulates as a simple dynamic body: gravity of
9.8 m/s², integration at the fixed tick, contact probes against the world
with its own solver coefficients, an activity accumulator that decays each
tick (≈ ×0.95) and puts the body to sleep below a threshold — knocked props
settle and stop rather than jittering forever. [[370-bodysim]]()

> [[370-impulse]]() db:crash-bag — body branch of @0x00125090
> (contact+0x14 == 0): numerator 1.3·closing (@0x00125570/0x00125598),
> denominator body+0x08 inverse mass + rider term + rotational term
> (@0x001256d0..f0); write-back
> `PhysicsBody_ApplyImpulseAndUpdateVelocityCandidate` @0x00154350 (velocity
> +0x50, torque +0x60). Activation/mass provenance and the negative writer
> sweep are in doc:../research/prop-collision-semantics.md "Mode-3 inverse
> mass".

> [[370-impulse-vals]]() db:crash-bag — no PlayerBounceAmmount or instance
> U0 read in the body branch; no vertical bias in the impulse direction.

> [[370-bodysim]]() db:physics-body —
> `PhysicsBody_UpdateAndSettleCandidate` @0x0013e8b0: gravity −980/body+0x08
> (@0x0013eb80), integration dt 1/60, energy decay 0.95 (@0x0013e998),
> sleep threshold 10000.0, terrain contact @0x0013edb0.

## Scripted knock-off (the Roller effect)

A prop doesn't only move when the rider hits it directly — an effect chain can
knock a piece off **on script**. The **Roller** node (`230-level-ssf.md`,
`MainType-0`/`SubType-0`) makes its target instance a short-lived **dynamic
rigid body** and launches it, then hands it to the **same moved-body
simulation** as a shoved crash bag (gravity 9.8 m/s², `dt = 1/60`, terrain
bounce, activity decay to sleep). The target moves **in place** — it is not
copied or hidden, and it stays visible and collidable; it ends by **settling
and sleeping** (there is no duration/reset field). Its **mass** is the node's
first field; the **launch direction** is the node's last three fields — all
zero means "launch along the instance's own transform", otherwise it launches
along that authored vector. Launch speed on the default (all-zero) path scales
**inversely with mass**; on the authored-direction path it is a fixed impulse.
[[370-roller]]()

The canonical use is a **fire hydrant**: hitting the base runs a collision
effect that plays a Roller on the hydrant's *top-lid* instance, so the lid
**pops off and tumbles away** (the base's effect also fires the water spray and
a debounce). [[370-roller-vals]]()

> [[370-roller]]() db:roller — ctor
> `RollerNode_ConstructFromEffectPayload` @0x0013d6c8 (class `cRollerNode`,
> 848-byte body node, embedded `PhysicsBody` at `node+0x30`); Update slot
> (vtable `0x0036e990` `+0x14`) is `PhysicsBody_UpdateAndSettleCandidate`
> @0x0013e8b0 — the same `[[370-bodysim]]()` path. Launch: all-zero direction
> → `RollerNode_LaunchAlongInstanceTransform` @0x0013dd48
> (`clamp(5000/mass + 100, ≤600)` u/s), else
> `RollerNode_LaunchAlongAuthoredDirection` @0x0013dbf0 (normalized authored
> vector, mass-independent). Ctor flips the target flags `entity+0xe8` (set
> 0x1|0x4|0x40, clear 0x2|0x20). Fields U1/U2 are authored but read by no
> traced runtime path (`230-level-ssf.md` `[[230-roller]]()`).

> [[370-roller-vals]]() db:roller — MERQUER `SSFLogic.json`:
> `FireHyDrant_Base` (`EffectSlotIndex 275`) → `CollisionEffectSlot 675`
> = { Debounce 7 s ; water-spray emitter ; `MainType-7` hop → the `TopLid`
> instance, `EffectIndex 676` } → one Roller
> `(mass 6, _, _, dir 0/1000/0)` — direction up. Roller census: MERQUER 448,
> GARI 3, MESA 7.

## Riding through hollow structures

Gateway structures — arches, scaffolds, finish banners — have no special
runtime rule: their occupancy-tree bodies are **hollow by shape**
(`130-collision-data.md`), so the contact test only ever finds the posts and
lintel, and the rider passes through the opening. There is no ride-through
flag to honor; faithful traversal falls out of using the authored body
shape. [[370-hollow]]()

> [[370-hollow]]() db:rideable-props; map:"Mode-3 sphere-tree payload
> layout" — sphere-tree traversal @0x0023ac48 descends occupied octants only.

## Breakables

A breakable is a **pass-through instance wired to a scripted break chain**,
not a physics shatter: the intact prop has response mass 0 (no hard stop — you
ride through it), the player-collision flag set, and a collision effect slot
whose chain (`150-logic.md`) performs the break. Five authored variants
exist: [[370-breakables]]()

- **Mesh swap** (fences, hole covers, screens): the chain **hides** the
  intact mesh and **reveals** a pre-authored broken twin shipped as a real,
  initially invisible instance at the same spot (`120-objects.md`) —
  sometimes also hiding auxiliary meshes (a screen's scanline overlay).
- **Self-destruct** (snappable tree branches): the chain simply hides the
  source; there is no twin.
  <br>**The hide is bounded by the node, not permanent.** An authored
  sub-5/mode-4 kill was ridden on a custom prop with the instance's flag word and
  the live-node slot traced against each other: the draw bit leaves the drawn
  state on the same sample the node appears in the effect slot, and returns on
  the same sample the node disappears — identical timestamps, three passes of
  three. A lasting mark is left at teardown, bit **0x0100** clearing and staying
  clear, whose meaning is not recovered. So keeping a prop hidden past the node's
  own end is a job for the latch columns (`150-logic.md` §slot-columns) rather
  than for the kill alone; that pairing is untested. [measured]
  [[370-kill-live]]()
- **Function-driven** (the jumbotron screens): the chain runs a named
  per-instance break function that performs the hide/reveal set, one function
  per screen, so each breaks independently.
- **Trigger-driven**: the intact prop is a **solid** wall (nonzero response mass,
  player-bounce) carrying an **empty** collision effect, and a **separate
  invisible pass-through trigger volume** (response mass 0, player-collision set)
  sits at it carrying the break chain, which **acts on** the wall — hiding it
  (a `main type 7` kill sub-effect) and revealing-and-throwing its broken twin
  (`main type 7` → a sub-20 mesh-throw). Unlike the other three, the
  effect-carrying instance is not the visible source: the trigger drives the
  break of a neighbour. A scripted-event trigger (a fireworks or
  falling-scenery cinematic) looks similar — an invisible pass-through volume
  that hides visible props and reveals hidden ones — so the discriminator is
  the **sub-20 mesh-throw of the hidden twin**: a break shatters authored
  geometry, an event only starts animations and fires emitters.
- **Crack-then-shatter** (glass panes): the collision chain does not break
  anything. It installs a **crack** handler on the pane and plays a crack
  sound; the break itself is the slot's **deferred-trigger** chain
  (`150-logic.md`), which the crack handler fires when the pane gives way.
  That chain plays a shatter sound, kills the intact pane, and reveals *two*
  hidden twins rather than one — a broken glass **surface** plus a separate
  **debris** mesh, thrown by a sub-20 mesh-throw. Observed in game: the pane
  stays **solid and rideable while cracked**, and the break opens a hole the
  rider **falls through** — so neither revealed twin restores a floor.
  The discriminator against every other variant is that the collision chain
  contains no kill and no reveal at all: reading it alone, the prop looks
  inert. What can defer the shatter is **accumulated damage**: the handler
  carries a *strength* pool (the pane's authored `U1`) and subtracts the force
  of each contact from it, giving way when the pool crosses zero. Contacts are
  rate-limited by a 30-frame gate, and a CARRIED rider reaches that ceiling
  continuously: measured hit spacing on a panel laid in the slope is a flat
  **0.5 s**, exactly 30 frames at 60 Hz. A rider who merely crosses a volume
  strikes it far less often — the spacing there was nearer 1.8 s, which is the
  traversal and not the gate. A surface whose pool has gone negative
  refuses every later contact, so the give-way happens once.
  **In game the deferral is the observed behaviour**: riding onto a pane cracks
  it, the rider keeps riding on it in that cracked state, and it gives way a
  few seconds later — at which point the rider falls through. That is the two
  stages being temporal, and it is what the strength pool and the 30-frame gate
  are for: a supported rider accrues damage in small increments, one per gate
  period, until the 5 is spent.

  **The cracked APPEARANCE is a material flipbook, painted by the handler.**
  No pane carries a texture-flip *node* in any column or either reveal — the 20
  chains emit sound 65 (crack) and sound 64 (shatter) and nothing else — but
  the art is authored all the same, one level down: MEGAPLE material 43 carries
  a two-entry `TextureFlipbook` of `0050.png` (plain glass) and `0069.png`
  (glass with the crack pattern through it). Every `Mdl_Glass_Pane_*` and every
  `Mdl_Glass_Surface_*` uses that one material, so the pane and the twin it
  reveals crack from the same two frames. The graph never selects between them;
  the crack handler paints frame 1 when the surface cracks, which is why a
  search of the effect chains alone finds nothing and concludes wrongly.
  [measured]

  The per-contact cost while genuinely *riding on* a surface is of order 1,
  read live off retail panes mid-drain — see below. [measured]
  The handler's other word is the crack's own **lifetime** in seconds: when it
  expires the node retires and takes the accumulated damage with it, so the
  surface heals — which is why every authored pane sets it to `−1` and never
  expires. [measured] [[370-cracked]]()

  **What a hit costs is a near-constant, and it is the number an author needs.**
  Measured contacts cost **80–88** of strength: an 80 m box the rider flies
  through, a flat panel ridden over, and a **solid** host whose collision
  response actually stopped the rider (87.55 per hit, entry speed 24 m/s
  against the pass-through cells' 22–24, leaving at 17). Nine passes, three
  shapes, two points of the course. So the cost is not the approach angle, not
  the rider's speed, and not the collision response — the node's two-vector
  reduction is being handed near-identical numbers every time, and
  `responseMass` is ruled out as the explanation. Within a single course
  layout the figure is byte-identical across passes; it shifts a few units
  between layouts (87.55 against 80.4–83.2 for the same cell after neighbouring
  cells moved), so it is *nearly* a constant rather than exactly one.

  **That 80–88 is the cost of a CROSSING, and a pane is not crossed — it is
  ridden on.** Every cell above put the rider *through* the host: four
  pass-through volumes and pads the rider passes into, plus one solid gate the
  rider punched through at 24 m/s and left at 17. None of them is what a
  Megaplex pane is, which is a solid floor a rider is supported by for
  seconds. In game the pane cracks on arrival and breaks a few seconds later,
  so the cost of a *supported* contact must be small enough that retail's
  authored `5` takes several gate periods to spend — of the order of 1 per hit
  rather than 87. That number is the one an author needs and it is still
  unmeasured. Two attempts to stage it failed, both because a prop panel is an
  obstacle to the physics rather than ground: a scale-8 pad (960 × 60 m,
  lifted 0.3 m) launched the rider and orphaned every cell below it, and a
  120 × 64 m solid pad lifted 0.05 m stopped the rider dead — yet still cost
  **87.6** on the contact that installed the node, with the rider down at
  2.8–3.3 m/s. So the cost does not scale with approach speed either.

  A third attempt copied MEGAPLE property 120 exactly — mode 1, response mass
  0, `BitFlags` 4129, so **PlayerBounce clear** where every earlier cell had it
  set — on a flush 64 m panel. That profile is the one that behaves: the rider
  crossed at a full 24.3 m/s, neither launched nor stopped. It still did not
  reproduce the deferral. Retail's `5` went to **−82.62** on the first contact,
  and a strength-1000 twin beside it took exactly **one** hit of 87.55 in the
  2.7 s traversal, its next not until a later pass. So the cost is not the
  profile and the deferral is not a matter of hit frequency either.

  **A hit costs what the contact is worth, and that varies by two orders of
  magnitude.** Read live off retail MEGAPLE, three panes the player had ridden
  held crack nodes at **5.0000**, **3.8750** and **2.0165** — a pool mid-drain
  in steps of order 1. Reproduced on the bench once a panel was laid *in* the
  slope rather than across it: a strength-1000 cell took **ten or more** hits
  in a single traversal costing anywhere from **0.687 to 96.2**, where every
  earlier staging booked exactly one hit of 87.55. The apparent constancy was
  the geometry, not the node — a horizontal panel on a fall-line course is a
  ledge the rider strikes once.

  The gate is exact: those hits land **0.5 s apart** (27.45, 27.92, 28.43,
  28.90, 29.43, 29.90, 30.43, 30.93, 31.45, 31.92 s), which is the 30-frame
  gate at 60 Hz and a ceiling the rider reaches continuously while carried.
  So retail's authored `5`, drained by contacts worth about 1 at two per
  second, is the ~3 s a pane stays cracked; and dropping onto one from a height
  spends it in a single hit because that contact is worth what the bench's
  crossings were worth. [measured] [[370-cracked]]()

  **Separately, the debris flies for two seconds.** Every one of the 20 panes
  reveals a `Mdl_Glass_JunkA` twin through a sub-20 **mesh-throw authored at a
  2.0 s duration** (frame step `0.05` s, so 20 steps; per-axis velocity
  800/800/900 cm/s along the collision direction), byte-identical across all
  20. This is the shatter playing out, *after* the pane gives way — not the
  interval between the crack and the break. [measured] [[370-cracked]]()

A source's "hide" is not always an instant disappearance: a break chain may
route it through a **procedural mesh-throw** (`120-objects.md`'s animated
ModelObjects, `230-level-ssf.md` type 0 sub 20) instead of an immediate cut.
The throw animates the source's own render pieces flying apart over an
authored duration, each piece taking a per-axis velocity (authored in cm/s;
an all-zero authored direction falls back to the actual collision
direction) scaled by a direction multiplier, stepped at an authored frame
rate. The Mesa cave hole-cover and the burning tree branches use this path;
the LCD jumbotron's instant hide/reveal swap (above) does not.
[[370-throw]]()

A break chain may **additionally fire particle emitters**. Some self-destruct
breakables *also* spray a one-shot **coloured star** burst: the collision chain
pairs the hide-source kill with two timer-type emitter nodes (main type 2 /
sub-type 0, `180-particles-data.md`) whose colour-ramp first stop is authored
**per instance** (e.g. balloon-animal props whose shapes burst green, blue, and
tan). This is the only breakable family observed to emit;
it is the regular effect-graph emitter fired one-shot from the collision slot,
**not** the dedicated collision emitter below. [[370-balloon]]()

The break **sound** and any rebound on the same contact are the separate
collision-response paths above — the break itself is purely the effect
chain. Not every instance with a collision effect is a breakable (boost
pads, texture-flip signs, and triggers use the same slot machinery); the
discriminating shape is a chain that **kills the visible source**.
[[370-break-chain]]()

> [[370-kill-live]]() Live evidence: `Trailmap/tools/autotest`, runs
> 20260806-100330, -100532 and -100734 (cell `breakable-kill-hides`). The chain
> is a debounce, a particle marker and the kill, with no flip anywhere to move
> the same word. `entity+0xe8` traced 0x00a101a3 -> 0x00a10105 -> 0x00a100a3
> against `entity+0xe4` tracing 0 -> node -> 0, transition for transition at
> 7.109/15.703, 6.906/15.422 and 6.907/15.516 s. The set of values alone cannot
> distinguish this from a kill that never applied, which is why the ordered
> trace exists.

> [[370-breakables]]() db:sign-break — Mesa general system: mesh-swap =
> hide-source (type 0 sub 5 with dead-node mode 4, or sub 20) + main-type-7
> reveal of an invisible `_Junk` twin (fences slot 63 → junk inst 698, hole
> covers 35); self-destruct = single sub-20 hide on self (TreeBurnBranch slot
> 86, EH[170]); GARI jumbotron = main-type-21 run-function → `BreakLogo*`
> (map:"BreakLogo"). Trigger-driven = the MERQUER sewer brick walls: a solid
> wall with an empty collision chain + a separate invisible pass-through
> trigger whose chain hides the wall (main-type-7) and reveals-and-throws its
> broken twin (main-type-7 → sub-20 mesh-throw); the discriminator vs a
> scripted event is the hidden twin's sub-20 mesh-throw.
> Two-stage = the MEGAPLE `Mdl_Glass_Pane_*` panes, the only authored
> instances of Cracked (type-0 sub 14) in the whole retail corpus: 20 panes on
> slots 164–183, collision = Cracked (`U0`=−1, `U1`=5, identical on all 20) +
> crack sound, column 5 = shatter sound + sub-5/dead-mode-2 self-kill +
> main-type-7 reveals of the pane's own `Mdl_Glass_Surface_*` and
> `Mdl_Glass_JunkA_*` twins (14 panes reveal two, 6 reveal three). Chain
> shapes are uniform across all 20. The column-5 mechanism and the corpus
> counts are in `150-logic.md`;
> doc:../research/effects-semantic-names.md carries the census derivation.

> [[370-cracked]]() Field roles, the damage arithmetic and the 30-frame gate
> are `230-level-ssf.md` [[230-cracked]](); the fire path into the slot's
> trigger column is `150-logic.md` [[150-deferred-trigger]](). Live evidence:
> `Trailmap/tools/autotest`, runs 20260807-075619, -075854 and -080130, cells
> `cracked-tough` / `cracked-shatters` / `cracked-heals` / `cracked-retail`,
> byte-identical across all three; then runs -081545, -081921 and -082206
> adding `cracked-pad` (retail's payload on a flat panel, its companion
> holding a hopped node 3/3) and `cracked-solid` (`responseMass` 1e30, a host
> that really stopped the rider: 1000 → 912.45 → 824.90, hits of 87.55, and
> its strength-1000 pool correctly never fired). An authored strength of 1000 stepped
> 912.43 → 824.88 → 737.30 → 649.75 (four hits of 87.55; 1000 less the first
> hit is the 912.43 the node is first seen holding), while 0.1 went to −87.60
> on its first hit and never moved again. An authored lifetime of 2 s counted
> `node+0x34` from 119 down at 60 Hz, released the instance 1.98 s after
> taking it, and its replacement restarted at full strength — the heal — where
> the `−1` cells read a flat −60 and never released. The corpus check that
> squares with a hit costing far more than retail authors: all 20 MEGAPLE
> column-5 chains are shatter sound + tombstone kill + two or three reveals,
> with **no wait node anywhere** — nothing in the data defers the shatter,
> because at a cost of 80–88 against an authored 5 the pool is gone on the
> first contact and the trigger column resolves immediately. The same census
> locates the visible delay: every one of the 20 hops a sub-20 mesh-throw onto
> its `Mdl_Glass_JunkA` twin at `U1` = 0.05 s frame step and **`U2` = 2.0 s
> duration** (`230-level-ssf.md` sub-20 layout), velocities 800/800/900 cm/s,
> authored direction all-zero so the throw follows the collision. Twenty of
> twenty identical in crack payload (`-1`/`5`), wait count (zero) and throw
> tuning; slots 164-183, read from
> `temp/p1-effects/corpus/MEGAPLE.semantic.effects.json` (repo root). Worked
> example: slot 164 = collision `graph:0506` (crack + sound 65), trigger
> `graph:0508` (sound 64, tombstone, hops to instances 225 and 227), whose
> `graph:0510` carries the throw. The twins ship INVISIBLE and the
> main-type-7 hops are what reveal them: instance 225 (`property:0119`,
> `BitFlags` 4256 — visible clear, player collision set, response mass 1e30)
> and 227 (`property:0118`, `BitFlags` 4096, no collision at all). The pane
> itself is `property:0120`, `BitFlags` 4129 — visible + player collision with
> **PlayerBounce clear** and response mass 0, which is the profile that lets a
> rider be carried without being shoved. Note the chain contains no
> `DeadNodeMode 4`, so nothing in the effect graph hides the intact pane; the
> hide comes from the handler. So does the crack's APPEARANCE, though its art
> is authored: `Maps/MEGAPLE/Materials.json` material 43 — shared by every
> `Mdl_Glass_Pane_*` and every `Mdl_Glass_Surface_*` — carries
> `TextureFlipbook: ["0050.png", "0069.png"]`, plain glass and cracked glass,
> while `Flip.json` lists only materials 34 and 78. So the pane's two frames
> are never PLAYED as an animation, only selected.
>
> Live drain, read read-only off a paused retail session (PINE, heap sweep for
> the `-60` lifetime sentinel at `node+0x34`, owner confirmed by an entity
> whose `+0xC0` model points into the heap and whose flags high half is the
> property's 4129): three ridden panes at entities `0x01144050`, `0x01143450`
> and `0x01136850` held strengths **5.0000 / 3.8750 / 2.0165**, gate word 0.
> A pool caught mid-drain in steps of order 1 is the whole two-stage break.
> The authoring consequence is that the collision chain
> and the break are **two chains on one slot**, and a Cracked surface whose
> trigger column is empty cracks and then stands:
> `Slopesmith/src/core/effects/authoring.ts` template `cracked`.

> [[370-break-chain]]() db:sign-break — classifier discriminators:
> visible source + source-hide kill + invisible reveal target; counter-cases
> directional sign (TextureFlip), warning sign (knock physics), boost pads
> (sub 5 / dead mode 2); sound remaps separately (LCD 63→slot 64,
> branch snap 72).

> [[370-throw]]() map:"The mesh-throw break (`cMeshAnimNode`, MainType 20 /
> type0 Sub20)" — `cMeshAnim::Init` `0x001466c0` reads the Sub20 payload:
> `U1` frame step (s), `U2` duration (s, stored as `U2×60` frames), `U3-5`
> authored throw direction (all zero = use the actual collision direction),
> `U6-8` per-axis velocity scale (cm/s), `U9` direction scale; builds the
> per-piece pivot table from the model's render objects. Field layout:
> `230-level-ssf.md` type 0 sub 20 row.

> [[370-balloon]]() db:sign-break — Snowdream balloon animals: the
> collision chain is two main-type-2 sub-type-0 emitters + one main-type-0
> sub-type-5 dead-node mode 4. Per-instance burst colour in the emitter
> colour-ramp first stop (`U33..U36` serialized `A,R,G,B`,
> `180-particles-data.md` / `230-level-ssf.md`),
> star sprite from the shared bank; worked through in `150-logic.md`. The sub-2
> `CollideEmitter` (below) is a different mechanism; UNTRACK's snow trees are
> the one shipped use.

## Contact-triggered debris

The engine has a dedicated **collision-triggered particle emitter** class in
the effect system (same parameter footprint as the timer emitter —
`180-particles-data.md`): the collision response tries to spawn one (before
bounce and sound) for entities authored with one. GARI and most other courses
carry none, so their tree hits produce only sound plus bounce. UNTRACK is the
positive case: one slot shared by 34 `Mdl_Tree_SnowGhost_*` props emits the
authored `clod` snow burst. A reimplementation should therefore treat contact
debris as data-driven authoring, not a built-in. [[370-debris]]()

The dedicated emitter consumes the collision frame, not a fixed point on the
prop. On each hit it replaces payload U9..U11 with the exact contact point and
replaces U18..U20 with `outwardContactNormal * length(authored U18..U20)` before
using the ordinary P6 particle reader. Spawn spread, velocity variation
U21..U29, gravity, colour, and sprite stay authored. UNTRACK's base vector has
length 800 cm/s, so the snow launches directly away from whichever side of the
tree the rider struck. [[370-debris-frame]]()

This dedicated emitter (sub-type 2) is **distinct from** the balloon star
burst above: that one is a *timer-type* emitter (sub-type 0) placed in the
prop's collision **effect chain** and fired one-shot when the chain runs, not
this collision-response emitter. Both forms ship: balloons take the sub-0
effect-chain route, while UNTRACK's 34 snow trees share the one sub-2 graph.
[[370-debris-vs-burst]]()

> [[370-debris]]() db:bark-fx — effect main type 2 / sub 2; generic collision
> shell @0x0013b8c8 from @0x00125090, particle branch @0x0013d210 and real
> constructor @0x00148568; same U0..U50 payload as the timer emitter; GARI
> authors zero (107 type-2 effects, all sub 0), while
> UNTRACK effect 10 is `clod` snow and is bound to 34 SnowGhost trees;
> map:"Prop-collision debris particle (bark-fx investigation)".

> [[370-debris-frame]]() SubType-2 constructor @0x00148568 computes the
> U18..U20 magnitude, multiplies contact frame `+0x20`, and stores the result;
> @0x00148750 replaces scratch U9..U11/U18..U20 before common reader
> @0x001d8988. Object-collision query @0x00125090 supplies point at frame
> `+0x00` and outward normal at `+0x20`; map:"The collision shell and the SSF
> MainType 2 / SubType 2 particle".

> [[370-debris-vs-burst]]() db:sign-break — the shipped contact particles
> are the balloon star burst, authored as sub-0 emitter nodes inside the
> prop's `CollisionEffectSlot` chain (see the Breakables section above and
> `150-logic.md`), reached by the chain dispatcher — not the sub-2
> collision-response emitter used by UNTRACK's snow trees.

## Animated props

A prop animates by playing its model's authored clip (the piecewise-cubic
channel format of `120-objects.md`, on-disc in `220-level-pbd.md`) under an
effect node that loops,
ping-pongs, or randomizes phase/rate per instance. Where the rider must
collide with the moving surface, the level stacks a **visible animated mesh**
with an **invisible collidable twin** running the identical clip from the
same effect chain, so collision tracks the rendered motion in sync
(`130-collision-data.md`). Riding the moving surface is ordinary ground
contact on the twin's surface type. [[370-anim]]()

> [[370-anim]]() db:anim-object; db:bridge-sway (negative: no dedicated
> sway/flex code exists — the bridge is this generic mechanism) —
> `AnimObject` (type 0 sub 256) init
> @0x00198d08 (loop mode, window, rate, random phase), update @0x00199550;
> Mesa bridge: visible sway mesh + invisible collidable surface twin
> chained from one persistent effect, both clips identical;
> map:"World-prop model animation (`AnimObject`, type0 Sub256) — the swinging
> bridge".

## Collision sound

A prop hit plays the instance's authored collision sound as an
impact-scaled, debounced positional one-shot; the shaping and the
resolution of the authored sound id to a bank slot are both specified in
`420-audio-runtime.md`. [[370-sound]]()

> [[370-sound]]() db:audio — `PropCollisionSound_TriggerCandidate`
> @0x00217148: gate on the linked sound row (entity+0xf4); full shaping
> trace in 420-audio-runtime.md's `[[420-oneshot]]`.
