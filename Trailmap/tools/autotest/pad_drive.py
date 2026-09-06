#!/usr/bin/env python3
"""Force pad buttons into SSX Tricky's decoded controller state, so a machine can work the front end.

The harness rebuilds the ISO every iteration and PCSX2 mounts the disc at launch, so every pass starts from
a cold boot and has to get itself from the EA logo into a course. Nothing in the game does that, and a
savestate cannot: it restores all of EE RAM, so a state taken in-level restores the level it was taken in
and every later run would ride a stale map. Driving the front end is what removes the last manual step.

Menu navigation turns out not to be needed. Mashing CROSS from startup takes the defaults all the way into
Garibaldi, so this forces one button rather than steering a cursor, and the host toggles it press/release
instead of the cave carrying any timing of its own.

## The site

Site A (`0x0017B104`) is the pad device decode, already vetted by the noclip patch, which reads the same
registers there:

    s1 = device (port at +0x3C, and only port 0 is a player)
    s2 = the decoded output struct: +0x18 takes the held-button halfword
    v1 = that mask, NOR'd so a SET bit means PRESSED, with the upper bits dirty
    free registers: at and t9, and nothing else -- v0/v1/a1/a3 are all still live here

That last line is why this cave is shaped the way it is. It runs the two displaced originals FIRST and
unconditionally, then re-reads `0x18(s2)` and ORs the forced bits into what the game just stored, which
needs exactly the two registers that are free. Patching `v1` before the store would be shorter and would
corrupt a live register.

## The button bits

Read out of the noclip patch's own cave B, which consumes this same mask: it tests `0x0030` for
TRIANGLE+CIRCLE and `0x0008` for R1. Those are the standard PS2 second-byte positions, which pins the whole
halfword -- the low byte is L2/R2/L1/R1/TRIANGLE/CIRCLE/CROSS/SQUARE and the high byte is
SELECT/L3/R3/START/UP/RIGHT/DOWN/LEFT. CROSS is therefore `0x0040`.

TRIANGLE, CIRCLE and R1 are directly attested by cave B; CROSS is derived from their positions. `probe`
prints the live mask so a wrong derivation is one command to see rather than a mystery about why the menus
will not advance.

## Safety

The same contract as the other probes here: the pre-existing bytes are saved to a recovery record before
anything is touched, every write is read back, and `verify_bounded_writer` proves against the ASSEMBLED
words that the cave's only stores are its own counter and the one halfword it exists to write. Unlike
`input_ring.py` this cave is deliberately not an observer, so the proof pins exactly which single game
address it may touch rather than asserting it touches none.

  python tools/autotest/pad_drive.py install     # VM may be running; the site is checked first
  python tools/autotest/pad_drive.py probe       # live mask + whether the cave is running
  python tools/autotest/pad_drive.py mash --seconds 30
  python tools/autotest/pad_drive.py uninstall
"""

from __future__ import annotations

import argparse
import json
import struct
import sys
import time
from dataclasses import dataclass
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS / "patches"))
sys.path.insert(0, str(TOOLS / "instrumentation"))
from noclip_patch import TARGETS, Asm, Target, hi_base, site_is_stock  # noqa: E402
from input_ring import usable_region  # noqa: E402
from pine_hooks import Pine, j_ins  # noqa: E402

MAGIC = 0x44415000  # "\0PAD" little-endian

OFF_MAGIC = 0x00
OFF_ENABLE = 0x04
OFF_FORCE = 0x08
OFF_APPLIED = 0x0C
CODE_OFFSET = 0x10

DEVICE_PORT = 0x3C
OUT_HELD_MASK = 0x18
OUT_RIGHT_STICK = 0x24

#: Stand-ins for site A's two words when a cave is assembled only to measure its length (`build_layout`).
#: Never installed: `install` reads the real words out of the emulator.
SIZING_DISPLACED = (0, 0)

# The decoded held-button halfword: a SET bit is a PRESSED button.
BUTTONS = {
    "l2": 0x0001, "r2": 0x0002, "l1": 0x0004, "r1": 0x0008,
    "triangle": 0x0010, "circle": 0x0020, "cross": 0x0040, "square": 0x0080,
    "select": 0x0100, "l3": 0x0200, "r3": 0x0400, "start": 0x0800,
    "up": 0x1000, "right": 0x2000, "down": 0x4000, "left": 0x8000,
}

