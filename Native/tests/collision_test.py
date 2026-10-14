"""Authored collision pools -> canonical files -> portable shape queries."""
import base64
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile

from import_test import big, iso, run
from prop_import_test import members as prop_members


def members():
    files = prop_members()
    pbd = bytearray(files["fixture.pbd"])
    model, = struct.unpack_from("<I", pbd, 108)
    # Both model objects use this independently authored mesh header.
    struct.pack_into("<i", pbd, model + 60, 184)
    struct.pack_into("<6f", pbd, model + 244, -100, -200, -300, 100, 200, 300)
    files["fixture.pbd"] = bytes(pbd)
    data = bytearray(76)

    def append(payload):
        offset = len(data)
        data.extend(payload)
        return offset

    def proxy(x):
        return (struct.pack("<3I3I", 1, 3, 4, 0, 1, 2) + bytes(4)
                + struct.pack("<12f", x, 0, 0, 1, x + 100, 0, 0, 1, x, 100, 0, 1)
                + struct.pack("<4f", 0, 0, 1, 0))

    def body(compressed):
        masks = bytes([0]) if not compressed else bytes([255, 129, 7, 0, 0])
        depth = 1 if not compressed else 2
        values = [1., 2., 3., 4., 5., 6.] + [0.] * 18
        levels = struct.pack("<2fI", 400, 0, 1)
        if compressed:
            levels += struct.pack("<2fI", 25, 100, 8)
        return struct.pack("<4I24f", 2, len(masks), int(compressed), depth - 1, *values) + levels + masks + bytes(2)

    proxies = append(proxy(0) + proxy(200))
    bodies = append(body(False) + body(True))
    proxy_pool = append(struct.pack("<3I", proxies, 1, 2))  # Deliberately irrelevant byteSize.
    body_pool = append(struct.pack("<3I", bodies, 1, 2))
    properties = append(struct.pack("<2f2Hi4h", 1, .5, 0, 1 | 32 | 128, -1, 1, 0, 7, 0)
                        + struct.pack("<2f2Hi4h", 0, .25, 0, 32 | 128, 3, 3, 0, 8, 0))
    joins = append(struct.pack("<2I", 0, 1))
    struct.pack_into("<I", data, 4, 0x00101500)
    for offset, values in ((20, (1, body_pool)), (28, (1, proxy_pool)),
                           (52, (2, properties)), (60, (2, joins))):
        struct.pack_into("<2I", data, offset, *values)
    files["fixture.ssf"] = bytes(data)
    return files


def main():
    executable, queries = map(lambda value: Path(value).resolve(), sys.argv[1:3])
    with tempfile.TemporaryDirectory(prefix="openslope-collision-") as directory:
        root = Path(directory)
        image = root / "authored.iso"
        files = members()
        image.write_bytes(iso(big(files)))
        run(executable, "extract", image, "FIXTURE", root / "Maps")
        output = root / "Maps/FIXTURE"
        rows = json.loads((output / "Instances.json").read_text())["Instances"]
        assert rows[0]["CollsionModelPaths"] == ["0.obj", "1.obj"]
        assert rows[0]["CollsionMode"] == 1 and rows[0]["EffectSlotIndex"] == 7
        assert rows[1]["CollsionMode"] == 3 and rows[1]["PhysicsIndex"] == 0
        assert rows[1]["U0"] == 0 and rows[1]["PlayerCollision"] and not rows[1]["Visable"]
        assert "v 200 0 0" in (output / "Collision/1.obj").read_text()
        assert "vn 0 0 1" in (output / "Collision/0.obj").read_text()
        physics = json.loads((output / "Physics.json").read_text())
        bodies = physics["PhysicsHeaders"][0]["PhysicsDatas"]
        assert len(bodies) == 2 and bodies[0]["U2"] == 0 and bodies[1]["U2"] == 1
        assert bodies[0]["UFloat0"] == 1 and bodies[0]["UFloat3"] == 4
        assert base64.b64decode(bodies[1]["UByteData"]) == bytes([255, 129, 7, 0, 0])
        model = json.loads((output / "Models.json").read_text())["Models"][0]
        assert model["ModelObjects"][0]["CollisionBounds"] == {"Min": [-100, -200, -300], "Max": [100, 200, 300]}
        subprocess.run([str(queries), str(root), str(output)], check=True)
        bad = members()
        behavior = bytearray(bad["fixture.ssf"])
        joins, = struct.unpack_from("<I", behavior, 64)
        struct.pack_into("<I", behavior, joins, 100)
        bad["fixture.ssf"] = bytes(behavior)
        image.write_bytes(iso(big(bad)))
        run(executable, "extract", image, "FIXTURE", root / "bad", succeeds=False)
        assert not list((root / "bad").iterdir())
    print("PASS: multiple collision/physics payloads, source bounds, response joins and failed-import cleanup")


if __name__ == "__main__":
    main()
