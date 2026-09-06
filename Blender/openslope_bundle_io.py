bl_info = {
    "name": "OpenSlope Bundle (glTF + sidecar)",
    "author": "OpenSlope",
    "version": (0, 1, 0),
    "blender": (4, 0, 0),
    "location": "File > Import/Export > OpenSlope Bundle",
    "description": "Load/save a Snowknife OpenSlope map bundle: terrain/prop meshes (glTF) + the manifest "
                   "sidecar (grind rails as editable Bezier curves, course path, spawn). Edit the rails "
                   "in Blender and save back to the sidecar without disturbing snowknife's geometry.",
    "category": "Import-Export",
}

# =============================================================================
# OpenSlope map bundle <-> Blender.
#
# A map bundle is the folder snowknife writes: terrain.glb / props.glb (+ collision.glb),
# LightmapAtlas.png, and manifest.json (textures live one level up in the level's Textures/). The MESHES travel in glTF (standard, Blender-native). Everything
# glTF can't carry - grind rails (cubic Beziers), the OOB course path (polyline), the spawn - lives in the
# manifest sidecar. This add-on ties the two halves into one Import and one Export:
#
#   Import : glTF import (terrain/props as context geometry) + manifest -> editable Bezier rail curves,
#            course curves, a Spawn empty.
#   Export : (sidecar-only by default) the rail/course curves + spawn -> manifest.json, PRESERVING every
#            other manifest section and leaving the snowknife .glb untouched. Tick "Export meshes" only for a
#            from-scratch authored map (re-exporting snowknife's terrain through Blender is lossy).
#
# COORDINATES. snowknife emits meshes in standard glTF space (Y-up, metres) = mesh-space (X-negated, Z-up,
# cm) transformed by (x,z,y)*Scale. Blender's glTF importer then converts Y-up->Z-up. The net mesh->Blender
# is (x,-y,z)*Scale; rails/course points (raw mesh-space in the manifest) use the same net transform so they
# land on the imported terrain. Recenter is NOT baked into the bundle (Unity applies it as a uniform shift),
# so terrain and rails share one un-recentered space here - no offset to chase.
#
# RAILS = CUBIC BEZIER. A game rail is a chain of cubic Bezier segments (4 control points each), which is
# exactly Blender's Bezier curve: anchor co = segment p0/p3, handle_right = p1, handle_left = p2 (handles
# FREE so the shape is exact). Round-trips losslessly for continuous rails; on export each curve is also
# re-sampled to the polyline the runtime's broad-phase uses, so Points and Cubic never drift.
# =============================================================================

import bpy
import os
import json
from mathutils import Vector

RAILS_COLL = "OpenSlope_Rails"
COURSE_COLL = "OpenSlope_Course"
MESH_COLL = "OpenSlope_Mesh"
SPAWN_NAME = "OpenSlope_Spawn"
RAIL_STYLE_PROP = "openslope_rail_style"
DEFAULT_RAIL_STYLE = 13

#: Pre-rename spellings. A .blend built before the OpenSlope rename holds the old collection/object names
#: and the old per-object round-trip indices, and an export that silently found no rails would drop them
#: from the manifest. Lookups accept either; import only ever creates the current names.
LEGACY_NAMES = {
    RAILS_COLL: "SWX_Rails",
    COURSE_COLL: "SWX_Course",
    MESH_COLL: "SWX_Mesh",
    SPAWN_NAME: "SWX_Spawn",
}
LEGACY_RAIL_INDEX = "swx_rail"
LEGACY_POLY_INDEX = "swx_poly"


def _find(bag, name):
    """A collection/object by name, accepting its pre-rename spelling."""
    return bag.get(name) or bag.get(LEGACY_NAMES.get(name, ""))


def _order(obj, key, legacy):
    """A per-object round-trip index under either spelling; sorts unindexed objects last by name."""
    if key in obj:
        return (0, obj[key])
    if legacy in obj:
        return (0, obj[legacy])
    return (1, obj.name)
DEFAULT_SAMPLES_PER_SEG = 8


