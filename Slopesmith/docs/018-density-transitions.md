# 018 — Density transitions (stamps, terminators, block refine)

Fidelity to the reference terrain is mostly a *density* story: the measured levels spend their patch
budget on the racing line (10–20 m cells on course, 30 m+ on the surround) and change resolution with
a small, exact vocabulary — pole transitions inside the sheet, T-seam refinement at region borders,
and strip terminators where a dense band simply ends. This doc specifies those as one tool family
built on the [017](017-topology-surgery.md) primitives, so a creator gets the "not too many poles,
perfectly placed" outcome without hand-deriving the patterns.

## The invariants the tools enforce

Measured/derived on the reference quilts (see the pole study in the terrain notes and the temp
deconstruction scripts):

- **Parity.** A quad disk always has an even boundary-edge count, so a 1→2 transition is impossible;
  in-sheet density changes step 1:3, 2:4, … (difference even). The tool rejects impossible requests
  instead of producing a broken stamp.
- **Transition-end cost.** A watertight transition end costs a fixed pole set — 5-poles at the mouth's
  lateral corners, 3-poles at the tips. The reference's 5-pole rows sit exactly at transition ends,
  with 3:1 the dominant ratio. Stamps place precisely this set, nothing more.
- **Pole/curvature law.** 3-poles live on domes/bowls (positive Gaussian curvature), 5-poles on
  saddles, with ~zero violations in the reference; *flow* poles (the transition sets above) live on
  near-flat ground. Stamps therefore prefer flat placements, and [021](ideas/021-fidelity-lint.md) audits
  the law after the fact.

## Ops

### Band transition stamp (1:3, 2:4)

Input: a selected cell band (the existing cell-selection range, [006](006-surface-net.md) S7) plus a
ratio. The stamp rewrites the band into the canonical transition: the dense side continues at k× the
coarse column count, the transition row carries the mouth/tip pole set, wedges fill the dart tips
(017's triangle op). Ghost preview shows the resulting topology with pole dots before commit.

- New vertices seat on the derived surface (Bézier-evaluated, as loop cut does), so the stamp is a
  topology change with minimal shape change.
- Orientation: the band's long axis is the transition line; the wheel flips which side densifies.
- Composition: a course-following corridor is a run of band stamps; the tool chains them along a
  selected face loop so a whole corridor densifies in one gesture.

### Strip terminator

Ends a dense strip inside the sheet: caps the k extra columns with the mouth/tip pole set. This is
the "finite resolution strip" pattern the reference uses everywhere a groomed band fades into open
terrain.

### Block refine (T-seam)

For broad areas (a whole bowl, a canyon floor) the reference uses exact subdivision with **T-seams**
at the region border: the fine boundary curves lie *on* the coarse ones (coincident border edges),
crack-free to render, topologically open. Slopesmith reproduces this exactly:

- Selected rectangular cell block → de Casteljau split each quad k× per axis. The split is
  shape-exact (measured to 1e-12 m), so the surface does not move at all.
- The block's rim vertices become hanging nodes: the fine quads and the coarse neighbours simply do
  not share ids. `topologyFromQuads` reads these as boundary edges — the same representation the
  reference data has. **The T-seam invariant is geometric**: fine rim curves must remain on the
  coarse curve. Edits that move a T-seam vertex re-project it onto the coarse-side edge curve (the
  frozen-surface slide machinery from the surface gizmo, applied to a curve); [021](ideas/021-fidelity-lint.md)
  flags any drifted T-seam as a real crack.
- Split handles use exact subdivision (not Bessel re-fit) so creases and tuned tension survive
  refinement; interior twist offsets ([020](020-patch-finish.md)) split with the patch.

Committed guidance (not a choice dialog): **band stamps** for course-following density, **block
refine** for broad regions, **terminators** to end strips. All three are shipped reference practice.

## UI

One "Density" group in the Edit tool: Stamp 1:3, Stamp 2:4, Terminate strip, Refine block ×2/×3.
Every gesture: cell-select first, ghost with pole dots + parity verdict, wheel for orientation/ratio,
commit/Esc. The Tools note shows the patch-count delta before commit — density is budget, and the
budget lives in [021](ideas/021-fidelity-lint.md).

## Verification

- Unit: stamp output pole census matches the canonical set per end; parity checker rejects 1:2;
  block refine derives a byte-identical surface (sampled) and exactly-coincident rim curves.
- Smoke: stamp + terminator on a seeded grid, then export — bake consumes the quilt (wedges included)
  with no cracks at welded seams.
- In-browser: corridor chain along a face loop; ride the result (docs/016) across both seam kinds.

## Staged build

- **S1 — block refine** (exact split, T-seam rim, re-projection on edit).
- **S2 — band stamp 1:3** + parity checker + ghost.
- **S3 — terminator + 2:4 + corridor chaining.**
