#!/usr/bin/env python3
"""Regenerate every shipped patch manifest from your own executable and require it to match.

`specs/patch_hygiene.py` checks the manifests' structure without a disc: declared windows hold
`break`, no `break` is undeclared, versions are supported. What it cannot check is the thing the
whole format exists for -- that a payload really is only this project's code -- because deciding
that needs the executable the words would have come from.

This is that half. For each ISO under `discs/`, it pulls the boot executable out, runs every
generator under this directory against it, and compares the result with the tracked file. A
tracked manifest failing to reproduce means one of two things, and both matter:

  * a generator now emits something different from what is committed -- the tracked manifest is
    stale, and nobody would otherwise notice, because a generated file nobody regenerates is a
    file nobody is checking; or
  * a payload changed in a way the structural scanner cannot see.

The verdict is per build, not per source: a working `discs/` directory legitimately holds
patched and repacked copies beside the pristine image, and a generator missing its hook sites
in a modified copy proves nothing about the manifests. Each source's misses are still printed,
but the run fails only when a tracked manifest reproduces from NO present copy of its build --
or on tracking/generator drift (a tracked manifest no generator claims, an emission nobody
tracks), which is wrong regardless of which copy ran.

Runs from `tools/hygiene.py`, so the fast gate, CI, and release preparation all get it. With
no disc it skips, loudly, naming what it did not cover.

    python Trailmap/tools/patches/verify_manifests.py [--discs DIR] [--elf FILE ...]
"""

from __future__ import annotations

import argparse
import json
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
MANIFESTS = REPO / "Snowknife" / "Snowknife" / "Patches"
SECTOR = 2048

#: generator script -> the manifest name it emits
GENERATORS = {
    "noclip_patch.py": "noclip-fly-mode",
    "sky_color_patch.py": "sky-color",
    "debug_text_patch.py": "debug-text",
}


