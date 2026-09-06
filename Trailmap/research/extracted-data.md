# Extracted Data We Can Trust

Facts pulled directly out of extracted level/config files (level JSON,
`DATA/CONFIG/*`), not inferred from disassembly. These are the
highest-confidence inputs to the functional spec (`../specs/`). For the
ELF-side constants and motion math, see `elf-map.md`.

The extracted level/config data gives us, directly reusable: surface labels,
boost magnitudes, reset/no-collision labels, trick-only patches, input mapping,
and prop bounce. It does **not** contain named/direct friction and grip
coefficients. The closest real source for those is the ELF's per-surface
material response table (see `elf-map.md#surface-physics-table`).

## Terrain surface labels

Garibaldi (`Assets/OpenSlope/Maps/gari/Patches.json`) uses these terrain
`SurfaceType` counts (full legend + distribution: spec:110-surface-types,
spec:110-gari-counts):

| SurfaceType | Count | Meaning from `PBDHandler` legend |
|---:|---:|---|
| 0 | 622 | reset / out of bounds |
| 1 | 650 | standard snow |
| 3 | 1321 | powdered snow |
| 4 | 390 | slow powdered snow |
| 5 | 258 | ice standard |
| 9 | 540 | rock / off track |
| 10 | 38 | wall |
| 17 | 6 | no collision |
| 18 | 60 | show-off ramp / metal |

`TrickOnlyPatch` is separate from `SurfaceType`: GARI has 60 trick-only
patches (decoder rule: `PatchVisablity < 0`). spec:110-trick-only

## Terrain patch orientation and seam conventions

Empirical findings about the patch records themselves, established on GARI
(all reproduced level-wide) unless a wider basis is noted:

- **Texture UV corners pair index-for-index with the geometry corners.** Each
  stored `UVPoint_i` is the texture coordinate of the patch corner `Point_i` of
  the same index: in the .pbd the four corner points (record `0x168` = bicubic
  cp0, cp12, cp3, cp15, in parametric order (u0,v0),(u1,v0),(u0,v1),(u1,v1)) are
  stored **parallel** to `UVPoint1..4` (record `0x10`). In bilinear terms —
  corners uvA@(0,0), uvB@(0,1), uvC@(1,0), uvD@(1,1) — the binding is
  uvA=UVPoint1, uvB=UVPoint3, uvC=UVPoint2, uvD=UVPoint4: a **transpose** of the
  same-index order (the two off-diagonal corners swap). The boost-chevron decals
  are the unambiguous compass — correctly bound they point parallel, downhill.
  spec:110-uv-rotation
- **The lightmap tile is transposed (u↔v), not rotated.** Scoring all 8
  square symmetries by luminance disagreement among world-coincident
  boundary vertices: transpose 0.025, rot90 0.121, rot270 0.139, identity
  0.196, others ≥0.199. Per-axis: rot90 = 0.145 down-mountain / 0.023
  lateral (checkerboard of brightness steps along one axis); transpose =
  0.018 / 0.017 (smooth both ways). Textures and lightmaps use **different**
  storage conventions — the texture rides stored UV corners, the lightmap
  maps parametric (u,v) onto its tile rectangle. spec:110-lightmap-tile
- **Boundary control points of adjacent patches are near-equal, not bitwise
  equal**: tessellators need an epsilon weld, and the boundary-mismatch
  metric above only works because coincident vertices are merely *near*.
  spec:110-seams
- **Tile UVs: one full tile per patch, usually seam-inset** (census across all
  five extracted levels, 14,985 patches). The dominant convention pulls the
  tile's corners inward by **0.008 per side** (span 0.984): ELYSIUM 4,200/4,268,
  MESA 2,197/2,448 and MERQUER 2,183/2,731 patches carry exactly that value —
  the inset keeps bilinear + wrap sampling from bleeding the tile's opposite
  edge across the patch seam. **GARI is the outlier, not the rule** (3,715/3,885
  exact-unit, 152 mixed insets 0.980–0.985); SNOW sits between (1,065 unit, 172
  lighter ~0.993 insets). A GARI-only census reads the inset as a rare hand-fix —
  backwards. The remainder: D4 rotations/mirrors of the full tile, multi-tile
  repeats on one patch (2×1 / 2×3 spans; GARI 12, MERQUER 143, MESA 190, SNOW
  412), and a handful of sub-tile crops (≤6 per level). All 13 distinct shipped
  layouts are axis-aligned rectangles composed with a D4 state — nothing
  sheared. spec:110-uv-inset

## Terrain patch authoring structure (flow-aligned ribbons)

GARI's 3,885 patches carry **authoring category prefixes** in `PatchName`, and
the categories — not a uniform grid — are the structure. The trail is its own
surface: `Patch_MainPath`/`Patch_Mainpath` (219) is a named category distinct
from the side terrain (`Patch_SCE` 1681, `Patch_SideGeo` 656, `Patch_SGD` 384,
`Patch_SG` 357, plain `Patch` 353, `Patch_SC1/2/5`+`NewSC` 169, `Patch_ShowOff`
60, `Patch_MetalRail` 6).

- **MainPath patches form a connected ribbon.** By shared-edge adjacency (≥2
  shared corners), the median MainPath patch has **3–4 neighbours** (interior of
  a strip), only one isolated — a coherent 2D mesh threading the level, not
  scattered tiles. They are **elongated** (aspect median 2.2, p90 4.5): strips
  running along the trail.
- **Patch size is the texture-density control.** Every patch is exactly one UV
  tile (corner UVs span 1.0×1.0; only `Patch_MetalRail` differs, 1.0×0.70).
  MainPath patches are ~16.5×7.7 m; `Patch_SideGeo` is ~32.8×36.6 m. Half the
  size → ~2× the texel density on the trail where the player looks, coarse tiles
  off-trail. Resolution is authored by where the patch edges go, not a texel
  budget.
- **Region = surface.** MainPath rides surface 1 (standard snow) + 5 (ice);
  SideGeo is the 0/3/4/9/10 grab-bag (reset/powder/rock/wall); `Patch_ShowOff`
  is its own surface 18 (show-off/metal), `Patch_MetalRail` surface 17 (no
  collision — the rail system is separate). Authored category and physical
  surface track each other.
