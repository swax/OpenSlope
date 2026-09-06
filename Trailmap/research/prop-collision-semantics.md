# Prop collision semantics — U0, bounce, effect re-fire, narrowphase

This is the reverse-engineering evidence record. Normative behavior lives in
`../specs/130-collision-data.md`, `../specs/150-logic.md`, and
`../specs/370-world-interaction.md`; implementations cite those chapters, not
this derivation. The spec citations point back here for addresses, sweeps,
negative results, and live PCSX2 validation.

2026-07-23. Four parallel static passes over the PAL ELF (SLES-50545) plus one
follow-up, run read-only against `extracted/SLES_505.45` with
`tools/analysis/ssx_analyze.py`. Everything below is instruction-level evidence
unless marked **INFERRED**. Motivating question: the retail corpus showed
mode-1 glass at `U0 = 0.2` (no body), mode-3 path markers at `U0 = 0` (valid
body), mode-3 movables at 5/20, and 1e30 for pinned — so the provisional
"0 = pass-through, finite = movable, 1e30 = pinned" rule looked mode-dependent.
It isn't. It's a single rule that was mis-factored.

## 1. What `U0` actually is

**The runtime tests `U0` against exactly one value — `0.0` — everywhere.**
There is no `≈1e30` sentinel/threshold comparison anywhere on the collision,
response, or camera paths. All 75 `lw *,0xec(*)` sites were swept; exactly two
read `+0x00`:

1. `0x00125a58` in the player-bounce response `0x00125a08`:
   `c.eq.s U0, 0.0` at `0x00125a5c`.
   - `U0 == 0` → `0x00124dd8` (react-event dispatch only; no velocity change —
     pass-through). The dispatcher acts only when rider status `+0x428 ∈
     {2,3,14}` (events 580/581, cos-45° angle + speed thresholds); otherwise it
     returns untouched.
   - `U0 != 0` → full restitution bounce (§3). `0.2`, `5`, and `1e30` take the
     identical branch.
2. `0x0025cc48` in a chase-camera solidity predicate `0x0025cbc0` (callers
   inside `ChaseCamera_TerrainClearancePass 0x0016fe78`): `U0 == 0` → prop is
   transparent to the camera; any nonzero → solid.

Negatives (confirmed): no load-time copy of `U0` into any other runtime
structure; the mode-3 dynamics/impulse path never reads `U0`; the
effect/sound/break chain never reads `U0` (the effect dispatch at
`0x00125238`/`0x001253b4` runs before and regardless of the `U0` branch).

One place the *magnitude* of `U0` matters: the bounce response's rare Path B
(§3). There `U0` is a divisor in a mass-ratio solve — `m_rider/U0` — so
`1e30` behaves as infinite mass *arithmetically* (ratio → 0), never via a
threshold. `U0` is best understood as **the prop's mass as seen by the
player-response system**, with `0` encoding "massless / no solid response" via
the exact-equality gate.

## 2. Mode-3 inverse mass: where it comes from (and doesn't)

The impulse path reads inverse mass directly from the dynamics body:
`0x001256d4 lwc1 f21, 8(s5)` (`s5 = contact+0x30`). Gravity uses the same
field (`-980.0 / body+0x08` at `0x0013eb80`). There is **no pinned/movability
gate on the impulse path** — an immovable object is immovable purely because
its `body+0x08 ≈ 0`.

**`body+0x08` is NOT seeded at level load.** Evidence:

- The load-time per-body ctor `0x00239860` (level load → pool builder
  `sub_0025fac8`, `jal` at `0x00260008`; N×`0x150` records, tag `0xdeadc0ed`)
  is a pure field-copy from `PhysicsData` via memcpy `0x002cf2ec`:
  `+0xd8←U2`, `+0xdc←U3`(depth−1), `+0xe4←CoM`, `+0xfc←centroid`,
  `+0x108←inertia tensor`, `+0x12c←inverse inertia tensor`, plus the
  occupancy-tree pointers. **No scalar inverse mass is written, and
  `PhysicsData` has none to copy** (it stores the inverse inertia *tensor*,
  not `1/m`). This `0x150` record is the collision **shape wrapper** (vtable
  `0x003a5288`) — a different structure from the dynamics body at
  `contact+0x30`.
- `PhysicsBody_CloneRecord 0x00239708` copies `+0x10..+0x14c` and **skips
  `+0x08`**.
