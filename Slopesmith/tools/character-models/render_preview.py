"""Render a framed preview of a character GLB or posed Blender file.

Run inside Blender:

    blender --background --factory-startup --python render_preview.py -- \
        MODEL.glb OUTPUT.png [--frame 20] [--view three-quarter]
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def arguments() -> argparse.Namespace:
    if "--" not in sys.argv:
        raise SystemExit("Expected Blender script arguments after --")
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--frame", type=int, help="evaluate this frame before rendering")
    parser.add_argument(
        "--view",
        choices=("three-quarter", "front", "side", "back"),
        default="three-quarter",
    )
    parser.add_argument("--size", type=int, default=700, help="square output size in pixels")
    parser.add_argument("--transparent", action="store_true")
    parser.add_argument("--background", default="0b0e13", help="six-digit RGB background colour")
    parser.add_argument(
        "--dark",
        action="store_true",
        help="drop the lights to a trace so only emissive materials read: what a character looks like at night",
    )
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1 :])
    args.source = args.source.resolve()
    args.output = args.output.resolve()
    if not args.source.is_file():
        parser.error(f"source does not exist: {args.source}")
    if args.source.suffix.lower() not in {".glb", ".blend"}:
        parser.error("source must be a .glb or .blend file")
    if args.output.suffix.lower() != ".png":
        parser.error("output must have a .png extension")
    if args.size < 64:
        parser.error("--size must be at least 64")
    if len(args.background.lstrip("#")) != 6:
        parser.error("--background must be a six-digit RGB colour")
    return args


def colour(value: str) -> tuple[float, float, float]:
    value = value.lstrip("#")
    try:
        srgb = [int(value[index : index + 2], 16) / 255 for index in (0, 2, 4)]
        return tuple(
            channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4
            for channel in srgb
        )
    except ValueError as error:
        raise SystemExit("--background must be a six-digit RGB colour") from error


def load(source: Path, frame: int | None) -> tuple[list[Vector], Vector, Vector]:
    if source.suffix.lower() == ".blend":
        bpy.ops.wm.open_mainfile(filepath=os.fspath(source))
    else:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=os.fspath(source))
    if frame is not None:
        bpy.context.scene.frame_set(frame)
    bpy.context.view_layer.update()
    # A hidden COLLECTION hides its objects too, and the glTF importer puts the unit sphere it uses as a bone
    # display shape in one. It never renders, but counted as bounds it silently triples the extent the camera
    # and both lights below are scaled from — a small character framed for a two-metre scene, badly overlit.
    meshes = [
        obj for obj in bpy.context.scene.objects
        if obj.type == "MESH" and not obj.hide_render
        and not any(collection.hide_render for collection in obj.users_collection)
    ]
    depsgraph = bpy.context.evaluated_depsgraph_get()
    # Skinned meshes often store compact inverse-bind geometry whose object-mode bound box bears no relation to
    # the visible standing character. Frame the evaluated armature result that the renderer will actually draw.
    points = []
    for obj in meshes:
        evaluated = obj.evaluated_get(depsgraph)
        evaluated_mesh = evaluated.to_mesh()
        try:
            points.extend(evaluated.matrix_world @ vertex.co for vertex in evaluated_mesh.vertices)
        finally:
            evaluated.to_mesh_clear()
    if not points:
        raise RuntimeError("source contains no renderable mesh bounds")
    minimum = Vector(tuple(min(point[axis] for point in points) for axis in range(3)))
    maximum = Vector(tuple(max(point[axis] for point in points) for axis in range(3)))
    return points, minimum, maximum


def aim(obj: bpy.types.Object, target: Vector) -> None:
    obj.rotation_euler = ((target - obj.location).to_track_quat("-Z", "Y")).to_euler()


def render(args: argparse.Namespace) -> None:
    points, minimum, maximum = load(args.source, args.frame)
    center = (minimum + maximum) * 0.5
    dimensions = maximum - minimum
    extent = max(dimensions.x, dimensions.y, dimensions.z, 0.1)
    print(
        "CHARACTER_PREVIEW_BOUNDS="
        f"min={tuple(round(value, 4) for value in minimum)} "
        f"max={tuple(round(value, 4) for value in maximum)}"
    )
    directions = {
        "three-quarter": Vector((0.8, -1.35, 0.18)),
        "front": Vector((0.0, -1.0, 0.08)),
        "side": Vector((1.0, 0.0, 0.08)),
        "back": Vector((0.0, 1.0, 0.08)),
    }
    direction = directions[args.view].normalized()
    view_right = direction.cross(Vector((0, 0, 1))).normalized()
    view_up = view_right.cross(direction).normalized()
    horizontal = max(point.dot(view_right) for point in points) - min(point.dot(view_right) for point in points)
    vertical = max(point.dot(view_up) for point in points) - min(point.dot(view_up) for point in points)

    bpy.ops.object.camera_add(location=center + direction * extent * 3.0)
    camera = bpy.context.object
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = max(horizontal, vertical, 0.1) * 1.15
    aim(camera, center)
    bpy.context.scene.camera = camera

    bpy.ops.object.light_add(
        type="AREA",
        location=center + direction * extent * 1.7 - view_right * extent * 0.8 + Vector((0, 0, extent)),
    )
    key = bpy.context.object
    # Both lights are placed a multiple of `extent` away, so their power has to scale with its square to hold
    # the exposure as a character's size changes. The constants are chosen so a white surface square to the
    # key lands just under clipping under the Standard view transform, which is what the flat-colour
    # materials these previews exist to check need — a blown frame hides exactly the colour it was asked for.
    # A trace of key light rather than none at all: pitch black would hide whether a lit panel is actually
    # ON a model or floating beside it, which is the mistake this view exists to catch.
    exposure = 0.03 if args.dark else 1.0
    key.data.energy = 45 * exposure * max(1.0, extent * extent)
    key.data.shape = "DISK"
    key.data.size = extent * 1.8
    aim(key, center)
    bpy.ops.object.light_add(
        type="AREA",
        location=center - direction * extent + view_right * extent + Vector((0, 0, extent * 0.4)),
    )
    fill = bpy.context.object
    fill.data.energy = 18 * exposure * max(1.0, extent * extent)
    fill.data.size = extent * 1.5
    aim(fill, center)

    scene = bpy.context.scene
    engines = {item.identifier for item in type(scene.render).bl_rna.properties["engine"].enum_items}
    scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in engines else "BLENDER_EEVEE"
    scene.render.resolution_x = args.size
    scene.render.resolution_y = args.size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA" if args.transparent else "RGB"
    scene.view_settings.view_transform = "Standard"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    scene.render.filepath = os.fspath(args.output)
    scene.render.film_transparent = args.transparent
    scene.world = scene.world or bpy.data.worlds.new("CharacterPreviewWorld")
    background = colour("000000" if args.dark else args.background)
    scene.world.color = background
    scene.world.use_nodes = True
    world_background = scene.world.node_tree.nodes.get("Background")
    if world_background:
        world_background.inputs["Color"].default_value = (*background, 1.0)
        world_background.inputs["Strength"].default_value = 1.0
    result = bpy.ops.render.render(write_still=True)
    if "FINISHED" not in result or not args.output.is_file():
        raise RuntimeError(f"Blender did not produce {args.output}")
    print(f"CHARACTER_PREVIEW_RESULT={args.output} {args.size}x{args.size} {args.view}")


if __name__ == "__main__":
    render(arguments())