def boot_executable(iso: Path) -> tuple[str, bytes] | None:
    """The boot executable in an ISO9660 image, by walking the root directory."""
    with iso.open("rb") as handle:
        handle.seek(16 * SECTOR)
        pvd = handle.read(SECTOR)
        if pvd[1:6] != b"CD001":
            return None
        root = pvd[156:156 + 34]
        lba, length = struct.unpack_from("<I", root, 2)[0], struct.unpack_from("<I", root, 10)[0]
        handle.seek(lba * SECTOR)
        directory = handle.read(length)

        position = 0
        while position < len(directory):
            record_length = directory[position]
            if record_length == 0:
                position = (position // SECTOR + 1) * SECTOR
                continue
            extent, size = (struct.unpack_from("<I", directory, position + 2)[0],
                            struct.unpack_from("<I", directory, position + 10)[0])
            name_length = directory[position + 32]
            name = directory[position + 33:position + 33 + name_length].decode("ascii", "replace")
            name = name.split(";")[0]
            if name.startswith(("SLES", "SLUS", "SLPS")):
                handle.seek(extent * SECTOR)
                return name, handle.read(size)
            position += record_length
    return None


def regenerate(elf: Path, work: Path, required: set[str]) -> tuple[dict[str, Path], list[str]]:
    """Run every generator against `elf`.

    Returns the manifests produced, and one message per generator that FAILED when it should
    have succeeded. "Should have succeeded" is decided by the tracked tree, not by the
    generator: if `<name>.<target>.json` is committed, then this build is one that generator
    supports, and a non-zero exit is a broken generator rather than a polite decline. Without
    that rule a generator that crashed would silently drop its manifest from the comparison and
    the gate would pass having checked less than it reported.
    """
    emitted: dict[str, Path] = {}
    errors: list[str] = []
    for script, name in GENERATORS.items():
        out = work / f"{name}.json"
        result = subprocess.run(
            [sys.executable, str(HERE / script), "--elf", str(elf),
             "--out", str(work / f"{name}.elf"), "--emit-patch", str(out)],
            capture_output=True, text=True)
        if result.returncode == 0 and out.exists():
            emitted[name] = out
        elif name in required:
            detail = (result.stderr or result.stdout).strip().splitlines()
            errors.append(
                f"    missed   {script} did not produce a manifest, but one is tracked for this "
                f"build\n" + "\n".join(f"               {line}" for line in detail[-4:]))
        else:
            print(f"    n/a      {name}: this generator does not support this build, "
                  "and no manifest for it is tracked")
    return emitted, errors


def compare(name: str, target: str, emitted: Path) -> bool:
    tracked = MANIFESTS / f"{name}.{target}.json"
    if not tracked.exists():
        print(f"    MISSING  {tracked.name} is not tracked, but a generator emits it")
        return False

    fresh_text, tracked_text = emitted.read_text(), tracked.read_text()
    if fresh_text == tracked_text:
        print(f"    ok       {tracked.name}")
        return True

    fresh, old = json.loads(fresh_text), json.loads(tracked_text)
    if fresh.get("regions") != old.get("regions"):
        differing = [r["fileOffset"] for r, o in zip(fresh["regions"], old["regions"]) if r != o]
        print(f"    MISMATCH {tracked.name}: regions differ"
              + (f" at file offset(s) {', '.join(hex(o) for o in differing)}" if differing else ""))
    else:
        changed = sorted(k for k in set(fresh) | set(old) if fresh.get(k) != old.get(k))
        print(f"    STALE    {tracked.name}: regions match but {', '.join(changed)} differs "
              "- regenerate and commit it")
    return False


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--discs", type=Path, default=REPO / "discs",
                        help="directory of ISO images (default: discs/)")
    parser.add_argument("--elf", type=Path, action="append", default=[],
                        help="check an already-extracted boot executable instead")
    args = parser.parse_args(argv[1:])

    sources: list[tuple[str, bytes]] = []
    for elf in args.elf:
        sources.append((elf.name, elf.read_bytes()))
    if not sources and args.discs.is_dir():
        for iso in sorted(args.discs.glob("*.iso")):
            found = boot_executable(iso)
            if found is None:
                print(f"{iso.name}: no boot executable in the root directory; skipped")
                continue
            sources.append(found)

    if not sources:
        print("verify_manifests: SKIPPED - no disc image under "
              f"{args.discs.relative_to(REPO) if args.discs.is_relative_to(REPO) else args.discs}"
              " and no --elf given.")
        print("  The structural half of this guarantee still ran (specs/patch_hygiene.py); the "
              "word-level half needs a copy of the game you own.")
        return 0

    tracked = {p.name for p in MANIFESTS.glob("*.json")}
    verified: set[str] = set()
    attempted: set[str] = set()   # manifests a detected build was supposed to reproduce
    hard_failures = 0             # tracking/generator drift: wrong no matter which copy ran
    soft_sources = 0              # sources that did not reproduce everything (a modified copy looks like this)

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for target, blob in sources:
            elf = work / target
            elf.write_bytes(blob)
            print(f"{target} ({len(blob):,} B)")

            # Every manifest committed for this build must be regenerated and compared. This set
            # is what makes the check fail closed: nothing here can be skipped quietly.
            #
            # It is derived from the TRACKED FILES, not from GENERATORS. Deriving it from the
            # mapping would mean that deleting a generator's entry there silently drops its
            # manifest from the comparison, and the run would then report it as "no disc" and
            # exit 0 -- the whole failure this check exists to prevent, reachable by editing a
            # dict. A tracked manifest no generator claims is an error below.
            required = {p.name[:-len(f".{target}.json")] for p in MANIFESTS.glob(f"*.{target}.json")}
            unclaimed = required - set(GENERATORS.values())
            for name in sorted(unclaimed):
                print(f"    FAILED   {name}.{target}.json is tracked but no generator in GENERATORS "
                      "produces it; it cannot be verified")
                hard_failures += 1
            required -= unclaimed
            attempted |= {f"{name}.{target}.json" for name in required}

            # The generators always run, even when nothing is tracked for this build. Skipping
            # them there would reopen the hole from the other side: a generator that STARTS
            # supporting a build has no committed manifest yet, so `required` would not name it
            # and its output would go uncompared. Anything it emits is checked below.
            emitted, errors = regenerate(elf, work, required)
            source_clean = not errors
            for error in errors:
                print(error)
            if not required and not emitted:
                print("    no generator supports this build and no manifest is tracked for it")
                continue

            for name in sorted(required | set(emitted)):
                path = emitted.get(name)
                if path is None:
                    continue  # already reported by regenerate above
                fresh_target = json.loads(path.read_text()).get("target")
                if name not in required:
                    # An emission nobody tracks is generator/tracking drift, not disc state:
                    # hard, because no other copy of the build can make it right.
                    compare(name, target, path)
                    hard_failures += 1
                    continue
                if fresh_target != target:
                    print(f"    MISMATCH {name}.{target}.json: the generator emitted a manifest for "
                          f"{fresh_target!r}, not this build")
                    source_clean = False
                elif compare(name, target, path):
                    verified.add(f"{name}.{target}.json")
                else:
                    source_clean = False
            if not source_clean:
                soft_sources += 1

            # Nothing goes unaccounted: every required manifest entered `attempted` above, so a
            # name no source reproduces surfaces in `broken` at the end even though a single
            # source's miss is not, by itself, a failure any more.

    # Two different reasons a tracked manifest can be unverified, and only one is benign.
    no_disc = sorted(tracked - verified - attempted)
    broken = sorted(attempted - verified)
    print(f"\nverified {len(verified)} of {len(tracked)} tracked manifests")
    if no_disc:
        print("  not reached (no disc for these builds): " + ", ".join(no_disc))
    if broken:
        print("  FAILED to reproduce (a copy of these builds WAS present, and none of them "
              "reproduced these): " + ", ".join(broken))
    elif soft_sources and not hard_failures:
        print(f"  note: {soft_sources} source(s) did not reproduce every manifest -- expected for "
              "patched or repacked copies, and harmless because every tracked manifest verified")
    if hard_failures or broken:
        print(f"\nverify_manifests: {hard_failures + len(broken)} problem(s)", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
