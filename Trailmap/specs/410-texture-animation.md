# 410 — Texture Animation

How the level's surfaces move without their geometry moving: **flipbooks**
cycle a material through a frame list (start flags, LCD signage, the crowd),
and **UV scroll** slides a texture across a surface (river water, boost-pad
chevrons, LCD scanlines). The same frame-list machinery also carries
surfaces that never animate — a ride-over button's two colours, a pane's
intact/broken pair — because a frame list is a **state** list and an effect
is what steps it. The data model is in `170-materials.md` (what a flipbook
is, where scroll parameters live); this chapter specifies the runtime: what
drives the animation, at what rate, and the behaviors of the standard
consumers. [[410-overview]]()

> [[410-overview]]() db:timestep; db:course-boost;
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs
> (`UVScrolling`, `TextureFlipEffect`).

## The global animation tick

Texture animation has no per-effect clock: every scroller and flipbook in
the level steps on a shared beat, and authored rates are expressed per tick
of that clock. **Both UV scroll and the flipbook phase step advance per
simulation tick (60 Hz)** — see `002-conventions.md` for the shared tick.
The flip adds `speed / 60` of a frame per tick, so a flipbook's on-screen
rate is **`speed` fps**. An implementation that advances texture animation
per rendered frame without rescaling runs everything at the wrong speed.
[[410-tick]]()

> [[410-tick]]() db:timestep — scroll observed at 60 Hz (the 2026-07-16
> side-by-side in `[[002-timestep]]`: the game ran the same extracted
> per-tick rates at exactly 2× a 30 ticks/s preview). The flipbook tick is
> pinned by the same clock: a megaplex button's triggered flip (`speed`
> 3.5) holds its selected frame until the accumulator's first crossing at
> tick `ceil(60 / 3.5)` = 18, and that hold is 0.3 s against retail — 18/60,
> where a 30 Hz list would give 0.6 s. Corroborated by `EffectThread_Tick`
> counting its own wait timer down `1/60` per call, which is what makes an
> authored `Debounce 3.0` mean three seconds.
> doc:../research/texture-flip-timing.md.

## A frame list is a state list

A material's frame list does not, by itself, animate anything. What a
flipbook material carries is an ordered set of **states**; an SSF
`TextureFlip` node is what steps through them, and the node's **lifetime**
decides which of two very different behaviours the surface has:

- **Persistent** (`Length` = 0) — the node lives as long as its slot, so
  the frames cycle endlessly at the authored rate. The signage and screens
  below are all of this kind.
- **Finite** (`Length` > 0) — a one-shot, reached only by a `MainType-7`
  hop that plays it *at* a target instance. It advances a few frames and
  expires; because the authored counts are odd on a two-frame list, the
  surface returns to the state it started in. The effect is a **pulse**.