- **Directional decals are terrain-patch textures, not overlays.** MainPath's
  textures are dominated by one tiling track tile (`0012.png`, 100/219) with a
  scatter of `0085–0096` tiles appearing 1–3× each — marking/chevron tiles
  **inset into the ribbon** where a decal goes. They point downhill only because
  the patch UVs (the index-matched corner convention above) follow the trail.
  The separate coplanar-decal *overlay* path (a draw-order z-fight tiebreaker)
  is for props
  (LCD/firework/coral), not trail markings. spec:110-uv-rotation;
  spec:170-alpha-flag
- **The trail is a SEPARATE surface stitched into a corridor, not a welded
  quilt.** MainPath is one connected ribbon (218/219 patches in a single
  shared-corner component), but the body does **not** lie under it: only **3% of
  MainPath patches** have any side-geometry patch beneath them in plan view — the
  body tiles up to a course-shaped **corridor** and stops; the ribbon **fills**
  it. The two meet only at the seam, and **not** by vertex-matching: ribbon
  perimeter tips weld 100% to body corners and ~33% of MainPath corners overall
  touch a body corner (the two long edges), while the finer interior floats free
  over ground the body doesn't cover. Non-conforming tessellation (the ribbon has
  ~4 patches where the body has 1) stays watertight because the boundary
  **curves** coincide even where the **vertices** don't — the near-equal-weld
  seam convention above is exactly this (T-junctions + epsilon weld; no shared
  interior vertices needed). spec:110-seams

Implication: the shipped terrain was authored as **flow-aligned patch ribbons**
(the trail a distinct, finer ribbon whose patch rows run along the course)
**stitched into a corridor cut in a coarser body** — not one welded quilt, and
not a heightfield grid with a trench stamped in. That is why walls and
directional textures stay clean: the patch edges *are* the trail edges, so no
diagonal feature is aliased across a square lattice, and the body/trail seam is a
matched-curve T-junction rather than a shared-vertex weld. (Counts/sizes/coverage
reproduced from `Maps/GARI/Patches.json`.)

## Boost and scoring effects

`Assets/OpenSlope/Maps/gari/SSFLogic.json` contains real effect magnitudes:

| Effect main type | Meaning in extracted handler/docs | Values found |
|---:|---|---|
| 17 | speed boost | `3.0`, `5.0` |
| 18 | trick boost window | `10.0`, `15.0` |
| 14 | score multiplier | `2.0`, `3.0`, `5.0` |

In GARI instances, `Mdl_SpeedBoost_Gold_*` uses effect slot `0`, and
`Mdl_TrickBoost_RedGreen_*` uses effect slot `1`.

For the visible GARI pads:

| Slot | Visible model | Persistent effect | Collision effect |
|---:|---|---|---|
| 0 | `Mdl_SpeedBoost_Gold_*` | UV scroll, V = `-0.05` | main type 17, value `5.0` |
| 1 | `Mdl_TrickBoost_RedGreen_*` | UV scroll, V = `-0.06` | main type 18, value `15.0` |

Other effect headers carry the lower-tier values (`3.0` for speed boost, `10.0`
for trick boost). Runtime mapping in the ELF is through the numeric effect
main-type dispatcher: type 17 calls `Boarder_RequestBoostAmount` and sets
boarder `+0x134`; type 18 calls `Boarder_RequestBoostFlagAndWindow` and sets
`+0x138/+0x13c`. A direct trick-pad upward velocity write has not been found.

The named `cBoostNode` constructor is a separate type-0 subtype-7 `Boost` effect
path; do not conflate it with the visible speed/trick pad collision handlers.
Both are summarized in `elf-map.md#boost-effect-constructor`.

## Instance placement census

GARI `Instances.json` places **3,393 object instances**. 58 of them ship with
the visible flag (object-property `BitFlags` bit 0) cleared — real table
entries the engine never draws (spec:120-invisible, spec:120-gari-counts):

| Invisible set | Count | Kind |
|---|---:|---|
| `Mdl_FWTrigger_*` | 23 | firework/event trigger volumes |
| `ResetZone_40x40` | 20 | out-of-bounds reset zones |
| `PhantomBox` | 5 | radio-tower phantom collision boxes |
| `Mdl_Lcd_ScreenLogoBroken_*` | 10 | pre-broken jumbotron swap-in twins (real shattered meshes with their own material, not volumes) |

The 48 volume-type entries wear placeholder art (the red "no-entry" sheet
texture `0052`, shared with some *visible* props) — drawn anyway, they render
as solid red walls across the course, which is what makes honoring the flag
load-bearing.

Instance and model **names** (`Mdl_…`) are authored debug strings shipped in
the level's map sidecar, not in the PBD instance records themselves; the
exporter joins them by index (spec:120-names).

### Per-instance lighting frame

`LightVector1..3` are **model-local**, not world-space directions. Retail GARI
settles the transform statistically: rotating each stored primary vector
through its instance placement recovers the common world sun; equivalently,
inverse-rotating that sun by a placement reproduces the stored vector. Comparing
the records without their instance rotations mixes differently turned frames.

An authored PCSX2 gnomon made the consequence visible. It carries flat-colour
cards with stored normals on ±X/±Y/±Z and was placed at a non-cardinal yaw. A
single world sun vector copied unchanged into the instance lit the gnomon's
local nose after the prop turned, while the editor lit the opposite world-facing
card. Storing `inverse(instance rotation)·world sun` made the same faces light
in both. A full-bright twin (`ambient = [256,256,256]`, keys zero) stayed
texture-true and separated lighting from texture/gamma errors. spec:160-instance-frame

The canary also exposed a codec failure independent of the frame. PBD mesh
normals are signed-normalized i16 values decoded by ÷32768. The writer formerly
computed `int(value×32768)` and narrowed it directly; exact +1 became 32768,
wrapped to −32768, and turned every positive cardinal normal inward. Saturating
to 32767 before the i16 write round-trips +1 as +0.9999695 and preserves all six
cardinal directions. spec:160-instance-normal; spec:220-chunk-layout

## Prop bounce

`Assets/OpenSlope/Maps/gari/Instances.json` exposes authored player bounce values:

| `PlayerBounceAmmount` | Count |
|---:|---:|
| 0.03 | 16 |
| 0.2 | 63 |
| 0.5 | 2955 |
| 0.6 | 359 |

The same file's `U0` field (the rider-response mass,
spec:130-movability) over all 3,393 GARI instances: 1,187 at exactly `0`,
2,182 `≥ 1e29`, and 24 finite — every finite value is `5`. These are corpus
buckets, not movement classes: exact zero suppresses solid response and every
nonzero value admits it. Tally from `Maps/GARI/Instances.json`, field `U0`.

