# 120 — Objects

Everything placed *on* the terrain — buildings, trees, rocks, signs, rails
and their supports, ramps, the crowd, start/finish structures, pickups,
trigger volumes — is an **object instance**: a placement of a shared
**model**. A level's object population is described by three tables that
reference each other by index: [[120-tables]]()

1. **Models** — shared geometry, each potentially reused by many instances.
2. **Instances** — placements: one world transform plus per-instance data
   (lighting, identity) per placed object.
3. **Object properties** — shared behavior records (visibility, collision,
   bounce, effect hooks); each instance names one record, and many instances
   may share the same record.

This chapter defines that logical model. The on-disc encodings are specified
in `220-level-pbd.md` and `230-level-ssf.md`; collision geometry and the
movability/physics data in `130-collision-data.md`; the per-instance lighting
model in `160-lighting-data.md`; the logic graph that effect slots point into
in `150-logic.md`; runtime interaction behavior (bounce, breakables,
knockables) in `370-world-interaction.md`.

> [[120-tables]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs
> (Instance list, model list); doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> (ObjectPropertiesStruct + the per-instance `InstanceState` index list
> that joins instances to property records);
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/TrickyLevelInterface.cs
> (the join: `ObjectProperties[InstanceState[i]]` per instance `i`).

## Models

A model is shared geometry: one definition, instantiated any number of times.
A model is composed of one or more **sub-objects** arranged in a parent
hierarchy, each carrying a **rest transform** that places it relative to its
parent. A sub-object's meshes are stored in **its own frame**, not in model
space: the rest transform is what puts them where they belong, and the
hierarchy then composes by ordinary local transforms. Most models leave every
rest transform at identity, which makes their meshes model-space by
coincidence rather than by rule. Materials and texture references resolve
through the level material table (`170-materials.md`).
[[120-model-objects]]() [[120-object-frames]]()

A model may carry an **animation clip** that drives its sub-object hierarchy
(the swinging bridge, falling trees, spinning pickup gems): [measured]

- Clip length is stated in **30 fps frames** (e.g. 90 frames = 3.0 s). [[120-model-anim]]()
- Each animated sub-object carries a **base translation**, held separately from
  its rest transform, plus a set of **channels** selected by a bitmask (e.g.
  rotation about a single axis); one curve per set bit. The bitmask is not
  minimal — a clip may enable a channel and author a flat zero curve on it.
- Each channel's curve is a sequence of **piecewise cubic segments**
  (polynomial coefficients plus a time window in seconds), evaluated at
  absolute clip time and clamped to the segment window outside it.
- A sampled channel value is the **full local pose component**, not an additive
  offset. Translation starts from the base translation and each translation
  channel replaces its component.

**An animated sub-object's ROTATION is built from its channels alone.** A
rotation component carrying a curve takes its value from that curve. The
sub-object's rest rotation takes no part whatever, and the Euler triple stored
beside the base translation very nearly none: the runtime reads that triple —
held on disc in **radians** — as though it were degrees and converts it a second
time, so it reaches the pose scaled by (π/180)², about one part in 3,300. An
authored 90° arrives as 0.027°. Treat an unchannelled rotation component as zero;
no rotation can be expressed through it. Shipped levels never expose any of this,
because every non-zero rotation they author is also channelled.
[measured] [[120-anim-base]]()

Two consequences for anything authoring clips. A rotation the author wants must
be expressed as a **channel**, even a constant one — a value parked in the base
or the rest transform simply does not appear. And a turn about an arbitrary axis
cannot be aimed on the moving sub-object at all; the tilt goes on an **unanimated
parent**, whose rest transform *is* honoured, leaving the animated child to sweep
a plain local axis. Parent transforms compose normally, and the shipped levels
already nest an animated child under an animated parent several levels deep.

Where a sub-object drives two or more rotation channels at once, the triple
composes **ZYX** — Z outermost, then Y, then X. A single live channel is one plain
axis rotation whatever the order, so this only bites on multi-channel clips, of
which the shipped levels author essentially one. [measured] [[120-euler-order]]()

A sub-object carrying a rest transform but **no meshes** is composed like any
other. The shipped levels never use one — every mesh-less sub-object they
carry is a bare root with no transform at all — but the capability is real,
and it is what lets a transform be inserted into a chain without inventing
geometry to hang it on. [measured] [[120-meshless-node]]()

An animated model is safe only through **27 total native `ModelObjects`**.
The 28th does not merely stop animating: the PAL runtime overruns a fixed
matrix workspace while composing the model and the game freezes. Count every
entry in the packed model — static root, animated and unanimated objects, and
mesh-less mounts alike. This is not a separate hierarchy-depth or animated-
record limit: both a 25-link chain and a flat 13-rung model work because each
packs to 27 objects, while the corresponding 26-link (28-object) and 14-rung
(29-object) models freeze after their last animated objects have already been
sampled. [measured] [[120-model-object-limit]]()

Whether and how a given instance plays its model's clip is decided by the
logic graph, not by the model (`150-logic.md`), through one of two runtime
players: [measured] [[120-model-anim]]()

- **Free-running** — the clip clock advances continuously (wrapping per the
  loop mode: wrap, ping-pong, or play-once) for as long as the player exists
  (the swinging bridge, the spinning pickup gems).
- **Delta-gated** — the clock starts frozen and advances only while a granted
  **budget** (in clip-seconds) remains, freezing again when it runs dry. Budget
  arrives via the animation-node ops (`150-logic.md` main types 3/9): op 2
  grants value/30 seconds, op 1 holds the clock for value seconds, op 4 seeks.
  The up/down kicker ramps are the worked example: a 1-second grant on their
  2-second ping-pong hinge clip advances exactly one half-cycle, so each grant
  *toggles* the ramp between its rest and raised poses.

Either player exists only while the instance's world-grid region is active;
deactivation destroys it and the model reverts to its rest pose.

> [[120-model-objects]]() doc:../research/extracted-data.md "Model
> object animation" — `ModelObjects[].ParentID` hierarchy and the per-object
> `Position`/`Rotation`/`Scale` rest transform.

> [[120-object-frames]]() doc:../research/extracted-data.md "Model object
> animation" §Meshes are stored in their own object's frame. Census over
> ELYSIUM/GARI/MERQUER/MESA/SNOW: 692 of 6229 mesh-bearing sub-objects carry a
> non-identity rest transform; of the 673 whose offset is large enough to
> discriminate, 311 have their geometry about its own origin, 362 are offset
> within their own frame, and **none** sits on its own rest position. (Classify
> by median vertex distance — a centroid reports one false counter-example on a
> disjoint mesh, MERQUER `Mdl_Helicopter_PoliceANIM_0` obj2.) Crispest
> case SNOW `Mdl_SnowBlower_Top_1000` obj1: rest `Position` (-0.0006,
> -111.802376, -0.4116) against `43.obj` centroid (0.00, 0.02, 0.25). The frame
> is forced by the engine composing the absolute accumulated pose rather than a
> delta from rest. Retail settles that alone: MERQUER
> `Mdl_Helicopter_PoliceANIM_0` obj2 (the searchlight) rests at y 481.0,
> z -369.2 while the fuselage skin at that station runs z -370.2 underside —
> the absolute reading mounts it flush to the belly under the nose, 1.0 unit
> off, where it is observed in play; the delta reading would bury it at the
> model origin, inside the cabin. An authored PCSX2 canary then measured the
> same thing in both directions — model-space geometry under a rest matrix
> rendered displaced by exactly that rest translation (a double application,
> which a delta engine cannot produce), and the same part expressed in its
> object's frame rendered correctly.

> [[120-anim-base]]() doc:../research/extracted-data.md "Model object
> animation" §Rotation comes from the channels alone; §Runtime animation records
> for the live-memory route. `Animation.U1-U3` is the base translation, copied
> verbatim; `U4-U6` is the Euler triple. `MeshAnimRecord_Bind` @0x001cb5d0 (PAL)
> passes that triple through ×π/180 although the disc already holds it in
> radians, and `MeshAnimRecord_BuildLocalMatrix` @0x001cb990 converts again —
> hence the (π/180)² factor. `MeshAnimRecord_SampleChannels` @0x001cb7f8 walks
> the action bitmask and writes channel *i* to `rec+0x4c+4i` **only** when its
> bit is set, which is why an unchannelled component keeps the vestigial base
> value. Measured live on the PAL disc: a sub-object with a stored base of
> 1.57080 rad per axis and one constant 90° channel on bit 3 reads
> (90.0000, 0.0274, 0.0274) degrees, against a predicted 90·(π/180)² = 0.027416.
> Corroborated by three authored canaries read visually before the memory route
> existed, and by retail: across ELYSIUM/GARI/MERQUER/MESA/SNOW, **0 of 117**
> animated sub-objects carry a non-zero base rotation component without a channel
> on it. The same rule explains an earlier canary in which an aim quaternion
> written to a sub-object's rest `Rotation` was ignored entirely. Translation is
> the base's, not the rest transform's, and is measured rather than assumed: a
> canary whose sub-object rests at (0, 0, 200) while its base declares
> (200, 0, 200) — no translation channel — reads a live `rec+0x4c` of
> (200.000, 0.000, 200.000), so the two must be authored apart to tell them
> apart, which no shipped clip does.

> [[120-euler-order]]() [measured] doc:../research/extracted-data.md "Model
> object animation" §Composition order. Three independent lines agree. (1) The
> code: `MeshAnimRecord_BuildLocalMatrix` @0x001cb990 (PAL) negates the three
> angles, sincos's them and emits a closed form equal to `transpose(Rz·Ry·Rx)`
> to 2.2e-16 over 20,000 random triples; it is stored transposed (row-vector
> form), so a point sees `Rz·Ry·Rx`. (2) The engine's own computed matrices, read
> over PINE from an authored canary whose three sub-objects each drive TWO
> constant 90° channels — masks 0x18/0x28/0x30 — fitting ZYX uniquely among all
> six orders at max |Δ| = 6.1e-17, sending local +X to −Z, +Y and −Z. (3) The
> same canary read visually before the memory route existed. Consistent with the
> only shipped multi-channel rotation, MESA `Mdl_MineCart_RustedANIM_3000` obj2
> (live X and Z, Y zero), whose rest matrix equals its channel pose under
> {YZX, ZXY, ZYX} — those three coincide whenever Y is absent, so retail alone
> can never separate them. Nesting depth: MERQUER `Mdl_Helicopter_PoliceANIM_0`.
> Non-minimal bitmask: SNOW `Mdl_SnowBlower_Top_1000` obj1 `AnimationAction`
> 56 with flat zero curves on two of the three enabled rotation channels.

> [[120-meshless-node]]() doc:../research/extracted-data.md "Model object
> animation" §A mesh-less sub-object carrying a rest transform is honoured —
> all 125 mesh-less sub-objects across ELYSIUM/GARI/MERQUER/MESA/SNOW are
> bare roots with null `Position`/`Rotation`/`Scale`; an authored PCSX2 canary
> placed a matrix-only mesh-less node between a static root and an animated
> child and the engine composed it normally.

> [[120-model-object-limit]]() [measured] doc:../research/extracted-data.md
> "Runtime animation records" §Animated-model object ceiling. PAL
> `sub_00199818` allocates a fixed 0x7c0-byte frame and writes one 0x40-byte
> composed matrix per `model+0x04` object from `sp+0x20`. Object indices 0–26
> fit; index 27 (the 28th object) reaches `sp+0x710..0x71c` and overwrites live
> locals, including an entity/working pointer at `sp+0x71c`. Authored PINE
> boundary tests agree across topology: flat 13 rungs = 27 objects works,
> flat 14 = 29 freezes; depth 25 = 27 works, depth 26 = 28 freezes. In both
> failing cases the highest animated object had already been sampled, placing
> the failure in matrix composition rather than curve evaluation.

> [[120-model-anim]]() db:anim-object; db:anim-delta-kicker; map:"World-prop
> model animation" — clip fields (`AnimTime` 30 fps frames, `AnimationAction`
> channel bitmask, `AnimationMaths` cubic segments with second-unit
> windows) decoded in doc:../research/extracted-data.md "Model object
> animation"; runtime playback node traced on the Mesa bridge (3.0 s
> X-rotation hinge chain, amplitude compounding down the parent chain). The
> delta-gated player and its clip-second budget ops (grant value/30, hold,
> seek) are the up/down kicker ramps' worked example (`150-logic.md`): a
> 1 s grant on a 2 s ping-pong clip advances one half-cycle, toggling the
> ramp between poses.

