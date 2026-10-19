"""Compare sky model/material/PNG data against an existing normalized course."""

import argparse
import importlib.util
import json
from pathlib import Path


def helper(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def compare(native, reference):
    geometry = helper("native-compare-props")
    images = helper("native-compare-maps")
    native, reference = native / "Skybox", reference / "Skybox"
    a = geometry.document(native, "Models.json", "Models")
    b = geometry.document(reference, "Models.json", "Models")
    assert len(a) == len(b), "Sky model count differs"
    triangles, worst = 0, 0
    textures = set()
    ma = geometry.document(native, "Materials.json", "Materials")
    mb = geometry.document(reference, "Materials.json", "Materials")
    assert len(ma) == len(mb), "Sky material count differs"
    for x, y in zip(ma, mb):
        assert (x["TexturePath"], x["UnknownInt18"]) == (y["TexturePath"], y["UnknownInt18"]), (
            "Sky material binding differs"
        )
        if x["TexturePath"]:
            textures.add(x["TexturePath"])
    for model, expected in zip(a, b):
        assert len(model["ModelObjects"]) == len(expected["ModelObjects"]), "Sky hierarchy count differs"
        for obj, other in zip(model["ModelObjects"], expected["ModelObjects"]):
            assert obj["ParentID"] == other["ParentID"], "Sky parent differs"
            for key in ("Position", "Rotation", "Scale"):
                x, y = obj.get(key), other.get(key)
                assert (x is None and y is None) or (x is not None and y is not None and geometry.same_float32(x, y)), (
                    f"Sky {key} differs"
                )
            assert not obj.get("IncludeAnimation", False) and not other.get("IncludeAnimation", False), (
                "Animated sky requires a separate comparison oracle"
            )
            parts, others = obj["MeshData"], other["MeshData"]
            assert len(parts) == len(others), "Sky material partition differs"
            for part, expected_part in zip(parts, others):
                assert part["MaterialID"] == expected_part["MaterialID"], "Sky material index differs"
                count, error = geometry.compare_mesh(
                    native / "Meshes" / part["MeshPath"], reference / "Meshes" / expected_part["MeshPath"], 0.001
                )
                triangles += count
                worst = max(worst, error)
    for name in textures:
        assert Path(name).name == name and "/" not in name and "\\" not in name, "Unsafe comparison asset"
        assert images.rgba(native / "Textures" / name) == images.rgba(reference / "Textures" / name), (
            f"Sky RGBA differs: {name}"
        )
    print(
        f"PASS: {len(a)} sky models, {len(ma)} materials, {len(textures)} exact RGBA images, {triangles} triangles; worst position difference {worst:g} raw cm"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("native", type=Path)
    parser.add_argument("reference", type=Path)
    args = parser.parse_args()
    compare(args.native, args.reference)
