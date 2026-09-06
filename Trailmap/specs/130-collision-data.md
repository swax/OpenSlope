# 130 — Collision Data

Collision and physics-body data is factored out of the instance, behind the
shared object-properties record introduced in `120-objects.md`. An instance's
collision is fully determined by its properties record: a **collision mode**
that selects the collision shape, a **response-mass scalar**, a **player-bounce
magnitude**, a surface type, and — for the two modes that need geometry — a
reference into one of two shared pools (triangle-mesh **proxies** or physics
**bodies**). The visible render mesh is never used for collision. [[130-overview]]()

This chapter defines that collision data. The properties record and how an
instance joins to it are in `120-objects.md`; the on-disc encoding is in
`230-level-ssf.md`; the runtime collision *response* (bounce, knockback,
breakables, ride-through traversal) is in `370-world-interaction.md`; how a
rideable prop's surface type feeds the ride model is in `310-surface-response.md`;
terrain's own (analytic) collision surface is in `110-terrain.md`.

> [[130-overview]]() db:collision; the per-instance collision fields
> live on the properties record,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> `ObjectPropertiesStruct` (`U0` response mass, `PlayerBounce`, `CollsionMode`,
> `CollisonModelIndex`/`PhysicsIndex`, `SurfaceType`, `EffectSlotIndex`);
> instance→record join `ObjectProperties[InstanceState[i]]`,
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/TrickyLevelInterface.cs.

## Collision is a separate asset from the render mesh

Collision proxies are purpose-built, simplified shapes authored alongside the
art, **not** derived at runtime from the visible geometry. A proxy is typically
coarser than the mesh it stands in for (box-like trunks, flat fence planes); on
one example level the proxy pool totals fewer triangles than the full visible
geometry and more than its opaque-submesh skin. [[130-separation]]()

A pervasive consequence is the **visible/collidable twin** pattern already noted
in `120-objects.md`: a visible prop frequently carries *no* collision, paired
with an invisible, immovable twin at the same place that carries the proxy. For
an animated prop the twin runs a copy of the same animation clip so the
collision surface tracks the rendered motion (the swinging-bridge case). Proxy
winding is not consistent — some proxies are authored as inside-out shells —
so an implementation must not assume outward-facing faces. [[130-twin]]()

> [[130-separation]]() db:collision; proxy mesh record =
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> `CollisonModel` (`FaceCount`, `VerticeCount`, `Index`, `Vertices`,
> `FaceNormals`), pooled under `CollisonModelPointer`. GARI: ~412 unique
> proxy meshes, proxy ≈172k tris vs full visible ≈305k. The proxy is reached
> only when `CollsionMode == 1`.

> [[130-twin]]() db:anim-object (Mesa `Mdl_bridgesway` visible /
> `Mdl_bridgesurface` invisible+collidable twin, clip-synced); inverted-shell
> winding observed on `Mdl_Radiotower_PhantomBox`, db:collision.

## Collision mode

A collision query reaches only a small candidate set, not every instance: the
query point maps to its cell in the level's **world spatial grid** — the shared
broad-phase index that also serves terrain and rail queries and the per-frame
render gather (`160-lighting-data.md`) — and only the instances that cell lists
are carried into the per-instance narrowphase. [[130-broadphase]]()

The properties record carries a small-integer **collision mode** that selects
the collision shape mechanism and which reference (if any) the record uses: [[130-modes]]()

