"""Generate an authored synthetic ISO into ignored Android test build assets."""
from pathlib import Path
import sys
import struct
import math
import wave
from import_test import big, iso
from collision_test import members
from path_import_test import path_file

destination = Path(sys.argv[1])
destination.parent.mkdir(parents=True, exist_ok=True)
files = members()
files['fixture.aip'] = files['fixture.sop'] = path_file()
destination.write_bytes(iso(big(files)))
with wave.open(str(destination.with_name('tone.wav')), 'wb') as tone:
    tone.setparams((1, 2, 8000, 0, 'NONE', 'not compressed'))
    tone.writeframes(b''.join(struct.pack('<h', round(3000 * math.sin(2 * math.pi * 440 * i / 8000))) for i in range(800)))
