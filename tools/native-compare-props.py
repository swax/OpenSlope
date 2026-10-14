"""Compare generated static-prop contracts, never decoder implementation sources."""
import json
import argparse
import struct
from pathlib import Path


def document(root, name, key):
    return json.loads((root / name).read_text(encoding="utf-8"))[key]


def close(a, b, tolerance):
    return len(a) == len(b) and all(abs(x - y) <= tolerance for x, y in zip(a, b))


def same_float32(a, b):
    # Both JSON writers serialize the same single-precision source values with
    # different decimal spellings. Compare the recovered float32 bytes exactly.
    return len(a) == len(b) and all(struct.pack("<f", x) == struct.pack("<f", y) for x, y in zip(a, b))


def triangles(path):
    points, uv, normals, result = [], [], [], []
    for line in path.read_text(encoding="utf-8").splitlines():
        fields = line.split()
        if not fields:
            continue
        if fields[0] in ("v", "vt", "vn"):
            {"v": points, "vt": uv, "vn": normals}[fields[0]].append(tuple(map(float, fields[1:])))
        elif fields[0] == "f":
            corners = []
            for field in fields[1:]:
                p, t, n = map(int, field.split("/"))
                corners.append((points[p - 1], uv[t - 1], normals[n - 1]))
            for i in range(1, len(corners) - 1):
                result.append((corners[0], corners[i], corners[i + 1]))
    return result


def compare_mesh(a, b, tolerance):
    first, second = triangles(a), triangles(b)
    if len(first) != len(second):
        raise AssertionError(f"{a.name}: triangle count {len(first)} != {len(second)}")
    worst = 0
    for index, (triangle, reference) in enumerate(zip(first, second)):
        matched = False
        for rotation in range(3):
            candidate = reference[rotation:] + reference[:rotation]
            if all(close(p, q, tolerance) and close(uv, uv_ref, 1e-6) and close(n, n_ref, 1e-6)
                   for (p, uv, n), (q, uv_ref, n_ref) in zip(triangle, candidate)):
                worst = max(worst, max(abs(x - y) for c, d in zip(triangle, candidate) for x, y in zip(c[0], d[0])))
                matched = True
                break
        if not matched:
            raise AssertionError(f"{a.name}: triangle {index} position, UV, normal or winding differs")
    return len(first), worst


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("native", type=Path)
    parser.add_argument("reference", type=Path)
    parser.add_argument("--point-tolerance-cm", type=float, default=.001)
    args = parser.parse_args()
    if not 0 < args.point_tolerance_cm <= 1:
        parser.error("point tolerance must be positive and no greater than one raw centimetre")
    native, reference = args.native, args.reference
    models = document(native, "Models.json", "Models")
    model_ref = document(reference, "Models.json", "Models")
    instances = document(native, "Instances.json", "Instances")
    instance_ref = document(reference, "Instances.json", "Instances")
    materials = document(native, "Materials.json", "Materials")
    material_ref = document(reference, "Materials.json", "Materials")
    assert (len(models), len(instances), len(materials)) == (len(model_ref), len(instance_ref), len(material_ref))
    for a, b in zip(materials, material_ref):
        assert (a["TexturePath"] or "") == (b["TexturePath"] or "") and a["UnknownInt18"] == b["UnknownInt18"]
    count, faces, worst = 0, 0, 0
    for a, b in zip(models, model_ref):
        assert a["ModelName"] == b["ModelName"] and len(a["ModelObjects"]) == len(b["ModelObjects"])
        assert same_float32([a["AnimTime"]], [b["AnimTime"]])
        for obj, obj_ref in zip(a["ModelObjects"], b["ModelObjects"]):
            assert obj["ParentID"] == obj_ref["ParentID"]
            assert obj["IncludeMatrix"] == obj_ref["IncludeMatrix"] and obj["IncludeAnimation"] == obj_ref["IncludeAnimation"]
            if obj["IncludeMatrix"]:
                assert same_float32(obj["Position"], obj_ref["Position"])
                assert close(obj["Scale"], obj_ref["Scale"], 1e-5)
                assert min(sum((x - y) ** 2 for x, y in zip(obj["Rotation"], obj_ref["Rotation"])),
                           sum((x + y) ** 2 for x, y in zip(obj["Rotation"], obj_ref["Rotation"]))) < 1e-8
            if obj["IncludeAnimation"]:
                first, second = obj["Animation"], obj_ref["Animation"]
                assert first["AnimationAction"] == second["AnimationAction"]
                assert same_float32([first[f"U{i}"] for i in range(1, 7)], [second[f"U{i}"] for i in range(1, 7)])
                assert len(first["AnimationEntries"]) == len(second["AnimationEntries"])
                for entry, entry_ref in zip(first["AnimationEntries"], second["AnimationEntries"]):
                    rows, rows_ref = entry["AnimationMaths"], entry_ref["AnimationMaths"]
                    assert len(rows) == len(rows_ref)
                    for row, row_ref in zip(rows, rows_ref):
                        assert same_float32([row[f"Value{i}"] for i in range(1, 7)], [row_ref[f"Value{i}"] for i in range(1, 7)])
            assert len(obj["MeshData"]) == len(obj_ref["MeshData"])
            for part, part_ref in zip(obj["MeshData"], obj_ref["MeshData"]):
                assert part["MaterialID"] == part_ref["MaterialID"]
                triangles_count, error = compare_mesh(native / "Meshes" / part["MeshPath"], reference / "Meshes" / part_ref["MeshPath"], args.point_tolerance_cm)
                count += 1; faces += triangles_count; worst = max(worst, error)
    for a, b in zip(instances, instance_ref):
        assert a["InstanceName"] == b["InstanceName"] and a["ModelID"] == b["ModelID"] and a["Visable"] == b["Visable"]
        assert same_float32(a["Location"], b["Location"]), f"{a['InstanceName']}: source location differs"
        assert close(a["Scale"], b["Scale"], 1e-5), f"{a['InstanceName']}: decomposed scale differs"
        # Quaternions q and -q encode the same rotation.
        assert min(sum((x - y) ** 2 for x, y in zip(a["Rotation"], b["Rotation"])), sum((x + y) ** 2 for x, y in zip(a["Rotation"], b["Rotation"]))) < 1e-8
        for key in ("LightVector1", "LightVector2", "LightVector3", "LightColour1", "LightColour2", "LightColour3", "AmbentLightColour"):
            assert same_float32(a[key], b[key]), f"{a['InstanceName']}: {key} differs at float32 precision"
    print(f"PASS: {len(models)} models, {len(instances)} placements, {len(materials)} materials, {count} meshes, {faces} ordered triangles; max position delta {worst:.6f} raw cm")
    print(f"Declared position tolerance: {args.point_tolerance_cm} raw cm.")
    print("Source locations/lighting/animation: exact recovered float32; scale tolerance 1e-5; quaternion squared delta < 1e-8; UV/normal tolerance 1e-6.")
    print("Material names and deferred behavior fields are outside this static rendering comparison.")


if __name__ == "__main__":
    main()