# ---- coordinate transform (mesh-space <-> Blender) -------------------------
def mesh_to_blender(p, s):
    """manifest mesh-space [mx,my,mz] -> Blender Vector (matches the imported glb terrain)."""
    return Vector((p[0] * s, -p[1] * s, p[2] * s))


def blender_to_mesh(v, s):
    """Blender position -> manifest mesh-space [mx,my,mz] (exact inverse of mesh_to_blender)."""
    return [v[0] / s, -v[1] / s, v[2] / s]


def dir_to_mesh(v):
    """Blender direction -> mesh-space direction (linear part only; scale dropped)."""
    return [v[0], -v[1], v[2]]


def bezier(p0, p1, p2, p3, t):
    """Cubic Bezier point, mesh-space lists in/out. Matches snowknife PathBundle.Bezier exactly."""
    u = 1.0 - t
    uu, tt = u * u, t * t
    a, b, c, d = uu * u, 3 * uu * t, 3 * u * tt, tt * t
    return [a * p0[i] + b * p1[i] + c * p2[i] + d * p3[i] for i in range(3)]


# ---- collection / scene helpers --------------------------------------------
def ensure_collection(name):
    c = bpy.data.collections.get(name)
    if c is None:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
    return c


def read_manifest(bundle_dir):
    with open(os.path.join(bundle_dir, "manifest.json"), "r", encoding="utf-8") as f:
        return json.load(f)


# =============================================================================
# IMPORT
# =============================================================================
def import_meshes(bundle_dir):
    """Import the bundle's .glb meshes as context geometry (plain; use open_bundle_in_blender.py for
    textured viewing). Returns the count imported."""
    coll = ensure_collection(MESH_COLL)
    n = 0
    for fname in ("terrain.glb", "props.glb"):
        path = os.path.join(bundle_dir, fname)
        if not os.path.exists(path):
            continue
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        for o in [o for o in bpy.data.objects if o not in before]:
            for c in list(o.users_collection):
                c.objects.unlink(o)
            coll.objects.link(o)
            n += 1
    return n


def _reflect(co, handle):
    """Mirror a handle across its anchor (for the unused end handles, so they're not degenerate)."""
    return co + (co - handle)


def import_rails(manifest, scale):
    """manifest Paths.Rails.Cubic -> one editable Bezier curve per rail in the OpenSlope_Rails collection."""
    rails = (manifest.get("Paths") or {}).get("Rails")
    if not rails:
        return 0, 0
    cubic = rails.get("Cubic")
    coll = ensure_collection(RAILS_COLL)
    made, discontinuities = 0, 0

    if cubic and cubic.get("ControlPoints"):
        CP = cubic["ControlPoints"]
        seg_start, seg_count = cubic["SegStart"], cubic["SegCount"]
        for r in range(len(seg_start)):
            g0, gc = seg_start[r], seg_count[r]
            if gc <= 0:
                continue
            cu = bpy.data.curves.new(f"{RAILS_COLL}_{r}", 'CURVE')
            cu.dimensions = '3D'
            sp = cu.splines.new('BEZIER')
            sp.bezier_points.add(gc)                    # a BEZIER spline starts with 1 point -> gc+1 total
            pts = sp.bezier_points
            for bp in pts:
                bp.handle_left_type = bp.handle_right_type = 'FREE'

            last_p3 = None
            for li in range(gc):
                base = (g0 + li) * 4
                p0, p1, p2, p3 = CP[base], CP[base + 1], CP[base + 2], CP[base + 3]
                if li > 0 and last_p3 is not None:
                    gap = sum((p0[k] - last_p3[k]) ** 2 for k in range(3)) ** 0.5
                    if gap > 1.0:                       # >1cm mesh-space: a real break, not a shared anchor
                        discontinuities += 1
                pts[li].co = mesh_to_blender(p0, scale)
                pts[li].handle_right = mesh_to_blender(p1, scale)
                pts[li + 1].handle_left = mesh_to_blender(p2, scale)
                last_p3 = p3
            pts[gc].co = mesh_to_blender(last_p3, scale)
            pts[0].handle_left = _reflect(pts[0].co, pts[0].handle_right)
            pts[gc].handle_right = _reflect(pts[gc].co, pts[gc].handle_left)

            obj = bpy.data.objects.new(f"{RAILS_COLL}_{r}", cu)
            obj["openslope_rail"] = r                          # preserve original index/order for a stable round-trip
            styles = rails.get("Style") or []
            obj[RAIL_STYLE_PROP] = int(styles[r]) if r < len(styles) else DEFAULT_RAIL_STYLE
            coll.objects.link(obj)
            made += 1
    else:
        made = _import_polylines(rails, coll, RAILS_COLL, scale, rails.get("Style"))
    return made, discontinuities