The bounce values above come from the SSF object-property float at property offset `+0x04`,
exported as `PlayerBounceAmmount`. The boolean `PlayerBounce` flag is separate:
it is bit 7 in the object-property `BitFlags` field.

Use these as authored prop-bounce/restitution values, not terrain friction.
`Boarder_ObjectPlayerBounceResponseCandidate` (`0x00125a08`) reads the
object-property float at `+0x04` and produces outgoing normal speed
`max(bounce * closingSpeed, 55.556 cm/s)`, leaving tangential speed unchanged.
The constant is the native universal 2 km/h outward floor.

Do not use `PlayerBounceAmmount` as the shove scale for Roller-activated mode-3 physics
props such as `Mdl_Barricade_CrashBagA`. The traced CrashBagA-style body branch
in `Boarder_ObjectCollisionProbeAndResponseCandidate` (`0x00125090`) computes a
rigid-body impulse and calls `PhysicsBody_ApplyImpulseAndUpdateVelocityCandidate`
(`0x00154350`) to write the object's body velocity/torque. That branch has a
fixed `1.3 * closingSpeed` impulse numerator and effective-mass denominator
terms; it does not read object-property `+0x04`.

Consumer note: `PropsCollision.obj` preserves placed-object indices
in its `o inst{N}_...` groups. Those indices map back to
`Instances.json`/object-property `BitFlags` bit 7 (`PlayerBounce`) and
`PlayerBounceAmmount`, so static prop colliders can be bucketed by the authored
flag/value. `PlayerBounce=false` preserves eligible contact dispatch but
suppresses physical rider response, as the dedicated cyan mode-1 lab control
confirmed. GARI has 20 unflagged proxy groups, but all 20 are exact-zero reset
zones; the five extracted retail levels contain no natural nonzero mode-1
flag-off instance, which is why the lab required a dedicated follow-up.
The flagged GARI groups bucket as `0.5` (2220) and `0.6` (359); the `0.2`
knockables and `0.03` jumbotron tier are not present in `PropsCollision.obj`.

Collision SHAPE by `CollsionMode` (resolved; see
`elf-map.md#prop-collision-shape-by-collsionmode`):
props with a proxy are `CollsionMode 1` and collide as their **triangle mesh**;
the no-proxy props collide as a coarse **volume**, never their render mesh —
`CollsionMode 2` (e.g. tree trunks) as a **ray-vs-AABB box**
(`WorldLine_IntersectAABBSlab` `0x0025e178`), and `CollsionMode 3` (signs,
jumbotrons, rocks, gateway arches/scaffolds, crash bags) as a **sphere-set**
body (`PhysicsBody_ContactProbeAgainstBoarderCandidate` `0x002399c8` ->
`PhysicsBody_SphereContactElementTest` `0x0023ac48`). The mode-3 sphere-set
payload is fully decoded (an RLE'd base-8 occupancy tree in
`PhysicsData.uPhysicsStruct0`/`UByteData`; layout in
`elf-map.md#mode-3-sphere-tree-payload-layout`).
Consumer implications: the computed-bounds **AABB** for a compact no-proxy
prop is *faithful in kind* (a coarse convex volume, not a render-mesh-shaped
collider), while the gateway/scaffold bodies decode as **hollow**
(opening empty), so snowknife derives ride-through "doorway" collision straight
from the body shape (`SsxPhysicsBodies.cs`); there is no per-prop ride-through
tag.

## Selected control-map findings

