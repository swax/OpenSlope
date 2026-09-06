#!/usr/bin/env python3
"""The repository hygiene gate: every check that decides whether the tree is publishable.

**This file is the list.** Package scripts, verification, release tooling, and CI all call it so
the same controls run at every entry point.

Python rather than Node so the CI gate stays a Python-only job and release preparation does not
gain a runtime it did not already need.

    python tools/hygiene.py           run every check, stopping at the first failure
    python tools/hygiene.py --list    print the checks without running them
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: (what it proves, script, arguments). Order matters: the scanners' own tests run first, so a
#: broken scanner is reported as a broken scanner rather than as a clean tree.
CHECKS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("Repository hygiene scanner tests",
     "Trailmap/tools/specs/test_repo_hygiene.py", ()),
    ("Patch-manifest scanner tests",
     "Trailmap/tools/specs/test_patch_hygiene.py", ()),
    ("Every Trailmap tool module imports and resolves its globals",
     "Trailmap/tools/specs/test_tools_import.py", ()),
    ("Manifest-reproduction checker tests",
     "Trailmap/tools/patches/test_verify_manifests.py", ()),
    ("Trailmap clean/dirty separation",
     "Trailmap/tools/specs/spec_trace.py", ("check",)),
    ("Shipped patch manifests carry no displaced instruction",
     "Trailmap/tools/specs/patch_hygiene.py", ("check",)),
    ("Trailmap repository hygiene baseline",
     "Trailmap/tools/specs/repo_hygiene.py", ("check",)),
    # The word-level half of the patch-manifest guarantee: regenerate every tracked manifest
    # from the operator's own executable and require byte-equality. Needs a disc under discs/,
    # so it self-skips (exit 0, loudly) on a machine without one, and a machine with one gets
    # the real comparison. It lives here so that every entry point running the gate runs it
    # too, instead of only `verify --full`.
    ("Tracked patch manifests reproduce byte-for-byte from a local disc when one is present",
     "Trailmap/tools/patches/verify_manifests.py", ()),
)


def main(argv: list[str]) -> int:
    if "--list" in argv:
        for label, script, args in CHECKS:
            print(f"{script} {' '.join(args)}".strip().ljust(58) + label)
        return 0

    for index, (label, script, args) in enumerate(CHECKS, start=1):
        print(f"\n=== [{index}/{len(CHECKS)}] {label} ===", flush=True)
        result = subprocess.run([sys.executable, str(ROOT / script), *args], cwd=ROOT)
        if result.returncode != 0:
            print(f"\nHYGIENE FAILED: {script} {' '.join(args)}".rstrip()
                  + f" exited {result.returncode}.", file=sys.stderr)
            return result.returncode

    print(f"\nhygiene: {len(CHECKS)} checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
