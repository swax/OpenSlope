# Prop recipes

Parametric low-poly props for Slopesmith's Prop Library, authored as re-runnable Python rather than
modelled by hand. A recipe reads like a spec, re-bakes at a different triangle budget or scale by
changing a constant, and proves its own orientation before it exports.

```
_lib.py                shared primitives, guards, export, preview   Blender's Python (bpy)
_atlas.py              shared painting helpers                      system Python + Pillow
measure.py             takes the platform's cost census — start here
measure-models.ts      measures built GLBs in editor metres without importing them
check.py               validates every recipe without Blender
build_all.py           repaints every atlas, rebuilds every prop
props/                 committed output: <Name>.glb
build/                 ignored scratch: <name>.png, previews, upscales
trees/                 the conifers and broadleaves
  _species.py          species parameters -> the ladder of whorls a tree is built from
buildings/             structures
misc/                  everything else
  <name>.py            a recipe: builds the geometry
  <name>_atlas.py      its texture page
```

The root holds only shared code and tools — every recipe lives in a folder, so `check.py` and
`build_all.py` both search one directory down. A recipe resolves the shared helpers one level up:

```python
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
```

A new tool script dropped at the root must be added to `check.py`'s `TOOLS`, or the recipe search picks
it up and runs it as a prop.

Two processes because Blender's bundled interpreter has no Pillow and the system one has no `bpy`. They
meet at a PNG on disk. `_lib.panels(cols, rows)` and `_atlas.panels(size, cols, rows)` describe the same
grid in UV and pixel space, generated from the same two numbers so they cannot drift.

An atlas may serve a FAMILY rather than one prop — `conifer_atlas.py` paints one page that five
conifers all hang their cards on. This is the cheapest way to get a varied forest: what separates one
tree from another at this budget is architecture, not art, so a spruce, a fir and three pines are
legible as four different species off a single 256² page. When several props differ only in
proportion, share the page and vary the species.

## Where the numbers come from

Two kinds of number go into a prop here, and they have different sources on purpose.

**Technical constraints come from the target platform, because they are facts about what it can
draw.** Triangle budgets, texture page sizes and the 512-per-edge importer cap, the winding convention
the importer stores geometry in, whether foliage is expressible as solid geometry or has to be
alpha-cut cards, the emitter payload's units, which axis a spline mover leads with. These are measured
— see `measure.py` and the budget table below — because guessing them wastes a build, and because
there is no other place to learn them from.

**Form is authored from life.** Silhouette, proportion, crown shape, branch arrangement, how a
structure is massed: those come from what the thing is, expressed as parameters with real-world
meaning. For the trees that is literal — `trees/_species.py` takes crown ratio, crown spread, annual
height increment and branch insertion angle, all quantities forestry already measures and publishes
ranges for, and generates the geometry from them. A recipe declares a species; it does not trace a
profile.

The two meet at the check: `check.py` measures the built crown back against the species that asked for
it, and prints the triangle bill next to the budget. A prop is right when it satisfies both.

## Where the output goes

| | tracked? | why |
|---|---|---|
| `props/*.glb` | **yes** | rebuilding one needs Blender, so a fresh clone must not have to |
| `build/` — atlas pages, previews, upscales | no | repaints from Pillow alone, and each atlas is embedded in its GLB anyway |

The line is reproducibility, not size. An atlas comes back byte-identical from any checkout with
`build_all.py --atlas-only`; a GLB needs a multi-gigabyte, version-sensitive dependency that is usually
not even on `PATH`. Keeping `build/` wholly ignored also keeps it honest as scratch, rather than a
directory of negation rules where a stray preview render can sneak into a commit.

## Rebuilding everything

```bash
python Slopesmith/tools/prop-recipes/build_all.py                # all atlases, then all recipes
python Slopesmith/tools/prop-recipes/build_all.py --atlas-only   # art iteration; no Blender
python Slopesmith/tools/prop-recipes/build_all.py frosted_pine   # one recipe, all atlases
```

Not a checkout bootstrap — `props/` is already committed. It exists for the case that actually bites: a
shared file moving under props built days ago. Touching `_lib.py` makes every committed GLB stale, and touching
`conifer_atlas.py` makes five conifers stale, because **a GLB embeds its atlas at export time and
nothing recomputes that later**. There is no dependency graph, so the honest move is to rebuild the lot;
it takes seconds. It finds the newest installed Blender, or takes `--blender <path>`.

Output is deterministic — two consecutive full builds give byte-identical GLBs — so `git status
props/` after a rebuild shows exactly the props a change actually moved.

## Running one

```bash
python Slopesmith/tools/prop-recipes/trees/conifer_atlas.py    # paint the atlas
python Slopesmith/tools/prop-recipes/check.py frosted_pine     # validate geometry, no Blender needed
python Slopesmith/tools/prop-recipes/check.py                  # or every recipe at once
```

then, in Blender (via the MCP bridge or its text editor):

```python
ROOT = r'C:\path\to\OpenSlope\Slopesmith\tools\prop-recipes'
P = ROOT + r'\trees\frosted_pine.py'
exec(open(P).read(), {'__file__': P})
```

