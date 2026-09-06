#!/usr/bin/env python3
"""Offline tests for the debug-text patch and its live probe.

The live half needs PCSX2, but everything that decides whether the patch is safe to
write into a running game is decidable here: the assembled cave, the hook words, the
freeness of the space it lands in, and the register liveness the shim depends on.

Hand-assembled MIPS with delay slots is the part that bites. A one-register slip in the
renderer hijack -- ``lw a1, 4(a1)`` where ``lw a1, 4(v1)`` was meant -- assembles, runs,
and draws whatever the string-id register happened to hold. So every instruction the
patch emits is decoded back with the repository's own
disassembler and compared against what it is supposed to be, rather than trusted
because the generator produced it.

Everything here runs against BOTH shipped builds. The NTSC-U anchors were found by
matching PAL instruction windows rather than by re-reading the code, and a match that
is merely unique is not a match that is right -- so each one is checked against the
executable it names: the hook sites hold the words the patch expects to replace, entry
12 is that build's own inert default, v1 really does survive to the call, and the
colour block is re-derived from the retail draw's own store rather than trusted.
"""

from __future__ import annotations

import struct
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]
ROOT = TOOLS.parent
sys.path.insert(0, str(TOOLS / "analysis"))
sys.path.insert(0, str(TOOLS / "patches"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import debug_text_patch as patch  # noqa: E402
from noclip_patch import Asm  # noqa: E402
from ssx_analyze import decode  # noqa: E402

PAL = patch.TARGETS["SLES_505.45"]
USA = patch.TARGETS["SLUS_203.26"]


def disassemble(blob: bytes, base: int) -> list[str]:
    return [" ".join(decode(struct.unpack_from("<I", blob, i)[0], base + i).split())
            for i in range(0, len(blob), 4)]


def s16(value: int) -> int:
    return value - 0x10000 if value & 0x8000 else value


def shim_base(t: patch.Target) -> int:
    return t.cave + len(patch.build_handler(t, t.cave))


class HandlerMixin:
    """Dispatcher entry 12. Entered by `jr` with the dispatcher's frame live."""

    TARGET: patch.Target

    def setUp(self):
        t = self.TARGET
        self.text = disassemble(patch.build_handler(t, t.cave), t.cave)

    def test_it_is_the_expected_instruction_sequence(self):
        t = self.TARGET
        self.assertEqual(self.text, [
            "lw a0, 232(s0)",                       # [thread+0xE8] = the firing rider
            f"beq a0, zero, 0x{t.cave + 4 * 9:08x}",  # no rider: post nothing
            "addiu a2, s1, 20",                     # delay slot: value = the inline text
            "lui a3, 0x5357",                       # aux = the sentinel, one instruction by design
            "lui at, 0x4020",
            "mtc1 at, f12",                         # f12 = 2.5s lifetime
            "addiu a1, zero, 10",                   # kind 10, the CHECKPOINT banner
            f"jal 0x{t.add_hud_event:08x}",
            "addiu a0, a0, 22560",                  # delay slot: rider -> trick-score state
            f"j 0x{t.dispatch_epilogue:08x}",       # the dispatcher's shared epilogue
            "addiu v0, zero, 1",                    # delay slot: 1 = continue the chain
        ])

    def test_the_value_word_points_past_the_colour_to_the_text(self):
        # The whole colour scheme rests on this one displacement: the slot carries the TEXT
        # pointer, and the shim reaches the colour by stepping back from it. Off by a field
        # here and the banner draws three floats as UTF-16 and colours itself from the string.
        self.assertIn(f"addiu a2, s1, {patch.NODE_PAYLOAD + patch.PAYLOAD_TEXT}", self.text[2])

    def test_the_rider_guard_branches_past_the_post(self):
        # The branch target has to be the epilogue jump, not the middle of the setup:
        # posting with a null trick-score state would write through a null pointer.
        target = int(self.text[1].split()[-1], 16)
        self.assertEqual(target, self.TARGET.cave + 4 * (len(self.text) - 2))

    def test_the_sentinel_loads_whole_in_one_instruction(self):
        # A sentinel with a nonzero low half needs a second instruction in each of the three
        # routines, and all three together only just fit the gaps.
        self.assertEqual(patch.SENTINEL & 0xFFFF, 0)
        self.assertEqual(int(self.text[3].split()[-1], 16) << 16, patch.SENTINEL)

    def test_the_trick_score_offset_matches_the_engine(self):
        self.assertIn(f"{0x5820}", self.text[8])


class ShimMixin:
    """Replaces the kind-10 banner's LocString call, and colours what it returns."""

    TARGET: patch.Target

    def setUp(self):
        t = self.TARGET
        self.base = shim_base(t)
        self.text = disassemble(patch.build_shim(t, self.base), self.base)

    def test_it_is_the_expected_instruction_sequence(self):
        t = self.TARGET
        red = t.colour_block + 4
        hi = (red + 0x8000) >> 16                   # the lui the three stores share
        disp = [(red + 4 * i) - (hi << 16) for i in range(3)]
        self.assertEqual(self.text, [
            "lw at, 16(v1)",                        # the slot's aux word
            "lui t9, 0x5357",
            f"beq at, t9, 0x{self.base + 24:08x}",  # ours?
            "lw v0, 4(v1)",                         # delay slot: the value word = the text
            f"j 0x{t.locstring:08x}",               # not ours: the stock call, arguments untouched
            "nop",
            f"lui at, 0x{hi:04x}",
            "lw t9, -12(v0)",                       # R, G, B ride just behind the text...
            f"sw t9, {disp[0]}(at)",                # ...so they copy across as plain words
            "lw t9, -8(v0)",
            f"sw t9, {disp[1]}(at)",
            "lw t9, -4(v0)",
            f"sw t9, {disp[2]}(at)",
            "jr ra",                                # v0 already holds the string
            "nop",
        ])

    def test_the_retail_path_is_a_tail_call_not_a_call(self):
        # `j`, not `jal`: LocString has to return to the banner branch, not to the shim.
        self.assertTrue(self.text[4].startswith("j "), self.text[4])

    def test_it_reads_the_slot_through_v1(self):
        # v1 is the only register still holding the slot at the call site. Reading the
        # aux word through anything else silently reads somebody else's memory.
        for line in (self.text[0], self.text[3]):
            self.assertTrue(line.endswith("(v1)"), line)

    def test_the_aux_and_value_offsets_are_the_slot_fields(self):
        self.assertIn(f"{patch.SLOT_AUX}(v1)", self.text[0])
        self.assertIn(f"{patch.SLOT_VALUE}(v1)", self.text[3])

    def test_the_colour_is_read_back_from_the_text_pointer(self):
        # Three consecutive words ending where the string starts, in R, G, B order. A sign
        # slip here reads past the string instead of in front of it.
        loads = [self.text[7], self.text[9], self.text[11]]
        for channel, line in enumerate(loads):
            self.assertEqual(line, f"lw t9, {-patch.PAYLOAD_TEXT + 4 * channel}(v0)")

    def test_the_retail_path_writes_no_colour(self):
        # Everything from the branch target on is ours. A real checkpoint leaves through
        # instruction 4 and must reach the draw with retail's own colour still in place.
        self.assertNotIn("sw", " ".join(self.text[:6]))


class NumericSkipMixin:
    """Keeps the banner's second draw -- a signed time built from the slot's value word --
    off slots whose value is a text pointer."""

    TARGET: patch.Target

    def setUp(self):
        t = self.TARGET
        self.base = t.cave2
        self.text = disassemble(patch.build_numeric_skip(t, self.base), self.base)

    def test_it_is_the_expected_instruction_sequence(self):
        t = self.TARGET
        tail = f"0x{self.base + 24:08x}"
        self.assertEqual(self.text, [
            f"bne a0, v0, {tail}",                  # not kind 10: the test's own taken path
            "lw at, 16(a2)",                        # delay slot: aux, harmless if we branched
            f"bne at, zero, {tail}",                # nonzero aux = ours, so skip the number
            "nop",
            f"j 0x{t.numeric_body:08x}",            # a checkpoint's own slot: draw it as usual
            "nop",
            f"j 0x{t.numeric_next:08x}",            # the loop tail
            "nop",
        ])

    def test_the_retail_path_re_enters_past_the_branch_delay_slot(self):
        # The hook replaces a branch whose delay slot increments the loop counter, and `j`
        # runs that delay slot before transferring -- so re-entering AT it would count twice.
        self.assertEqual(self.TARGET.numeric_body, self.TARGET.numeric_test + 8)

    def test_both_exits_leave_through_the_loop_tail(self):
        self.assertEqual(int(self.text[0].split()[-1], 16), self.base + 4 * 6)
        self.assertEqual(int(self.text[2].split()[-1], 16), self.base + 4 * 6)
        self.assertIn(f"0x{self.TARGET.numeric_next:08x}", self.text[6])

    def test_it_reads_the_slot_through_a2(self):
        # a2 is what the numeric loop holds the slot in -- v1 belongs to the text loop.
        self.assertIn(f"{patch.SLOT_AUX}(a2)", self.text[1])


class ShippedExecutableMixin:
    """Skipped in a fresh clone -- the boot ELFs are locally generated, not committed."""

    TARGET: patch.Target

    def setUp(self):
        self.elf = ROOT / "extracted" / self.TARGET.name
        if not self.elf.is_file():
            self.skipTest(f"{self.elf} not extracted; see the repo README")
        self.image = self.elf.read_bytes()

    def word_at(self, vaddr: int) -> int:
        return struct.unpack_from("<I", self.image, patch.vaddr_to_off(vaddr))[0]

    def text_at(self, vaddr: int) -> str:
        """The instruction at `vaddr` as the repository's disassembler prints it, one space between
        tokens. Expectations below are written as that text, so the encodings stay in the executable."""
        return " ".join(decode(self.word_at(vaddr), vaddr).split())

    def test_the_image_is_the_size_the_target_names(self):
        self.assertEqual(len(self.image), self.TARGET.size)

    def test_every_hook_site_holds_what_the_patch_expects(self):
        # Checked the way the patch itself checks a site -- by the digest of the word there --
        # so the retail encodings stay in the executable and nowhere in this tree.
        t = self.TARGET
        for label, site, want in (("loc_call", t.loc_call, t.anchor_digests[0]),
                                  ("table_entry", t.table_entry, t.anchor_digests[1]),
                                  ("numeric_test", t.numeric_test, t.anchor_digests[2])):
            with self.subTest(site=label):
                self.assertEqual(patch.anchor_digest(self.image, site), want)

    def test_the_hooked_call_really_is_the_call_to_locstring(self):
        # The word at loc_call being stock is not the same as `locstring` being the right
        # ADDRESS -- the shim's retail path jumps to the latter. Read the call out of the
        # executable and check where it goes against the table.
        self.assertEqual(self.text_at(self.TARGET.loc_call), f"jal 0x{self.TARGET.locstring:08x}")

    def test_the_claimed_opcode_is_the_inert_default(self):
        # Entry 12 must still be the do-nothing case, or this patch is stealing a
        # main type the engine actually uses.
        self.assertEqual(self.word_at(self.TARGET.table_entry), self.TARGET.dispatch_epilogue - 4)

    def test_the_inert_default_returns_one(self):
        # `addiu v0, zero, 1` -- which is also what the handler leaves in v0, so an
        # authored node continues its chain exactly as an unhandled one did. The expected
        # encoding comes from the repository's own assembler, not a written-down word.
        expected = Asm(0)
        expected.addiu("v0", "zero", 1)
        handler = self.word_at(self.TARGET.table_entry)
        self.assertEqual(self.word_at(handler), struct.unpack("<I", expected.assemble())[0])

    def test_the_numeric_test_falls_through_to_its_body(self):
        # The hook replaces a `bne` whose NOT-taken path is the kind-10 body. Both
        # addresses are read back out of the branch rather than tabulated independently.
        t = self.TARGET
        word = self.word_at(t.numeric_test)
        self.assertEqual(t.numeric_next, t.numeric_test + 4 + (s16(word & 0xFFFF) << 2))
        self.assertEqual(t.numeric_body, t.numeric_test + 8)

    def test_the_colour_block_is_the_one_the_retail_draw_writes(self):
        # Re-derived from the executable: the store in the call's delay slot is retail's own
        # write of the fade alpha, so its base+displacement IS the colour block. Without this
        # a wrong address still draws the text correctly and colours it from whatever else
        # lives there -- the failure mode that made this worth deriving twice.
        t = self.TARGET
        store = self.word_at(t.loc_call + 4)
        self.assertEqual(store >> 26, 0x39, "expected swc1 in the call's delay slot")
        base_reg = (store >> 21) & 0x1F
        for vaddr in range(t.loc_call, t.loc_call - 0x1000, -4):
            word = self.word_at(vaddr)
            if word >> 26 == 0x0F and (word >> 16) & 0x1F == base_reg:
                base = (word & 0xFFFF) << 16
                break
        else:
            self.fail(f"no lui into the store's base register before 0x{t.loc_call:08x}")
        self.assertEqual(t.colour_block, base + s16(store & 0xFFFF))

    def test_both_cave_gaps_are_zero(self):
        for cave, size in ((self.TARGET.cave, patch.CAVE_BYTES),
                           (self.TARGET.cave2, patch.CAVE2_BYTES)):
            with self.subTest(cave=hex(cave)):
                off = patch.vaddr_to_off(cave)
                self.assertEqual(self.image[off:off + size], bytes(size))

    def test_both_caves_fit_their_vetted_ranges(self):
        for cave, size, (lo, hi) in ((self.TARGET.cave, patch.CAVE_BYTES,
                                      self.TARGET.cave_range),
                                     (self.TARGET.cave2, patch.CAVE2_BYTES,
                                      self.TARGET.cave2_range)):
            with self.subTest(cave=hex(cave)):
                self.assertLessEqual(lo, cave)
                self.assertLessEqual(cave + size, hi)

    def test_the_assembled_routines_fit(self):
        # The handler and the shim share the first gap; the skip has the second to itself.
        t = self.TARGET
        first = len(patch.build_handler(t, t.cave))
        first += len(patch.build_shim(t, t.cave + first))
        self.assertLessEqual(first, patch.CAVE_BYTES)
        self.assertLessEqual(len(patch.build_numeric_skip(t, t.cave2)), patch.CAVE2_BYTES)

    def test_the_probe_scratch_overlaps_nothing_the_patch_writes(self):
        # It is live-RAM only and never reaches a disc, but it is written while the patch is
        # installed -- so landing it on a cave would corrupt the code that is about to read it.
        t = self.TARGET
        scratch = range(t.scratch, t.scratch + t.scratch_bytes)
        for cave, size in ((t.cave, patch.CAVE_BYTES), (t.cave2, patch.CAVE2_BYTES)):
            with self.subTest(cave=hex(cave)):
                self.assertTrue(scratch.stop <= cave or scratch.start >= cave + size)

    def test_the_probe_scratch_is_allocated_but_not_file_backed(self):
        # `.sbss`/`.bss` padding: inside the load segment's memsz, so the loader allocates and
        # zeroes it, but past its filesz, so no shipped byte lands there. Both halves matter --
        # past memsz it would not be mapped at all, inside filesz it would be real content.
        t = self.TARGET
        phoff, = struct.unpack_from("<I", self.image, 0x1C)
        entsize, count = struct.unpack_from("<HH", self.image, 0x2A)
        segments = [struct.unpack_from("<8I", self.image, phoff + i * entsize)
                    for i in range(count)]
        loads = [s for s in segments if s[0] == 1 and s[2] <= t.scratch < s[2] + s[5]]
        self.assertEqual(len(loads), 1, "the scratch is not in exactly one load segment")
        _t, _off, vaddr, _pa, filesz, memsz, _fl, _al = loads[0]
        self.assertLessEqual(t.scratch + t.scratch_bytes, vaddr + memsz)
        self.assertGreaterEqual(t.scratch, vaddr + filesz)

    def test_the_probe_hooks_are_the_three_that_arm_the_patch(self):
        # Ordering on install depends on this split: a hook written before its cave body jumps
        # into whatever was there.
        import hud_message_probe as probe
        self.assertEqual(sorted(probe.hook_sites(self.TARGET)),
                         sorted((self.TARGET.table_entry, self.TARGET.loc_call,
                                 self.TARGET.numeric_test)))

    def test_the_probe_finds_every_word_the_generator_changes(self):
        # The probe diffs the two executables rather than re-deriving the layout, so this is what
        # says the .debugtext build on disk is the one this generator produces.
        #
        # CHANGES, not writes: the caves are zero-filled gaps, so every `nop` the routines emit is
        # already the byte that is there and does not show up in a diff. That is why the count is
        # short of the instruction count, and it is harmless in both directions -- install leaves a
        # zero where a zero belongs, and revert restores a zero that was never disturbed.
        import hud_message_probe as probe
        t = self.TARGET
        _stock, patched = probe.elf_paths(t)
        if not patched.is_file():
            self.skipTest(f"{patched} not built")
        handler = patch.build_handler(t, t.cave)
        shim = patch.build_shim(t, t.cave + len(handler))
        skip = patch.build_numeric_skip(t, t.cave2)
        body = handler + shim + skip
        nonzero = sum(1 for i in range(0, len(body), 4)
                      if struct.unpack_from("<I", body, i)[0] != 0)
        self.assertEqual(len(probe.patch_words(t)), 3 + nonzero)

    def test_the_slot_pointer_survives_to_the_shim_call(self):
        # The shim reads the slot through v1, which the branch forms at `slot_form`.
        # If a future re-read of this region finds v1 reassigned in between, that has
        # to fail here rather than in-game.
        writers = ("lw", "addiu", "addu", "daddu", "lui", "or", "ori", "and",
                   "movn", "movz", "sll", "sra", "subu", "xor")
        for vaddr in range(self.TARGET.slot_form + 4, self.TARGET.loc_call, 4):
            text = decode(self.word_at(vaddr), vaddr)
            mnemonic, _, operands = text.partition(" ")
            if mnemonic in writers:
                self.assertNotEqual(operands.split(",")[0].strip(), "v1",
                                    f"v1 is clobbered at 0x{vaddr:08x}: {text}")

    def test_the_slot_is_formed_at_the_ring_stride(self):
        # `addu v1, s7, v1`, and the addiu feeding it carries the ring's +0x15C offset.
        # This is what says `slot_form` names the slot rather than some other pointer.
        self.assertEqual(self.text_at(self.TARGET.slot_form), "addu v1, s7, v1")
        self.assertEqual(self.text_at(self.TARGET.slot_form - 4), f"addiu v1, v1, {0x15C}")


class BothBuilds(unittest.TestCase):
    """Claims about the pair rather than about either one."""

    def test_the_routines_assemble_to_the_same_length_on_both(self):
        # The gaps are the same size on both builds, so "it fits" is one claim -- but only
        # while the code is the same shape. A target that needed an extra instruction for a
        # far address would silently spend the 8 bytes of headroom that are left.
        def lengths(t):
            handler = patch.build_handler(t, t.cave)
            return (len(handler), len(patch.build_shim(t, t.cave + len(handler))),
                    len(patch.build_numeric_skip(t, t.cave2)))
        self.assertEqual(lengths(PAL), lengths(USA))

    def test_the_two_targets_share_no_addresses(self):
        # A copied row with a field left at the other build's address is the likely way this
        # table goes wrong, and it would apply cleanly -- the descriptor only verifies the
        # bytes it replaces, not the addresses the cave jumps to.
        fields = ("loc_call", "slot_form", "table_entry", "numeric_test", "numeric_body",
                  "numeric_next", "locstring", "add_hud_event", "dispatch_epilogue",
                  "colour_block", "cave", "cave2")
        for field in fields:
            with self.subTest(field=field):
                self.assertNotEqual(getattr(PAL, field), getattr(USA, field))


class HandlerPal(HandlerMixin, unittest.TestCase):
    TARGET = PAL


class HandlerUsa(HandlerMixin, unittest.TestCase):
    TARGET = USA


class ShimPal(ShimMixin, unittest.TestCase):
    TARGET = PAL


class ShimUsa(ShimMixin, unittest.TestCase):
    TARGET = USA


class NumericSkipPal(NumericSkipMixin, unittest.TestCase):
    TARGET = PAL


class NumericSkipUsa(NumericSkipMixin, unittest.TestCase):
    TARGET = USA


class ShippedExecutablePal(ShippedExecutableMixin, unittest.TestCase):
    TARGET = PAL


class ShippedExecutableUsa(ShippedExecutableMixin, unittest.TestCase):
    TARGET = USA


if __name__ == "__main__":
    unittest.main()
