# 001 — NURBS terrain authoring + analytic trail carving

Authoring SSX-style terrain in Blender as a smooth **Bezier/NURBS surface** (a
coarse control net) rather than a dense triangle mesh, then tessellating it to a
mesh at any target density and (later) exporting the control net as bicubic
patches. Helper: [`openslope_terrain.py`](../openslope_terrain.py).

## Why bother

The PS2 stores its slope as a grid of bicubic Bezier patch control points and
tessellates them adaptively at runtime ([Trailmap: 110-terrain]). That representation
buys three things, and only the first was about the PS2's memory limits:

1. **Smooth board contact at any tessellation density.** The surface is analytic,
   so the geometry the board rides is smooth regardless of how coarsely it's
   meshed — no faceting / poke-through *baked into* the geometry. (Our brute-force
   alternative — a 500k-tri mountain — only hides poke-through if the *local* edge
   length stays well under the deck thickness; total triangle count is the wrong
   metric. A ~3 km mountain at 500k tris is ~6 m facets, marginal on tight rolls.)
2. **LOD for free.** One source surface, tessellate coarse for far / dense for near.
3. **A compact, exportable master.** A few hundred control points instead of
   hundreds of thousands of verts, and the control net dumps straight out as patches.

We are not memory-constrained like the PS2, so this is optional — but it's the
clean way to get smooth ride + LOD + a small editable source. See the board
poke-through discussion in [Trailmap: 400-rendering].

## The one rule: a NURBS surface *approximates* its net

A NURBS/B-spline surface smooths its control net. Practically:

- **Constant regions reproduce exactly** — a flat floor of equal-height control
  points comes out flat at the right depth.
- **Sharp transitions round off** — a thin berm ridge gets softened.

So a carved feature only survives if the **control spacing is ≤ ~half the feature
width**. A ~5 m-wide gully needs ~2.5 m control spacing; at 3.5 m it washes out
into a shallow dip (observed directly while building this). The takeaway:

> Smooth open mountain → few control points. Sharply carved trail → a locally
> finer net right where the trail is. That density is the honest cost of the
> analytic representation; it's still a fraction of a full dense mesh.

## Carving a trail

Same trick as the dense-mesh version, but moving **control points** instead of
mesh vertices: displace each control point's height by a function of its
horizontal **distance to the course centreline**. `openslope_terrain.trough()` is a
half-pipe cross-section (flat floor → banked wall → berm lip → ease out);
`carved_height(base_fn, path_xy)` composes it onto a base hill. The NURBS surface
then interpolates a smooth banked gully you can tessellate at any density.

## Pipeline

```
control net (height_fn)            # the editable source of truth
  └─ build_nurbs_surface()         # rows -> NURBS splines -> curve.make_segment() weld
       ├─ tessellate(res=N)        # bake a mesh at any density (LOD)
       └─ export_patches(json)     # control net -> bicubic-patch JSON (order 4,4)
```

`build_nurbs_surface` hides the only fiddly bit: stitching the per-row NURBS
splines into one surface grid needs `bpy.ops.curve.make_segment()` in an
edit-mode **context override** on a VIEW_3D area. `resolution_u/v` is the
tessellation density. The exported JSON (`order`, `count_u`, `count_v`,
`control_points`) is the SSX-patch shape — a real exporter just reformats it into
the snowknife bundle's patch struct.

## Coordinates

These helpers work in plain Blender space (Z-up, metres) — an authoring sandbox.
To feed a result into the snowknife pipeline, convert with
`openslope_bundle_io.blender_to_mesh` (net mesh→Blender is `(x,-y,z)*Scale`). The course
centreline is independent of the slope representation anyway — it's a
polyline/cubic that feeds `RailNetwork`, so the path is safe either way.

## Capture gotcha (read this before screenshotting)

Any capture that reads the viewport framebuffer **freezes when the Blender window
is unfocused / backgrounded** — it returns a stale frame, including objects that
have already been deleted. Setting `region_3d` from Python doesn't force a redraw
either. Use `openslope_terrain.render_to_png()` — a real camera render (Workbench +
cavity) doesn't depend on window focus and writes a PNG you can open directly.

## Status / next steps

Experimental sandbox, not wired into the import pipeline. Proven end to end in
Blender: control net → NURBS surface → two-density tessellation → control-point
export, plus a carved half-pipe trail (943-point net, 2.5 m spacing). Natural
next steps:

1. **Real data in** — downsample the Mammoth lidar heightfield into the control
   net (replace the noise base) so it's the actual mountain.
2. **SSX patch exporter** — map `export_patches` JSON into the snowknife bundle's
   real patch format so it round-trips into the app.
3. **Patch tiling** — a grid of NURBS patches to cover a full course (exact for a
   regular grid; no irregular-vertex approximation).
