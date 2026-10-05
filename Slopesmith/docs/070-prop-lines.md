# 070 — Prop Lines

A **prop line** is a path laid on the ground that owns a row of placements of one model: a fence, a line of
lamps, a row of cones. You draw the path the way you draw a rail, the prop repeats along it — turned to follow
it and seated on the ground — and editing the path or a setting lays the whole row out again.

## What a line is

`PropLine` (`core/doc/types.ts`) is the path and the settings. The copies are **ordinary placements**: each is a
`PlacedProp` in the document's `props`, tagged with `line` = the line's id. So everything that reads placements
— the viewport, Test's colliders, the effects join, the Unity export, the ISO repack, preflight — handles a
fence exactly as it handles a hand-placed prop, and nothing downstream of the document knows lines exist.

The other way to build this would derive the copies whenever something reads them, the way group members are
derived (docs/015). That puts an expansion step in front of every reader of `props` — about forty files — and
groups show the cost: the export, Test and the viewport each grew their own member handling. Real members
avoid all of it. The price is that a member is **owned** by its line: any change re-lays the line out and
replaces its members, so a hand edit to one member lasts only until the next re-layout. Hence:

- A click on a member **selects the line**, the way a click on a rail's tube selects the rail. Box selection
  passes members by.
- **⇥ break into props** is the way out for the one member that needs to be different. The members stay exactly
  where they are, lose their `line` tag, and the line is removed.

Member ids are derived from the line — `line:0000:007` is the eighth member (`lineMemberId`). A re-layout that
keeps the count keeps every member's id, and with it the effect attached to it.

A line is its own register family (`o/prop-line/<id>`, docs/039), so two people can edit two lines at once.

## Laying one

1. **Hold a prop** — pick it from the Prop Library, or middle-click one in the world. The held prop's panel
   offers **⟿ lay as a line**.
2. **Click points on the mountain.** Each click adds a node on the ground; a dashed band shows where the next
   segment will run. The copies appear from the second point and re-lay with every click.
3. **Enter or Esc** finishes. The line stays selected so its settings are in front of you.

The held prop's settings, effect and size (Shift+wheel) become the line's. Holding the prop first means the
copies you see while drawing are the real thing. The other order works too: **⇄ swap prop…** on a line takes
the next prop picked in the Library (or middle-clicked in the world) and lays that out instead, with that
pick's settings and effect.

A line under two points has nothing to lay out, so while it is being drawn it is not in the document yet
(`app/props/lines.ts`). Abandoning the draw — another tool, an undo — leaves nothing behind.

## The layout (`core/props/prop-line.ts`)

`layoutPropLine(line, footprint, ground)` is pure: the line, the model's footprint and a ground sampler in; the
member poses out. `test/prop-line.test.ts` pins every rule below as numbers.

- **The path** is the Catmull-Rom curve through the nodes — the same curve a rail uses (`sampleRail`).
- **Joints are a straight distance apart**, not a distance along the curve. A panel is straight, so a chord is
  what it can span: its two ends land exactly on the curve and a bend opens no gap and makes no overlap.
  Spacing by arc length would overlap panels on every bend, since a chord is shorter than its arc.
- **A whole number fits.** The spacing is nudged so the last joint lands exactly on the last node. When the
  spacing is the model's own length — the default, panels end to end — the members are scaled by the same few
  percent so they still meet. A spacing set by hand keeps the members' size and moves only the gaps.
- **The long side follows the path.** The footprint (`footprintOfRawBox`, or `groupFootprint` for a group) is
  the model's box in its own frame. Each member is turned so the box's longer horizontal side lies along its
  step, plus the line's own **turn**, and its box centre goes on the step's midpoint. The default spacing is
  the box projected onto the path, so a quarter turn spaces by the short side.
- **Placement.** `span` (default): one member on each step — a fence panel. `joint`: one standing at every
  joint, both ends included — a lamp, a post, a cone.
- **Seating.** An upright member is seated at the **lowest** ground under it — its two ends and its middle —
  so no end floats; on a slope the uphill end sinks into the snow. **follow slope** (`rake`, span only) tilts
  each member along the ground between its ends instead: a roll or a pitch, whichever of the member's own axes
  the step runs along, so the YXZ composition stays exact (`core/props/pose.ts`).
- **Ground** comes from `Viewport.groundHeightAt`, the same cached ride tree effect bodies bounce on. A node
  dragged with the gizmo drops back onto the ground under it. A line does not follow later sculpting on its
  own; its next edit re-seats it.
- A line lays out at most 1000 members (`LINE_MAX_MEMBERS`, the API's repeat limit); past that the spacing grows.

## Editing

Selecting a line — a click on a member, or on one of its node bulbs — outlines every member, draws the path in
teal, and puts a bulb on each node. The bulbs draw on top and win the click on top, since a node sits at a
joint inside the very fence it lays out. Dragging a node's gizmo re-lays the line live.

The **Line** section of the Tools panel:

| Control | What it does |
| --- | --- |
| members | how many copies, of what |
| place | between points (a fence) / at every point (posts, lamps) |
| spacing (m) | metres between copies, measured straight; **↺ model length** goes back to end to end |
| turn (°), ↻ quarter turn, ⇄ flip side | turn every copy, on top of the automatic alignment |
| follow slope | tilt copies along the ground (span only) |
| size × | scale every copy |

Then **✚ add more points**, **✕ delete this point**, **⇄ swap prop…**, **⇥ break into props** and **✕ delete
line**. Below them are the sections a placed prop has — mode presence, contact & collision, lighting, impact
sound and emitters, or for a group the Members list and its per-member panels — bound to the line's template,
so an edit reaches every copy. Delete removes the selected point, or the whole line with no point selected; Esc deselects.

### Effects

Members get what a hand drop gets (`PropOps.stampHeldEffects`): the held prop's effect through the slot every
placement of it shares — so a GARI fence flexes panel by panel — and anything the model declares for itself.
A member added later (a longer line, a tighter spacing) takes its siblings' attachment; a member removed takes
its attachment and any screen fitted to it. Swapping the prop re-stamps every member with the new pick's effect.

A **sheet** ([071](071-sheet-props.md)) is a line whose spans are filled by generated textured quads rather
than copies of a model — the seamless fence or river the shipped levels store as hundreds of one-quad pieces.
It shares everything above; only what fills a span differs.

## Not yet

- **Closed loops** — fencing in an area. The curve is open-ended like a rail's.
- **A post at every joint** — a second model for panel-and-post kits.
- **Variation** — random turn and size per member, for a row of trees.
- **Gaps** — a member left out for a gate. Break the line into props for now.
