#!/usr/bin/env python3
"""Frame-fenced SSX Tricky rider telemetry recorder over PCSX2 PINE.

The recorder is designed for an ordinary played course. It samples the local
human boarder once per game frame, preserves exact raw words for the compact
physics/state/pose regions, and emits convenient decoded fields in JSONL.

Safe played-run workflow (PAL SLES-50545):

  1. Pause the *VM* in PCSX2 (not only SSX's pause menu).
  2. python tools/instrumentation/rider_telemetry.py prepare
  3. python tools/instrumentation/rider_telemetry.py capture --label snowdream
  4. Resume PCSX2 and play. Press Circle after anything interesting.
  5. python tools/instrumentation/rider_telemetry.py stop (from another terminal) stops capture.
  6. Pause the VM again; python tools/instrumentation/rider_telemetry.py restore

Background marker hotkeys: Ctrl+Shift+M generic, J jump, G ground/contact,
L landing, P pass-through. Markers include a configurable lookback window, so
they can be pressed after the problem is seen. Ctrl+C also stops capture when
the terminal has focus.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import math
import os
import platform
import statistics
import struct
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from pine_hooks import Pine, SITES as NOCLIP_SITES, is_stock, j_ins, restore_stock  # noqa: E402

SCHEMA = "ssx-tricky-rider-telemetry/v4"
SUPPORTED_SCHEMAS = {
    "ssx-tricky-rider-telemetry/v1",
    "ssx-tricky-rider-telemetry/v2",
    "ssx-tricky-rider-telemetry/v3",
    SCHEMA,
}
EXPECTED_GAME_ID = "SLES-50545"
REPO_ROOT = Path(__file__).resolve().parents[3]
REGISTRY_PTR = 0x00338E58
PREPARE_STATE = Path("temp/telemetry/rider-telemetry-hook-state.json")
STOP_FILE = Path("temp/telemetry/rider-telemetry-stop.request")

# The active noclip code reads/writes these fields. prepare leaves only the
# read-only pad observer (site A) installed and disconnects B/C/D from it.
NOCLIP_ACTIVE = 0x002B4C40
PAD_MASK = 0x002B4C48
PAD_LX = 0x002B4C4C
PAD_LY = 0x002B4C50
PAD_MARKER_BUTTON = 0x0020  # Circle in the active-high low 16-bit held mask

# The four pad words sit inside one 8-aligned span, so a frame samples them as a
# region alongside the boarder rather than as four separate round trips.
PAD_REGION_BASE = NOCLIP_ACTIVE
PAD_REGION_BYTES = 0x18

UNITS_PER_METER = 100.0
SIM_HZ = 60.0
MAX_REASONABLE_FRAME_GAP = 600

# Each viewport/render-gather slot is 128 bytes apart. The active slot's live
# camera transform begins at +0xB0: position followed by a 3x3 basis stored as
# rows. +0x100 is the horizontal half-FOV in radians and +0x104 is the near
# clip distance in engine units; preserve the remaining adjacent words too.
CAMERA_RECORD_STRIDE = 0x80
CAMERA_RAW_START = 0xB0
CAMERA_RAW_END = 0x110

# Lean bins the camera roll study reports against, matching rig-study's defaults
# so a single capture describes the pose and the camera on the same turns.
CAMERA_LEAN_THRESHOLD = 0.35
CAMERA_NEUTRAL_THRESHOLD = 0.08

# The boarder owns six fixed-size render-part records.  Model part id 0 is the
# animated body.  Its MPF skeleton pointer/count and post-blend local pose are
# live after BoarderAnim's per-frame evaluator (0x0015f7e0).  Retail body AFLs
# have exactly 60 channels: root translation plus 19 x 3 local Euler rotations.
RIDER_PART_COUNT_OFFSET = 0x7BC
RIDER_PARTS_OFFSET = 0x7C0
RIDER_PART_STRIDE = 0x394
RIDER_BODY_PART_ID = 0
RIDER_PART_ID_OFFSET = 0x384
RIDER_SKELETON_PTR_OFFSET = 0x388
RIDER_BONE_COUNT_OFFSET = 0x38C
RIDER_LOCAL_ROTATIONS_OFFSET = 0x000
RIDER_LOCAL_TRANSLATIONS_OFFSET = 0x108
RIDER_ANIM_CONTROLLER_OFFSET = 0x46C0
RIDER_ANIM_EVENT_IDS_OFFSET = RIDER_ANIM_CONTROLLER_OFFSET + 0x08
RIDER_RENDER_TRANSFORM_OFFSET = 0x4A90
RIDER_RENDER_TRANSFORM_WORDS = 16
BONE_RECORD_SIZE = 84
BONE_NAME_SIZE = 16
BONE_PARENT_OFFSET = 0x12
BONE_TRANSLATION_OFFSET = 0x18
BONE_ROTATION_OFFSET = 0x24
MAX_RIDER_PARTS = 16
MAX_RIDER_BONES = 64

# Exact core regions kept on every frame. Fragmenting the boarder this way cuts
# synchronous PINE calls enough to stay well inside one 60 Hz tick. Less
# time-critical path/render/contact-detail regions are emitted separately.
RAW_REGIONS: dict[str, tuple[int, int]] = {
    "timing": (0x128, 0x130),
    "motion": (0x140, 0x190),
    "motionScalars": (0x1B0, 0x1D0),
    "controlA": (0x1F8, 0x210),
    "controlB": (0x210, 0x248),
    "contact": (0x288, 0x2B0),
    "smoothedUp": (0x2C0, 0x2D0),
    "groundState": (0x2E0, 0x2E8),
    "contactBasis": (0x318, 0x340),
    "surfacePose": (0x300, 0x318),
    "state": (0x418, 0x430),
}

DETAIL_REGIONS: dict[str, tuple[int, int]] = {
    "contactAux": (0x2B0, 0x2C0),
    "probeTangent": (0x2D0, 0x2E0),
    "path": (0x340, 0x380),
    "pose": (0x4A90, 0x4AD0),
}

MOTION_STATES = {
    0: "static",
    1: "air",
    2: "ground",
    3: "rail",
    4: "aux_contact",
    5: "landing_or_wipeout",
    6: "recover_contact",
}

CONTROL_STATES = {
    3: "cruise",
    8: "air_prewind",
    9: "air_spin",
    10: "jump_release_wait",
    13: "airborne",
    14: "jump_charge",
    15: "rail_entry",
    16: "rail_control",
    19: "wipeout",
    20: "recover_wait",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def evidence_path(path: Path) -> str:
    """How a trace is named inside a saved report.

    These reports are archived as research evidence and quoted in Trailmap notes, so they record a
    path relative to the repository rather than to the machine that captured it. A trace from outside
    the repository keeps only its file name.
    """
    resolved = Path(path).resolve()
    try:
        return resolved.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return resolved.name


def hex32(value: int) -> str:
    return f"0x{value & 0xFFFFFFFF:08x}"


def read_words(pine: Pine, addr: int, count: int) -> list[int]:
    return pine.r32_many(addr + i * 4 for i in range(count))


def write_words(pine: Pine, addr: int, words: list[int]) -> None:
    for i, word in enumerate(words):
        pine.w32(addr + i * 4, word)


class Region64Batch:
    """Collect several 8-byte-aligned EE regions and fetch them in one PINE packet.

    A frame-fenced sample is only as good as the time it spans: every extra host
    round trip widens the window the game can tick inside, and a sample that
    straddles a tick is discarded and retried. Retries cost enough wall time to
    lose the next game frame outright, so packet count is the direct lever on the
    capture's missed-frame rate.
    """

    def __init__(self) -> None:
        self._addresses: list[int] = []
        self._spans: list[tuple[str, int, int, int]] = []

    def add(self, key: str, addr: int, byte_count: int, start: int = 0) -> None:
        """Queue `byte_count` bytes at `addr`, recorded under `key` with region offset `start`."""
        if addr % 8 or byte_count % 8:
            raise ValueError("r64 telemetry regions must be 8-byte aligned")
        index = len(self._addresses)
        self._addresses.extend(range(addr, addr + byte_count, 8))
        self._spans.append((key, start, index, byte_count // 8))

    def run(self, pine: Pine) -> dict[str, tuple[int, list[int]]]:
        values = pine.r64_many(self._addresses)
        regions: dict[str, tuple[int, list[int]]] = {}
        for key, start, index, count in self._spans:
            words: list[int] = []
            for value in values[index:index + count]:
                words.extend((value & 0xFFFFFFFF, value >> 32))
            regions[key] = (start, words)
        return regions


def read_region64(pine: Pine, addr: int, byte_count: int) -> list[int]:
    batch = Region64Batch()
    batch.add("region", addr, byte_count)
    return batch.run(pine)["region"][1]


def words_hex(words: list[int]) -> str:
    return struct.pack(f"<{len(words)}I", *words).hex()


def bits_float(word: int) -> float | None:
    value = struct.unpack("<f", struct.pack("<I", word & 0xFFFFFFFF))[0]
    return value if math.isfinite(value) else None


class RawBoarder:
    def __init__(self, regions: dict[str, tuple[int, list[int]]]):
        self.regions = regions

    def word(self, offset: int) -> int:
        for _, (start, words) in self.regions.items():
            index = offset - start
            if index >= 0 and index % 4 == 0 and index // 4 < len(words):
                return words[index // 4]
        raise KeyError(f"boarder offset +0x{offset:x} is outside captured raw regions")

    def u32(self, offset: int) -> int:
        return self.word(offset)

    def f32(self, offset: int) -> float | None:
        return bits_float(self.word(offset))

    def vec(self, offset: int, count: int = 4) -> list[float | None]:
        return [self.f32(offset + i * 4) for i in range(count)]

    def encoded(self) -> dict[str, str]:
        return {name: words_hex(words) for name, (_, words) in self.regions.items()}


class RawCamera:
    def __init__(self, active_index: int, record_base: int, words: list[int]):
        self.active_index = active_index
        self.record_base = record_base
        self.words = words

    def word(self, offset: int) -> int:
        index = offset - CAMERA_RAW_START
        if index < 0 or index % 4 or index // 4 >= len(self.words):
            raise KeyError(f"camera offset +0x{offset:x} is outside the captured raw region")
        return self.words[index // 4]

    def f32(self, offset: int) -> float | None:
        return bits_float(self.word(offset))

    def vec(self, offset: int, count: int = 4) -> list[float | None]:
        return [self.f32(offset + i * 4) for i in range(count)]

    def encoded(self) -> str:
        return words_hex(self.words)


class RawRig:
    def __init__(
        self,
        context: dict[str, Any],
        rotation_words: list[int],
        root_translation_words: list[int],
        render_transform_words: list[int],
        event_words: list[int],
    ):
        self.context = context
        self.rotation_words = rotation_words
        self.root_translation_words = root_translation_words
        self.render_transform_words = render_transform_words
        self.event_words = event_words

    @staticmethod
    def floats(words: list[int]) -> list[float | None]:
        return [bits_float(word) for word in words]

    def encoded(self) -> dict[str, str]:
        return {
            "localRotations": words_hex(self.rotation_words),
            "rootTranslation": words_hex(self.root_translation_words),
            "renderTransform": words_hex(self.render_transform_words),
            "eventIds": words_hex(self.event_words),
        }


def hook_states(pine: Pine) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for name, (site, digest, cave) in NOCLIP_SITES.items():
        words = read_words(pine, site, 2)
        if is_stock(words, digest):
            state = "stock"
        elif words == [j_ins(cave), 0]:
            state = "hooked"
        else:
            state = "unknown"
        result[name] = {
            "site": hex32(site),
            "words": [hex32(word) for word in words],
            "state": state,
        }
    return result


def require_vm_paused(pine: Pine, operation: str) -> None:
    status = pine.status()
    if status != 1:
        states = {0: "running", 1: "paused", 2: "shutdown"}
        raise RuntimeError(
            f"Refusing to {operation} while the PCSX2 VM is "
            f"{states.get(status, f'unknown:{status}')}. Use PCSX2 Pause Emulation first; "
            "SSX's own pause/start screen does not pause the VM."
        )


def validate_game(pine: Pine) -> None:
    game_id = pine.game_id()
    if game_id != EXPECTED_GAME_ID:
        raise RuntimeError(f"Expected {EXPECTED_GAME_ID}, found {game_id or '<no game>'}.")


def prepare() -> int:
    if PREPARE_STATE.exists():
        raise RuntimeError(f"Telemetry is already prepared; restore first using {PREPARE_STATE}.")
    pine = Pine()
    validate_game(pine)
    require_vm_paused(pine, "prepare telemetry hooks")
    states = hook_states(pine)
    if states["a"]["state"] != "hooked":
        raise RuntimeError(
            "Pad observer hook A is not installed. Restore/install the repository noclip patch first; "
            "telemetry uses its passive pad capture but disables every gameplay-changing hook."
        )
    for name in ("b", "c", "d"):
        if states[name]["state"] not in ("stock", "hooked"):
            raise RuntimeError(f"Noclip site {name.upper()} is unknown; refusing to overwrite it.")

    saved = {
        "kind": "ssx-tricky-rider-telemetry-live-hook-state",
        "savedAtUtc": utc_now(),
        "gameId": pine.game_id(),
        "active": pine.r32(NOCLIP_ACTIVE),
        "sites": {
            name: read_words(pine, NOCLIP_SITES[name][0], 2)
            for name in ("b", "c", "d")
        },
    }
    PREPARE_STATE.parent.mkdir(parents=True, exist_ok=True)
    PREPARE_STATE.write_text(json.dumps(saved, indent=2) + "\n", encoding="utf-8")

    try:
        pine.w32(NOCLIP_ACTIVE, 0)
        for name in ("b", "c", "d"):
            # A detoured site gets its stock words copied back from the operator's own executable.
            restore_stock(pine, name)
        verified = hook_states(pine)
        if any(verified[name]["state"] != "stock" for name in ("b", "c", "d")):
            raise RuntimeError("One or more noclip control hooks failed stock verification.")
    except Exception:
        try:
            for name in ("b", "c", "d"):
                write_words(pine, NOCLIP_SITES[name][0], saved["sites"][name])
            pine.w32(NOCLIP_ACTIVE, saved["active"])
            PREPARE_STATE.unlink()
        except Exception as rollback_error:
            raise RuntimeError(
                f"Prepare failed and rollback also failed; recovery state remains at {PREPARE_STATE}."
            ) from rollback_error
        raise

    print("Telemetry prepared: passive pad hook A retained; noclip/control hooks B/C/D are stock.")
    print(f"Recovery state: {PREPARE_STATE}")
    return 0


def restore() -> int:
    if not PREPARE_STATE.exists():
        raise RuntimeError(f"No telemetry prepare state exists at {PREPARE_STATE}.")
    saved = json.loads(PREPARE_STATE.read_text(encoding="utf-8"))
    pine = Pine()
    validate_game(pine)
    require_vm_paused(pine, "restore telemetry hooks")
    if saved.get("gameId") != pine.game_id():
        raise RuntimeError("Saved telemetry hook state belongs to a different game image.")

    for name in ("b", "c", "d"):
        write_words(pine, NOCLIP_SITES[name][0], saved["sites"][name])
    pine.w32(NOCLIP_ACTIVE, saved["active"])
    for name in ("b", "c", "d"):
        if read_words(pine, NOCLIP_SITES[name][0], 2) != saved["sites"][name]:
            raise RuntimeError(f"Site {name.upper()} failed restore verification; state file retained.")
    if pine.r32(NOCLIP_ACTIVE) != saved["active"]:
        raise RuntimeError("Noclip active flag failed restore verification; state file retained.")
    PREPARE_STATE.unlink()
    print("Original noclip hook words and active flag restored exactly.")
    return 0


def resolve_live(pine: Pine) -> dict[str, int]:
    registry = pine.r32(REGISTRY_PTR)
    if not registry:
        raise RuntimeError("SSX registry pointer is null; load into a course first.")
    world = pine.r32(registry + 0x730)
    if not world:
        raise RuntimeError("SSX world object is null; load into a course first.")
    boarder = pine.r32(world + 0xA4)
    clock = pine.r32(world + 0x1C)
    if not boarder or not clock:
        raise RuntimeError("Local boarder or game clock pointer is null.")
    local = pine.r32(boarder + 0x41C)
    if local != 1:
        raise RuntimeError(f"Resolved boarder is not the local human (+0x41C={local}).")
    return {
        "registry": registry,
        "world": world,
        "boarder": boarder,
        "clock": clock,
        "frameAddress": clock + 0x18,
    }


def plan_boarder_regions(
    batch: Region64Batch, boarder: int, definitions: dict[str, tuple[int, int]]
) -> None:
    for name, (start, end) in definitions.items():
        batch.add(f"boarder:{name}", boarder + start, end - start, start)


def take_boarder_regions(
    regions: dict[str, tuple[int, list[int]]], definitions: dict[str, tuple[int, int]]
) -> RawBoarder:
    return RawBoarder({name: regions[f"boarder:{name}"] for name in definitions})


def plan_camera_region(batch: Region64Batch, world: int, active_index: int) -> int:
    record_base = world + active_index * CAMERA_RECORD_STRIDE
    batch.add("camera", record_base + CAMERA_RAW_START, CAMERA_RAW_END - CAMERA_RAW_START)
    return record_base


def read_boarder_regions(
    pine: Pine, boarder: int, definitions: dict[str, tuple[int, int]]
) -> RawBoarder:
    batch = Region64Batch()
    plan_boarder_regions(batch, boarder, definitions)
    return take_boarder_regions(batch.run(pine), definitions)


def read_raw_boarder(pine: Pine, boarder: int) -> RawBoarder:
    return read_boarder_regions(pine, boarder, RAW_REGIONS)


def read_raw_camera(pine: Pine, world: int, active_index: int) -> RawCamera:
    batch = Region64Batch()
    record_base = plan_camera_region(batch, world, active_index)
    return RawCamera(active_index, record_base, batch.run(pine)["camera"][1])


def decode_camera(raw: RawCamera) -> dict[str, Any]:
    # The three stored rows transpose into the world-space right/up/forward
    # columns. The forward column points from the eye into the rendered scene.
    rows = [raw.vec(0xC0 + row * 0x10, 3) for row in range(3)]
    half_fov_x = raw.f32(0x100)
    fov_x_deg = math.degrees(2 * half_fov_x) if half_fov_x is not None else None
    fov_y_4x3_deg = (
        math.degrees(2 * math.atan(math.tan(half_fov_x) / (4 / 3)))
        if half_fov_x is not None else None
    )
    return {
        "activeIndex": raw.active_index,
        "recordBase": hex32(raw.record_base),
        "position": raw.vec(0xB0),
        "right": [rows[row][0] for row in range(3)],
        "up": [rows[row][1] for row in range(3)],
        "forward": [rows[row][2] for row in range(3)],
        "basisRows": rows,
        "halfFovXRad": half_fov_x,
        "fovXDeg": fov_x_deg,
        "fovY4x3Deg": fov_y_4x3_deg,
        "nearClipUnits": raw.f32(0x104),
        "raw": raw.encoded(),
    }


def _valid_ee_pointer(address: int) -> bool:
    return 0x00100000 <= address < 0x02000000 and address % 4 == 0


def _words_blob(words: list[int]) -> bytes:
    return struct.pack(f"<{len(words)}I", *words)


def public_rig_context(context: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in context.items() if not key.startswith("_")}


def resolve_body_rig(pine: Pine, boarder: int) -> dict[str, Any]:
    """Resolve model-part 0 and decode its live MPF skeleton metadata."""
    part_count = pine.r32(boarder + RIDER_PART_COUNT_OFFSET)
    if not 1 <= part_count <= MAX_RIDER_PARTS:
        raise RuntimeError(f"Implausible rider render-part count {part_count}.")

    meta_addresses: list[int] = []
    for index in range(part_count):
        part = boarder + RIDER_PARTS_OFFSET + index * RIDER_PART_STRIDE
        meta_addresses.extend(
            (
                part + RIDER_PART_ID_OFFSET,
                part + RIDER_SKELETON_PTR_OFFSET,
                part + RIDER_BONE_COUNT_OFFSET,
            )
        )
    metadata = pine.r32_many(meta_addresses)
    found: tuple[int, int, int, int] | None = None
    for index in range(part_count):
        part_id, skeleton, bone_count = metadata[index * 3:index * 3 + 3]
        if part_id == RIDER_BODY_PART_ID and skeleton and bone_count:
            found = (index, part_id, skeleton, bone_count)
            break
    if found is None:
        raise RuntimeError("Rider body render part has no live skeleton.")

    part_index, part_id, skeleton, bone_count = found
    part = boarder + RIDER_PARTS_OFFSET + part_index * RIDER_PART_STRIDE
    if not _valid_ee_pointer(skeleton):
        raise RuntimeError(f"Implausible rider skeleton pointer {hex32(skeleton)}.")
    if not 1 <= bone_count <= MAX_RIDER_BONES:
        raise RuntimeError(f"Implausible rider body bone count {bone_count}.")

    skeleton_words = read_words(pine, skeleton, bone_count * (BONE_RECORD_SIZE // 4))
    skeleton_blob = _words_blob(skeleton_words)
    bones: list[dict[str, Any]] = []
    for index in range(bone_count):
        offset = index * BONE_RECORD_SIZE
        name = skeleton_blob[offset:offset + BONE_NAME_SIZE].split(b"\0", 1)[0].decode(
            "ascii", errors="replace"
        )
        parent = struct.unpack_from("<h", skeleton_blob, offset + BONE_PARENT_OFFSET)[0]
        animation_index = struct.unpack_from("<h", skeleton_blob, offset + 0x16)[0]
        translation = list(
            struct.unpack_from("<3f", skeleton_blob, offset + BONE_TRANSLATION_OFFSET)
        )
        rotation = list(
            struct.unpack_from("<3f", skeleton_blob, offset + BONE_ROTATION_OFFSET)
        )
        bones.append(
            {
                "index": index,
                "name": name,
                "parent": parent,
                "animationIndex": animation_index,
                "bindTranslation": translation,
                "bindRotationRad": rotation,
            }
        )

    return {
        "source": "post-blend body locals after BoarderAnim evaluator 0x0015f7e0",
        "modelPartId": part_id,
        "partIndex": part_index,
        "partAddress": hex32(part),
        "skeletonAddress": hex32(skeleton),
        "boneCount": bone_count,
        "channelCount": 3 + bone_count * 3,
        "rotationUnit": "radians",
        "translationUnit": "engine units",
        "rotationOrder": "negated local XYZ Euler composed as Rz*Ry*Rx",
        "bones": bones,
        "rawSkeleton": skeleton_blob.hex(),
        "_boarder": boarder,
        "_part": part,
        "_skeleton": skeleton,
    }


def read_rig_sample(pine: Pine, boarder: int, context: dict[str, Any]) -> tuple[RawRig, bool]:
    """Read the evaluated pose and the identity words that vouch for it, in one packet.

    The part id, skeleton pointer and bone count prove the pose came from the
    part the context describes and that it did not change mid-sample, so they
    belong in the same request as the pose rather than a round trip after it.
    """
    part = context["_part"]
    bone_count = context["boneCount"]
    rotation_count = bone_count * 3
    addresses = [part + RIDER_LOCAL_ROTATIONS_OFFSET + i * 4 for i in range(rotation_count)]
    addresses.extend(part + RIDER_LOCAL_TRANSLATIONS_OFFSET + i * 4 for i in range(3))
    addresses.extend(
        boarder + RIDER_RENDER_TRANSFORM_OFFSET + i * 4
        for i in range(RIDER_RENDER_TRANSFORM_WORDS)
    )
    addresses.extend(boarder + RIDER_ANIM_EVENT_IDS_OFFSET + i * 4 for i in range(3))
    addresses.extend(
        (
            part + RIDER_PART_ID_OFFSET,
            part + RIDER_SKELETON_PTR_OFFSET,
            part + RIDER_BONE_COUNT_OFFSET,
        )
    )
    words = pine.r32_many(addresses)
    cursor = 0
    rotations = words[cursor:cursor + rotation_count]
    cursor += rotation_count
    root_translation = words[cursor:cursor + 3]
    cursor += 3
    render_transform = words[cursor:cursor + RIDER_RENDER_TRANSFORM_WORDS]
    cursor += RIDER_RENDER_TRANSFORM_WORDS
    events = words[cursor:cursor + 3]
    cursor += 3
    part_id, skeleton, live_bone_count = words[cursor:cursor + 3]
    stable = (
        part_id == context["modelPartId"]
        and skeleton == context["_skeleton"]
        and live_bone_count == bone_count
    )
    return RawRig(context, rotations, root_translation, render_transform, events), stable


def decode_rig(raw: RawRig) -> dict[str, Any]:
    rotation_values = raw.floats(raw.rotation_words)
    rotations = [rotation_values[index:index + 3] for index in range(0, len(rotation_values), 3)]
    render_values = raw.floats(raw.render_transform_words)
    return {
        "modelPartId": raw.context["modelPartId"],
        "partAddress": raw.context["partAddress"],
        "skeletonAddress": raw.context["skeletonAddress"],
        "boneCount": raw.context["boneCount"],
        "eventIds": raw.event_words,
        "rootTranslation": raw.floats(raw.root_translation_words),
        "localRotationsRad": rotations,
        "renderPosition": render_values[:4],
        "renderMatrixRows": [render_values[index:index + 4] for index in range(4, 16, 4)],
        "raw": raw.encoded(),
    }


def decode_frame(
    frame: int,
    elapsed: float,
    boarder: int,
    raw: RawBoarder,
    camera: RawCamera,
    pad: tuple[int, int, int, int] | None,
    retries: int,
    rig: RawRig | None = None,
) -> dict[str, Any]:
    motion = raw.u32(0x424)
    control = raw.u32(0x428)
    lean = raw.f32(0x214)
    rider_mode = raw.u32(0x420)
    bank_scale = 1.13446403 if rider_mode == 2 else 0.87266463
    bank_radians = 0.0 if motion == 3 or lean is None else lean * bank_scale
    pad_doc = None
    if pad is not None:
        active, mask_word, lx, ly = pad
        pad_doc = {
            "heldMask": mask_word & 0xFFFF,
            "rawMaskWord": hex32(mask_word),
            "lx": lx & 0xFF,
            "ly": ly & 0xFF,
            "noclipActive": active,
        }
    return {
        "kind": "frame",
        "frame": frame,
        "hostSeconds": round(elapsed, 6),
        "boarder": hex32(boarder),
        "coherenceRetries": retries,
        "input": pad_doc,
        "state": {
            "motion": motion,
            "motionName": MOTION_STATES.get(motion, f"unknown_{motion}"),
            "control": control,
            "controlName": CONTROL_STATES.get(control, f"unknown_{control}"),
            "raceFlag": raw.u32(0x418),
            "localHuman": raw.u32(0x41C),
            "riderMode": rider_mode,
            "groundSubstate": raw.u32(0x2E0),
        },
        "motion": {
            "position": raw.vec(0x140),
            "velocity": raw.vec(0x150),
            "orientation": raw.vec(0x170),
            # Local board +Y transformed by the orientation quaternion: the visible down-course deck axis.
            # `airOrientation` is retained as a schema-v2 compatibility alias for already-recorded traces.
            "boardForward": raw.vec(0x180),
            "airOrientation": raw.vec(0x180),
            "tickScale": raw.f32(0x12C),
            "heading": raw.f32(0x1B0),
            "speedCap": raw.f32(0x1C4),
        },
        "camera": decode_camera(camera),
        "contact": {
            "error": raw.f32(0x1BC),
            "surfaceType": raw.u32(0x290),
            "bogDepth": raw.f32(0x294),
            "budgetDepth": raw.f32(0x298),
            "normal": raw.vec(0x2A0),
            "smoothedUp": raw.vec(0x2C0),
            "visualLift": raw.f32(0x308),
            "tangent": raw.vec(0x320),
            "lateral": raw.vec(0x330),
        },
        "control": {
            "jumpCharge": raw.f32(0x208),
            "chargeOrSpinSnapshot": raw.f32(0x1C8),
            "rawSlip": raw.f32(0x1FC),
            "leanSlew": raw.vec(0x214, 3),
            "leanPoseOffset": raw.f32(0x244),
            "renderBankRad": bank_radians,
            "prewindA": raw.vec(0x220, 3),
            "prewindB": raw.vec(0x22C, 3),
            "spinSlew": raw.vec(0x238, 3),
        },
        "rig": decode_rig(rig) if rig is not None else None,
        "raw": raw.encoded(),
    }


def read_frame_anchor(pine: Pine, live: dict[str, int]) -> tuple[int, int, int, int, int, int]:
    """Resolve the pointer chain and the opening frame fence.

    The chain is re-checked every frame because restarting a run or changing race
    mode can replace the boarder allocation. Checking it against the previous
    frame's pointers keeps that to one packet, since every address is then known
    up front; only a genuine change falls back to walking the chain dependently.
    """
    registry = live.get("registry", 0)
    world = live.get("world", 0)
    clock = live.get("clock", 0)
    if registry and world and clock:
        found_registry, found_world, boarder, found_clock, camera_index, before = pine.r32_many(
            (
                REGISTRY_PTR,
                registry + 0x730,
                world + 0xA4,
                world + 0x1C,
                world + 0x290,
                clock + 0x18,
            )
        )
        if (found_registry, found_world, found_clock) == (registry, world, clock) and boarder:
            return registry, world, boarder, clock, camera_index, before
    registry = pine.r32(REGISTRY_PTR)
    world = pine.r32(registry + 0x730) if registry else 0
    boarder = pine.r32(world + 0xA4) if world else 0
    clock = pine.r32(world + 0x1C) if world else 0
    if not boarder or not clock:
        raise RuntimeError("live rider context is temporarily unavailable")
    camera_index, before = pine.r32_many((world + 0x290, clock + 0x18))
    return registry, world, boarder, clock, camera_index, before


def coherent_frame(
    pine: Pine,
    live: dict[str, int],
    start: float,
    input_available: bool,
    rig_context: dict[str, Any] | None = None,
    capture_rig: bool = True,
) -> dict[str, Any]:
    retries = 0
    deadline = time.monotonic() + 5.0
    while True:
        try:
            registry, world, boarder, clock, camera_index, before = read_frame_anchor(pine, live)
            frame_address = clock + 0x18

            # One packet for the whole fenced payload: every boarder region, the
            # active camera record and the pad words.
            batch = Region64Batch()
            plan_boarder_regions(batch, boarder, RAW_REGIONS)
            record_base = plan_camera_region(batch, world, camera_index)
            if input_available:
                batch.add("pad", PAD_REGION_BASE, PAD_REGION_BYTES)
            regions = batch.run(pine)
            raw = take_boarder_regions(regions, RAW_REGIONS)
            camera = RawCamera(camera_index, record_base, regions["camera"][1])
            pad = None
            if input_available:
                pad_words = regions["pad"][1]
                pad = tuple(
                    pad_words[(address - PAD_REGION_BASE) // 4]
                    for address in (NOCLIP_ACTIVE, PAD_MASK, PAD_LX, PAD_LY)
                )

            active_rig_context = None
            rig = None
            rig_stable = not capture_rig
            if capture_rig:
                active_rig_context = (
                    rig_context
                    if rig_context is not None and rig_context.get("_boarder") == boarder
                    else resolve_body_rig(pine, boarder)
                )
                rig, rig_stable = read_rig_sample(pine, boarder, active_rig_context)

            after, world_after, boarder_after, clock_after, camera_after = pine.r32_many(
                (frame_address, registry + 0x730, world + 0xA4, world + 0x1C, world + 0x290)
            )
            stable = (
                before == after
                and world_after == world
                and boarder_after == boarder
                and clock_after == clock
                and camera_after == camera_index
                and raw.u32(0x41C) == 1
                and rig_stable
            )
            if stable:
                live.update(
                    registry=registry,
                    world=world,
                    boarder=boarder,
                    clock=clock,
                    frameAddress=frame_address,
                )
                if (
                    rig_context is not None
                    and active_rig_context is not None
                    and active_rig_context is not rig_context
                ):
                    rig_context.clear()
                    rig_context.update(active_rig_context)
                return decode_frame(
                    before, time.monotonic() - start, boarder, raw, camera, pad, retries, rig
                )
        except (OSError, RuntimeError):
            pass
        retries += 1
        if time.monotonic() >= deadline:
            raise RuntimeError(f"Could not obtain a stable local-rider frame after {retries} retries.")
        time.sleep(0.001)


def frame_gap(previous: int, current: int) -> tuple[int, bool]:
    """Return (missed frames, discontinuity) across a u32 game-frame counter."""
    delta = (current - previous) & 0xFFFFFFFF
    if delta <= 1:
        return 0, False
    if delta <= MAX_REASONABLE_FRAME_GAP:
        return delta - 1, False
    return 0, True


def coherent_detail(
    pine: Pine, live: dict[str, int], start: float
) -> dict[str, Any] | None:
    """Best-effort slow detail; discard rather than delay core frame capture."""
    try:
        registry, world, boarder, clock, _camera_index, before = read_frame_anchor(pine, live)
        raw = read_boarder_regions(pine, boarder, DETAIL_REGIONS)
        after, world_after, boarder_after, clock_after = pine.r32_many(
            (clock + 0x18, registry + 0x730, world + 0xA4, world + 0x1C)
        )
        if (
            before != after
            or world_after != world
            or boarder_after != boarder
            or clock_after != clock
        ):
            return None
        return {
            "kind": "detail",
            "frame": before,
            "hostSeconds": round(time.monotonic() - start, 6),
            "boarder": hex32(boarder),
            "contact": {
                "frameAux": raw.vec(0x2B0),
                "probeTangent": raw.vec(0x2D0),
            },
            "path": {
                "previousArc": raw.f32(0x340),
                "currentArc": raw.f32(0x344),
                "perpendicular": raw.f32(0x348),
                "closestPoint": raw.vec(0x350),
                "lookaheadTarget": raw.vec(0x360),
                "pathHeading": raw.f32(0x370),
                "distanceToFinish": raw.f32(0x374),
            },
            "pose": {
                "odometerPosition": raw.vec(0x4A90),
                "boardMatrix": raw.vec(0x4AA0, 12),
            },
            "raw": raw.encoded(),
        }
    except (OSError, RuntimeError):
        return None


class GlobalHotkeys:
    """Edge-triggered Windows hotkeys that work while PCSX2 owns focus."""

    VK_CONTROL = 0x11
    VK_SHIFT = 0x10
    KEYS = {
        0x4D: "marker",       # M
        0x4A: "jump",         # J
        0x47: "ground",       # G
        0x4C: "landing",      # L
        0x50: "pass_through", # P
        0x51: "stop",         # Q
    }

    def __init__(self):
        self.available = os.name == "nt"
        self._down = {key: False for key in self.KEYS}
        self._get = ctypes.windll.user32.GetAsyncKeyState if self.available else None

    def key_down(self, key: int) -> bool:
        return bool(self._get(key) & 0x8000) if self._get else False

    def poll(self) -> list[str]:
        if not self.available:
            return []
        modifiers = self.key_down(self.VK_CONTROL) and self.key_down(self.VK_SHIFT)
        events: list[str] = []
        for key, name in self.KEYS.items():
            down = modifiers and self.key_down(key)
            if down and not self._down[key]:
                events.append(name)
            self._down[key] = down
        return events


def safe_capture_layout(states: dict[str, dict[str, Any]], active: int) -> tuple[bool, str]:
    if states["a"]["state"] != "hooked":
        return False, "passive pad observer hook A is not installed"
    if any(states[name]["state"] != "stock" for name in ("b", "c", "d")):
        return False, "noclip/control hooks B/C/D are still connected"
    if active != 0:
        return False, "noclip active flag is nonzero"
    return True, "passive input observer only"


def default_output(label: str) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in label).strip("-") or "run"
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return Path("temp/telemetry") / f"{safe}-{stamp}.jsonl"


def request_stop() -> int:
    STOP_FILE.parent.mkdir(parents=True, exist_ok=True)
    STOP_FILE.write_text(utc_now() + "\n", encoding="utf-8")
    print(f"Stop requested via {STOP_FILE}")
    return 0


def clear_stop_request() -> str | None:
    """Best-effort cleanup resilient to short Windows indexer/AV file locks."""
    for attempt in range(20):
        try:
            STOP_FILE.unlink(missing_ok=True)
            return None
        except PermissionError as exc:
            if attempt == 19:
                return str(exc)
            time.sleep(0.01 * (attempt + 1))
    return None


def marker_record(
    marker_id: int,
    category: str,
    source: str,
    sample: dict[str, Any],
    lookback_seconds: float,
) -> dict[str, Any]:
    frame = sample["frame"]
    return {
        "kind": "marker",
        "id": marker_id,
        "category": category,
        "source": source,
        "frame": frame,
        "hostSeconds": sample["hostSeconds"],
        "lookbackSeconds": lookback_seconds,
        "lookbackStartFrame": max(0, frame - round(lookback_seconds * SIM_HZ)),
        "state": sample["state"],
        "position": sample["motion"]["position"],
        "velocity": sample["motion"]["velocity"],
    }


def capture(args: argparse.Namespace) -> int:
    pine = Pine()
    validate_game(pine)
    states = hook_states(pine)
    active = pine.r32(NOCLIP_ACTIVE)
    safe, safety_note = safe_capture_layout(states, active)
    if not safe and not args.allow_control_hooks:
        raise RuntimeError(
            f"Capture is not in observer-only mode: {safety_note}. Pause the PCSX2 VM and run "
            "`python tools/instrumentation/rider_telemetry.py prepare`, then resume and capture."
        )
    input_available = states["a"]["state"] == "hooked"
    live = resolve_live(pine)
    # A golden run is only golden if it has every frame. The rig and detail passes
    # are the two reads that can push a sample past a tick boundary, and neither
    # belongs in an input/trajectory reference.
    if getattr(args, "golden", False):
        args.no_rig = True
        args.detail_interval = 0
    capture_rig = not args.no_rig
    rig_context = resolve_body_rig(pine, live["boarder"]) if capture_rig else None
    out = args.out or default_output(args.label)
    out.parent.mkdir(parents=True, exist_ok=True)
    stale_stop_error = clear_stop_request()
    if stale_stop_error:
        raise RuntimeError(f"Could not clear stale capture stop request: {stale_stop_error}")
    start = time.monotonic()
    hotkeys = GlobalHotkeys()

    header = {
        "kind": "header",
        "schema": SCHEMA,
        "capturedAtUtc": utc_now(),
        "label": args.label,
        "game": {"title": pine.title(), "id": pine.game_id(), "region": "PAL"},
        "runtime": {"python": sys.version.split()[0], "platform": platform.platform()},
        "coordinates": {"upAxis": "Z", "unitsPerMeter": UNITS_PER_METER},
        "simulationHz": SIM_HZ,
        "frameFence": "game frame before == game frame after raw reads",
        "rawRegions": {
            "everyFrame": {
                name: {"start": hex32(start_off), "endExclusive": hex32(end_off)}
                for name, (start_off, end_off) in RAW_REGIONS.items()
            },
            "cameraEveryFrame": {
                "activeIndexAddress": "world+0x290",
                "recordBase": f"world+activeIndex*{hex32(CAMERA_RECORD_STRIDE)}",
                "start": hex32(CAMERA_RAW_START),
                "endExclusive": hex32(CAMERA_RAW_END),
            },
            "detail": {
                name: {"start": hex32(start_off), "endExclusive": hex32(end_off)}
                for name, (start_off, end_off) in DETAIL_REGIONS.items()
            },
            "rigEveryFrame": {
                "partCount": f"boarder+{hex32(RIDER_PART_COUNT_OFFSET)}",
                "partBase": f"boarder+{hex32(RIDER_PARTS_OFFSET)}",
                "partStride": hex32(RIDER_PART_STRIDE),
                "bodyPartId": RIDER_BODY_PART_ID,
                "localRotations": hex32(RIDER_LOCAL_ROTATIONS_OFFSET),
                "rootTranslation": hex32(RIDER_LOCAL_TRANSLATIONS_OFFSET),
                "renderTransform": f"boarder+{hex32(RIDER_RENDER_TRANSFORM_OFFSET)}",
                "eventIds": f"boarder+{hex32(RIDER_ANIM_EVENT_IDS_OFFSET)}",
            } if capture_rig else None,
        },
        "captureProfile": "golden" if getattr(args, "golden", False) else "full",
        "detailIntervalFrames": args.detail_interval,
        "rig": public_rig_context(rig_context) if rig_context is not None else None,
        "live": {name: hex32(value) for name, value in live.items()},
        "hooks": states,
        "captureSafety": {"observerOnly": safe, "note": safety_note},
        "inputCapture": {
            "available": input_available,
            "source": "noclip passive pad observer A" if input_available else None,
        },
        "markers": {
            "controller": "Circle",
            "hotkeys": "Ctrl+Shift+M/J/G/L/P; Ctrl+Shift+Q stops",
            "lookbackSeconds": args.marker_lookback,
        },
    }

    frame_count = 0
    marker_count = 0
    missed_frames = 0
    coherence_retries = 0
    context_changes = 0
    frame_discontinuities = 0
    detail_count = 0
    detail_drops = 0
    first_frame: int | None = None
    last_frame: int | None = None
    reason = "unknown"
    last_sample: dict[str, Any] | None = None
    marker_button_down = False

    print(f"Capturing {pine.title()} [{pine.game_id()}] -> {out.resolve()}")
    print("Markers: Circle generic | Ctrl+Shift+J jump | G ground | L landing | P pass-through")
    print("Stop: Ctrl+Shift+Q globally, or Ctrl+C in this terminal.")

    with out.open("w", encoding="utf-8", buffering=1024 * 1024) as stream:
        def emit(doc: dict[str, Any], flush: bool = False) -> None:
            stream.write(json.dumps(doc, separators=(",", ":"), ensure_ascii=False) + "\n")
            if flush:
                stream.flush()

        emit(header, flush=True)
        try:
            last_sample = coherent_frame(
                pine, live, start, input_available, rig_context, capture_rig
            )
            while True:
                now = time.monotonic()
                if STOP_FILE.exists():
                    reason = "stop_request"
                    break
                for event in hotkeys.poll():
                    if event == "stop":
                        reason = "hotkey_stop"
                        raise StopIteration
                    if last_sample is not None:
                        marker_count += 1
                        marker = marker_record(
                            marker_count, event, "keyboard", last_sample, args.marker_lookback
                        )
                        emit(marker, flush=True)
                        print(
                            f"MARK {marker_count}: {event} at frame {marker['frame']} "
                            f"(covers from {marker['lookbackStartFrame']})"
                        )
                if args.seconds and now - start >= args.seconds:
                    reason = "time_limit"
                    break

                current_frame = pine.r32(live["frameAddress"])
                if last_frame is not None and current_frame == last_frame:
                    time.sleep(0.0005)
                    continue

                sample = coherent_frame(
                    pine, live, start, input_available, rig_context, capture_rig
                )
                frame = sample["frame"]
                if last_frame is not None and frame == last_frame:
                    continue
                if last_sample is not None and sample["boarder"] != last_sample["boarder"]:
                    context_changes += 1
                    emit(
                        {
                            "kind": "context",
                            "reason": "local_boarder_changed",
                            "frame": frame,
                            "hostSeconds": sample["hostSeconds"],
                            "oldBoarder": last_sample["boarder"],
                            "newBoarder": sample["boarder"],
                        },
                        flush=True,
                    )
                    last_frame = None
                if last_frame is not None:
                    missed, discontinuity = frame_gap(last_frame, frame)
                    missed_frames += missed
                    frame_discontinuities += int(discontinuity)
                if first_frame is None:
                    first_frame = frame
                last_frame = frame
                last_sample = sample
                frame_count += 1
                coherence_retries += sample["coherenceRetries"]
                emit(sample, flush=frame_count % 60 == 0)

                if args.detail_interval > 0 and frame % args.detail_interval == 0:
                    detail = coherent_detail(pine, live, start)
                    if detail is None:
                        detail_drops += 1
                    else:
                        detail_count += 1
                        emit(detail)

                input_doc = sample.get("input")
                marker_button = bool(
                    input_doc
                    and input_doc["heldMask"] & PAD_MARKER_BUTTON == PAD_MARKER_BUTTON
                )
                if marker_button and not marker_button_down:
                    marker_count += 1
                    marker = marker_record(
                        marker_count, "marker", "controller_circle", sample, args.marker_lookback
                    )
                    emit(marker, flush=True)
                    print(
                        f"MARK {marker_count}: controller at frame {frame} "
                        f"(covers from {marker['lookbackStartFrame']})"
                    )
                marker_button_down = marker_button

                if input_doc and input_doc["noclipActive"]:
                    reason = "noclip_became_active"
                    raise RuntimeError("Noclip became active during capture; trace stopped before further play.")
        except KeyboardInterrupt:
            reason = "keyboard_interrupt"
        except StopIteration:
            pass
        except Exception as exc:
            if reason == "unknown":
                reason = "error"
            emit({"kind": "error", "atUtc": utc_now(), "message": str(exc)}, flush=True)
            raise
        finally:
            stop_cleanup_error = clear_stop_request()
            footer = {
                "kind": "footer",
                "endedAtUtc": utc_now(),
                "reason": reason,
                "frames": frame_count,
                "firstFrame": first_frame,
                "lastFrame": last_frame,
                "missedFrames": missed_frames,
                "coherenceRetries": coherence_retries,
                "contextChanges": context_changes,
                "frameDiscontinuities": frame_discontinuities,
                "detailRecords": detail_count,
                "detailDrops": detail_drops,
                "markers": marker_count,
                "hostSeconds": round(time.monotonic() - start, 6),
            }
            if stop_cleanup_error:
                footer["stopRequestCleanupError"] = stop_cleanup_error
            emit(footer, flush=True)

    print(
        f"Saved {frame_count} frames, {marker_count} markers, {missed_frames} missed game frames "
        f"({reason}) -> {out.resolve()}"
    )
    return 0


def speed_mps(frame: dict[str, Any]) -> float | None:
    velocity = frame.get("motion", {}).get("velocity")
    if not velocity or any(value is None for value in velocity[:3]):
        return None
    return math.sqrt(sum(float(value) ** 2 for value in velocity[:3])) / UNITS_PER_METER


def pitch_deg(vector: list[float | None] | None) -> float | None:
    """Signed Z-up pitch: nose/upward positive, downhill negative."""
    if not vector or any(value is None for value in vector[:3]):
        return None
    x, y, z = (float(value) for value in vector[:3])
    return math.degrees(math.atan2(z, math.hypot(x, y)))


def compact_analysis_frame(frame: dict[str, Any]) -> dict[str, Any]:
    board_forward = frame["motion"].get("boardForward") or frame["motion"].get("airOrientation")
    return {
        "frame": frame["frame"],
        "hostSeconds": frame["hostSeconds"],
        "motionState": frame["state"]["motion"],
        "motionName": frame["state"]["motionName"],
        "controlState": frame["state"]["control"],
        "controlName": frame["state"]["controlName"],
        "position": frame["motion"]["position"],
        "velocity": frame["motion"]["velocity"],
        "trajectoryPitchDeg": pitch_deg(frame["motion"]["velocity"]),
        "boardPitchDeg": pitch_deg(board_forward),
        "surfaceType": frame["contact"]["surfaceType"],
        "normal": frame["contact"]["normal"],
        "chargeSnapshot": frame["control"]["chargeOrSpinSnapshot"],
    }


def compact_speed_mps(frame: dict[str, Any] | None) -> float | None:
    if not frame or any(value is None for value in frame["velocity"][:3]):
        return None
    return math.sqrt(sum(float(value) ** 2 for value in frame["velocity"][:3])) / UNITS_PER_METER


def extract_flights(
    frames: list[dict[str, Any]], markers: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """Build air segments and locate discrete jump impulses within them."""
    segments: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    previous: dict[str, Any] | None = None
    for frame in frames:
        if frame["motionState"] == 1 and current is None:
            current = {"prior": previous, "samples": []}
        if current is not None:
            if frame["motionState"] == 1:
                current["samples"].append(frame)
            else:
                current["exit"] = frame
                segments.append(current)
                current = None
        previous = frame
    if current is not None:
        current["exit"] = None
        segments.append(current)

    flights: list[dict[str, Any]] = []
    for flight_id, segment in enumerate(segments, start=1):
        samples = segment["samples"]
        if not samples:
            continue
        entry = samples[0]
        prior = segment["prior"] or entry
        exit_frame = segment["exit"]
        last = exit_frame or samples[-1]
        elapsed_frames = (last["frame"] - entry["frame"]) & 0xFFFFFFFF
        if elapsed_frames > MAX_REASONABLE_FRAME_GAP:
            elapsed_frames = 0

        apex = max(
            samples,
            key=lambda item: (
                float(item["position"][2])
                if item["position"][2] is not None
                else -float("inf")
            ),
        )
        start_z = entry["position"][2]
        apex_gain = None
        if start_z is not None and apex["position"][2] is not None:
            apex_gain = (apex["position"][2] - start_z) / UNITS_PER_METER

        missed = 0
        best_impulse = None
        impulse_samples = ([prior] if segment["prior"] else []) + samples
        for before, after in zip(impulse_samples, impulse_samples[1:]):
            delta = (after["frame"] - before["frame"]) & 0xFFFFFFFF
            if 1 < delta <= MAX_REASONABLE_FRAME_GAP:
                missed += delta - 1
            if not 1 <= delta <= 5:
                continue
            if any(value is None for value in before["velocity"][:3] + after["velocity"][:3]):
                continue
            dv = [
                (after["velocity"][axis] - before["velocity"][axis]) / UNITS_PER_METER
                for axis in range(3)
            ]
            magnitude = math.sqrt(sum(value * value for value in dv))
            normal_delta = sum(dv[axis] * float(before["normal"][axis] or 0) for axis in range(3))
            candidate = {
                "fromFrame": before["frame"],
                "frame": after["frame"],
                "deltaVelocityMps": magnitude,
                "normalDeltaMps": normal_delta,
                "chargeSnapshot": after["chargeSnapshot"],
                "controlState": after["controlState"],
                "controlName": after["controlName"],
            }
            if best_impulse is None or candidate["normalDeltaMps"] > best_impulse["normalDeltaMps"]:
                best_impulse = candidate

        takeoff_normal_velocity = None
        if not any(value is None for value in entry["velocity"][:3] + prior["normal"][:3]):
            takeoff_normal_velocity = sum(
                entry["velocity"][axis] * prior["normal"][axis] for axis in range(3)
            ) / UNITS_PER_METER
        has_jump_impulse = bool(
            best_impulse
            and best_impulse["deltaVelocityMps"] >= 4.0
            and best_impulse["normalDeltaMps"] >= 2.5
        )
        marker_ids = [
            marker["id"]
            for marker in markers
            if not (
                last["frame"] < marker["lookbackStartFrame"]
                or entry["frame"] > marker["frame"]
            )
        ]
        flights.append(
            {
                "id": flight_id,
                "entryFrame": entry["frame"],
                "exitFrame": last["frame"],
                "airtimeSeconds": elapsed_frames / SIM_HZ,
                "sampleCount": len(samples),
                "missedFrames": missed,
                "entryPosition": entry["position"],
                "exitPosition": last["position"],
                "entrySpeedMps": compact_speed_mps(entry),
                "exitSpeedMps": compact_speed_mps(exit_frame),
                "entryTrajectoryPitchDeg": entry.get("trajectoryPitchDeg"),
                "entryBoardPitchDeg": entry.get("boardPitchDeg"),
                "exitTrajectoryPitchDeg": exit_frame.get("trajectoryPitchDeg") if exit_frame else None,
                "exitBoardPitchDeg": exit_frame.get("boardPitchDeg") if exit_frame else None,
                "takeoffSurfaceType": prior["surfaceType"],
                "landingSurfaceType": exit_frame["surfaceType"] if exit_frame else None,
                "takeoffNormalVelocityMps": takeoff_normal_velocity,
                "apexFrame": apex["frame"],
                "globalZApexGainM": apex_gain,
                "hasJumpImpulse": has_jump_impulse,
                "bestPositiveNormalImpulse": best_impulse,
                "markerIds": marker_ids,
            }
        )
    return flights


def annotation_path(trace: Path) -> Path:
    return trace.with_suffix(".annotations.json")


def read_trace(path: Path):
    with path.open("r", encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, start=1):
            if not line.strip():
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                raise RuntimeError(f"Invalid JSON at {path}:{line_number}: {exc}") from exc


def load_annotations(path: Path) -> dict[int, dict[str, Any]]:
    sidecar = annotation_path(path)
    if not sidecar.exists():
        return {}
    doc = json.loads(sidecar.read_text(encoding="utf-8"))
    return {int(item["markerId"]): item for item in doc.get("annotations", [])}


def analyze(args: argparse.Namespace) -> int:
    header = None
    footer = None
    markers: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    contexts: list[dict[str, Any]] = []
    motion_counts: Counter[int] = Counter()
    control_counts: Counter[int] = Counter()
    speeds: list[float] = []
    previous = None
    frames = 0
    inferred_missed = 0
    analysis_frames: list[dict[str, Any]] = []

    for item in read_trace(args.trace):
        kind = item.get("kind")
        if kind == "header":
            header = item
        elif kind == "footer":
            footer = item
        elif kind == "marker":
            markers.append(item)
        elif kind == "context":
            contexts.append(item)
            previous = None
        elif kind == "frame":
            frames += 1
            analysis_frames.append(compact_analysis_frame(item))
            state = item["state"]
            motion_counts[state["motion"]] += 1
            control_counts[state["control"]] += 1
            speed = speed_mps(item)
            if speed is not None:
                speeds.append(speed)
            if previous is not None:
                missed, discontinuity = frame_gap(previous["frame"], item["frame"])
                inferred_missed += missed
                if discontinuity:
                    events.append(
                        {
                            "event": "frame_discontinuity",
                            "frame": item["frame"],
                            "hostSeconds": item["hostSeconds"],
                            "fromFrame": previous["frame"],
                        }
                    )
                prev_motion = previous["state"]["motion"]
                motion = state["motion"]
                event = None
                if motion == 1 and prev_motion != 1:
                    event = "air_enter"
                elif prev_motion == 1 and motion != 1:
                    event = "air_exit"
                elif motion == 2 and prev_motion in (5, 6):
                    event = "ground_accept"
                if event:
                    events.append(
                        {
                            "event": event,
                            "frame": item["frame"],
                            "hostSeconds": item["hostSeconds"],
                            "fromMotion": prev_motion,
                            "toMotion": motion,
                            "speedMps": speed,
                            "trajectoryPitchDeg": pitch_deg(item["motion"]["velocity"]),
                            "boardPitchDeg": pitch_deg(
                                item["motion"].get("boardForward")
                                or item["motion"].get("airOrientation")
                            ),
                        }
                    )
            previous = item

    if not header:
        raise RuntimeError("Trace has no header record.")
    if header.get("schema") not in SUPPORTED_SCHEMAS:
        raise RuntimeError(f"Unsupported trace schema: {header.get('schema')}")
    annotations = load_annotations(args.trace)
    flights = extract_flights(analysis_frames, markers)
    duration = footer.get("hostSeconds") if footer else (previous or {}).get("hostSeconds", 0)
    summary = {
        "schema": header["schema"],
        "label": header.get("label"),
        "game": header.get("game"),
        "frames": frames,
        "durationSeconds": duration,
        "missedFrames": inferred_missed,
        "captureFooter": footer,
        "speedMps": {
            "min": min(speeds) if speeds else None,
            "mean": sum(speeds) / len(speeds) if speeds else None,
            "max": max(speeds) if speeds else None,
        },
        "motionFrames": {
            MOTION_STATES.get(key, str(key)): value for key, value in sorted(motion_counts.items())
        },
        "controlFrames": {
            CONTROL_STATES.get(key, str(key)): value for key, value in sorted(control_counts.items())
        },
        "events": events,
        "contexts": contexts,
        "flights": flights,
        "markers": [
            {**marker, "annotation": annotations.get(marker["id"])} for marker in markers
        ],
    }

    print(f"Trace: {args.trace.resolve()}")
    print(f"Label: {summary['label']} | frames: {frames} | host duration: {duration:.3f}s")
    print(
        f"Missed game frames: {inferred_missed} | contexts: {len(contexts)} | "
        f"markers: {len(markers)} | events: {len(events)} | "
        f"end: {(footer or {}).get('reason', 'missing footer')}"
    )
    if speeds:
        print(
            f"Speed m/s: min {min(speeds):.3f} | mean {sum(speeds) / len(speeds):.3f} | "
            f"max {max(speeds):.3f}"
        )
    print("Motion frames: " + ", ".join(f"{k}={v}" for k, v in summary["motionFrames"].items()))
    explicit_jumps = sum(1 for flight in flights if flight["hasJumpImpulse"])
    print(f"Flights: {len(flights)} | detected jump impulses: {explicit_jumps}")
    for event in events:
        if event["event"] == "frame_discontinuity":
            print(
                f"  EVENT frame_discontinuity frame {event['frame']:8d} "
                f"t={event['hostSeconds']:8.3f}s from={event['fromFrame']}"
            )
            continue
        speed_text = "?" if event["speedMps"] is None else f"{event['speedMps']:.2f}m/s"
        trajectory_text = "?" if event["trajectoryPitchDeg"] is None else f"{event['trajectoryPitchDeg']:+.1f}°"
        board_text = "?" if event["boardPitchDeg"] is None else f"{event['boardPitchDeg']:+.1f}°"
        print(
            f"  EVENT {event['event']:13s} frame {event['frame']:8d} "
            f"t={event['hostSeconds']:8.3f}s speed={speed_text} "
            f"trajectory={trajectory_text} board={board_text}"
        )
    for marker in markers:
        ann = annotations.get(marker["id"])
        suffix = ""
        if ann:
            suffix = f" | {ann.get('label', '')}: {ann.get('note', '')}".rstrip(": ")
        print(
            f"  MARK {marker['id']:3d} {marker['category']:12s} frame {marker['frame']:8d} "
            f"lookback->{marker['lookbackStartFrame']}{suffix}"
        )
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
        print(f"Summary JSON -> {args.json_out.resolve()}")
    return 0


def recover_footer(args: argparse.Namespace) -> int:
    """Append a derived footer to an otherwise-complete interrupted JSONL trace."""
    header = None
    frame_count = marker_count = context_changes = detail_count = 0
    missed_frames = coherence_retries = frame_discontinuities = 0
    expected_details = 0
    first_frame = last_frame = previous_frame = None
    host_seconds = 0.0
    for item in read_trace(args.trace):
        kind = item.get("kind")
        if kind == "header":
            header = item
        elif kind == "footer":
            raise RuntimeError("Trace already has a footer; refusing to append another.")
        elif kind == "context":
            context_changes += 1
            previous_frame = None
        elif kind == "marker":
            marker_count += 1
        elif kind == "detail":
            detail_count += 1
        elif kind == "frame":
            frame = int(item["frame"])
            frame_count += 1
            first_frame = frame if first_frame is None else first_frame
            last_frame = frame
            coherence_retries += int(item.get("coherenceRetries", 0))
            interval = int((header or {}).get("detailIntervalFrames", 0))
            if interval > 0 and frame % interval == 0:
                expected_details += 1
            if previous_frame is not None:
                missed, discontinuity = frame_gap(previous_frame, frame)
                missed_frames += missed
                frame_discontinuities += int(discontinuity)
            previous_frame = frame
        host_seconds = max(host_seconds, float(item.get("hostSeconds", 0.0)))

    if not header:
        raise RuntimeError("Trace has no header record.")
    footer = {
        "kind": "footer",
        "endedAtUtc": utc_now(),
        "reason": args.reason,
        "recovered": True,
        "frames": frame_count,
        "firstFrame": first_frame,
        "lastFrame": last_frame,
        "missedFrames": missed_frames,
        "coherenceRetries": coherence_retries,
        "contextChanges": context_changes,
        "frameDiscontinuities": frame_discontinuities,
        "detailRecords": detail_count,
        "detailDrops": max(0, expected_details - detail_count),
        "markers": marker_count,
        "hostSeconds": host_seconds,
    }
    with args.trace.open("a", encoding="utf-8") as stream:
        stream.write(json.dumps(footer, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(
        f"Recovered footer: {frame_count} frames, {missed_frames} missed, "
        f"{detail_count} details -> {args.trace.resolve()}"
    )
    return 0


def _vsub(a: list[float], b: list[float]) -> list[float]:
    return [a[i] - b[i] for i in range(3)]


def _vdot(a: list[float], b: list[float]) -> float:
    return sum(a[i] * b[i] for i in range(3))


def _vlen(v: list[float]) -> float:
    return math.sqrt(_vdot(v, v))


def _vunit(v: list[float]) -> list[float] | None:
    length = _vlen(v)
    return [item / length for item in v] if length > 1e-9 else None


def _angle_deg(a: list[float], b: list[float]) -> float | None:
    ua, ub = _vunit(a), _vunit(b)
    if ua is None or ub is None:
        return None
    return math.degrees(math.acos(max(-1.0, min(1.0, _vdot(ua, ub)))))


def _optional_float(value: Any) -> float | None:
    return None if value is None else float(value)


def _format_optional(value: float | None) -> str:
    return "n/a" if value is None else f"{value:+.2f}"


def _vcross(a: list[float], b: list[float]) -> list[float]:
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]


def _camera_roll_deg(
    forward: list[float], up: list[float], up_axis: list[float]
) -> float | None:
    """Signed roll of the camera about its own forward axis, away from level.

    A camera that rolls into a turn cancels part of the rider's lateral lean in
    screen space, so a body that swings hard in world coordinates can still read
    as steady to the player. Roll is therefore measured alongside the pose rather
    than inferred from it. Positive means the horizon tipped toward screen right.
    Undefined, and reported as None, when the camera looks along the up axis.
    """
    unit_forward = _vunit(forward)
    unit_up = _vunit(up)
    if unit_forward is None or unit_up is None:
        return None
    along = _vdot(up_axis, unit_forward)
    level = _vunit([up_axis[i] - along * unit_forward[i] for i in range(3)])
    if level is None:
        return None
    right = _vcross(unit_forward, level)
    return math.degrees(math.atan2(_vdot(unit_up, right), _vdot(unit_up, level)))


def _least_squares_slope(pairs: list[tuple[float, float]]) -> float | None:
    """Slope of y against x through the sample mean, or None without a spread of x."""
    if len(pairs) < 2:
        return None
    mean_x = sum(x for x, _ in pairs) / len(pairs)
    mean_y = sum(y for _, y in pairs) / len(pairs)
    variance = sum((x - mean_x) ** 2 for x, _ in pairs)
    if variance < 1e-9:
        return None
    return sum((x - mean_x) * (y - mean_y) for x, y in pairs) / variance


def _percentiles(values: list[float]) -> dict[str, float | None]:
    if not values:
        return {"p10": None, "median": None, "p90": None, "max": None}
    ordered = sorted(values)

    def at(fraction: float) -> float:
        index = fraction * (len(ordered) - 1)
        lo, hi = math.floor(index), math.ceil(index)
        return ordered[lo] + (ordered[hi] - ordered[lo]) * (index - lo)

    return {"p10": at(0.1), "median": at(0.5), "p90": at(0.9), "max": ordered[-1]}


def _wrapped_angle(value: float) -> float:
    return (value + math.pi) % (2 * math.pi) - math.pi


def _circular_mean(values: list[float]) -> float | None:
    if not values:
        return None
    return math.atan2(
        sum(math.sin(value) for value in values),
        sum(math.cos(value) for value in values),
    )


def _rig_matrix_multiply(left: list[list[float]], right: list[list[float]]) -> list[list[float]]:
    return [
        [sum(left[row][axis] * right[axis][column] for axis in range(3)) for column in range(3)]
        for row in range(3)
    ]


def _rig_matrix_vector(matrix: list[list[float]], vector: list[float]) -> list[float]:
    return [sum(matrix[row][axis] * vector[axis] for axis in range(3)) for row in range(3)]


def _rig_local_rotation(euler: list[float]) -> list[list[float]]:
    x, y, z = (-euler[0], -euler[1], -euler[2])
    cx, sx = math.cos(x), math.sin(x)
    cy, sy = math.cos(y), math.sin(y)
    cz, sz = math.cos(z), math.sin(z)
    rotate_x = [[1, 0, 0], [0, cx, -sx], [0, sx, cx]]
    rotate_y = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]
    rotate_z = [[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]]
    return _rig_matrix_multiply(_rig_matrix_multiply(rotate_z, rotate_y), rotate_x)


def _rig_world_joints(
    metadata: dict[str, Any], root: list[float], rotations: list[list[float]]
) -> list[list[float]]:
    positions: list[list[float]] = []
    world_rotations: list[list[list[float]]] = []
    for bone in metadata["bones"]:
        index = int(bone["index"])
        local = _rig_local_rotation(rotations[index])
        parent = int(bone["parent"])
        if parent < 0:
            position = list(root)
            rotation = local
        else:
            translated = _rig_matrix_vector(
                world_rotations[parent], [float(value) for value in bone["bindTranslation"]]
            )
            position = [positions[parent][axis] + translated[axis] for axis in range(3)]
            rotation = _rig_matrix_multiply(world_rotations[parent], local)
        positions.append(position)
        world_rotations.append(rotation)
    return positions


def _bin_bank_degrees(frames: list[dict[str, Any]]) -> dict[str, float | None]:
    """Median lean and drawn deck roll for one lean bin."""
    leans = [
        float(frame["control"]["leanSlew"][0])
        for frame in frames
        if frame["control"].get("leanSlew", [None])[0] is not None
    ]
    banks = [
        math.degrees(float(frame["control"]["renderBankRad"]))
        for frame in frames
        if frame["control"].get("renderBankRad") is not None
    ]
    return {
        "lean": statistics.median(leans) if leans else None,
        "bankDeg": statistics.median(banks) if banks else None,
    }


def _rig_group_pose(
    frames: list[dict[str, Any]], bone_index: int
) -> list[float | None]:
    result: list[float | None] = []
    for axis in range(3):
        values = [
            float(frame["rig"]["localRotationsRad"][bone_index][axis])
            for frame in frames
            if frame["rig"]["localRotationsRad"][bone_index][axis] is not None
        ]
        result.append(_circular_mean(values))
    return result


def _knee_lead(
    joints: dict[str, list[float]], names: list[str]
) -> float | None:
    """How far the knees sit off the hip-ankle line, along the lateral axis.

    Which way a rider's toes point across the board is a property of the stance,
    not of the model format, so a capture cannot be labelled heel/toe from the
    axis alone -- and getting it backwards silently mirrors every conclusion
    drawn from the pose. A boarder's knees bend the way the toes do, in every
    stance including neutral, so their offset names the toe direction from the
    pose itself. Returns None for a skeleton without both legs.
    """
    legs = [
        (f"{side}_thigh", f"{side}_calf", f"{side}_foot")
        for side in ("l", "r")
    ]
    offsets: list[float] = []
    for hip, knee, ankle in legs:
        if hip not in names or knee not in names or ankle not in names:
            continue
        offsets.append(joints[knee][0] - (joints[hip][0] + joints[ankle][0]) / 2)
    return sum(offsets) / len(offsets) if offsets else None


def _rig_group_joint_pose(
    frames: list[dict[str, Any]], metadata: dict[str, Any]
) -> dict[str, Any] | None:
    if not frames:
        return None
    if any("rootTranslation" not in frame.get("rig", {}) for frame in frames):
        return None
    if any("bindTranslation" not in bone for bone in metadata.get("bones", [])):
        return None
    root: list[float] = []
    for axis in range(3):
        values = sorted(float(frame["rig"]["rootTranslation"][axis]) for frame in frames)
        root.append(values[len(values) // 2])
    rotations = [_rig_group_pose(frames, int(bone["index"])) for bone in metadata["bones"]]
    if any(any(value is None for value in rotation) for rotation in rotations):
        return None
    definite_rotations = [[float(value) for value in rotation] for rotation in rotations]
    names = [str(bone["name"]) for bone in metadata["bones"]]
    if "l_foot" not in names or "r_foot" not in names:
        raise RuntimeError("Rig skeleton has no l_foot/r_foot ankle origins.")

    # Reconstruct each sampled pose before taking coordinate medians.  Building
    # one hierarchy from circular-mean Euler angles biases remote joints because
    # matrix composition is nonlinear (hands and knees make that especially
    # visible).  The mean rotations above remain useful as a compact pose, while
    # these positions describe where the game actually drew each joint.
    frame_points: list[dict[str, list[float]]] = []
    ankle_midpoints: list[list[float]] = []
    for frame in frames:
        frame_rotations = frame["rig"]["localRotationsRad"]
        frame_root = frame["rig"]["rootTranslation"]
        if any(value is None for rotation in frame_rotations for value in rotation):
            continue
        if any(value is None for value in frame_root):
            continue
        joints = _rig_world_joints(
            metadata,
            [float(value) for value in frame_root],
            [[float(value) for value in rotation] for rotation in frame_rotations],
        )
        by_name = {name: joints[index] for index, name in enumerate(names)}
        ankle = [
            (by_name["l_foot"][axis] + by_name["r_foot"][axis]) * 0.5
            for axis in range(3)
        ]
        ankle_midpoints.append(ankle)
        # Retail model axes are +X lateral, +Y board-longitudinal, +Z up.
        # Slopesmith uses +X toe, +Y up, +Z toward the front ankle. Which lateral
        # direction is "toe" depends on the rider's stance, so the sign is resolved
        # from the pose below rather than assumed here.
        frame_points.append(
            {
                name: [
                    (point[0] - ankle[0]) / UNITS_PER_METER,
                    (point[2] - ankle[2]) / UNITS_PER_METER,
                    (point[1] - ankle[1]) / UNITS_PER_METER,
                ]
                for name, point in by_name.items()
            }
        )
    if not frame_points:
        return None

    board_frame_m = {
        name: [
            statistics.median(points[name][axis] for points in frame_points)
            for axis in range(3)
        ]
        for name in names
    }
    ankle_midpoint = [
        statistics.median(point[axis] for point in ankle_midpoints)
        for axis in range(3)
    ]
    knee_lead = _knee_lead(board_frame_m, names)
    flipped = knee_lead is not None and knee_lead < 0
    if flipped:
        board_frame_m = {
            name: [-point[0], point[1], point[2]] for name, point in board_frame_m.items()
        }
    return {
        "rootTranslationUnits": root,
        "localRotationsRad": definite_rotations,
        "ankleMidpointRawUnits": ankle_midpoint,
        # Positive once oriented: how far the knees lead toward the toe edge, and whether
        # the model's own lateral axis had to be mirrored to make +X toe for this rider.
        "kneeLeadM": None if knee_lead is None else abs(knee_lead),
        "toeAxisMirrored": flipped,
        "jointsBoardFrameM": board_frame_m,
    }


def summarize_rig_trace(
    header: dict[str, Any],
    frames: list[dict[str, Any]],
    lean_threshold: float = 0.35,
    neutral_threshold: float = 0.08,
    ground_only: bool = True,
    event_layer: int = 2,
    negative_event: int | None = None,
    neutral_event: int | None = None,
    positive_event: int | None = None,
) -> dict[str, Any]:
    metadata = header.get("rig")
    if not metadata or not metadata.get("bones"):
        raise RuntimeError("Trace header has no v4 rig metadata.")
    if not 0 <= event_layer < 3:
        raise ValueError("event_layer must select one of the three animation layers (0..2).")
    usable = [
        frame for frame in frames
        if frame.get("rig")
        and (not ground_only or frame.get("state", {}).get("motion") == 2)
    ]
    if not usable:
        raise RuntimeError("Trace has no usable rig frames for the selected motion filter.")

    negative = [
        frame for frame in usable
        if float(frame["control"]["leanSlew"][0]) <= -lean_threshold
    ]
    neutral = [
        frame for frame in usable
        if abs(float(frame["control"]["leanSlew"][0])) <= neutral_threshold
    ]
    positive = [
        frame for frame in usable
        if float(frame["control"]["leanSlew"][0]) >= lean_threshold
    ]
    if negative_event is not None:
        negative = [
            frame for frame in negative
            if int(frame["rig"]["eventIds"][event_layer]) == negative_event
        ]
    if neutral_event is not None:
        neutral = [
            frame for frame in neutral
            if int(frame["rig"]["eventIds"][event_layer]) == neutral_event
        ]
    if positive_event is not None:
        positive = [
            frame for frame in positive
            if int(frame["rig"]["eventIds"][event_layer]) == positive_event
        ]

    bones: list[dict[str, Any]] = []
    for bone in metadata["bones"]:
        index = int(bone["index"])
        negative_pose = _rig_group_pose(negative, index)
        neutral_pose = _rig_group_pose(neutral, index)
        positive_pose = _rig_group_pose(positive, index)
        turn_delta: list[float | None] = []
        for neg, pos in zip(negative_pose, positive_pose):
            turn_delta.append(
                None if neg is None or pos is None else _wrapped_angle(pos - neg)
            )
        delta_magnitude = (
            math.degrees(math.sqrt(sum(float(value) ** 2 for value in turn_delta)))
            if all(value is not None for value in turn_delta)
            else None
        )

        speeds: list[float] = []
        previous = None
        for frame in usable:
            if previous is not None:
                delta_frames = (int(frame["frame"]) - int(previous["frame"])) & 0xFFFFFFFF
                if 1 <= delta_frames <= MAX_REASONABLE_FRAME_GAP:
                    before = previous["rig"]["localRotationsRad"][index]
                    after = frame["rig"]["localRotationsRad"][index]
                    if all(value is not None for value in before + after):
                        delta = [
                            _wrapped_angle(float(after[axis]) - float(before[axis]))
                            for axis in range(3)
                        ]
                        speeds.append(
                            math.degrees(math.sqrt(sum(value * value for value in delta)))
                            * SIM_HZ / delta_frames
                        )
            previous = frame

        bones.append(
            {
                "index": index,
                "name": bone["name"],
                "parent": bone["parent"],
                "negativeLeanMeanRad": negative_pose,
                "neutralMeanRad": neutral_pose,
                "positiveLeanMeanRad": positive_pose,
                "positiveMinusNegativeRad": turn_delta,
                "turnDeltaMagnitudeDeg": delta_magnitude,
                "angularSpeedDegPerSec": _percentiles(speeds),
            }
        )

    surface_groups: dict[int, list[dict[str, Any]]] = {}
    for frame in usable:
        surface_groups.setdefault(int(frame["contact"]["surfaceType"]), []).append(frame)
    surfaces: dict[str, Any] = {}
    for surface_type, samples in sorted(surface_groups.items()):
        surfaces[str(surface_type)] = {
            "frames": len(samples),
            "visualLiftUnits": _percentiles(
                [float(item["contact"]["visualLift"]) for item in samples]
            ),
            "bogDepthUnits": _percentiles(
                [float(item["contact"]["bogDepth"]) for item in samples]
            ),
            "budgetDepthUnits": _percentiles(
                [float(item["contact"]["budgetDepth"]) for item in samples]
            ),
        }

    event_counts: Counter[tuple[int, ...]] = Counter(
        tuple(int(value) for value in frame["rig"]["eventIds"]) for frame in usable
    )
    return {
        "schema": header.get("schema"),
        "label": header.get("label"),
        "boneCount": metadata["boneCount"],
        "samples": len(usable),
        "motionFilter": "ground" if ground_only else "all",
        "leanThreshold": lean_threshold,
        "neutralThreshold": neutral_threshold,
        "eventFilter": {
            "layer": event_layer,
            "negative": negative_event,
            "neutral": neutral_event,
            "positive": positive_event,
        },
        "leanBins": {
            "negative": len(negative),
            "neutral": len(neutral),
            "positive": len(positive),
        },
        # The deck roll each bin was actually held at. A pose only compares against another
        # renderer's pose at the same bank, and the engine's own lean->bank scale is rider-mode
        # dependent, so the drawn angle is reported rather than left to be re-derived from lean.
        "leanBinBankDeg": {
            name: _bin_bank_degrees(samples)
            for name, samples in (
                ("negative", negative), ("neutral", neutral), ("positive", positive)
            )
        },
        "representativePoses": {
            "negative": _rig_group_joint_pose(negative, metadata),
            "neutral": _rig_group_joint_pose(neutral, metadata),
            "positive": _rig_group_joint_pose(positive, metadata),
        },
        "eventIdCounts": [
            {"eventIds": list(events), "frames": count}
            for events, count in event_counts.most_common()
        ],
        "surfaces": surfaces,
        "bones": bones,
    }


def rig_study(args: argparse.Namespace) -> int:
    header = None
    frames: list[dict[str, Any]] = []
    for item in read_trace(args.trace):
        if item.get("kind") == "header":
            header = item
        elif item.get("kind") == "frame" and item.get("rig"):
            frames.append(item)
    if header is None:
        raise RuntimeError("Trace has no header record.")
    report = summarize_rig_trace(
        header,
        frames,
        lean_threshold=args.lean_threshold,
        neutral_threshold=args.neutral_threshold,
        ground_only=not args.all_motion,
        event_layer=args.event_layer,
        negative_event=args.negative_event,
        neutral_event=args.neutral_event,
        positive_event=args.positive_event,
    )

    bins = report["leanBins"]
    print(f"Rig trace: {args.trace.resolve()}")
    print(
        f"  {report['samples']} {report['motionFilter']} samples | "
        f"lean bins -={bins['negative']} neutral={bins['neutral']} +={bins['positive']}"
    )
    event_filter = report["eventFilter"]
    if any(event_filter[name] is not None for name in ("negative", "neutral", "positive")):
        print(
            f"  event layer {event_filter['layer']} filter: "
            f"-={event_filter['negative']} neutral={event_filter['neutral']} "
            f"+={event_filter['positive']}"
        )
    ranked = sorted(
        (bone for bone in report["bones"] if bone["turnDeltaMagnitudeDeg"] is not None),
        key=lambda bone: bone["turnDeltaMagnitudeDeg"],
        reverse=True,
    )
    if not ranked:
        print("  No two-sided turn pose yet; hold both left and right long enough to fill the lean bins.")
    else:
        print("  strongest +lean minus -lean local-pose changes:")
        for bone in ranked[:10]:
            delta = [math.degrees(value) for value in bone["positiveMinusNegativeRad"]]
            speed = bone["angularSpeedDegPerSec"]
            print(
                f"    {bone['name']:12s} delta=({delta[0]:+7.1f},{delta[1]:+7.1f},"
                f"{delta[2]:+7.1f}) deg | magnitude={bone['turnDeltaMagnitudeDeg']:6.1f} | "
                f"step p90={speed['p90'] or 0:7.1f} deg/s max={speed['max'] or 0:7.1f}"
            )
    print("  surfaces: " + ", ".join(
        f"{surface_type}={values['frames']}" for surface_type, values in report["surfaces"].items()
    ))
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(f"Rig JSON -> {args.json_out.resolve()}")
    return 0


def read_camera_samples(path: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Normalize retail and Slopesmith traces into metre-scale invariant samples."""
    header: dict[str, Any] | None = None
    samples: list[dict[str, Any]] = []
    physics: dict[int, dict[str, Any]] = {}
    for item in read_trace(path):
        kind = item.get("kind")
        if kind == "header":
            header = item
            continue
        schema = (header or {}).get("schema", "")
        if schema.startswith("ssx-tricky-rider-telemetry/") and kind == "frame" and item.get("camera"):
            scale = float((header or {}).get("coordinates", {}).get("unitsPerMeter", 100.0))
            subject = [float(value) / scale for value in item["motion"]["position"][:3]]
            eye = [float(value) / scale for value in item["camera"]["position"][:3]]
            look = [subject[0], subject[1], subject[2] + 1.0]
            samples.append(
                {
                    "frame": int(item["frame"]),
                    "renderFrame": None,
                    "subject": subject,
                    "look": look,
                    "eye": eye,
                    "forward": [float(value) for value in item["camera"]["forward"][:3]],
                    "up": [float(value) for value in item["camera"]["up"][:3]],
                    "velocity": [float(value) / scale for value in item["motion"]["velocity"][:3]],
                    "upAxis": [0.0, 0.0, 1.0],
                    "lean": _optional_float((item.get("control") or {}).get("leanSlew", [None])[0]),
                    "air": item["state"]["motion"] == 1,
                    "renderDt": None,
                    "clearance": None,
                    "correctionDistanceM": None,
                    "nearClipM": None,
                    "aspect": None,
                    "probes": [],
                }
            )
        elif schema.startswith("slopesmith-ride-telemetry/"):
            if kind == "frame":
                physics[int(item["frame"])] = item["closing"]
            elif kind == "camera":
                state = physics.get(int(item["frame"]), {})
                samples.append(
                    {
                        "frame": int(item["frame"]),
                        "renderFrame": int(item["renderFrame"]),
                        "subject": [float(value) for value in item["subjectPosition"]],
                        "look": [float(value) for value in item["lookTarget"]],
                        "eye": [float(value) for value in item["position"]],
                        "forward": [float(value) for value in item["forward"]],
                        "up": [float(value) for value in item["up"]],
                        "velocity": [float(value) for value in state.get("velocity", [0, 0, 0])],
                        "upAxis": [0.0, 1.0, 0.0],
                        "lean": _optional_float(state.get("lean")),
                        "air": not bool(state.get("grounded", True)),
                        "renderDt": float(item["renderDt"]),
                        "clearance": item.get("clearance"),
                        "correctionDistanceM": item.get("correctionDistanceM"),
                        "nearClipM": item.get("nearClipM"),
                        "aspect": item.get("aspect"),
                        "probes": item.get("probes", []),
                    }
                )
    if not header:
        raise RuntimeError(f"Trace has no header: {path}")
    if not samples:
        raise RuntimeError(f"Trace has no camera samples: {path}")
    return header, samples


