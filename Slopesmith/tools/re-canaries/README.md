# RE canaries

Authored props that answer a question about the PS2 engine's animation or render runtime.

Retail content cannot answer these questions. Every shipped clip channels every non-zero rotation it
authors, so the cases that would separate one hypothesis from another simply never occur in the
data — the only way to find out is to author the case and look at it. That is what these are.

They are hand-built `PropModelAnimation` clips, not recipe output: arbitrary base poses, constant
channels, several live channels on one sub-object. None of it is expressible through
`importedSpinAnimation`, and it only reaches the disc because the export and the ISO packer carry a
clip verbatim (`docs/032-imported-props.md`).

```
npx tsx tools/re-canaries/make.ts               # write all of them into the Custom prop library
npx tsx tools/re-canaries/make.ts euler-order   # or just one
```

Then place them in a level, export, repack, and read them. Every read below is **yaw- and
scale-independent**: the reference body carries a long thin **NOSE** bar along model +X and a low
wide **FIN** slab along +Y, and the answers are given relative to those.

Better, if PCSX2 is running with PINE: read the engine's own computed matrices instead of judging by
eye — see `Trailmap/tools/pine`. `node anim-nodes.mjs` lists the live nodes; the canaries are
identified by their base translations and channel masks (not by name — see that README).

## The canaries

### `lighting-gnomon` — texture page, light record, or normals?

A fixed six-face normal control using retail GARI `0037.png` (snow), never an encoded Custom page. On GARI it
stays in its native slot; on any other target it is copied verbatim from GARI. The stand keeps ordinary 0..1
UVs, so its mottled snow remains a visible texture-detail/upload control. The six cardinal cards alone are
pinned to the centre of the page's quiet `(75,93)` snow texel (decoded RGB about `221,231,233`), making each
one a flat measurement swatch independent of texture-detail noise.

Place two copies beside the suspect prop. Leave one normally lit and enable **self-lit (ignores sun)** on the
other. At yaw 0 with Slopesmith's default sun, the `+X` plate at the long NOSE and the `+Z` top plate take strong
key light, the opposite `-X` / underside `-Z` faces are ambient-only, and the two Y plates are close to neutral.
At any other yaw the same WORLD-facing sides must remain lit in SlopeSmith and PCSX2: export inverse-rotates
the sun into the placement's model-local record. The exact tint is unimportant; the categorical face pattern
and the self-lit control are the reads.

| PCSX2 result | isolated cause |
|---|---|
| donor gnomons match Slopesmith; imported prop is dark/corrupt | custom page/upload path — first rebuild with `--texture-type2` and check the dry-run VRAM total |
| self-lit donor is bright; normally lit donor disagrees with Slopesmith | instance-light magnitude/vector or packed normals, not the texture page |
| normally lit donor selects the opposite cardinal faces | normal or `LightVector1` sign/frame mismatch |
| even the self-lit donor is uniformly dark | global GS blending/output path, not model normals or per-instance lighting |

The self-lit copy ships retail's measured control record: ambient 256, no directional key. The normal copy
ships the same per-instance ambient/key/vector law as every authored prop. Because both wear the same verbatim
retail texel, their per-channel ratio is lighting alone. The expected screen multiplier is
`clamp((ambient + max(0,N·L)·key) / 256, 0, 1)` in byte/sRGB space; do not compare it with a linear-light
Lambert renderer.

### `euler-gnomon` — does the stored base pose participate?

Three arms along local +X (short, fat), +Y (medium) and +Z (long, thin). Base Euler says
(90°, 90°, 90°); a single **constant** channel on bit 3 says X = 90°.

Landing on exactly `Rx(90)` — short arm at the nose, medium arm UP, long arm away from the fin —
means the base did not participate and the channel alone posed it. **That is what happens.**

### `euler-bits` — which axis does each rotation bit drive?

Three arms, base zero, one ramp channel each on bits 3 / 4 / 5. With a zero base each arm is one
plain axis rotation, identical in every composition order, which isolates the bit→axis mapping.

| the arm | that bit drives |
|---|---|
| holds still, only its fin twirls | X |
| sweeps a vertical circle | Y |
| sweeps a flat horizontal circle | Z |

Result: bit 3 = X, bit 4 = Y, bit 5 = Z.

### `euler-order` — in what order does a multi-channel rotation compose?

Three arms, each driving **two** constant 90° channels with its third component unchannelled: the
pairs (X,Y), (X,Z) and (Y,Z). Each pair sends its arm to a different cardinal direction per
candidate order, so the three together give a six-way signature.

| bottom | middle | top | order |
|---|---|---|---|
| FIN | UP | FIN | XYZ |
| FIN | UP | DOWN | XZY |
| DOWN | UP | FIN | YXZ |
| DOWN | FIN | FIN | YZX |
| FIN | FIN | DOWN | ZXY |
| DOWN | FIN | DOWN | **ZYX** ← observed |

Note the observed row is identifiable even without telling UP from DOWN: no other order leaves both
the bottom and top arms vertical, which matters because a vertical arm overlaps the mast.

### `translation-source` — where does an animated object's translation come from?