**Pass `__file__`.** A recipe derives its own `ROOT` from it, which is what keeps this folder
relocatable; a bare `exec(open(P).read())` defines no `__file__` and the recipe raises `NameError`.

To look at the result:

```python
import bpy, sys, importlib
if ROOT not in sys.path: sys.path.insert(0, ROOT)
sys.modules.pop('_lib', None)          # drop a copy cached from another path
import _lib; importlib.reload(_lib)
_lib.render_views(bpy.data.objects['FrostedPine'], ('quarter', 'side'),
                  out_dir=ROOT + r'\build', cutout=True)   # cutout=True for alpha props
```

Then read `build/_preview_quarter.png` directly. Finally, import `props/<Name>.glb` through the Prop
Library's **Custom** view **＋** tile.

`render_views` also runs under `blender --background`, which is the quicker loop when Blender is not
already open — it makes its own sun and world, and switches to EEVEE because `bpy.ops.render.opengl`
raises outright without a GL context. `VIEWS` pitch is **negative for looking down**, so `'quarter'`
sees the prop from above and `'top'` really is the top.

```bash
blender --background --factory-startup --python-expr "$(cat <<'PY'
import bpy, sys, importlib
ROOT = r'C:\path\to\OpenSlope\Slopesmith\tools\prop-recipes'
P = ROOT + r'\buildings\patrol_hut.py'
exec(open(P).read(), {'__file__': P})
sys.path.insert(0, ROOT); import _lib; importlib.reload(_lib)
_lib.render_views(bpy.data.objects['PatrolHut'], ('quarter', 'side'), out_dir=ROOT + r'\build')
PY
)"
```

To inspect the built dimensions and triangle bill for every GLB in either the shared library or a course-owned
model directory, without modifying the Custom bank:

```bash
npx tsx tools/prop-recipes/measure-models.ts tools/prop-recipes/props
npx tsx tools/prop-recipes/measure-models.ts courses/europa/props/models
```

## The order that works

1. **Find the budget first**, with `measure.py`. What a prop of this class is allowed to cost on the
   target platform, and whether that class is built solid or as sheets, are facts to look up rather
   than guess — a wrong answer to the second one cannot be rescued by any amount of atlas work, and
   you only find out after building.

   ```bash
   python Slopesmith/tools/prop-recipes/measure.py --list hut cabin shack lodge   # what exists
   python Slopesmith/tools/prop-recipes/measure.py --map SNOW Shrine              # cost it
   ```

   Read the triangle count and the up/down/side normal split; that split is what tells you solid from
   sheet. Sizes do **not** transfer, and neither does shape: the levels are built at level scale where
   these recipes are authored at real-world metres, and the shape of the thing comes from the thing.
2. **Write the recipe, then `check.py`, and read its cm/px table before painting anything.** It prints
   what each part's art is drawn at and flags any tapered face. Deriving those numbers by hand works
   but lands ~14% out, because a 64px cell only carries 56 usable pixels after `_lib.uv()`'s inset.
3. **Paint the atlas and look at it at 3–4×.** On a 128px page a defect is invisible; on the model it
   is the first thing you see.
4. **Build in Blender, then `render_views`.** Look from more than one angle. It works headless.
5. **Iterate on constants**, re-running 1–4. Nothing is hand-edited, so nothing is lost.

Steps 2 and 3 are in that order deliberately. The scale the art will be drawn at is a property of the
*geometry*, so the recipe has to exist before the page can be painted to fit it.

## Budget, measured

A cost census of the target platform, taken with `measure.py`. This is the one place model names
appear, because this is the one thing worth reading off them: what a prop of each class is allowed to
cost. Everything about how a prop LOOKS is authored somewhere else.

| platform prop | tris | note |
| --- | ---: | --- |
| `Mdl_Tree_BushyTrunk` (GARI) | 40 | 5 sides, 4 segments, no caps |
| `Mdl_PhotoBooth` (MERQUER) | 86 | a 2.6 × 1.5 × 2.6 m kiosk |
| `Mdl_SnowBlower_Bottom` (SNOW) | 120 | a small prop *part* |
| `Mdl_Building_DockWarehouseA` (MERQUER) | 162 | an entire warehouse |
| `Mdl_Building_ACafe` (MERQUER) | 208 | an entire café |
| `Mdl_TreeI_SnowLeaves` (GARI) | 272 | alpha-cut cards |
| `Mdl_SnowBlower_Top` (SNOW) | 320 | two objects, one animated |
| GARI's 648-model average | ~350 | |
| `Mdl_TreeH_SnowLeaves` (GARI) | 384 | |
| `Mdl_Vehicle_SnowCat` (ELYSIUM) | 1662 | hero vehicle |
| `Mdl_Vehicle_SnowCatB` (GARI) | 3216 | |
| `Mdl_Prepbench` (GARI) | 3384 | |
| `Mdl_ShrineBase_Wood` (SNOW) | 376 | the nearest timber structure |
| `Mdl_Tree_SparceLeaves` (GARI) | 1584 | background tree at level scale, not a prop |

So a **tree prop is a 272-384 triangle object**, which is the band every recipe in `trees/` is costed
against, and a background tree at level scale is a different and much more expensive thing.

