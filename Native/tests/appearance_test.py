"""Authored PNG/map fixtures; no disc or external game-format decoder required."""
import json
import pathlib
import struct
import subprocess
import sys
import tempfile
import zlib


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def png(width, height, pixels, colour=6, interlace=0, extra=b""):
    header = struct.pack(">IIBBBBB", width, height, 8, colour, 0, 0, interlace)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + extra + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b"")


def rgba(width, height, pixels):
    return png(width, height, b"".join(b"\0" + bytes(pixels[y * width * 4:(y + 1) * width * 4]) for y in range(height)))


def course(root, name, texture, lightmap=-1, tile=(0, 0, 0, 0), uv=((0, 0), (0, 1), (1, 0), (1, 1))):
    folder = root / name
    (folder / "Textures").mkdir(parents=True)
    (folder / "Lightmaps").mkdir()
    # With identity projection: screen x=patch u, screen y=patch v.
    points = [[(u * 1.6 / 3 - .8) * 100, -50, (v * 1.6 / 3 - .8) * 100] for u in range(4) for v in range(4)]
    row = dict(PatchName="Authored rendering fixture", SurfaceType=1, TrickOnlyPatch=False,
               Points=points, UVPoints=uv, TexturePath=texture, LightmapID=lightmap, LightMapPoint=tile)
    (folder / "Patches.json").write_text(json.dumps(dict(Patches=[row])), encoding="utf-8")
    return folder


def fixtures(root):
    pixels = bytes([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 255, 255, 255, 64])
    (root / "rgba.png").write_bytes(rgba(2, 2, pixels))
    palette = chunk(b"PLTE", bytes([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255])) + chunk(b"tRNS", bytes([255, 128, 0, 64]))
    (root / "palette.png").write_bytes(png(2, 2, b"\0\0\1\0\2\3", 3, extra=palette))
    # Adam7 passes for 2x2: pass1 top-left, pass6 top-right, pass7 bottom row.
    (root / "interlaced.png").write_bytes(png(2, 2, b"\0" + pixels[:4] + b"\0" + pixels[4:8] + b"\0" + pixels[8:], interlace=1))
    (root / "rgb.png").write_bytes(png(1, 1, b"\0\x17\x3d\x7f", 2, extra=chunk(b"gAMA", struct.pack(">I", 100000))))
    bad = bytearray((root / "rgba.png").read_bytes()); bad[-5] ^= 1
    (root / "crc.png").write_bytes(bad)
    (root / "truncated.png").write_bytes(bytes(bad[:40]))
    (root / "oversized.png").write_bytes(png(5000, 1, b""))
    (root / "not-png.png").write_bytes(b"not a PNG" * 8)
    orientation = course(root, "orientation", "corners.png")
    # 4x4 constant quadrants: sample well away from their filtering boundary.
    corners = ([240, 20, 40, 255], [30, 220, 50, 255], [40, 60, 230, 255], [230, 210, 190, 255])
    (orientation / "Textures/corners.png").write_bytes(rgba(4, 4, sum((corners[(y // 2) * 2 + x // 2] for y in range(4) for x in range(4)), [])))
    handedness = course(root, "handedness", "corners.png", uv=((0, 0), (1, 0), (0, 1), (1, 1)))
    document = json.loads((handedness / "Patches.json").read_text())
    # Raw X grows to the right; raw +Z is up and raw +Y is forward.
    # This fixture deliberately has no inverse of the native loader's mapping.
    document["Patches"][0]["Points"] = [[(-3.2 + u * 6.4 / 3) * 100, 400, (3.2 - v * 6.4 / 3) * 100] for u in range(4) for v in range(4)]
    (handedness / "Patches.json").write_text(json.dumps(document), encoding="utf-8")
    (handedness / "Textures/corners.png").write_bytes((orientation / "Textures/corners.png").read_bytes())
    lighting = course(root, "lighting", "base.png", 0, (.25, .25, .5, .5))
    (lighting / "Textures/base.png").write_bytes(rgba(1, 1, [200, 180, 160, 255]))
    light = ([20, 40, 60, 128], [100, 10, 30, 255], [50, 100, 170, 192], [0, 0, 0, 64])
    page = sum((light[((y - 2) // 2) * 2 + (x - 2) // 2] if 2 <= x < 6 and 2 <= y < 6 else [255, 0, 255, 255] for y in range(8) for x in range(8)), [])
    (lighting / "Lightmaps/0000.png").write_bytes(rgba(8, 8, page))
    repeat = course(root, "repeat", "corners.png", uv=((0, -1), (0, 1), (2, -1), (2, 1)))
    (repeat / "Textures/corners.png").write_bytes((orientation / "Textures/corners.png").read_bytes())
    course(root, "missing", "base.png", 0, (.25, .25, .5, .5))
    course(root, "unsafe", "../rgb.png")
    corrupt = course(root, "corrupt", "base.png")
    (corrupt / "Textures/base.png").write_bytes(bad)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="openslope-appearance-") as temporary:
        root = pathlib.Path(temporary)
        fixtures(root)
        for executable in sys.argv[1:]:
            subprocess.run([executable, str(root)], check=True)