## Instances

An instance is one placement. Each instance record carries: [[120-instance-record]]()

| Field | Meaning |
|---|---|
| Transform | Full affine world transform (rotation, translation; scale permitted). |
| Model reference | Index of the shared model this instance places. |
| Bounding box | World-space min/max corner; derivable from the transformed model, stored for convenience. |
| Lighting block | Per-instance baked lighting: an ambient color plus up to three directional key lights (direction + color each). Directions are model-local and dot the stored model-local mesh normals; see `160-lighting-data.md`. |
| Properties reference | Index into the shared object-properties table (below). |

Two further pieces of per-instance identity live alongside the table:

- **Names.** Every instance (and model) has an authored name (e.g. a
  `Mdl_…`-prefixed string naming the prop and often its course location).
  Names are descriptive, not behavioral — behavior comes from the properties
  record and the logic graph — but they are the practical key for humans and
  tools. [observed] [[120-names]]()
- **Name-hash identity.** Instances are joined to the per-instance collision
  **sound** rows by a hash of identity, kept in a sidecar mapping
  (instance index ↔ hash; the sound table is keyed by hash). An instance
  with no row simply has no collision sound. Sound data and resolution are
  specified in `190-audio-data.md` / `420-audio-runtime.md`. [[120-name-hash]]()

