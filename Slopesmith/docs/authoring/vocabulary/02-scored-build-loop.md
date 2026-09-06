# Design Study 02 — A Scored Build Loop (toward authoring an original mountain)

> Study 01 decomposes a shipped SSX mountain's terrain into a parametric vocabulary. This doc turns that
> vocabulary into an *executable feedback loop*: a scorecard that measures any level against a reference
> mountain's numbers, and a first authored candidate driven through the existing bake pipeline, scored against the
> reference to read the gap. The point is not the candidate — it is the loop, and the structural findings the loop
> surfaced. Tools live in `tools/mountain-study/`: `score.ts`, `build-candidate.ts` (figures/output write to
> git-ignored `temp/`).

## The loop

```
author CourseDoc  ──>  buildLevel()  ──>  Maps/<NAME>/  ──>  score.ts vs ref   ──>  read gap ──┐
   (a spec in code)   (Slopesmith core,    (Patches.json +        (live reference mtn,             │
                       headless)            AIP.json + Textures)    same physical frame)             │
        ^─────────────────────────────────────────────────────────────────────────────────────────┘
```

`buildLevel(doc)` is Slopesmith's loft (`src/core/math/{spine,bezier}.ts` +
`src/core/export/level.ts`; the grid sweep since folded into `src/core/doc/mountain.ts`) driven
as a *library*, no UI — `CourseDoc` is knots (pos + width/wall/bank/shoulder) + surface paint, and
it emits the exact authored-folder contract `snowknife gltf` consumes (study 01's pipeline steps
1–4: spine, cross-section, loft, surface striping). Scoring reads `Patches.json` + `AIP.json`
directly, so the loop closes **without** running the bake — Unity is only needed for the final
ride test, not for measuring whether a course has the reference mountain's shape.

## The scorecard (`tools/mountain-study/score.ts`)

