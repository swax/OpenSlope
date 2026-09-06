#!/usr/bin/env python3
"""Offline tests for riding either retail disc.

The harness reads two absolute addresses out of the boot executable -- the registry singleton and
`GameModeGlobal` -- and steers the front end with a schedule calibrated against one. All three are
properties of the DISC, and the failure mode when they are wrong is not an exception: a registry
pointer from the other build reads a word that is not a world, so the ride reports that no level
came up, and a prelude from the other build lands on a different menu entry and reports a full page
of results under a mode it was not measuring.

So these pin the things that keep the two builds from being confused for each other: the addresses
are distinct, the serials map to the right executables, detection is asked once and remembered, and
a mode with no calibration for a disc is refused rather than silently ridden without a prelude.
"""

from __future__ import annotations

import sys
import unittest
import unittest.mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import emu  # noqa: E402
import run  # noqa: E402


class FakePine:
    """Just enough of the transport: the one call `detect_build` makes, and a count of it."""

    def __init__(self, serial: str):
        self.serial = serial
        self.asks = 0

    def game_id(self) -> str:
        self.asks += 1
        return self.serial


class BuildTable(unittest.TestCase):
    def test_the_two_builds_share_no_addresses(self):
        pal, usa = emu.BUILDS["SLES-50545"], emu.BUILDS["SLUS-20326"]
        self.assertNotEqual(pal.registry_ptr, usa.registry_ptr)
        self.assertNotEqual(pal.game_mode_global, usa.game_mode_global)

    def test_the_registry_pointer_is_the_one_the_noclip_patch_maintains(self):
        # Not restated here. A second copy is a second thing to keep right, and the symptom of the
        # two drifting apart is a ride that reports no level rather than a mismatch.
        for serial, build in emu.BUILDS.items():
            with self.subTest(serial=serial):
                self.assertEqual(build.registry_ptr,
                                 emu.NOCLIP_TARGETS[build.name].registry_ptr)

    def test_every_build_has_a_game_mode_address_and_a_prelude_table(self):
        for build in emu.BUILDS.values():
            with self.subTest(build=build.name):
                self.assertEqual(build.game_mode_global, emu.GAME_MODE_GLOBAL[build.name])
                self.assertIn(build.name, emu.MODE_PRELUDES)


class DetectBuild(unittest.TestCase):
    def test_it_maps_each_serial_to_its_executable(self):
        self.assertEqual(emu.detect_build(FakePine("SLES-50545")).name, "SLES_505.45")
        self.assertEqual(emu.detect_build(FakePine("SLUS-20326")).name, "SLUS_203.26")

    def test_it_tolerates_the_shape_pcsx2_actually_returns(self):
        # Whitespace and case are not guaranteed by the protocol, and a serial that fails to match
        # would take out the whole ride rather than one read.
        self.assertEqual(emu.detect_build(FakePine("  slus-20326 \n")).name, "SLUS_203.26")

    def test_it_asks_once_and_remembers(self):
        pine = FakePine("SLES-50545")
        for _ in range(5):
            emu.detect_build(pine)
        self.assertEqual(pine.asks, 1)

    def test_an_unknown_disc_is_refused_by_name(self):
        with self.assertRaises(RuntimeError) as caught:
            emu.detect_build(FakePine("SLPM-65535"))
        self.assertIn("SLPM-65535", str(caught.exception))


class Preludes(unittest.TestCase):
    def test_a_mode_that_needs_no_steering_is_not_the_same_as_an_uncalibrated_one(self):
        # `None` means "ride it as-is"; missing means "nobody has measured this disc". Collapsing
        # them would ride the front end's default and report it as the mode that was asked for.
        self.assertIsNone(emu.mode_prelude("SLUS_203.26", "race"))
        with self.assertRaises(SystemExit):
            emu.mode_prelude("SLUS_203.26", "nonexistent-mode")

    def test_an_uncalibrated_mode_names_the_command_that_calibrates_it(self):
        table = dict(emu.MODE_PRELUDES)
        table["SLES_505.45"] = {"race": None}
        with unittest.mock.patch.object(emu, "MODE_PRELUDES", table):
            with self.assertRaises(SystemExit) as caught:
                emu.mode_prelude("SLES_505.45", "showoff")
        self.assertIn("modescan", str(caught.exception))

    def test_every_calibrated_mode_is_a_mode_the_engine_has(self):
        for build, table in emu.MODE_PRELUDES.items():
            for mode in table:
                with self.subTest(build=build, mode=mode):
                    self.assertIn(mode, emu.GAME_MODES)

    def test_an_unknown_build_is_refused(self):
        with self.assertRaises(SystemExit):
            emu.mode_prelude("SLPM_655.35", "race")


class Regions(unittest.TestCase):
    def test_each_region_names_a_build_the_harness_can_read(self):
        builds = {build.name for build in emu.BUILDS.values()}
        for region, (_iso, build) in run.REGIONS.items():
            with self.subTest(region=region):
                self.assertIn(build, builds)

    def test_the_regions_are_distinct_discs(self):
        isos = [iso for iso, _ in run.REGIONS.values()]
        self.assertEqual(len(isos), len(set(isos)))

    def test_the_default_region_still_owns_the_unsuffixed_iso_name(self):
        # Every existing image, report and habit refers to `ssx-tricky-gold.iso`. Adding a region
        # must not quietly re-point that name at a different disc.
        self.assertIn(run.DEFAULT_REGION, run.REGIONS)
        self.assertEqual(run.DEFAULT_REGION, "pal")


if __name__ == "__main__":
    unittest.main()
