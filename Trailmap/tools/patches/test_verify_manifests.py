#!/usr/bin/env python3
"""Tests for verify_manifests, over synthetic generators and manifests.

The value of this check is that it FAILS when it should, and each way it can fail open has been
a real bug once: a crashed generator read as a polite decline; a generator emitting a manifest
nobody tracks skipped because the tracked set drove the loop; a tracked manifest made invisible
by deleting its entry from GENERATORS.

So these drive `main()` end to end against stub generators rather than calling `compare()` in
isolation -- the orchestration is where every one of those bugs lived.

    python Trailmap/tools/patches/test_verify_manifests.py
"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import contextlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import verify_manifests as vm  # noqa: E402

FAILURES: list[str] = []
TARGET = "SLES_TEST.00"

REGIONS = [{"fileOffset": 16, "length": 4, "originalSha256": "0" * 64, "patched": "11111111"}]


def check(condition: bool, label: str) -> None:
    print(f"{'ok  ' if condition else 'FAIL'} {label}")
    if not condition:
        FAILURES.append(label)


def doc(name: str, *, regions=None, notes="n") -> str:
    return json.dumps({"name": name, "target": TARGET, "formatVersion": 3,
                       "notes": notes, "regions": regions or REGIONS}, indent=1) + "\n"


def stub(script: Path, body: str) -> None:
    """A generator that behaves as `body` says: writes its manifest, crashes, or exits 0 silently."""
    script.write_text(
        "import sys, argparse\n"
        "p = argparse.ArgumentParser()\n"
        "p.add_argument('--elf'); p.add_argument('--out'); p.add_argument('--emit-patch')\n"
        "a = p.parse_args()\n" + body, encoding="utf-8")


def run_case(label: str, *, tracked: dict[str, str], generators: dict[str, str],
             bodies: dict[str, str], expect_exit: int, expect_text: str,
             elf_contents: list[bytes] | None = None) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        manifests = root / "Patches"
        manifests.mkdir()
        for name, text in tracked.items():
            (manifests / f"{name}.{TARGET}.json").write_text(text, encoding="utf-8")

        gen_dir = root / "gen"
        gen_dir.mkdir()
        for script, body in bodies.items():
            stub(gen_dir / script, body)

        # Each source gets its own directory so several copies of the same build --
        # the same boot-executable name -- can sit side by side, like discs/ does.
        elf_args: list[str] = []
        for index, content in enumerate(elf_contents or [b"\0" * 64]):
            source_dir = root / f"source{index}"
            source_dir.mkdir()
            elf = source_dir / TARGET
            elf.write_bytes(content)
            elf_args += ["--elf", str(elf)]

        saved = (vm.MANIFESTS, vm.GENERATORS, vm.HERE)
        vm.MANIFESTS, vm.GENERATORS, vm.HERE = manifests, generators, gen_dir
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                code = vm.main(["verify_manifests.py", *elf_args])
        finally:
            vm.MANIFESTS, vm.GENERATORS, vm.HERE = saved
        output = buf.getvalue()
        ok = code == expect_exit and expect_text in output
        check(ok, label)
        if not ok:
            print(f"       exit {code} (want {expect_exit}); looked for {expect_text!r} in:\n{output}")


WRITES = "open(a.emit_patch,'w',encoding='utf-8').write(MANIFEST)\n"


def run() -> int:
    good = doc("alpha")

    run_case("a matching generator passes",
             tracked={"alpha": good},
             generators={"alpha.py": "alpha"},
             bodies={"alpha.py": f"MANIFEST = {good!r}\n" + WRITES},
             expect_exit=0, expect_text="ok       alpha")

    run_case("a generator that exits non-zero is a failure, not a decline",
             tracked={"alpha": good},
             generators={"alpha.py": "alpha"},
             bodies={"alpha.py": "sys.exit('boom')\n"},
             expect_exit=1, expect_text="did not produce a manifest")

    run_case("a generator that exits 0 but writes nothing is caught",
             tracked={"alpha": good},
             generators={"alpha.py": "alpha"},
             bodies={"alpha.py": "pass\n"},
             expect_exit=1, expect_text="did not produce a manifest")

    run_case("a tracked manifest no generator claims is caught",
             tracked={"orphan": doc("orphan")},
             generators={},
             bodies={},
             expect_exit=1, expect_text="no generator in GENERATORS produces it")

    run_case("a generator emitting a manifest nobody tracks is caught",
             tracked={},
             generators={"extra.py": "extra"},
             bodies={"extra.py": f"MANIFEST = {doc('extra')!r}\n" + WRITES},
             expect_exit=1, expect_text="MISSING")

    drifted = doc("alpha", regions=[
        {"fileOffset": 16, "length": 4, "originalSha256": "0" * 64, "patched": "22222222"}])
    run_case("a payload difference is caught",
             tracked={"alpha": good},
             generators={"alpha.py": "alpha"},
             bodies={"alpha.py": f"MANIFEST = {drifted!r}\n" + WRITES},
             expect_exit=1, expect_text="regions differ")

    run_case("regions equal but prose drifted is caught as stale",
             tracked={"alpha": good},
             generators={"alpha.py": "alpha"},
             bodies={"alpha.py": f"MANIFEST = {doc('alpha', notes='reworded')!r}\n" + WRITES},
             expect_exit=1, expect_text="STALE")

    picky = (f"MANIFEST = {good!r}\n"
             "content = open(a.elf, 'rb').read()\n"
             "if content.startswith(b'MOD'): sys.exit('hook sites not found; modified copy?')\n"
             + WRITES)
    run_case("a modified copy beside a pristine one is noise, not a failure",
             tracked={"alpha": good},
             generators={"alpha.py": "alpha"},
             bodies={"alpha.py": picky},
             elf_contents=[b"MOD" + b"\0" * 61, b"\0" * 64],
             expect_exit=0, expect_text="ok       alpha")

    run_case("modified copies alone still fail: nothing verified the manifest",
             tracked={"alpha": good},
             generators={"alpha.py": "alpha"},
             bodies={"alpha.py": picky},
             elf_contents=[b"MOD" + b"\0" * 61],
             expect_exit=1, expect_text="FAILED to reproduce")

    run_case("a manifest emitted for a different build is caught",
             tracked={"alpha": good},
             generators={"alpha.py": "alpha"},
             bodies={"alpha.py": "MANIFEST = " + repr(
                 json.dumps({"name": "alpha", "target": "OTHER", "formatVersion": 3,
                             "notes": "n", "regions": REGIONS}, indent=1) + "\n") + "\n" + WRITES},
             expect_exit=1, expect_text="not this build")

    print()
    if FAILURES:
        print(f"{len(FAILURES)} failure(s)", file=sys.stderr)
        return 1
    print("verify_manifests tests pass")
    return 0


if __name__ == "__main__":
    raise SystemExit(run())
