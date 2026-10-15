"""Generate an authored synthetic ISO into ignored Android test build assets."""
from pathlib import Path
import sys
import struct
from audio_import_test import disc, fixture
from collision_test import members
from path_import_test import path_file
from prop_import_test import members as prop_members
from rail_import_test import members as rail_members
from import_test import big
from world_import_fixture import boot_files
from audio_resolver_fixture import boot_program

destination = Path(sys.argv[1])
destination.parent.mkdir(parents=True, exist_ok=True)
files = members()
sky = bytearray(prop_members()['fixture.pbd']); struct.pack_into('<I', sky, 12, 0)
files['fixture_sky.pbd'] = bytes(sky)
files['fixture_sky.ssh'] = files['fixture.ssh']
rails = rail_members()
for filename, fields in [('fixture.pbd', ((32,92,40),(36,96,128))), ('fixture.ssf', ((68,72,8),))]:
    target = bytearray(files[filename]); source = rails[filename]
    for count_field, offset_field, stride in fields:
        count, = struct.unpack_from('<I',source,count_field)
        offset, = struct.unpack_from('<I',source,offset_field)
        target.extend(bytes(-len(target)%16)); start = len(target)
        target.extend(source[offset:offset+count*stride])
        struct.pack_into('<I',target,count_field,count);struct.pack_into('<I',target,offset_field,start)
    files[filename] = bytes(target)
files['fixture.map'] += rails['fixture.map'][rails['fixture.map'].index(b'### SPLINES BEGIN'):]
files['fixture.aip'] = files['fixture.sop'] = path_file()
data=fixture(files)
data['DATA/MODELS/GARI.BIG']=big({k.replace('fixture','gari'):v for k,v in files.items()})
data.update(boot_files(boot_program(world=True)))
data['DATA/CONFIG/BANKS.INF']+=b'[GARI]\nMAIN="tone.bnk"\nBOARD="tone.bnk"\nBANK="tone.bnk"\nCROWD="tone.bnk"\n'
data['DATA/CONFIG/MUSICMAP.INF']+=b'[GARI]\n'
data['DATA/CONFIG/SNOW.INF']=b'[PACK]\n[GLIDE]\nLOAD BOARD\nASSIGNVOL\n'
destination.write_bytes(disc(data))