- ELF-wide `swc1 →+0x08` sweep: **zero** hits in the entire SSF
  relocate/instantiate/body-ctor region (`0x00239000–0x00262000`). The only
  writers are the effect-node ctors: Roller `0x0013d818`
  (`div.s f1,1.0,node+0x0c; swc1 f1,8(s5)` — the **effect payload's** mass,
  e.g. hydrant lid `U0=6`) and its siblings in `0x00140000–0x00149000`.
- The "PhysicsData aliasing" hypothesis is refuted: on-disc `PhysicsData+0x08`
  is integer `U2` (copied to wrapper `+0xd8`), not an inverse-mass float.

**Corrected model:** a mode-3 prop becomes a live rigid body only when its
collision-effect graph *activates* one (Roller-family node), and the mass used
is the **effect's authored payload mass — not `ObjectProperties.U0`**. A
static mode-3 prop that is never activated has no live dynamics body; its
contact routes through the same flag/U0-gated bounce response as modes 1/2
(**INFERRED** routing — see the `contact+0x14` open lead). The earlier
inference "level-instance `body+0x08 = 1/ObjectProperties.U0`" is **struck**.

The 2026-07-23 PCSX2 collision-lab run subsequently confirmed the static
mode-3 routing cell: with the same valid sphere body and particle-only contact
graph, U0=0 emitted its contact marker and passed through, while U0=5/20/1e30
emitted and produced a solid response. It did not test a Roller-activated body.

### Moved-body ground and sleep constants

The shared moved-body simulation uses terrain restitution `0.5` from
`body+0xdc`. Its contact response retains `0.9648` of both linear and angular
motion at `0x0013ee64/0x0013ee94`. The activity accumulator is a separate
sleep signal: it decays by approximately `0.95` per tick at `0x0013e998` and
sleeps below `10000 cm²/s²` (`1.0 m²/s²`). These are the provenance for
the clean moved-body behavior in `spec:370-bodysim`; the retention factor is
not ordinary free-flight velocity damping.

## 3. The player-bounce formula

`Boarder_ObjectPlayerBounceResponseCandidate 0x00125a08` takes the rider, the
struck entity, the contact buffer, the contact direction `n` and the hit
distance `d`. **A crashed rider (status 22) gets no bounce response at all**,
and a prop whose `U0` is zero is passed through (§1). Otherwise the response is
driven by the closing speed along the contact normal, `s = dot(v, −n)`, and the
prop's authored `b` = PlayerBounceAmmount (`props+0x04`):

- **Path A** (no live linked node, or its `vt+0x54` returns nonzero — the
  common case):
  `speedOut = max( s·(1+b), s + 55.5556 )` applied as
  `v' = v + n·speedOut`, i.e. **`v_n' = max(b·s, 55.5556 cm/s)`, tangent
  untouched** (constant `0x425e38e3`; 55.556 cm/s = 2 km/h — a universal
  outward floor, so even `b=0.03` always pushes the rider off).
  Position push `boarder+0x140 += n·(d·1.1)`.
- **Path B** (live linked node at `entity+0xe4` whose `vt+0x54` returns 0):
  `k = 1/(m/U0 + 1)` with `m` = rider effective mass from `0x0011d7b8`
  (`= B·(0.79599 + A·2.1457789/255)·(1 + 8·f)`, bytes `A=rec+0x12`,
  `B=rec+0x1e`, `rec=boarder+0x464`, `f=boarder+0x130`);
  `speedOut = sqrt(max((s·k)² − (1−b)·k, 0)) − s·k`. This is the only place
  `U0`'s magnitude is consumed (shared-momentum solve). Role **INFERRED**
  (rarely reached; semantics of `vt+0x54` untraced).
- Common tail: impact feedback virtual with `s·0.0012`; velocity write is a
  single VU0 `VADD` into `boarder+0x150` at `0x00125c08–0x00125c18`. The
  ordinary path passes its normal velocity delta
  **`J = max(s·(1+b), s+55.5556)`** to `0x00126548`. That helper computes
  `q = dot(u,n)`, where `u` is the board-up/orientation matrix row at
  `boarder+0x4ac0`, and directly calls `Boarder_EnterWipeOut` when
  **`J > 1944.444 + 833.333·q`** (unless motion state 5 is already active).
  The same helper can also feed `boarder+0x300`, but that is the distinct
  decaying contact integrator used by course reset above 12.0021—not this
  immediate wipeout comparison.