**Buildings are the cheapest class there is**, which is worth knowing before designing one. A whole
café is 208 triangles and a whole warehouse 162 — they are background mass, and the texture does all
the work. A placeable prop gets looked at from two metres away and can afford the shrine's end of that
range, but the shell of it should still cost almost nothing: `patrol_hut`'s walls and roof together are
22 triangles and everything else is the detail that survives close inspection.

Textures are one small page per prop *family*: a whole machine — base, head and both pipe runs — fits
on a single 128×128. Use 128² for a simple prop, 256² for one wearing many distinct surfaces. The
importer caps at 512 per edge.

## Orientation is the whole game

A prop's normals are **derived from its stored winding**. The hardware lights each face as
`ambient + Σ max(0, N·L)·key` from that normal alone, and shows the same shading from both sides — it
does not backface-cull and does not re-light per side. So a face wound the wrong way still draws, and
draws **ambient-only dark from every view**. See `Slopesmith/docs/028-authored-models.md`.

Two guards run before any export, and `check.py` runs both plus one more:

- **Raw-space enclosed volume must be positive.** This models the importer exactly — mirror the
  positions to raw cm *and reverse each triangle* (`glb-import.ts`) — so it is a claim about what gets
  **stored**, not about what Blender shows. Checking in glTF space instead passes while the stored data
  is upside-down. Every shipped prop measured (GARI's boulders, SNOW's snow blower) encloses positive
  raw volume; an outward-wound 1 m³ cube reads `+1,000,000 cm³`.
- **Per-face expected facing.** Every primitive records which way each face it emits is supposed to
  look, and the mesh normal must agree. This is the authority for open geometry, which the volume test
  cannot judge.
- **No sheet face aims below horizontal** (`check.py` only, for parts named `boughs`, `foliage`,
  `crown`, `leaves`, …).

`mirror_x` carries the same rule one level up: a mirror is orientation-reversing, so it reverses the
index order of everything it copies. Without that, the mirrored half of a symmetric prop ships dark.

## Solid or sheet?

Both are correct; the shipped data says which to use where.

**Sheets** for anything thin — foliage, fences, banners. One single-sided surface, **no duplicate
reversed twin**: lighting is per-vertex from the authored normal and both sides show identically, so a
twin costs triangles and changes nothing. The only doubled faces across all 648 GARI models are on
MediaTower panels, and those exist to un-mirror readable art. Pass `finish(closed=False)`.

**Silhouette is architecture, not texture.** A conifer's boughs leave the trunk level or below and its
outline is a cone; a broadleaf's limbs sweep upward and its crown is a dome, widest in the MIDDLE. Pass
`rise` to `card` (or a sixth column to a `whorls` row) to get the second one. A birch built at `rise=0`
reads as a pale spruce however carefully its page is painted — that was the first attempt at `birch.py`,
and no amount of atlas work fixed it.

**Cutout cards** for foliage specifically. The platform's own snow trees measure **0 up / 0 down / all
side** across ~18 distinct yaw buckets on a page that is **59% fully transparent**: at this budget a
tree is a thin pole with a few dozen vertical bough cards, and the shape lives in the alpha channel.
Solid geometry cannot express a conifer here — a cone at 280 triangles reads as a cone. Slopesmith
supports the cutout path directly: `props/textures.ts:288` builds *every* prop material
as `MeshLambertMaterial({ side: DoubleSide, alphaTest: 0.4 })`, and `props/texture-alpha.ts` classifies
cutout straight off the PNG. Pass `finish(alpha=True)` and paint on a transparent page.

**Solids** for everything else — vehicles, machinery, food, rock.

## Making a prop move

Geometry can **`spin()` continuously** or **`swing()` as a pendulum**; `surface(scroll=)` instead travels
a texture across geometry without moving the vertices.

### Spinning a part

Wrap the faces that turn in `b.spin(pivot, axis, revs_per_second)`:

```python
with b.part('fan'):
    with b.spin(fan_mid, axis, 0.75):
        tube(b, [hub_back, hub], 8, 0.41, P_FAN, closed_ends=True)
```

Spins may be nested when one moving assembly rides another. The outer context yields its ordinal and
becomes the implicit parent of any spin declared inside it:

```python
with b.spin(PLATFORM_PIVOT, (0, 0, 1), 0.10) as platform:
    cylinder(b, 16, 0.4, 0.7, 4.2, 4.2, P_TRIM, panel_cap=P_DECK,
             cap_bottom=True, cap_top=True)
    with b.spin(CAR_PIVOT, (0, 0, 1), -0.30):
        build_car(b, CAR_PIVOT)
```

The car's mount is parented beneath the platform's turning object, so it orbits first and then applies
its own local turn. Parents must precede children; lexical nesting makes that true by construction.

For a pendulum ride, wrap the moving assembly in
`b.swing(pivot, axis, amplitude_degrees, period_seconds)`. It starts in the authored rest pose, sweeps
smoothly through both signed apexes, and returns to rest at the loop boundary:

```python
with b.swing((0, 0, 4.8), (0, 1, 0), 58, 4.8):
    build_ship_and_hangers()
```

