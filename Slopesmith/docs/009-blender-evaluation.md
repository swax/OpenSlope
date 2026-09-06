# 009 — Blender evaluation

How much of Slopesmith's architecture a general DCC tool (Blender) could carry, tested against
the live representation rather than argued in the abstract. This is the long form of
[001 — Design](001-design.md)'s "Why not Blender", read against the surface-net the editor
actually authors today ([006 — Surface net](006-surface-net.md)) and the files it must emit
([003 — Export Contract](003-export-contract.md)). Prototype: `blender/ssx_cage_bridge.py`.

## The answer depends on which layer

Slopesmith is not one thing; it is six separable layers, and Blender grades very differently on
each. The whole question collapses into this table:

| Layer | What it is | Blender |
|---|---|---|
| **Cage manipulation** | corner control net + sparse handle overrides (`MountainDoc.corners`/`handles`) | **Excellent** — the cage *is* a quad mesh |
| **Per-patch attributes** | `SurfaceType` / `TexturePath` / `TrickOnlyPatch` per cell | **Good** — face attributes + material slots |
| **Lighting bake** | the [008](008-lighting-study.md) sun → `A_S`/`C_S` lightmap pages | **Strong engine, custom format** — Cycles bakes; packing is yours |
| **Preview parity** | viewport tessellates the *exact* bake evaluator (`bezier.ts`) | **Broken** — no native primitive is the SSX surface |
| **Export contract** | `Patches.json` / UV transpose / lightmaps / `Lights.json` | **No help** — the addon writes all of it |
| **Amateur thesis** | "make the *course* the primitive; never open a DCC tool" | **Defeated** — Blender is the opposite premise |

The first three are why a Blender *complement* is attractive; the last three are why it is not a
*replacement*. Each claim below is measured, not asserted.

## What Blender cannot give you: the surface

The game boards on a watertight quilt of **bicubic Bézier patches that interpolate their corner
control points** (`cellControlPoints` sets `cp[0]=A`), with **Bessel tangents** and **deliberate
per-seam creases** (006). Blender's two smooth-surface primitives are Catmull-Clark subdivision
and NURBS — both use the *approximating* B-spline basis, which does **not** pass through the
control net.

Measured directly: take one control cage (4 m spacing), derive the SSX surface from it, and
subdivide the *same* cage with Catmull-Clark (level 4):

- the SSX surface passes through every control corner — **offset 0 by construction**;
- Blender's subdivision limit sits **up to 0.42 m (mean 0.17 m) off** every corner — ~10 % of cell
  size, growing with curvature.

So Blender's viewport cannot be the WYSIWYG preview: what the artist sees (subsurf / NURBS) is not
what bakes, which discards Slopesmith's central principle — *the preview is the game's geometry,
not an approximation* (001). NURBS is wrong twice over: a Blender NURBS surface is one **global**
B-spline grid, so it is globally continuous (cannot crease a seam — 006 wants creases as a feature)
**and** non-interpolating. The only faithful route is to edit a quad **cage** and re-run the SSX
derivation on export — which is exactly the prototype below, and which means the geometry
intelligence stays in the addon, not in Blender.

## What Blender cannot keep: grid topology

The per-patch bicubic model requires a clean rectangular `(R+1)×(C+1)` grid — every interior
vertex valence-4, no triangles, n-gons, or extraordinary corners. That is the same constraint that
makes arbitrary original levels a read-only Reference and not an importable document (006, Non-goals).
Slopesmith makes invalid topology **impossible to express**; the user only ever moves corners.
Blender will happily let a knife cut, an inset, or a dissolve introduce a triangle or a valence-5
vertex — and the instant it does, the patch derivation is undefined. A Blender path therefore needs
an addon that continuously **validates and repairs** the mesh back to a grid: precisely the
"large addon that enforces invariants" 001 warned about, and real, ongoing work.

## What you still write either way: the export contract

None of [003](003-export-contract.md) comes free from Blender. glTF export yields **triangles** —
the one thing the contract explicitly forbids, because it discards the continuous surface that
makes the format good. The UV index-transpose `(uvA,uvB,uvC,uvD) = (c0,c2,c1,c3)`, the
`raw = (-100x,-100z,100y)` bijection, the `(du×dv).y < 0` winding, the AIP delta-encoding, the
8×8 lightmap tiles with `alpha = A_S` / `RGB = C_S`, the directional+ambient `Lights.json` — every
one is custom. An export addon is essentially `level.ts` + `bake.ts` re-hosted, minus only the
parts `snowknife` already owns. The contract is the same cost on either path.

## What Blender does carry well: the cage

The surface-net redesign (006) is what makes any of this viable: once the authored object became
"a net of corners plus sparse handles", it became a **mesh**, and meshes are Blender's home turf.
For a user who already lives in Blender, its mesh toolset strictly dominates Slopesmith's
hand-rolled equivalents — proportional editing, sculpt brushes, grab/relax/flatten, the
shrinkwrap and mirror modifiers, marquee/lasso select, the transform gizmo — each of which 006
re-implements from scratch (`TransformControls`, box-select, mirror-across-the-fall-line). The
per-patch channels map cleanly to native data: `SurfaceType` as a face `INT` attribute,
`TexturePath` as one material slot per tile. And Cycles would bake cast shadows / AO far better
than the dependency-free CPU depth-map rasteriser in `occlusion.ts`.