STATE_FILE = TOOLS.parents[1] / "Trailmap" / "temp" / "autotest" / "pad-drive-state.json"


@dataclass(frozen=True)
class PadLayout:
    target: Target
    header: int

    @property
    def magic(self) -> int:
        return self.header + OFF_MAGIC

    @property
    def enable(self) -> int:
        return self.header + OFF_ENABLE

    @property
    def force(self) -> int:
        return self.header + OFF_FORCE

    @property
    def applied(self) -> int:
        return self.header + OFF_APPLIED

    @property
    def code(self) -> int:
        return self.header + CODE_OFFSET


def build_layout(target: Target) -> PadLayout:
    start, end = usable_region(target)
    layout = PadLayout(target=target, header=start)
    size = CODE_OFFSET + len(build_pad_cave(layout, SIZING_DISPLACED))
    if start + size > end:
        raise RuntimeError(f"{target.name}: pad cave needs {size} B of {end - start} B")
    base_hi, _ = hi_base(layout.header)
    for name, address in (("header", layout.header), ("applied", layout.applied)):
        hi, lo = hi_base(address)
        if hi != base_hi or lo >= 0x8000:
            raise RuntimeError(f"{name} 0x{address:08x} is not reachable from one lui")
    return layout


def build_pad_cave(layout: PadLayout, displaced) -> bytes:
    """Run site A's displaced work, then OR the forced buttons into what it just stored.

    `displaced` is the pair of words site A holds in the running game, read from the emulator by `install`
    and checked by digest there. They are the game's instructions, which is why this module takes them as
    input rather than spelling them out.
    """
    if len(displaced) != 2:
        raise ValueError(f"site A displaces two words, got {len(displaced)}")
    target = layout.target
    a = Asm(layout.code)
    base_hi, _ = hi_base(layout.header)

    # Unconditionally first, so the decode behaves exactly as stock on every path out of here.
    for word in displaced:                  # site A's own two words, read at install
        a.word(word)

    a.lw("t9", DEVICE_PORT, "s1")           # port 0 is the player; other ports decode into other structs
    a.bne("t9", "zero", "done")
    a.nop()
    a.lui("at", base_hi)
    a.lw("t9", layout.enable & 0xFFFF, "at")
    a.beq("t9", "zero", "done")
    a.nop()

    a.lw("t9", layout.applied & 0xFFFF, "at")   # proof the cave is live, independent of any button working
    a.addiu("t9", "t9", 1)
    a.sw("t9", layout.applied & 0xFFFF, "at")

    a.lw("t9", layout.force & 0xFFFF, "at")
    # `at` stops being the cave base here: the OR needs a second value and these two are the only free
    # registers at this site.
    a.lhu("at", OUT_HELD_MASK, "s2")
    a.or_("t9", "t9", "at")
    a.sh("t9", OUT_HELD_MASK, "s2")

    a.label("done")
    a.j(target.site_a + 8)
    a.nop()
    return a.assemble()


class BoundedWriterViolation(RuntimeError):
    """The assembled cave stores somewhere it was not authorized to."""


# Every opcode that writes memory, as in input_ring's observer proof.
STORE_OPCODES = {0x28, 0x29, 0x2A, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F, 0x1F, 0x39, 0x3A, 0x3E, 0x3F}
REGISTERS = (
    "zero at v0 v1 a0 a1 a2 a3 t0 t1 t2 t3 t4 t5 t6 t7 "
    "s0 s1 s2 s3 s4 s5 s6 s7 t8 t9 k0 k1 gp sp fp ra"
).split()


def verify_bounded_writer(layout: PadLayout, blob: bytes) -> None:
    """Prove the cave writes only its own counter and the one halfword it exists to force.

    The point of an injector is that it writes game state, so "writes nothing" is not the available
    property. What IS available is an exact allow-list, checked against the bytes that will actually be
    installed rather than against the source that produced them. The cave must also open with site A's
    own two words, checked by digest as the build checks a site, so this module never spells them out.
    """
    words = list(struct.unpack(f"<{len(blob) // 4}I", blob))
    if not site_is_stock(layout.target, 0, words[:2]):
        raise BoundedWriterViolation(
            "cave does not open with the two words site A displaced: " + " ".join(f"{w:08x}" for w in words[:2]))
    allowed = {
        ("s2", OUT_HELD_MASK, 0x29),      # sh: the forced mask, and the displaced original
        ("s2", OUT_RIGHT_STICK, 0x2B),    # sw: the displaced original
        ("at", layout.applied & 0xFFFF, 0x2B),
    }
    seen = []
    for index, word in enumerate(words):
        opcode = word >> 26
        if opcode not in STORE_OPCODES:
            continue
        base = REGISTERS[(word >> 21) & 0x1F]
        offset = word & 0xFFFF
        entry = (base, offset, opcode)
        seen.append((index, entry))
        if entry not in allowed:
            raise BoundedWriterViolation(
                f"word {index} (0x{word:08x}) stores to {base}+0x{offset:x} with opcode 0x{opcode:02x}, "
                "which is outside the cave's allow-list"
            )
    if len(seen) != 4:
        raise BoundedWriterViolation(f"expected exactly 4 stores, found {len(seen)}: {seen}")