Those faces export as their own glTF node in the prop hierarchy, carrying a `OpenSlope_animation` declaration. The
importer turns it into the same object-hierarchy clip an extracted level's `ModelObjects` decode to, and
placing the prop attaches the **Model clip** effect that runs it — so it is turning the moment it lands,
and the Effects editor owns it from there like any other node.

This is what the format itself expects rather than a new mechanism: an animated prop is exactly
two objects, the second parented to the first with one rotation channel and `AnimTime: 15.0`, spinning at
120 rpm.

Two things bite:

- **The axis is arbitrary but the pivot is not free.** Both are read in the recipe's own coordinates and
  the geometry keeps its authored position — the pivot is where the turn happens, so a hub half a metre
  off makes the part orbit rather than rotate. `check.py` prints both.
- **Symmetry eats the rotation.** Anything N-fold symmetric about its axis repeats every 360/N degrees,
  so it appears to turn N times its actual rate. An eight-wedge fan disc at 0.75 rev/s already flickers
  six times a second. Pick the rate by how it reads, not by what the real machine does.
- **The direction is not worth deriving.** The raw frame is mirrored, so the sign that comes out on
  screen depends on a frame change two steps away. Look at it and negate `revs_per_second` if it is wrong.

**Judging the rate without leaving Blender.** `finish()` also gives each rotating child real AXIS_ANGLE
keyframes with a CYCLES modifier — linear for a spin and eased through the apexes for a swing — so pressing
play in a local `props/props.blend` preview scene shows the declared motion. It reports the period in scene
frames, which follows the scene's fps rather than the editor's 30 fps clip clock; the motion is the same,
the clock is not.

Those keyframes are added **after** the export, and that ordering is load-bearing: the exporter writes each
node's transform as evaluated at the current frame, so keyframing first bakes the part crooked by however
far into its turn the scene happened to be sitting. The GLB carries the spin only as its `OpenSlope_animation`
declaration — one source of truth, and the editor builds its own curves from it.

**It reaches a disc.** The export tags each run with the object that owns it and ships the pivot, axis and
sweep alongside; Slopesmith's canonical exporter writes that as native `ModelObjects` + `AnimTime`, in the same shape
the engine's own fans use. So a declared spin turns in
Preview/Test, in the Unity path, and in a repacked ISO. See docs/032 for the encoding.

### Scrolling a surface

The other kind is the engine's own mechanism for flowing water. Declare
it on a surface and it travels to the editor inside the GLB, as glTF `extras`:

```python
finish(b, NAME, TEX, GLB, closed=False,
       surfaces=[surface(WATER_TEX, alpha=True, scroll=(-1.35, 0.0))])   # uv per SECOND
```

No current recipe uses a scrolling surface, so the example above is written out rather than quoted.

**The moving surface needs its own material.** Effects attach per material, so a surface that scrolls and
bodywork that does not cannot share a slot — they would crawl together. That is what `surfaces=` and
`with b.surface(1):` are for, and it is why such a prop is two pages rather than one.

Two constraints on the art, both of which bite silently:

- **It must tile along the scroll axis.** Scrolling walks the sampled window off the end and
  `RepeatWrapping` returns it to 0, so anything not meeting its opposite edge becomes a seam crossing
  the surface once per cycle.
- **It must be uniform along that axis.** Anything varying with the scroll direction travels WITH the
  texture — paint a stream thinning toward its far end and the thin part sets off downstream forever.
  Put the gradient on the other axis, which does not move, and break the far end up with geometry.

The rate is UV per second and is converted to SSX's per-tick unit (60 Hz) on the way out, so the value
in the GLB is the native one and nothing has to be translated back. `check.py` prints each surface's
face count and rate; a surface with no faces is an error, because a material nothing is tagged for
exports an empty slot and its effect animates nothing.

**Scrolling only runs with world effects on** — the **Effects** toggle in the top bar. With it off the
surface is a still image by design, which looks exactly like a scroll that does not work.

### Switching a surface between states

The third kind moves nothing at all: the material carries several **frames** and something else chooses
which one shows. `misc/ride_button.py` is the worked example — a floor button whose lamp rests green and
flashes red when a rider crosses it.

```python
finish(b, NAME, TEX, GLB, frames=2)        # or surface(..., frames=2) for an extra material
```

**Declare the count and nothing else.** A frame list is a STATE list; what plays it is an SSF effect
authored against the placement in the editor, not a property of the art. The same two-frame page is a
strobing warning sign under one effect, a ride-over button's pulse under another, and a still image under
none — attach the **Ride-over button** effect to a placement of `RideButton` and crossing it flashes frame 1
and settles back. A rate declared here would be a second animator running beside the graph, which is the one
thing the scroll declaration above is careful not to be.

**The page is a filmstrip**: `frames` square bands stacked top to bottom, every band the same layout, only
the paint differing. That is what lets the UVs be authored against one frame and address all of them — the
geometry never learns the material has states — and it is how flipbook art really works. Paint each frame
with the ordinary `new_atlas(SIZE)` and stack them:

```python
strip = filmstrip([paint_frame(REST), paint_frame(PULSE)])
```

