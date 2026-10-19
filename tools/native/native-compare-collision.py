"""Compare generated collision contracts, without importing another decoder."""

import base64
import json
from pathlib import Path
import struct
import sys


def read(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def f32(value):
    return struct.pack("<f", value)


def proxy(path):
    vertices, normals, triangles = [], [], []

    def index(text, count):
        value = int(text)
        return value - 1 if value > 0 else count + value

    for line in path.read_text().splitlines():
        fields = line.split()
        if not fields or fields[0].startswith("#"):
            continue
        if fields[0] == "v":
            vertices.append(tuple(map(float, fields[1:4])))
        if fields[0] == "vn":
            normals.append(tuple(map(float, fields[1:4])))
        if fields[0] == "f":
            face = [token.split("/") for token in fields[1:]]
            for i in range(1, len(face) - 1):
                triangle = []
                for corner in (face[0], face[i], face[i + 1]):
                    point = vertices[index(corner[0], len(vertices))]
                    normal = normals[index(corner[2], len(normals))] if len(corner) == 3 and corner[2] else None
                    triangle.append((point, normal))
                triangles.append(triangle)
    return triangles


def compare(native, reference):
    current = read(native / "Instances.json")["Instances"]
    expected = read(reference / "Instances.json")["Instances"]
    assert len(current) == len(expected), "instance count"
    checked = set()
    for i, (a, b) in enumerate(zip(current, expected)):
        for key in [
            "PlayerCollision",
            "PlayerBounce",
            "SurfaceType",
            "CollsionMode",
            "PhysicsIndex",
            "EffectSlotIndex",
        ]:
            assert a[key] == b[key], f"instance {i} {key}: {a[key]} != {b[key]}"
        for key in ["U0", "PlayerBounceAmmount"]:
            assert f32(a[key]) == f32(b[key]), f"instance {i} {key}"
        names_a, names_b = a.get("CollsionModelPaths") or [], b.get("CollsionModelPaths") or []
        assert len(names_a) == len(names_b), f"instance {i} proxy payload count"
        for name_a, name_b in zip(names_a, names_b):
            pair = (name_a, name_b)
            if pair in checked:
                continue
            checked.add(pair)
            actual, wanted = proxy(native / "Collision" / name_a), proxy(reference / "Collision" / name_b)
            assert len(actual) == len(wanted), f"proxy {pair} face count"
            for face_a, face_b in zip(actual, wanted):
                for corner_a, corner_b in zip(face_a, face_b):
                    for va, vb in zip(corner_a[0], corner_b[0]):
                        assert abs(va - vb) <= 0.001, f"proxy {pair} vertex"
                    assert (corner_a[1] is None) == (corner_b[1] is None), f"proxy {pair} normal presence"
                    if corner_a[1] is not None:
                        assert all(abs(va - vb) <= 1e-6 for va, vb in zip(corner_a[1], corner_b[1])), (
                            f"proxy {pair} face normal"
                        )
    actual = read(native / "Physics.json")["PhysicsHeaders"]
    wanted = read(reference / "SSFLogic.json")["PhysicsHeaders"]
    assert len(actual) == len(wanted), "physics pool count"
    bodies = 0
    for i, (a, b) in enumerate(zip(actual, wanted)):
        assert len(a["PhysicsDatas"]) == len(b["PhysicsDatas"]), f"physics pool {i} payload count"
        for va, vb in zip(a["PhysicsDatas"], b["PhysicsDatas"]):
            bodies += 1
            assert va["U2"] == vb["U2"], f"physics pool {i} encoding"
            assert base64.b64decode(va["UByteData"]) == base64.b64decode(vb["UByteData"]), f"physics pool {i} masks"
            for field in range(24):
                key = f"UFloat{field}"
                assert f32(va[key]) == f32(vb[key]), f"physics pool {i} {key}"
            levels_a, levels_b = va["uPhysicsStruct0"], vb["uPhysicsStruct0"]
            assert len(levels_a) == len(levels_b), f"physics pool {i} depth"
            for level_a, level_b in zip(levels_a, levels_b):
                assert level_a["U2"] == level_b["U2"], f"physics pool {i} stride"
                for key in ["U0", "U1"]:
                    assert f32(level_a[key]) == f32(level_b[key]), f"physics pool {i} level {key}"
    # The source box extension has no counterpart in older exported Models.json.
    # Check each six-float box directly against its clean PBD layout instead.
    source = next((native / "Source").glob("*.PBD")).read_bytes()
    word = lambda offset: struct.unpack_from("<I", source, offset)[0]
    models = read(native / "Models.json")["Models"]
    assert len(models) == word(44), "source model count"
    bounds = 0
    for i, model in enumerate(models):
        start = word(108) + word(word(104) + i * 4)
        assert len(model["ModelObjects"]) == word(start + 4), "source object count"
        for j, obj in enumerate(model["ModelObjects"]):
            entry = start + word(start + 8) + j * 24
            (relative,) = struct.unpack_from("<i", source, entry + 4)
            if relative <= 0:
                continue
            box = obj["CollisionBounds"]
            values = box["Min"] + box["Max"]
            wanted = struct.unpack_from("<6f", source, entry + relative + 4)
            assert all(f32(a) == f32(b) for a, b in zip(values, wanted)), f"model {i} object {j} source bounds"
            bounds += 1
    print(
        f"PASS {native.name}: {len(current)} instance joins, {len(checked)} proxy pairs, {bodies} bodies, {bounds} source boxes"
    )


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: native-compare-collision.py <native-course> <reference-course>")
    compare(Path(sys.argv[1]), Path(sys.argv[2]))
