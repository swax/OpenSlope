"""Independent authored source RGB, projected shadow and separate-rig checks."""
from pathlib import Path
import json
import struct
import subprocess
import sys
import tempfile
from avalanche_import_test import be, background, gcm, level, members, package, png_pixels, rvz


def lighting_fixture():
    world = members(scenery_format=0x29)
    geo = bytearray(world['CRS00_00.GEO'])
    palette = len(geo)
    geo.extend(bytes([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]))
    struct.pack_into('>I', geo, 0x38, palette)
    struct.pack_into('>I', geo, 0x98, 4)
    struct.pack_into('>4H', geo, 0x180 + 92, 0, 1, 2, 3)
    struct.pack_into('>I', geo, 0x18, len(geo))
    world['CRS00_00.GEO'] = bytes(geo)
    base = background('00_00')
    rig = bytearray(base['PLAYERLIGHT_00_00.LIG'])
    rig[48:56] = bytes([230, 100, 40, 255, 30, 50, 80, 255])
    struct.pack_into('>3f', rig, 72, -1, 0, 0)
    base['OBJLIGHT_00_00.LIG'] = bytes(rig)
    # A single white/grey CMPR image: each four-row band changes its selector.
    tpl = bytearray(members()['CRS00_00.TPL'])
    tpl[64:96] = (struct.pack('>HH', 0xffff, 0x4208) + bytes([0, 0x55, 0xaa, 0xff])) * 4
    shadow = bytearray(0x2040)
    struct.pack_into('>3I', shadow, 0, 32, 0x2020, 0x2040)
    struct.pack_into('>4f', shadow, 0x2020, -6000, 0, 12000, 12000)
    shadow.extend(tpl)
    base['SHAD00_00.DAT'] = bytes(shadow)
    path = package('Crs00_00', 'Normal')
    return {path: level(world), path.replace('/World/1P/Crs00_00_1P.LVL', '/Crs00_00.LVL'): level(base)}, base, world


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-avalanche-lighting-') as temporary:
        root = Path(temporary)
        source = root / 'authored.rvz'
        files, base, world = lighting_fixture()
        source.write_bytes(rvz(gcm(files), packing=True))
        def run(*args, succeeds=True):
            result = subprocess.run([str(executable), *map(str, args)], capture_output=True, text=True, timeout=120)
            assert (result.returncode == 0) == succeeds, result.stdout + result.stderr
            return result
        run('extract', source, 'AVALANCHE_CRS00_00', root / 'maps')
        output = root / 'maps/AVALANCHE_CRS00_00'
        patch = json.loads((output / 'Patches.json').read_text())['Patches'][0]
        assert patch['LightmapEncoding'] == 'rgb-multiply'
        pixels = png_pixels(output / 'Lightmaps/0000.png', 128, 128)
        def pixel(x, y):return pixels[(y * 128 + x) * 4:(y * 128 + x) * 4 + 4]
        assert pixel(0, 0) == bytes([255, 0, 0, 255]), pixel(0, 0)
        assert pixel(15, 0)[0] == 0 and pixel(15, 0)[1] > 50 and pixel(15, 0)[2] == 0
        assert pixel(0, 15)[0:2] == bytes([0, 0]) and pixel(0, 15)[2] > 50
        # Identical spatial shadow lookup and channel independent modulation.
        assert pixel(6, 8)[1] < pixel(6, 8)[2] and pixel(6, 8)[0] > 0
        metadata = json.loads((output / 'AvalancheLighting.json').read_text())
        assert metadata['ShadowTextures'] == 1 and metadata['TerrainTintedPatches'] == 1
        instances = json.loads((output / 'Instances.json').read_text())['Instances']
        visible = next(row for row in instances if row.get('Visable', True))
        assert visible['LightColour1'][0] > visible['LightColour1'][2]
        assert visible['RiderLighting']['LightColour1'][0] < visible['RiderLighting']['LightColour1'][2]
        assert json.loads((output / 'Lights.json').read_text())['Lights'][1]['Direction'] == [1.0, -0.0, 0.0]
        before = (output / 'Patches.json').read_bytes()
        for name in ['Import.json', 'AvalancheEnvironment.json']:
            path = output / name
            document = json.loads(path.read_text())
            environment = document['Environment'] if name == 'Import.json' else document
            environment['Deferred'] = ['source-shadow-map', 'source-fog']
            path.write_text(json.dumps(document))
        run('refresh-avalanche-lighting', source, 'AVALANCHE_CRS00_00', output)
        assert (output / 'LightingBackup-v1/Patches.json').read_bytes() == before
        assert (output / 'Patches.json').read_bytes() == before
        for name in ['Import.json', 'AvalancheEnvironment.json']:
            document = json.loads((output / name).read_text())
            environment = document['Environment'] if name == 'Import.json' else document
            assert environment['Deferred'] == ['dynamic-shadow-casters', 'source-fog']
        run('refresh-avalanche-lighting', source, 'AVALANCHE_CRS00_00', output)
        assert (output / 'LightingBackup-v1/Patches.json').read_bytes() == before
        # Bad source must fail before modifying an existing map or publishing a new one.
        shadow = bytearray(base['SHAD00_00.DAT'])
        struct.pack_into('>H', shadow, 32, 2)
        base['SHAD00_00.DAT'] = bytes(shadow)
        path = package('Crs00_00', 'Normal')
        files = {path: level(world), path.replace('/World/1P/Crs00_00_1P.LVL', '/Crs00_00.LVL'): level(base)}
        source.write_bytes(rvz(gcm(files)))
        run('extract', source, 'AVALANCHE_CRS00_00', root / 'failed', succeeds=False)
        assert not (root / 'failed/AVALANCHE_CRS00_00').exists()
        run('refresh-avalanche-lighting', source, 'AVALANCHE_CRS00_00', output, succeeds=False)
        assert (output / 'Patches.json').read_bytes() == before
        assert not list(output.glob('.openslope-lighting-*'))
    print('PASS: source RGB corners, coloured shadow projection, rig separation, stable refresh/backup and malformed input rollback')


if __name__ == '__main__':
    main()
