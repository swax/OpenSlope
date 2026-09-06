# 001 — Slopesmith Design

Why a purpose-built course editor exists, who it is for, and where it sits in the pipeline.
The math that turns its document into terrain is [002 — Course Model](002-course-model.md);
the files it writes and the conventions they must honor are
[003 — Export Contract](003-export-contract.md).

Code: `Slopesmith/` (Vite + TypeScript + Three.js). Terrain model reference:
[Trailmap: 110-terrain].

## The goal

Let someone who has never opened a 3D tool build a rideable SSX course. The target user
thinks in course vocabulary — *turns, chutes, banks, walls, drops* — not in vertices or
control nets. Every design decision below follows from that.

## Why not Blender

The terrain domain is a very constrained object: a watertight quilt of 4×4 bicubic Bézier
patches with per-patch surface types, an index-matched texture-UV corner convention, and trick/reset
flags. A general DCC tool has no primitive for that quilt, so authoring there means a large
addon that enforces boundary-point sharing, carries custom attributes, and exports — most of
an editor's code with none of the control over UX, on top of Blender's learning curve, which
defeats the amateur goal outright. A zero-install web app can instead make the *course* the
primitive. (Blender remains viable later as a power-user path: anything that emits the same
authored folder — see 003 — joins the pipeline without changes.)

## The course-grammar thesis

Users never see 16-point grids. They author a small hierarchy, and the editor derives the
quilt:

| Layer | What the user does | What it becomes |
|---|---|---|
| **Spine** | drags knots of a downhill centerline | rows of the patch grid, the AIP course line, the spawn |
| **Cross-section** | sets width / wall / bank / shoulder per knot | columns of the patch grid, blended along the spine |
| **Paint** | clicks patch cells with a surface type | per-patch `SurfaceType` + texture |

Watertightness and smoothness are then **properties of the construction, not of user
discipline**: neighboring patches share boundary control points because they are derived from
one grid (002). A control-point-level editor would have to validate what this design makes
impossible to break.

This mirrors how the original courses read: a long swept ribbon with locally varying section,
plus features. The two layers the grammar does not cover yet — local feature stamps
(kicker/drop/gap) and rail splines — compose on top of the same grid and are listed as
post-MVP in the README.

## Position in the pipeline

Slopesmith exports the **authored level folder**, the same intermediate `snowknife import`
produces when extracting an original disc. Everything downstream is reused unchanged:

```
editor ──▶ Maps/<NAME>/ ──snowknife gltf──▶ gltf/ ──snowknife unity──▶ Unity import ──▶ ride
```

That target — rather than baked glTF triangles — is the central architectural choice:

- **One tessellator.** `TerrainBundle` is the only thing that turns control points into a
  mesh, for original and authored levels alike; density/normal/welding fixes land everywhere.
- **The continuous surface survives.** The bake (and any future runtime) can re-tessellate or
  do analytic contact; exporting triangles would discard exactly what makes the format good.
- **Parity with original levels for free.** Materials, collision-per-surface, course paths,
  start-grid assignment, the Unity importer — all already proven on the extracted reference levels.

The editor's preview honors the same principle from the other side: it tessellates the same
control points with the same Bernstein evaluator at the same resolution as the bake, so the
preview is the game's geometry, not an approximation of it (002, "Preview parity").

## MVP scope

In: spine editing, blended cross-section (floor, quarter-pipe walls, bank, reset shoulders),
surface-type painting, procedural textures, course-line export, one-click export + bake,
headless smoke test (`npm run smoke`) that runs the real `snowknife gltf` and asserts the glb.

Out (deliberately, in rough priority order): feature stamps, rail authoring
(`Splines.json` style-13), texture paint decoupled from surface type, lightmaps, undo,
in-browser test ride. The last one is the long-game payoff of owning the tool: the specs
define surface response well enough to ride a course in the browser before exporting.