Instance records also contain a small number of fields whose purpose is not
yet established, including what appear to be prev/next instance links and a
second model reference; no observed behavior depends on them so far.
[inferred] [[120-unresolved-fields]]()

> [[120-instance-record]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs
> (Instance: `matrix4X4`, light vector matrix + `LightColour1..3` /
> `AmbentLightColour`, `ModelID`, `LowestXYZ`/`HighestXYZ`); the
> properties reference is the parallel `InstanceState` list in
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs.

> [[120-names]]() names ship in the level's map sidecar
> (`InternalInstances[].Name`), exported per instance by
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/TrickyLevelInterface.cs.

> [[120-name-hash]]() doc:../research/extracted-data.md "Prop
> collision sounds from ADL and `BANKS.INF`" — hash row layout, the
> `entity+0xf4` runtime gate, and the event-id → bank-slot remap;
> db:prop-collision-sound; map:"Prop collision audio routing". Hash join:
> `hashData.InstanceHash` (ObjectUID ↔ hash) in
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/TrickyLevelInterface.cs.

> [[120-unresolved-fields]]() PBD Instance `PrevInstance` /
> `NextInstance` / `ModelID2` / `UnknownInt26..32`,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs.
> Open lead: plausibly per-model instance chains (every model's instances
> linked); not needed by any traced behavior yet.

## Object properties (shared behavior records)

Behavior is factored out of the instance table: each instance names one
record in a shared **object-properties** table, and unrelated instances
freely share records (every "plain solid tree" can point at the same one).
A record carries: [[120-properties-record]]()

| Field | Meaning |
|---|---|
| Rider-response mass | Exact zero suppresses solid rider response; every nonzero value admits the common response. It does not activate dynamic movement. Specified in `130-collision-data.md`. |
| Bounce magnitude | Player-bounce restitution scalar; levels use a small set of tiers. Specified in `130-collision-data.md`. |
| Flags | Bit flags; established bits below. |
| Surface type | Same enumeration as terrain (`110-terrain.md`), or −1 for "none". See below. |
| Collision mode + reference | Small-integer collision mode selecting how the object collides (none, triangle-mesh proxy, coarse box, or physics body), with a mode-dependent reference to a collision model or physics-data record. Specified in `130-collision-data.md`. |
| Effect-slot reference | Index into the logic graph's slot table — the instance's behavior hook (below). |

**Known flag bits** (16-bit field): [measured]

| Bit | Meaning |
|---:|---|
| 0 | **Visible** — cleared on instances the renderer must never draw (next section). |
| 5 | **Player collision** — the instance participates in rider-vs-object collision. |
| 7 | **Player bounce** — rider impact uses the bounce response (with the bounce magnitude above) instead of a plain slide. |
| 13 | **UV scroll** — the instance's material animates by UV scrolling (`170-materials.md`, `410-texture-animation.md`). |

Bit 12 is also set on some instances; its meaning is not established. [inferred]

**Object surface type.** Most records carry −1 ("none"): the object is not a
ridable material, and a rider contacting it resolves through the object
collision response rather than the terrain surface table. A **rideable**
prop — one meant to be ridden across like ground (a bridge deck, a ramp
surface) — sets a real surface type, which selects its ride feel and ride
audio family exactly as terrain does (a wooden bridge deck carries the
wood-family type, so riding it sounds like wood). Objects whose surface type
is −1 still collide; they just don't impersonate terrain. [[120-surface-type]]()

> [[120-properties-record]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> ObjectPropertiesStruct (`U0` response mass, `PlayerBounce` magnitude,
> `BitFlags`, `SurfaceType`, `CollsionMode`,
> `CollisonModelIndex`/`PhysicsIndex` mode-split, `EffectSlotIndex`); bit
> assignments confirmed in
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/TrickyLevelInterface.cs
> (bits 0/5/7/12/13). Response-mass values + bounce tiers + collision-shape
> modes: doc:../research/extracted-data.md "Prop bounce"; db:prop-bounce;
> db:collision; db:physics-body.

> [[120-surface-type]]() db:rideable-props @0x00128af0 — the
> ground-contact query dispatches terrain AND objects; the nearest hit's
> surface type feeds the rider's material response, and −1 cannot index
> the per-surface table (stride-indexed), so −1 props route through
> object handling. Wood-deck example: db:anim-object (Mesa
> `Mdl_bridgesurface` collision twin, surface type 12 → WOOD audio
> group); audio mapping table in doc:../research/extracted-data.md
> "Board-snow audio mapping".

## Effect slots — the behavior hook

An instance's dynamic behavior (boost pads, breakables, triggers, ambient
animation, scrolling textures) is not encoded on the instance; the properties
record points at an **effect slot**, and the slot bundles several entry
points into the level's logic graph, distinguished by circumstance (at
minimum **persistent** and **player-collision**). The slot record, the
circumstances, the chain encoding, and the dispatch semantics are specified
in `150-logic.md`. [[120-effect-slots]]()

