"""Authored GameCube/RVZ -> Avalanche maps; no retail data or decoder packages."""
from pathlib import Path
import hashlib
import json
import math
import struct
import subprocess
import sys
import tempfile
import zlib


def be(value):
    return struct.pack('>I', value)


def level(files):
    directory = b'CONTENTS_FLAG'.ljust(32) + be(2) + b'NAME_LEN_MAX'.ljust(32) + be(32)
    for name, data in files.items():
        directory += name.encode().ljust(32, b'\0') + be(len(data))
    payloads = list(files.values()) + [directory]
    out = bytearray(be(len(payloads)))
    at = (4 + (len(payloads) + 1) * 4 + 31) // 32 * 32
    offsets = []
    body = bytearray()
    for data in payloads:
        offsets.append(at + len(body))
        body.extend(data)
        body.extend(bytes((-len(body)) % 32))
    offsets.append(at + len(body))
    out.extend(b''.join(be(i) for i in offsets))
    out.extend(bytes(at-len(out)))
    return bytes(out+body)


COURSES = [(f'Crs{family:02}_{variant:02}', difficulty)
    for family in range(7) for variant, difficulty in enumerate(('Normal', 'Hard', 'Expert', 'Diamond'))
    if not (family == 0 and variant in (1, 2) or family == 6 and variant == 1)]


def package(stem, difficulty):
    return f'1080Data/LevelData_LVL/Course/{stem[:5]}/{difficulty}/World/1P/{stem}_1P.LVL'


TERRAIN_UVS = [
    ((0, 0), (1024, 0), (0, 1024), (1024, 1024)),
    ((1024, 0), (1024, 1024), (0, 0), (0, 1024)),
    ((1024, 1024), (0, 1024), (1024, 0), (0, 0)),
    ((0, 1024), (0, 0), (1024, 1024), (1024, 0)),
    ((1024, 0), (0, 0), (1024, 1024), (0, 1024)),
    ((0, 1024), (1024, 1024), (0, 0), (1024, 0)),
    ((0, 0), (0, 1024), (1024, 0), (1024, 1024)),
    ((1024, 1024), (1024, 0), (0, 1024), (0, 0)),
    ((512, 0), (1024, 0), (512, 1024), (1024, 1024)),
    ((-2048, 3072), (1024, 3072), (-2048, 5120), (1024, 5120)),
    ((1, 478), (55, 474), (981, 3), (13, 0)),
]


def portable_uvs(corners):
    # Portable UV corners bind to source controls 0,12,3,15 after the X reflection.
    return [[corners[i][0]/1024, corners[i][1]/1024] for i in (0, 2, 1, 3)]


def visible_world(output):
    models=json.loads((output/'Models.json').read_text())['Models']
    rows=[]
    for instance in json.loads((output/'Instances.json').read_text())['Instances']:
        if not instance.get('Visable',True):continue
        for ob in models[instance['ModelID']]['ModelObjects']:
            for sub in ob['MeshData']:
                for line in (output/'Meshes'/sub['MeshPath']).read_text().splitlines():
                    if line.startswith('v '):rows.append([x+y for x,y in zip(map(float,line.split()[1:]),instance['Location'])])
    return rows


