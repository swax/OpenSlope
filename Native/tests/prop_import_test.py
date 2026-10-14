"""Authored packet/layout oracle for the native static-object importer."""
import json
from pathlib import Path
import struct
import sys
import tempfile
from import_test import course_members, le, big, iso, run


def packet():
    data = bytearray(64)
    data[31] = 0x6c
    struct.pack_into("<I", data, 48, 1)
    struct.pack_into("<I", data, 56, 4)
    for tag_bytes, command, count, payload in (
        (16, 0x66, 1, b"\x0c\0"),
        (64, 0x75, 4, struct.pack("<8h", 0, 0, 4096, 0, 4096, 4096, 0, 4096)),
        (48, 0x79, 4, struct.pack("<3h", 32767, 0, 0) * 4),
        (16, 0x79, 4, struct.pack("<12h", -16384, 0, -16384, 16384, 0, -16384, 16384, 0, 16384, -16384, 0, 16384)),
    ):
        tags = bytearray(tag_bytes)
        tags[-2:] = bytes([count, command])
        data += tags + payload
        data += bytes(-len(data) % 16)
    return bytes(data) + bytes(16)


def members():
    files = course_members()
    data = bytearray(files["fixture.pbd"])

    def append(payload):
        data.extend(bytes(-len(data) % 16))
        offset = len(data)
        data.extend(payload)
        return offset

    def transform(x=0):
        return struct.pack("<16f", 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1)

    placements = bytearray(512)
    for index in range(2):
        p = index * 256
        placements[p:p + 64] = transform(1000 + index * 1000)
        placements[p + 64:p + 128] = transform()
        struct.pack_into("<4f", placements, p + 128, 256, 0, 0, 0)
        struct.pack_into("<4f", placements, p + 176, 64, 128, 192, 128)
    instance_offset = append(placements)
    material = bytearray(144)
    struct.pack_into("<h", material, 0, 0)
    struct.pack_into("<h", material, 72, -1)
    struct.pack_into("<I", material, 64, 1 << 18)
    material_offset = append(material)
    block_offset = append(struct.pack("<3I", 2, 1, 0))
    pointer_offset = append(le(0))
    model = bytearray(432)
    struct.pack_into("<6I3f", model, 0, len(model), 2, 56, 0, 0, 0, 200, 1, 200)
    struct.pack_into("<6i", model, 56, -1, 0, 0, 0, 0, 56)
    struct.pack_into("<6i", model, 80, 0, 160, 160, 160, 272, 96)
    model[112:176] = transform(100)
    model[176:240] = transform(200)
    first_mesh = packet() * 2 + bytes(48)
    second_mesh = packet() + bytes(48)
    h = 240
    struct.pack_into("<I", model, h, 108)
    struct.pack_into("<4I", model, h + 28, 0, 2, 6, 44)
    # Entry offsets are relative to their own pointer words.
    struct.pack_into("<2I", model, h + 44, 8, 32)
    struct.pack_into("<7I", model, h + 52, 28, 0, len(first_mesh), 0, 0, 0, 0)
    struct.pack_into("<7I", model, h + 80, 28, 1, len(second_mesh), len(first_mesh), 0, 0, 0)
    # Animation-relative channel pointer, then channel-relative segment pointer.
    struct.pack_into("<6f3I", model, 352, 200, 0, 0, 0, 0, 0, 32, 1, 36)
    struct.pack_into("<3I6f", model, 388, 40, 1, 8, 0, 0, 0, 90, 0, 2)
    model_offset = append(model)
    blob_offset = append(first_mesh + second_mesh)
    for field, value in ((12, 2), (20, 2), (24, 1), (44, 1), (72, instance_offset),
                         (80, material_offset), (84, block_offset), (104, pointer_offset),
                         (108, model_offset), (132, blob_offset)):
        struct.pack_into("<I", data, field, value)
    files["fixture.pbd"] = bytes(data)
    for section, names in (("MODELS", ["Authored shared prop"]), ("INSTANCES", ["Visible prop", "Hidden volume"])):
        files["fixture.map"] += ("### " + section + " BEGIN\n" + "".join(name.ljust(82) + "0\n" for name in names) + "### " + section + " END\n").encode()
    behavior = bytearray(132)
    struct.pack_into("<I", behavior, 4, 0x00101500)
    struct.pack_into("<4I", behavior, 52, 2, 76, 2, 124)
    struct.pack_into("<H", behavior, 86, 1)
    struct.pack_into("<H", behavior, 110, 32)
    struct.pack_into("<2I", behavior, 124, 0, 1)
    files["fixture.ssf"] = bytes(behavior)
    return files


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix="openslope-prop-import-") as directory:
        root = Path(directory)
        image = root / "authored.iso"
        files = members()
        sky = bytearray(files['fixture.pbd']); struct.pack_into('<I',sky,12,0)
        files['fixture_sky.pbd'] = bytes(sky)
        files['fixture_sky.ssh'] = files['fixture.ssh']
        image.write_bytes(iso(big(files)))
        run(executable, "extract", image, "FIXTURE", root / "Maps")
        output = root / "Maps/FIXTURE"
        backdrop = output / 'Skybox'
        assert json.loads((backdrop / 'Models.json').read_text())['Models'][0]['ModelName'] == 'MODELS 0'
        assert json.loads((backdrop / 'Instances.json').read_text())['Instances'] == []
        assert (backdrop / 'Meshes/0.obj').is_file() and (backdrop / 'Textures/0000.png').is_file()
        assert 'Skybox' in json.loads((output / 'Import.json').read_text())['Outputs']
        assert 'skybox' not in json.loads((output / 'Import.json').read_text())['Deferred']
        broken = files.copy(); del broken['fixture_sky.ssh']; image.write_bytes(iso(big(broken)))
        run(executable, 'extract', image, 'FIXTURE', root / 'partial-sky', succeeds=False)
        assert not list((root / 'partial-sky').iterdir())
        models = json.loads((output / "Models.json").read_text())["Models"]
        instances = json.loads((output / "Instances.json").read_text())["Instances"]
        assert len(models) == 1 and len(instances) == 2
        objects = models[0]["ModelObjects"]
        assert objects[1]["ParentID"] == 0
        assert objects[0]["Position"] == [100, 0, 0] and objects[1]["Position"] == [200, 0, 0]
        assert [row["MaterialID"] for row in objects[1]["MeshData"]] == [1, 0]
        assert objects[1]["IncludeAnimation"]
        animation = objects[1]["Animation"]
        assert animation["AnimationAction"] == 32
        assert animation["AnimationEntries"][0]["AnimationMaths"] == [
            {"Value1": 0, "Value2": 0, "Value3": 0, "Value4": 90, "Value5": 0, "Value6": 2}]
        assert json.loads((output / "Materials.json").read_text())["Materials"][1]["TexturePath"] is None
        assert instances[0]["Visable"] and not instances[1]["Visable"]
        assert instances[0]["LightVector1"] == [1, 0, 0, 0]
        assert instances[0]["AmbentLightColour"] == [64, 128, 192, 128]
        obj = (output / "Meshes/0.obj").read_text().splitlines()
        assert sum(line.startswith("v ") for line in obj) == 8
        assert sum(line.startswith("f ") for line in obj) == 4
        assert "v -100 0 -100" in obj and "vt 0 1" in obj
        assert "f 1/1/1 2/2/2 3/3/3" in obj and "f 3/3/3 2/2/2 4/4/4" in obj
        bad = members(); pbd = bytearray(bad["fixture.pbd"])
        blob, = struct.unpack_from("<I", pbd, 132)
        struct.pack_into("<I", pbd, blob + 56, 400)
        bad["fixture.pbd"] = bytes(pbd); image.write_bytes(iso(big(bad)))
        run(executable, "extract", image, "FIXTURE", root / "bad", succeeds=False)
        assert not list((root / "bad").iterdir())
        bad = members(); pbd = bytearray(bad["fixture.pbd"])
        model_start, = struct.unpack_from("<I", pbd, 108)
        struct.pack_into("<I", pbd, model_start + 396, 0xffffff00)
        bad["fixture.pbd"] = bytes(pbd); image.write_bytes(iso(big(bad)))
        run(executable, "extract", image, "FIXTURE", root / "bad-animation", succeeds=False)
        assert not list((root / "bad-animation").iterdir())
    print("PASS: authored prop packets, material indirection, hierarchy, visibility, normals, strips and failed-import cleanup")


if __name__ == "__main__":
    main()