Gating into this path: **on-disc `BitFlags` bit 7 (PlayerBounce) ↔ runtime
`entity+0xe8` bit `0x80`** (checked at `0x00125240`/`0x001253bc`; bit-position
identity pinned from both ends, the loader's copy instruction not yet
located). Worked tiers, `v_n' = max(b·s, 55.556)` cm/s: at `s`=1500,
b=0.03→55.6, b=0.2→300, b=0.5→750, b=0.6→900; the floor binds below
`s` = 1852/278/111/93 respectively.

The finite mode-3 body branch (`contact+0x14==0` at `0x001253d4` →
`0x002399c8` probe → impulse ×1.3 → `0x00154350` writeback) never reads
`props+0x04`; the body-bump helper `0x00124928` reads contact `+0x04`, not
props. Its side effects: a **mode-1 bump can put the rider into a crash state**
(`0x0011d838`), which the game-manager and replay singletons are told about
(`*(0x00344250)`). A **mode-3 bump provokes a rider reaction only above a
magnitude of `167.3`** (`0x00124dd8`), and which reaction plays depends on the
rider's current state id (21 vs anything else).

## 4. Collision-effect re-fire rule

**A mode-1/2 instance's collision-effect graph is constructed once per contact
episode, gated purely on the aliveness of the previously spawned node — there
is no frame counter on this path.**

- The contact walk reaches construction only via
  `CollisionEffectNode_GetOrCreate 0x0013bd48` (callers: `0x00125238`,
  `0x001253b4`, and landing-contact `0x0010ea74` — whole-ELF `jal` sweep).
- GetOrCreate keys off a single per-entity slot (**`entity+0xe4`**): with it
  empty a fresh node is built and ticked at frame 0; with it occupied the
  existing node is kept and **not** reconstructed — for every node class in
  retail, since the only refresh predicate is a hard "no". No cooldown constant
  (30, 50, or any other) appears anywhere on this path.
- The slot is set by the base attach `0x0013a848` (`entity+0xe4 = node`) and
  cleared **only** by the node's destructor path (`0x0013a8f0` →
  `0x0013aab8`). `EffectThread_Tick 0x0013be80` decrements the wait-timer
  `node+0x40` by 1/60 and self-destructs via `vt+0xc` when the header cursor
  (`node+0x38/+0x3c`) reaches the count — that destruct is what re-arms the
  graph. **There is no contact-exit event**; leaving the shape clears nothing.
- Authored **`Debounce`** (type-0/SubType-2, seconds) realizes as the thread
  wait-timer: `Debounce = -1` → the thread never completes → `entity+0xe4`
  stays occupied → the graph fires exactly once, forever. The
  `MainType-5/U0=3` guard (`0x0013c174`, U0==3 arm at `0x0013c1cc`) literally
  reads `entity+0xe4` and stops the thread if a live child exists. (Exact
  `swc1 →node+0x40` store inside the type-0/Sub-2 lifecycle manager
  `0x0013c5d8` not isolated — open lead.)
- **A hardcoded 30-frame cooldown exists but is a different mechanism**:
  `0x00142698`/`0x00143380` (`if this+0x4c/+0x50 > 0 skip; spawn; counter=30`)
  call `SpawnFromContactResult 0x0013ab00`, which re-runs the whole header
  with no dedup (alloc tag `0x36c2a0`). These are MI secondary-vtable slots
  (`0x0036e0c0`/`0x0036e290`, this-adjust −36); their per-frame invoker is
  unresolved statically, so which node class self-repeats every 30 frames is
  an **open lead**. It is provably not the contact-walk path.

Cross-link: `entity+0xe4` is the same slot the bounce response consults for
Path A/B — the "live linked body" during a bounce *is* the live effect node.

## 5. Narrowphase edge rules