def summarize_camera_samples(samples: list[dict[str, Any]]) -> dict[str, Any]:
    if not samples:
        empty = _percentiles([])
        return {
            "samples": 0, "firstFrame": None, "lastFrame": None, "frameSpan": 0,
            "sampleCoveragePct": 0.0, "airSamples": 0,
            "targetDistanceM": empty, "horizontalBoomM": empty,
            "eyeHeightAboveSubjectM": empty, "aimErrorDeg": empty, "aimMissM": empty,
            "absRollDeg": empty, "rollDegPerLeanUnit": None, "rollByLeanDeg": {},
            "forwardPitchDeg": empty, "travelYawErrorDeg": empty, "cameraSpeedMps": empty,
            "relativeOffsetSpeedMps": empty, "angularSpeedDegPerSec": empty,
            "correctionDistanceM": empty, "nearClipM": empty, "aspect": empty,
            "staleCameraFrames": 0, "clearanceCounts": {}, "probeCounts": {},
            "obstacleHitCounts": {},
        }
    target_distance: list[float] = []
    horizontal_boom: list[float] = []
    eye_height: list[float] = []
    aim_error: list[float] = []
    aim_miss: list[float] = []
    abs_roll: list[float] = []
    roll_against_lean: list[tuple[float, float]] = []
    roll_left: list[float] = []
    roll_right: list[float] = []
    roll_neutral: list[float] = []
    forward_pitch: list[float] = []
    travel_yaw_error: list[float] = []
    camera_speed: list[float] = []
    relative_speed: list[float] = []
    angular_speed: list[float] = []
    correction_distance: list[float] = []
    near_clip: list[float] = []
    aspect: list[float] = []
    clearance: Counter[str] = Counter()
    probe_counts: Counter[str] = Counter()
    obstacle_hits: Counter[str] = Counter()
    stale_camera_frames = 0

    for sample in samples:
        to_target = _vsub(sample["look"], sample["eye"])
        target_dist = _vlen(to_target)
        subject_to_eye = _vsub(sample["eye"], sample["subject"])
        height = _vdot(subject_to_eye, sample["upAxis"])
        horizontal = [
            subject_to_eye[i] - height * sample["upAxis"][i]
            for i in range(3)
        ]
        error = _angle_deg(sample["forward"], to_target)
        target_distance.append(target_dist)
        horizontal_boom.append(_vlen(horizontal))
        eye_height.append(height)
        if error is not None:
            aim_error.append(error)
            aim_miss.append(math.sin(math.radians(error)) * target_dist)
        roll = _camera_roll_deg(sample["forward"], sample["up"], sample["upAxis"])
        if roll is not None:
            abs_roll.append(abs(roll))
            lean = sample.get("lean")
            if lean is not None:
                roll_against_lean.append((lean, roll))
                if lean <= -CAMERA_LEAN_THRESHOLD:
                    roll_left.append(roll)
                elif lean >= CAMERA_LEAN_THRESHOLD:
                    roll_right.append(roll)
                elif abs(lean) <= CAMERA_NEUTRAL_THRESHOLD:
                    roll_neutral.append(roll)
        forward_pitch.append(math.degrees(math.asin(max(-1.0, min(1.0, _vdot(sample["forward"], sample["upAxis"]))))))
        velocity_up = _vdot(sample["velocity"], sample["upAxis"])
        travel = [sample["velocity"][i] - velocity_up * sample["upAxis"][i] for i in range(3)]
        forward_up = _vdot(sample["forward"], sample["upAxis"])
        flat_forward = [sample["forward"][i] - forward_up * sample["upAxis"][i] for i in range(3)]
        if _vlen(travel) >= 1.5:
            yaw_error = _angle_deg(flat_forward, travel)
            if yaw_error is not None:
                travel_yaw_error.append(yaw_error)
        if sample["clearance"]:
            clearance[str(sample["clearance"])] += 1
        if sample.get("correctionDistanceM") is not None:
            correction_distance.append(float(sample["correctionDistanceM"]))
        if sample.get("nearClipM") is not None:
            near_clip.append(float(sample["nearClipM"]))
        if sample.get("aspect") is not None:
            aspect.append(float(sample["aspect"]))
        for probe in sample.get("probes", []):
            kind = str(probe.get("kind", "unknown"))
            outcome = str(probe.get("source", "hit")) if probe.get("hit") else "miss"
            probe_counts[f"{kind}:{outcome}"] += 1
            if probe.get("hit") and probe.get("source") == "obstacle":
                obstacle_hits[str(probe.get("obstacleKey", "<unknown>"))] += 1

    for previous, current in zip(samples, samples[1:]):
        frame_delta = current["frame"] - previous["frame"]
        dt = current["renderDt"] if current["renderDt"] and current["renderFrame"] != previous["renderFrame"] else None
        if not dt and frame_delta > 0:
            dt = frame_delta / SIM_HZ
        if not dt or dt <= 0 or dt > 0.25:
            continue
        eye_delta = _vlen(_vsub(current["eye"], previous["eye"]))
        subject_delta = _vlen(_vsub(current["subject"], previous["subject"]))
        camera_speed.append(eye_delta / dt)
        relative_speed.append(
            _vlen(_vsub(_vsub(current["eye"], current["subject"]), _vsub(previous["eye"], previous["subject"]))) / dt
        )
        angle = _angle_deg(previous["forward"], current["forward"])
        if angle is not None:
            angular_speed.append(angle / dt)
        if eye_delta < 1e-5 and subject_delta > 0.01:
            stale_camera_frames += 1

    frame_span = samples[-1]["frame"] - samples[0]["frame"] + 1
    return {
        "samples": len(samples),
        "firstFrame": samples[0]["frame"],
        "lastFrame": samples[-1]["frame"],
        "frameSpan": frame_span,
        "sampleCoveragePct": 100.0 * len({item["frame"] for item in samples}) / frame_span,
        "airSamples": sum(bool(item["air"]) for item in samples),
        "targetDistanceM": _percentiles(target_distance),
        "horizontalBoomM": _percentiles(horizontal_boom),
        "eyeHeightAboveSubjectM": _percentiles(eye_height),
        "aimErrorDeg": _percentiles(aim_error),
        "aimMissM": _percentiles(aim_miss),
        "absRollDeg": _percentiles(abs_roll),
        "rollDegPerLeanUnit": _least_squares_slope(roll_against_lean),
        "rollByLeanDeg": {
            "leftMedian": statistics.median(roll_left) if roll_left else None,
            "neutralMedian": statistics.median(roll_neutral) if roll_neutral else None,
            "rightMedian": statistics.median(roll_right) if roll_right else None,
            "samples": {
                "left": len(roll_left), "neutral": len(roll_neutral), "right": len(roll_right),
            },
        },
        "forwardPitchDeg": _percentiles(forward_pitch),
        "travelYawErrorDeg": _percentiles(travel_yaw_error),
        "cameraSpeedMps": _percentiles(camera_speed),
        "relativeOffsetSpeedMps": _percentiles(relative_speed),
        "angularSpeedDegPerSec": _percentiles(angular_speed),
        "correctionDistanceM": _percentiles(correction_distance),
        "nearClipM": _percentiles(near_clip),
        "aspect": _percentiles(aspect),
        "staleCameraFrames": stale_camera_frames,
        "clearanceCounts": dict(clearance),
        "probeCounts": dict(probe_counts),
        "obstacleHitCounts": dict(obstacle_hits),
    }


