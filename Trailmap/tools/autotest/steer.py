#!/usr/bin/env python3
"""Force the packed control word the physics consumes, so a run can CARVE with no human.

The unsteered instrument pass (AUTOTEST4) measured the clean-riding baseline of the board-audio signals and
stopped there by construction: Slip and Lean sit near zero down a straight fall line, so the carving half of
every SNOW.INF program was unreachable. This module is the other half — a cave at site C that replaces the
packed control word with a forced one, which makes the rider hold an edge on demand.

## The site, and why the word is total

Site C (`0x00117B7C`, SharedUpdate's control dispatch) is where `input_ring.py` already reads the word,
because of what is in registers there: `s0` points at the packed control word `cPlayer::GetInput` just built
on SharedUpdate's stack — post button mapping, post 6-bit quantization — and `s1` is the boarder, so the
local-human gate is one load. The cave stores the forced word over `[s0]` before the control-state dispatch
reads it, so the physics consumes OUR word exactly as it would the pad's: same quantization, same per-state
interpretation, no separate channel [Trailmap: 395-ai-riders — the AI steers through this same word].

The word layout is the traced one: the turn axis is bits 5–10, 6-bit signed, full deflection ±31 (the human
ground control recovers it as `((word << 21) >> 26) / 31.0`). A forced word also replaces the button bits —
deliberately: a steered measurement run wants nothing pressed, so the whole word is authored rather than
merged.

## Install order is site C's own, not site A's

`pad_drive.py` hooks its site by writing the `j` first, and its safety argument does not transfer here:
site C's SECOND word is a `jal`, so a half-written hook would put a jump in a jump's delay slot — undefined
on the R5900. The order that can never form a branch hazard is the reverse: neutralize the `jal` first (for
a tick or two each rider skips its control dispatch — one dropped input frame), then write the `j`. The
uninstall mirrors it.

## Honesty

A steered pass is not a stock-executable pass. The report carries a `steered` field describing the pattern,
and a steered run is an instrument for the signal analyzer — it is not a regression batch and should not be
tallied with unsteered passes.

  python tools/autotest/steer.py probe        # site C state + whether the cave is live
  python tools/autotest/run.py --fixture AUTOTEST4 --weave   # the intended consumer
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
from noclip_patch import TARGETS, Asm, Target, hi_base, site_c_displaced_is_stock, site_is_stock  # noqa: E402
from input_ring import SIZING_DISPLACED, usable_region  # noqa: E402
from pine_hooks import Pine, j_ins  # noqa: E402

MAGIC = 0x53544552  # "RETS" in a memory dump -> 'STER' little-endian

OFF_MAGIC = 0x00
OFF_ENABLE = 0x04
OFF_FORCE = 0x08
OFF_APPLIED = 0x0C
CODE_OFFSET = 0x10

BOARDER_LOCAL_HUMAN = 0x41C

#: The turn axis: bits 5-10 of the packed word, 6-bit signed, full deflection +/-31
#: [Trailmap: 395-ai-riders [[395-word]]].
TURN_SHIFT = 5
TURN_FULL = 31

STATE_FILE = TOOLS.parents[1] / "Trailmap" / "temp" / "autotest" / "steer-state.json"

NOP = 0x00000000


def turn_word(quantized: int) -> int:
    """The packed control word for a held turn and nothing else pressed."""
    if not -TURN_FULL <= quantized <= TURN_FULL:
        raise ValueError(f"turn {quantized} is outside the 6-bit +/-31 range")
    return (quantized & 0x3F) << TURN_SHIFT


@dataclass(frozen=True)
class SteerLayout:
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


def build_layout(target: Target) -> SteerLayout:
    start, end = usable_region(target)
    layout = SteerLayout(target=target, header=start)
    size = CODE_OFFSET + len(build_steer_cave(layout, SIZING_DISPLACED))
    if start + size > end:
        raise RuntimeError(f"{target.name}: steer cave needs {size} B of {end - start} B")
    base_hi, _ = hi_base(layout.header)
    for name, address in (("header", layout.header), ("applied", layout.applied)):
        hi, lo = hi_base(address)
        if hi != base_hi or lo >= 0x8000:
            raise RuntimeError(f"{name} 0x{address:08x} is not reachable from one lui")
    return layout


def build_steer_cave(layout: SteerLayout, displaced) -> bytes:
    """Replace the packed control word for the local human, then run site C's displaced work.

    `displaced` is the three words site C holds in the running game — the two the hook overwrites and the
    jal's delay slot after them — read from the emulator by `install` and checked by digest there. They are
    the game's instructions, which is why this module takes them as input rather than spelling them out.

    Registers: a `jal` follows the hook site, so every caller-saved register is dead; the cave uses at/t0/t1
    and leaves s0 (the word's address) and s1 (the boarder) for the displaced originals at the tail —
    exactly the register discipline `input_ring.py` proved at this same site.
    """
    if len(displaced) != 3:
        raise ValueError(f"site C displaces three words, got {len(displaced)}")
    t = layout.target
    a = Asm(layout.code)
    base_hi, _ = hi_base(layout.header)

    a.lui("at", base_hi)
    a.lw("t0", layout.enable & 0xFFFF, "at")
    a.beq("t0", "zero", "done")
    a.nop()

    a.lw("t0", BOARDER_LOCAL_HUMAN, "s1")               # the local human only: site C runs per rider
    a.addiu("t1", "zero", 1)
    a.bne("t0", "t1", "done")
    a.nop()

    a.lw("t0", layout.applied & 0xFFFF, "at")           # proof the cave is live, independent of steering
    a.addiu("t0", "t0", 1)
    a.sw("t0", layout.applied & 0xFFFF, "at")

    a.lw("t0", layout.force & 0xFFFF, "at")
    a.sw("t0", 0, "s0")                                 # the one game store: the packed control word

    a.label("done")
    for word in displaced:                              # site C's own three words, read at install
        a.word(word)
    a.j(t.site_c + 12)
    a.nop()
    return a.assemble()


class BoundedWriterViolation(RuntimeError):
    """The assembled cave stores somewhere it was not authorized to."""


STORE_OPCODES = {0x28, 0x29, 0x2A, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F, 0x1F, 0x39, 0x3A, 0x3E, 0x3F}
REGISTERS = (
    "zero at v0 v1 a0 a1 a2 a3 t0 t1 t2 t3 t4 t5 t6 t7 "
    "s0 s1 s2 s3 s4 s5 s6 s7 t8 t9 k0 k1 gp sp fp ra"
).split()


def verify_bounded_writer(layout: SteerLayout, blob: bytes) -> None:
    """Prove the cave writes only its own counter and the one word it exists to force.

    An injector cannot be an observer, so the available property is an exact allow-list, checked against the
    assembled words. The tail is additionally pinned to site C's displaced work byte for byte, exactly as
    `input_ring.verify_observer_only` pins its own — a cave that leaves the site any other way is a detour,
    not a hook.
    """
    words = list(struct.unpack(f"<{len(blob) // 4}I", blob))
    allowed = {
        ("at", layout.applied & 0xFFFF, 0x2B),   # the liveness counter
        ("s0", 0x0, 0x2B),                        # the packed control word: the whole point
    }
    seen = []
    for index, word in enumerate(words):
        opcode = word >> 26
        if opcode == 0 and (word & 0x3F) in (0x08, 0x09):
            raise BoundedWriterViolation(f"word {index}: indirect transfer is not allowed in the cave")
        if opcode not in STORE_OPCODES:
            continue
        base = REGISTERS[(word >> 21) & 0x1F]
        offset = word & 0xFFFF
        entry = (base, offset, opcode)
        seen.append((index, entry))
        if entry not in allowed:
            raise BoundedWriterViolation(
                f"word {index} (0x{word:08x}) stores to {base}+0x{offset:x}, outside the allow-list")
    if len(seen) != 2:
        raise BoundedWriterViolation(f"expected exactly 2 stores, found {len(seen)}: {seen}")

    tail = words[-5:]
    # The three words site C holds are checked by digest, as the build checks a site, so this module never
    # spells them out; the rest of the tail is the project's own code.
    if not site_c_displaced_is_stock(layout.target, tail[:3]):
        raise BoundedWriterViolation(
            "cave tail does not re-run the three words site C displaced: " + " ".join(f"{w:08x}" for w in tail))
    a = Asm(0)
    a.j(layout.target.site_c + 12)
    a.nop()
    if tail[3:] != list(struct.unpack(f"<{len(tail) - 3}I", a.assemble())):
        raise BoundedWriterViolation(
            "cave tail does not return to site C after its displaced work: " + " ".join(f"{w:08x}" for w in tail))


def resolve_target(pine: Pine) -> Target:
    wanted = pine.game_id().strip().replace("-", "_")
    for name, target in TARGETS.items():
        if name.replace(".", "").replace("_", "") in wanted.replace(".", "").replace("_", ""):
            return target
    raise RuntimeError(f"unsupported game id {pine.game_id()!r}")


def write_verified(pine: Pine, addr: int, words) -> None:
    for index, word in enumerate(words):
        address = addr + index * 4
        pine.w32(address, word)
        readback = pine.r32(address)
        if readback != word:
            raise RuntimeError(f"verify failed @0x{address:08x}: wrote 0x{word:08x}, read 0x{readback:08x}")


def installed(pine: Pine, layout: SteerLayout) -> bool:
    site = layout.target.site_c
    word0, word1, magic = pine.r32_many((site, site + 4, layout.magic))
    return word0 == j_ins(layout.code) and word1 == NOP and magic == MAGIC


def install(pine: Pine, layout: SteerLayout, state_path: Path = STATE_FILE) -> None:
    """Install the cave live, in the order site C itself dictates.

    Site A's `j`-first ordering would be a fault here: site C's second word is a `jal`, and executing a
    half-written hook would put that jal in the new jump's delay slot — a branch in a branch delay slot,
    undefined on the R5900. So the jal is NEUTRALIZED first: with `[lw][nop][daddu]` in place each rider
    skips its control dispatch for the tick or two before the `j` lands (one dropped input frame, the same
    thing a missed pad read costs), and no instant exists in which a branch hazard can form.
    """
    # The cave re-executes the three words site C holds, so they are read from the game first — the two the
    # hook overwrites and the jal's delay slot — and checked by digest before anything is built around them.
    site = layout.target.site_c
    displaced = pine.r32_many((site, site + 4, site + 8))
    site_words = displaced[:2]
    stock = site_is_stock(layout.target, 2, site_words)
    if state_path.exists():
        # Same arbiter as pad_drive: the ELF is streamed fresh off the ISO at every launch, so a record left
        # by a dead emulator describes bytes that no longer exist anywhere. Stock site = stale record.
        if stock:
            print(f"note: discarding a stale steer record ({state_path.name}); site C is stock")
            state_path.unlink()
        else:
            raise RuntimeError(f"{state_path} exists; the cave is installed or an uninstall was interrupted")
    if not stock:
        if tuple(site_words) == (j_ins(layout.code), NOP):
            # The site already carries this cave's hook and its record is gone, so the words it displaced
            # cannot be read back; there is nothing to build a cave around.
            raise RuntimeError(
                "site C already holds this cave's hook and no recovery record exists; restart the emulator "
                "and install again")
        raise RuntimeError(
            f"site C is 0x{site_words[0]:08x} 0x{site_words[1]:08x}, neither stock nor this cave; "
            "refusing to overwrite an unknown hook (an input ring left installed also lands here)")
    if not site_c_displaced_is_stock(layout.target, displaced):
        raise RuntimeError(
            "site C reads stock but the delay slot after it does not; refusing to build a cave around words "
            "this build is not known to hold")
    blob = build_steer_cave(layout, displaced)
    verify_bounded_writer(layout, blob)

    span = CODE_OFFSET + len(blob)
    region_words = pine.r32_many(layout.header + index * 4 for index in range(span // 4))
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps({
        "kind": "ssx-tricky-steer-state",
        "savedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "gameId": pine.game_id(),
        "target": layout.target.name,
        "header": f"0x{layout.header:08x}",
        "regionWords": [f"0x{word:08x}" for word in region_words],
        "siteC": [f"0x{word:08x}" for word in site_words],
    }, indent=2) + "\n", encoding="utf-8")

    try:
        # Header disarmed first, then code, then the site in the hazard-free order described above.
        write_verified(pine, layout.header, (MAGIC, 0, 0, 0))
        write_verified(pine, layout.code, struct.unpack(f"<{len(blob) // 4}I", blob))
        write_verified(pine, site + 4, (NOP,))
        write_verified(pine, site, (j_ins(layout.code),))
    except Exception:
        try:
            write_verified(pine, site, site_words[:1])
            write_verified(pine, site + 4, site_words[1:])
            write_verified(pine, layout.header, region_words)
            state_path.unlink(missing_ok=True)
        except Exception as rollback_error:
            raise RuntimeError(
                f"install failed and rollback also failed ({rollback_error}); {state_path} retained")
        raise


def uninstall(pine: Pine, state_path: Path = STATE_FILE) -> None:
    """Restore site C and the cave region — the install's ordering, mirrored."""
    if not state_path.exists():
        raise RuntimeError(f"no recovery record at {state_path}")
    saved = json.loads(state_path.read_text(encoding="utf-8"))
    target = TARGETS[saved["target"]]
    site_words = [int(word, 16) for word in saved["siteC"]]
    # First word back first: `[lw][nop][daddu]` skips the dispatch for a tick and forms no hazard; then the
    # jal. The cave region is restored only after a beat, so a rider mid-cave has left it.
    write_verified(pine, target.site_c, site_words[:1])
    write_verified(pine, target.site_c + 4, site_words[1:])
    time.sleep(0.05)
    write_verified(pine, int(saved["header"], 16), [int(word, 16) for word in saved["regionWords"]])
    state_path.unlink()


class Weaver:
    """The steering schedule: hold left, glide, hold right, glide — on the GAME clock.

    The cave applies the forced word every frame; the host only has to change it when the phase does, so the
    resolution of the weave is the game's own 60 Hz however sparsely the host ticks. Timing comes from the
    caller's `now` (game seconds from the sampler), not the wall clock, so the pattern survives turbo the
    same way the sampling window does.
    """

    def __init__(self, pine: Pine, hold: float = 1.0, rest: float = 1.5, deflection: int = TURN_FULL):
        # The duty cycle is a descent budget. A held full-lock edge SCRUBS: at hold=2/rest=0.5 the first
        # steered ride made ~4 m/s of course progress and the showoff timer (~128 s) ended it one strip in.
        # Lean saturates well inside a second, so a 1 s hold measures the same carve and the 1.5 s glide
        # between edges keeps the rider moving down the mountain.
        self.pine = pine
        self.hold = hold
        self.rest = rest
        self.deflection = deflection
        self.layout = build_layout(resolve_target(pine))
        self._current: int | None = None

    def describe(self) -> str:
        return (f"weave hold={self.hold:g}s rest={self.rest:g}s "
                f"deflection={self.deflection}/{TURN_FULL} (turn axis only, no buttons)")

    def install(self) -> None:
        install(self.pine, self.layout)
        self.pine.w32(self.layout.enable, 1)

    def tick(self, now: float) -> None:
        period = 2 * (self.hold + self.rest)
        phase = now % period
        if phase < self.hold:
            quantized = self.deflection
        elif phase < self.hold + self.rest:
            quantized = 0
        elif phase < 2 * self.hold + self.rest:
            quantized = -self.deflection
        else:
            quantized = 0
        word = turn_word(quantized)
        if word == self._current:
            return
        if self.pine.r32(self.layout.magic) != MAGIC:
            raise RuntimeError(
                f"the steer cave at 0x{self.layout.header:08x} was overwritten while armed; "
                "site C is pointing at code that is no longer ours")
        self.pine.w32(self.layout.force, word)
        self._current = word

    def remove(self) -> None:
        try:
            self.pine.w32(self.layout.enable, 0)
        finally:
            uninstall(self.pine)


def cmd_probe(_: argparse.Namespace) -> int:
    pine = Pine()
    target = resolve_target(pine)
    layout = build_layout(target)
    site_words = pine.r32_many((target.site_c, target.site_c + 4))
    live = installed(pine, layout)
    state = ("hooked" if live
             else "stock" if site_is_stock(target, 2, site_words) else "unknown")
    print(f"site C: 0x{site_words[0]:08x} 0x{site_words[1]:08x} [{state}]")
    if live:
        enable, force, applied = pine.r32_many((layout.enable, layout.force, layout.applied))
        turn = (force >> TURN_SHIFT) & 0x3F
        turn -= 0x40 if turn >= 0x20 else 0
        print(f"enable={enable}  force=0x{force:08x} (turn {turn:+d}/31)  applied={applied}")
        before = applied
        time.sleep(0.5)
        after = pine.r32(layout.applied)
        print(f"cave ran {after - before} time(s) in 0.5 s "
              f"({'the dispatch is live' if after > before else 'the dispatch is NOT running'})")
    return 0


def cmd_uninstall(_: argparse.Namespace) -> int:
    uninstall(Pine())
    print("site C and its cave region restored exactly")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("probe").set_defaults(func=cmd_probe)
    sub.add_parser("uninstall").set_defaults(func=cmd_uninstall)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