def _import_polylines(poly, coll, prefix, scale, rail_styles=None):
    """A Points/Start/Count polyline set -> POLY curves (course, or a rail bundle with no cubic)."""
    pts, starts, counts = poly.get("Points"), poly.get("Start"), poly.get("Count")
    if not pts or not starts:
        return 0
    made = 0
    for i in range(len(starts)):
        s, c = starts[i], counts[i]
        if c < 2:
            continue
        cu = bpy.data.curves.new(f"{prefix}_{i}", 'CURVE')
        cu.dimensions = '3D'
        sp = cu.splines.new('POLY')
        sp.points.add(c - 1)                            # POLY starts with 1 point
        for k in range(c):
            v = mesh_to_blender(pts[s + k], scale)
            sp.points[k].co = (v.x, v.y, v.z, 1.0)
        obj = bpy.data.objects.new(f"{prefix}_{i}", cu)
        obj["openslope_poly"] = i
        if rail_styles is not None:
            obj[RAIL_STYLE_PROP] = int(rail_styles[i]) if i < len(rail_styles) else DEFAULT_RAIL_STYLE
        coll.objects.link(obj)
        made += 1
    return made


def import_course(manifest, scale):
    course = (manifest.get("Paths") or {}).get("Course")
    if not course:
        return 0
    return _import_polylines(course, ensure_collection(COURSE_COLL), COURSE_COLL, scale)


def import_spawn(manifest, scale):
    """Create the OpenSlope_Spawn empty from manifest.Spawn if present, else a default at origin for the creator
    to position. Returns True if a spawn empty now exists."""
    e = _find(bpy.data.objects, SPAWN_NAME)
    if e is None:
        e = bpy.data.objects.new(SPAWN_NAME, None)
        e.empty_display_type = 'ARROWS'
        e.empty_display_size = 5.0
        bpy.context.scene.collection.objects.link(e)
    sp = manifest.get("Spawn")
    if sp and sp.get("Pos"):
        e.location = mesh_to_blender(sp["Pos"], scale)
    return True


# =============================================================================
# EXPORT (sidecar)
# =============================================================================
def _rail_objects():
    """Rail curve objects, original rails (openslope_rail) first in index order, then any newly-drawn ones."""
    coll = _find(bpy.data.collections, RAILS_COLL)
    if not coll:
        return []
    objs = [o for o in coll.objects if o.type == 'CURVE']
    objs.sort(key=lambda o: _order(o, "openslope_rail", LEGACY_RAIL_INDEX))
    return objs


def _segments_of(curve_obj, scale):
    """Per-segment (p0,p1,p2,p3) mesh-space tuples from a curve's first Bezier spline (world space)."""
    mw = curve_obj.matrix_world
    out = []
    for sp in curve_obj.data.splines:
        if sp.type != 'BEZIER' or len(sp.bezier_points) < 2:
            continue
        bp = sp.bezier_points
        rng = range(len(bp) - 1) if not sp.use_cyclic_u else range(len(bp))
        for i in rng:
            j = (i + 1) % len(bp)
            p0 = blender_to_mesh(mw @ bp[i].co, scale)
            p1 = blender_to_mesh(mw @ bp[i].handle_right, scale)
            p2 = blender_to_mesh(mw @ bp[j].handle_left, scale)
            p3 = blender_to_mesh(mw @ bp[j].co, scale)
            out.append((p0, p1, p2, p3))
        break                                           # one spline per rail
    return out


