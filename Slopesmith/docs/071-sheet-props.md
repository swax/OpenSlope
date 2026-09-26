# 071 — Sheet Props

A **sheet** is one continuous textured surface drawn along a path. It **stands up** — a chain-link fence, a
hoarding, a banner run — or **lies flat** — a river, a road stripe. The editor holds it as one thing: you draw
it, reshape it by its path, and give it one look and one behaviour. On export it is **cut into pieces**, one
model per span, each placed once, which is exactly how the shipped levels store theirs.

## What the reference levels actually ship

Measured on GARI (`Maps/GARI`, the extract on this machine):

| | pieces | placed | geometry | neighbours | mapping |
| --- | --- | --- | --- | --- | --- |
| `Fnc_FenceChainLink_NoLogo_*` | 332 models | each once | ONE 4-vertex quad, span 4–12 m (median 7.4), height 2.5–5.5 m (median 4.0) | share corner vertices exactly — 120 pieces share all four corners, 103 one end | the tile once per quad: U along the run, V = 1 at the top |
| `Mdl_Water_River_*` | 43 models | 42 once | a flat strip of 6 vertices, identity rotation (baked in place) | share vertices along the flow | U along the flow, V across |

So the "many models for one fence" is not a modelling choice: it is a strip drawn along the ground and chunked
per span on export, the same thing a rail tube is (docs/014). Two consequences:

- A rigid, repeated prop cannot reproduce it. A placement can turn and scale a model but never shear it, so on
  a slope two panels either step (upright) or open a wedge at the top (raked). Only shared vertices meet
  exactly, and shared vertices are generated geometry.
- Picking one retail piece and repeating it (a prop line, docs/070) is wrong almost everywhere: each piece is
  already sheared for its own spot on the hill.

Every chain-link piece also carries the same behaviour — effect slot 44 (the fence flex), mesh-proxy
collision, solid, hit sound 18 — so a sheet has to keep everything a placement can carry.

## What a sheet is in the document

A sheet is a **prop line with a `sheet` record** (`PropLine.sheet`, `core/doc/types.ts`). It shares everything
a line already does (docs/070): the path and its Catmull-Rom curve, drawing and node editing, the straight-chord
joints fitted to a whole number of spans, ground following, selection, and members that are real placements
tagged with the line. What differs is what fills a span:

- A **line** puts a copy of one model on each span.
- A **sheet** generates the span's own geometry: a **one-quad tiled model** (`AuthoredModel`, docs/028) owned
  by the sheet (`AuthoredModel.line`), and one placement of it.

Tiled models are the right container because they already are the retail piece. A tiled model wears the full
tile once per quad — the retail mapping. It renders live in the viewport, exports as its own canonical model and
instance (docs/003), which the PS2 repack appends, and it collides as a mesh proxy. So a sheet needs nothing new
from the export, Test or the ISO. And because each piece has a placement, the fence flex, the hit sound and the
contact profile are ordinary placement settings, stamped from the sheet's template the way a line's are.

The pieces are **owned**: the Prop Library's Custom view does not list them, deleting the sheet deletes them,
and any change to the sheet rebuilds them. **⇥ break into props** releases them as ordinary tiled props.

## The geometry (`core/props/sheet-prop.ts`)

The joints are the line's (`lineJoints`): walked along the curve a straight distance apart, fitted so the last
lands on the last node. Each joint contributes one edge that the spans on both sides of it share:

- **Standing:** from the ground at the joint up to the sheet's height. Edges are vertical, so a fence stays
  plumb on a slope while its top and bottom follow the ground — the retail shape.
- **Lying:** across the path at the joint, perpendicular to the path there (the two neighbouring steps
  averaged, so a bend is mitred rather than gapped), level across, at the ground plus a small lift.

Each span is one quad, corners A B C D in the tiled convention: A→B along the path (U), A→C up or across (V).
For a lying sheet A–B is the left edge, so `(B−A)×(C−A)` points up, the way the terrain's own quads face — a
river faces the sky. The tile's D4 turn (`orient`) applies to every piece.

## The Prop Library

A level's sheet pieces collapse into **one tile per sheet**, e.g. *FenceChainLink_NoLogo — sheet · 332
pieces*, instead of 332 near-identical tiles. `mineSheetFamilies` finds them from the level's own data:

- models sharing a base name (the name less its trailing `_<n>`), at least four of them;
- each small (a handful of vertices) and nearly all placed exactly once;
- and most of them sharing a vertex with a sibling once placed, which is what makes them one surface rather
  than a family of similar props.

The family reports its orientation (the pieces' area-weighted facing), its typical size and span, its tile, and
one representative instance. A piece's span is its extent along its own principal axis in plan, and its size is
its area over that span: a panel sheared down a slope still reads its true height (its z extent would add the
drop), and a river strip its width whichever way it runs. On the extracts here, in under 10 ms a level:

| level | sheet | pieces | | size | span |
| --- | --- | --- | --- | --- | --- |
| GARI | `Fnc_FenceChainLink_NoLogo` | 332 | standing | 4.00 m | 7.46 m |
| GARI | `Mdl_Water_River` | 44 | lying | 27.4 m | 44.9 m |
| GARI | `Fnc_Directional` | 27 | standing | 3.64 m | 4.22 m |
| ELYSIUM | `Mdl_Tree_TreeBackB` / `A` | 245 / 204 | standing | 14.8 / 21.6 m | 18.7 m |

The ELYSIUM pair are its background tree lines — card strips standing along the horizon, the same construction.

Clicking the tile starts a new sheet **with that look and behaviour**: the tile and its alpha flag, the height
(or width) and span, and — through the same instance copy middle-clicking a reference prop uses (docs/069) —
the representative piece's contact, hit sound and portable effect. A GARI chain-link sheet arrives solid and
flexing. A lying sheet starts with its span capped at 16 m: the shipped river's pieces run ~45 m, and chords
that long would cut the corners of a winding new one.

A level's **rail pipes** fold the same way and for the same reason — each is one swept chunk of tube placed
once — but into a **Rail pipe** tile that opens the rail tool in their tube tile, since a pipe is swept along
the rail's own curve (docs/014).

**Add sheet** in the Prop Tools launcher starts a blank one: standing, untextured, to be given a tile from the
Texture Library in its panel.

## Editing

Selecting a sheet — any piece, or a node — shows the **Sheet** panel:

| Control | What it does |
| --- | --- |
| stand up / lie flat | a fence or a river |
| height (m) · width (m) | the top edge above the ground, or the width across |
| span (m) | the straight length of each piece; fitted so a whole number lands on the last node |
| lift (m) | lying only: how far the surface floats above the ground |
| tile, ↻ turn tile | the texture every piece wears (Texture Library), and its D4 turn |

Then the path actions a line has, and the behaviour sections, bound to the sheet's template.

## Not yet

- **Hearing a picked sheet's hit sound in the editor.** The sound is the retail event id, and the editor resolves
  an event against the placement's own level; a piece is a tiled model, so auditions and Test rides stay silent.
  An ISO repacked onto the same level plays it. A WAV of your own (`collisionSoundFile`) plays everywhere.
- **Varying spans.** Retail pieces run 4–12 m, following where the artist put posts; a sheet's spans are
  equal. Add nodes where a post should be.
- **Per-node height or width** — a fence that steps up at a gate, a river that widens at a pool.
- **Closed loops**, like lines.
- **Cascades.** A lying sheet follows the ground, so it can run down a steep drop, but it does not know how to
  become a waterfall.
