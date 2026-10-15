"""Feed the CPU tests an independently authored portable occupancy-body map."""
from pathlib import Path
import subprocess
import sys
import tempfile
from roller_replay_test import fixture

with tempfile.TemporaryDirectory(prefix='openslope-body-core-') as temporary:
    root=Path(temporary);fixture(root)
    command=[str(Path(sys.argv[1]).resolve()),str(root),*sys.argv[2:]]
    raise SystemExit(subprocess.run(command,timeout=180).returncode)