def export_rails(scale, samples_per_seg):
    """All OpenSlope_Rails curves -> the manifest Paths.Rails dict (sampled Points + source Cubic, consistent)."""
    objs = _rail_objects()
    if not objs:
        return None
    points, p_start, p_count, styles = [], [], [], []
    ctrl, s_start, s_count = [], [], []
    pi, si = 0, 0
    for o in objs:
        segs = _segments_of(o, scale)
        if not segs:
            continue
        styles.append(int(o.get(RAIL_STYLE_PROP, DEFAULT_RAIL_STYLE)))
        s_start.append(si)
        s_count.append(len(segs))
        for (p0, p1, p2, p3) in segs:
            ctrl.extend([p0, p1, p2, p3])
            si += 1
        sampled = []
        for (p0, p1, p2, p3) in segs:
            for k in range(samples_per_seg):
                sampled.append(bezier(p0, p1, p2, p3, k / samples_per_seg))
        sampled.append(segs[-1][3])                     # final endpoint (matches PathBundle)
        p_start.append(pi)
        p_count.append(len(sampled))
        points.extend(sampled)
        pi += len(sampled)
    return {
        "Points": points, "Start": p_start, "Count": p_count, "Style": styles,
        "Cubic": {"SamplesPerSegment": samples_per_seg, "ControlPoints": ctrl,
                  "SegStart": s_start, "SegCount": s_count},
    }


def export_course(scale):
    coll = _find(bpy.data.collections, COURSE_COLL)
    if not coll:
        return None
    objs = [o for o in coll.objects if o.type == 'CURVE']
    objs.sort(key=lambda o: _order(o, "openslope_poly", LEGACY_POLY_INDEX))
    points, start, count = [], [], []
    pi = 0
    for o in objs:
        mw = o.matrix_world
        for sp in o.data.splines:
            pts = sp.bezier_points if sp.type == 'BEZIER' else sp.points
            if len(pts) < 2:
                continue
            start.append(pi)
            n = 0
            for p in pts:
                co = p.co if sp.type == 'BEZIER' else Vector((p.co[0], p.co[1], p.co[2]))
                points.append(blender_to_mesh(mw @ co, scale))
                n += 1
            count.append(n)
            pi += n
            break
    if not points:
        return None
    return {"Points": points, "Start": start, "Count": count}


def export_spawn(scale):
    e = _find(bpy.data.objects, SPAWN_NAME)
    if e is None:
        return None
    fwd = (e.matrix_world.to_3x3() @ Vector((0, 1, 0))).normalized()   # empty's local +Y is "forward"
    return {"Pos": blender_to_mesh(e.matrix_world.translation, scale),
            "Forward": dir_to_mesh(fwd)}


