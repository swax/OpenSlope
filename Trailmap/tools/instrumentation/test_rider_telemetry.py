#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import unittest
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rider_telemetry as telemetry  # noqa: E402


class RiderTelemetryTests(unittest.TestCase):
    def blank_raw(self) -> telemetry.RawBoarder:
        return telemetry.RawBoarder(
            {
                name: (start, [0] * ((end - start) // 4))
                for name, (start, end) in telemetry.RAW_REGIONS.items()
            }
        )

    def set_word(self, raw: telemetry.RawBoarder, offset: int, value: int) -> None:
        for _, (start, words) in raw.regions.items():
            index = offset - start
            if index >= 0 and index % 4 == 0 and index // 4 < len(words):
                words[index // 4] = value & 0xFFFFFFFF
                return
        self.fail(f"offset +0x{offset:x} is not captured")

    def set_float(self, raw: telemetry.RawBoarder, offset: int, value: float) -> None:
        self.set_word(raw, offset, struct.unpack("<I", struct.pack("<f", value))[0])

    def test_decode_frame_and_exact_raw_words(self) -> None:
        raw = self.blank_raw()
        self.set_word(raw, 0x424, 1)
        self.set_word(raw, 0x428, 13)
        self.set_word(raw, 0x41C, 1)
        self.set_word(raw, 0x290, 18)
        for index, value in enumerate((300.0, 400.0, 0.0, 0.0)):
            self.set_float(raw, 0x150 + index * 4, value)
        self.set_float(raw, 0x208, 0.75)
        self.set_float(raw, 0x2A8, 1.0)

        camera_words = [0] * ((telemetry.CAMERA_RAW_END - telemetry.CAMERA_RAW_START) // 4)
        camera = telemetry.RawCamera(2, 0x00854000, camera_words)
        camera_values = {
            0xB0: 100.0, 0xB4: 200.0, 0xB8: 300.0, 0xBC: 1.0,
            # Stored rows; decoded columns are right/up/forward.
            0xC0: 1.0, 0xC4: 0.0, 0xC8: 0.0,
            0xD0: 0.0, 0xD4: 0.0, 0xD8: 1.0,
            0xE0: 0.0, 0xE4: 1.0, 0xE8: 0.0,
            0x100: 0.825, 0x104: 15.0,
        }
        for offset, value in camera_values.items():
            camera.words[(offset - telemetry.CAMERA_RAW_START) // 4] = struct.unpack(
                "<I", struct.pack("<f", value)
            )[0]

        frame = telemetry.decode_frame(
            1234, 2.5, 0x00ABC000, raw, camera, (0, 0xFFFF0020, 127, 128), retries=1
        )

        self.assertEqual(frame["state"]["motionName"], "air")
        self.assertEqual(frame["state"]["controlName"], "airborne")
        self.assertEqual(frame["contact"]["surfaceType"], 18)
        self.assertAlmostEqual(frame["control"]["jumpCharge"], 0.75)
        self.assertEqual(frame["input"]["heldMask"], telemetry.PAD_MARKER_BUTTON)
        self.assertAlmostEqual(telemetry.speed_mps(frame), 5.0)
        self.assertEqual(frame["camera"]["activeIndex"], 2)
        self.assertEqual(frame["camera"]["position"], [100.0, 200.0, 300.0, 1.0])
        self.assertEqual(frame["camera"]["right"], [1.0, 0.0, 0.0])
        self.assertEqual(frame["camera"]["up"], [0.0, 0.0, 1.0])
        self.assertEqual(frame["camera"]["forward"], [0.0, 1.0, 0.0])
        self.assertAlmostEqual(frame["camera"]["halfFovXRad"], 0.825)
        self.assertAlmostEqual(frame["camera"]["fovXDeg"], math.degrees(1.65), places=5)
        self.assertAlmostEqual(
            frame["camera"]["fovY4x3Deg"],
            math.degrees(2 * math.atan(math.tan(0.825) / (4 / 3))), places=5,
        )
        self.assertAlmostEqual(frame["camera"]["nearClipUnits"], 15.0)
        self.assertEqual(
            len(bytes.fromhex(frame["camera"]["raw"])),
            telemetry.CAMERA_RAW_END - telemetry.CAMERA_RAW_START,
        )
        self.assertEqual(set(frame["raw"]), set(telemetry.RAW_REGIONS))
        for name, encoded in frame["raw"].items():
            start, end = telemetry.RAW_REGIONS[name]
            self.assertEqual(len(bytes.fromhex(encoded)), end - start)

    def test_marker_lookback(self) -> None:
        sample = {
            "frame": 600,
            "hostSeconds": 10.0,
            "state": {"motion": 2},
            "motion": {"position": [1, 2, 3, 1], "velocity": [4, 5, 6, 0]},
        }
        marker = telemetry.marker_record(2, "jump", "keyboard", sample, 3.0)
        self.assertEqual(marker["lookbackStartFrame"], 420)
        self.assertEqual(marker["id"], 2)

    def test_decode_final_blended_rig_pose_and_exact_raw(self) -> None:
        floats = lambda values: [
            struct.unpack("<I", struct.pack("<f", value))[0] for value in values
        ]
        context = {
            "modelPartId": 0,
            "partAddress": "0x00100000",
            "skeletonAddress": "0x00200000",
            "boneCount": 2,
        }
        rig = telemetry.RawRig(
            context,
            floats([0.1, 0.2, 0.3, -0.1, -0.2, -0.3]),
            floats([1.0, 2.0, 3.0]),
            floats([float(index) for index in range(16)]),
            [508, 768, 752],
        )
        decoded = telemetry.decode_rig(rig)
        self.assertEqual(decoded["boneCount"], 2)
        self.assertEqual(decoded["eventIds"], [508, 768, 752])
        self.assertAlmostEqual(decoded["localRotationsRad"][1][2], -0.3)
        self.assertEqual(decoded["rootTranslation"], [1.0, 2.0, 3.0])
        self.assertEqual(decoded["renderMatrixRows"][2], [12.0, 13.0, 14.0, 15.0])
        self.assertEqual(len(bytes.fromhex(decoded["raw"]["localRotations"])), 24)

    def test_rig_study_compares_two_sided_turn_pose(self) -> None:
        header = {
            "schema": telemetry.SCHEMA,
            "label": "turns",
            "rig": {
                "boneCount": 1,
                "bones": [{"index": 0, "name": "hips", "parent": -1}],
            },
        }

        def frame(number: int, lean: float, rotation: float) -> dict:
            return {
                "kind": "frame",
                "frame": number,
                "state": {"motion": 2},
                "control": {"leanSlew": [lean, 0.0, 0.0]},
                "contact": {
                    "surfaceType": 1,
                    "visualLift": 1.75,
                    "bogDepth": 2.5,
                    "budgetDepth": 2.5,
                },
                "rig": {
                    "eventIds": [100, 200, 300],
                    "localRotationsRad": [[rotation, 0.0, 0.0]],
                },
            }

        report = telemetry.summarize_rig_trace(
            header,
            [frame(10, -1.0, -0.5), frame(11, 0.0, 0.0), frame(12, 1.0, 0.5)],
        )
        self.assertEqual(report["leanBins"], {"negative": 1, "neutral": 1, "positive": 1})
        self.assertAlmostEqual(report["bones"][0]["positiveMinusNegativeRad"][0], 1.0)
        self.assertAlmostEqual(report["bones"][0]["turnDeltaMagnitudeDeg"], math.degrees(1.0))
        self.assertEqual(report["surfaces"]["1"]["frames"], 3)
        filtered = telemetry.summarize_rig_trace(
            header,
            [frame(10, -1.0, -0.5), frame(11, 0.0, 0.0), frame(12, 1.0, 0.5)],
            negative_event=999,
        )
        self.assertEqual(filtered["leanBins"]["negative"], 0)
        self.assertEqual(filtered["eventFilter"]["layer"], 2)
        self.assertEqual(filtered["eventFilter"]["negative"], 999)

    def test_representative_joints_are_per_frame_coordinate_medians(self) -> None:
        metadata = {
            "bones": [
                {"index": 0, "name": "hips", "parent": -1, "bindTranslation": [0, 0, 0]},
                {"index": 1, "name": "l_foot", "parent": 0, "bindTranslation": [0, 100, 0]},
                {"index": 2, "name": "r_foot", "parent": 0, "bindTranslation": [0, -100, 0]},
            ]
        }

        def frame(hips_z: float) -> dict:
            return {
                "rig": {
                    "rootTranslation": [0, 0, 0],
                    "localRotationsRad": [
                        [0, 0, hips_z], [0, 0, 0], [0, 0, 0],
                    ],
                }
            }

        pose = telemetry._rig_group_joint_pose(
            [frame(-math.pi / 2), frame(0), frame(math.pi / 2)], metadata
        )
        self.assertIsNotNone(pose)
        # A hierarchy reconstructed from the mean (zero) Euler would put the
        # left foot at board-longitudinal +1 m. The drawn per-frame positions
        # have medians of zero on both horizontal axes.
        self.assertAlmostEqual(pose["jointsBoardFrameM"]["l_foot"][0], 0.0)
        self.assertAlmostEqual(pose["jointsBoardFrameM"]["l_foot"][2], 0.0)
        # A legless skeleton has nothing to orient from, and says so rather than guessing.
        self.assertIsNone(pose["kneeLeadM"])
        self.assertFalse(pose["toeAxisMirrored"])

    def test_board_frame_is_oriented_toe_positive_from_the_knees(self) -> None:
        """Whichever lateral direction the model puts the toes in, +X comes out toe."""

        def skeleton(knee_lateral: float) -> tuple[dict, list[dict]]:
            # Retail model axes: X lateral, Y board-longitudinal, Z up. Bones hang off
            # the hips, so a bind translation is the joint's offset from the origin.
            bones = [
                ("hips", -1, [0.0, 0.0, 0.0]),
                ("l_thigh", 0, [0.0, -20.0, -10.0]),
                ("l_calf", 0, [knee_lateral, -20.0, -45.0]),
                ("l_foot", 0, [0.0, -20.0, -80.0]),
                ("r_thigh", 0, [0.0, 20.0, -10.0]),
                ("r_calf", 0, [knee_lateral, 20.0, -45.0]),
                ("r_foot", 0, [0.0, 20.0, -80.0]),
            ]
            metadata = {
                "bones": [
                    {"index": i, "name": n, "parent": p, "bindTranslation": t}
                    for i, (n, p, t) in enumerate(bones)
                ]
            }
            frames = [{
                "rig": {
                    "rootTranslation": [0.0, 0.0, 0.0],
                    "localRotationsRad": [[0.0, 0.0, 0.0]] * len(bones),
                }
            }]
            return metadata, frames

        for lateral in (30.0, -30.0):
            metadata, frames = skeleton(lateral)
            pose = telemetry._rig_group_joint_pose(frames, metadata)
            self.assertIsNotNone(pose)
            joints = pose["jointsBoardFrameM"]
            self.assertAlmostEqual(pose["kneeLeadM"], 0.30, places=6)
            self.assertEqual(pose["toeAxisMirrored"], lateral < 0)
            self.assertGreater(joints["l_calf"][0], 0.0, "knees must come out on the toe side")
            self.assertGreater(joints["r_calf"][0], 0.0, "knees must come out on the toe side")

    def test_frame_gap_distinguishes_misses_from_counter_reset(self) -> None:
        self.assertEqual(telemetry.frame_gap(100, 101), (0, False))
        self.assertEqual(telemetry.frame_gap(100, 104), (3, False))
        self.assertEqual(telemetry.frame_gap(100, 10000), (0, True))
        self.assertEqual(telemetry.frame_gap(10000, 2), (0, True))

    def test_extract_flights_finds_delayed_airborne_jump_impulse(self) -> None:
        def frame(number: int, motion: int, vx: float, vz: float, snapshot: float = 0.0):
            return {
                "frame": number,
                "hostSeconds": number / 60,
                "motionState": motion,
                "motionName": telemetry.MOTION_STATES[motion],
                "controlState": 16,
                "controlName": "rail_control",
                "position": [number * 10.0, 0.0, number * 2.0, 1.0],
                "velocity": [vx, 0.0, vz, 0.0],
                "surfaceType": 18,
                "normal": [0.0, 0.0, 1.0, 0.0],
                "chargeSnapshot": snapshot,
            }

        frames = [
            frame(10, 2, 1000.0, -100.0),
            frame(11, 1, 1000.0, -120.0),
            frame(12, 1, 1000.0, -140.0),
            frame(13, 1, 1120.0, 490.0, 0.8),
            frame(14, 1, 1120.0, 470.0, 0.8),
            frame(15, 2, 1120.0, 0.0),
        ]
        flights = telemetry.extract_flights(frames, [])
        self.assertEqual(len(flights), 1)
        self.assertTrue(flights[0]["hasJumpImpulse"])
        self.assertEqual(flights[0]["bestPositiveNormalImpulse"]["frame"], 13)

    def test_noninteractive_annotation_uses_sidecar(self) -> None:
        workspace_temp = Path(__file__).resolve().parents[3] / "temp"
        workspace_temp.mkdir(exist_ok=True)
        trace = workspace_temp / f"rider-telemetry-test-{uuid.uuid4().hex}.jsonl"
        sidecar = telemetry.annotation_path(trace)
        try:
            records = [
                {"kind": "header", "schema": telemetry.SCHEMA},
                {
                    "kind": "marker",
                    "id": 1,
                    "category": "marker",
                    "frame": 100,
                    "lookbackStartFrame": 0,
                },
                {"kind": "footer", "reason": "test"},
            ]
            trace.write_text(
                "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8"
            )
            telemetry.annotate(
                argparse.Namespace(
                    trace=trace,
                    marker=1,
                    label="kicker",
                    note="passed through the lip",
                )
            )
            self.assertTrue(sidecar.exists())
            doc = json.loads(sidecar.read_text(encoding="utf-8"))
            self.assertEqual(doc["annotations"][0]["markerId"], 1)
            self.assertEqual(doc["annotations"][0]["label"], "kicker")
        finally:
            trace.unlink(missing_ok=True)
            sidecar.unlink(missing_ok=True)

    def test_recover_footer_derives_interrupted_capture_counts(self) -> None:
        workspace_temp = Path(__file__).resolve().parents[3] / "temp"
        workspace_temp.mkdir(exist_ok=True)
        trace = workspace_temp / f"rider-telemetry-recover-{uuid.uuid4().hex}.jsonl"
        try:
            records = [
                {"kind": "header", "schema": telemetry.SCHEMA, "detailIntervalFrames": 10},
                {"kind": "frame", "frame": 9, "hostSeconds": 1.0, "coherenceRetries": 1},
                {"kind": "frame", "frame": 10, "hostSeconds": 1.1, "coherenceRetries": 2},
                {"kind": "marker", "frame": 10},
                {"kind": "frame", "frame": 13, "hostSeconds": 1.2, "coherenceRetries": 0},
            ]
            trace.write_text("".join(json.dumps(record) + "\n" for record in records), encoding="utf-8")
            telemetry.recover_footer(argparse.Namespace(trace=trace, reason="test_recovery"))
            footer = list(telemetry.read_trace(trace))[-1]
            self.assertEqual(footer["reason"], "test_recovery")
            self.assertTrue(footer["recovered"])
            self.assertEqual(footer["frames"], 3)
            self.assertEqual(footer["missedFrames"], 2)
            self.assertEqual(footer["coherenceRetries"], 3)
            self.assertEqual(footer["detailDrops"], 1)
            self.assertEqual(footer["markers"], 1)
        finally:
            trace.unlink(missing_ok=True)

    def camera_sample(self, roll_deg: float, lean: float) -> dict:
        """A Z-up sample looking along +Y whose horizon is tipped by `roll_deg`."""
        angle = math.radians(roll_deg)
        return {
            "frame": 0, "renderFrame": None,
            "subject": [0.0, 0.0, 0.0], "look": [0.0, 0.0, 1.0], "eye": [0.0, -5.0, 1.0],
            "forward": [0.0, 1.0, 0.0],
            "up": [math.sin(angle), 0.0, math.cos(angle)],
            "velocity": [0.0, 10.0, 0.0], "upAxis": [0.0, 0.0, 1.0], "lean": lean,
            "air": False, "renderDt": None, "clearance": None,
            "correctionDistanceM": None, "nearClipM": None, "aspect": None, "probes": [],
        }

    def test_camera_roll_sign_and_lean_slope(self) -> None:
        # Looking along +Y with world up +Z, tipping the camera up toward +X puts
        # the horizon down on screen right, which is the positive direction.
        self.assertAlmostEqual(
            telemetry._camera_roll_deg([0.0, 1.0, 0.0], [0.5, 0.0, math.sqrt(0.75)], [0.0, 0.0, 1.0]),
            30.0, places=6,
        )
        self.assertAlmostEqual(
            telemetry._camera_roll_deg([0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, 1.0]),
            0.0, places=6,
        )
        # Roll is undefined looking straight down the up axis rather than wrong.
        self.assertIsNone(
            telemetry._camera_roll_deg([0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0])
        )

        report = telemetry.summarize_camera_samples(
            [
                self.camera_sample(-8.0, -0.6), self.camera_sample(-4.0, -0.4),
                self.camera_sample(0.0, 0.0), self.camera_sample(4.0, 0.4),
                self.camera_sample(8.0, 0.6),
            ]
        )
        self.assertAlmostEqual(report["rollDegPerLeanUnit"], 12.8 / 1.04, places=6)
        self.assertAlmostEqual(report["rollByLeanDeg"]["leftMedian"], -6.0, places=6)
        self.assertAlmostEqual(report["rollByLeanDeg"]["neutralMedian"], 0.0, places=6)
        self.assertAlmostEqual(report["rollByLeanDeg"]["rightMedian"], 6.0, places=6)
        self.assertEqual(report["rollByLeanDeg"]["samples"], {"left": 2, "neutral": 1, "right": 2})
        self.assertAlmostEqual(report["absRollDeg"]["max"], 8.0, places=6)

    def test_camera_roll_absent_without_lean(self) -> None:
        """A trace with no lean still reports roll magnitude, just no correlation."""
        samples = [self.camera_sample(6.0, 0.5), self.camera_sample(-6.0, -0.5)]
        for sample in samples:
            sample["lean"] = None
        report = telemetry.summarize_camera_samples(samples)
        self.assertIsNone(report["rollDegPerLeanUnit"])
        self.assertIsNone(report["rollByLeanDeg"]["leftMedian"])
        self.assertAlmostEqual(report["absRollDeg"]["max"], 6.0, places=6)


class FakePine:
    """In-process stand-in for the PINE client that counts requests.

    Batching is measured in packets, not words: PCSX2 sees one IPC request per
    call regardless of how many commands it carries, and it is the request count
    that decides how long a frame-fenced sample stays open.
    """

    def __init__(self, memory: dict[int, int]) -> None:
        self.memory = memory
        self.packets = 0

    def _read(self, addr: int) -> int:
        if addr % 4:
            raise ValueError(f"unaligned read 0x{addr:08x}")
        return self.memory.get(addr, 0) & 0xFFFFFFFF

    def r32(self, addr: int) -> int:
        self.packets += 1
        return self._read(addr)

    def r32_many(self, addrs) -> list[int]:
        addresses = list(addrs)
        if not addresses:
            return []
        self.packets += 1
        return [self._read(addr) for addr in addresses]

    def r64_many(self, addrs) -> list[int]:
        addresses = list(addrs)
        if not addresses:
            return []
        self.packets += 1
        for addr in addresses:
            if addr % 8:
                raise ValueError(f"unaligned r64 read 0x{addr:08x}")
        return [self._read(addr) | (self._read(addr + 4) << 32) for addr in addresses]


REGISTRY = 0x01000000
WORLD = 0x01100000
BOARDER = 0x01200000
CLOCK = 0x01300000
CAMERA_INDEX = 2
FRAME_NUMBER = 4242


def build_live_memory() -> dict[int, int]:
    memory = {
        telemetry.REGISTRY_PTR: REGISTRY,
        REGISTRY + 0x730: WORLD,
        WORLD + 0xA4: BOARDER,
        WORLD + 0x1C: CLOCK,
        WORLD + 0x290: CAMERA_INDEX,
        CLOCK + 0x18: FRAME_NUMBER,
        BOARDER + 0x41C: 1,  # local human, required by the coherence check
        telemetry.NOCLIP_ACTIVE: 0,
        telemetry.PAD_MASK: 0x0040,  # Cross held
        telemetry.PAD_LX: 200,
        telemetry.PAD_LY: 50,
    }
    # Distinct value per captured boarder word so a mis-sliced region is visible.
    for start, end in telemetry.RAW_REGIONS.values():
        for offset in range(start, end, 4):
            memory.setdefault(BOARDER + offset, 0xB0000000 | offset)
    memory[BOARDER + 0x41C] = 1
    record_base = WORLD + CAMERA_INDEX * telemetry.CAMERA_RECORD_STRIDE
    for offset in range(telemetry.CAMERA_RAW_START, telemetry.CAMERA_RAW_END, 4):
        memory[record_base + offset] = 0xC0000000 | offset
    return memory


class BatchedReadTests(unittest.TestCase):
    def warm_live(self) -> dict[str, int]:
        return {
            "registry": REGISTRY,
            "world": WORLD,
            "boarder": BOARDER,
            "clock": CLOCK,
            "frameAddress": CLOCK + 0x18,
        }

    def test_region_batch_slices_each_region_independently(self) -> None:
        pine = FakePine({0x1000 + i * 4: 0xAA00 + i for i in range(8)})
        batch = telemetry.Region64Batch()
        batch.add("first", 0x1000, 0x10, start=0x40)
        batch.add("second", 0x1010, 0x10, start=0x80)
        regions = batch.run(pine)
        self.assertEqual(pine.packets, 1)
        self.assertEqual(regions["first"], (0x40, [0xAA00, 0xAA01, 0xAA02, 0xAA03]))
        self.assertEqual(regions["second"], (0x80, [0xAA04, 0xAA05, 0xAA06, 0xAA07]))

    def test_region_batch_rejects_unaligned_regions(self) -> None:
        batch = telemetry.Region64Batch()
        with self.assertRaises(ValueError):
            batch.add("odd", 0x1004, 0x10)
        with self.assertRaises(ValueError):
            batch.add("short", 0x1000, 0x0C)

    def test_warm_anchor_costs_one_packet(self) -> None:
        pine = FakePine(build_live_memory())
        registry, world, boarder, clock, camera_index, before = telemetry.read_frame_anchor(
            pine, self.warm_live()
        )
        self.assertEqual(pine.packets, 1)
        self.assertEqual(
            (registry, world, boarder, clock, camera_index, before),
            (REGISTRY, WORLD, BOARDER, CLOCK, CAMERA_INDEX, FRAME_NUMBER),
        )

    def test_cold_anchor_walks_the_chain_and_still_resolves(self) -> None:
        pine = FakePine(build_live_memory())
        anchor = telemetry.read_frame_anchor(pine, {})
        self.assertEqual(anchor[:4], (REGISTRY, WORLD, BOARDER, CLOCK))
        self.assertGreater(pine.packets, 1)

    def test_stale_anchor_cache_falls_back_instead_of_returning_garbage(self) -> None:
        pine = FakePine(build_live_memory())
        stale = {"registry": REGISTRY, "world": 0x09990000, "clock": CLOCK}
        registry, world, boarder, clock, _index, _before = telemetry.read_frame_anchor(pine, stale)
        self.assertEqual((registry, world, boarder, clock), (REGISTRY, WORLD, BOARDER, CLOCK))

    def test_coherent_frame_costs_three_packets_without_the_rig(self) -> None:
        pine = FakePine(build_live_memory())
        live = self.warm_live()
        frame = telemetry.coherent_frame(
            pine, live, start=0.0, input_available=True, rig_context=None, capture_rig=False
        )
        # anchor, the whole fenced payload, and the closing fence.
        self.assertEqual(pine.packets, 3)
        self.assertEqual(frame["frame"], FRAME_NUMBER)
        self.assertEqual(frame["coherenceRetries"], 0)

    def test_coherent_frame_unpacks_pad_words_in_order(self) -> None:
        pine = FakePine(build_live_memory())
        frame = telemetry.coherent_frame(
            pine, self.warm_live(), start=0.0, input_available=True,
            rig_context=None, capture_rig=False,
        )
        self.assertEqual(frame["input"]["heldMask"], 0x0040)
        self.assertEqual(frame["input"]["lx"], 200)
        self.assertEqual(frame["input"]["ly"], 50)
        self.assertEqual(frame["input"]["noclipActive"], 0)

    def test_batched_boarder_regions_match_a_word_at_a_time_read(self) -> None:
        memory = build_live_memory()
        raw = telemetry.read_raw_boarder(FakePine(memory), BOARDER)
        for start, end in telemetry.RAW_REGIONS.values():
            for offset in range(start, end, 4):
                self.assertEqual(raw.u32(offset), memory[BOARDER + offset])

    def test_batched_camera_region_matches_memory(self) -> None:
        memory = build_live_memory()
        camera = telemetry.read_raw_camera(FakePine(memory), WORLD, CAMERA_INDEX)
        record_base = WORLD + CAMERA_INDEX * telemetry.CAMERA_RECORD_STRIDE
        self.assertEqual(camera.record_base, record_base)
        for offset in range(telemetry.CAMERA_RAW_START, telemetry.CAMERA_RAW_END, 4):
            self.assertEqual(camera.word(offset), memory[record_base + offset])

    def test_coherent_frame_retries_when_the_frame_counter_moves(self) -> None:
        memory = build_live_memory()

        class TickingPine(FakePine):
            """Advance the game frame once, mid-sample, on the first attempt."""

            def __init__(self, mem):
                super().__init__(mem)
                self.payloads = 0

            def r64_many(self, addrs):
                values = super().r64_many(addrs)
                self.payloads += 1
                if self.payloads == 1:
                    self.memory[CLOCK + 0x18] = FRAME_NUMBER + 1
                return values

        pine = TickingPine(memory)
        frame = telemetry.coherent_frame(
            pine, self.warm_live(), start=0.0, input_available=True,
            rig_context=None, capture_rig=False,
        )
        self.assertEqual(frame["coherenceRetries"], 1)
        self.assertEqual(frame["frame"], FRAME_NUMBER + 1)


if __name__ == "__main__":
    unittest.main()
