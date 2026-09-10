# 066 — A scored build loop for terrain authoring

Build a small feature, measure it, inspect it and ride it before extending the course. Use a scorecard
to find specific problems and track improvements against the previous saved state. No single score,
patch count or match to another mountain establishes quality.

Start with the [terrain vocabulary](064-terrain-vocabulary.md) for the feature's purpose and the
[course-building guide](065-course-building.md) for its construction. Keep geometry, assets and ride
results separate so that a successful check in one category does not hide a failure in another.

## Keep the loop reproducible

1. **Read:** save the current document, revision, lighting and relevant stable IDs. Name a checkpoint
   before a substantial topology change.
2. **Specify:** state the feature's riding purpose and what the pass should improve. Choose a bounded
   section including its approach, exit and neighbouring joins.
3. **Author:** construct a candidate from that document. Preserve unrelated channels and separate
   generation from the API write.
4. **Measure:** validate the schema and run the relevant surface, seam, topology and route probes.
5. **Publish:** write against the revision that the candidate was built from. Reconcile a conflict;
   do not apply a fresh revision number to an old snapshot.
6. **Inspect and ride:** confirm the live revision in the browser, review the saved views with the
   saved lighting, and observe the intended lines with scenery present.
7. **Record:** save results, decisions, remaining issues and a checkpoint. Proceed when the feature
   and its connections support the next section.

Repeat after a meaningful correction. Run local checks while editing, then the full route when joins,
obstacles or gameplay changes can affect completion. Avoid repeating unrelated tests after a pass
whose relevant checks already succeeded.

## Use a scorecard with clear limits

| Check | Useful evidence | What it does not establish |
| --- | --- | --- |
| Document validity | Valid schema, references and object fields | Smooth or rideable geometry |
| Surface orientation | Evaluated normals and non-degenerate derivatives within patches | That every steep or downward-facing rock patch is wrong |
| Positional seams | Full shared control curves and sampled gap distances, including partial T-edges | Tangent continuity |
| Smooth joins | Normal-angle samples on both sides, with parameter directions aligned | Whether a deliberate fracture should be smoothed |
| Boundary topology | Incident-face counts and classified boundary loops after splitting host edges at T-nodes | That all visible overlaps are buried |
| Quilt intersections | Curved perimeter samples against the host surface and opposing views | Exact global solid containment |
| Route coverage | Samples between knots, across the lane and at its edges | Collision clearance or the correct layer under an overhang |
| Profile and rhythm | Grade, width, curvature and recovery intervals at stated scales | A universal difficulty rating |
| Asset readiness | Preflight and successful tracked browser loads | Correct lighting, placement or effect execution |
| Ride results | Completion, hits, resets, stalls and landing observations per route | Every possible player trajectory or downstream runtime |

Include units, sample spacing or parameter resolution, tested regions and tolerances with each
measurement. Report the worst location as well as a summary. A tiny positional seam gap with a large
normal-angle jump is a shape problem, not a missing-vertex problem.

## Inspect the actual Bézier surface

Use `quadControlPoints` from [topology.ts](../../src/core/mesh/topology.ts), then `patchPoint` and
`patchNormal` from [bezier.ts](../../src/core/math/bezier.ts). A tessellated facet angle mixes
surface curvature with edge discontinuity; it is not the same measurement as normals evaluated on
either side of a shared patch boundary.

For an exact subdivision, compare children against the corresponding parent parameter intervals.
For a T-junction, restrict the coarse edge and surface to each fine interval before comparing them.
Checking only pairs of complete shared edges misses fine-to-coarse joins.

If an edit changes a shared handle, check the neighbouring patches as well. If it changes topology,
check sparse channel remapping, stable IDs and all affected T-junction records. For ordinary snow,
look for folds throughout the patch; corner winding alone can miss them. For vertical or overhanging
rock, preserve the intended surface orientation rather than demanding a positive Y normal.

Treat a height query as a limited probe. `POST /api/projects/<id>/ground` returns the upper terrain
surface at an XZ position. It may find the river below a gap or a cliff cap above a lower line. Use
the intended patch and three-dimensional queries when that distinction matters.

## Compare design quantities in the same frame

Keep authored metres/Y-up separate from imported raw axes and renderer coordinates. State the
conversion before combining data. Compare trail area with trail area, whole-mountain area with
whole-mountain area, and similar feature lengths with each other.

Record whether grade uses horizontal distance or another denominator; conventional percent grade
uses vertical change over horizontal travel. It is not degrees. Use multiple profile windows to
distinguish sustained pitches and benches from smaller rollovers. Thresholds chosen for one map's
scale should not silently become requirements for another.

Patch counts, pole counts and material percentages are descriptive. A lower patch count can be an
improvement if it replaces repeated strips with a better buttress and snow pocket. Evaluate those
relationships in the lit view and control cage rather than optimizing the counts themselves.

## Observe complete rides

Use a browser view with `mode=test`, then **Play** or **Watch the AI**. Opening the view only opens
the test setup; it does not run the course. Observe finish or failure explicitly.

For a local headless check, the existing [authored-mountain runner](../../scripts/ai-mountain-run.ts)
uses the editor's terrain and ride systems. From the Slopesmith directory, substitute the project
identifier and choose a duration long enough for completion:

```text
npx tsx scripts/ai-mountain-run.ts <PROJECT> 120 --riders 6
```

Placed props participate in the normal run. The runner's `--no-props` option is useful for diagnosing
whether a failure comes from terrain or scenery; it is not a replacement for the final run with
obstacles. Consult the script's current options for tracing or assertions.

Record how many riders finished and what failed. Test each optional line through its approach and
rejoin, using an appropriate route probe or manual ride; the default main-course run does not certify
every branch. Look at contacts near signs, tree canopies, bridge braces and narrow shelves. Move or
reshape misplaced obstacles, then rerun the affected route.

Test trigger crossings, fog visibility, fireworks and knockable props in the mode that executes them.
Successful static rendering is not evidence that their gameplay behaviour ran.

## Keep an honest validation record

A useful text record includes:

- Project ID, actual revision, checkpoint and the section/feature labels checked.
- The intended change, affected stable IDs and preserved boundaries.
- Surface and seam measurements, classified open boundaries and deliberate creases.
- Asset and placement results under the saved lighting.
- Routes tested, rider counts, completion and observed failures.
- View URLs, probe settings, bundle location and remaining limitations.

Camera links reproduce framing and view modes, not historical geometry. A `revision` parameter checks
the current project; keep the checkpoint or bundle to preserve the old state. Confirm browser
readiness and revision after reload, especially following material or whole-document changes.

Report a sampled clean corridor as a sampled result, not proof that the mountain has no holes.
Distinguish an intentional buried fracture boundary from an unexplained slit. State any untested
route or export target. The portable project bundle, browser ride and downstream engine/console
export each need their own verification.