> [[120-effect-slots]]() db:sign-break (collision chain:
> `EffectSlots[15].CollisionEffectSlot=49` → the BreakLogo function);
> db:anim-object (persistent chain: slot 71 → `PersistantEffectSlot` 149 →
> the bridge sway clip); map:"SSF effect-node opcode dispatcher". Slot
> record = 7 int references,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> struct EffectSlot; the remaining entries' circumstances are not yet
> pinned.

## Invisible instances

Instances with the **visible flag cleared** are real table entries the
renderer must never draw. They are load-bearing — an implementation that
draws them anyway renders walls of placeholder art across the course (the
volumes typically wear a flat "no-entry" placeholder texture). They come in
three kinds: [[120-invisible]]()

1. **Utility volumes** — box-shaped instances whose only job is their
   collision/trigger footprint: event trigger volumes (fireworks, scripted
   events), out-of-bounds reset zones, and phantom collision boxes that
   stand in for unclimbable detail geometry. They participate fully in
   collision and trigger queries; only drawing is suppressed.
2. **Swap-in twins** — complete hidden meshes shipped for a scripted reveal:
   a breakable screen's pre-broken twin sits at the same spot, hidden, until
   the logic graph's break chain hides the intact instance and shows the
   broken one (`150-logic.md`, `370-world-interaction.md`).
