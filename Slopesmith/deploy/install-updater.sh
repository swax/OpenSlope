#!/usr/bin/env bash
set -euo pipefail
readonly HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# Run from a reviewed release. Publisher trust is set separately by the application installer.
exec /usr/bin/python3 -I "$HERE/release_manager.py" install-updater