| Mode | Name | Shape | Required reference |
|---:|---|---|---|
| 0 | `None` | none | — |
| 1 | `TriangleProxy` | triangle-mesh proxy | valid proxy-pool index |
| 2 | `BoundingBox` | axis-aligned bounding box | none (uses the instance's stored AABB) |
| 3 | `PhysicsBodySpheres` | physics body (sphere occupancy tree) | valid body-pool / `PhysicsIndex` entry |

The proxy-pool and body-pool indices are mode-disambiguated, one shared
on-disc slot (`230-level-ssf.md`); modes 0 and 2 reference no shape record.
Example distribution (Garibaldi, by properties record as applied to
instances): mode 0 ≈ 295, mode 1 ≈ 2,599, mode 2 ≈ 349, mode 3 ≈ 150.
[measured] [[130-mode-counts]]()

### Contact eligibility and response state

The fields form a state machine; no one field is a synonym for “collides.” A
query can produce a contact only when `PlayerCollision` is set **and** the
selected mode has its required shape: mode 1 needs a real triangle proxy,
mode 2 uses the stored AABB, and mode 3 needs a valid physics body. Mode 0, a
missing mode-1 proxy, or a missing mode-3 body produces no contact. A successful
contact can then dispatch the instance's collision-effect graph and collision
sound. Those contact side effects run independently of response. Exactly
`U0 == 0` suppresses every solid response. `PlayerBounce=false` likewise
suppresses physical rider response while preserving eligible contact dispatch;
live nonzero mode-1 and mode-2 controls both emitted their marker and remained
ride-through.
`PlayerBounceAmmount` supplies restitution only when the flag admits the
bounce response. Neither response field creates a shape.
[[130-contact-state]]()

`Visable` is independent: it gates rendering, not collision. Retail hidden
reset and event volumes still contact through modes 1/2, while a visible mode-3
instance with no body still cannot contact. This distinction was confirmed by
the authored-trigger PCSX2 probe: the old custom instance selected mode 3 with
`PhysicsIndex = -1` and no proxy, so neither its collision graph nor sound/boost
contact ran. The same hidden host changed to mode 1 with a generated box proxy,
`PlayerCollision=true`, `U0=0`, and `PlayerBounce=false` fired its collision
particles and speed boost while remaining pass-through. [observed]
[[130-authored-trigger]]()

A mode-1 hit reports the same kind of result as a terrain hit (a point plus the
surface type), so a rider sliding onto a rideable proxy picks up that proxy's
surface type exactly as it would a terrain patch's (`120-objects.md`,
`310-surface-response.md`). [[130-mode1-result]]()

> [[130-broadphase]]() the per-instance shape tests below run only on the
> candidates returned by the world-grid broadphase (`WorldIntersect_QueryNearest`,
> via @0x00128bc8, over world singleton @0x00347688); grid data model =
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/LTGHandler.cs
> (`gari.ltg`), spec:160-grid. db:object-cull.

> [[130-modes]]() db:collision; map:"Prop collision SHAPE by
> `CollsionMode`" — `WorldEntity_IntersectLineQuery` narrowphase split by
> `CollsionMode`: 1 → `WorldTriangleList_IntersectLineCandidate` 0x0025d908
> (triangle proxy), 2 → `WorldLine_IntersectAABBSlab` 0x0025e178 (3-axis slab
> on the instance box), 3 → `PhysicsBody_SphereContactElementTest` 0x0023ac48;
> `CollsionMode`/`CollisonModelIndex`/`PhysicsIndex` =
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> `ObjectPropertiesStruct`.

> [[130-mode-counts]]() doc:../research/extracted-data.md "Instance
> placement census" / "Prop bounce"; counts read from GARI level data
> (`CollsionMode` per properties record).

> [[130-contact-state]]() db:collision; mode split and required references are
> `[[130-modes]]`; response split is `[[130-movability]]` and
> `[[130-bounce]]`; collision-effect construction after the contact-result
> entry point is `150-logic.md` `[[150-dispatch-runtime]]`.

> [[130-authored-trigger]]() live PCSX2/PINE isolation against the custom GARI
> export; probes doc:../tools/instrumentation/effect_dispatch_probe.py and
> doc:../tools/instrumentation/effect_invoke_probe.py. Direct graph invocation
> produced the expected particle/speed nodes, isolating the old failure to
> contact eligibility; the mode-1 proxy build then dispatched the same graph
> from rider overlap.

> [[130-mode1-result]]() db:rideable-props @0x00128af0 — the
> ground-contact query dispatches terrain and objects together and the nearest
> hit's surface type feeds the rider; mode-1 result carries `SurfaceType` at
> result+0x34, map:"Prop collision SHAPE by `CollsionMode`".

## Triangle-mesh proxies (mode 1)