3. **Collision twins** — invisible, collidable doubles of a visible animated
   prop, clip-synced so the collision surface tracks the rendered animation
   (the swinging-bridge pattern); the proxy/twin data model is specified in
   `130-collision-data.md`. [measured] [[120-collision-twin]]()

Visibility is therefore **dynamic state, not a static cull list**: logic
chains hide and show instances at runtime (the mesh-swap break above), so
implementations must keep hidden instances resident and toggleable. The
authored visible flag itself is never rewritten while a level runs. Each
instance carries a live status word seeded from its authored flags plus two
engine bits — "cell active" and "drawn by the static path" — and the
placed-object render pass submits an instance only when both the authored
visible bit and the static-draw bit are set. A live effect node that takes
over an instance's model (an animation clip, a knock-off body, a rail, a
texture flip, a mesh throw, a spline mover) clears the static-draw bit and
draws the instance itself; the dead-node tombstone clears it and draws
nothing, which is how every scripted hide works. Whenever such a node ends,
the live word is rebuilt from the authored flags and the instance returns to
the static path. [[120-runtime-hide]]()

> [[120-runtime-hide]]() `entity+0xe8` = `{lo16 live flags, hi16 authored
> BitFlags}`: copied from the SSF properties record at
> `CourseResolve_BindInstanceProperties` `0x0025fac8` (`0x0025fb88/0x0025fb9c`),
> live half initialised `authored | 0x0102` at `0x0025f8f0–0x0025f96c`; the
> static submit walk `WorldCells_SubmitStaticInstances` `0x00200888` requires
> `(w & 3) == 3` (`0x002009f0–0x002009f8`) and is the only consumer of bit
> 0x02; node ctors clear it (`AnimObject` `0x00198e78`, `Rail` `0x0014014c`,
> `TextureFlip` `0x00143018`, `MeshAnim` `0x00146dcc`, `Movie` `0x00148ab8`,
> `Roller` `0x0013db28`, `SplinePath` `0x001fa938`, tombstones
> `0x0013af78/0x0013afd8/0x0013b030`); the node-end restore idiom
> `live = (live & 0x0100) | template | 0x0002` at 14 sites (`0x0011608c`,
> `0x0013a944`, `0x0019970c`, …). Bit 0x01 (`Visable`) has no runtime writer.
> map:"Instance runtime status word (`entity+0xe8`)".

