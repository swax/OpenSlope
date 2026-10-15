"""Authored PNG/map fixtures; no disc or external game-format decoder required."""
import json
import pathlib
import shutil
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
    for name in ('sky', 'sky_foreground', 'sky_authored'):
        folder = course(root, name, 'base.png')
        (folder / 'Textures/base.png').write_bytes(rgba(1, 1, [40,80,120,255]))
        if name != 'sky_foreground':
            document = json.loads((folder / 'Patches.json').read_text())
            for p in document['Patches'][0]['Points']: p[0] += 10000
            (folder / 'Patches.json').write_text(json.dumps(document))
        sky = folder / 'Skybox'
        (sky / 'Textures').mkdir(parents=True)
        (sky / 'Meshes').mkdir()
        (sky / 'Meshes/ring.obj').write_text('v -200 200 -60\nv 200 200 -60\nv 200 200 60\nv -200 200 60\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nf 1/1 2/2 3/3 4/4\n')
        (sky / 'Models.json').write_text(json.dumps(dict(Models=[dict(ModelObjects=[dict(ParentID=-1, MeshData=[dict(MeshPath='ring.obj', MaterialID=0)])])])))
        (sky / 'Materials.json').write_text(json.dumps(dict(Materials=[dict(TexturePath='sky.png')])))
        (sky / 'Textures/sky.png').write_bytes(rgba(4,4,[c for y in range(4) for x in range(4) for c in ([120,160,200,255] if y==0 else [20,40,80,255] if x<2 else [80,20,40,255])]))
        # No instance table: the panorama is already camera-local model geometry.
        (folder / 'World.json').write_text(json.dumps(dict(Schema='openslope-world/v1', Fog=dict(Enabled=False), **(dict(SkyColor=[90,110,130]) if name=='sky_authored' else {}))))
    fog = course(root, 'fog', 'base.png')
    (fog / 'Textures/base.png').write_bytes(rgba(1,1,[40,80,120,255]))
    (fog / 'World.json').write_text(json.dumps(dict(Schema='openslope-world/v1', SkyColor=[23,61,127], Fog=dict(Start=0, End=1, Color=[200,40,20]))))
    for name, profile in [('fog_bad_range', dict(Fog=dict(Start=3,End=2))), ('world_bad_colour', dict(SkyColor=[0,256,0])), ('world_bad_schema', {})]:
        folder = course(root,name,'')
        (folder / 'World.json').write_text(json.dumps(dict(Schema='invalid' if name=='world_bad_schema' else 'openslope-world/v1', **profile)))
    incomplete = course(root, 'sky_incomplete', '')
    (incomplete / 'Skybox').mkdir()
    (incomplete / 'Skybox/Models.json').write_text('{"Models":[]}')
    unsafe = course(root, 'sky_unsafe', '')
    (unsafe / 'Skybox').mkdir()
    (unsafe / 'Skybox/Models.json').write_text(json.dumps(dict(Models=[dict(ModelObjects=[dict(MeshData=[dict(MeshPath='../escape.obj',MaterialID=0)])])])))
    (unsafe / 'Skybox/Materials.json').write_text('{"Materials":[{"TexturePath":"sky.png"}]}')
    sheet = course(root, 'sheet', 'background.png')
    (sheet / 'Textures/background.png').write_bytes(rgba(1, 1, [40, 80, 120, 255]))
    (sheet / 'Textures/sheet.png').write_bytes(rgba(1, 1, [255,255,255,128]))
    (sheet / 'RidingEffects.json').write_text(json.dumps(dict(Schema='openslope-riding-effects/v1', Sheet='sheet.png')))
    for name in ('wake', 'wake_repeat', 'unsafe_wake'):
        wake = course(root, name, 'background.png')
        (wake / 'Textures/background.png').write_bytes(rgba(1, 1, [40, 80, 120, 255]))
        (wake / 'RidingEffects.json').write_text(json.dumps(dict(Schema='openslope-riding-effects/v1', Wake='../rgb.png' if name == 'unsafe_wake' else 'wake.png')))
        art = rgba(1, 1, [200, 100, 50, 128]) if name != 'wake_repeat' else rgba(32, 32, [c for y in range(32) for x in range(32) for c in [200,200,200,255 if x < 8 and y < 16 else 0]])
        (wake / 'Textures/wake.png').write_bytes(art)
    sprites = course(root, "sprites", "background.png")
    (sprites / "Textures/background.png").write_bytes(rgba(1, 1, [40, 80, 120, 255]))
    (sprites / "Textures/puff.png").write_bytes(rgba(1, 1, [255, 255, 255, 255]))
    (sprites / "RidingEffects.json").write_text(json.dumps(dict(Schema='openslope-riding-effects/v1', Puff='puff.png')))
    miniature = course(root, "minification", "checker.png", uv=((0, 0), (0, 256), (256, 0), (256, 256)))
    (miniature / "Textures/checker.png").write_bytes(rgba(128, 128, [channel for y in range(128) for x in range(128) for channel in ([255,255,255,255] if (x+y)%2 else [0,0,0,255])]))
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
    for name, flags, art in (("props", 0, [200, 160, 120, 64]),
                              ("props_cutout", 1 << 18, [240, 100, 40, 0, 240, 100, 40, 255]),
                              ("props_blend", 1 << 18, [200, 160, 120, 128])):
        folder = course(root, name, "background.png")
        (folder / "Textures/background.png").write_bytes(rgba(1, 1, [40, 80, 120, 255]))
        (folder / "Textures/prop.png").write_bytes(rgba(len(art) // 4, 1, art))
        (folder / "Meshes").mkdir()
        (folder / "Meshes/quad.obj").write_text("v -30 0 -30\nv 30 0 -30\nv 30 0 30\nv -30 0 30\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nvn 1 0 0\nf 1/1/1 2/2/1 3/3/1 4/4/1\n")
        models = [{"ModelName": "Authored shared quad", "ModelObjects": [{"ParentID": -1, "MeshData": [{"MeshPath": "quad.obj", "MaterialID": 0}]}]}]
        materials = [{"TexturePath": "prop.png", "UnknownInt18": flags}]
        if name == "props_cutout":
            materials[0]["TextureFlipbook"] = ["prop.png", "prop-state.png"]
            (folder / "Textures/prop-state.png").write_bytes(rgba(1, 1, [240, 100, 40, 128]))
        if name == "props":
            materials[0]["TextureFlipbook"] = ["prop.png", "prop-state.png"]
            (folder / "Textures/prop-state.png").write_bytes(rgba(1, 1, [80, 120, 200, 255]))
            instances = [dict(ModelID=0, Location=[-40, -25, 0], Rotation=[0, 0, 0, 1], Scale=[.7, .7, .7], Visable=True, AmbentLightColour=[0, 0, 0, 128], LightVector1=[1, 0, 0, 0], LightColour1=[192, 128, 64, 0]),
                         dict(ModelID=0, Location=[40, -25, 0], Rotation=[0, 1, 0, 0], Scale=[.7, .7, .7], Visable=True, AmbentLightColour=[0, 0, 0, 128], LightVector1=[1, 0, 0, 0], LightColour1=[384, 256, 128, 0]),
                         dict(ModelID=0, Location=[0, -25, 0], Visable=False),
                         dict(ModelID=0, Location=[100000, -25, 0], Visable=True),
                         dict(ModelID=0, Location=[2000, -25, 0], Visable=True)]
        else:
            instances = [dict(ModelID=0, Location=[0, -25, 0], Visable=True)]
        for filename, key, rows in (("Models.json", "Models", models), ("Materials.json", "Materials", materials), ("Instances.json", "Instances", instances)):
            (folder / filename).write_text(json.dumps({key: rows}), encoding="utf-8")
    folder = root/'props_uv'
    shutil.copytree(root/'props', folder)
    palette = [[240,20,40,255],[20,220,40,255],[20,40,240,255],[240,190,10,255]]
    (folder/'Textures/grid.png').write_bytes(rgba(16,16,sum((palette[(y//8)*2+x//8] for y in range(16) for x in range(16)),[])))
    (folder/'Materials.json').write_text(json.dumps(dict(Materials=[dict(TexturePath='prop-state.png',TextureFlipbook=['grid.png','prop-state.png'])])))
    rows=json.loads((folder/'Instances.json').read_text())
    for row in rows['Instances']:
        row['Rotation']=[0,0,0,1]
        row['AmbentLightColour']=[256,256,256]
        for key in ['LightVector1','LightColour1']: row.pop(key,None)
    (folder/'Instances.json').write_text(json.dumps(rows))
    for name in ('sprites', 'wake', 'sheet', 'props'):
        folder = root / (name + '_fog')
        shutil.copytree(root / name, folder)
        (folder / 'World.json').write_text(json.dumps(dict(Schema='openslope-world/v1', Fog=dict(Start=0, End=.2, Color=[200,40,20]))))


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="openslope-appearance-") as temporary:
        root = pathlib.Path(temporary)
        fixtures(root)
        for executable in sys.argv[1:]:
            subprocess.run([executable, str(root)], check=True)