Rotation is settled: it ignores both the base and the rest transform. Translation is not — every clip
we have, retail and canary alike, sets base translation equal to rest translation, so the two have
never been separated. This one makes them differ by 2 m. The marker is stored (and drawn) at its rest
position `(0, 0, 200)` while its base says `(200, 0, 200)`, and a slow spin makes it obvious the
object is animated at all.

| where the marker sits | translation comes from |
|---|---|
| above the mast, where it is drawn | the **rest** transform |
| 2 m out toward the **nose** | the **base** ← observed |
| down at the plinth | it is **zero**, as rotation is |

Read over PINE rather than by eye — `node anim-nodes.mjs <node>` prints the live translation at
`rec+0x4c`..`+0x54` directly, naming the answer with no spatial judgement at all. It reads
`(200.000, 0.000, 200.000)` against a rest of `(0, 0, 200)`: **the base wins.** Translation is
therefore unlike rotation, which ignores the base entirely, and Slopesmith's existing behaviour was
already correct.

### `object-count` — how many animated objects will one model carry?

Retail's largest animated model is MESA's `Mdl_bridgesway_3000` at **7 objects, depth 3**, and
`120-objects.md` states no bound — so anything wanting a dozen independently moving parts is asking a
question the shipped data cannot answer.

A ladder of bars, each its own object parented to the root, each holding a constant 90° Z channel. A posed
rung points at the **FIN**; one the engine skipped is left at its rest, pointing at the **NOSE**. The
boundary between fin-bars and nose-bars is the answer, read as a count rather than an angle. The top
rung sweeps instead of holding, so a clip that never played at all is distinguishable from one that hit
a ceiling — if nothing sweeps, nothing ran.

The canonical exporter omits an identity placement mount, so this identity-framed probe packs exactly
as one root plus *n* rungs. A real non-identity frame still gets the unanimated mount the native player needs.

### `object-depth` — how deep will the parent chain go?

The same question along the other axis: each link hangs off the one below. Every link turns a constant
90° about Z and its offset to the next is *along* Z, so the offset is invariant under its own rotation —
the column stays dead vertical while the bars fan into a four-fold helix, link k pointing at 90k°.

A spiral staircase that straightens into a plain ladder made skipped links unmistakable. With its identity
placement frame, *n* links pack as *n* + 1 native objects.

### Sizing the two ladders

The boundary is now settled: an animated model works with **27 total packed native objects** and corrupts
the runtime's matrix-composition stack at **28**. This is a total-object budget, not an animated-object or
hierarchy-depth budget. Static roots and mesh-less mounts count.

| canary | authored size | packed native objects | result |
|---|---:|---:|---|
| `object-count` | 26 rungs | `1 + 26 = 27` | safe edge |
| `object-count` | 27 rungs | `1 + 27 = 28` | failing edge |
| `object-depth` | 26 links | `1 + 26 = 27` | safe edge |
| `object-depth` | 27 links | `1 + 27 = 28` | failing edge |

The defaults are the two last-known-good boundary shapes. Pass a size explicitly to reproduce either
side without rewriting the other canary:

```
npx tsx tools/re-canaries/make.ts object-count=26 object-depth=26 # safe edge: both pack to 27
npx tsx tools/re-canaries/make.ts object-count=27                 # exact failing edge: 28
npx tsx tools/re-canaries/make.ts object-depth=27                 # exact failing edge: 28
```

PINE sees the highest animated object sampled before the failure. The failure comes afterward, when the
runtime writes one 0x40-byte composed matrix per native object into a fixed workspace; its 28th matrix
overwrites live state. Canonical export omits identity mounts, so every entry in these probes is
load-bearing.

This result does **not** establish a global animated-record budget. One working build carried 56 animated
records across 13 players, exceeding an earlier frozen duplicate-canary build's 55 records. The possible
separate significance of 14 simultaneous players remains unisolated.

Re-running rewrites a canary **in place**, keeping its model number, so props already placed in a
level pick up the new geometry instead of being orphaned against a fresh copy.

Two earlier props may also be sitting in the library — `zz-euler-canary` and `zz-euler-precedence`.
They are not reproduced here: both were designed around the assumption that the stored base pose is
applied, which turned out to be false, so their readings could not be interpreted until the three
above had settled the question. They are superseded, not load-bearing.

## What they established

Written up in [Trailmap: 120-objects]:

- an animated sub-object's rotation comes from its **channels alone**; the rest rotation takes no
  part, and the stored base Euler is read as degrees when the disc holds radians, so it arrives
  scaled by (π/180)² — an authored 90° becomes 0.027°, i.e. nothing;
- multi-channel rotation composes **ZYX**;
- a turn about an arbitrary axis therefore cannot be aimed on the moving sub-object at all — the
  tilt has to go on an unanimated parent, whose rest transform *is* honoured;
- an animated model is safe through **27 total packed native objects**. Object 28 corrupts matrix-
  composition stack locals, so roots and helper mounts must be included in the authoring budget.

## Adding one

Add an entry to `CANARIES` in `make.ts`. The useful discipline, learned the hard way here: make the
competing hypotheses predict **categorically different** outcomes — "does it sweep or stay put",
"which cardinal direction" — never an angle or a size to be estimated. Several readings in this
investigation went wrong because they asked someone to tell three arms apart under an arbitrary
rotation, and every one that asked a yes/no question came back right.