A mode-1 proxy is an indexed triangle mesh: a face count, a vertex count, a flat
triangle index list (three indices per face), the vertex positions, and one
**precomputed face normal per triangle**. Proxies live in a shared pool and an
instance names one by index, so many instances reuse a proxy (every "plain solid
tree" can share one). The on-disc packing of this pool is in `230-level-ssf.md`.
[[130-proxy]]()

A proxy is not necessarily a *volume*. A recurring authored idiom is the
**zero-thickness proxy** — a bare open quad of two triangles, no shell and no
enclosed space — used both for the invisible trigger planes one would expect and
for ordinary **flat signage**, the latter carrying the same fully-solid
properties record as a chunky proxy beside it. On one example level nine of the
proxies are flat and they serve well over a hundred instances, two dozen of them
visible signs and billboards. A reimplementation that gives every mode-1 proxy
solid two-sided collision will therefore diverge on that whole family, and what
the original does with them is an open question. [measured] [[130-flat-proxy]]()

> [[130-flat-proxy]]() db:collision; ALOHA `Collision/137.obj` on instance 882
> `Mdl_Billboard_Ad_C_1001` — 4 verts, 2 tris, constant local Y, best-fit slab
> thickness 0.000 over all orientations, edge-use {1:4, 2:1}. Its placement and
> winding match the visible model (`124.obj`, max vertex delta 0.16 units) and
> its properties record (props[187]: mode 1, shape 137, flags 0x00A1, U0 1e30,
> bounce 0.5) is field-for-field identical to the solid jumbotron cabinet's
> (props[75], shape 35) apart from the shape index — so the proxy geometry is
> the entire difference. Level census: 9 of 241 proxies are zero-thickness,
> used by 157 instances — 134 `Mdl_ResetZone_Aloha` (flags 0x0020, U0 0) plus
> 23 signs/billboards at flags 0x00A1 / U0 1e30 (`Mdl_DirectionalSign_Red` ×10,
> `Mdl_Billboard_Ad_B` ×4, `Mdl_DirectionalSign_Green` ×4, `Mdl_Billboard_Ad_F`
> ×3, `Mdl_Billboard_Ad_C` ×1, `Mdl_ResetZone_1026` ×1). Open: whether the
> engine collides them at all — an in-game noclip pass reported flying straight
> through instance 882, which the specified rules do not permit.

> [[130-proxy]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> `CollisonModel` (`FaceCount`, `VerticeCount`, `VerticeOffsetAlign`, `Index`,
> `Vertices` W=1, `FaceNormals` one per face) within `CollisonModelPointer`
> (`Offset`/`ByteSize`/`Count`/`Models`); db:collision.

## Bounding-box collision (mode 2)

A mode-2 instance collides the rider against a **box tight to its own model,
oriented with the placement** — not against the instance's world axis-aligned
bounds. The box is the model's own local bounding box, held once per model
object and shared by every instance of that model; the query is carried into the
placement's local frame and tested there, so what the rider meets is an oriented
box that turns with the prop. It is the coarse, cheap option for props whose
silhouette a box approximates acceptably (tree trunks, pickups, flat billboards,
and the box-shaped trigger/boost pads). [[130-mode2]]()

The distinction is not academic, and getting it wrong is a large error rather
than a small one. The world AABB of a rotated prop is bigger than the prop —
unboundedly so as the model gets flatter and the rotation approaches 45° — and
the instance record does carry such a box, which makes it an inviting thing to
collide against. It is the **cull** box (`120-objects.md`). One shipped screen
panel is a zero-thickness rectangle 14.6 m wide turned 31° off the world axes:
its cull box is a slab 12.5 × 7.6 m in plan with corners standing metres off any
surface, while the collider it actually ships is the panel itself, of no
thickness at all. A rider passes through the first and is stopped by the second.
[measured] [[130-mode2-oriented]]()

What meets that box on the rider's side is a **single sphere**, not the deck —
and it meets it on the box's faces only, with the edges and corners left
square. That probe geometry belongs to the rider rather than to the instance,
so it is specified with the rest of the rider's collision volume in
`370-world-interaction.md`; the same volume is what a mode-1 proxy and a mode-3
body are tested against, in each case consuming a different part of it.
[[130-probe-side]]()

> [[130-probe-side]]() db:collision; `370-world-interaction.md` `[[370-probe-volume]]`,
> `[[370-probe-modes]]`, `[[370-sphere-box]]`.

> [[130-mode2]]() db:collision; map:"Prop collision SHAPE by
> `CollsionMode`" — mode 2 → `WorldLine_IntersectAABBSlab` 0x0025e178 for a line
> query, the sphere-set query's own slot for the rider
> (`370-world-interaction.md` `[[370-probe-modes]]`); no stored proxy. GARI
> examples: `Mdl_TreeTrunk_*`, gems, billboards, `Mdl_FWTrigger_*`, boost pads.

> [[130-mode2-oriented]]() db:collision; live read of a paused PCSX2 session
> (PAL SLES-50545, PCSX2 2.6.3) over PINE, ALOHA loaded. The narrowphase
> @0x0025c478 walks the model's object array — count `model+4`, base `model+8`,
> **stride 24** (`addiu s5, s5, 24` @0x0025cb44) — transforms the query per
> object (@0x0025c8e8), and gates every mode on `a3 = *(objectRecord+4)` being
> non-null (@0x0025c93c/@0x0025c940); mode 2 then passes `a3+0x04` as min and
> `a3+0x10` as max (@0x0025c954/@0x0025c958). Measured for `Mdl_Jumbotron_Top`:
> model record 0x00f06de0 carries box min (−732.0, 120.1, 2121.9) / max (732.0,
> 120.1, 2880.0), which is `Maps/ALOHA/Meshes/118.obj`'s own local bounds
> (−732.0, 120.1, 2121.7)…(732.0, 120.1, 2879.8) to 0.2 units — model-LOCAL, and
> **shared**: instances 1170 and 1338 (entities 0x00eb0750 / 0x00ebaf50, live
> rotation rows 0.857/−0.516 and −0.912/0.411) read the same record. The live
> instance hash table is `(hash, entityPtr)` pairs, and it moves per level, so
> locate an entry by hash rather than by a fixed base. Negative control from the
> same session: the rider at (−8100.8, 2332.9, 53323.3) sits several metres
> inside instance 1170's world AABB (−8853.5, 1918.0, 52863.6)…(−7599.4, 2673.2,
> 53621.7) and is neither stopped nor depenetrated by it.

## The response mass (`U0` on disc)

`ObjectProperties.U0` has one mode-independent common-path rule:
**exactly zero is massless/pass-through; every nonzero value admits the
mode-specific response.** Shape contact, collision effects, sounds, and break
actions occur before and independently of this test. The only runtime
comparisons found are exact `U0 == 0.0` tests in rider response and
chase-camera solidity; there is no `1e29`/`1e30` threshold test. A separate
`PlayerBounce` gate must also admit physical response; otherwise a shaped
contact remains contact-only. [[130-movability]]()

The magnitude is consumed only by a rare live-node momentum-sharing variant,
where the rider/prop term contains `m_rider/U0`. Thus `1e30` behaves like
infinite mass arithmetically, not as a categorical sentinel; `0.2`, `5`, `20`,
and `1e30` are indistinguishable at this gate. Rigid-body dynamics
are separate: a Roller-family effect constructor writes inverse mass from the
**effect payload's** mass. The level-load physics-shape constructor never seeds
that scalar from instance U0. [[130-response-mass-magnitude]]()

Per-instance value census (Garibaldi, all 3,393 instances): exact zero 1,187;
huge (≈ 10³⁰) 2,182; finite positive 24 — every finite-positive instance uses
5. Example values: path markers 0; crash bags 5; one billboard model is authored
with both 5 and ≈10³⁰ on different instances. These are corpus categories, not
movability classes. [measured] [[130-movability-vals]]()

### Controlled collision-matrix validation

A sixteen-specimen live matrix held the visible model and mode-3 sphere body
constant while varying collision mode, `PlayerCollision`, U0,
`PlayerBounce`, and bounce magnitude independently. Each contactable specimen
carried a distinct collision-burst color, making effect dispatch observable
separately from physical response. Mode-1/2/3 bands exercised U0 values 0,
0.2, 5/20, and 1e30; controls exercised mode 0, `PlayerCollision=false`, and
`PlayerBounce=false`. [[130-collision-lab]]()

The complete live run matched all sixteen predicted cells:

- the U0-zero lane's mode-1/2/3 specimens emitted their red/blue/green contact
  markers but gave no physical response;
- the mode-0 control produced neither marker nor response;
- every `0.2`, `5`, `20`, and `1e30` shaped specimen with PlayerBounce enabled
  emitted and responded;
- the `PlayerCollision=false` control produced neither marker nor response;
- the mode-2 `PlayerBounce=false` control emitted its white marker but gave no
  physical response; and the `0.6` control emitted and responded.

This independently confirms contact/effect dispatch, exact-zero response,
PlayerCollision, and PlayerBounce as separate gates. [observed]
[[130-collision-lab-results]]()

A seventeenth downhill follow-up isolated the missing cross-cell: nonzero mode
1 with `PlayerBounce=false`. It emitted its cyan contact marker but the rider
passed through, falsifying the prediction that every mode-1 proxy hit falls
through to ordinary collide-and-slide. This control is intentionally outside
the historical four-by-four matrix: all mode-1 flag-off instances across the
five extracted retail levels have exact-zero response mass, so retail supplied
no natural live control. [observed]

The historical seventeen cases are now also `AUTOTEST7`, a single-file machine
fixture that retains every exact scale-1 profile. It grades marker dispatch and
the rider's contact-velocity discontinuity separately, samples each solid response for one
second, then relays the rider back onto the fall line. A hidden pass-through
trigger just uphill of every specimen posts its original lab label through Show
Message, independently of whether that specimen admits contact; the fixture's
plan enables the required executable patch automatically. The clean default run
`20260808-125743` posted all 17 labels and passed all 17 collision cases with no
regressions or inconclusive rows;
calibration passes measured contact-only controls at 0.00–0.02 m/s and solid
responses at 1.17 m/s or more. [measured]

The generated lab also carries a separate six-box downhill regression column
that changes one gate at a time. Its expected sequence is: no shape → no
contact; `PlayerCollision=false` → no contact; exact-zero response mass →
contact marker/pass-through; `PlayerBounce=false` with nonzero mass → contact
marker/pass-through; then bounce amounts 0 and 0.6 with every gate admitted →
solid response, with the former still receiving the universal minimum eject.
This column restates the specified classifier as a repeatable live oracle; its
first PCSX2 run remains pending. [predicted]

A separate downhill column holds mode 1, nonzero response mass, and every gate
constant while varying restitution through 0, 0.03, 0.2, 0.5, 0.6, and a
deliberately non-retail 1.0 elastic stress control. Its 190 m gaps trade exact
same-speed control for a practical single run with acceleration/recovery room.
It is designed for one continuous downhill pass: below the threshold `s ≤ 55.556/b`, two
different authored values can look identical because both clamp to the 55.556
cm/s minimum eject. The velocity delta passed into the hard-impact check is
`J = max(s·(1+b), s+55.556)`. With outward contact normal `n` and the board-up
orientation row `u`, the game enters wipeout when
`J > 1944.444 + 833.333·dot(u,n)` cm/s. Bounce therefore affects both recoil
and wipeout likelihood, but does not determine a fall by itself.

Continuous telemetry across the six authored cases observed no wipeout for
`b=0/0.03/0.2/0.5`, a wipeout for `b=0.6` (`J≈3394`, threshold `≈1839`), and
no wipeout for the slower `b=1.0` control (`J≈1901`, threshold `≈1919`). A
repeat-hit caller counter recorded the player-bounce hard-impact site once,
the independent SurfaceType-6/10 wipeout site zero times, and the common
wipeout entry once. The same helper also feeds a separate decaying contact
integrator that the course-reset path consumes; that accumulator is not this
immediate wipeout threshold. [observed] [[130-reset-integrator]]()

> [[130-reset-integrator]]() @0x0012665c;
> doc:../research/prop-collision-semantics.md — the hard-impact helper's
> separate accumulator work (`boarder+0x300`) belongs to course reset, not to
> this immediate comparison.

> [[130-collision-lab]]()
> doc:../research/prop-collision-semantics.md "Per-mode × per-value truth
> table" and its live-lab note; the controlled GARI run recorded marker
> dispatch plus physical response independently.

> [[130-collision-lab-results]]()
> doc:../research/prop-collision-semantics.md "Per-mode × per-value truth
> table" and its live-lab note; the sixteen-cell run used the controlled matrix
> above and recorded marker dispatch plus physical response independently.

> [[130-response-mass-magnitude]]()
> doc:../research/prop-collision-semantics.md "What U0 actually is" and
> "Mode-3 inverse mass"; exhaustive U0-reader and inverse-mass-writer sweeps
> separate the response scalar from Roller-authored body mass.

> [[130-movability]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> `ObjectPropertiesStruct.U0`; db:collision; exhaustive `entity+0xec` reader
> sweep and exact comparisons documented in
> doc:../research/prop-collision-semantics.md; no threshold comparison exists.
> Pass-through-overrides-solid-response: elf-map.md "How a 'sign'
> breaks (`BreakLogo*`)" — the jumbotron logo (`Mdl_Lcd_ScreenLogo_4001`) is
> authored `U0 = 0` with `PlayerCollision = true` set — the same `U0` value
> the leaf cutouts use — and still passes the rider through; db:sign-break;
> db:collision. The trigger/reset/gem/pad/foliage examples are the same
> pattern, not independently confirmed per-category; their existence as
> distinct invisible/volume instance kinds is censused in
> doc:../research/extracted-data.md "Instance placement census" (23
> `Mdl_FWTrigger_*`, 20 `ResetZone_40x40`), which does not itself record
> their movability field.

> [[130-movability-vals]]() doc:../research/extracted-data.md "Prop
> bounce" (U0 read per instance: `Mdl_Obstacle_PathMarker` 0,
> `Mdl_Barricade_CrashBagA` 5, `Mdl_Billboard_Event5` 5 / ≈1e30 variants);
> db:crash-bag. Tally: GARI `Instances.json` `U0` field, 3,393 instances —
> 1,187 at exactly 0, 2,182 ≥ 1e29, 24 finite (all = 5).

## Player-bounce tiers

A per-record **restitution magnitude** sets how hard the rider rebounds off the
prop; whether the bounce response fires at all is the separate player-bounce
flag (`120-objects.md`). `PlayerBounce=false` still permits contact effects but
suppresses physical rider response, as confirmed by the collision lab's cyan
mode-1 and white mode-2 controls. Levels draw from a small set of tiers:
[[130-bounce]]()

| Magnitude | Feel | Typical props |
|---:|---|---|
| 0.03 | near-dead authored restitution | jumbotron screens |
| 0.2 | soft, absorbing | knockable bodies (crash bags, path markers) |
| 0.5 | default rebound | trees, rocks, billboards, crowd stands |
| 0.6 | springy (kicks you back on-course) | chain-link and directional fences |

The ordinary response reflects the normal velocity with
`v_n' = max(b·s, 55.556 cm/s)` while leaving tangential velocity untouched;
55.556 cm/s is the universal 2 km/h outward floor. A live dynamic-body impulse
path instead ignores this amount; entering that path depends on effect-created
body state, not finite instance U0. That response is specified in
`370-world-interaction.md`.
[[130-bounce-mode3]]()

> [[130-bounce]]() db:prop-bounce; doc:../research/extracted-data.md
> "Prop bounce" (`PlayerBounceAmmount` tiers + GARI counts 0.03×16 / 0.2×63 /
> 0.5×2955 / 0.6×359);
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> `ObjectPropertiesStruct.PlayerBounce`; consumed by
> map:"Boarder/body bump and prop-bounce paths" (response @0x00125a08 reads
> entity+0xec → +0x04).

> [[130-bounce-mode3]]() db:crash-bag — the live-body branch selected by
> `contact+0x14 == 0` in map:"Boarder/body bump and prop-bounce paths"
> (0x00125090) routes to rigid-body impulse 0x00154350 and reads neither
> `ObjectProperties.U0` nor the bounce magnitude.

## Physics bodies — shape center and inertia tensors

A mode-3 instance references a **physics body** record. Its leading block is the
shape center plus inertia data, stored as 24 floats; it contains no scalar mass
or inverse mass: [[130-massprops]]()

- the **shape center** (3 floats) — the root of the occupancy tree, read only
  by the contact probe — and the **center of mass** (3 floats), read only by
  the dynamic-body path, which pivots the knocked-off rigid body about it and
  draws the model at body position minus the rotated offset
  (`230-level-ssf.md`); the two coincide on almost no shipped body,
- the symmetric 3×3 **inertia tensor** (9 floats, row-major), and
- its **inverse** (9 floats) — the matrix the solver consumes directly.

The inverse reproduces the tensor exactly (e.g. a thin path-marker body's
small spin-axis inertia inverts to its stored inverse term to full float
precision), confirming the decode. A chunky crash-bag body is near-isotropic;
a thin path-marker body has a much smaller inertia about its flag axis, so it
spins easily about that axis. [measured] [[130-massprops-vals]]()

> [[130-massprops]]() db:physics-body;
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> `PhysicsData` (`UFloat0..2` tree-root/shape center, `UFloat3..5` center of
> mass, `UFloat6..14` inertia tensor, `UFloat15..23` inverse) under
> `PhysicsHeader`; integer head `U1` = trailing occupancy-mask byte count,
> `U2` = mask RLE flag, `U3`+1 = tree depth. Readers: `sub+0x14` → root center
> into `PhysicsBody_SphereContactElementTest` `0x0023ac48` (`addiu a2,a0,0x90`
> at `0x0023a6fc`); `sub+0x2c` → Roller ctor `0x0013d7f8` only (`node+0x130`,
> body position `0x0013da2c`; inverse `PhysicsBody_ModelPoseFromBodyState`
> `0x0013e6a8`) — `230-level-ssf.md` `[[230-mass]]()`.

> [[130-massprops-vals]]() db:physics-body — GARI header 7
> (`Mdl_Barricade_CrashBagA`) inertia diag ≈ (17569,18104,16997); header 6
> (`Mdl_Obstacle_PathMarker`) ≈ (1960,1960,122), inverse term 0.008174 =
> 1/122.334 exact; doc:../research/extracted-data.md "Prop bounce".

## Occupancy-tree bodies (hollow ride-through structures)

The physics body also stores the collision **shape**, as a **sphere occupancy
tree**: a base-8 tree over a cube, of a stored depth (≤ 5 observed; typically
5 — depth-4 bodies also occur). Each level supplies a sphere radius,
the child-cell layout, and a run-length-encoded mask of which of the eight child
octants are occupied; a line or sphere query descends only into occupied
octants, down to leaf spheres, and reports the first overlapping leaf in tree
order. [[130-spheretree]]()

The load-bearing property of this representation is that large **gateway**
structures — arches, scaffolds, finish-line banners — decode as **hollow**: the
posts/pillars and the lintel/banner are present, and the opening between them is
empty. A rider therefore passes cleanly through the gap and collides only with
the solid members. There is no separate "ride-through" flag anywhere in the
data; the rideable opening is intrinsic to the body's own shape. On one example
level (Mesa), nearly a thousand mode-3 props reduce to a compact box plus a few
dozen gateway bodies that must keep their doorway, decomposed from a handful of
distinct hollow shapes. [observed] [[130-gateways]]()

> [[130-spheretree]]() map:"Mode-3 sphere-tree payload layout";
> db:rideable-props; db:physics-body. Tree = `uPhysicsStruct0[depth]`
> (`U0` sphere radius, `U1` child-center step, `U2` child-mask stride) +
> RLE `UByteData`,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs.
> Traversal `PhysicsBody_SphereContactElementTest` 0x0023ac48: child-mask
> offset = parent + (bit+1)·stride[d−1], the parent's own depth level (the +1
> is load-bearing; without it every level aliases offset 0); octant signs
> table 0x00344bd0; RLE decode 0x0023a040.

