# 019 — Rips, lips & holes (open-boundary editing)

The reference quilts are not watertight everywhere on purpose. Measured on one reference level: 1758
border edges over ~3.9k patches — paired **rip** slits (snow piled against a rock face with a hard
break; ~70% of rip lips sit on a snow↔rock or ice↔snow SurfaceType boundary), **free lips** where a
sheet simply ends under an overlap, and closed **hole** loops. The bake and the game both consume
open seams fine. Slopesmith's watertight invariant ([006](../006-surface-net.md)) is the right *default*,
but matching reference fidelity needs deliberate openings as first-class edits.

Built on [017](../017-topology-surgery.md)'s op contract (pure rewrites, remapIds, manifold guard).

## Ops

### Rip (un-stitch along a path)

Input: a vertex path picked along existing edges (click-drag along the cage; the path highlights).
The op duplicates every interior path vertex and reassigns the quads on one side to the duplicates —
the seam becomes two boundary chains ("lips") that share endpoints only (a slit), or nothing at all
if ripped through to the rim.

- **Endpoints pin by default** (a slit — the reference's dominant form). Ripping across the rim
  unpins that end. A single interior edge reaching the rim can rip too; a path from rim to rim
  splits both endpoints, so cutting across a 2×2 quilt separates it into two halves.
- A rip that ends mid-sheet leaves a **free lip** hairpin — legal, shipped practice.
- After the rip the two lips are selectable as groups; **lift** is just the existing multi-select
  surface gizmo (raise one lip a few metres — the snow-against-rock break). No new movement code.
- Paint: the tool offers per-lip SurfaceType/texture assignment on commit (`quadPaint`/`quadTex` on
  each side's quads), reflecting the measured snow↔rock correlation — but doesn't force it.

### Stitch (inverse)

Pick two boundary chains; corners pair by mutual nearest (the same pairing rule the deconstruction
uses to detect rip pairs); equal-count chains weld vertex-to-vertex (ids merge, duplicates removed);
unequal counts are rejected with the surplus highlighted (fix with 017 collapse/knife first). Stitch
+ rip round-trip is identity.

### Hole cut

Delete a selected quad set. The boundary loop it leaves is an ordinary open border. With
[017](../017-topology-surgery.md)'s bridge/cap it is reversible.

## What stays true when the mesh is open

- `topologyFromQuads` already models boundary correctly (edges with one quad; boundary vertices are
  never poles). Face loops end at lips — correct.
- The exporter emits open borders as the reference does: two coincident-or-separated boundary curves,
  no shared corner ids. Nothing downstream needs a watertight assumption — the bake winds by
  geometric orientation ([006](../006-surface-net.md) Normals).
- Sculpt/smooth brushes must not weld across a slit: neighbourhood is id-adjacency (already true for
  the mesh brush path), never position-dedup.
- Test-ride collision: both lips tessellate; the gap is real geometry the board can drop into —
  which is the point of a lifted lip.

## UI

"Open" group in the Edit tool: Rip, Stitch, Cut hole. Path picking uses edge hover + drag (same
feel as the loop-cut ghost); lips flash orange/pink (the reference-view rip colours) on commit.
[021](021-fidelity-lint.md) counts open-boundary edges and classifies them (rip pair / free lip /
hole) with the deconstruction's own classifier, so authored openings and accidental cracks are
distinguishable at a glance.

## Verification

- Unit: rip→stitch identity (ids remapped, paint/handles preserved); rip through rim vs pinned slit
  boundary counts; hole cut + cap identity.
- Smoke: export with open seams — bake succeeds, boundary curve pairs come back classified as rips
  by the deconstruction classifier (`terrain.ts` cornerSegRip lineage).
- In-browser: rip a band, lift a lip with the surface gizmo, paint rock on the high side, ride the
  break.

## Staged build

- **S1 — rip + lip selection groups** (pinned slits, rim rips, free lips).
- **S2 — stitch** (mutual-nearest pairing, guards).
- **S3 — hole cut** + per-lip paint offer + lint classification hookup.
