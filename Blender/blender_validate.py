"""
Headless Blender validation/preview for SSX exports.

Usage:
  blender --background --python blender_validate.py -- <model.obj|.glb|DIR> [out.png]

If given a directory, imports every .obj inside it (useful for previewing a whole
level's meshes at once). Prints geometry stats prefixed RESULT/ERROR and, if an
output PNG is given, renders a colored Workbench thumbnail.
"""
import sys
import os
import glob
import math

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if not argv:
    print("ERROR no model path given")
    sys.exit(1)

model_path = os.path.abspath(argv[0])
out_png = os.path.abspath(argv[1]) if len(argv) > 1 else None

import bpy
import mathutils

bpy.ops.wm.read_factory_settings(use_empty=True)

# Collect the files to import.
if os.path.isdir(model_path):
    files = sorted(glob.glob(os.path.join(model_path, "*.obj")))
else:
    files = [model_path]

if not files:
    print("ERROR no .obj files found")
    sys.exit(1)

imported = 0
for f in files:
    ext = os.path.splitext(f)[1].lower()
    try:
        if ext == ".obj":
            bpy.ops.wm.obj_import(filepath=f)
        elif ext in (".glb", ".gltf"):
            bpy.ops.import_scene.gltf(filepath=f)
        else:
            continue
        imported += 1
    except Exception as e:
        print(f"ERROR import failed for {f}: {e}")

meshes = [o for o in bpy.data.objects if o.type == "MESH"]
total_v = sum(len(o.data.vertices) for o in meshes)
total_f = sum(len(o.data.polygons) for o in meshes)
total_uv = sum(1 for o in meshes if o.data.uv_layers)
print(f"RESULT files_imported={imported} objects={len(meshes)} verts={total_v} faces={total_f} meshes_with_uv={total_uv}")

if total_v == 0 or total_f == 0:
    print("ERROR imported geometry is empty")
    sys.exit(1)

# Combined world-space bounding box.
mins = mathutils.Vector((1e30, 1e30, 1e30))
maxs = mathutils.Vector((-1e30, -1e30, -1e30))
for o in meshes:
    for corner in o.bound_box:
        wc = o.matrix_world @ mathutils.Vector(corner)
        mins.x, mins.y, mins.z = min(mins.x, wc.x), min(mins.y, wc.y), min(mins.z, wc.z)
        maxs.x, maxs.y, maxs.z = max(maxs.x, wc.x), max(maxs.y, wc.y), max(maxs.z, wc.z)
size = maxs - mins
print(f"RESULT bbox_min=({mins.x:.1f},{mins.y:.1f},{mins.z:.1f}) "
      f"bbox_max=({maxs.x:.1f},{maxs.y:.1f},{maxs.z:.1f}) "
      f"size=({size.x:.1f},{size.y:.1f},{size.z:.1f})")

if out_png:
    center = (mins + maxs) * 0.5
    radius = max(size.length * 0.5, 0.001)

    # Dark world so geometry stands out.
    world = bpy.data.worlds.new("W")
    world.use_nodes = False
    world.color = (0.05, 0.05, 0.06)
    bpy.context.scene.world = world

    cam_data = bpy.data.cameras.new("Cam")
    # SSX coordinates are large (thousands of units); default far-clip (1000)
    # would clip the whole model away, so scale the clip planes to the scene.
    cam_data.clip_start = max(radius * 0.001, 0.1)
    cam_data.clip_end = radius * 100.0
    cam = bpy.data.objects.new("Cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    dist = radius * 2.2
    cam.location = center + mathutils.Vector((dist, -dist, dist * 0.7))
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "RANDOM"     # distinct color per object
    shading.show_cavity = True
    shading.cavity_type = "BOTH"
    scene.render.resolution_x = 1000
    scene.render.resolution_y = 750
    scene.render.filepath = out_png
    try:
        bpy.ops.render.render(write_still=True)
        print(f"RESULT thumbnail={out_png}")
    except Exception as e:
        print(f"ERROR render failed: {e}")

print("RESULT ok")
