# Rail spline SSF flag pair — dead authored rails

Working notes behind the spec claims in `230-level-ssf.md` (spline records)
and `350-rails.md` (tube-prop collision). Clean statements live there; this
is the repro chain and the raw census.

## Symptom

MOUNTAIN12 (Slopesmith export, repacked as GARI with `snowknife repack`):
6 authored grind rails, correct in the Slopesmith preview and in Unity, but
on the PS2 disc there is **no rail lock-on at all** — the rider passes
through the tube and never attaches to the curve.

## Elimination chain

Everything downstream of the SSF record checked out in the shipped members
(extracted back out of the built ISO):

| Layer | Check | Result |
|---|---|---|
| PBD spline section | count @0x20 / segments @0x24 | 6 / 55 ✓ |
| `.ltg` grid | `ltg-stats` node SplineIndex lists | 55 segments listed ✓ |
| SSF spline styles | last `8×N` bytes of the `.ssf` | style 13 on all 6 ✓ |
| Mode gating | GARI `HideShowOff` MainType-25 Effect-0 targets | spline indices 11–168 only — authored indices 0–5 escape the freeride disables ✓ |
| SSF flag pair | the two i16s before the style | **(0, 0) — never ships on any disc** ✗ |

The authored records read `(0, 0, 13)`; every grindable spline on all five
discs reads `(1, 1, style)`.

## Census (extracted `Splines.json`, all five levels)

- GARI 169/169, MESA 100/100 (including the fallen-tree splines that start
  non-grindable — so the pair is **not** the initial candidacy bit),
  MERQUER 166/169, SNOW 290/293, ELYSIUM 289/296: **(1, 1)**.
- The only exceptions are non-rail path splines, all `(−1, −2)` with style
  −1: MERQUER `spline_trainpath_00`, `Spline_SubwayEnd_0/1`; SNOW
  `Spline_GondolaWire_1000/3000/4000`; ELYSIUM
  `Spline_HalfPipeThing_Rail_5000..5006`.
- `(0, 0)` appears nowhere.

## Data path

`Splines.json` `U0`/`U1`/`SplineStyle` → `TrickyLevelInterface.cs:1514-1516`
→ `SSFHandler.Spline` `{i16 U1, i16 U2, u32 SplineStyle}` → the spline
table at the tail of the `.ssf`. Slopesmith's `buildSplinesJson` wrote
`U0: 0, U1: 0`; fixed to `1/1` (`Slopesmith/src/core/export/level.ts`), and
`repack` normalises zeroed/missing values on the authored-Splines
overlay so pre-fix exports pack correctly (`Snowknife/Snowknife/Services/RepackService.cs`).

## Open lead

Where the engine reads the pair is untraced. Candidates: the spline
scene-object constructor at level load (the style read must be nearby,
since style 13 sets the default candidacy bit — `350-rails.md` admission
bit at `*(segment+0x58)+0x18`), or `RailMan_RegisterRailEffectCandidate`
@0x00149038. Worth a look next time the ELF is open: find the loader walk
of the 8-byte records and see which field lands where. Also still pending:
a ride test of the (1, 1) fix on MOUNTAIN12 (the (0, 0) failure is
ride-confirmed; the fix matching the discs is not yet ridden).

## Side answer: tube colliders on the original discs

Asked while debugging: did the originals ship "smaller colliders inside"
their rail tubes? No — census in `350-rails.md` `[[350-tubeprops]]`: GARI
and MERQUER tubes have **no collision at all**; MESA/ELYSIUM tubes have
**full-size** mode-1 mesh colliders (MESA sample: collider bounds identical
to the render mesh, 15 verts each); SNOW mixes mode 1 and mode-2 bounds
slabs; supports are mode-2 slabs everywhere. Grinding coexists with the
solid tubes on MESA/ELYSIUM, so object collision does not veto lock-on.
Our repack ships tubes with no collision (the GARI/MERQUER configuration).