def camera_study(args: argparse.Namespace) -> int:
    reports = []
    for path in args.traces:
        header, samples = read_camera_samples(path)
        report = {
            "trace": evidence_path(path),
            "schema": header.get("schema"),
            "label": header.get("label"),
            "all": summarize_camera_samples(samples),
            "ground": summarize_camera_samples([sample for sample in samples if not sample["air"]]),
            "air": summarize_camera_samples([sample for sample in samples if sample["air"]]),
        }
        reports.append(report)
        overall = report["all"]
        fmt = lambda group, key: group[key]["median"]
        print(f"Camera trace: {path.resolve()}")
        print(
            f"  {overall['samples']} samples, frames {overall['firstFrame']}..{overall['lastFrame']} "
            f"({overall['sampleCoveragePct']:.1f}% frame coverage; {overall['airSamples']} air)"
        )
        print(
            f"  median target distance {fmt(overall, 'targetDistanceM'):.3f} m | "
            f"horizontal boom {fmt(overall, 'horizontalBoomM'):.3f} m | "
            f"eye height {fmt(overall, 'eyeHeightAboveSubjectM'):.3f} m"
        )
        print(
            f"  median aim error {fmt(overall, 'aimErrorDeg'):.3f} deg "
            f"({fmt(overall, 'aimMissM'):.3f} m miss) | "
            f"travel yaw error {fmt(overall, 'travelYawErrorDeg'):.3f} deg | "
            f"forward pitch {fmt(overall, 'forwardPitchDeg'):.3f} deg"
        )
        print(
            f"  median camera speed {fmt(overall, 'cameraSpeedMps'):.3f} m/s | "
            f"relative-offset speed {fmt(overall, 'relativeOffsetSpeedMps'):.3f} m/s | "
            f"stale moving-subject samples {overall['staleCameraFrames']}"
        )
        roll = overall["rollByLeanDeg"]
        counts = roll["samples"]
        slope = overall["rollDegPerLeanUnit"]
        print(
            f"  median |roll| {fmt(overall, 'absRollDeg'):.3f} deg | "
            f"roll vs lean {'n/a' if slope is None else f'{slope:+.2f}'} deg/unit | "
            f"left {_format_optional(roll['leftMedian'])} neutral "
            f"{_format_optional(roll['neutralMedian'])} right {_format_optional(roll['rightMedian'])} deg "
            f"(n={counts['left']}/{counts['neutral']}/{counts['right']})"
        )
        if overall["clearanceCounts"]:
            print(f"  clearance: {overall['clearanceCounts']}")
        if overall["probeCounts"]:
            print(f"  probes: {overall['probeCounts']}")
        if overall["obstacleHitCounts"]:
            print(f"  obstacle hits: {overall['obstacleHitCounts']}")
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(json.dumps(reports, indent=2) + "\n", encoding="utf-8")
        print(f"JSON -> {args.json_out.resolve()}")
    return 0


