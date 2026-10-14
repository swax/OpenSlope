"""Generate an authored synthetic ISO into ignored Android test build assets."""
from pathlib import Path
import sys
from audio_import_test import disc, fixture
from collision_test import members
from path_import_test import path_file

destination = Path(sys.argv[1])
destination.parent.mkdir(parents=True, exist_ok=True)
files = members()
files['fixture.aip'] = files['fixture.sop'] = path_file()
destination.write_bytes(disc(fixture(files)))
