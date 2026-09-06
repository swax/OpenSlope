"""Bake a GLB into one upright, unrigged, textured FBX for Mixamo auto-rigging.

Run inside Blender:

    blender --background --factory-startup --python prepare_mixamo_upload.py -- \
        SOURCE.glb OUTPUT.fbx [--rest-pose] [--height 1.8]

``--rest-pose`` evaluates an already-rigged source in its bind pose before the
armature and weights are removed. Images are packed into the binary FBX.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

import bpy
from mathutils import Matrix, Vector


def arguments() -> argparse.Namespace:
    if "--" not in sys.argv:
        raise SystemExit("Expected Blender script arguments after --")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--rest-pose",
        action="store_true",
        help="bake the source armature's rest pose before removing the rig",
    )
    parser.add_argument("--height", type=float, default=1.8, help="output character height in metres")
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    args.source = args.source.resolve()
    args.output = args.output.resolve()
    if not args.source.is_file():
        parser.error(f"source does not exist: {args.source}")
    if args.source.suffix.lower() != ".glb":
        parser.error("source must be a binary glTF (.glb)")
    if args.output.suffix.lower() != ".fbx":
        parser.error("output must have an .fbx extension")
    if args.height <= 0:
        parser.error("--height must be positive")
    return args


def mesh_bounds(meshes: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ vertex.co for obj in meshes for vertex in obj.data.vertices]
    if not points:
        raise RuntimeError("source contains no mesh vertices")
    return (
        Vector(tuple(min(point[axis] for point in points) for axis in range(3))),
        Vector(tuple(max(point[axis] for point in points) for axis in range(3))),
    )


def bake_mesh(obj: bpy.types.Object) -> None:
    """Replace an object with its evaluated appearance and preserve its world placement."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    evaluated = obj.evaluated_get(depsgraph)
    baked = bpy.data.meshes.new_from_object(evaluated, depsgraph=depsgraph)
    old = obj.data
    world = obj.matrix_world.copy()
    obj.data = baked
    obj.modifiers.clear()
    obj.vertex_groups.clear()
    obj.parent = None
    obj.matrix_world = world
    if old.users == 0:
        bpy.data.meshes.remove(old)


def prepare(source: Path, rest_pose: bool, target_height: float) -> bpy.types.Object:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=os.fspath(source))
    scene = bpy.context.scene
    scene.frame_set(0)

    armatures = [obj for obj in scene.objects if obj.type == "ARMATURE"]
    if rest_pose:
        if not armatures:
            raise RuntimeError("--rest-pose requested, but the source has no armature")
        for armature in armatures:
            armature.data.pose_position = "REST"
    bpy.context.view_layer.update()

    # A rigged source can contain helpers unrelated to the visible skin. An
    # unrigged source has no such signal, so retain every renderable mesh.
    if armatures:
        meshes = [
            obj
            for obj in scene.objects
            if obj.type == "MESH"
            and any(mod.type == "ARMATURE" for mod in obj.modifiers)
            and not obj.hide_render
        ]
    else:
        meshes = [obj for obj in scene.objects if obj.type == "MESH" and not obj.hide_render]
    if not meshes:
        raise RuntimeError("source contains no character meshes")
    for obj in meshes:
        bake_mesh(obj)

    minimum, maximum = mesh_bounds(meshes)
    height = maximum.z - minimum.z
    if height <= 1e-8:
        raise RuntimeError("character has zero height on Blender's Z axis")
    scale = target_height / height
    ground_center = Vector(((minimum.x + maximum.x) * 0.5, (minimum.y + maximum.y) * 0.5, minimum.z))
    for obj in meshes:
        obj.data.transform(
            Matrix.Diagonal((scale, scale, scale, 1.0))
            @ Matrix.Translation(-ground_center)
            @ obj.matrix_world
        )
        obj.matrix_world = Matrix.Identity(4)
        obj.data.update()

    keep = set(meshes)
    for obj in list(scene.objects):
        if obj not in keep:
            bpy.data.objects.remove(obj, do_unlink=True)
    for action in list(bpy.data.actions):
        bpy.data.actions.remove(action)
    for armature in list(bpy.data.armatures):
        bpy.data.armatures.remove(armature)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
    character = bpy.context.view_layer.objects.active
    safe_name = re.sub(r"[^A-Za-z0-9_]+", "_", source.stem).strip("_") or "Character"
    character.name = f"{safe_name}_Mixamo"
    character.data.name = f"{character.name}Mesh"

    for image in bpy.data.images:
        if image.source == "VIEWER" or image.type == "RENDER_RESULT":
            continue
        try:
            if not image.packed_file:
                image.pack()
        except RuntimeError as error:
            raise RuntimeError(f"could not pack image {image.name}: {error}") from error

    scene.unit_settings.system = "METRIC"
    scene.unit_settings.length_unit = "METERS"
    scene.unit_settings.scale_length = 1.0
    return character


def export_fbx(character: bpy.types.Object, output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    character.select_set(True)
    bpy.context.view_layer.objects.active = character
    result = bpy.ops.export_scene.fbx(
        filepath=os.fspath(output),
        use_selection=True,
        object_types={"MESH"},
        global_scale=1.0,
        apply_unit_scale=True,
        apply_scale_options="FBX_SCALE_UNITS",
        axis_forward="-Z",
        axis_up="Y",
        path_mode="COPY",
        embed_textures=True,
        use_mesh_modifiers=True,
        use_triangles=True,
        add_leaf_bones=False,
        bake_anim=False,
    )
    if "FINISHED" not in result or not output.is_file():
        raise RuntimeError(f"Blender did not produce {output}")


def verify(output: Path, target_height: float) -> dict[str, object]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=os.fspath(output))
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    minimum, maximum = mesh_bounds(meshes)
    dimensions = [maximum[index] - minimum[index] for index in range(3)]
    report: dict[str, object] = {
        "fbx": os.fspath(output),
        "bytes": output.stat().st_size,
        "meshes": len(meshes),
        "armatures": len(armatures),
        "vertices": sum(len(obj.data.vertices) for obj in meshes),
        "polygons": sum(len(obj.data.polygons) for obj in meshes),
        "materials": sorted(
            {slot.material.name for obj in meshes for slot in obj.material_slots if slot.material}
        ),
        "images": sorted(image.name for image in bpy.data.images if image.source != "VIEWER"),
        "bounds_min": [round(value, 5) for value in minimum],
        "bounds_max": [round(value, 5) for value in maximum],
        "dimensions": [round(value, 5) for value in dimensions],
    }
    if len(meshes) != 1 or armatures:
        raise RuntimeError(f"FBX verification found {len(meshes)} meshes and {len(armatures)} armatures")
    if abs(dimensions[2] - target_height) > 0.02:
        raise RuntimeError(
            f"FBX verification measured {dimensions[2]:.4f} m height, expected {target_height:.4f} m"
        )
    return report


def main() -> None:
    args = arguments()
    character = prepare(args.source, args.rest_pose, args.height)
    export_fbx(character, args.output)
    print("MIXAMO_UPLOAD_RESULT=" + json.dumps(verify(args.output, args.height), sort_keys=True))


if __name__ == "__main__":
    main()