Scope correction (later session): everything in this section describes the
**line-query** class (`cWorldLine`, vtable `0x003a8d18`) — terrain stabs through
`WorldIntersect_QueryNearest`. The boarder's *prop* pass `0x00125090` installs the
**sphere-set** class (`0x003a8a48`) on the same `WorldEntity_IntersectLineQuery`
dispatch and gets different narrowphase methods in all three modes, so the mode-1 line
rules and the mode-2 `WorldLine_IntersectAABBSlab` slab below are not what the rider
meets. The mode-3 bullet is unaffected (it was already written from the object probe).
Rider-side shapes, the `+0x24` limb mask, and the sphere/box face rule are in
`elf-map.md` (the locally regenerated ELF map, not shipped; section "Rider collision volume:
sphere set and the per-state limb mask");
spec:370-probe-volume, spec:370-probe-modes, spec:370-sphere-box.

Label correction: the triangle math is in `0x0025df10` (stored-normal test) and
`0x0025e048` (orient wrapper), not in `WorldTriangleList_IntersectLineCandidate
0x0025d908`, which only iterates faces. Earlier notes citing `0x0025d908` or
`0x0025ca34` for the intersection rules meant these two.

- **Mode 1 (triangle proxy), `0x0025df10`:** plane test uses the **stored**
  per-face normal (never recomputed): `t = ((v0−org)·N)/(dir·N)`; the only
  plane rejection is `|dir·N| < 1e-10` — **two-sided, no backface cull**
  (why inside-out shells work); reject `t<0` / `t>1` (**segment-clamped**);
  then point-in-triangle `0x0023bbd0` (13-instr VU0 boolean, edge tol ~1e-4;
  per-lane math undecoded). The wrapper `0x0025e048` flips N to oppose the
  ray when `dir·N < 0` — reported-normal orientation only, acceptance
  unchanged (selector bit `*(x+0x1c)&1`, source field untraced). Loop keeps
  the hit minimizing `|t − ref|` (ref from table method `0x0025f108`, init
  sentinel 1e30). Result: `+0x30` hit index, `+0x34` SurfaceType, `+0x38`
  entity — **no normal stored**; the contact frame is rebuilt downstream
  (`Boarder_UpdateGroundContactFromWorld`, boarder `+0x2a0`).
- **Query segment:** built by `WorldLine_InitSegmentQuery 0x0025dd20` —
  origin `+0x50`, delta `+0x60`, swept AABB `+0x10/+0x20`, reference `+0x90`.
  **Zero thickness, no inflation radius.** Ground stab: `base − 100·N` to
  `base + 200·N` (fixed ~3 m along the surface normal, literals, not
  speed-scaled; ref 0.5). Airborne: swept along predicted travel with the
  same fixed ±(1–2) m extents (axis via an undecoded VU0 matrix transform at
  `0x001084d0`). ⇒ **tunnelling through thin proxies is possible** above
  ~probe-length-per-frame speeds; two-sidedness never prevents a hit.
- **Mode 2 (AABB), `0x0025e178`:** 3-axis slab on the **instance's stored
  world AABB passed directly** (box+4/box+16; runtime test purely
  axis-aligned — rotation/scale must be baked into the stored bounds;
  baking step INFERRED). Rejects `tFar<tNear`, `tFar<0`, `tNear>1`. Axes
  with `|dir| ≤ 1e-10` are **skipped before dividing** (no EE ±Fmax hazard)
  — leaving a theoretical false-positive hole for exactly-axis-parallel rays
  outside the box on the skipped axis (no `org∈[min,max]` check).
  Contact normal = ±unit axis of the limiting slab from a lazily-built
  6-entry table at `0x003d4010` (guard `0x00347684`); `t` chosen as
  entry-vs-exit nearest to `query+0x90` (0.5).
- **Mode 3 (sphere tree), `0x002399c8` → `0x0023ac48`:** the probe is the
  **rider's own sphere set** at `boarder+0x470` (main sphere `+0x10/+0x20`;
  limb count `+0x28`, limbs `+0x30/+0x40` stride 0x20). Main-sphere miss
  rejects the whole contact. Node accept: `dist² < (rProbe + rNode)²`;
  descent returns the **first** overlapping leaf (not nearest/deepest);
  penetration `= (rProbe+rLeaf) − dist`; contact direction ≈
  `normalize(riderCenter − leafCenter)` (per-lane VU0 scaling undecoded);
  outputs land in two stack vec4s consumed inline — no persistent
  normal/point field on the contact record. **Not swept** — per-frame
  overlap, so fast riders can slip thin members.

## Per-mode × per-value truth table

`C` = confirmed at instruction level; `I` = inferred. The nonzero cells below
describe `PlayerBounce`-enabled response; the flag-off cross-cell is separate.