def save_sidecar(bundle_dir, scale, write_meshes=False):
    """Merge the authored channels back into manifest.json, preserving every other section. Returns a
    short summary string."""
    manifest = read_manifest(bundle_dir)
    spseg = (((manifest.get("Paths") or {}).get("Rails") or {}).get("Cubic") or {}) \
        .get("SamplesPerSegment", DEFAULT_SAMPLES_PER_SEG)

    paths = manifest.setdefault("Paths", {})
    rails = export_rails(scale, spseg)
    course = export_course(scale)
    if rails is not None:
        paths["Rails"] = rails
    if course is not None:
        paths["Course"] = course
    spawn = export_spawn(scale)
    if spawn is not None:
        manifest["Spawn"] = spawn

    with open(os.path.join(bundle_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    nr = len(rails["Start"]) if rails else 0
    nseg = len(rails["Cubic"]["SegStart"]) and sum(rails["Cubic"]["SegCount"]) if rails else 0
    nc = len(course["Start"]) if course else 0
    note = ""
    if write_meshes:
        note = " (mesh re-export not implemented in v0.1 - sidecar only)"
    return f"saved {nr} rails ({nseg} segs), {nc} course lines, spawn={'yes' if spawn else 'no'}{note}"


# =============================================================================
# OPERATORS
# =============================================================================
from bpy.props import StringProperty, BoolProperty
from bpy_extras.io_utils import ImportHelper


class OPENSLOPE_OT_import_bundle(bpy.types.Operator, ImportHelper):
    bl_idname = "openslope.import_bundle"
    bl_label = "Import OpenSlope Bundle"
    bl_description = "Load a Snowknife map bundle: meshes (glTF) + rails/course/spawn (manifest sidecar)"
    filename_ext = ".json"
    filter_glob: StringProperty(default="manifest.json;*.json", options={'HIDDEN'})
    import_meshes_opt: BoolProperty(name="Import meshes", default=True,
                                    description="Also import terrain/prop .glb as context geometry")

    def execute(self, context):
        bundle_dir = os.path.dirname(self.filepath)
        if not os.path.exists(os.path.join(bundle_dir, "manifest.json")):
            self.report({'ERROR'}, "Pick the bundle's manifest.json")
            return {'CANCELLED'}
        manifest = read_manifest(bundle_dir)
        scale = float(((manifest.get("Space") or {}).get("Scale", 0.01)))

        nm = import_meshes(bundle_dir) if self.import_meshes_opt else 0
        nr, disc = import_rails(manifest, scale)
        nc = import_course(manifest, scale)
        import_spawn(manifest, scale)
        context.scene["openslope_bundle_dir"] = bundle_dir

        msg = f"OpenSlope: imported {nm} meshes, {nr} rails, {nc} course lines, spawn."
        if disc:
            msg += f" ({disc} rail anchors were discontinuous and healed to continuous.)"
        self.report({'INFO'}, msg)
        return {'FINISHED'}


class OPENSLOPE_OT_export_bundle(bpy.types.Operator):
    bl_idname = "openslope.export_bundle"
    bl_label = "Export OpenSlope Bundle (sidecar)"
    bl_description = "Save the edited rails/course/spawn back into the bundle's manifest.json, leaving " \
                    "snowknife's .glb geometry untouched"
    bl_options = {'REGISTER', 'UNDO'}
    write_meshes: BoolProperty(name="Export meshes", default=False,
                               description="Re-export terrain/prop meshes (for a from-scratch authored map; "
                                           "NOT for tweaking a Snowknife-imported map - it would round-trip the glb)")

    def execute(self, context):
        bundle_dir = context.scene.get("openslope_bundle_dir") or context.scene.get("swx_bundle_dir")
        if not bundle_dir or not os.path.exists(os.path.join(bundle_dir, "manifest.json")):
            self.report({'ERROR'}, "Import an OpenSlope bundle first (so the target manifest is known).")
            return {'CANCELLED'}
        manifest = read_manifest(bundle_dir)
        scale = float(((manifest.get("Space") or {}).get("Scale", 0.01)))
        summary = save_sidecar(bundle_dir, scale, self.write_meshes)
        self.report({'INFO'}, "OpenSlope: " + summary)
        return {'FINISHED'}


def _menu_import(self, context):
    self.layout.operator(OPENSLOPE_OT_import_bundle.bl_idname, text="OpenSlope Bundle (.glb + manifest)")


def _menu_export(self, context):
    self.layout.operator(OPENSLOPE_OT_export_bundle.bl_idname, text="OpenSlope Bundle sidecar (manifest)")


_classes = (OPENSLOPE_OT_import_bundle, OPENSLOPE_OT_export_bundle)


def register():
    for c in _classes:
        bpy.utils.register_class(c)
    bpy.types.TOPBAR_MT_file_import.append(_menu_import)
    bpy.types.TOPBAR_MT_file_export.append(_menu_export)


def unregister():
    bpy.types.TOPBAR_MT_file_import.remove(_menu_import)
    bpy.types.TOPBAR_MT_file_export.remove(_menu_export)
    for c in reversed(_classes):
        bpy.utils.unregister_class(c)


if __name__ == "__main__":
    register()