def resolve_target(pine: Pine) -> Target:
    wanted = pine.game_id().strip().replace("-", "_")
    for name, target in TARGETS.items():
        if name.replace(".", "").replace("_", "") in wanted.replace(".", "").replace("_", ""):
            return target
    raise RuntimeError(f"unsupported game id {pine.game_id()!r}")


def elf_is_up(pine: Pine, target: Target) -> bool:
    """True once site A holds its stock words -- which is also how we know the ELF is resident."""
    try:
        return site_is_stock(target, 0, pine.r32_many((target.site_a, target.site_a + 4)))
    except OSError:
        return False


def wait_for_elf(pine: Pine, target: Target, timeout: float = 120.0, settle: float = 1.0) -> None:
    """Block until site A is stock AND the whole cave region has stopped changing.

    Site A alone is not enough. The blob this cave lives in is real (unreferenced) code in the shipped
    executable, not zero padding, so during the tail of the ELF load site A can already read stock while the
    loader is still writing the bytes a few hundred further on. Installing there gets the cave overwritten
    and the hook jumps into the loader's output.
    """
    region = range(target.cave_base, target.cave_end, 4)
    deadline = time.monotonic() + timeout
    previous: list[int] | None = None
    while time.monotonic() < deadline:
        if elf_is_up(pine, target):
            current = pine.r32_many(region)
            if previous is not None and current == previous:
                return
            previous = current
        else:
            previous = None
        time.sleep(settle)
    raise RuntimeError("the game executable never settled in EE RAM")


def installed(pine: Pine, layout: PadLayout) -> bool:
    site = layout.target.site_a
    word0, word1, magic = pine.r32_many((site, site + 4, layout.magic))
    return word0 == j_ins(layout.code) and word1 == 0 and magic == MAGIC


def write_verified(pine: Pine, addr: int, words) -> None:
    for index, word in enumerate(words):
        address = addr + index * 4
        pine.w32(address, word)
        readback = pine.r32(address)
        if readback != word:
            raise RuntimeError(f"verify failed @0x{address:08x}: wrote 0x{word:08x}, read 0x{readback:08x}")