Computes the reference mountain **live** as the reference column (scoring it against itself yields all-zero deltas — the
tool's own sanity check), then measures the target in the same frame and prints per-metric deltas
with `ok` / `~` / `XX` flags. Metrics are study 01's "generator rules" made measurable:

- **Profile rhythm** off the main course line (Race Line 0, else longest race line, else longest
  Respawnable path; resampled to 6 m): length, drop, avg grade, the grade-band split over a 100 m
  window (`flat <15% / easy 15–50% / mid 50–90% / steep >90%`), terrace crest spacing (convex
  rollover events, non-max-suppressed at 30 m), and convex/concave fraction (vertical R < 125 m).
- **Surface mix**: rideable area by family (snow / powder / ice / rock / ramp), as % of rideable.
- **Quilt continuity**: shared-edge count, watertight count, and the face-facet dihedral across
  shared edges (median / p75 / fraction > 15° = creases). *Note this is a face-normal fold angle —
  it conflates genuine terrain curvature with intentional creases, so it runs hotter than study
  01's control-tangent kink (median 0.2°); it is a valid comparative metric, not the same statistic.*

From `Slopesmith/`, run: `npx tsx tools/mountain-study/score.ts` (reference self-check),
`npx tsx tools/mountain-study/score.ts <MOUNTAIN>`, or `npx tsx tools/mountain-study/score.ts OpenSlope01`.

## Finding A — invariants vs style dials (two shipped mountains)

Scoring a second shipped mountain against the reference separates what is a **rule** (both courses
converge) from what is a **dial** (each course chooses). This is the single most useful output for
authoring: hit the rules, choose the dials per mountain.

| Metric | Reference | Second mountain | verdict |
|---|---|---|---|
| avg grade (main line) | 70.1% | 70.3% | **rule** — ~70° -ish average is a constant |
| convex rollover frac (R<125 m) | 30.7% | 29.3% | **rule** — ~30% of the line is kicker-curvature |
| surface family ordering | powder ≫ rock > snow > ice | powder ≫ snow > rock > ice | **rule** — powder-dominant, ice rare |
| continuity character (dihedral med / p75 / crease) | 18° / 34° / 57% | 21° / 38° / 64% | **rule** — watertight quilt, ~60% creased edges |
| total drop | 2968 m | 2110 m | dial — mountain size |
| flat (<15%) fraction | 7% | 26% | dial — the second mountain is benchier |
| terrace crest spacing | 60 m | 113 m | dial — the second mountain's rollers ~2× farther apart |
| ice content (% rideable) | 3.2% | 9.3% | dial — the second mountain is colder/icier |

## Finding B — the reference profile is bimodal at *two* scales

The candidate (`OpenSlope01`, below) converges on avg grade, convex/concave, length and drop on the
first authored rep, but **cannot reproduce the band split** with a single-frequency rhythm. The
reason is structural and is the key authoring lesson:

- A 100 m grade window only reads `flat` or `steep` when a pitch or a bench is itself **longer than
  ~100 m** (the window center sits entirely inside it). The reference gets 7% flat + 42% steep because it has
  **long sustained macro-segments** (the ice-canyon pitch, the flat river shelf, the finale plunge)
  *with* short terrace lips (50–100 m convex rollers) superimposed on top.
- A course built as one ~80 m pitch/bench cycle (OpenSlope01) has only the *micro* scale: every 100 m
  window straddles a pitch and a bench and averages into `mid` (50–90%). It looks rhythmic but reads
  as monotone grade at the window scale.

**Authoring rule:** lay down a *macro* pitch/bench/shelf structure first (segments > 100 m: a couple
of sustained steep faces, a flat regroup shelf, a finale), then superimpose the *micro* terrace lips
(50–100 m rollers) on top. Study 01's "terrace lips every 50–100 m" is necessary but not
sufficient — it is the second layer, not the whole profile.

## Finding C — a lofted ribbon is the *trail*, not the mountain

OpenSlope01 is a single lofted strip. Its surface mix (snow 68% / ice 18% / powder 14%) does **not** match
the reference's *whole-mountain* mix (snow 12% / powder 62% / rock 23% / ice 3%) — and that is correct, not a
defect: it closely matches the reference's **MainPath trail** composition (study 01: 68% snow + 25% ice). The
whole-mountain powder dominance is the off-trail fringe — the 25–75 m powder shoulder of every lane
plus the 27.7 ha mega-field — which a spine loft structurally does not produce. Reproducing the
*mountain* mix needs the stacked-lane / powder-fringe layer (study 01's freeride findings), i.e. the
freeform terrain stage, not just a wider shoulder. A single ribbon authors a faithful **race trail**;
it does not author a **mountain**.

## Finding D — authored raw ≠ original raw (axis convention)

The scorecard had to be made frame-aware. Extracted original data is −Y-up (vertical at raw index 1:
`up = −raw1/100`). Slopesmith's authored `toRaw = [−100x, −100z, 100y]` puts vertical at raw index 2
(`up = raw2/100`); the bake's `RootEuler [270,0,0]` reorients it at import, so the round-trip works,
but the two on-disk files are **not** in the same axis frame. `score.ts` detects authored levels by
`PatchName` (`Cell_r*`) and swaps the decode so the reference and a candidate are measured in one physical
frame. Area- and angle-based metrics (surface mix, dihedral) are frame-invariant and were unaffected;
only the up-axis-dependent profile metrics needed the fix. (This is the axis inconsistency flagged in
the functional spec review; here it is a measurement gotcha, not a bake bug.)

## The first candidate (`OpenSlope01`, `tools/mountain-study/build-candidate.ts`)

A 22-knot course: gate plateau → near-vertical launch drop → landing bench → a wall-banked S with
ice painted on the bank cells → six terrace cycles → finale plunge + runout. Snow floor, powder
shoulders, ice banks. Scored vs the reference:

| Metric | Reference | OpenSlope01 | flag |
|---|---|---|---|
| spine length | 991 m | 997 m | ok |
| spine drop | 501 m | 478 m | ok |
| avg grade | 70.1% | 64.6% | ok |
| convex (R<125 m) | 30.7% | 34.8% | ok |
| concave (R<125 m) | 25.2% | 33.5% | ~ |
| band flat <15% | 7.3% | 0.0% | XX → Finding B |
| band easy 15–50% | 25.4% | 34.7% | ~ |
| band mid 50–90% | 25.3% | 36.6% | ~ → Finding B |
| band steep >90% | 42.1% | 28.8% | ~ → Finding B |
| terrace crest spacing | 60 m | 101 m | ~ |
| dihedral median / p75 | 18° / 34° | 22° / 38° | ~ |
| surface mix | (whole mtn) | (trail) | Finding C |

The macro-shape invariants land on the first rep; the band split and crest spacing are the next
iteration (apply Finding B); the surface mix and the missing freeride layer are the next *capability*
(Finding C), not a tuning knob.

## Next

The two-scale profile (Finding B: macro pitch/bench/shelf > 100 m with micro lips on top) converges
the band split — **steep >90% 42.5% vs reference 42.1%** (avg grade 72.1, drop 513, length 945;
convex still light at 19% vs 31%).

The end-to-end runbook for taking a candidate like OpenSlope01 into Unity (bake → bootstrap → stage →
import → ride-ready) is [00 — Pipeline](../../../../Unity/docs/authoring/00-pipeline.md). Remaining: actual ride-feel test; lift
convex density (rollers) toward 30%.

- Add the width/lane and wall-vs-radius metrics to `score.ts` (study 01 has the targets; they
  need spine-relative cross-section sampling, heavier than the profile metrics here).
- The off-trail layer (Finding C): score a candidate's *whole-mountain* powder fringe — requires
  authoring beyond a single ribbon (stacked lanes / freeform terrain).
- Lightmap/luminance bake for authored levels (terrain is flat-white without `Lightmaps/`); is
  the reference terrain's luminance ≈ sun hillshade + gully AO, i.e. computable from the surface?

## Reproduce

```
cd Slopesmith
npx tsx tools/mountain-study/score.ts            # reference self-check (all deltas ~0)
npx tsx tools/mountain-study/score.ts <MOUNTAIN> # a second shipped mountain: invariants vs dials (Finding A)
npx tsx tools/mountain-study/build-candidate.ts  # write Maps/OpenSlope01
npx tsx tools/mountain-study/score.ts OpenSlope01      # the gap (Findings B, C)
```
