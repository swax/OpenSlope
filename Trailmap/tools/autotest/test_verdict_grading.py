#!/usr/bin/env python3
"""Offline tests for the dispatch grade, and for the banner's part in it.

A cell is graded on a live-node slot sampled from the host at ~20 Hz. That sampler can miss a node whose
whole life fits between two reads, and when it does the cell reports as a broken node rather than as a
missed sample -- indistinguishable from a real regression in the output.

A run built with `--hud-text` carries a second, independent witness: the effect chain posts a banner from
a node the fixture puts behind the debounce. So a banner appearing proves the chain RAN, and proves it
from inside the chain rather than by sampling the instance from outside.

`boost-directional` is the cell that forced the issue: over six runs its banner posted six times and the
slot read it four. These pin the rule that settles such a disagreement, and -- more importantly -- pin
the three ways it must NOT be allowed to hide a real failure.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from verdict import BANNER_COLOUR_BYTES, BANNER_READ_BYTES, BANNER_TEXT_MAX, _grade, _rider_signal  # noqa: E402

FIRED = "fired"
EMPTY = "never"          # any state that is not "fired"/"not-reached"/"pre-occupied"


class BannerRead(unittest.TestCase):
    """`ee.read_block` requires 8-alignment of the LENGTH as well as the address, and it raises rather
    than rounding -- so a length that is merely big enough fails at the first banner, a minute into a
    ride, having already paid for the boot and the build."""

    def test_the_read_length_is_eight_aligned(self):
        self.assertEqual(BANNER_READ_BYTES % 8, 0)

    def test_the_read_covers_the_colour_and_the_text_at_the_worst_alignment(self):
        # The address is rounded DOWN to the 8-byte boundary, so up to 7 bytes of the read are consumed
        # before the colour even starts.
        self.assertGreaterEqual(BANNER_READ_BYTES, 7 + BANNER_COLOUR_BYTES + BANNER_TEXT_MAX)


class DispatchGrade(unittest.TestCase):
    def test_the_slot_seeing_it_is_a_pass_with_or_without_a_banner(self):
        self.assertEqual(_grade("dispatch", FIRED, None), "pass")
        self.assertEqual(_grade("dispatch", FIRED, 26.3), "pass")

    def test_a_banner_rescues_a_dispatch_the_slot_missed(self):
        # The disagreement this exists for: the chain says it ran, the sampler did not see the node.
        self.assertEqual(_grade("dispatch", EMPTY, 26.3), "pass")

    def test_without_a_banner_a_missed_dispatch_is_still_a_regression(self):
        # An ordinary run carries no banners at all, so this must be the unchanged behaviour.
        self.assertEqual(_grade("dispatch", EMPTY, None), "REGRESSION")

    def test_a_banner_at_time_zero_still_counts(self):
        # 0.0 is a real timestamp; a truthiness test here would silently drop the first cell on the course.
        self.assertEqual(_grade("dispatch", EMPTY, 0.0), "pass")


class WhatTheBannerMustNotRescue(unittest.TestCase):
    def test_a_no_dispatch_cell_that_fired_is_still_a_regression(self):
        # The negative controls are the sharpest claims in the suite. A banner says the chain ran, which
        # for these cells is the thing that must NOT happen -- it can only ever make the case worse.
        self.assertEqual(_grade("no-dispatch", FIRED, None), "REGRESSION")
        self.assertEqual(_grade("no-dispatch", FIRED, 12.0), "REGRESSION")

    def test_a_no_dispatch_cell_that_stayed_empty_is_a_pass(self):
        self.assertEqual(_grade("no-dispatch", EMPTY, None), "pass")

    def test_a_cell_the_rider_never_reached_stays_inconclusive(self):
        # Including when a banner somehow exists: not reaching a cell proves nothing about it either way.
        self.assertEqual(_grade("dispatch", "not-reached", None), "inconclusive")
        self.assertEqual(_grade("dispatch", "not-reached", 5.0), "inconclusive")
        self.assertEqual(_grade("no-dispatch", "not-reached", None), "inconclusive")

    def test_a_pre_occupied_slot_stays_unobservable(self):
        self.assertEqual(_grade("dispatch", "pre-occupied", 5.0), "unobservable")

    def test_a_cell_with_no_expectation_stays_open(self):
        self.assertEqual(_grade(None, FIRED, 5.0), "open")
        self.assertEqual(_grade(None, EMPTY, None), "open")


class CollisionImpactSignal(unittest.TestCase):
    @staticmethod
    def sample(at: float, vx: float, vy: float = 0.0) -> tuple:
        # riderPath: seconds, XYZ position, XYZ velocity, then fields irrelevant to this signal.
        return (at, 0.0, 0.0, 0.0, vx, vy, 0.0, 0.0, 0.0)

    def test_pass_through_motion_has_no_impact(self):
        path = [self.sample(0.0, 1800.0), self.sample(0.05, 1780.0), self.sample(0.1, 1760.0)]
        window = list(enumerate(path[1:], start=1))
        self.assertEqual(_rider_signal("impact", window, path), 0.2)

    def test_the_contact_velocity_delta_is_reported_in_metres_per_second(self):
        path = [self.sample(0.0, 1800.0), self.sample(0.05, -200.0), self.sample(0.1, -240.0)]
        window = list(enumerate(path[1:], start=1))
        self.assertEqual(_rider_signal("impact", window, path), 20.0)

    def test_a_sideways_deflection_counts_as_a_physical_response(self):
        path = [self.sample(0.0, 1800.0, 0.0), self.sample(0.05, 1700.0, 1200.0)]
        window = list(enumerate(path[1:], start=1))
        self.assertEqual(_rider_signal("impact", window, path), 12.04)

    def test_a_missing_raw_path_refuses_the_reading(self):
        window = [(0, self.sample(0.0, -500.0))]
        self.assertIsNone(_rider_signal("impact", window))


if __name__ == "__main__":
    unittest.main()
