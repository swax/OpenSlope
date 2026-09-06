# =============================================================================
# OpenSlope terrain authoring - smooth NURBS terrain + analytic trail carving.
#
# A small toolbox for authoring SSX-style terrain in Blender as a Bezier/NURBS
# SURFACE (a coarse control net), instead of a dense triangle mesh. The surface
# is the source of truth; you tessellate it to a mesh at any target density and
# (later) export the control net as bicubic patches - which is exactly how the
# PS2 engine stores its slope (a grid of control points, tessellated at runtime).
#
# WHY. SSX used Bezier so the board rides a SMOOTH surface built from very little
# data. We don't have the PS2's triangle budget problem, but the analytic surface
# still buys: (1) smooth board contact at ANY tessellation density (no faceting /
# poke-through baked into the geometry), (2) LOD for free (one source, coarse far
# / dense near), (3) a compact, exportable master. See Blender/docs/001.
#
# THE ONE RULE worth remembering: a NURBS surface APPROXIMATES (smooths) its
# control net. Constant regions (a flat floor of equal-height points) reproduce
# exactly; sharp transitions round off. So a carved feature only survives if the
# control spacing is <= ~half its width. A ~5 m-wide gully needs ~2.5 m control
# spacing; 3.5 m washes it out into a shallow dip. Smooth open mountain = few
# points; a sharply carved trail = a locally finer net.
#
# COORDINATES. These helpers work in plain Blender space (Z-up, metres) - an
# authoring sandbox. To feed a result into the snowknife pipeline, convert with
# openslope_bundle_io.blender_to_mesh (net mesh->Blender is (x,-y,z)*Scale).
#
# USAGE (from the Blender Python console, or any script bridge into it):
#   import sys; sys.path.append(r"C:\\path\\to\\OpenSlope\\Blender")
#   import openslope_terrain as T
#   import importlib; importlib.reload(T)            # after edits
#   xs = T.linspace(-28, 28, 23); ys = T.linspace(-10, 90, 41)   # 2.5 m net
#   path = [(0, y, 0) for y in ys]                   # your course centreline (xy used)
#   h = T.carved_height(lambda x, y: -0.35 * y, [(p[0], p[1]) for p in path])
#   surf = T.build_nurbs_surface("Terrain", xs, ys, h, resolution=6)
#   T.export_patches(surf, r"C:\\path\\to\\OpenSlope\\Blender\\terrain_patch.json")
#   T.render_to_png(r"C:\\path\\to\\OpenSlope\\Blender\\terrain.png", target=(0, 45, -14))
#
# CAPTURE GOTCHA. Any capture that reads the viewport framebuffer FREEZES when the
# Blender window is unfocused and hands back a stale frame. Use render_to_png()
# below - a real camera render doesn't depend on window focus.
# =============================================================================

import bpy
import json
from mathutils import Vector


# ---- small math helpers ----------------------------------------------------
def linspace(a, b, n):
    """n evenly spaced values from a to b inclusive."""
    return [a + i * (b - a) / (n - 1) for i in range(n)] if n > 1 else [a]


def path_distance(path_xy):
    """Return f(x, y) = horizontal distance from (x, y) to the polyline path_xy
    (a list of (x, y)). Used to drive the carve."""
    segs = [(path_xy[i], path_xy[i + 1]) for i in range(len(path_xy) - 1)]

    def f(px, py):
        best = 1e18
        for (ax, ay), (bx, by) in segs:
            abx, aby = bx - ax, by - ay
            l2 = abx * abx + aby * aby
            t = 0.0 if l2 < 1e-9 else max(0.0, min(1.0, ((px - ax) * abx + (py - ay) * aby) / l2))
            dx, dy = px - (ax + abx * t), py - (ay + aby * t)
            d = dx * dx + dy * dy
            if d < best:
                best = d
        return best ** 0.5
    return f


def trough(d, depth=7.0, berm=4.0, floor_half=5.0, wall_top=11.0, outer=16.0):
    """A half-pipe cross-section as a function of distance d from the centreline:
    flat floor (-depth) -> banked wall up to a +berm lip -> ease back to 0."""
    if d <= floor_half:
        return -depth
    if d <= wall_top:
        s = (d - floor_half) / (wall_top - floor_half)
        return -depth + (depth + berm) * (s * s * (3 - 2 * s))
    if d <= outer:
        s = (d - wall_top) / (outer - wall_top)
        return berm * (1 - (s * s * (3 - 2 * s)))
    return 0.0


def carved_height(base_fn, path_xy, **trough_kw):
    """Compose base_fn(x, y) + trough(distance-to-path). Returns a height_fn ready
    for build_nurbs_surface. trough_kw -> trough() (depth, berm, floor_half, ...)."""
    dist = path_distance(path_xy)
    return lambda x, y: base_fn(x, y) + trough(dist(x, y), **trough_kw)


