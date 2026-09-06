#!/usr/bin/env python3
"""Offline tests for the per-frame input ring.

The live half needs PCSX2, but everything that decides whether the cave is safe
to run is decidable here: the assembled words, the layout arithmetic, the
observer-only proof and the drain's overrun accounting.
"""

from __future__ import annotations

import hashlib
import struct
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(TOOLS / "patches"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import input_ring as ring  # noqa: E402
from noclip_patch import TARGETS, Asm, site_c_displaced_is_stock, vaddr_to_off  # noqa: E402
from pine_hooks import j_ins  # noqa: E402

PAL = TARGETS["SLES_505.45"]
NTSC = TARGETS["SLUS_203.26"]
ELF_DIR = TOOLS.parent / "extracted"

# The exact cave for PAL. Regenerate deliberately, never to make a test pass:
# every word here is an instruction that will run inside SharedUpdate. The three
# words site C's branch displaces are the game's, so they are not written down:
# RETAIL marks their slots, and CaveTests pins them by digest instead.
RETAIL = None
PAL_CAVE_WORDS = (
    0x3C01002B, 0x8C284EBC, 0x1100002F, 0x00000000, 0x8E28041C,
    0x24090001, 0x1509002B, 0x00000000, 0x3C0A0034, 0x8D4A8E58,
    0x11400027, 0x00000000, 0x8D4A0730, 0x11400024, 0x00000000,
    0x8D4A001C, 0x11400021, 0x00000000, 0x8D4A0018, 0x8C2B4EC0,
    0x316C000F, 0x000C6100, 0x242D4EC8, 0x018D6021, 0xAD8A0000,
    0x8E0D0000, 0xAD8D0004, 0x8C2D4C48, 0x8C2E4C4C, 0x8C2F4C50,
    0x31ADFFFF, 0x31CE00FF, 0x000E7400, 0x01AE6825, 0x31EF00FF,
    0x000F7E00, 0x01AF6825, 0xAD8D0008, 0x8E2D0428, 0x8E2E0424,
    0x31AD00FF, 0x31CE00FF, 0x000E7200, 0x01AE6825, 0x316EFFFF,
    0x000E7400, 0x01AE6825, 0xAD8D000C, 0x256B0001, 0xAC2B4EC0,
    RETAIL, RETAIL, RETAIL, 0x08045EE2, 0x00000000,
)


def words_of(blob: bytes) -> list[int]:
    return list(struct.unpack(f"<{len(blob) // 4}I", blob))


def displaced_words(target) -> tuple[int, int, int] | None:
    """The three site-C words a cave re-executes, read from the locally extracted executable.

    They are the game's, so they are never written down here: a clone without the executable
    skips the tests that need a real cave, and a clone with one checks them by digest first,
    exactly as `install` checks what it reads from the emulator.
    """
    elf = ELF_DIR / target.name
    if not elf.is_file():
        return None
    words = struct.unpack_from("<3I", elf.read_bytes(), vaddr_to_off(target.site_c))
    if not site_c_displaced_is_stock(target, words):
        raise AssertionError(f"{elf} does not hold the stock words at site C")
    return words


def cave_for(test: unittest.TestCase, target) -> tuple[ring.RingLayout, list[int]]:
    displaced = displaced_words(target)
    if displaced is None:
        test.skipTest(f"{ELF_DIR / target.name} not extracted; see the repo README")
    layout = ring.build_layout(target)
    return layout, words_of(ring.build_ring_cave(layout, displaced))


class AsmEncodingTests(unittest.TestCase):
    """The mnemonics added for this cave, against real retail instructions.

    Ground truth is the game's own code, not hand arithmetic: each expected
    encoding is pinned by the SHA-256 of the word SLES_505.45 holds at the
    address in the comment, the way a hook site is pinned, so the word itself
    is not written down here.
    """

    def test_new_mnemonics_match_retail_encodings(self) -> None:
        cases = (
            ("or_", ("s4", "s4", "v1"),      # 0x00118578  or   s4, s4, v1
             "1189c805c9127f2ff2596674adeb365fd3a9919ca0885300a136906b84816b14"),
            ("ori", ("at", "at", 0x8889),    # 0x00117234  ori  at, at, 0x8889
             "870c8cdcfd45ed65a065bd4e8298ffe3ddb0999c819b62a35bf4603e7f8d4800"),
            ("sb", ("v0", 0, "s2"),          # 0x0017b14c  sb   v0, 0(s2)
             "5b808977ff85bdba4aaf620d7950ba0eaa521eaf16751f85a3354450deed1981"),
            ("lbu", ("v0", 29, "v1"),        # 0x0011b068  lbu  v0, 29(v1)
             "def4f87991fdf158f9499cf7219b0f6f0422faf9ac69abe0bb9b7a9e4d24f51c"),
        )
        for name, args, expected in cases:
            with self.subTest(mnemonic=name):
                a = Asm(0)
                getattr(a, name)(*args)
                self.assertEqual(hashlib.sha256(a.assemble()).hexdigest(), expected)

    def test_ori_reproduces_the_hand_encoded_fconst_word(self) -> None:
        a = Asm(0)
        a.ori("at", "at", 0x1234)
        self.assertEqual(words_of(a.assemble()), [0x34210000 | 0x1234])


class LayoutTests(unittest.TestCase):
    def test_pal_layout_fits_the_vetted_free_tail(self) -> None:
        layout = ring.build_layout(PAL)
        self.assertEqual(layout.region_start, 0x002B4EB8)
        self.assertEqual(layout.region_end, PAL.cave_end)
        self.assertEqual(layout.capacity, 16)
        self.assertLessEqual(layout.total_bytes, layout.region_end - layout.region_start)

    def test_ntsc_layout_stops_short_of_the_sky_color_cave(self) -> None:
        # On NTSC-U the sky patch lives in this same dead blob; overlapping it
        # would corrupt whichever patch was installed second.
        layout = ring.build_layout(NTSC)
        reservations = ring.cave_reservations(NTSC)
        self.assertTrue(reservations, "NTSC-U should reserve the sky-color cave")
        self.assertLessEqual(layout.region_end, reservations[0][0])
        self.assertLess(layout.code + layout.code_bytes, reservations[0][0])

    def test_pal_has_no_reservation(self) -> None:
        self.assertEqual(ring.cave_reservations(PAL), ())

    def test_every_layout_is_aligned_and_power_of_two(self) -> None:
        for target in TARGETS.values():
            with self.subTest(target=target.name):
                layout = ring.build_layout(target)
                self.assertEqual(layout.header % 8, 0)
                self.assertEqual(layout.ring % 8, 0)
                self.assertEqual(layout.snapshot_bytes % 8, 0)
                self.assertEqual(layout.capacity & (layout.capacity - 1), 0)
                self.assertGreaterEqual(layout.capacity, 4)

    def test_layout_never_overlaps_noclip(self) -> None:
        for target in TARGETS.values():
            with self.subTest(target=target.name):
                layout = ring.build_layout(target)
                self.assertGreaterEqual(layout.region_start, ring.noclip_top(target))

    def test_code_length_is_independent_of_capacity(self) -> None:
        # build_layout solves for capacity assuming this; if a future edit makes
        # the cave's size depend on capacity the solver silently mis-sizes.
        layout = ring.build_layout(PAL)
        for capacity in (4, 8, 16):
            variant = ring.RingLayout(
                PAL, layout.region_start, layout.region_end, layout.header,
                layout.ring, capacity, layout.ring + capacity * ring.ENTRY_BYTES,
                layout.code_bytes,
            )
            self.assertEqual(len(ring.build_ring_cave(variant, ring.SIZING_DISPLACED)), layout.code_bytes)


class CaveTests(unittest.TestCase):
    def test_pal_cave_matches_the_golden_words(self) -> None:
        _, words = cave_for(self, PAL)
        self.assertEqual(len(words), len(PAL_CAVE_WORDS))
        for index, (expected, actual) in enumerate(zip(PAL_CAVE_WORDS, words)):
            if expected is not RETAIL:
                self.assertEqual(actual, expected, f"word {index}")

    def test_cave_reproduces_site_c_displaced_work(self) -> None:
        _, words = cave_for(self, PAL)
        # The three words the hook displaces, checked the way the build itself checks a site: by
        # digest, so the expected encodings live in PAL's digest table and nowhere else.
        self.assertTrue(site_c_displaced_is_stock(PAL, words[-5:-2]),
                        "the cave must re-run the three words site C displaced")
        self.assertEqual(words[-2], j_ins(PAL.site_c + 12))
        self.assertEqual(words[-1], 0)

    def test_sizing_stand_ins_never_pass_as_a_real_cave(self) -> None:
        # The zero words `build_layout` measures with must be refused by the observer proof, so a
        # cave assembled for its length alone can never be the one that gets installed.
        layout = ring.build_layout(PAL)
        with self.assertRaises(ring.ObserverViolation):
            ring.verify_observer_only(layout, ring.build_ring_cave(layout, ring.SIZING_DISPLACED))

    def test_cave_preserves_the_registers_the_tail_needs(self) -> None:
        # s0 (the packed word pointer) and s1 (the boarder) must survive to the
        # displaced tail, which dereferences both. Only instructions that
        # actually write a register are considered: a store or a branch naming
        # s1 reads it, which is exactly what this cave is supposed to do.
        writes_rt = {0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F,   # addi..lui
                     0x20, 0x21, 0x23, 0x24, 0x25, 0x27, 0x37}         # loads
        _, words = cave_for(self, PAL)
        for word in words:
            opcode = word >> 26
            if opcode == 0:
                if (word & 0x3F) in (0x08, 0x09):      # jr / jalr write no GPR here
                    continue
                written = (word >> 11) & 0x1F
            elif opcode in writes_rt:
                written = (word >> 16) & 0x1F
            else:
                continue
            self.assertNotIn(
                ring.REGISTER_NAMES[written], ("s0", "s1"),
                f"cave clobbers a register the displaced tail needs: 0x{word:08x}",
            )

    def test_observer_only_passes_for_every_target(self) -> None:
        for target in TARGETS.values():
            with self.subTest(target=target.name):
                layout, words = cave_for(self, target)
                ring.verify_observer_only(layout, struct.pack(f"<{len(words)}I", *words))


class ObserverViolationTests(unittest.TestCase):
    """Each negative case is a real way the cave could stop being an observer."""

    def setUp(self) -> None:
        self.layout, self.words = cave_for(self, PAL)

    def mutated(self, index: int, word: int) -> bytes:
        words = list(self.words)
        words[index] = word
        return struct.pack(f"<{len(words)}I", *words)

    def find(self, predicate) -> int:
        for index, word in enumerate(self.words):
            if predicate(word):
                return index
        self.fail("no matching instruction in the cave")

    def rebase_first_store(self, register: str) -> bytes:
        index = self.find(lambda w: w >> 26 == 0x2B)
        rebased = (self.words[index] & ~(0x1F << 21)) | (ring.REGISTER_NAMES.index(register) << 21)
        return self.mutated(index, rebased)

    def test_store_through_the_boarder_is_rejected(self) -> None:
        # Assert the message, not just the exception: the structural ring-store
        # check would also reject this, so only the message proves the
        # preserved-register guard itself is doing work.
        with self.assertRaises(ring.ObserverViolation) as caught:
            ring.verify_observer_only(self.layout, self.rebase_first_store("s1"))
        self.assertIn("preserved register s1", str(caught.exception))

    def test_store_through_the_stack_is_rejected(self) -> None:
        with self.assertRaises(ring.ObserverViolation) as caught:
            ring.verify_observer_only(self.layout, self.rebase_first_store("sp"))
        self.assertIn("preserved register sp", str(caught.exception))

    def test_ring_store_outside_its_entry_is_rejected(self) -> None:
        # A store still based on the slot pointer but reaching past the entry
        # walks into the next slot, or off the end of the ring entirely. The
        # base and the slot arithmetic both still look correct, so only the
        # offset set catches it.
        index = self.find(lambda w: w == 0xAD8A0000)     # sw t2, 0(t4)
        with self.assertRaises(ring.ObserverViolation):
            ring.verify_observer_only(self.layout, self.mutated(index, 0xAD8A0040))

    def test_extra_store_into_the_cave_header_is_rejected(self) -> None:
        # Injecting a store rather than rebasing one: the scenario is someone
        # adding a write to the cave later. Redundant with the tail and
        # base/offset checks, kept because the scenario is the dangerous one.
        with self.assertRaises(ring.ObserverViolation):
            ring.verify_observer_only(self.layout, self.mutated(3, 0xAC280000))  # sw t0, 0(at)

    def test_indirect_transfer_is_rejected(self) -> None:
        with self.assertRaises(ring.ObserverViolation):
            ring.verify_observer_only(self.layout, self.mutated(3, 0x03E00008))  # jr ra

    def test_extra_call_is_rejected(self) -> None:
        with self.assertRaises(ring.ObserverViolation):
            ring.verify_observer_only(self.layout, self.mutated(3, 0x0C000000 | (0x00123456 >> 2)))

    def test_widened_slot_mask_is_rejected(self) -> None:
        # A mask wider than capacity-1 would let a store walk out of the ring.
        index = self.find(lambda w: w == 0x316C000F)
        with self.assertRaises(ring.ObserverViolation):
            ring.verify_observer_only(self.layout, self.mutated(index, 0x316C00FF))

    def test_broken_tail_is_rejected(self) -> None:
        with self.assertRaises(ring.ObserverViolation):
            ring.verify_observer_only(self.layout, self.mutated(len(self.words) - 5, 0x00000000))


class RingEntryTests(unittest.TestCase):
    def test_fields_unpack_from_the_packed_words(self) -> None:
        entry = ring.RingEntry(
            frame=1234,
            packed=0xDEADBEEF,
            pad=(50 << 24) | (200 << 16) | 0x0040,
            states=(7 << 16) | (2 << 8) | 3,
        )
        self.assertEqual(entry.held_mask, 0x0040)
        self.assertEqual(entry.lx, 200)
        self.assertEqual(entry.ly, 50)
        self.assertEqual(entry.control_state, 3)
        self.assertEqual(entry.motion_state, 2)
        self.assertEqual(entry.seq, 7)


class FakeRingPine:
    """A ring the test drives frame by frame, read through the PINE surface."""

    def __init__(self, layout: ring.RingLayout, magic: int = ring.MAGIC):
        self.layout = layout
        self.memory: dict[int, int] = {
            layout.magic: magic,
            layout.enable: 1,
            layout.count: 0,
            layout.header + ring.OFF_RESERVED: 0,
        }
        for offset in range(0, layout.ring_bytes, 4):
            self.memory[layout.ring + offset] = 0
        self.count = 0

    def push(self, frame: int, packed: int = 0, pad: int = 0, states: int = 0,
             seq: int | None = None) -> None:
        slot = self.count & (self.layout.capacity - 1)
        base = self.layout.ring + slot * ring.ENTRY_BYTES
        stamp = self.count & 0xFFFF if seq is None else seq
        self.memory[base + 0x0] = frame
        self.memory[base + 0x4] = packed
        self.memory[base + 0x8] = pad
        self.memory[base + 0xC] = (stamp << 16) | (states & 0xFFFF)
        self.count += 1
        self.memory[self.layout.count] = self.count & 0xFFFFFFFF

    def _read(self, addr: int) -> int:
        return self.memory.get(addr, 0) & 0xFFFFFFFF

    def r32(self, addr: int) -> int:
        return self._read(addr)

    def r32_many(self, addrs) -> list[int]:
        return [self._read(addr) for addr in addrs]

    def r64_many(self, addrs) -> list[int]:
        return [self._read(addr) | (self._read(addr + 4) << 32) for addr in addrs]

    def w32(self, addr: int, value: int) -> None:
        self.memory[addr] = value & 0xFFFFFFFF


class DrainTests(unittest.TestCase):
    def setUp(self) -> None:
        self.layout = ring.build_layout(PAL)
        self.pine = FakeRingPine(self.layout)
        self.client = ring.RingClient(self.pine, self.layout)

    def test_first_drain_primes_the_cursor_without_replaying_history(self) -> None:
        for frame in range(5):
            self.pine.push(frame)
        entries, lost, torn = self.client.drain()
        self.assertEqual((entries, lost, torn), ([], 0, 0))

    def test_drain_returns_frames_in_order(self) -> None:
        self.client.drain()
        for frame in range(1000, 1005):
            self.pine.push(frame)
        entries, lost, torn = self.client.drain()
        self.assertEqual([entry.frame for entry in entries], [1000, 1001, 1002, 1003, 1004])
        self.assertEqual((lost, torn), (0, 0))

    def test_repeated_drains_do_not_duplicate(self) -> None:
        self.client.drain()
        self.pine.push(1)
        self.assertEqual([e.frame for e in self.client.drain()[0]], [1])
        self.assertEqual(self.client.drain()[0], [])
        self.pine.push(2)
        self.assertEqual([e.frame for e in self.client.drain()[0]], [2])

    def test_wrapping_is_seamless_while_the_host_keeps_up(self) -> None:
        self.client.drain()
        frames = list(range(100, 100 + self.layout.capacity * 3))
        for frame in frames:
            self.pine.push(frame)
            if frame % 4 == 0:
                self.client.drain()
        # Drain whatever is left and check nothing was lost across the wraps.
        seen: list[int] = []
        self.client.reset_drain_cursor()
        self.client.drain()
        for frame in range(500, 500 + self.layout.capacity):
            self.pine.push(frame)
        entries, lost, _ = self.client.drain()
        seen.extend(entry.frame for entry in entries)
        self.assertEqual(lost, 0)
        self.assertEqual(seen, list(range(500, 500 + self.layout.capacity)))

    def test_overrun_is_counted_exactly(self) -> None:
        self.client.drain()
        overshoot = 5
        for frame in range(self.layout.capacity + overshoot):
            self.pine.push(frame)
        entries, lost, _ = self.client.drain()
        self.assertEqual(lost, overshoot)
        self.assertEqual(len(entries), self.layout.capacity)
        # What survives is the newest window, not the oldest.
        self.assertEqual(entries[-1].frame, self.layout.capacity + overshoot - 1)

    def test_torn_slot_is_dropped_not_reported_as_data(self) -> None:
        self.client.drain()
        self.pine.push(10)
        self.pine.push(11, seq=0xBEEF)  # a slot caught mid-write
        self.pine.push(12)
        entries, lost, torn = self.client.drain()
        self.assertEqual(torn, 1)
        self.assertEqual([entry.frame for entry in entries], [10, 12])
        self.assertEqual(lost, 0)

    def test_missing_magic_is_a_hard_error(self) -> None:
        # A savestate load replaces EE RAM wholesale and silently removes the
        # recorder; the drain must say so rather than return plausible zeros.
        pine = FakeRingPine(self.layout, magic=0)
        client = ring.RingClient(pine, self.layout)
        with self.assertRaises(RuntimeError) as caught:
            client.drain()
        self.assertIn("not installed", str(caught.exception))

    def test_counter_wraparound_at_the_u32_boundary(self) -> None:
        self.pine.count = 0xFFFFFFFE
        self.pine.memory[self.layout.count] = self.pine.count
        self.client.drain()
        self.pine.push(7)
        self.pine.push(8)
        entries, lost, torn = self.client.drain()
        self.assertEqual([entry.frame for entry in entries], [7, 8])
        self.assertEqual((lost, torn), (0, 0))


if __name__ == "__main__":
    unittest.main()