Two constraints, both of which bite silently:

- **Seed the noise once per PAGE, not per frame.** Grime, scuffs and stripes have to land in identical
  pixels in every band, or the parts that are not supposed to change crawl when the state does.
- **Keep the states at the same value.** A crossing should read as a colour change; if one frame is also
  brighter it reads as a light coming on, which is a different prop.

`check.py` divides the page height by the frame count and reports the BAND — the cm/px table then costs the
art the model actually samples, and a page that does not divide evenly is an error rather than a half-frame.

### Particles

A scroll moves a surface; particles actually leave the prop. `emitter()` writes SSX's OWN emitter
payload — the `type2Sub0` field bag of a MainType-2 node, the same record `Effects.json` stores — so
the editor's existing particle runtime plays it unchanged and an exported level ships a real emitter:

```python
finish(b, NAME, TEX, GLB, emitters=[emitter(
    at=MOUTH, aim=PLUME_AIM, speed=15.0, spread=(2.6, 3.4, 2.2),
    gravity=-3.4, life=(2.6, 0.9), size=(0.55, 0.30), count=64, sprite='snfl')])
```

Placing a model that declared emitters attaches them as an ordinary persistent graph, which the Effects
editor then owns — retune or delete it and the next placement is unaffected.

Arguments are metres and m/s; the conversion to native units (raw cm, cm/s) happens in `_lib`, so a
recipe never contains `U20: 1200`. Two things worth taking from the shipped data rather than intuition:

- **Gravity is well under the real thing.** A measured emitter runs `-300` (−3 m/s²), because a
  light particle has drag the sim does not model. At −9.8 the arc collapses into a stone's throw.
- **`sprite` names the shared particle bank** — `snfl` is the snowflake, `spry` the spray. Full list in
  `PARTICLE_SPRITES`, and the index is what lands in `U49`.

The spawn point is the one value that travels in the file's own frame rather than converted up front,
because the importer re-centres a model on its bounding box and the spawn point has to take that same
shift or it drifts off the muzzle. `check.py` prints where each emitter sits, in recipe coordinates,
and fails if it lands outside the prop's own bounding box — which is what a frame-conversion slip
looks like.

### Riding a spline

Everything above is declared IN the GLB and travels with it. This one is not. A prop is moved along an
authored **motion path** by the **Spline mover** effect (SSF MainType 2 / SubType 1), which rebuilds the
placement's matrix from the curve every tick — so the ride is the route, drawn in the Effects editor over
whatever terrain it crosses, and the recipe's whole job is to hand that node a model shaped the way it
expects. Three of its rules decide the layout, and each is a silently wrong-looking prop:

- **+Y is the direction of travel.** Yaw is `(yaw offset + pi/2) − the tangent's compass angle`, so at a
  zero offset the image of raw model +Y is the tangent — and raw +Y is Blender +Y. Build the vehicle
  pointing down +Y and the mover needs no yaw offset at all.
- **Pitch is applied about model X**, and is not re-derived from the yaw offset. A vehicle laid out along
  X therefore ROLLS on every gradient instead of pitching, which is why the shipped MERQUER subway — it
  authors a 1.62 rad offset to put its long −X axis on the track — has to disable pitch altogether.
- **Roll is hard-zeroed.** The spline's own normal is never computed and the prop does not bank, so a
  route authored with a lean in it is a lean the vehicle ignores.

**`z=0` is the rail.** The mover overwrites the placement's translation wholesale, so the model's own
origin is the point that rides the curve, and the importer re-centres horizontally on the bounding box
while leaving height alone — the origin lands mid-model at whatever `z=0` the recipe chose. Build the
wheels resting on it. `check.py`'s `base z=` is load-bearing here for a different reason than on a prop
that stands on the ground, and so is symmetry along Y: an asymmetric model has its bounding-box centre
somewhere other than its middle, and the whole vehicle then rides that far ahead of or behind its route.

**Instance count is how you get more than one.** Copies share the one model and are spaced by
`arc length ÷ count`, so a train is cars built INTO the model with the count placing whole trains evenly
around the circuit — not a raised count hoping they land nose to tail. Snowdream circulates 15 gondola
chairs on one wire this way. On an authored prop the editor Preview draws a single copy while the disc
and Unity draw them all (`Slopesmith/docs/026-effects-editor.md`).

The full behaviour is `Trailmap/specs/230-level-ssf.md`; `misc/snowcap_screamer.py` is built for it and
declares no motion of its own.

## The library

`_lib.py` (inside Blender):