def annotate(args: argparse.Namespace) -> int:
    markers = [item for item in read_trace(args.trace) if item.get("kind") == "marker"]
    if not markers:
        raise RuntimeError("Trace has no marker records.")
    annotations = load_annotations(args.trace)

    if args.marker is not None:
        marker = next((item for item in markers if item["id"] == args.marker), None)
        if not marker:
            raise RuntimeError(f"Trace has no marker {args.marker}.")
        if not args.label and not args.note:
            raise RuntimeError("Provide --label and/or --note for non-interactive annotation.")
        existing = annotations.get(args.marker, {})
        annotations[args.marker] = {
            "markerId": args.marker,
            "label": args.label if args.label is not None else existing.get("label", ""),
            "note": args.note if args.note is not None else existing.get("note", ""),
        }
    else:
        print("Annotate markers; blank input keeps existing text. Ctrl+C cancels without writing.")
        for marker in markers:
            existing = annotations.get(marker["id"], {})
            print(
                f"Marker {marker['id']} [{marker['category']}] frame {marker['frame']} "
                f"(lookback {marker['lookbackStartFrame']}..{marker['frame']})"
            )
            label = input(f"  Label [{existing.get('label', '')}]: ").strip()
            note = input(f"  Note  [{existing.get('note', '')}]: ").strip()
            annotations[marker["id"]] = {
                "markerId": marker["id"],
                "label": label or existing.get("label", ""),
                "note": note or existing.get("note", ""),
            }

    sidecar = annotation_path(args.trace)
    doc = {
        "kind": "ssx-tricky-rider-telemetry-annotations",
        "trace": args.trace.name,
        "updatedAtUtc": utc_now(),
        "annotations": [annotations[key] for key in sorted(annotations)],
    }
    sidecar.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print(f"Annotations -> {sidecar.resolve()}")
    return 0