def install(pine: Pine, layout: PadLayout, state_path: Path = STATE_FILE) -> None:
    """Install the cave, then point site A at it.

    Deliberately does NOT require a paused VM, because the front end is where this has to run and the
    harness has no way to pause there. It is safe in this order for a specific reason: nothing branches
    into the cave until the site is rewritten, and the site's two words are rewritten `j` first. In the
    instant between those two writes the jump's delay slot still holds site A's own second original, which
    the cave then re-runs -- a duplicate store of identical values to the same address, and nothing else.
    """
    # The cave re-executes site A's two words, so they are read from the game first and checked by digest
    # before anything is built around them.
    site = layout.target.site_a
    site_words = pine.r32_many((site, site + 4))
    if state_path.exists():
        # A record left behind by an emulator that died mid-run describes bytes that no longer exist: the ELF
        # is streamed fresh off the ISO at every launch, so nothing of ours survives into this image. Site A
        # is the arbiter -- reading stock means there is no cave here to restore, and keeping the record would
        # wedge every future run behind a manual delete. Anything else is a live install and still refused.
        if site_is_stock(layout.target, 0, site_words):
            print(f"note: discarding a stale cave record ({state_path.name}); site A is stock, so the run "
                  "it belonged to died before it could restore")
            state_path.unlink()
        else:
            raise RuntimeError(f"{state_path} exists; the cave is installed or an uninstall was interrupted")
    if tuple(site_words) == (j_ins(layout.code), 0):
        # The site already carries this cave's hook and its record is gone, so the two words it displaced
        # cannot be read back; there is nothing to build a cave around.
        raise RuntimeError(
            "site A already holds this cave's hook and no recovery record exists; restart the emulator "
            "and install again"
        )
    if not site_is_stock(layout.target, 0, site_words):
        raise RuntimeError(
            f"site A is 0x{site_words[0]:08x} 0x{site_words[1]:08x}, neither stock nor this cave; "
            "refusing to overwrite an unknown hook"
        )
    blob = build_pad_cave(layout, site_words)
    verify_bounded_writer(layout, blob)
    span = CODE_OFFSET + len(blob)
    region_words = pine.r32_many(layout.header + index * 4 for index in range(span // 4))

    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({
        "kind": "ssx-tricky-pad-drive-state",
        "savedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "gameId": pine.game_id(),
        "target": layout.target.name,
        "header": f"0x{layout.header:08x}",
        "regionWords": [f"0x{word:08x}" for word in region_words],
        "siteA": [f"0x{word:08x}" for word in site_words],
    }, indent=2) + "\n", encoding="utf-8")

    try:
        # Header disarmed first, then code, then the hook: the site can never branch into a half-written cave.
        write_verified(pine, layout.header, (MAGIC, 0, 0, 0))
        write_verified(pine, layout.code, struct.unpack(f"<{len(blob) // 4}I", blob))
        write_verified(pine, site, (j_ins(layout.code), 0))
    except Exception:
        try:
            write_verified(pine, site, site_words)
            write_verified(pine, layout.header, region_words)
            state_path.unlink(missing_ok=True)
        except Exception as rollback_error:
            raise RuntimeError(
                f"install failed and rollback also failed ({rollback_error}); {state_path} retained"
            )
        raise


def uninstall(pine: Pine, state_path: Path = STATE_FILE) -> None:
    if not state_path.exists():
        raise RuntimeError(f"no recovery record at {state_path}")
    saved = json.loads(state_path.read_text(encoding="utf-8"))
    target = TARGETS[saved["target"]]
    # Site before cave, so nothing can branch into a region being rewritten.
    write_verified(pine, target.site_a, [int(word, 16) for word in saved["siteA"]])
    write_verified(pine, int(saved["header"], 16), [int(word, 16) for word in saved["regionWords"]])
    state_path.unlink()


def arm(pine: Pine, layout: PadLayout, enabled: bool) -> None:
    pine.w32(layout.enable, 1 if enabled else 0)
    if not enabled:
        pine.w32(layout.force, 0)


def press(pine: Pine, layout: PadLayout, mask: int) -> None:
    pine.w32(layout.force, mask & 0xFFFF)


def mash(pine: Pine, layout: PadLayout, mask: int, seconds: float,
         hold: float = 0.12, gap: float = 0.12, until=None) -> bool:
    """Tap `mask` until `until()` says stop or the time runs out.

    Tapping rather than holding: a menu advances on the press EDGE, so a held button walks one screen and
    then sits there.
    """
    deadline = time.monotonic() + seconds
    arm(pine, layout, True)
    try:
        while time.monotonic() < deadline:
            # The cave lives in the executable's own image, so confirm on every tap that it is still ours
            # before asking the game to run it again. Anything that rewrites this blob turns the hook into
            # a jump to arbitrary code, and stopping is the only safe response.
            if pine.r32(layout.magic) != MAGIC:
                raise RuntimeError(
                    f"the pad cave at 0x{layout.header:08x} was overwritten while armed; "
                    "site A is pointing at code that is no longer ours"
                )
            press(pine, layout, mask)
            time.sleep(hold)
            press(pine, layout, 0)
            if until is not None and until():
                return True
            time.sleep(gap)
        return until() if until is not None else False
    finally:
        arm(pine, layout, False)


def tap(pine: Pine, layout: PadLayout, mask: int, times: int = 1,
        hold: float = 0.12, gap: float = 0.18) -> None:
    """Press `mask` exactly `times` and stop, whatever the game does about it.

    Distinct from `mash`, and the distinction is the whole of menu steering. `mash` repeats until a condition
    comes true, which works for "get into a course" because arriving is observable. Choosing a MODE is not:
    the top-level menu selector is an argument to the dispatcher (`sub_0029b458` takes it in a0) rather than
    a field of any object this harness can reach, so there is nothing to poll while steering and a
    repeat-until would walk straight past the entry it was aiming at.

    So the count is open-loop and the ARRIVAL is checked instead -- `GameModeGlobal` says exactly which entry
    was taken, after the fact and without ambiguity. Steer blind, then refuse to measure if you landed
    somewhere else.
    """
    arm(pine, layout, True)
    try:
        for _ in range(times):
            if pine.r32(layout.magic) != MAGIC:
                raise RuntimeError(
                    f"the pad cave at 0x{layout.header:08x} was overwritten while armed; "
                    "site A is pointing at code that is no longer ours"
                )
            press(pine, layout, mask)
            time.sleep(hold)
            press(pine, layout, 0)
            time.sleep(gap)
    finally:
        arm(pine, layout, False)


def parse_plan(plan: str) -> list[tuple[int, int]]:
    """`"cross:3,down:2"` -> `[(crossMask, 3), (downMask, 2)]`, a scripted menu prelude.

    Written as a string rather than as flags because the useful unit is a SEQUENCE: which button, how many
    times, in what order. A prelude is discovered once per front end (see `emu.py modescan`) and then lives
    in a table, so the format only has to be readable enough to check by eye against what was calibrated.
    """
    steps: list[tuple[int, int]] = []
    for chunk in plan.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        name, _, count = chunk.partition(":")
        times = int(count) if count.strip() else 1
        if times < 0:
            raise SystemExit(f"a step cannot be pressed {times} times: {chunk!r}")
        steps.append((parse_buttons(name), times))
    return steps


def run_plan(pine: Pine, layout: PadLayout, plan: str) -> None:
    for mask, times in parse_plan(plan):
        if times:
            print(f"  menu: {describe(mask)} x{times}")
            tap(pine, layout, mask, times)


def parse_buttons(names: str) -> int:
    mask = 0
    for name in names.split("+"):
        key = name.strip().lower()
        if key not in BUTTONS:
            raise SystemExit(f"unknown button {name!r}; known: {', '.join(sorted(BUTTONS))}")
        mask |= BUTTONS[key]
    return mask


def describe(mask: int) -> str:
    return "+".join(name for name, bit in BUTTONS.items() if mask & bit) or "none"


def cmd_install(_: argparse.Namespace) -> int:
    pine = Pine()
    target = resolve_target(pine)
    wait_for_elf(pine, target)
    layout = build_layout(target)
    install(pine, layout)
    print(f"pad cave installed at 0x{layout.header:08x} (code 0x{layout.code:08x}); recovery -> {STATE_FILE}")
    return 0


def cmd_uninstall(_: argparse.Namespace) -> int:
    uninstall(Pine())
    print("site A and its cave region restored exactly")
    return 0


def cmd_probe(_: argparse.Namespace) -> int:
    pine = Pine()
    target = resolve_target(pine)
    layout = build_layout(target)
    site_words = pine.r32_many((target.site_a, target.site_a + 4))
    live = installed(pine, layout)
    print(f"site A: 0x{site_words[0]:08x} 0x{site_words[1]:08x} "
          f"[{'hooked' if live else 'stock' if site_is_stock(target, 0, site_words) else 'unknown'}]")
    if live:
        enable, force, applied = pine.r32_many((layout.enable, layout.force, layout.applied))
        print(f"enable={enable}  force=0x{force:04x} ({describe(force)})  applied={applied}")
        before = applied
        time.sleep(0.5)
        after = pine.r32(layout.applied)
        print(f"cave ran {after - before} time(s) in 0.5 s "
              f"({'the decode is live' if after > before else 'the decode is NOT running'})")
    return 0


def cmd_mash(args: argparse.Namespace) -> int:
    pine = Pine()
    target = resolve_target(pine)
    layout = build_layout(target)
    if not installed(pine, layout):
        raise SystemExit("pad cave is not installed")
    mask = parse_buttons(args.buttons)
    print(f"mashing {describe(mask)} for {args.seconds:.0f}s")
    mash(pine, layout, mask, args.seconds)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("install").set_defaults(func=cmd_install)
    sub.add_parser("uninstall").set_defaults(func=cmd_uninstall)
    sub.add_parser("probe").set_defaults(func=cmd_probe)
    mash_parser = sub.add_parser("mash")
    mash_parser.add_argument("--buttons", default="cross")
    mash_parser.add_argument("--seconds", type=float, default=30.0)
    mash_parser.set_defaults(func=cmd_mash)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