> [[130-gateways]]() db:rideable-props; map:"Mode-3 sphere-tree
> payload layout"; doc:../research/extracted-data.md. Mesa: 956 no-proxy
> mode-3 candidates → 908 compact AABBs + 48 doorway bodies from 9 distinct
> hollow shapes (e.g. `Mdl_Cavescaf_Event_3000` hollow cave mouth, `FinishArch`
> ~8 m clear span).

## Surface type on collision

Recapping `120-objects.md`: most props carry surface type −1 and resolve through
the object-collision path above, while a **rideable** prop carries a real
terrain surface type so it rides and sounds like that material (a wood bridge
deck reads as wood). The surface-type enumeration is shared with terrain
(`110-terrain.md`); the per-type physical response is `310-surface-response.md`;
the audio family is `420-audio-runtime.md`. [[130-surface]]()

A handful of properties-record fields beyond those above are not yet assigned a
meaning; no traced collision behavior depends on them. [inferred] [[130-unknowns]]()

> [[130-surface]]() db:rideable-props @0x00128af0 — the per-surface
> response table is stride-indexed by surface type, which −1 cannot address,
> so −1 props route through object handling; rideable example surface type 12
> (wood) on the Mesa bridge collision twin, db:anim-object.

> [[130-unknowns]]() open leads:
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> `ObjectPropertiesStruct.U2`/`U8`, `PhysicsData` integer-head `U2`; no traced
> behavior reads them yet.
