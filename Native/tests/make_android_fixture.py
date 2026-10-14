"""Generate an authored synthetic ISO into ignored Android test build assets."""
from pathlib import Path
import sys
import struct
from audio_import_test import disc, fixture
from collision_test import members
from path_import_test import path_file
from prop_import_test import members as prop_members

destination = Path(sys.argv[1])
destination.parent.mkdir(parents=True, exist_ok=True)
files = members()
sky = bytearray(prop_members()['fixture.pbd']); struct.pack_into('<I', sky, 12, 0)
files['fixture_sky.pbd'] = bytes(sky)
files['fixture_sky.ssh'] = files['fixture.ssh']
files['fixture.aip'] = files['fixture.sop'] = path_file()
destination.write_bytes(disc(fixture(files)))
