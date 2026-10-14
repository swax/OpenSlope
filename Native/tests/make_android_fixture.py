"""Generate an authored synthetic ISO into ignored Android test build assets."""
from pathlib import Path
import sys
from import_test import big, iso
from prop_import_test import members

destination = Path(sys.argv[1])
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_bytes(iso(big(members())))