Example census (Garibaldi): 3,393 instances, of which 58 ship invisible —
23 event-trigger volumes, 20 reset zones, 5 phantom collision boxes, and
10 pre-broken screen twins. [measured] [[120-gari-counts]]()

> [[120-invisible]]() visible flag = properties `BitFlags` bit 0,
> doc:../../Snowknife/SSX-Library/SSX-Library/JsonFiles/TrickyLevelInterface.cs;
> instance-kind breakdown + placeholder-art observation:
> doc:../research/extracted-data.md "Instance placement census".

> [[120-collision-twin]]() db:anim-object — Mesa
> `Mdl_bridgesway` (visible, no player collision) + `Mdl_bridgesurface`
> (invisible, collidable, proxies mirror the render sub-objects 1:1),
> both driven by identical clip nodes from one persistent chain;
> map:"World-prop model animation".

> [[120-gari-counts]]() doc:../research/extracted-data.md "Instance
> placement census" (counts read from GARI Instances.json).

## Start / finish staging markers

Every Tricky course carries two **named placeholder instances** the engine
resolves by name hash to obtain the start and finish placement transforms:
`Mdl_StageArea_Start_0` and `Mdl_StageArea_Finish_0`. The engine hard-codes
both strings, hashes the selected one at runtime (index 1 → start, 2 →
finish), and resolves that hash through the PBD instance-hash table. The
getter transforms the caller's position through the found instance matrix
and emits the corresponding orientation. If the hash is absent, callers keep
their untransformed default position.
[[120-stagearea]]()