`DATA/CONFIG/BTNMAP0.DAT` and `BTNMAP1.DAT` are plain text. Their complete
retail mappings are intentionally not reproduced here; use the local extraction
and inspection commands in [`tooling.md`](tooling.md#extract-the-pal-boot-elf-and-config-files)
against your own disc when the full table is needed.

The findings relevant to the functional analysis are that Antic/jump uses X,
Boost and Tweak share Square, and Reset uses Select. The alternate map adds
left-stick axes for Spin, Flip, and their Prewind forms, and maps
`CameraReverse` to Triangle. Circle is not assigned to a riding control in
either map. Trailmap implementations choose their own input bindings; these
facts describe the retail configuration rather than imposing an API.

## `SNOW.INF` is audio, but it reveals runtime signals

`DATA/CONFIG/SNOW.INF` is a mini expression language for board-snow audio. It is
not physics tuning. It maps game variables into volume and pitch bend for
surface/sound modes:

- Surfaces/groups: `PACK`, `ICE`, `CHUTE`, `ROCK`, `METAL`, `POWDER`, `LOOSE`,
  `WOOD`, `RAIL`, `GLASS`.
- Motion/sound modes: `GLIDE`, `AIGLIDE`, `CARVE`.
- Runtime values: `Slip`, `Dig`, `Lean`, `Board`, `Bend`.

Those names are still useful for our model. SSX exposes at least:

- `Slip`: sideways skid / sliding amount.
- `Dig`: edge bite, carving force, or braking bite.
- `Lean`: rider/board lean during turn.
- `Bend`: board flex, also used for rail/wood/glass pitch bend.
- `Board`: available to the script language, though not used heavily here.

This supports modeling board feel as separate forward speed, lateral slip, edge
dig, lean, and flex terms rather than one generic velocity.

### Board-snow audio mapping

The ELF side of the board-snow audio path is now partially mapped. It compiles
`SNOW.INF` into a matrix of 10 material groups by 3 sound modes:

```text
groups: PACK, POWDER, LOOSE, ICE, METAL, WOOD, RAIL, ROCK, GLASS, CHUTE
modes:  GLIDE, AIGLIDE, CARVE
```

Important anchors:

| Address | Meaning |
|---:|---|
| `0x00211130` | loads `SNOW.INF` and compiles all group/mode programs |
| `0x0021acc0` | compiles one surface/mode script into bytecode |
| `0x0021b388` | evaluates one compiled script and outputs volume/bend |
| `0x0020fe00` | maps current `SurfaceType` to one audio material group |
| `0x00210fc8` | initializes the per-boarder board-snow audio nodes |
| `0x002101d8` | initializes the extra slip-style callback node |
| `0x00210540` | initializes the glide / alternate-glide sound node |
| `0x00210bb8` | initializes the carve sound node |
| `0x0021b938` | updates the extra slip-style callback |
| `0x0021ba00` | updates/evaluates the `GLIDE` program |
| `0x0021bb20` | updates/evaluates the `AIGLIDE` program |
| `0x0021bc10` | updates/evaluates the `CARVE` program |

The material-group map from `SurfaceType` is:

| SurfaceType | Surface label | Audio group |
|---:|---|---|
| 0 | reset / out of bounds | `POWDER` |
| 1 | standard snow | `PACK` |
| 2 | standard off track | `LOOSE` |
| 3 | powdered snow | `POWDER` |
| 4 | slow powdered snow | `POWDER` |
| 5 | ice standard | `ICE` |
| 6 | bounce / unskiable | `ICE` |
| 7 | ice / water no trail | `PACK` |
| 8 | glidy snow particles | `PACK` |
| 9 | rock / off track | `ROCK` |
| 10 | wall | `ROCK` |
| 11 | ice crunch no trail | `ROCK` |
| 12 | no sound small wake | `WOOD` |
| 13 | off-track metal | `METAL` |
| 14 | speed / grinding | `GLASS` |
| 15 | standard unknown | `PACK` |
| 16 | sand | `PACK` |
| 17 | no collision | `PACK` |
| 18 | show-off ramp / metal | `CHUTE` |
| 19 | unknown | `CHUTE` |

`SNOW.INF` has a `RAIL` group, but `SnowAudio_SurfaceTypeToGroup` does not
return it for normal terrain contact. Rail audio is therefore likely selected
by a rail-specific path, not by this terrain `SurfaceType` mapper.

The runtime values loaded by `SNOW.INF` map to these current getter candidates:

| `SNOW.INF` value | Current ELF read |
|---|---|
| `Slip` | absolute projection of boarder vector `+0x320` against motion vector `+0x150` |
| `Dig` | `abs(boarder +0x160)` |
| `Lean` | `abs(boarder +0x214 * 127.0)` |
| `Board` | `Slip / 4 + Dig * 2` |
| `Bend` | `Board + Slip` |

Measured live (the `AUTOTEST4` instrument fixture, run 20260806-232645): `+0x320` is a **unit vector** — its
magnitude reads exactly 1.0 on every surface, so it is the board's heading and `Slip` is the **lateral
residual** of the velocity against it (cm/s; 0 tracking clean, which sits the signal inside the programs'
`Bound 0,400`). Riding straight, `Dig` is a per-surface contact load far above the glide program's 280
threshold (pack ~401, metal ~543, chute ~308, ice ~361, rock ~358), and the loose surfaces slip on their
own: chute ~90 cm/s and rock ~69 against pack's ~6 — which drives the chute's glide bend to ~97/127 with no
stick input at all. `tools/autotest/audio_signals.py` reproduces the table from any instrument run.

The carving half, from a steered pass (`run.py --weave`, run 20260807-001204): holding an edge, Slip runs
~170–500 cm/s on pack/chute/metal and **550–840 on ice** — ice routinely exceeds the programs' 0–400 clamp,
which is what the clamp is for — while `Dig` COLLAPSES from its ~400 straight-riding value to ~90–220, so
it is a forward drive/bite force rather than plain load. The shared-block programs answer by handing the
bed to the carve row: median outputs while edging are **carve 85–90 / glide 0** on pack, chute and metal
(ice and rock carve ~59). The glide-vs-carve crossfade is therefore measured at both ends: clean chute =
glide 34 / carve 23 (self-slip alone), edged chute = glide 0 / carve 90.

`GLIDE`, `AIGLIDE`, and `CARVE` are continuously updated sound programs rather
than one-shot events. The update functions select the current material group,
run the compiled program, then pass volume and bend/pitch to the audio node.
Mode eligibility is keyed off boarder motion state `+0x424`: `GLIDE` and
`CARVE` skip state `1`, while `AIGLIDE` only evaluates for states `2` and `3`.
There is also an extra slip-style callback at `0x0021b938` that only runs when
`+0x424 == 2`; it maps `Slip` through sound-system curve ids `5` and `6`.

Board-snow output is muted when boarder `+0x5ae4` is nonzero. Clearing that flag
through `0x0011f448(a1=0)` sets a short fade counter at `+0x5af0` to `5`. The
update callbacks call `0x0011f470`, which decrements that counter and divides
the computed volume by it while nonzero. So the board sound can hard-mute during
transitions, then fade back in over about five frames instead of popping.

The decoded `zboard.bnk` layout matches an 8-slot material group stride. The
main continuous layers are:

```text
CARVE   node: zboard[group * 8 + 3]
GLIDE   node: zboard[group * 8 + 4] when boarder +0x41c == 1
AIGLIDE node: zboard[group * 8 + 6] otherwise
```

`+0x41c` is not semantically named yet. Current evidence only says it chooses
the normal glide branch (`+4`, with carve also initialized) versus the alternate
glide branch (`+6`).

The decoded GARI bank orders its ten groups as `PACK`, `POWDER`, `LOOSE`,
`ICE`, `METAL`, `WOOD`, `RAIL`, `ROCK`, `GLASS`, and `CHUTE`, indexed from
zero. Combined with the formula above, that order reconstructs every loop slot
without reproducing the retail slot table. The `GLASS` alternate-glide slot is
the one missing loop entry. Most groups also have short sounds at
`group * 8 + 1`, `+2`, and `+5`; their exact one-shot/event use remains
unresolved, and `group * 8 + 7` is empty in the decoded GARI bank.

The decoded evaluation model is:

```text
audioGroup = SurfaceTypeToSnowAudioGroup(surfaceType)
if boarderAudioMuted:
    drive all board-snow outputs to zero
else if modeState == 1:
    board-snow GLIDE/CARVE are silent
else if normalGlideBranch:
    run GLIDE continuously from slip/dig/lean/bend
    layer CARVE from lean, dig, and slip
else:
    use AIGLIDE / alternate glide from slip/dig/lean/bend only for modeState 2 or 3
```

The script formulas are surface-family specific:

| Group family | Main behavior |
|---|---|
| `PACK`/`ICE`/`CHUTE`/`ROCK`/`METAL` | glide volume mostly from `Slip` and high `Dig`, with `Lean` reducing glide; carve adds lean, stopping dig, and low-speed slip texture |
| `POWDER`/`LOOSE` | glide volume mostly from `Slip`, carve volume from `Lean + Dig`, bend from `Slip` or `Lean` |
| `WOOD`/`RAIL`/`GLASS` | all modes use simple `Slip` volume and `Bend` pitch mapping |

## Prop collision sounds from ADL and `BANKS.INF`

The extracted `.adl` files carry per-instance sound rows keyed by world-instance
hash. `SSX-Library` currently exports these as `IncludeSound`, `Sounds.CollisonSound`,
and `Sounds.ExternalSounds[]`.

ADL file layout from `ADLHandler`:

| Field | Meaning |
|---|---|
| header byte | must be `0` |
| header float at `+0x04` | version, observed/required `1.0` |
| header int at `+0x08` | hash sound row count |
| hash row `+0x00` | instance hash |
| hash row `+0x04` | file offset to shared `SoundData` |
| `SoundData+0x00` | `CollisonSound` event id |
| `SoundData+0x04` | `ExternalSoundsCount` |
| external record | variable by `U0`: type 0=`0x1c` (`U2..U6`), type 1/2=`0x30` (`U2..U11`), type 3=`0x18` (`U2..U5`) |

`IncludeSound` is therefore an exporter/build flag for "this instance had an ADL
hash-sound row." The ELF links that row onto the runtime world entity at
`entity+0xf4`, which becomes the actual collision sound gate.

The observed GARI section confirms the group roles described in
spec:260-banksinf; its course-specific group-2 bank is `garibaldi1.bnk`.
The complete retail section and its original formatting are intentionally not
reproduced here. Inspect a locally extracted `BANKS.INF` when source evidence
for every shared-bank assignment is needed.

The ELF remaps ADL `CollisonSound` event ids through
`AudioSoundEventId_ToGroupAndSlotCandidate` (`0x0022ddb8`). Normal prop collision
ids resolve to group `2`, and the `BANKS.INF` parser loads group `2` from the
course `BANK` entry — `garibaldi1.bnk` on GARI, `mesabanca1.bnk` on MESA. The
value in ADL is not the final BNK slot.

The resolver's jump table at `0x003a2870` is indexed by `id - 2` for ids
`2..182`. Entries pointing at the "skip slot write" tail `0x0022e12c` are
unmapped and therefore authored-silent. Snowknife recognizes this resolver's
instruction shape, follows each handler in the user's boot executable, joins
its group to that disc's `BANKS.INF`, and writes the result into the extracted
map's `Audio/SoundIndex.json`. Neither Trailmap nor an implementation repository
keeps a second complete copy of those generated rows. spec:190-collision-event-map

Example GARI materials: `6` rock→032, `7` tree leaves→050, `12` bushy
leaves→051, `18` chain-link fence→019, `23` jumbotron→022, `25`
billboards/signs→018, `31` metal rail→016, `39` crash bag→017, `58` path
marker→000, `63` LCD→064, `64` speakers→023, `72` tree trunk→049, `78`
(Mesa's `bridgesurface` wood)→053.

A course bank is sparse but slot MEANINGS are shared across levels (the event
map is global). A level's bank ships only the subset its course references —
when an id's slot is empty in that bank the game plays nothing (verified: no
fallback; e.g. MESA's `Bomb_Event` `SoundPlay 83` against `mesabanca1`'s empty
slot 83). Checking for the raw ADL ids inside a bank gives false negatives; the
event-id remap happens first.

The collision rule is not just flat playback. The traced ELF path gates on
`entity+0xf4`, computes an impact/velocity scalar from the boarder's carried
velocity, clamps it to `0..127`, plays a positional one-shot, then registers a
per-object debounce record for `currentTick + 50`. `ExternalSounds[]` is handled
by a separate ADL spatial/ambient-emitter path. Type 0 is now fully traced as a
continuing point emitter: center = instance position + `U2/U3/U4`, `U5` = range,
and `U6` selects one of six falloff curves. Event ids 97–99 are the native crowd
emitters (Crowd-bank slots 0–2); all observed crowd records are type 0 / curve 2
(linear). Fixed environmental event ranges resolve instead through the ELF's
group-6 `eventId-79` table to named global banks such as `Bird_Owl.bnk`,
`Coyote.bnk`, `Snowmachine.bnk`, and `Waterfall.bnk`; events 95/102/134 are
context-dependent exceptions. See `specs/420-audio-runtime.md` for the complete
event→bank table, remaining type shapes, and census.

## Model object animation (`Models.json`) — the world-prop clip format

A model that animates (the Mesa swinging bridge, falling trees, the minecart, gem
spins) carries its clip in `Models.json`, played at runtime by the SSF `AnimObject`
node (`type0 Sub256`; ELF map "World-prop model animation"):

| Field | Meaning |
|---|---|
| model `AnimTime` | clip length in **30 fps frames** (bridge: 90 = 3.0 s) |
| `ModelObjects[].ParentID` | object hierarchy |
| `ModelObjects[].Position/Rotation/Scale` | the object's **rest transform** — the frame its own meshes are stored in |
| `Animation.U1-U3` | **animation base** translation (model units, raw) |
| `Animation.U4-U6` | **animation base** Euler, **radians** |
| `Animation.AnimationAction` | **channel bitmask** — channels in bit order: bits 0-2 = X/Y/Z translation, bit 3 (value 8) = X-rotation, bits 4/5 = Y/Z-rotation; one `AnimationEntries[]` per set bit |
| `AnimationMaths` | piecewise-cubic segments: `V1-V4` = cubic coefficients (Horner), `V5/V6` = segment time window in **seconds** |

The sampled channel value is the **full local pose component** (rotation channels in
**degrees**), replacing — not offsetting — the corresponding component. Evaluation is
at absolute clip time, clamped to the segment window outside it. spec:120-model-anim

**Meshes are stored in their own object's frame, not model space.** Two independent
lines, because a single example does not settle it:

*Census.* Of the 6229 mesh-bearing sub-objects across the five levels, 692 (11.1%)
carry a non-identity rest transform, and 673 of those have a rest offset large enough
to discriminate. Classify each by where its vertices sit — near its own origin
(object-local) versus near its accumulated rest position (mesh already in model
space, rest transform a bare pivot). Using the MEDIAN vertex distance: **311
object-local, 0 pivot-shaped, 362 neither** — the last being meshes legitimately
offset within their own frame (SNOW's balloon animals ride a long string). Not one
sub-object in the corpus has its geometry sitting on its own rest position. SNOW
`Mdl_SnowBlower_Top_1000` obj1 is the crispest positive case: rest `Position`
`(-0.0006, -111.802376, -0.4116)` against `43.obj` centroid `(0.00, 0.02, 0.25)`.

Use the median, not the centroid. A centroid classifier reports one apparent
counter-example — MERQUER `Mdl_Helicopter_PoliceANIM_0` obj2, accumulated rest
`(0, 481.0, -369.2)` against mesh centroid `(0.0, 481.7, -348.2)` — which is an
artifact of a DISJOINT mesh. Observed in play, the prop is exactly what its name
says: a police helicopter hovering with its rotor disc turning above it and a
searchlight sweeping below. obj3 (12 verts, a flat ±952 plane rotating about Z) is
the blurred rotor billboard; obj2 is the searchlight, and a searchlight is a compact
housing plus a beam reaching far away from it — 78 of its 114 vertices lie within 257
units of the object origin and the remaining 36 are ~1400 units out, so the centroid
of the two lands in empty space that happens to fall near the rest offset. A median
is immune.

**The `MaterialName` in an extracted `Materials.json` is attached to the WRONG record.**
`TrickyLevelInterface` zips the `.map` linker names onto the PBD table positionally
(`TempMaterial.MaterialName = mapHandler.Materials[i].Name` against
`pbdHandler.materials[i]`), and the two lists are not parallel. So
`Mdl_Building_SkyCorner4_4` reads as `Flip_LcdSign_0`, and the police helicopter reads
as `craneblinn` / `lightsspotblinn` / `lightpolesewerT` — names belonging to a crane and
a sewer lamp elsewhere in the level, which is the tell. Until the extractor aligns
properly (below), ignore the field and identify a sub-object from its texture page and
geometry (`0181.png` rotor, `0182.png` searchlight, `0183.png` body here), confirmed in
play. Everything else in the record — `TexturePath`, `TextureFlipbook`, `UnknownInt18` —
comes from the PBD and is sound. spec:170-no-name

*The engine composes the ABSOLUTE accumulated pose, not a delta from rest.* This is
what forces the frame, and three independent lines agree.

Retail data alone settles it on MERQUER `Mdl_Helicopter_PoliceANIM_0`. Its searchlight
(obj2) has rest position `y = 481.0, z = -369.2`; the fuselage skin at that station
(body vertices within 90 units of `y = 481`) runs `z = -370.2` underside to `-162.7`
topside. The absolute-pose reading therefore mounts the searchlight housing **flush to
the belly under the nose, 1.0 unit off the skin** — where a police helicopter's
searchlight belongs, and observed there in play. The delta reading would place it at
the model origin, which at mid-cabin lies between an underside of `-347.6` and a
topside of `43.2`: inside the fuselage. A 1-unit agreement is not available to
coincidence. (`+y` is the nose: the body's half-width falls to 0 by `y = -1057`, the
tail fin.)

A canary then measured the same thing directly, in both directions. A disc authored
with a moving part's geometry left in model space while its object carried a rest
matrix rendered that part displaced by **the rest translation itself** — the signature
of a double application, which a delta engine cannot produce. Rebuilding the same part
with its geometry expressed in the object's own frame rendered it correctly. A delta
engine would have inverted both outcomes. spec:120-object-frames

A third line was tried and yielded nothing: a mesh file instanced by two sub-objects
at DIFFERENT rest transforms would be decisive (under model-space geometry the two
copies would coincide, which is pointless), but retail authors none — 0 across 5,483
models.

**Rotation comes from the channels alone.** An animated sub-object's rotation is
built entirely from its curves. The object's own rest `Rotation` is never read.
`Animation.U4-U6` — the Euler triple beside the base translation — is read but
arrives crippled by a double unit conversion: `MeshAnimRecord_Bind` (0x001cb5d0)
copies `U1-U3` verbatim yet passes `U4-U6` through ×π/180 although the disc already
stores them in RADIANS, and `MeshAnimRecord_BuildLocalMatrix` (0x001cb990) converts
again. An unchannelled component therefore contributes its authored angle scaled by
(π/180)², about 1/3283 — an authored 90° arrives as 0.0274°. Treat it as zero.
`U1-U3` (base translation) IS applied normally, and that is measured rather than inherited: retail and every other canary set base translation equal to rest translation, so a dedicated canary was authored with them 200 units apart — sub-object rest (0, 0, 200) against base (200, 0, 200), no translation channel — and its live `rec+0x4c` reads (200.000, 0.000, 200.000). The base wins; the rest transform is no more consulted for translation than for rotation.

`MeshAnimRecord_SampleChannels` (0x001cb7f8) walks bits 0..15 of the action mask and
writes channel *i* to `rec+0x4c+4i` only when the bit is set, which is the mechanism:
an unchannelled slot simply keeps the vestigial bound value.

Three authored PCSX2 canaries establish it, each designed so the read is a
sweeps-or-stays judgement rather than an angle estimate:

- a **gnomon** with three arms along its local +X/+Y/+Z, base Euler (90, 90, 90) and a
  CONSTANT 90 on bit 3, landed its arms at +X / +Z / −Y — exactly `Rx(90)`, i.e. the
  channel alone, with the (90, 90, 90) base absent;
- an **arm** with base (0, 90, 45) and a ramp on bit 3 swept about a cardinal axis;
  an applied base would have tilted that axis 45° (and does, in a renderer that
  applies it — the editor and the disc differed by exactly that);
- a **three-arm prop** where two arms carried 90° of base on DIFFERENT components with
  a ramp on bit 3: both stayed pointing down their stored +X axis, spinning in place.
  No applied base permits that — only an X-axis base leaves +X fixed, and the two arms
  had their 90° on different components.

Retail cannot contradict it, and does not: across ELYSIUM/GARI/MERQUER/MESA/SNOW,
**0 of 117** animated sub-objects carry a non-zero base rotation component without a
channel on it. Every non-zero rotation retail authors is channelled, so the stored
Euler is always redundant — which is why it reads as load-bearing and is not. The
same rule explains an earlier canary in which an aim quaternion written to a
sub-object's rest `Rotation` was ignored and the part turned about a plain model axis;
that is also why an arbitrary-axis turn must hang its tilt on an unanimated PARENT,
whose rest transform is honoured. spec:120-anim-base

**A mesh-less sub-object carrying a rest transform is honoured**, though retail
never ships one: all 125 mesh-less sub-objects across the five levels are bare
roots with null `Position`/`Rotation`/`Scale`. A canary disc placed a matrix-only
mesh-less node between a static root and an animated child and the engine composed
it normally. spec:120-meshless-node

That capability still consumes an object slot. Live boundary tests below establish
that an animated model is safe through **27 total native `ModelObjects`**, counting
the static root and mesh-less mounts as well as moving objects. The 28th corrupts
the matrix-composition stack rather than being ignored. spec:120-model-object-limit

**The bitmask is not minimal.** SNOW `Mdl_SnowBlower_Top_1000` obj1 sets
`AnimationAction 56` (all three rotation bits) over a 15-frame clip but authors flat
zero curves on X and Z, leaving one live Y term of `719.28125` deg/s — one turn per
0.5 s, i.e. 2 rev/s. Its base is exactly its rest (`U1-U3` reproduce `Position`
digit for digit, `U4-U6` are zero against an identity `Rotation`), which is the
frame-0 continuity every retail clip holds.

Census method for the four claims above: walk `Models[].ModelObjects[]` in
`Maps/<LEVEL>/Models.json` (SSX-Library extraction) where the model's `AnimTime > 0`;
mesh centroids read from the paired `Maps/<LEVEL>/Meshes/<n>.obj`. Levels
ELYSIUM / GARI / MERQUER / MESA / SNOW.

**Composition order is ZYX** — Rz outermost, then Ry, then Rx.

Because an unchannelled rotation component is zero, a sub-object with ONE live
channel is a single-axis rotation, identical in all six orders; that is why no earlier
canary and no shipped level could separate them. The settling canary therefore carried
three sub-objects each with TWO constant channels at 90° and the third component left
unchannelled: pairs (X,Y), (X,Z) and (Y,Z). Each pair poses its arm to a different
cardinal direction per candidate order, so the three arms together spell a 6-way
signature. Observed: arm 1 vertical, arm 2 horizontal at +Y, arm 3 vertical — matching
ZYX alone, and uniquely so even without resolving up from down (no other order leaves
both the first and third arms vertical).

Retail agrees as far as it can. MESA `Mdl_MineCart_RustedANIM_3000` obj2 is the only
shipped multi-channel rotation (live X and Z, Y zero); its rest matrix reproduces its
channel pose under {YZX, ZXY, ZYX} — the three orders that coincide whenever Y is
absent — and ZYX is among them.

An earlier attempt to narrow the order from retail data compared each object's rest
quaternion against `U4-U6` under all six orders and appeared to exclude XYZ/YXZ/XZY.
That test was void on two counts: it assumed the stored Euler is the pose, which it is
not, and 19 of its 20 objects are single-axis, so its entire discriminating power came
from that one mine cart. It happened to point at the right family for the wrong reason.
spec:120-euler-order

The bridge shows the composition pattern: objects 2–6 all parent under object 1 as
concentric bands of the span, each with the same curve shape at growing amplitude
(±2.45° at the anchors → ±10° mid-span), so the whole deck rolls about the anchor
line with the middle swinging widest. A prop that needs synced collision ships as
two stacked instances — a visible mesh with no collision and an invisible
`CollsionMode 1` twin whose proxies (`Collision/<n>.obj`) mirror the render
objects (`Meshes/<n>.obj`) 1:1 — both driven by identical `Sub256` nodes from one
persistent effect chain.

## Material names and the linker map

A PBD material record (`TrickyMaterial`) has no name member. Names ship only in the
build's `.map` linker sidecar, whose `MATERIALS BEGIN` block holds fixed-width rows of
`Name / UID / Ref / HashValue`. Retail `.map`/`.pbd`/`.ssf` for 12 levels are on disk
under `temp/patch-trailer-retail/<LEVEL>/data/models/`. spec:170-no-name

Neither extra column is an independent key. `UID` is the row index (contiguous
0..N−1). `HashValue` is `bxStringHash(Name)` — reproduced on all 1821 MATERIALS rows
across 10 retail levels, 0 mismatches. And nothing on the PBD side can serve as one:
profiling all 218 MERQUER records, every non-texture field has cardinality 1–4
(`UnknownInt2`/`UnknownInt3` are −1 throughout, `UnknownFloat5` is 92125.6 throughout).
The PBD hash-table block covers only instances and lights — MERQUER reads
`CountInstances=4445`, `CountLights=934`, and 0 for the other four — so materials are
not hashed at all.

**The map list is an order-preserving SUPERSET, and that is the whole story.** Every
other map block is exactly 1:1 with its PBD table across all 10 levels
(MODELS/PATCHES/INTERNAL INSTANCES/PARTICLE INSTANCES/SPLINES/LIGHTS); MATERIALS never
is — 259/218 MERQUER, 176/115 ELYSIUM, 219/126 GARI, 225/158 MESA, 189/110 SNOW. The
surplus is terrain: the PS2 PBD flattens a patch's material to a bare texture index
(`Patch.TextureAssigment`) and drops the record, while the linker still lists it, and
the unmatched names are duly terrain-shaped (`mainLeft_SN`, `powder_SN`, `conctrete_SN`,
`Tex_Snow_Track_*`, `MesaMaterial_*`). Order survives: the offsets between
flipbook-bearing records and their `Flip_*` names are monotone non-decreasing in every
level (MERQUER +20 ×8 then +34; MEGAPLE +33 ×5; ALOHA +31 ×4, +33 ×6, +71 ×4; GARI +28,
+31, +34, +60, +64, +77) — interleaved insertions, not a permutation.

**`Ref` is the authored reference count**, and it is what makes the alignment
tractable. `MapHandler` parses it and `TrickyLevelInterface` then discards it. Measured
identity, exact on five levels:

| level | Σ Ref | NumPatches | mesh→material refs | sum |
|---|---|---|---|---|
| MERQUER | 4696 | 2731 | 1965 | 4696 |
| ELYSIUM | 5294 | 4268 | 1026 | 5294 |
| GARI | 4709 | 3885 | 824 | 4709 |
| MESA | 3730 | 2448 | 1282 | 3730 |
| SNOW | 3266 | 1653 | 1613 | 3266 |

So for a PBD material *i* sitting at map row *j*, `Ref[j] ≥ meshUse[i]` is a hard
constraint, with equality for the mesh-only majority.

**Recovering the join.** An order-preserving alignment (DP) of the PBD table into the
map list under that constraint, scored on `Ref[j] == meshUse[i]` plus a model-name term
(a map material named `Mdl_X_…` should be worn by a mesh of model `Mdl_X_*`), pins
**676 of 723 materials (93.5%)** across the five levels. Acceptance test — a `Flip_*`
name must land on a record carrying a `TextureFlipbook` — gives **60/63 correct with
zero false positives**, and all 63 correct names appear in the candidate set. The two
scoring signals are independent (reference counts vs. name/mesh ownership) yet their
separately computed alignments agree on 97–100% of positions. The current positional
join scores 20/63 with 28 false positives, and on model-name agreement 52 ok / 113 bad
(MERQUER: 0 ok / 53 bad).

Residual ~6.5% are runs of `Ref==1, meshUse==1` mesh-only materials adjacent to a
dropped patch material, which counts cannot separate. The windows are local (≤15 rows)
and enumerable, so an extractor should emit a name plus an ambiguity flag rather than
guess. A purely derived constraint system (adding "if no patch uses this material's
texture, `Ref` must equal `meshUse` exactly" — true for 193/218 MERQUER materials) is
exactly feasible for MERQUER but needs slack on the other four, so it does not stand
alone.

Incidental, from the same pass:

- `CONTEXT BLOCKS` is the `materialBlocks` table — count equals `NumMaterialBlocks`
  equals `NumModels` on all 10 levels, every row literally `NO NAME` with `UID` = index.
- `INTERNAL INSTANCES` and `PARTICLE INSTANCES` rows carry a 5th column at char offset
  112, `SCROLL` / `NOSCROLL`, documented in their own header rows; `ReadBlock`'s fixed
  82/10/10/10 slicing discards it. A possible cross-check against `Scroll.json`.
- Map header line 11 records the authoring path: a `## START [...]` row carrying the
  course's art directory on the build machine that produced it, level name repeated as
  the leaf. Useful only as a level-identity cross-check.
- Record sizes confirmed by independent parse: `TrickyMaterial` 72 bytes, `Patch` 448.

## Runtime animation records (PAL, read live over PINE)

PCSX2's PINE socket (127.0.0.1:28011) makes the engine's own computed matrices
readable while paused, which turns an authored-canary experiment from a repack cycle
into a direct read. Measured on **SLES-50545** (PAL Europe) under PCSX2 v2.6.3; the
addresses are that build's. PINE accepts ~40,000 batched `Read64` commands per message
(120,000 fails), giving ~100 MiB/s — a full 32 MB EE snapshot takes about 1.5 s, so
dump once and work offline. spec:120-anim-base; spec:120-euler-order

The instance hash table is at **0x012c7a40**, 3518 entries of `(entityPtr, hash)` sorted
ascending by hash — what the resolver at 0x002555f8 binary-searches. Validated against
the universal markers `Mdl_StageArea_Start_0` = 0x0091f640 and `Mdl_StageArea_Finish_0`
= 0x0fc656e0.

`AnimObject` / `AnimDelta` nodes are found by scanning for their vtables at `node+0x38`
(0x0038d8c0 / 0x0038d7c8):

| offset | meaning |
|---|---|
| `+0x08` | loop mode; `+0x0c` clock gate |
| `+0x20` | per-frame step (s); `+0x24` clip time (s); `+0x28`/`+0x2c` window |
| `+0x58` | world entity; `+0x5c` animated-object count; `+0x60` → record array |

`entity+0xc0` = model, `entity+0xe8` = flags (bit 2 set while installed). `model+0x04` =
ModelObject count, `model+0x08` = array at stride 0x18, `modelObject+0x10` → Animation
record or 0. The record array allocation is `[u32 count][records…]` and `+0x60` points
past the count.

**Per-object record, 0xD0 bytes, one per animated ModelObject in object order:**

| offset | meaning |
|---|---|
| `+0x48` | source Animation record |
| `+0x4c` / `+0x50` / `+0x54` | live translation X/Y/Z (channels 0-2) |
| `+0x58` / `+0x5c` / `+0x60` | live rotation X/Y/Z, **degrees** (channels 3-5) |
| `+0x90`..`+0xcf` | computed 4×4 local matrix, row-major, row 3 = translation |

`+0x90` is the consumed matrix, not scratch: 0x001cbb50 loads it into vf8-vf11 and
VU0-multiplies by a parent matrix.

### Animated-model object ceiling

The PAL model composition routine `sub_00199818` @0x00199818 allocates a fixed
**0x7c0-byte stack frame** and loops over `model+0x04`, the total native
`ModelObject` count. It writes a 0x40-byte composed matrix for every object into an
array beginning at `sp+0x20`, with no count check:

- indices 0–26 (27 objects) occupy `sp+0x20..sp+0x6df` and are safe;
- index 27, the 28th object, begins at `sp+0x6e0` and its final row overwrites
  live locals at `sp+0x710..sp+0x71c`. In the frozen canary snapshot the working
  entity/pointer at `sp+0x71c` had become the matrix homogeneous term
  `0x3f800000` (`1.0f`);
- index 28, the 29th object, begins at `sp+0x720` and also overwrites the saved
  `s0`–`s3` region.

Four authored canary boots locate the same boundary independently of topology:

| authored shape | packed native objects | result |
|---|---:|---|
| flat 13-rung ladder | `1 + 2×13 = 27` | runs |
| flat 14-rung ladder | `1 + 2×14 = 29` | freezes |
| nested 25-link chain | `25 + 2 = 27` | runs |
| nested 26-link chain | `26 + 2 = 28` | freezes |

PINE caught the highest link/rung already posed in every diagnostic snapshot: the
working depth-25 top link was at 235.9989°, the failing depth-26 top link at
337.9997°, and the failing flat-14 top rung at 68°. Thus channel sampling and the
26-deep parent chain both complete; the freeze happens afterward when
`sub_00199818` composes one matrix per native object. The invariant is therefore
**27 total packed native objects**, not 27 animated records, 25 levels of hierarchy,
or a global animation-record budget. spec:120-model-object-limit

This also rules out the earlier apparent ~48-record global ceiling. A duplicate-
canary build froze with 14 live players / 55 animated records, and removing the
duplicates worked with 13 / 43; however, the working depth-25 boundary build had
13 live players / **56** records. Total animated-record count therefore was not the
cause. Whether 14 simultaneous players exposes a separate limit, or that build
failed for another reason, remains unresolved and is independent of the per-model
27-object ceiling above.

**Identify props structurally, not by name hash.** `bxStringHash` is a 28-bit ELF hash
and reversing entity hashes back to `Import_<i>_<slug>` names proved unreliable — 101 of
238 candidate names collided, and two apparent matches were demonstrably wrong against
the geometry. Base translations plus channel masks are unambiguous and were enough to
pin all five `zz euler *` canaries and three snow guns.