| | `U0 = 0` | `U0` small finite | `U0 ≈ 1e30` |
|---|---|---|---|
| **Mode 1** | contact registers; pass-through (no restitution); effects/sound/break fire independently. **C** | restitution bounce, feel = PlayerBounceAmmount. **C** | identical to finite — same branch. **C** |
| **Mode 2** | same as mode 1 (jumbotron rides through). **C** | restitution bounce. **C** | restitution bounce, indistinguishable. **C** |
| **Mode 3** | body gives shape only; flagged response is pass-through; knock-down visuals come from the effect graph. **C** (ELF + live lab) | statically solid; *dynamic* shove requires effect activation, with the **effect's** mass. **C** (ELF + live static response) | statically solid; immovable as a body only because no activation gives it real inverse mass (and Path B's `m/U0 → 0`). **C** (live static response) / **I** (dynamic explanation) |

Corpus reconciliation: Elysium glass (mode 1, `U0=0.2`) = "solid + breakable"
— nonzero is all that matters on Path A, no body needed. Garibaldi path
markers (mode 3, `U0=0`) = ride-through race furniture whose topple is
authored in the effect slot. Movable 5/20: statically solid; magnitudes only
reach Path B. `1e30` = infinite mass by arithmetic, never by threshold. The
suspected mode-dependence dissolves: **`U0` is uniformly "response mass with
0 = massless"; what differs by mode is which response paths a contact can
take.**

`PlayerBounce=false` preserves a shaped contact but suppresses physical rider
response. The original live matrix isolated the flag on mode 2, where the
white marker fired without physical response. The seventeenth specimen supplied
the missing nonzero mode-1 cell: its cyan marker fired and the rider passed
through. That live result falsified the earlier prediction that the generic
mode-1 world-hit route guaranteed collide-and-slide for a flag-off instance.

## Spec traceability after absorption

- `spec:130-contact-state`, `spec:130-movability`, and
  `spec:130-collision-lab-results` carry the shape/gate/U0 conclusions and the
  live matrix result.
- `spec:150-dispatch-runtime` carries the live-node re-fire rule and separates
  it from the unrelated 30-frame repeat-node gates.
- `spec:370-impulse`, `spec:370-impulse-vals`, and `spec:370-roller` separate
  instance response U0 from Roller activation and mass.
- `spec:130-proxy`, `spec:130-mode2`, and `spec:130-spheretree` carry the three
  narrowphase rules. `0x0025d908` is recorded here as the per-face loop and
  `0x0025ca34` as its call site.

The clean spec owns those conclusions. This note retains their derivation and
open leads so a future correction changes the evidence first and then the
normative chapters.

## Live PINE probes (the cells static RE can't settle)

