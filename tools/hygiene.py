#!/usr/bin/env python3
"""Repository publication checks; all required scripts ship with a fresh clone.

The manifest reproduction check additionally uses the optional local Trailmap patch
generators and a user-supplied disc. It reports an explicit skip when those are absent.
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

CHECKS: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("Repository hygiene scanner tests", "tools/hygiene/test_repo_hygiene.py", ()),
    ("Patch-manifest scanner tests", "tools/hygiene/test_patch_hygiene.py", ()),
    ("Manifest-reproduction checker tests", "tools/hygiene/test_verify_manifests.py", ()),
    ("Shipped patch manifests carry no displaced instruction", "tools/hygiene/patch_hygiene.py", ("check",)),
    ("Repository hygiene baseline", "tools/hygiene/repo_hygiene.py", ("check",)),
    ("Local patch manifests reproduce when the research generators and a disc are present",
     "tools/hygiene/verify_manifests.py", ()),
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
            print(f"\nHYGIENE FAILED: {script} exited {result.returncode}.", file=sys.stderr)
            return result.returncode
    print(f"\nhygiene: {len(CHECKS)} checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