def members(stem='CRS00_00', scenery_format=None, terrain_uvs=None):
    geo = bytearray(0x260)
    for at, value in [(0, 0x10002), (4, 0x2011), (0x18, len(geo)), (0x28, 0x180), (0x30, 0x120), (0x88, 1), (0x90, 16)]:
        struct.pack_into('>I', geo, at, value)
    struct.pack_into('>12f', geo, 0xe4, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0)
    for u in range(4):
        for v in range(4):
            # A broad sloping, mildly curved sheet. Quantized positions are independent of retail data.
            i = u*4+v
            step = 1 if stem == 'CRS00_00' else 2
            struct.pack_into('>3h', geo, 0x120+i*6, -6000+u*4000, 3000-v*500*step, v*4000*step)
            struct.pack_into('>I', geo, 0x180+28+i*4, i)
    geo[0x210:0x210+13] = b'MatNameListV2'
    struct.pack_into('>I', geo, 0x220, 1)
    geo[0x224:0x224+4] = b'Snow'
    struct.pack_into('>I', geo, 0x3c, 0x240); struct.pack_into('>I', geo, 0x9c, 4)
    geo[0x180+100:0x180+132] = bytes([255])*32
    for index, corner in enumerate((0, 3, 12, 15)):
        struct.pack_into('>H', geo, 0x180+100+corner*2, index)
        struct.pack_into('>2h', geo, 0x240+index*4, *(terrain_uvs or TERRAIN_UVS[0])[index])
    if scenery_format is not None:
        # Independent GX triangle: optional colour/normal indices and zero to four extra UV sets.
        positions = bytes(geo[0x120:0x180])+b''.join(struct.pack('>3h', *p)
            for p in [(0, 500, 3000), (100, 500, 3000), (0, 600, 3000)])
        at = len(geo); geo.extend(positions)
        struct.pack_into('>II', geo, 0x8c, 0, 19)
        struct.pack_into('>I', geo, 0x30, at)
        row = len(geo); geo.extend(bytes(40))
        struct.pack_into('>I', geo, 0x20, row); struct.pack_into('>I', geo, 0x80, 1)
        uv = len(geo); geo.extend(struct.pack('>8h', 0, 0, 1024, 0, 0, 1024, 1024, 1024))
        geo.extend(bytes(geo[0x240:0x250]))
        for index, corner in enumerate((0, 3, 12, 15)):
            struct.pack_into('>H', geo, 0x180+100+corner*2, index+4)
        struct.pack_into('>I', geo, 0x3c, uv); struct.pack_into('>I', geo, 0x9c, 8)
        descriptor = len(geo); geo.extend(bytes(12))
        draw = bytearray(b'\x90\0\3')
        for i in range(3):
            indices = [16+i]+([0] if scenery_format & 2 else [])+[0]
            indices += ([i] if scenery_format & 0x20 else [])+[0]*(scenery_format >> 6).bit_count()
            draw.extend(b''.join(struct.pack('>H', index) for index in indices))
        draw.extend(bytes((-len(draw)) % 32))
        struct.pack_into('>HHII', geo, descriptor, 65535 if scenery_format == 9 else 0, len(draw)//32, scenery_format, len(geo))
        struct.pack_into('>II', geo, row+28, descriptor, 0)
        struct.pack_into('>I', geo, row+36, 0x10000)
        geo.extend(draw)
        struct.pack_into('>I', geo, 0x38, len(geo)); struct.pack_into('>I', geo, 0x98, 1)
        geo.extend(bytes([35, 130, 220, 255]))
        struct.pack_into('>I', geo, 0x18, len(geo))
    mtl = bytearray(0x140)
    struct.pack_into('>I', mtl, 0, 0x80)
    struct.pack_into('>II', mtl, 0x38, 1, 1)
    struct.pack_into('>H', mtl, 0x80+148, 0)
    tpl = bytearray(0x60)
    struct.pack_into('>IIIII', tpl, 0, 0x20af30, 1, 12, 20, 0)
    struct.pack_into('>HHII', tpl, 20, 8, 8, 14, 64)
    # Four BC1/CMPR blocks; each row exercises both endpoints and both interpolants.
    tpl[64:96] = (struct.pack('>HH', 0xf800, 0x07e0)+bytes([0x1b]*4))*4
    col = bytearray(0x90+64+72)
    struct.pack_into('>6I', col, 32, 0x90, 0xd0, 2, 6, len(col), len(col))
    struct.pack_into('>II', col, 0x50, 0x60, 1)
    struct.pack_into('>II10f', col, 0x60, 0x27404, 0, -3500, 2000, 2000, -3500, 4000, 2000, 100, 1, 0, 0)
    struct.pack_into('>3I', col, 0x90, 0, 1, 2)
    struct.pack_into('>4I', col, 0xb0, 3, 5, 4, 0x01610000) # Literal 'a': rideable snow floor.
    for i, vertex in enumerate([(1500, 0, 2000), (1500, 4000, 2000), (1500, 0, 6000),
                                (13000, 0, 0), (16000, 0, 0), (13000, 0, 4000)]):
        struct.pack_into('>3f', col, 0xd0+i*12, *vertex)
    return {stem+'.GEO': bytes(geo), stem+'.MTL': bytes(mtl), stem+'.TPL': bytes(tpl), stem+'.COL': bytes(col)}


def background(suffix):
    files = members('BG'+suffix, 0x6b)
    geo = bytearray(files['BG'+suffix+'.GEO'])
    row = int.from_bytes(geo[0x20:0x24], 'big')
    descriptor = int.from_bytes(geo[row+28:row+32], 'big')
    draw = int.from_bytes(geo[descriptor+8:descriptor+12], 'big')
    # Texture + three vertex tints, including coverage, must survive the portable sky bake.
    palette = len(geo); geo.extend(bytes([255,255,255,255, 80,120,255,255, 255,255,255,0]))
    struct.pack_into('>I', geo, 0x38, palette)
    struct.pack_into('>I', geo, 0x98, 3)
    for i in range(3):
        struct.pack_into('>3H', geo, draw+3+i*10+4, i, 0, i)
    if suffix in ('00_00', '06_00'):
        # Some backgrounds store normalized float3 positions with the same scale matrix.
        positions = int.from_bytes(geo[0x30:0x34], 'big')
        count = int.from_bytes(geo[0x90:0x94], 'big')
        points = [struct.unpack_from('>3h', geo, positions+i*6) for i in range(count)]
        struct.pack_into('>II', geo, 0, 0x10003, 0x2011)
        struct.pack_into('>I', geo, 0x30, len(geo))
        for point in points: geo.extend(struct.pack('>3f', *point))
    struct.pack_into('>I', geo, 0x18, len(geo))
    files['BG'+suffix+'.GEO'] = bytes(geo)
    files.pop('BG'+suffix+'.COL')
    original = files['BG'+suffix+'.TPL']
    tpl = bytearray(192)
    struct.pack_into('>7I', tpl, 0, 0x20af30, 2, 12, 28, 0, 64, 0)
    struct.pack_into('>HH6I', tpl, 28, 8, 8, 0, 128, 1, 1, 0, 0)
    struct.pack_into('>HH6I', tpl, 64, 8, 8, 14, 160, 1, 1, 0, 0)
    tpl[128:160] = bytes([255])*32
    tpl[160:192] = original[64:96]
    if suffix == '04_03':
        tpl.extend(bytes(32))
        struct.pack_into('>I',tpl,68,1) # White stage + I8 cloud coverage.
        tpl[160:224] = bytes([128])*64
    files['BG'+suffix+'.TPL'] = bytes(tpl)
    mtl = bytearray(files['BG'+suffix+'.MTL'])
    struct.pack_into('>I',mtl,0x3c,2); mtl[0x80] = 2
    struct.pack_into('>2H',mtl,0x80+148,0,1)
    files['BG'+suffix+'.MTL'] = bytes(mtl)
    rig = bytearray(192); struct.pack_into('>I', rig, 0, 1)
    struct.pack_into('>I', rig, 32, 0x10003)
    rig[48:56] = bytes([80,100,140,255, 120,140,180,255])
    struct.pack_into('>3f', rig, 72, 0, -1, 0)
    files['PLAYERLIGHT_'+suffix+'.LIG'] = bytes(rig)
    files['PTCL'+suffix+'.TPL'] = original
    return files


def with_material_srt(files, values, flags=0, animated=False):
    """Authored 56-byte matrix route -> 244-byte key track -> five-float SRT."""
    files = dict(files)
    name = next(name for name in files if name.endswith('.MTL'))
    mtl = bytearray(files[name]); mat = int.from_bytes(mtl[:4], 'big')
    mtl[mat+1] = 1
    struct.pack_into('>I', mtl, mat+20, 0x007d3c41)
    struct.pack_into('>2h', mtl, mat+28, 0, -1)
    route = len(mtl); mtl.extend(bytes(56))
    struct.pack_into('>3h', mtl, route+50, -1, -1, 0)
    track = len(mtl); mtl.extend(bytes(244))
    mtl[track+50:track+52] = bytes([flags, 2 if animated else 1])
    if animated: struct.pack_into('>2H', mtl, track+56, 60, 1)
    table = len(mtl); mtl.extend(struct.pack('>5f', *values))
    if animated: mtl.extend(struct.pack('>5f', 1, 1, 0, 0, math.pi))
    for offset, value in [(0x1c,route), (0x54,1), (0x10,track), (0x48,1), (8,table), (0x40,2 if animated else 1)]:
        struct.pack_into('>I',mtl,offset,value)
    files[name] = bytes(mtl)
    return files


def with_scenery_nodes():
    """A shared template, two translations, a sheared/reflected placement and a baked chunk."""
    files = members(scenery_format=0x29)
    geo = bytearray(files['CRS00_00.GEO'])
    old_row = int.from_bytes(geo[0x20:0x24], 'big')
    row = bytearray(geo[old_row:old_row+40])
    struct.pack_into('>6f', row, 0, 0, 500, 3000, 100, 600, 3000)
    rows = len(geo)
    struct.pack_into('>I', row, 36, 0x10001); geo.extend(row)
    struct.pack_into('>I', row, 36, 0x10000); geo.extend(row)
    struct.pack_into('>I', geo, 0x20, rows); struct.pack_into('>I', geo, 0x80, 2)
    nodes = len(geo)
    for i in range(4):
        node = bytearray(80)
        basis = (-1,.5,0,3000, 0,1,0,0, 0,0,1,0) if i==2 else (1,0,0,1000*(i+1), 0,1,0,0, 0,0,1,0)
        struct.pack_into('>12f', node, 0, *basis)
        struct.pack_into('>H', node, 64, 65535 if i==3 else 0)
        geo.extend(node)
    struct.pack_into('>I', geo, 0x6c, nodes); struct.pack_into('>I', geo, 0xcc, 4)
    terrain = len(geo)
    geo.extend(geo[0x180:0x210]); geo.extend(geo[0x210:0x23c])
    geo.extend(b'ObjNameListV2'.ljust(16,b'\0')+be(2))
    for name, identifier in [('TestTemplate',9),('StaticChunk',19)]:
        geo.extend(name.encode().ljust(20,b'\0')+be(identifier))
    struct.pack_into('>I', geo, 0x28, terrain)
    struct.pack_into('>I', geo, 0x18, len(geo))
    files['CRS00_00.GEO'] = bytes(geo)
    return files


def with_baked_props():
    """Two disconnected material islands in ONE chunk, with a cross-material UV seam."""
    files=members(scenery_format=0x29);geo=bytearray(files['CRS00_00.GEO'])
    original=int.from_bytes(geo[0x30:0x34],'big');positions=bytes(geo[original:original+19*6])
    at=len(geo);geo.extend(positions)
    for p in [(2000,500,3000),(2100,500,3000),(2000,600,3000),
              (0,500,3000),(0,600,3000),(-100,500,3000)]:geo.extend(struct.pack('>3h',*p))
    struct.pack_into('>I',geo,0x30,at);struct.pack_into('>I',geo,0x90,25)
    row=int.from_bytes(geo[0x20:0x24],'big');old_desc=int.from_bytes(geo[row+28:row+32],'big')
    descriptors=len(geo);geo.extend(geo[old_desc:old_desc+12]);geo.extend(bytes(24))
    draw=len(geo);geo.extend(b'\x90\0\3'+b''.join(struct.pack('>3H',19+i,0,i) for i in range(3))+bytes(11))
    struct.pack_into('>HHII',geo,descriptors+12,1,1,0x29,draw)
    struct.pack_into('>I',geo,row+28,descriptors);struct.pack_into('>I',geo,row+36,0x20000)
    draw=len(geo);geo.extend(b'\x90\0\3'+b''.join(struct.pack('>3H',22+i,0,i) for i in range(3))+bytes(11))
    struct.pack_into('>HHII',geo,descriptors+24,2,1,0x29,draw)
    rows=len(geo);geo.extend(geo[row:row+40]);geo.extend(geo[row:row+40])
    struct.pack_into('>I',geo,rows+40+28,descriptors+24);struct.pack_into('>I',geo,rows+40+36,0x10000)
    struct.pack_into('>I',geo,0x20,rows);struct.pack_into('>I',geo,0x80,2)
    terrain=len(geo);geo.extend(geo[0x180:0x210]);geo.extend(b'MatNameListV2'.ljust(16,b'\0')+be(3))
    for name in ['Wood','Leaves','Metal']:geo.extend(name.encode().ljust(20,b'\0')+be(0))
    struct.pack_into('>I',geo,0x28,terrain);struct.pack_into('>I',geo,0x18,len(geo))
    files['CRS00_00.GEO']=bytes(geo)
    mtl=bytearray(files['CRS00_00.MTL']);entry=mtl[0x80:0x80+164];mtl=mtl[:0x80]+entry+entry+entry
    struct.pack_into('>I',mtl,0x38,3);files['CRS00_00.MTL']=bytes(mtl)
    return files


def course_packages():
    formats = [0x29, 0x69, 0xe9, 0x1e9, 0x3e9, 0x2b, 0x6b, 0xeb]
    result = {}
    for index, (stem, difficulty) in enumerate(COURSES):
        fmt = formats[(index - 1 if index > 1 else 0) % len(formats)]
        if stem == 'Crs01_00': fmt = 9
        files = members(stem.upper(), fmt, TERRAIN_UVS[index % len(TERRAIN_UVS)])
        if stem.startswith('Crs02'):
            key = stem.upper()+'.GEO'; geo = bytearray(files[key])
            geo[0x224:0x224+15] = b'*CF_b01*Draw'.ljust(15,b'\0')
            files[key] = bytes(geo)
        result[package(stem, difficulty)] = level(files)
        result[package(stem, difficulty).replace('/World/1P/'+stem+'_1P.LVL', '/'+stem+'.LVL')] = level(background(stem[3:]))
    result['1080Data/Misc/spray.tpl'] = members()['CRS00_00.TPL']
    return result


def gcm(files):
    tree = {}
    for path, data in files.items():
        node = tree
        parts = path.split('/')
        for directory in parts[:-1]:
            node = node.setdefault(directory, {})
        node[parts[-1]] = data
    entries, strings, content = [], bytearray(b'\0'), bytearray()
    def walk(name, node, parent):
        i = len(entries)
        string = len(strings)
        strings.extend(name.encode()+b'\0')
        entries.append(None)
        if isinstance(node, dict):
            for key, value in sorted(node.items()):
                walk(key, value, i)
            entries[i] = [0x1000000 | string, parent, len(entries)]
        else:
            entries[i] = [string, 0x8000+len(content), len(node)]
            content.extend(node)
            content.extend(bytes((-len(content)) % 32))
    walk('', tree, 0)
    entries[0][0] = 0x1000000
    fst = b''.join(struct.pack('>3I', *e) for e in entries)+strings
    assert len(fst) < 0x7000
    data = bytearray(0x8000)
    data[:6] = b'GTEE01'
    struct.pack_into('>I', data, 0x1c, 0xc2339f3d)
    struct.pack_into('>II', data, 0x424, 0x1000, len(fst))
    data[0x1000:0x1000+len(fst)] = fst
    return bytes(data+content)


def zstd_frame(data):
    # Standard Zstandard single-segment frame with authored raw blocks.
    result = b'\x28\xb5\x2f\xfd\xa0'+struct.pack('<I', len(data))
    blocks = [data[i:i+131071] for i in range(0, len(data), 131071)] or [b'']
    for i, block in enumerate(blocks):
        result += ((len(block) << 3) | int(i+1 == len(blocks))).to_bytes(3, 'little')+block
    return result


def rvz(data, compression=5, packing=False, conflicting_group=False):
    chunk = 32768
    groups = [data[i:i+chunk] for i in range(0, len(data), chunk)]
    out = bytearray(0x200)
    records = []
    for group in groups:
        packed = be(len(group))+group if packing else group
        encoded = zstd_frame(packed) if compression == 5 else packed
        records.append(struct.pack('>3I', len(out)//4, len(encoded) | (0x80000000 if compression else 0), len(packed) if packing else 0))
        out.extend(encoded)
        out.extend(bytes((-len(out)) % 4))
    raw = struct.pack('>QQII', 128, len(data)-128, 0, len(groups))
    if conflicting_group:
        assert chunk < len(data) < chunk*2
        raw = struct.pack('>QQII', 128, chunk-128, 0, 1)+struct.pack('>QQII', chunk, len(data)-chunk, 0, 1)
    table = b''.join(records)
    raw = zstd_frame(raw) if compression else raw
    table = zstd_frame(table) if compression else table
    raw_at = len(out)
    out.extend(raw)
    group_at = len(out)
    out.extend(table)
    desc = bytearray(0xdc)
    struct.pack_into('>4I', desc, 0, 1, compression, 0, chunk)
    desc[16:144] = data[:128]
    struct.pack_into('>IQI', desc, 0xb4, 2 if conflicting_group else 1, raw_at, len(raw))
    struct.pack_into('>IQI', desc, 0xc4, len(groups), group_at, len(table))
    head = b'RVZ\x01'+struct.pack('>III', 0x1000000, 0x30000, len(desc))+hashlib.sha1(desc).digest()+struct.pack('>QQ', len(data), len(out))
    head += hashlib.sha1(head).digest()
    out[:len(head)] = head
    out[0x48:0x48+len(desc)] = desc
    return out


def png_pixels(path, width=8, height=8):
    data = path.read_bytes(); at = 8; compressed = bytearray()
    while at < len(data):
        size = int.from_bytes(data[at:at+4], 'big'); tag = data[at+4:at+8]
        if tag == b'IDAT': compressed.extend(data[at+8:at+8+size])
        at += size+12
    scan = zlib.decompress(compressed)
    stride = width*4+1
    assert all(scan[y*stride] == 0 for y in range(height))
    return b''.join(scan[y*stride+1:(y+1)*stride] for y in range(height))


def main():
    executable, queries = (Path(p).resolve() for p in sys.argv[1:3])
    path = '1080Data/LevelData_LVL/Course/Crs00/Normal/World/1P/Crs00_00_1P.LVL'
    def run(*args, succeeds=True):
        result = subprocess.run([str(executable), *map(str,args)], capture_output=True, text=True, timeout=60)
        assert (result.returncode == 0) == succeeds, result.stdout+result.stderr
        return result.stdout+result.stderr
    with tempfile.TemporaryDirectory(prefix='openslope-avalanche-') as temporary:
        root = Path(temporary); files = members(); image = gcm({path:level(files)})
        for i, data in enumerate([image, rvz(image), rvz(image, 0), rvz(image, packing=True)]):
            source = root/f'fixture-{i}.rvz'; source.write_bytes(data)
            assert 'AVALANCHE_CRS00_00' in run('list', source)
            maps = root/f'Maps-{i}'
            run('extract', source, 'AVALANCHE_CRS00_00', maps)
            output = maps/'AVALANCHE_CRS00_00'
            terrain = json.loads((output/'Patches.json').read_text())['Patches']
            assert len(terrain) == 1 and terrain[0]['Points'][0] == [6000, 0, 3000]
            assert terrain[0]['Points'][1] == [6000, -4000, 2500], 'Reflect X and retain the source control tensor'
            assert terrain[0]['UVPoints'] == portable_uvs(TERRAIN_UVS[0]), 'UV corners must stay attached to geometry'
            report = json.loads((output/'Import.json').read_text())
            assert report['TrunkProxies'] == 1 and report['CollisionTriangles'] == 46
            assert report['RideableSnowTriangles'] == 1
            rgba = png_pixels(output/'Textures/ava-0.png')
            assert rgba[:16] == bytes([255,0,0,255, 0,255,0,255, 170,85,0,255, 85,170,0,255])
            expected_uv = root/'expected-uv.json'
            expected_uv.write_text(json.dumps([portable_uvs(TERRAIN_UVS[0])]))
            subprocess.run([str(queries), str(output), str(expected_uv)], check=True, timeout=60)
            before = (output/'Patches.json').read_bytes()
            run('extract', source, 'AVALANCHE_CRS00_00', maps, succeeds=False)
            assert (output/'Patches.json').read_bytes() == before
        source = root/'bad.rvz'
        data = rvz(image); data[0x10] ^= 1; source.write_bytes(data)
        assert 'checksum' in run('list', source, succeeds=False)
        source.write_bytes(rvz(image)[:-4]); run('list', source, succeeds=False)
        source.write_bytes(rvz(image, conflicting_group=True))
        assert 'shared group lengths' in run('extract', source, 'AVALANCHE_CRS00_00', root/'conflicting', succeeds=False)
        assert not (root/'conflicting'/'AVALANCHE_CRS00_00').exists()
        bad_files = members(); geo = bytearray(bad_files['CRS00_00.GEO']); struct.pack_into('>I',geo,0x180+28,999999)
        bad_files['CRS00_00.GEO'] = bytes(geo)
        source.write_bytes(rvz(gcm({path:level(bad_files)})))
        run('extract', source, 'AVALANCHE_CRS00_00', root/'failed', succeeds=False)
        assert not list((root/'failed').iterdir())
        bad_files = members(); geo = bytearray(bad_files['CRS00_00.GEO'])
        struct.pack_into('>H',geo,0x180+100+3*2,65535)
        bad_files['CRS00_00.GEO'] = bytes(geo)
        source.write_bytes(rvz(gcm({path:level(bad_files)})))
        assert 'terrain UV index' in run('extract', source, 'AVALANCHE_CRS00_00', root/'bad-uv', succeeds=False)
        assert not list((root/'bad-uv').iterdir())
        source.write_bytes(rvz(image)); run('extract', source, 'AVALANCHE_CRS01_00', root/'unsupported', succeeds=False)
        assert not list((root/'unsupported').iterdir())
        source.write_bytes(rvz(gcm(course_packages()), packing=True))
        listed = run('list', source).splitlines()
        expected = ['AVALANCHE_'+stem.upper() for stem, _ in COURSES]
        assert [line.split()[0] for line in listed] == expected, listed
        for course_index, course in enumerate(expected):
            run('extract', source, course, root/'batch')
            output = root/'batch'/course
            report = json.loads((output/'Import.json').read_text())
            terrain = json.loads((output/'Patches.json').read_text())['Patches']
            assert terrain[0]['UVPoints'] == portable_uvs(TERRAIN_UVS[course_index % len(TERRAIN_UVS)]), 'Source rotations, mirrors, crops, repeats and fractional UVs must survive'
            assert report['SceneryTriangles'] == 1 and report['Course'] == course
            environment = report['Environment']
            assert environment['Available'] and environment['SkyTriangles'] == 1 and environment['RidingSpraySheet']
            assert len(environment['ParticleTextures']) == 1
            assert (output/'Lights.json').is_file() and (output/'Lightmaps/0000.png').is_file()
            lighting = png_pixels(output/'Lightmaps/0000.png',128,128)
            assert lighting[3] == 255 and lighting[0] < lighting[2], 'Source lighting must retain RGB instead of grey alpha'
            assert terrain[0]['LightmapEncoding'] == 'rgb-multiply'
            atlas = png_pixels(output/'Skybox/Textures/ava-gradient-0.png',512,512)
            sky_mesh = next((output/'Skybox/Meshes').glob('*.obj')).read_text()
            assert 'v 0 -3000 500' in sky_mesh, 'Short3 and float3 sky positions must share the portable coordinate frame'
            assert atlas[:4] == (bytes([255,255,255,128]) if course == 'AVALANCHE_CRS04_03' else bytes([255,0,0,255])), atlas[:4]
            assert atlas[20*4+1] > 100, 'White first stage must select the second image and second UV stream'
            assert atlas[(31*512)*4+3] == 0, 'Sky vertex coverage must survive texture modulation'
            spray = png_pixels(output/'Textures/Particles/ava-spray.png')
            assert spray[:4] == bytes([255,255,255,255]) and spray[11] == 170, spray[:12]
            if course != 'AVALANCHE_CRS00_00':
                assert report['SpawnPolicy'] == 'supported-snow-corridor-128m'
            mesh = next((output/'Meshes').glob('*.obj')).read_text()
            assert [0,-3000,500] in visible_world(output), mesh
            if course == 'AVALANCHE_CRS01_00':
                assert 'vt 0.5 0.5' in mesh and (output/'Textures/ava-colour-0.png').is_file()
                assert png_pixels(output/'Textures/ava-colour-0.png', 1, 1) == bytes([35, 130, 220, 255])
            else:
                assert 'vt 1 1' in mesh, mesh
            expected_uv.write_text(json.dumps([portable_uvs(TERRAIN_UVS[course_index % len(TERRAIN_UVS)])]))
            subprocess.run([str(queries), str(output), str(expected_uv)], check=True, timeout=60)
        run('extract', source, 'AVALANCHE_CRS07_00', root/'unknown', succeeds=False)
        assert not list((root/'unknown').iterdir())
        # Discovery does not depend on the original halfpipe being present.
        files = course_packages(); del files[package('Crs00_00', 'Normal')]
        source.write_bytes(rvz(gcm(files), packing=True))
        assert len(run('list', source).splitlines()) == 24
        # A narrow isolated snow sheet is not a safe start for the new layouts.
        files = members('CRS01_00'); geo = bytearray(files['CRS01_00.GEO'])
        for i in range(16):
            struct.pack_into('>h', geo, 0x120+i*6+2, 3000-(i%4)*5)
            struct.pack_into('>h', geo, 0x120+i*6+4, (i%4)*50)
        files['CRS01_00.GEO'] = bytes(geo)
        source.write_bytes(rvz(gcm({package('Crs01_00','Normal'):level(files)})))
        assert 'starting runout' in run('extract',source,'AVALANCHE_CRS01_00',root/'unsafe',succeeds=False)
        assert not list((root/'unsafe').iterdir())
        # A present environment package must not hide a corrupt rig behind the legacy no-environment fallback.
        files = course_packages()
        base = background('00_00'); base['PLAYERLIGHT_00_00.LIG'] = bytes(192)
        files['1080Data/LevelData_LVL/Course/Crs00/Normal/Crs00_00.LVL'] = level(base)
        source.write_bytes(rvz(gcm(files)))
        assert 'light rig' in run('extract', source, 'AVALANCHE_CRS00_00', root/'bad-light', succeeds=False)
        assert not list((root/'bad-light').iterdir())
        # Affine material SRT is distinct from the GEO corner indices. Check
        # ground and model draw UVs, plus first-key freezing of animated tracks.
        cases = [
            ((1,1,0,0,0),0,[[0,1],[1,1],[0,0],[1,0]]),
            ((1,1,0,0,math.pi/2),0,[[1,1],[1,0],[0,1],[0,0]]),
            ((1,1,0,0,-math.pi/2),0,[[0,0],[0,1],[1,0],[1,1]]),
            ((1,1,0,0,math.pi),0,[[1,0],[0,0],[1,1],[0,1]]),
            ((-1,1,0,0,0),0,[[1,1],[0,1],[1,0],[0,0]]),
            ((2,.5,.25,-.25,0),0,[[-1, .625],[1,.625],[-1,.125],[1,.125]]),
            ((1,1,0,0,0),0xc0,[[0,1],[2,1],[0,-1],[2,-1]]),
        ]
        for case, (values,flags,wanted) in enumerate(cases):
            wanted = [wanted[i] for i in (0,2,1,3)]
            files = with_material_srt(members(scenery_format=0x29),values,flags,animated=True)
            source.write_bytes(rvz(gcm({path:level(files)})))
            run('extract',source,'AVALANCHE_CRS00_00',root/f'srt-{case}')
            output=root/f'srt-{case}'/'AVALANCHE_CRS00_00'
            actual=json.loads((output/'Patches.json').read_text())['Patches'][0]['UVPoints']
            assert all(abs(a-b)<1e-6 for p,q in zip(actual,wanted) for a,b in zip(p,q)), (actual,wanted)
            report=json.loads((output/'Import.json').read_text())
            assert report['MaterialUVTransforms']==1 and report['AnimatedMaterialUVsFrozen']==1
            expected_uv.write_text(json.dumps([wanted]))
            subprocess.run([str(queries),str(output),str(expected_uv)],check=True,timeout=60)
            mesh=next((output/'Meshes').glob('*.obj')).read_text()
            draw=[list(map(float,line.split()[1:])) for line in mesh.splitlines() if line.startswith('vt ')]
            assert all(abs(a-b)<1e-6 for p,q in zip(draw,[wanted[0],wanted[1],wanted[2]]) for a,b in zip(p,[q[0],1-q[1]])),draw
        files=members(scenery_format=0x29);geo=bytearray(files['CRS00_00.GEO'])
        geo[0x224:0x224+15]=b'parking_backwar';files['CRS00_00.GEO']=bytes(geo)
        source.write_bytes(rvz(gcm({path:level(files)})))
        run('extract',source,'AVALANCHE_CRS00_00',root/'readable-sign')
        output=root/'readable-sign'/'AVALANCHE_CRS00_00'
        mesh=next((output/'Meshes').glob('*.obj')).read_text()
        assert [list(map(float,line.split()[1:])) for line in mesh.splitlines() if line.startswith('vt ')]==[[0,1],[0,0],[1,1]], 'Sign UVs require no special-case repair after the world handedness conversion'
        assert [-100,-3000,500] in visible_world(output) and 'f 1/1 2/2 3/3' in mesh
        assert (output/'Textures/ava-0.png').read_bytes()==(root/'Maps-0/AVALANCHE_CRS00_00/Textures/ava-0.png').read_bytes()
        assert json.loads((output/'Patches.json').read_text())['Patches'][0]['UVPoints']==portable_uvs(TERRAIN_UVS[0])
        source.write_bytes(rvz(gcm({path:level(with_scenery_nodes())})))
        run('extract',source,'AVALANCHE_CRS00_00',root/'separate-props')
        output=root/'separate-props'/'AVALANCHE_CRS00_00'
        models=json.loads((output/'Models.json').read_text())['Models']
        instances=[i for i in json.loads((output/'Instances.json').read_text())['Instances'] if i.get('Visable',True)]
        nodes={i['SourcePlacementIndex']:i for i in instances if 'SourcePlacementIndex' in i}
        assert len(instances)==4 and len(nodes)==3
        assert nodes[0]['ModelID']==nodes[1]['ModelID']!=nodes[2]['ModelID'], 'Share exact template/basis pairs; preserve shear separately'
        assert models[nodes[0]['ModelID']]['ModelName']=='TestTemplate'
        assert [nodes[i]['Location'] for i in range(3)]==[[-1000,0,0],[-2000,0,0],[-3000,0,0]]
        static=next(i for i in instances if 'SourcePlacementIndex' not in i)
        assert static['Location']==[-50,-3000,550], 'Baked chunks need a useful editable local pivot'
        assert models[static['ModelID']]['SourceObjects']==[1]
        expected={0:[[-1000,-3000,500],[-1100,-3000,500],[-1000,-3000,600]],
                  1:[[-2000,-3000,500],[-2100,-3000,500],[-2000,-3000,600]],
                  2:[[-3250,-3000,500],[-3150,-3000,500],[-3300,-3000,600]],
                  None:[[0,-3000,500],[-100,-3000,500],[0,-3000,600]]}
        for inst in instances:
            mesh=models[inst['ModelID']]['ModelObjects'][0]['MeshData'][0]['MeshPath']
            points=[list(map(float,line.split()[1:])) for line in (output/'Meshes'/mesh).read_text().splitlines() if line.startswith('v ')]
            world=[[x+y for x,y in zip(p,inst['Location'])] for p in points]
            assert sorted(world)==sorted(expected[inst.get('SourcePlacementIndex')]), world
        assert json.loads((output/'Import.json').read_text())['SceneryTriangles']==4
        subprocess.run([str(queries),str(output)],check=True,timeout=60)
        files=with_scenery_nodes();geo=bytearray(files['CRS00_00.GEO'])
        names=int.from_bytes(geo[0x28:0x2c],'big')+144+44
        struct.pack_into('>I',geo,names+16,3);files['CRS00_00.GEO']=bytes(geo)
        source.write_bytes(rvz(gcm({path:level(files)})))
        assert 'object name count' in run('extract',source,'AVALANCHE_CRS00_00',root/'bad-objects',succeeds=False)
        assert not list((root/'bad-objects').iterdir())
        source.write_bytes(rvz(gcm({path:level(with_baked_props())})))
        run('extract',source,'AVALANCHE_CRS00_00',root/'baked-props')
        output=root/'baked-props'/'AVALANCHE_CRS00_00'
        models=json.loads((output/'Models.json').read_text())['Models'][1:]
        assert len(models)==2,'Disconnected props in one source chunk must become individual models'
        wood=next(m for m in models if 'wood' in m['ModelName'])
        leaf=next(m for m in models if 'leaves' in m['ModelName'])
        assert wood['PlacementDefaults']['nativeCollision']['playerCollision'] is True
        assert wood['SourceObjects']==[0,1], 'Weld connected geometry across both material seams and source chunk boundaries'
        assert leaf['PlacementDefaults']['nativeCollision']['mode']==0 and 'PlacementCollisionPath' not in leaf
        assert (output/'Collision'/wood['PlacementCollisionPath']).is_file()
        assert sorted(visible_world(output))==sorted([[0,-3000,500],[-100,-3000,500],[0,-3000,600],[-2000,-3000,500],[-2100,-3000,500],[-2000,-3000,600],[0,-3000,500],[0,-3000,600],[100,-3000,500]])
        subprocess.run([str(queries),str(output)],check=True,timeout=60)
        # A whole tree can retain leaf geometry while a source cylinder supplies only trunk contact.
        files=with_scenery_nodes();geo=bytearray(files['CRS00_00.GEO'])
        names=int.from_bytes(geo[0x28:0x2c],'big')+144
        geo[names+20:names+40]=b'Branch'.ljust(20,b'\0');files['CRS00_00.GEO']=bytes(geo)
        col=bytearray(files['CRS00_00.COL']);struct.pack_into('>II10f',col,0x60,0x27404,0,1050,500,3000,1050,600,3000,10,1,0,0)
        files['CRS00_00.COL']=bytes(col);source.write_bytes(rvz(gcm({path:level(files)})))
        run('extract',source,'AVALANCHE_CRS00_00',root/'tree-hull')
        output=root/'tree-hull'/'AVALANCHE_CRS00_00';models=json.loads((output/'Models.json').read_text())['Models']
        node=next(i for i in json.loads((output/'Instances.json').read_text())['Instances'] if i.get('SourcePlacementIndex')==0)
        tree=models[node['ModelID']];proxy=(output/'Collision'/tree['PlacementCollisionPath']).read_text()
        assert sum(line.startswith('f ') for line in proxy.splitlines())==44,'Use the closed source trunk cylinder, never the visible leaf triangle'
        assert tree['PlacementDefaults']['nativeCollision']['mode']==1
        # Invalid links fail before extraction completes; camera generators stay deferred.
        files=with_material_srt(members(),(1,1,0,0,math.pi/2));mtl=bytearray(files['CRS00_00.MTL'])
        struct.pack_into('>I',mtl,0x80+20,0x007d3c01) # Position-generated mapping needs the source camera.
        files['CRS00_00.MTL']=bytes(mtl);source.write_bytes(rvz(gcm({path:level(files)})))
        run('extract',source,'AVALANCHE_CRS00_00',root/'camera-uv')
        output=root/'camera-uv'/'AVALANCHE_CRS00_00'
        assert json.loads((output/'Import.json').read_text())['DeferredMaterialUVs']==1
        assert json.loads((output/'Patches.json').read_text())['Patches'][0]['UVPoints']==portable_uvs(TERRAIN_UVS[0])
        for kind in ('matrix','animation','key'):
            files=with_material_srt(members(),(1,1,0,0,0));mtl=bytearray(files['CRS00_00.MTL'])
            if kind=='matrix':struct.pack_into('>H',mtl,0x80+28,5)
            elif kind=='animation':struct.pack_into('>H',mtl,int.from_bytes(mtl[0x1c:0x20],'big')+54,5)
            else:struct.pack_into('>H',mtl,int.from_bytes(mtl[0x10:0x14],'big')+54,5)
            files['CRS00_00.MTL']=bytes(mtl);source.write_bytes(rvz(gcm({path:level(files)})))
            run('extract',source,'AVALANCHE_CRS00_00',root/f'bad-srt-{kind}',succeeds=False)
            assert not list((root/f'bad-srt-{kind}').iterdir())
    print('PASS: GameCube, raw/Zstandard/packed RVZ, CMPR pixels, terrain/model material SRT, readable signs, curved ground, collision, spawn, reset and failed import cleanup')


if __name__ == '__main__':
    main()