1. **U0/mass (Q1/Q5):** watch `f21` at PC `0x001256d4` while shoving a crash
   bag / path marker / pinned rock; correlate with `entity+0xec+0x00` per
   instance. Hardware-watch first write to a crash bag's dynamics-body
   `+0x08` from spawn: writer PC in `0x0013d000–0x00149000` ⇒ effect
   activation (model confirmed); writer on the contact path ⇒ lazy
   contact-time build (hypothesis #2). Breakpoint `0x00125a58` and confirm it
   never fires for a live mode-3 body shove.
2. **Bounce (Q2, resolved):** continuous PINE telemetry recovered each contact's
   `s`, `n`, board-up row, velocity delta, and state transition. In authored
   order, `b=0/0.03/0.2/0.5` produced `(J,T)` ≈ `(1503,2041)`, `(1682,1957)`,
   `(1638,1699)`, and `(2089,2195)` cm/s with no wipeout; `b=0.6` produced
   `(3394,1839)` and entered motion 5/control 19; the slower `b=1.0` negative
   control produced `(1901,1919)` and did not wipe out. A reversible caller
   counter on a repeated `0.6` fall recorded bounce site `0x0012665c = 1`,
   SurfaceType-6/10 site `0x0010ac3c = 0`, and total
   `Boarder_EnterWipeOut = 1`. Thus bounce amount raises `J` and can make a fall
   more likely, but the result also depends on incoming normal speed and
   contact/board orientation; it is not an independent boolean side effect.
3. **Re-fire (Q3):** `tools/instrumentation/effect_dispatch_probe.py` already
   counts the three discriminating sites. Stand in a mode-1/2 contact:
   `Δgetcreate ≫ Δconstruct` proves the aliveness gate; equal counts falsify.
   Watch `entity+0xe4` transitions and `node+0x40` count down at 1/60. If
   `0x0013ab00` ticks every ~30 frames on some instance, that instance
   engages the cooldown-gate class.
4. **Narrowphase (Q4):** thin fence proxy from both faces at low speed
   (two-sided); full-boost through it watching `boarder+0x140` cross the
   plane with no hit (tunnelling). Crash-bag hit: log the two probe-output
   vec4s and impulse vector on `0x00125090`'s stack to confirm the
   leaf-normal derivation and first-leaf (vs nearest) selection.
5. **Mode-1 flag-off cross-cell (resolved):** the collision lab's centred
   downhill follow-up emitted its cyan contact marker and remained ride-through.
   Contact dispatch survives, but `PlayerBounce=false` suppresses physical
   response in mode 1 just as it did in the mode-2 control.

## DB labels

Applied from the resolved bounce trace:
`0x00126548 Boarder_PlayerBounceHardImpactAndContactIntegrate` and
`0x0011d838 Boarder_EnterWipeOut`.

Remaining candidates: `0x0025cbc0 ChaseCamera_ObjectSolidityProbe` ·
`0x00124dd8 Boarder_ContactReactEventDispatch` ·
`0x0011d7b8 Boarder_EffectiveMassTerm` ·
`0x00239860 PhysicsBody_ConstructFromPhysicsData` (shape+tensors, no invmass) ·
`0x00239708 PhysicsBody_CloneRecord` (skips +0x08) ·
`0x0013bd48 CollisionEffectNode_GetOrCreate` ·
`0x0013b8c8 CollisionEffectNode_Construct` ·
`0x0013ab00 CollisionEffectSlot_SpawnFromContactResult` ·
`0x00142698/0x00143380 CollisionEffectSlot_CooldownGate_A/B` (30-frame) ·
`0x0013a848 EffectNode_ConstructAttachToEntity` ·
`0x0013aa98/0x0013aab8 EffectSlot_Attach/DetachNode_e4` ·
`0x0013a8f0 EffectNode_BaseDestruct_DetachFromEntity` ·
`0x0013b7d8/0x0013b7a0 EffectNode_IsBusyPredicate_Base/Refresh_Base_Noop` ·
`0x0013c174 EffectMainType5_LiveNodeGuard` ·
`0x0025df10 WorldTriangle_IntersectLineStoredNormal` ·
`0x0025e048 WorldTriangle_IntersectLineOrientNormal` ·
`0x0023bbd0 Triangle_PointInsideTestVU0` ·
`0x0025dd20 WorldLine_InitSegmentQuery` ·
`0x003d4010 AABBSlab_FaceNormalTable` (data) ·
`0x0036c588 cEffectNode_Base_Vtable` (data).
Fields: `boarder+0x424` MotionMode · `+0x428` RiderStatus (22=crashed) ·
`+0x300` ImpactAccumulator · `+0x470` RiderCollisionSphereSet ·
`entity+0xe4` LiveEffectNodeSlot · `entity+0xe8` bit 0x80
PlayerBounceEnable (= BitFlags bit 7) · effect node `+0x40` WaitTimer ·
`+0x38/+0x3c` HeaderCursor · cooldown node `+0x4c/+0x50` RepeatCounters.

## Open leads

1. `contact+0x14` population — what writes 0 vs 256..259 on the
   `boarder+0x700` records; it is the true router between the U0-gated bounce
   and the U0-ignoring impulse (decides the mode-3 static-routing `I` cell).
2. The loader instruction copying `BitFlags` bit 7 → `entity+0xe8` bit 0x80.
3. The per-frame invoker of the 30-frame cooldown-gate vtable slots
   (`0x0036e0c0`/`0x0036e290`).
4. The exact `swc1 →node+0x40` Debounce store in the type-0/Sub-2 lifecycle
   manager (`0x0013c5d8` region).
5. Per-lane decode of the VU0 macro blocks: point-in-triangle `0x0023bbd0`,
   mode-3 leaf normal/point scaling (`0x0023ae4c–0x0023ae84`), the airborne
   probe axis (`0x001084d0`), and the bounce-path contact-normal
   normalization (whether `n` is unit-length).
6. `entity+0xe4` node classes overriding `vt+0x64` (would allow a second node
   during contact) — type-0 confirmed inherits `return 0`; others unswept.
7. Whether any code path ever reads `ObjectProperties.U0` beyond the two
   readers above (e.g. AI/camera variants in unswept ranges) — the sweep
   covered `lw *,0xec(*)` producers; exotic addressing would evade it.