| | |
| --- | --- |
| `Build()` / `b.part(name)` | accumulator; the context manager tags faces for the budget table |
| `b.surface(i)` / `surface()` | emit onto a second material — the only way one surface can animate alone |
| `surface(frames=)` / `finish(frames=)` | make a material a flipbook state list; its page is a filmstrip |
| `panels(cols, rows)` | atlas grid in UV space, `[row][col]` from the image's top-left |
| `uv` `band_uv` `rect_uv` `radial_uv` | map a face into a panel. `radial_uv` puts circles on circles — paint irregular blobs, never concentric rings |
| `box` | tapered, sheared, faces skippable |
| `cylinder` | tapered tube, opt-in caps |
| `puck` | lathed disc with domed fans |
| `barrel` | uncapped tube with a bulged middle |
| `extrude_profile` | sweep a 2D side-view outline along X — the vehicle workhorse; normalises its own winding |
| `triangulate` | ear-clipping, used by `extrude_profile` for concave outlines |
| `skirt` | single-sided conical fan |
| `card` | billboard strip for cutout sprigs. `rise` elevates its axis, `tilt` rolls it, `droop` drops the tip |
| `whorls` | rings of cards up a trunk, golden-angle staggered — the body of any tree. `jitter` roughs the ring up |
| `tapered_trunk` | stacked tapered tubes; five sides and a ring per ~1.25 m of stem |
| `tube` | polygonal sweep along a polyline |
| `pyramid` | four-triangle stud |
| `quad` | one free face |
| `mirror_x` | mirror a face range, reversing the winding |
| `wobble` | per-angle radius jitter — a clean lathe reads as CAD |
| `finish` | mesh, UVs, material, guards, export, budget table |
| `render_views` | render named angles to PNGs |
| `set_view` | frame the interactive viewport |

`_atlas.py` (system Python): `new_atlas` `panels` `filmstrip` `blob` `speckle` `scatter_blobs` `stripes`
`bars` `hazard`.

## Traps

**`raise SystemExit` inside Blender kills Blender.** The guards raise `RuntimeError`.

**A recipe must re-import its library.** Blender stays open between runs and caches modules; every
recipe starts with `import _lib; importlib.reload(_lib)`. `check.py` depends on that line being written
verbatim.

**Props are all built at the origin**, so a second one in the scene interpenetrates the first.
`render_views` hides every other object for the duration; the interactive viewport does not.

**Do not trust the MCP viewport screenshot.** It can return a stale frame — showing a prop that is
hidden, or one built two runs ago — which is worse than no preview because it looks like an answer.
`render_views` renders through the scene camera to a file instead.

**Workbench ignores alpha.** `render_views(cutout=True)` switches to EEVEE, or a cutout prop renders as
opaque rectangles. It also needs a lit world; the preview scene carries `_PropPreviewSun` and
`_PropPreviewWorld`.

**A canopy of `card`s comes out as a pinwheel unless you mix `hand`.** `tilt` rolls a card about its
own axis, and the normal's vertical component is `sin(tilt)` — so a negative tilt aims the sheet at the
ground and it ships dark, and every card is forced to roll the same way. The result is a whole tree of
fronds leaning identically, which is invisible from a three-quarter view and glaring the moment you
sight up one side of the trunk. `hand=-1` MIRRORS the card across its axis rather than rotating it back,
reversing the winding so the normal still points up; `whorls` coin-flips it per card off the seeded
stream. Anything else that rolls a sheet by a signed angle has the same trap in it.

**Foliage art needs all THREE of its levels, or the leaves come out life-size wrong.** A bough is an
axis carrying lateral shoots carrying needles, and it is tempting to comb the needles straight off the
axis and skip the middle. Do that and the strokes have to span the frond's whole depth on their own, so
they land four times life size and the bough reads as one enormous fern. Work the scale out first: a
long bough card is ~1.5 m across a 128 px cell, so the page runs ~1.2 cm/px and a 4–12 cm pine needle is
**3–8 px** — barely more than the line carrying it. Everything above that is a shoot and needs its own
needles on it. A 64px cell shows exactly where to stop: a spine, eight or ten foliage lobes,
and not one individual needle anywhere on the page.

**Lobes must overlap, and snow goes on the silhouette.** Evenly spaced shoots rebuild the comb even at
the right needle size; spaced too far apart they read as beads on a string. Overlap them and vary the
per-lobe thickness — the lumpy lower edge is most of what reads as many small branches. For snow, scan
each column for its topmost opaque pixel and lay the crust on that. Placing it by formula puts half the
dabs mid-mass where no snow could settle, and any that clear the foliage survive the alpha cut as white
specks hanging in mid-air. Measure the whole silhouette *before* drawing any of it: scan and draw in one
pass and each dab becomes the next column's silhouette, walking the crust up the cell in a staircase.

**A bark cell is stretched about 20:1, so pre-distort anything drawn on it.** The panel maps to ONE
trunk face over ONE segment — say 128 px across a 0.13 m face (0.10 cm/px) and 64 px up a 1.3 m segment
(2.0 cm/px). A mark that looks right on the page lands as a tall thin smear on the trunk. Work out the
ratio for your trunk and draw accordingly: an aspen's round branch scar is an ellipse ~20× wider than
tall, and fine vertical fissures vanish entirely while 8–16 px ones read at about a centimetre.

**A TAPERED face cannot be rescued by pre-distortion, because its UVs kink.** `box(taper=)` leaves the
sides as trapezoids — the roof of `patrol_hut` is one box tapered to a ridge, so each gable end runs
3.8 m wide at the eave and 0.22 m at the ridge. U there is a *fraction* of the width rather than a
distance, so a cross with vertical sides on the page comes out as a wedge on the prop. That much is
fixable: draw the bar flaring outward as it rises and it lands square. What is not fixable is that the
face is a QUAD and the exporter triangulates it, so U interpolates affinely on each half and jumps at
the diagonal — the pre-distorted cross comes out kinked down its middle. Only *V* survives, because on
a taper both triangles still map it to height. So horizontal siding is fine on a tapered face and
anything with a vertical edge is not; give that art its own flat board instead, which is what the
patrol cross is. `check.py` reports the taper ratio per part, so this is visible before it is painted.

