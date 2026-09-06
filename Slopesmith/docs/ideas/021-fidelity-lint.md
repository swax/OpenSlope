# 021 — Fidelity & performance lint (the reference envelope, live)

"Build a mountain with the fidelity and performance of the original maps" is a measurable claim: the
reference levels sit inside a numeric envelope we have already extracted (pole studies, the temp
deconstruction and cage-test scripts). This doc turns that envelope into a live lint — a HUD panel
while editing plus a section in the export preflight ([011](../011-export-target.md),
`src/core/export/preflight.ts`) — so a creator sees drift when it happens, not after a bad export.

Code home: `src/core/fidelity.ts` (pure: derived quilt in, findings out), panel in `src/app/`.

## The envelope (measured on the reference levels)

| Metric | Reference envelope | Lint verdict |
|---|---|---|
| Patch count | ~1.6k–4.3k per level | warn > 4.5k (PS2 + Quest budgets), info < 1k |
| Median patch edge | 10–30 m (median ~28 m); densest on the racing line | warn if median < 8 m (topology spent where [020](../020-patch-finish.md) CPs would do) |
| Extraordinary corners | ~15% of interior corners; 3s and 5s both present | info outside 5–25% |
| Pole/curvature law | 3-pole on positive Gaussian curvature, 5-pole on negative; ~0 violations among curved poles (angle defect > 0.2 rad) | **flag each violation** with jump-to (a 3-pole on a saddle fights the surface) |
| Wedges (collapsed-edge quads) | 3–9% of patches | warn > 12% |
| Seam smoothness | bimodal: exact welds (≤0.5°) + deliberate creases (>10°), thin middle | **flag 2–10° seams** as accidental kinks — neither weld nor crease |
| Open boundary | rips/lips/holes are normal; T-seams coincide exactly | **flag drifted T-seams** (fine rim off the coarse curve = real crack) |
| Handle/chord | median ⅓, artist spread ~0.2–0.5 | info outside 0.15–0.6 (degenerate or ballooned handles) |

Findings carry a position; clicking one flies the camera there (the double-click-focus path). Three
severities: **error** (will look/ride broken: drifted T-seam, NaN, non-manifold), **warn** (outside
the reference envelope), **info** (notable, not wrong).

## Performance side

The same pass reports the numbers that decide runtime cost, with the measured traps annotated:

- **Patch budget vs target** — the PS2 path tessellates every patch in the render gather; the Unity
  bake's draw count follows the per-texture draw groups. Patch count is *the* lever; the panel shows
  it against the envelope and the delta each [018](../018-density-transitions.md) gesture would add.
- **Render-gather sanity (PS2 target)** — the grid cell list must stay a single gather list
  (multi-list is a measured 30 fps trap in the repack pipeline); preflight recomputes the exported
  footprint and confirms.
- **Texture/tile classes** — already in preflight (native/borrowed/custom); shown alongside so one
  dialog answers "will it run".

## When it runs

- **HUD panel** (toggle in the Tools box): recomputes on document change, throttled; cheap metrics
  (counts, budget) live, expensive ones (Gaussian defects, seam angles) on idle. All of it reuses
  the derived quilt the preview already holds — no second derivation.
- **Export preflight**: the full pass, blocking on errors (with override), summarising warns.
- The seam/pole math is the cage-test/pole-study math (angle defect at poles, cross-CP G1 angles,
  T-seam curve-coincidence) applied to our own quilt — the same yardstick that measured the
  reference, so "inside the envelope" means exactly "indistinguishable from shipped practice".

## Verification

- Unit: each metric reproduces its known reference value when fed a loaded reference quilt (the
  envelope numbers above are the fixtures).
- Smoke: a seeded grid lints clean; a deliberately broken doc (drifted T-seam, 5° kink, 3-pole
  stamped onto a saddle) yields exactly the three planted findings.
- In-browser: panel updates while sculpting; click-to-fly lands on the finding.

## Staged build

- **S1 — counts + budgets** (patches, cell sizes, wedges, open-boundary census) in HUD + preflight.
- **S2 — seam classes** (weld/kink/crease, T-seam coincidence) with jump-to.
- **S3 — pole law** (angle-defect Gaussian sign vs valence) + envelope fixtures from a loaded
  reference.