A material whose frames no node ever references does not animate at all:
its list is indexed by game logic instead (a race countdown's light tree, a
pane's intact/broken pair). The distinction is entirely in the effect, not
the material.

A surface's **resting** state is always frame 0, written at load — the level
loader stamps each flipbook material's texture id from its first frame. A
flip node never changes that: it renders through a **private material
override table** built inside the node, so two instances sharing a material
are independent, and when the node dies the override simply goes away.
[measured] [[410-flip-kinds]]()

> [[410-flip-kinds]]() `TextureFlipEffect.Length`
> (doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs,
> the 4th payload word). Census of the shipped megaplex: every Sub11 reached
> from a `PersistantEffectSlot` carries `Length` 0 (2 nodes, speed 3.5);
> every Sub11 reachable only through an M7 hop carries 0.5 or 1.0 (77 nodes,
> speed 3.5). No shipped node mixes the two. Load-time resting frame and the
> per-node override table: `../research/texture-flip-timing.md`.

### Triggered pulses (the ride-over buttons)

The megaplex's route buttons are the worked example, and the clearest case
of an effect that runs on an instance holding no effect of its own: all 78
button instances have **no effect slot** (`EffectSlotIndex` −1) and no
collision. Each live one has a co-located invisible volume whose collision
header is debounced and then makes two `MainType-7` hops — one playing a
`Length` 0.5/1.0 `TextureFlip` **on the button**, one playing an
`AnimObject` on the pillars/ramp/door it opens. The colour change and the
prop are therefore siblings under one crossing, not cause and effect: the
button flashes for a fraction of a second while the barricade it opened
stays open far longer, and re-crossing does not extend the barricade.

The flash colour comes from a **second node in the same graph**: a
`MainType-3` control op (`U0` = 2) selects frame `U1` on the flip node, and
both nodes dispatch in the same tick, so the selected frame is in place
before anything renders. The node then advances the odd number of times
above and dies, returning the surface to frame 0. Each header pulses
**exactly one** button, so a line of buttons sharing one prop group changes
only where the rider actually crossed. [measured] [[410-flip-pulse]]()

> [[410-flip-pulse]]() megaplex census: 77 collision headers each carrying
> Sub2 `Debounce` 3.0 + one M7 flip hop + one M7 anim hop; 75 distinct
> target instances over 21 distinct anim-target groups (largest: 8 buttons →
> 3 `Mdl_DynAnim_PillarMiddle`). Volume models `Mdl_Button_BumperTrigger_100`
> (48), `Mdl_ButtonTirgger_BigIRIS_1045` (11) and the `Mdl_TrigButton_*`
> family. Every flip graph pairs the Sub11 with `MainType-3 {U0:2, U1:1}`.
> Retail observation: the buttons read green at rest, flash red on a
> crossing, and return to green — matching frame 0 = green, selected frame
> 1 = red. `MainType-3`'s op 2 grants clip budget on an animation node
> instead (`370-world-interaction.md`), so it is only meaningful against the
> node class the hop targets.

### Where a playing flip actually lives

A flip **never writes the level's material record**. The Sub-11 node builds a
node-local override table and the renderer is handed that instead of the
instance's own materials, so the level material array holds only the resting
texture id that load-time remapping stamped there — no field in it ever moves.
The playing state — sub-type, applied frame, captured material and frame counts,
and the enable — is therefore readable only from the live node, reached through
the instance's effect-node slot. [measured] [[410-flip-runtime]]()

Two consequences worth stating because both invert the obvious diagnosis:

- **A flip that fails is a disappearance, not a stale texture.** The world loop
  draws an instance only while both of its draw-gate bits are set; the flip
  constructor clears one and the node's death restores it, so while a flip node
  lives it is that prop's only draw. A prop that stays visible and unflipped has
  **no flip node on it at all** — the fault is upstream of the material.
- **Applied frame exactly −1 means the material reached the node carrying no
  flip table.** `SetFrame` clamps a requested index to `count − 1`, and a
  material whose flipbook is empty has `count` 0. This is the signature of a
  frame list lost in packing rather than of a broken graph.

A directly attached chain reaches the same place as retail's `MainType-7` hop:
collision-node construction binds the thread to the **contacted** instance, so
a Sub-11 attached to the button itself lands on the button exactly as a hop
from a sibling volume would. The two-object split is retail's authoring
convention, not a requirement of the runtime. [measured] [[410-flip-runtime]]()

> [[410-flip-runtime]]() Static derivation, addresses and open leads in
> `../research/texture-flip-runtime.md`. Node fields: sub-type `node+0x14`,
> applied frame `node+0x5c`, captured material and frame counts
> `node+0x60`/`node+0x64`, enable `node+0x2d0`, all reached through
> `entity+0xe4`; the draw gate is `(entity+0xe8 & 3) == 3`, whose bit 1 the flip
> constructor clears. Confirmed live on PAL hardware by the
> auto-test harness (`../tools/autotest`): an authored ride-over button read
> sub-type `0x0b`, applied frame moving `0 → 1`, one material captured and two
> frames available, node enabled — while nine sibling cells whose chains end in
> a particle emitter read sub-type `0x02`, their `Debounce` still holding the
> slot. That contrast also confirms the factory's replacement rule: a live node
> of a **different** sub-type is destroyed before the new one is built, so a
> `Debounce` followed by a property node on the same instance does not survive
> to gate anything.

## Flipbook playback

A persistent flipbook material's frame list and instance-driven
rate/direction model are specified in `170-materials.md`; at runtime, the
frames cycle endlessly while the instance exists. The authored `speed` maps
to a frame rate through a **phase accumulator**: each animation tick the flip adds
`speed / 60` to its phase, and when the phase reaches 1 it subtracts 1 (the
fraction carries, so there is no drift) and advances exactly one frame,
wrapping at the frame count. At the 60 Hz animation tick the on-screen
rate is therefore **`speed` frames per second**; the surveyed levels
author speeds 1, 3.5, 4 and 8, so flipbooks are a low-rate
effect by design — nothing pages texture every tick. A negative start
frame picks a random one; the special value −2 additionally re-randomizes
the frame on every advance instead of stepping in order. [measured] [[410-flipbook]]()

### Pause mode (the dwell/flash screens)

A texture-flip whose **pause flag** is set does not cycle uniformly.
Playback alternates two phases, each ending when the accumulator fires and
advances one frame:

- **Dwell** — the current frame holds for a randomized re-arm: the
  per-tick increment is re-rolled each cycle to `(speed / 60) × u` with
  `u` uniform in [0.25, 1.0), making the hold `1 / (speed × u)` seconds —
  1–4 s at the authored speed 1, mean ≈ 1.85 s. The first hold after spawn
  uses the un-randomized increment: exactly `1 / speed` seconds.
- **Flash** — the next frame holds for a fixed re-arm of 1/6 per tick:
  six ticks = **0.1 s exactly**, independent of `speed`.

Direction and the random-start-frame options are inert in pause mode.
Every authored pause flip is a two-frame list at speed 1, so the effect
reads as a long, varying hold on the first frame with a brief 0.1 s flash
of the second — and successive screens drift out of phase, because each
rolls its own dwell. [measured] [[410-pause]]()

One consumer has a separate playback machine rather than the ordinary
flipbook phase accumulator:

### Crowd-grid playback

The crowd draws cheering spectator billboards from a shared 16-frame disc
asset behind placeholder level materials (`170-materials.md`). A persistent
**CrowdBox** property describes the existing model's material-grid dimensions:
its second and third payload words are rows and columns, while its first word
has no runtime effect. The property does not create geometry. Shipped `4 x 4`
and `2 x 8` descriptors both address the controller's fixed sixteen cells.

Every cell starts on an independent random phase and one of four playback
patterns. The patterns select source frames as follows:

| Pattern | Sixteen-step source-frame sequence |
|---|---|
| 0 | `0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15` |
| 1 | `0 1 2 3 2 1 0 7 8 9 10 11 12 13 14 15` |
| 2 | `0 1 2 3 4 5 6 7 6 5 4 3 2 1 0 0` |
| 3 | `0 0 0 0 0 1 2 3 4 5 6 5 4 3 2 1` |

The controller advances once every fifth global animation tick: **12 updates
per second** under the 60 Hz timebase. Activity code zero freezes the current
poses. Other codes advance the cells; at the end of a cycle each cell rerolls
its pattern and can independently rest on frame zero for 0–63 update steps.
Codes 1–6 use rest probabilities `0/256`, `50/256`, `100/256`, `200/256`,
`100/256`, and `50/256`; code 7 never rests. Active riders within 20,000 engine
units feed this code through the shared crowd/SFX activity state, and a global
mode can force code 7.

The renderer receives one selected texture per authored grid cell. The random
phases, different motion envelopes, and independent rests make neighboring
parts of a stand move unevenly instead of turning the entire crowd into one
synchronized flipbook. Crowd audio remains a separate system. [measured]
[[410-crowd]]()

The other specialized consumer is **trackside signage**: directional arrows
and warning boards carry a
persistent texture-flip as their only logic — they are flipbook players
and nothing else, which distinguishes them from breakables sharing the
same chain machinery (`370-world-interaction.md`). [[410-signs]]()

> [[410-flipbook]]() rate/direction = SSF `TextureFlipEffect`
> (`Direction` 0 = forward, `Speed`),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs;
> observed GARI authored speeds {1, 3.5, 4, 8} (~16 flipbook materials), read
> from the shipped game, not derived from the field. Runtime advance is a
> phase accumulator (+= speed/60 per 60 Hz tick, subtract 1 and step one
> frame on overflow), so authored speed IS the on-screen fps; a negative start
> frame randomizes, −2 re-randomizes on every advance. Tick rate: `[[410-tick]]`.

> [[410-pause]]() db:texture-flip-dwell — the pause-flag `TextureFlipEffect`
> variant: dwell holds re-arm at `(speed/60)×u`, u∈[0.25,1.0) (first hold
> after spawn un-randomized), then a flash frame at a fixed 1/6-per-tick
> re-arm (six ticks = 0.1 s); direction and random-start options inert. Every
> authored pause flip is a two-frame list at speed 1; measured from the shipped
> game. Durations follow the 60 Hz tick of `[[410-tick]]`.

> [[410-crowd]]() crowd frames = the shared disc bank
> `DATA\TEXTURES\CROWD.SSH` (placeholder texture id in the level,
> `170-materials.md`); crowd grid = SSF sub-type 17 `CrowdBox`
> (`150-logic.md`); fixed 16-cell controller, tick/5 gate, frame-pattern
> table, pause thresholds, player-distance gate and material-override draw
> derived in `../research/crowd-box.md`,
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs.

> [[410-signs]]() db:sign-break — the directional/warning signs'
> slots carry only a persistent `TextureFlip` (type 0 sub 11); the
> breakable classifier uses this as a counter-case
> (map:"BreakLogo" → see `370-world-interaction.md`).

## UV scroll

An instance flagged for UV scroll runs a persistent **scroll** node whose
parameter model (mode, per-axis rate, active time, pause time, and lifetime) is
specified in `170-materials.md`. During an active interval each tick advances
the texture coordinates by the mode-shaped rate; the offsets wrap at one
texture repeat. Mode 0 continues forward across cycles, while modes 1 and 2
reverse after each active interval. A positive pause inserts stopped time
between intervals. Because the motion is in texture space, scroll materials
can never be flattened into static geometry or texture atlases that break UV
wrapping.
[[410-scroll]]()

The example level scrolls about 67 instances at 8 distinct authored speeds:
the river's 44 water segments, the LCD screens' scanline overlays, and the
boost pads — whose chevron stripes scroll lengthwise (V rates −0.05 and
−0.06 per tick for speed and trick pads respectively), reading as motion
streaming toward the rider. [measured] [[410-scroll-vals]]()

> [[410-scroll]]() SSF `UVScrolling` (`U0` mode, `U1`/`U2` H/V rate,
> `U3` active seconds, `U4` pause seconds, `U5` lifetime seconds),
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/PS2/SSFHandler.cs;
> the instance marker is properties `BitFlags` bit 13 (`120-objects.md`);
> runtime and mode evidence are `[[170-scroll-mode]]` / `[[170-scroll-timing]]`.

> [[410-scroll-vals]]() doc:../research/extracted-data.md (~67 GARI
> scrollers, 8 speeds, 44 `Mdl_Water_River`); pad scroll V −0.05 (speed) /
> −0.06 (trick) read with their collision boost values, db:course-boost,
> map:"Visible speed/trick boost pads".

## The LCD screens

The jumbotron/LCD screens **stack** the techniques: the screen content is a
flipbook material paging through its frames, with a separate semi-transparent
**scanline overlay** mesh scrolled over it to sell the "video wall" look.
The overlay is a distinct instance — when the screen is broken, the break
chain hides the content mesh *and* the overlay together
(`370-world-interaction.md`, `150-logic.md`). [[410-lcd]]()

> [[410-lcd]]() db:sign-break — `BreakLogo*` functions hide screen +
> broken-twin-reveal + the scanline overlay instance (e.g. GARI 1468);
> overlay = an alpha-blend scroller over the flipbook screen face.