def snapshot(as_json: bool) -> int:
    pine = Pine()
    validate_game(pine)
    live = resolve_live(pine)
    rig_context = resolve_body_rig(pine, live["boarder"])
    states = hook_states(pine)
    input_available = states["a"]["state"] == "hooked"
    sample = coherent_frame(pine, live, time.monotonic(), input_available, rig_context)
    if as_json:
        sample["rigMetadata"] = public_rig_context(rig_context)
        print(json.dumps(sample, indent=2))
        return 0
    pos = sample["motion"]["position"]
    vel = sample["motion"]["velocity"]
    speed = speed_mps(sample)
    state = sample["state"]
    contact = sample["contact"]
    print(f"{pine.title()} [{pine.game_id()}] frame={sample['frame']} boarder={sample['boarder']}")
    print(
        f"motion={state['motion']}:{state['motionName']} "
        f"control={state['control']}:{state['controlName']} surface={contact['surfaceType']}"
    )
    print(f"position(u)={pos} velocity(u/s)={vel} speed={speed:.3f}m/s")
    print(f"contact error={contact['error']} normal={contact['normal']}")
    rig = sample["rig"]
    print(
        f"rig={rig['boneCount']} bones events={rig['eventIds']} "
        f"root={rig['rootTranslation']}"
    )
    print(f"input={sample['input']}")
    return 0