Race-start placement uses six fixed 48-byte staging records. Each record carries
a position that is local to `StageArea_Start` plus a marker index selecting that
named transform. The six local positions have centroid
(-8.2617, 42.9267, 280.6483). Therefore the StageArea instance matrix, not the
active AIP/SOP start-path origins, places and orients the rider formation in world space.
Without a matching instance hash the same records remain near the untransformed
level origin. [[120-stagearea]]()

They are **universal and shared**: present exactly once per course with
byte-identical model hashes across every level checked (GARI / MESA /
ELYSIUM / ALASKA / PIPE — even the non-race half-pipe). `StageArea_Start`
sits at the start gate (`Mdl_StartGate_*` / `Mdl_Staging_support_*`).
`StageArea_Finish` sits on the post-race **podium/corral**, sharing its exact
position with the finish visuals (`Mdl_Finish_Stage_*` / `Mdl_Finish_Coral_*` /
`Mdl_Finsh_Screen_*`) — **20–48 m past the finish line itself**, which is the
DTF=0 crossing at the finish arch `Mdl_FinnishGate_*`
(`390-pickups-and-race.md`). Their collision footprint is a tiny ~1 × 0.1 × 1 m
box: they are **placement anchors, not crossing triggers**. For a port they
locate the start gate and the podium; the finish *line* comes from the race
lines. [[120-stagearea]]()

> [[120-stagearea]]() db:finish — names hard-coded at `0x00384278`/`0x00384290`;
> getter `StageArea_GetMarkerTransform` 0x001777e8 (sibling 0x001779d0) →
> name hash 0x00241408 → instance-hash resolver 0x002555f8; callers
> 0x0016e918/0x00171628/0x00172118 supply a default vector and retain it on a
> lookup miss. Cross-level hash census measured on
> GARI/MESA/ELYSIUM/ALASKA/PIPE (`StageArea_Start` 0x91f640,
> `StageArea_Finish` 0xfc656e0). Podium offset measured from the DTF=0 crossing
> on GARI/MESA/ELYSIUM/MERQUER/SNOW (47.6 / 20.3 / 39.0 / 34.3 / 31.4 m).
> Start-record layout and local coordinates verified live at
> `StagingPoint_GetWithStageAreaOverride` 0x00172118. spec:390-finish-anchor.

## Particle placements

Levels also place **particle emitters** through a separate, smaller table of
the same shape — a world transform plus a bounding box per entry, instead of
a model — with an explicit `ParticleModelIndex` reference to a puff-cluster
definition. The reference is many-to-one: ELYSIUM's 59 placements share 19
models. Particle system data is specified in `180-particles-data.md` and
`220-level-pbd.md`. [measured] [[120-particle-instances]]()

> [[120-particle-instances]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/PBDHandler.cs
> (ParticleInstance: `matrix4X4`, `LowestXYZ`/`HighestXYZ`, reference +
> unresolved ints); `ParticleModelIndex` is the u32 at record +0x40 and indexes
> the PBD particle-model table.
