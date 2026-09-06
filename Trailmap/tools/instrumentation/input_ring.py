#!/usr/bin/env python3
"""Lossless per-frame control input recording for SSX Tricky under PCSX2.

`rider_telemetry.py` samples the live rider by polling over PINE. That is fine
for statistical studies, which bin samples and take medians, but it drops a few
percent of frames: a sample that straddles a game tick is discarded, and the
retry costs enough wall time to lose the next frame outright. An input stream
cannot absorb that. A single-frame button press occupies exactly one frame, so
one lost frame silently erases a whole edge, and a golden run assembled from
"the presses the host happened to see" is not golden.

This module moves the recording into the game. A detour at site C appends one
16-byte entry per game frame to a ring buffer inside the vetted-free tail of the
noclip code cave, and the host drains it. The game writes every frame it runs,
so host timing stops mattering; all the host can do is fall far enough behind to
overrun the ring, and that is detected exactly rather than inferred.

Site C (`0x00117B7C`, SharedUpdate's control dispatch) is the capture point
because of what is already in registers there:

  s0 -> the packed control word cPlayer::GetInput just built on SharedUpdate's
        stack, which is the input the physics actually consumes -- post button
        mapping, post 6-bit quantization
  s1 -> the boarder, so the local-human gate (+0x41C == 1) is one load

The packed word is read *before* `0x0011C9A8` dispatches, because the dispatch
can change the control state that selects how the word is laid out.

Safety follows the same contract as the other probes in this directory: the
cave is observer-only and provably so (`verify_observer_only`), every write is
read back, and the pre-existing bytes are saved to a recovery record before
anything is touched.

  python tools/instrumentation/input_ring.py status
  python tools/instrumentation/input_ring.py install     # VM-paused
  python tools/instrumentation/input_ring.py arm
  python tools/instrumentation/input_ring.py watch --seconds 20
  python tools/instrumentation/input_ring.py disarm
  python tools/instrumentation/input_ring.py uninstall   # VM-paused
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

TOOLS_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS_DIR / "patches"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import debug_text_patch  # noqa: E402
import sky_color_patch  # noqa: E402
from noclip_patch import (  # noqa: E402
    TARGETS,
    Asm,
    Cave,
    Target,
    build_cave_b,
    build_cave_c,
    build_cave_d,
    hi_base,
    hi_lo,
    site_c_displaced_is_stock,
    site_is_stock,
)
from pine_hooks import SITES as NOCLIP_SITES, Pine, j_ins  # noqa: E402

MAGIC = 0x53584952  # 'RIXS' little-endian -> "SXIR" in a memory dump
RING_SCHEMA = "ssx-tricky-input-ring/v1"

#: Stand-ins for the three site-C words when a cave is assembled only to measure its length
#: (`build_layout`). Never installed: `install` reads the real words out of the emulator.
SIZING_DISPLACED = (0, 0, 0)

HEADER_BYTES = 0x10
ENTRY_BYTES = 0x10

# Header word offsets.
OFF_MAGIC = 0x00
OFF_ENABLE = 0x04
OFF_COUNT = 0x08
OFF_RESERVED = 0x0C

# Boarder fields the cave reads.
BOARDER_LOCAL_HUMAN = 0x41C
BOARDER_MOTION_STATE = 0x424
BOARDER_CONTROL_STATE = 0x428

# Cave-A pad observer outputs, relative to the noclip cave base.
PAD_MASK_OFFSET = 0x08
PAD_LX_OFFSET = 0x0C
PAD_LY_OFFSET = 0x10

INSTALL_STATE = TOOLS_DIR.parents[1] / "temp" / "telemetry" / "input-ring-state.json"

# Every store the cave emits, as (word index into the assembled cave, base
# register, offset). verify_observer_only pins the set exactly: the four entry
# stores land inside the ring by construction (see _verify_slot_math) and the
# fifth publishes the write counter into the header.
_ENTRY_STORE_OFFSETS = (0x0, 0x4, 0x8, 0xC)


# ---------------------------------------------------------------------------
# layout
# ---------------------------------------------------------------------------


def noclip_top(t: Target) -> int:
    """First address past noclip's own fragments, replaying its packing rules.

    Derived rather than tabulated: the two builds pack the same four caves at
    different bases, and a hardcoded constant would silently corrupt whichever
    build it was not written for.
    """
    cave = Cave(t)
    cave_b = build_cave_b(t, cave)
    cave_c_base = (cave.b + len(cave_b) + 15) & ~15
    cave_c = build_cave_c(t, cave, cave_c_base)
    cave_d_base = (cave_c_base + len(cave_c) + 15) & ~15
    return cave_d_base + len(build_cave_d(t, cave, cave_d_base))


def cave_reservations(t: Target) -> tuple[tuple[int, int], ...]:
    """Spans inside the noclip cave that another shipped patch already claims.

    On NTSC-U the sky-color cave lives in this same dead blob, because no code
    padding run in that build is long enough. PAL's sky cave is elsewhere.

    The debug-text cave is deliberately NOT here -- it sits in the .rodata/
    .gcc_except_table alignment gap instead, precisely so this module keeps the
    whole tail. Each reservation is read from the owning generator rather than
    tabulated, so a patch that moves or grows takes this boundary with it.
    """
    reserved = []
    for target_map, size in (
        (sky_color_patch.TARGETS, sky_color_patch.CAVE_BYTES),
        (debug_text_patch.TARGETS, debug_text_patch.CAVE_BYTES),
    ):
        other = target_map.get(t.name)
        if other is not None and t.cave_base <= other.cave < t.cave_end:
            reserved.append((other.cave, other.cave + size))
    return tuple(sorted(reserved))


def usable_region(t: Target) -> tuple[int, int]:
    """The span this module may use: past noclip, short of any other patch."""
    start = (noclip_top(t) + 7) & ~7
    end = t.cave_end
    for reserved_start, reserved_end in cave_reservations(t):
        if reserved_start < end and reserved_end > start:
            end = min(end, reserved_start)
    if end <= start:
        raise RuntimeError(f"{t.name}: no free cave space between other patches")
    return start, end


@dataclass(frozen=True)
class RingLayout:
    target: Target
    region_start: int
    region_end: int
    header: int
    ring: int
    capacity: int
    code: int
    code_bytes: int

    @property
    def magic(self) -> int:
        return self.header + OFF_MAGIC

    @property
    def enable(self) -> int:
        return self.header + OFF_ENABLE

    @property
    def count(self) -> int:
        return self.header + OFF_COUNT

    @property
    def ring_bytes(self) -> int:
        return self.capacity * ENTRY_BYTES

    @property
    def snapshot_bytes(self) -> int:
        """Header plus ring: what one drain reads."""
        return HEADER_BYTES + self.ring_bytes

    @property
    def total_bytes(self) -> int:
        return HEADER_BYTES + self.ring_bytes + self.code_bytes

    @property
    def pad_mask(self) -> int:
        return self.target.cave_base + PAD_MASK_OFFSET

    @property
    def pad_lx(self) -> int:
        return self.target.cave_base + PAD_LX_OFFSET

    @property
    def pad_ly(self) -> int:
        return self.target.cave_base + PAD_LY_OFFSET

    def seconds_of_slack(self, hz: float = 60.0) -> float:
        return self.capacity / hz


def build_layout(t: Target) -> RingLayout:
    """Place the header, ring and code inside the usable region.

    Capacity is the largest power of two that fits, because the cave turns the
    monotonic write counter into a slot with a single `andi` mask.
    """
    start, end = usable_region(t)
    header = start
    ring = header + HEADER_BYTES
    if header % 8 or ring % 8:
        raise RuntimeError(f"{t.name}: ring region is not 8-byte aligned")

    # Code length does not depend on capacity -- the mask is one immediate
    # either way -- so measure once with a trial layout and then solve.
    trial = RingLayout(t, start, end, header, ring, 2, ring + 2 * ENTRY_BYTES, 0)
    code_bytes = len(build_ring_cave(trial._replace_code(ring + 2 * ENTRY_BYTES), SIZING_DISPLACED))

    budget = end - start - HEADER_BYTES - code_bytes
    capacity = 1
    while capacity * 2 * ENTRY_BYTES <= budget:
        capacity *= 2
    if capacity < 4:
        raise RuntimeError(
            f"{t.name}: only {budget} B left for the ring; needs at least 4 entries"
        )

    layout = RingLayout(
        target=t,
        region_start=start,
        region_end=end,
        header=header,
        ring=ring,
        capacity=capacity,
        code=ring + capacity * ENTRY_BYTES,
        code_bytes=code_bytes,
    )
    if len(build_ring_cave(layout, SIZING_DISPLACED)) != code_bytes:
        raise RuntimeError("ring cave length depends on capacity; layout solver is invalid")
    if layout.total_bytes > end - start:
        raise RuntimeError(
            f"{t.name}: ring layout needs {layout.total_bytes} B of {end - start} B"
        )
    _check_single_lui_addressing(layout)
    return layout


def _replace_code(self: RingLayout, code: int) -> RingLayout:  # pragma: no cover - helper
    return RingLayout(
        self.target, self.region_start, self.region_end, self.header,
        self.ring, self.capacity, code, self.code_bytes,
    )


RingLayout._replace_code = _replace_code  # type: ignore[attr-defined]


def _check_single_lui_addressing(layout: RingLayout) -> None:
    """One `lui at` must cover every address the cave touches as a base.

    hi_base already asserts the low half stays positive; this additionally pins
    every referenced address to the same upper half, which is what makes a
    single lui legal in the first place.
    """
    base_hi, _ = hi_base(layout.header)
    for name, address in (
        ("header", layout.header),
        ("ring", layout.ring),
        ("ring end", layout.ring + layout.ring_bytes - 1),
        ("pad mask", layout.pad_mask),
        ("pad lx", layout.pad_lx),
        ("pad ly", layout.pad_ly),
    ):
        hi, lo = hi_base(address)
        if hi != base_hi:
            raise RuntimeError(
                f"{name} 0x{address:08x} is not reachable from lui 0x{base_hi:04x}"
            )
        if lo >= 0x8000:
            raise RuntimeError(f"{name} 0x{address:08x} needs a negative displacement")


# ---------------------------------------------------------------------------
# the cave
# ---------------------------------------------------------------------------


def build_ring_cave(layout: RingLayout, displaced) -> bytes:
    """Append one entry per game frame, then run site C's displaced work.

    `displaced` is the three words site C holds in the running game -- the two the
    hook overwrites and the jal's delay slot after them -- read from the emulator
    by `install` and checked by digest there. They are the game's instructions,
    which is why this module takes them as input rather than spelling them out.

    Registers: a `jal` follows the hook site, so every caller-saved register is
    already dead there; the cave uses at/t0-t7 and leaves s0 (packed word) and
    s1 (boarder) untouched for the displaced originals at the tail.

    The world-alive chain is gated at every link because SharedUpdate does run
    on half-built boarders during load and teardown.
    """
    if len(displaced) != 3:
        raise ValueError(f"site C displaces three words, got {len(displaced)}")
    t = layout.target
    a = Asm(layout.code)
    base_hi, _ = hi_base(layout.header)
    registry_hi, registry_lo = hi_lo(t.registry_ptr)

    a.lui("at", base_hi)                                # at = cave base
    a.lw("t0", layout.enable & 0xFFFF, "at")
    a.beq("t0", "zero", "done")
    a.nop()

    a.lw("t0", BOARDER_LOCAL_HUMAN, "s1")               # local human only
    a.addiu("t1", "zero", 1)
    a.bne("t0", "t1", "done")
    a.nop()

    a.lui("t2", registry_hi)                            # registry -> world -> clock -> frame
    a.lw("t2", registry_lo, "t2")
    a.beq("t2", "zero", "done")
    a.nop()
    a.lw("t2", 0x730, "t2")
    a.beq("t2", "zero", "done")
    a.nop()
    a.lw("t2", 0x01C, "t2")
    a.beq("t2", "zero", "done")
    a.nop()
    a.lw("t2", 0x018, "t2")                             # t2 = game frame

    a.lw("t3", layout.count & 0xFFFF, "at")             # monotonic write counter
    a.andi("t4", "t3", layout.capacity - 1)             # slot = count & (capacity-1)
    a.sll("t4", "t4", 4)                                # * ENTRY_BYTES
    a.addiu("t5", "at", layout.ring & 0xFFFF)
    a.addu("t4", "t4", "t5")                            # t4 = &ring[slot]

    a.sw("t2", 0x0, "t4")                               # w0: game frame
    a.lw("t5", 0, "s0")
    a.sw("t5", 0x4, "t4")                               # w1: packed control word

    a.lw("t5", layout.pad_mask & 0xFFFF, "at")          # w2: pad mask | lx<<16 | ly<<24
    a.lw("t6", layout.pad_lx & 0xFFFF, "at")
    a.lw("t7", layout.pad_ly & 0xFFFF, "at")
    a.andi("t5", "t5", 0xFFFF)
    a.andi("t6", "t6", 0x00FF)
    a.sll("t6", "t6", 16)
    a.or_("t5", "t5", "t6")
    a.andi("t7", "t7", 0x00FF)
    a.sll("t7", "t7", 24)
    a.or_("t5", "t5", "t7")
    a.sw("t5", 0x8, "t4")

    a.lw("t5", BOARDER_CONTROL_STATE, "s1")             # w3: control | motion<<8 | seq<<16
    a.lw("t6", BOARDER_MOTION_STATE, "s1")
    a.andi("t5", "t5", 0x00FF)
    a.andi("t6", "t6", 0x00FF)
    a.sll("t6", "t6", 8)
    a.or_("t5", "t5", "t6")
    a.andi("t6", "t3", 0xFFFF)
    a.sll("t6", "t6", 16)
    a.or_("t5", "t5", "t6")
    a.sw("t5", 0xC, "t4")

    a.addiu("t3", "t3", 1)
    a.sw("t3", layout.count & 0xFFFF, "at")             # publish only once whole

    a.label("done")
    for word in displaced:                              # site C's own three words, read at install
        a.word(word)
    a.j(t.site_c + 12)
    a.nop()
    return a.assemble()


# ---------------------------------------------------------------------------
# observer-only proof
# ---------------------------------------------------------------------------

# Opcodes that write memory. Anything here outside the ring would make the cave
# something other than an observer.
STORE_OPCODES = {0x28, 0x29, 0x2A, 0x2B, 0x2C, 0x2D, 0x2E, 0x2F, 0x1F, 0x39, 0x3A, 0x3E, 0x3F}
PROTECTED_BASES = {"s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "sp", "gp", "fp", "ra"}
REGISTER_NAMES = (
    "zero at v0 v1 a0 a1 a2 a3 t0 t1 t2 t3 t4 t5 t6 t7 "
    "s0 s1 s2 s3 s4 s5 s6 s7 t8 t9 k0 k1 gp sp fp ra"
).split()


class ObserverViolation(RuntimeError):
    """The assembled cave does something other than read and fill its own ring."""


def _words(blob: bytes) -> list[int]:
    return list(struct.unpack(f"<{len(blob) // 4}I", blob))


def verify_observer_only(layout: RingLayout, blob: bytes) -> None:
    """Prove, from the assembled words, that the cave only fills its own ring.

    Three things are checked, all decidable by inspection:
      * every store is either one of the four entry stores based on the slot
        pointer, or the single write-counter publish based on the cave base;
      * the slot pointer is computed as base + ring + ((count & mask) << 4), so
        the entry stores provably land inside [ring, ring + capacity*16);
      * control leaves exactly the way site C's original code would -- one jal
        to the control dispatch, no other indirect transfer, and the three
        displaced instructions reproduced byte for byte (checked by digest).
    """
    words = _words(blob)
    stores: list[tuple[int, str, int]] = []
    jals: list[int] = []
    for index, word in enumerate(words):
        opcode = word >> 26
        if opcode == 0 and (word & 0x3F) in (0x08, 0x09):
            raise ObserverViolation(
                f"word {index}: indirect transfer (jr/jalr) is not allowed in the cave"
            )
        if opcode == 0x03:
            jals.append((word & 0x03FFFFFF) << 2)
        if opcode in STORE_OPCODES:
            base = REGISTER_NAMES[(word >> 21) & 0x1F]
            offset = word & 0xFFFF
            if offset >= 0x8000:
                offset -= 0x10000
            if base in PROTECTED_BASES:
                raise ObserverViolation(
                    f"word {index}: store through preserved register {base}"
                )
            stores.append((index, base, offset))

    _verify_slot_math(layout, words)

    entry_stores = [s for s in stores if s[1] == "t4"]
    other_stores = [s for s in stores if s[1] != "t4"]
    if [offset for _, _, offset in entry_stores] != list(_ENTRY_STORE_OFFSETS):
        raise ObserverViolation(f"unexpected ring stores: {entry_stores}")
    if len(other_stores) != 1:
        raise ObserverViolation(f"expected exactly one header store, got {other_stores}")
    index, base, offset = other_stores[0]
    if base != "at" or offset != layout.count & 0xFFFF:
        raise ObserverViolation(
            f"word {index}: header store is {base}+0x{offset:x}, expected at+0x{layout.count & 0xFFFF:x}"
        )

    if jals != [layout.target.control_dispatch]:
        raise ObserverViolation(f"expected one jal to the control dispatch, got {jals}")

    tail = words[-5:]
    # The three words site C holds are checked the way the build checks a site -- by digest --
    # so this module never spells them out; the rest of the tail is the project's own code.
    if not site_c_displaced_is_stock(layout.target, tail[:3]):
        raise ObserverViolation(
            "cave tail does not re-run the three words site C displaced: "
            + " ".join(f"{w:08x}" for w in tail)
        )
    a = Asm(0)
    a.j(layout.target.site_c + 12)
    a.nop()
    if tail[3:] != _words(a.assemble()):
        raise ObserverViolation(
            "cave tail does not return to site C after its displaced work: "
            + " ".join(f"{w:08x}" for w in tail)
        )


def _verify_slot_math(layout: RingLayout, words: list[int]) -> None:
    """Pin the four instructions that build the slot pointer.

    Structural rather than symbolic: because capacity is a power of two, an
    `andi` by capacity-1 followed by `sll 4` and an add onto the ring base can
    only produce an address inside the ring, whatever the counter holds.
    """
    a = Asm(0)
    a.lw("t3", layout.count & 0xFFFF, "at")
    a.andi("t4", "t3", layout.capacity - 1)
    a.sll("t4", "t4", 4)
    a.addiu("t5", "at", layout.ring & 0xFFFF)
    a.addu("t4", "t4", "t5")
    expected = _words(a.assemble())
    for start in range(len(words) - len(expected) + 1):
        if words[start:start + len(expected)] == expected:
            return
    raise ObserverViolation("slot pointer is not computed as base + ring + (count & mask) * 16")


def stock_region_digest(t: Target, elf: Path | None = None) -> str:
    """SHA-256 of the untouched bytes this module will overwrite."""
    path = elf or (TOOLS_DIR.parents[1] / "Trailmap" / "extracted" / t.name)
    if not path.exists():
        path = TOOLS_DIR.parents[0] / "extracted" / t.name
    start, end = usable_region(t)
    data = path.read_bytes()
    offset = start - 0x00100000 + 0x1000
    return hashlib.sha256(data[offset:offset + (end - start)]).hexdigest()


# ---------------------------------------------------------------------------
# entries
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RingEntry:
    frame: int
    packed: int
    pad: int
    states: int

    @property
    def held_mask(self) -> int:
        return self.pad & 0xFFFF

    @property
    def lx(self) -> int:
        return (self.pad >> 16) & 0xFF

    @property
    def ly(self) -> int:
        return (self.pad >> 24) & 0xFF

    @property
    def control_state(self) -> int:
        return self.states & 0xFF

    @property
    def motion_state(self) -> int:
        return (self.states >> 8) & 0xFF

    @property
    def seq(self) -> int:
        return (self.states >> 16) & 0xFFFF

    def to_json(self) -> list[int]:
        return [self.frame, self.packed, self.pad, self.states]


class RingClient:
    """Host side of the ring: install, arm and drain."""

    def __init__(self, pine: Pine, layout: RingLayout):
        self.pine = pine
        self.layout = layout
        self._last_count: int | None = None

    # -- reads --

    def _read_region(self, addr: int, byte_count: int) -> list[int]:
        values = self.pine.r64_many(range(addr, addr + byte_count, 8))
        words: list[int] = []
        for value in values:
            words.extend((value & 0xFFFFFFFF, value >> 32))
        return words

    def header(self) -> tuple[int, int, int]:
        magic, enable, count, _ = self.pine.r32_many(
            (self.layout.magic, self.layout.enable, self.layout.count, self.layout.header + OFF_RESERVED)
        )
        return magic, enable, count

    def installed(self) -> bool:
        site = self.layout.target.site_c
        word0, word1, magic = self.pine.r32_many((site, site + 4, self.layout.magic))
        return word0 == j_ins(self.layout.code) and word1 == 0 and magic == MAGIC

    def status(self) -> dict[str, Any]:
        magic, enable, count = self.header()
        site = self.layout.target.site_c
        word0, word1 = self.pine.r32_many((site, site + 4))
        return {
            "schema": RING_SCHEMA,
            "target": self.layout.target.name,
            "magic": f"0x{magic:08x}",
            "magicOk": magic == MAGIC,
            "enabled": bool(enable),
            "writeCount": count,
            "capacity": self.layout.capacity,
            "slackSeconds": round(self.layout.seconds_of_slack(), 3),
            "siteC": f"{word0:08x} {word1:08x}",
            "siteCHooked": word0 == j_ins(self.layout.code) and word1 == 0,
            "region": f"0x{self.layout.region_start:08x}..0x{self.layout.region_end:08x}",
            "bytesUsed": self.layout.total_bytes,
        }

    # -- draining --

    def reset_drain_cursor(self) -> None:
        self._last_count = None

    def drain(self) -> tuple[list[RingEntry], int, int]:
        """Return (entries since the last drain, entries lost to overrun, torn slots).

        The cave publishes its write counter only after an entry is complete, so
        a counter delta is exactly how many entries were produced. Anything past
        `capacity` was overwritten before the host got to it; that is reported,
        never guessed at.
        """
        words = self._read_region(self.layout.header, self.layout.snapshot_bytes)
        magic, _enable, count = words[0], words[1], words[2]
        if magic != MAGIC:
            raise RuntimeError(
                f"input ring magic is 0x{magic:08x}, not 0x{MAGIC:08x}; "
                "the recorder is not installed (a savestate load removes it)"
            )
        slots = words[HEADER_BYTES // 4:]
        if self._last_count is None:
            self._last_count = count
            return [], 0, 0

        delta = (count - self._last_count) & 0xFFFFFFFF
        capacity = self.layout.capacity
        lost = max(0, delta - capacity)
        taken = min(delta, capacity)
        first_index = count - taken

        entries: list[RingEntry] = []
        torn = 0
        for offset in range(taken):
            index = first_index + offset
            slot = index & (capacity - 1)
            frame, packed, pad, states = slots[slot * 4:slot * 4 + 4]
            entry = RingEntry(frame, packed, pad, states)
            if entry.seq != (index & 0xFFFF):
                torn += 1
                continue
            entries.append(entry)
        self._last_count = count
        return entries, lost, torn

    # -- install / arm --

    def arm(self, enabled: bool) -> None:
        self.pine.w32(self.layout.enable, 1 if enabled else 0)
        readback = self.pine.r32(self.layout.enable)
        if readback != (1 if enabled else 0):
            raise RuntimeError(f"failed to set ring enable: read back 0x{readback:08x}")


def write_words_verified(pine: Pine, addr: int, words: Iterable[int]) -> None:
    for index, word in enumerate(words):
        address = addr + index * 4
        pine.w32(address, word)
        readback = pine.r32(address)
        if readback != word:
            raise RuntimeError(
                f"verify failed @0x{address:08x}: wrote 0x{word:08x}, read 0x{readback:08x}"
            )


def require_vm_paused(pine: Pine) -> None:
    if pine.status() != 1:
        raise RuntimeError(
            "Pause the PCSX2 VM first (Pause Emulation). SSX's own pause screen is not enough."
        )


def resolve_target(pine: Pine) -> Target:
    game_id = pine.game_id().strip()
    wanted = game_id.replace("-", "_")
    for name, target in TARGETS.items():
        if name.replace(".", "").replace("_", "") in wanted.replace(".", "").replace("_", ""):
            return target
    raise RuntimeError(f"unsupported game id {game_id!r}; expected one of {list(TARGETS)}")


def install(pine: Pine, layout: RingLayout, state_path: Path = INSTALL_STATE) -> dict[str, Any]:
    """Install the ring cave and point site C at it, saving a recovery record first."""
    require_vm_paused(pine)
    if state_path.exists():
        raise RuntimeError(
            f"{state_path} already exists; the ring is installed or a previous uninstall was "
            "interrupted. Pause the VM and run `uninstall`."
        )
    # The cave re-executes the three words site C holds, so they are read from the game
    # first -- the two the hook overwrites and the jal's delay slot -- and checked by digest
    # before anything is built around them. A site that already carries this ring's hook has
    # lost them: without the recovery record there is nothing to copy, so that is refused too.
    site = layout.target.site_c
    displaced = pine.r32_many((site, site + 4, site + 8))
    site_words = displaced[:2]
    if tuple(site_words) == (j_ins(layout.code), 0):
        raise RuntimeError(
            "site C already holds this ring's hook and no recovery record exists, so the words it "
            "displaced cannot be read back; restart the emulator and install again"
        )
    if not site_is_stock(layout.target, 2, site_words):
        raise RuntimeError(
            f"site C is 0x{site_words[0]:08x} 0x{site_words[1]:08x}, neither stock nor this ring; "
            "refusing to overwrite an unknown hook"
        )
    if not site_c_displaced_is_stock(layout.target, displaced):
        raise RuntimeError(
            "site C reads stock but the delay slot after it does not; refusing to build a cave "
            "around words this build is not known to hold"
        )
    blob = build_ring_cave(layout, displaced)
    verify_observer_only(layout, blob)

    region_words = _read_words(pine, layout.region_start, (layout.region_end - layout.region_start) // 4)
    saved = {
        "kind": "ssx-tricky-input-ring-state",
        "schema": RING_SCHEMA,
        "savedAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "gameId": pine.game_id(),
        "target": layout.target.name,
        "regionStart": f"0x{layout.region_start:08x}",
        "regionWords": [f"0x{word:08x}" for word in region_words],
        "siteC": [f"0x{word:08x}" for word in site_words],
        "layout": layout_summary(layout),
    }
    state_path.parent.mkdir(parents=True, exist_ok=True)
    state_path.write_text(json.dumps(saved, indent=2) + "\n", encoding="utf-8")

    try:
        # Header first with the ring disarmed, then the code, then the hook: at
        # no point can the site branch into a half-written cave.
        write_words_verified(pine, layout.header, (MAGIC, 0, 0, 0))
        write_words_verified(pine, layout.ring, [0] * (layout.ring_bytes // 4))
        write_words_verified(pine, layout.code, _words(blob))
        write_words_verified(pine, site, (j_ins(layout.code), 0))
    except Exception:
        try:
            write_words_verified(pine, site, site_words)
            write_words_verified(pine, layout.region_start, region_words)
            state_path.unlink(missing_ok=True)
        except Exception as rollback_error:  # pragma: no cover - live-only path
            raise RuntimeError(
                f"install failed and rollback also failed ({rollback_error}); "
                f"{state_path} is retained, pause the VM and run `uninstall`"
            )
        raise
    return saved


def uninstall(pine: Pine, state_path: Path = INSTALL_STATE) -> None:
    """Restore site C and the cave region to exactly what install found."""
    require_vm_paused(pine)
    if not state_path.exists():
        raise RuntimeError(f"no recovery record at {state_path}; nothing to restore")
    saved = json.loads(state_path.read_text(encoding="utf-8"))
    if saved.get("gameId") != pine.game_id():
        raise RuntimeError(
            f"recovery record is for {saved.get('gameId')!r}, running {pine.game_id()!r}"
        )
    site = TARGETS[saved["target"]].site_c
    site_words = [int(word, 16) for word in saved["siteC"]]
    region_words = [int(word, 16) for word in saved["regionWords"]]
    # Sites before caves, so nothing can branch into a region being rewritten.
    write_words_verified(pine, site, site_words)
    write_words_verified(pine, int(saved["regionStart"], 16), region_words)
    state_path.unlink()


def _read_words(pine: Pine, addr: int, count: int) -> list[int]:
    return pine.r32_many(addr + index * 4 for index in range(count))


def layout_summary(layout: RingLayout) -> dict[str, Any]:
    return {
        "target": layout.target.name,
        "region": [f"0x{layout.region_start:08x}", f"0x{layout.region_end:08x}"],
        "header": f"0x{layout.header:08x}",
        "ring": f"0x{layout.ring:08x}",
        "capacity": layout.capacity,
        "entryBytes": ENTRY_BYTES,
        "code": f"0x{layout.code:08x}",
        "codeBytes": layout.code_bytes,
        "totalBytes": layout.total_bytes,
        "freeBytes": layout.region_end - layout.region_start,
        "slackSeconds": round(layout.seconds_of_slack(), 3),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def cmd_layout(args: argparse.Namespace) -> int:
    for name, target in TARGETS.items():
        layout = build_layout(target)
        summary = layout_summary(layout)
        print(f"{name}:")
        for key, value in summary.items():
            print(f"  {key}: {value}")
        verify_observer_only(layout)
        print("  observerOnly: verified")
        noclip_state = "reserved" if cave_reservations(target) else "none"
        print(f"  otherPatchesInCave: {noclip_state}")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    pine = Pine()
    layout = build_layout(resolve_target(pine))
    for key, value in RingClient(pine, layout).status().items():
        print(f"{key}: {value}")
    print(f"state file: {'present' if INSTALL_STATE.exists() else 'absent'}")
    return 0


def cmd_install(args: argparse.Namespace) -> int:
    pine = Pine()
    layout = build_layout(resolve_target(pine))
    install(pine, layout)
    print(f"input ring installed: {layout.capacity} entries "
          f"({layout.seconds_of_slack():.2f} s of slack), site C -> 0x{layout.code:08x}")
    print(f"recovery record: {INSTALL_STATE}")
    print("Run `arm` once the VM is resumed and you are in a course.")
    return 0


def cmd_uninstall(args: argparse.Namespace) -> int:
    pine = Pine()
    uninstall(pine)
    print("input ring removed; site C and the cave region restored")
    return 0


def cmd_arm(args: argparse.Namespace) -> int:
    pine = Pine()
    layout = build_layout(resolve_target(pine))
    client = RingClient(pine, layout)
    if not client.installed():
        raise RuntimeError("input ring is not installed; run `install` with the VM paused")
    client.arm(args.command == "arm")
    print(f"input ring {'armed' if args.command == 'arm' else 'disarmed'}")
    return 0


def cmd_watch(args: argparse.Namespace) -> int:
    pine = Pine()
    layout = build_layout(resolve_target(pine))
    client = RingClient(pine, layout)
    client.drain()
    deadline = time.monotonic() + args.seconds
    total = lost_total = torn_total = 0
    gaps = 0
    previous_frame: int | None = None
    while time.monotonic() < deadline:
        entries, lost, torn = client.drain()
        total += len(entries)
        lost_total += lost
        torn_total += torn
        for entry in entries:
            if previous_frame is not None and entry.frame != (previous_frame + 1) & 0xFFFFFFFF:
                gaps += 1
            previous_frame = entry.frame
        if entries and args.verbose:
            last = entries[-1]
            print(f"frame {last.frame} packed=0x{last.packed:08x} mask=0x{last.held_mask:04x} "
                  f"lx={last.lx} ly={last.ly} ctl={last.control_state} motion={last.motion_state}")
        time.sleep(args.interval)
    print(f"entries={total} lost={lost_total} torn={torn_total} frameGaps={gaps}")
    return 0 if lost_total == 0 and torn_total == 0 else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("layout", help="print the computed cave layout for every target")
    sub.add_parser("status", help="show the live ring header and site C state")
    sub.add_parser("install", help="VM-paused: install the ring cave and hook site C")
    sub.add_parser("uninstall", help="VM-paused: restore site C and the cave region")
    sub.add_parser("arm", help="start recording into the ring")
    sub.add_parser("disarm", help="stop recording into the ring")
    watch = sub.add_parser("watch", help="drain the ring and report contiguity")
    watch.add_argument("--seconds", type=float, default=10.0)
    watch.add_argument("--interval", type=float, default=0.05)
    watch.add_argument("--verbose", action="store_true")
    return parser


COMMANDS = {
    "layout": cmd_layout,
    "status": cmd_status,
    "install": cmd_install,
    "uninstall": cmd_uninstall,
    "arm": cmd_arm,
    "disarm": cmd_arm,
    "watch": cmd_watch,
}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return COMMANDS[args.command](args)


if __name__ == "__main__":
    raise SystemExit(main())