def status() -> int:
    pine = Pine()
    states = hook_states(pine)
    active = pine.r32(NOCLIP_ACTIVE)
    safe, note = safe_capture_layout(states, active)
    vm = {0: "running", 1: "paused", 2: "shutdown"}.get(pine.status(), "unknown")
    print(f"game: {pine.title()} [{pine.game_id()}] | VM: {vm}")
    print(f"prepared state file: {'present' if PREPARE_STATE.exists() else 'absent'}")
    print(f"capture stop request: {'present' if STOP_FILE.exists() else 'absent'}")
    for name, item in states.items():
        print(f"site {name.upper()}: {item['state']:7s} {' '.join(item['words'])}")
    print(f"noclip active: {active} | capture observer-only: {safe} ({note})")
    try:
        live = resolve_live(pine)
        print("live: " + ", ".join(f"{key}={hex32(value)}" for key, value in live.items()))
        rig = resolve_body_rig(pine, live["boarder"])
        names = ", ".join(bone["name"] for bone in rig["bones"])
        print(
            f"rig: part={rig['partAddress']} skeleton={rig['skeletonAddress']} "
            f"bones={rig['boneCount']} [{names}]"
        )
    except RuntimeError as exc:
        print(f"live: unavailable ({exc})")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="show live pointers and capture-hook safety")
    sub.add_parser("prepare", help="VM-paused: retain passive pad capture, disable noclip controls")
    sub.add_parser("restore", help="VM-paused: restore the exact pre-prepare hook state")
    sub.add_parser("stop", help="request a running capture to write its footer and stop")
    snap = sub.add_parser("snapshot", help="read one coherent rider frame")
    snap.add_argument("--json", action="store_true")
    cap = sub.add_parser("capture", help="record a played run to frame-fenced JSONL")
    cap.add_argument("--label", default="run")
    cap.add_argument("--out", type=Path)
    cap.add_argument("--seconds", type=float, default=0.0, help="host-time limit; 0 records until stopped")
    cap.add_argument("--marker-lookback", type=float, default=3.0)
    cap.add_argument("--detail-interval", type=int, default=10)
    cap.add_argument("--no-rig", action="store_true", help="omit final blended body-pose sampling")
    cap.add_argument(
        "--golden",
        action="store_true",
        help="golden-run profile: drop the rig and detail passes so every game frame is sampled",
    )
    cap.add_argument("--allow-control-hooks", action="store_true", help=argparse.SUPPRESS)
    ana = sub.add_parser("analyze", help="validate and summarize a JSONL trace")
    ana.add_argument("trace", type=Path)
    ana.add_argument("--json-out", type=Path)
    rec = sub.add_parser("recover-footer", help="append derived metadata to an interrupted complete trace")
    rec.add_argument("trace", type=Path)
    rec.add_argument("--reason", default="recovered_after_interrupted_stop")
    cam = sub.add_parser("camera-study", help="summarize retail or Slopesmith camera traces in common units")
    cam.add_argument("traces", type=Path, nargs="+")
    cam.add_argument("--json-out", type=Path)
    rig = sub.add_parser("rig-study", help="compare final retail body poses at negative/neutral/positive lean")
    rig.add_argument("trace", type=Path)
    rig.add_argument("--lean-threshold", type=float, default=0.35)
    rig.add_argument("--neutral-threshold", type=float, default=0.08)
    rig.add_argument("--event-layer", type=int, choices=range(3), default=2)
    rig.add_argument("--negative-event", type=int, help="also require this event id in the selected layer")
    rig.add_argument("--neutral-event", type=int, help="also require this event id in the selected layer")
    rig.add_argument("--positive-event", type=int, help="also require this event id in the selected layer")
    rig.add_argument("--all-motion", action="store_true", help="include air/rail/recovery frames")
    rig.add_argument("--json-out", type=Path)
    ann = sub.add_parser("annotate", help="write marker labels/notes to a sidecar without altering raw trace")
    ann.add_argument("trace", type=Path)
    ann.add_argument("--marker", type=int)
    ann.add_argument("--label")
    ann.add_argument("--note")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "status":
        return status()
    if args.command == "prepare":
        return prepare()
    if args.command == "restore":
        return restore()
    if args.command == "stop":
        return request_stop()
    if args.command == "snapshot":
        return snapshot(args.json)
    if args.command == "capture":
        return capture(args)
    if args.command == "analyze":
        return analyze(args)
    if args.command == "recover-footer":
        return recover_footer(args)
    if args.command == "camera-study":
        return camera_study(args)
    if args.command == "rig-study":
        return rig_study(args)
    if args.command == "annotate":
        return annotate(args)
    raise AssertionError(args.command)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1)