# ---- the NURBS surface -----------------------------------------------------
def _view3d_override():
    win = bpy.context.window
    for area in win.screen.areas:
        if area.type == 'VIEW_3D':
            region = next((r for r in area.regions if r.type == 'WINDOW'), None)
            return dict(window=win, area=area, region=region)
    raise RuntimeError("openslope_terrain: need a VIEW_3D area for curve.make_segment()")


def build_nurbs_surface(name, xs, ys, height_fn, resolution=6, order=4):
    """Build a Blender NURBS SURFACE from a control grid: one control point per
    (x in xs, y in ys), z = height_fn(x, y). The rows are added as separate NURBS
    splines then welded into one surface grid with curve.make_segment (the only
    fiddly bit - it needs an edit-mode context override). resolution = tessellation
    density (resolution_u/v). Returns the new object (replaces any same-named one)."""
    old = bpy.data.objects.get(name)
    if old:
        bpy.data.objects.remove(old, do_unlink=True)

    sdata = bpy.data.curves.new(name, 'SURFACE')
    sdata.dimensions = '3D'
    for y in ys:
        sp = sdata.splines.new('NURBS')
        sp.points.add(len(xs) - 1)
        for u, x in enumerate(xs):
            sp.points[u].co = (x, y, height_fn(x, y), 1.0)
    obj = bpy.data.objects.new(name, sdata)
    bpy.context.collection.objects.link(obj)

    bpy.context.view_layer.objects.active = obj
    for o in bpy.data.objects:
        o.select_set(o == obj)
    with bpy.context.temp_override(**_view3d_override()):
        bpy.ops.object.mode_set(mode='EDIT')
        bpy.ops.curve.select_all(action='SELECT')
        bpy.ops.curve.make_segment()
        bpy.ops.object.mode_set(mode='OBJECT')

    nb = sdata.splines[0]
    nb.order_u = order
    nb.order_v = order
    nb.use_endpoint_u = True
    nb.use_endpoint_v = True
    nb.resolution_u = resolution
    nb.resolution_v = resolution
    return obj


def tessellate(surf, resolution=None, name=None, link=True):
    """Bake the NURBS surface to a triangle/quad mesh at `resolution` (a single
    int = density). One source -> as many density bakes as you like. Returns the
    new mesh object."""
    nb = surf.data.splines[0]
    if resolution is not None:
        nb.resolution_u = resolution
        nb.resolution_v = resolution
    surf.data.update_tag()
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(surf.evaluated_get(dg))
    for p in me.polygons:
        p.use_smooth = True
    o = bpy.data.objects.new(name or (surf.name + "_tess"), me)
    if link:
        bpy.context.collection.objects.link(o)
    return o


def export_patches(surf, filepath):
    """Dump the control net (the 'save with Beziers') to JSON: order + the
    count_u x count_v grid of control points. This is the SSX-patch shape; a real
    exporter just reformats it into the bundle's patch struct."""
    nb = surf.data.splines[0]
    pts = [list(p.co[:3]) for p in nb.points]   # flattened; reshape by count_u/count_v
    data = {
        "order": [nb.order_u, nb.order_v],
        "count_u": nb.point_count_u,
        "count_v": nb.point_count_v,
        "control_points": [[round(c, 4) for c in p] for p in pts],
    }
    with open(filepath, "w") as fh:
        json.dump(data, fh, indent=2)
    return data["count_u"] * data["count_v"]


# ---- focus-proof capture ---------------------------------------------------
def render_to_png(filepath, target=(0, 0, 0), cam_loc=(52, 8, 40),
                  res=(1100, 620), single_color=(0.85, 0.9, 1.0)):
    """Render the scene to a PNG via a camera (Workbench + cavity so carved shapes
    read). Unlike the viewport screenshot, this does NOT depend on the Blender
    window being focused. Reuses/creates a 'OpenSlope_RenderCam'."""
    tgt = Vector(target)
    cam = bpy.data.objects.get("OpenSlope_RenderCam")
    if cam is None:
        cam = bpy.data.objects.new("OpenSlope_RenderCam", bpy.data.cameras.new("OpenSlope_RenderCam"))
        bpy.context.collection.objects.link(cam)
    cam.location = Vector(cam_loc)
    cam.rotation_euler = (tgt - cam.location).to_track_quat('-Z', 'Y').to_euler()
    cam.data.clip_start = 0.05            # generous range so km-scale scenes aren't clipped
    cam.data.clip_end = 1.0e6
    scn = bpy.context.scene
    scn.camera = cam
    scn.render.engine = 'BLENDER_WORKBENCH'
    scn.display.shading.light = 'STUDIO'
    scn.display.shading.show_cavity = True
    scn.display.shading.cavity_type = 'BOTH'
    scn.display.shading.color_type = 'SINGLE'
    scn.display.shading.single_color = single_color
    scn.render.resolution_x, scn.render.resolution_y = res
    scn.render.filepath = filepath
    bpy.ops.render.render(write_still=True)
    return filepath