**And that cell tiles 20–30 times over a trunk**, so any high-contrast island in it becomes a regular
polka-dot grid. Keep distinctive marks to one or two per panel; the repeat is more visible than the
mark. Marks touching the panel's top or bottom edge become a ring at every segment seam.

**Nothing clips a drawing to its panel — ImageDraw has no clip region at all.** A mark that leans or
overhangs is simply drawn into the neighbouring cell, where it becomes some other part's paint: black
hazard diagonals overrunning a lamp panel put dark stripes on everything the lamp dresses, and the page
looks fine at 1× because the stripes land where stripes are plausible. Every helper in `_atlas.py` stays
inside its `rect`, and anything hand-drawn has to as well — `hazard()` exists because the leaning bar is
the shape that tempts you to reach past the edge.

**Paint transparent pixels in the art's own colour, not black.** Alpha is tested after filtering, so a
transparent-black background bleeds dark fringes into every cutout edge through the mip chain. Draw
without antialiasing too — a half-alpha edge pixel is a coin flip against a 0.4 test.

**Re-importing a GLB does not replace it.** `saveImportedProp` steps past taken names, so the same
filename lands as `<Name>_2` with a new model number and existing placements keep the old geometry.
Settle a prop's shape and scale before placing many of them.

**Scale is taken as authored.** 1 glTF unit = 1 metre = 100 raw cm. Build base-at-z=0: the importer
recentres horizontally on the bounding box but leaves height alone, reading the lowest vertex to stand
the prop on the terrain.

**Anything dipping under z=0 lifts the whole prop off the ground**, because that lowest vertex is what
the terrain gets matched to — the part does not sink into the snow, the trunk floats. A `card` is the
usual culprit: it hangs half its height BELOW its origin and then droops on top of that, so a low
whorl needs `z > droop + half·cos(tilt)` and not merely `z > 0`. `check.py` prints `base z=` for
exactly this; anything but `0.00` on a prop that should stand on the ground is the bug.

## Worked examples

| recipe | tris | what it demonstrates |
| --- | ---: | --- |
| `misc/ride_button.py` | 64 | a FLIPBOOK material: a filmstrip page, two states, and no declared playback |
| `misc/cookie_sandwich.py` | 172 | lathed solids, radial cap UVs, modelled *and* painted detail |
| `misc/snow_gun.py` | 190 | the one prop that MOVES: a particle emitter carried in the GLB |
| `misc/snowmobile.py` | 286 | swept side profiles, `mirror_x` symmetry, a multi-surface 256² atlas |
| `misc/snowcap_screamer.py` | 580 | built for a Spline mover: +Y leads, `z=0` is the rail, no declared motion |
| `buildings/patrol_hut.py` | 323 | a whole roof from one tapered box, and where its UVs stop working |
| `buildings/black_sun.py` | 4976 | a whole INTERIOR: four pages, two scroll axes, cutout glass, all four spins |
| `trees/snag.py` | 125 | the one SOLID tree — tubes and splinters, no cutout anywhere |
| `trees/aspen.py` | 228 | crown ratio taken to its limit: a 1:5 column that is mostly trunk |
| `trees/birch.py` | 238 | a decurrent crown, widest in the middle, and its own page for white bark |
| `trees/frosted_pine.py` | 272 | alpha-cutout cards, sheet geometry, golden-angle whorls |
| `trees/larch.py` | 280 | a bare deciduous conifer — the only see-through tree |
| `trees/bushy_pine.py` | 286 | wider than it is tall; a treeline shrub-pine's tiny annual increment |
| `trees/medium_fir.py` | 294 | `jitter` against a broad upswept crown |
| `trees/tall_spruce.py` | 338 | declining boughs and a narrow crown — the spire form |
| `trees/tall_pine.py` | 376 | forest-grown: a bare lower trunk and branch count peaking mid-crown |

Eight of the nine trees share one skeleton and one generator, and differ only in the species handed
to it. Reading `bushy_pine.py` beside `tall_pine.py` is the shortest explanation of what crown ratio
does; `_species.py`'s own report, side by side for the whole family, is the shortest explanation of
the rest.

`black_sun.py` is the other end of the range and is worth reading for a different reason: it is the
only recipe here whose subject is a **room**. Everything else is judged from outside, so a shell and
a good page are the whole job; a building you ride into has to hold a section, a circulation route
and a sightline as well, and the constants at the top of it are that section. It is also where the
four-material ceiling gets used up — one static page, two that scroll on different axes, one cutout —
and where `MAX_IMPORT_SPINS` is spent deliberately rather than incidentally.

## What actually generates a tree's shape

`trees/_species.py`, from parameters a forester would recognise — its docstring is the long version and
this is why those particular parameters. Run it to see the family at a glance:

```bash
python Slopesmith/tools/prop-recipes/trees/_species.py             # every species, side by side
python Slopesmith/tools/prop-recipes/trees/_species.py medium_fir  # one, ring by ring
```

**Apical dominance** sets the outline. A conifer's leader suppresses its laterals, growth stays on one
axis, and the crown is widest at its base and tapers all the way up: a cone (*excurrent*). Broadleaves
have weak apical dominance, the leader loses out partway up, the crown forks, and it ends up widest in
the MIDDLE: a dome (*decurrent*). That is `widest_at`, near 0 for the conifers and 0.5 for the birch,
and it is the single most legible thing about a tree. Relatedly, conifers put out one true whorl per
YEAR, so whorl spacing IS the annual height increment: it compresses toward the top as the leader
slows, evenly spaced whorls read as young, and the number of rings is not a choice — it is the age of
the live crown. Broadleaves do not whorl at all; the birch and aspen get away with rings only because
`jitter` and a steep `rise` disguise them.

**Light and self-pruning** set the crown ratio. Foliage persists only where it pays for itself, so
shaded interior branches are shed and a real crown is a hollow SHELL on a bare frame — which is why the
card model works at all. It also sets live crown ÷ height: ~70–90% open-grown, ~30–40% forest-grown
from side shading. `bushy_pine` sits above the open-grown end (a treeline shrub has never been shaded
by anything) and `aspen` at the forest-grown one, and that single ratio does more for "which tree is
this" than height does.

**`rise` is the species knob.** Boughs angled down (`tall_spruce`, -10 to -4°) give a drooping spire,
level (`frosted_pine`) a pine, swept up (`medium_fir`, +8 to +13°) a fir, and steeply up on an
ellipsoid crown (`birch`) a broadleaf. Those four read as four species while three of them share a
single texture page — architecture separates trees far more than height or art does. It also decides
branch LENGTH, since a limb ascending at 50° has to be half again as long as a level one to reach the
same crown width.

One thing the model still gets wrong: pines hold needles only 2–4 years against spruce and fir's 5–10,
so the inner two-thirds of a pine branch is bare wood while a fir looks dense to the trunk. That is in
the atlas rather than the geometry, and only half-done — `conifer_atlas` splits its columns for it, but
every spray cell still carries foliage its full length.

**`jitter` is worth reaching for on anything whorled**, and every tree here uses it. A generated ladder
still gives every sprig in a ring one height, one length, one angle and an exact 1/n of a turn, and
that regularity is visible before the needles are. 0.72–0.85 roughs it up; `larch` runs 0.90 because a
sparse tree can take more, but past that the rings stop reading as rings and a conifer turns into a
bush. `jitter` belongs to the species; `SEED` beside it in the recipe picks which individual of that
species you get, and changing it is free.

**The ANGLES need the widest swing.** A ring whose sprigs all leave the trunk at one angle reads as
machined even when their lengths and heights already differ — the eye picks up a repeated angle much
faster than a repeated size. `whorls` swings tilt ±13° and rise ±11° against ±22% on length, and at the
±7° it originally used the variation simply did not register. Tilt is floored at 5° rather than swung
symmetrically: it rolls the card off vertical, and at or below zero the face normal drops to horizontal
or under and the sprig ships ambient-only dark.

**Jitter is why ground clearance is solved and not tuned.** It can lengthen a bough 22%, deepen its
droop 30%, drop its height and flatten its tilt 13° all at once, so a bottom whorl that clears z=0 on
the table will not clear it jittered. `_species` handles this for the trees — it simulates the whole
bottom whorl over many seeds and places the crown so nine seeds in ten stay above the ground — but
anything else built from `card` has to check for itself. `base z=` off `check.py` is the answer;
anything but `0.00` on a prop that should stand on the ground is the bug.

## Adding a prop

1. Cost the class first (`measure.py`, or the budget table above). Record the triangle allowance and
   the face-normal up/down/side split — that split is what tells you solid from sheet. **Raw space is
   Z-up**: `editorFromRaw(x,y,z) = (-x/100, z/100, -y/100)`, so a normal census that treats raw Y as up
   reports nonsense.
2. `<name>_atlas.py`: pick a grid, paint, look at it upscaled.
3. `<name>.py`: constants at the top, `Build()`, tagged parts, `finish()`. For a tree, add a `Species`
   to `trees/_species.py` and let it generate the whorls — the recipe then only picks atlas cells.
4. `python Slopesmith/tools/prop-recipes/check.py <name>` until clean.
5. Build in Blender, `render_views`, iterate on the constants.
6. Import `props/<Name>.glb` — through the Prop Library's Custom **＋** tile, or headlessly from a script
   with `importGlbFile` + `saveImportedProp` (`src/server/props/import-glb.ts`), which is the same
   conversion with no browser in the loop. Props cut from one shared atlas should pass the same
   `tileName` so the kit costs the texture bank ONE page rather than one per prop.
7. Commit `props/<Name>.glb` with the recipe. If the change touched `_lib.py`, `_species.py` or a
   shared atlas, run `build_all.py` first — the props that embed it are stale and nothing else will
   tell you.