## The prototype: cage ↔ `Patches.json` round-trip

`blender/ssx_cage_bridge.py` is the concrete wedge: it imports a Slopesmith-authored level folder's
`Patches.json` as an editable quad cage and emits it straight back, re-running the same
Bessel-tangent derivation (`gridTangents` → `cellControlPoints`, ported from `bezier.ts`) so the
edited cage becomes valid `Points`. The field mapping is deliberately honest about what is and
isn't Blender-native:

| `Patches.json` field | In Blender | Editable natively? |
|---|---|---|
| `Points` (16 CPs) | derived from mesh **vertices** (the cage) + handles | yes — move corners |
| `SurfaceType` | per-face `INT` attribute `ssx_surface` | yes — face data |
| `TexturePath` | one **material slot** per tile, `material_index` | yes — assign material |
| handle overrides (creases) | `obj["ssx_handles"]`, sparse, Bessel default | no — addon-stored, captured from the source |
| `UVPoints` / `LightMapPoint` / `LightmapID` / `TrickOnlyPatch` | `obj["ssx_meta"]` per patch | no — carried verbatim |

Run live on three real exports, importing then re-emitting and diffing:

| Level | Patches | Corner grid | Handle overrides captured | Max control-pt error | Non-geo field mismatches |
|---|---|---|---|---|---|
| MOUNTAIN01 | 1060 | 107×11 | 2 (creases) | 0.019 cm | 0 |
| SLOPE01 | 480 | 49×11 | 0 | 0.004 cm | 0 |
| SMOKEMTN | 3431 | 74×48 | 0 | 0.009 cm | 0 |

Findings:

- **Geometry is lossless to float32**, not bit-exact. The `raw → editor → blender → editor → raw`
  trip is an exact bijection in the maths, but Blender stores mesh vertices as **32-bit floats**, so
  a kilometres-wide level round-trips to ~0.2 mm — negligible against a format whose unit is the
  centimetre and whose tessellation is metres, but worth stating precisely: editing the cage in
  Blender quantises corners to float32.
- **Every non-geometry field round-trips byte-exact** — `SurfaceType`, `TexturePath`,
  `TrickOnlyPatch`, `LightmapID`, `UVPoints`, `LightMapPoint` all matched across all three.
- **Creases survive.** MOUNTAIN01's two non-Bessel handles were recovered from the stored edge CPs,
  kept sparsely (the same model `MountainDoc.handles` uses), and re-applied on export.
- **Visual confirmation.** MOUNTAIN01 imports as a single clean 1177-vertex / 1060-face quad cage —
  a ~3 km banked run ribbon, grid topology intact, its powder and snow tiles as two material slots —
  ready to sculpt with any Blender tool and push back through the contract.

Limits, stated plainly: it round-trips **grid-topology levels only** (our own exports — original
stays the read-only Reference); handle overrides are **carried, not natively editable** (Blender has
no per-Bézier-handle gizmo for mesh edges, so creases are authored through the addon, not the
viewport); and because it carries `UVPoints` verbatim, a *real geometry edit* would need the addon
to recompute chord-length UVs — the same `deriveMountain` logic Slopesmith already owns.

## Verdict

**As a replacement: poor, and 001's reasoning holds up under measurement** — Blender's viewport
literally cannot show the surface that ships (0.42 m off), it cannot keep the mesh a valid grid, it
still requires the entire export+lighting contract as an addon, and it hands a never-opened-a-DCC
user the most intimidating DCC tool there is.

**As a complement: genuinely attractive, and the architecture already invites it.** The export
contract is the open interface — *anything that emits the same authored folder joins the pipeline*
(001, 003) — so this is a clean add-on, not a fork. The sweet-spot wedge is exactly the prototype,
extended two ways: (1) **power-user cage sculpting**, round-tripping grid-topology nets so an artist
shapes the corners with Blender's superior brushes and modifiers, then pushes them back through the
same derivation; (2) an optional **Cycles lightmap bake** into the SSX pages, an upgrade over the CPU
rasteriser. It deliberately does **not** try to be the previewer or the beginner tool — Slopesmith
stays the parity-correct preview and the amateur front-end, Blender becomes the high-end cage editor
for someone who already lives there. Each tool does what it is best at instead of impersonating the
other.

**The complement shipped first for PROPS, not terrain** — [046](046-blender-bridge.md). That inverts the
order this page anticipated, and the measurement above is why: the terrain sweet spot needs a cage bridge
because no Blender primitive is the SSX surface, while a prop is a polygon mesh in *both* tools, so the same
round trip is simply lossless. 046 also drops the file-on-disk step this prototype rests on — an add-on talks
to the running service, so a model is pulled and pushed rather than exported and reimported, and it lands back
on the model it came from with its number, its name and its placements intact.
