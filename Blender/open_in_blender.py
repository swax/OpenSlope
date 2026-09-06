"""
Open an extracted SSX level in the Blender GUI, ready to look at.

Run via the Blender executable (NOT --background) so the window stays open:
  blender --python open_in_blender.py -- <levelDir>

It clears the default scene, imports Terrain.obj + Props.obj from <levelDir>
into separate collections, fixes the viewport for SSX's huge coordinates
(clip_end), sets Material Preview shading so the textures from the .mtl files
show, and frames everything. (The OBJ importer auto-loads Terrain.mtl /
Props.mtl and the PNGs they reference in ./Textures/.)

SSX's "up" is -Y (verified: the slope's area-weighted average face normal
points along -Y, i.e. toward the sky). Blender is Z-up, so the OBJs are
imported with up_axis='Z', forward_axis='Y', which tips the level upright
(maps file (x,y,z) -> (x, z, -y)). If you import manually via
File > Import > Wavefront, pick those same Up/Forward axes.

The companion open-level.ps1 just locates blender.exe and calls this.
"""
import bpy
import sys
import os
import mathutils

# ---- args ----------------------------------------------------------------
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
level_dir = os.path.abspath(argv[0]) if argv else os.getcwd()
terrain_obj = os.path.join(level_dir, "Terrain.obj")
props_obj = os.path.join(level_dir, "Props.obj")

# ---- clean default scene (cube/camera/light) ------------------------------
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)


def import_into(path, collection_name):
    """Import an OBJ and move its new objects into a named collection."""
    if not os.path.exists(path):
        print(f"WARN missing {path}")
        return []
    before = set(bpy.data.objects)
    # up_axis='Z'/forward_axis='Y' tips SSX's -Y-up data to Blender's Z-up.
    bpy.ops.wm.obj_import(filepath=path, up_axis='Z', forward_axis='Y')
    new = [o for o in bpy.data.objects if o not in before]

    coll = bpy.data.collections.new(collection_name)
    bpy.context.scene.collection.children.link(coll)
    for o in new:
        for c in list(o.users_collection):
            c.objects.unlink(o)
        coll.objects.link(o)
    print(f"RESULT imported {len(new)} objects into '{collection_name}'")
    return new


terrain = import_into(terrain_obj, "Terrain")
props = import_into(props_obj, "Props")

# ---- per-object colours (only seen in SOLID + "Object" colour mode) -------
# We default to Material Preview below so the real textures show, but keep
# these so flipping the viewport to Solid still gives terrain-vs-props contrast.
for o in terrain:
    o.color = (0.35, 0.35, 0.38, 1.0)
for i, o in enumerate(props):
    h = (i * 0.61803398875) % 1.0
    c = mathutils.Color()
    c.hsv = (h, 0.75, 1.0)
    o.color = (c.r, c.g, c.b, 1.0)

# ---- viewport: clip planes, shading, framing ------------------------------
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type != "VIEW_3D":
            continue
        for space in area.spaces:
            if space.type == "VIEW_3D":
                space.clip_start = 10.0           # SSX coords are huge...
                space.clip_end = 5_000_000.0      # ...so push the far plane way out
                space.shading.type = "MATERIAL"   # show the .mtl image textures
                space.shading.color_type = "OBJECT"  # used only if you switch back to SOLID
                space.shading.show_cavity = True

# frame all geometry in the first 3D viewport
for window in bpy.context.window_manager.windows:
    handled = False
    for area in window.screen.areas:
        if area.type != "VIEW_3D":
            continue
        region = next((r for r in area.regions if r.type == "WINDOW"), None)
        if region is None:
            continue
        with bpy.context.temp_override(window=window, area=area, region=region):
            bpy.ops.object.select_all(action="SELECT")
            bpy.ops.view3d.view_all(center=False)
        handled = True
        break
    if handled:
        break

print(f"RESULT ready: {len(terrain)} terrain + {len(props)} prop objects from {level_dir}")
