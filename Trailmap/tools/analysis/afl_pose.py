#!/usr/bin/env python3
"""Inspect SSX Tricky rider poses stored in an AFL animation bank.

This is deliberately an offline asset tool.  It decodes the retail curve
format recovered from the PAL ELF and can combine a 60-channel body track
with a Tricky PS2 rider MPF skeleton.  It does not skin or render the mesh.

Examples (from the repository root):

    python tools/analysis/afl_pose.py ride-summary \
        temp/rig-re/anm/data/char/franim.afl path/to/mac_body.mpf

    python tools/analysis/afl_pose.py sample \
        temp/rig-re/anm/data/char/franim.afl frR_TURNHS --frame 11 \
        --mpf path/to/mac_body.mpf
"""

from __future__ import annotations

import argparse
import json
import math
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence


RIDE_CLIPS = (
    "frRL_BASECYCLEFAST",
    "frRL_CROUCHCYCLE",
    "frR_TURNHS",
    "frR_TURNTS",
    "frRC_TURNHS",
    "frRC_TURNTS",
    "frC_ANTIC",
)

POINTER_COUNTS = {
    0: 60,
    1: 6,
    4: 12,
    5: 6,
    6: 6,
    7: 6,
    8: 12,
    9: 12,
    10: 23,
    11: 6,
    12: 3,
    13: 12,
    14: 6,
    15: 3,
}


def bx_string_hash(value: str) -> int:
    """The engine hash used by named AFL sentinel headers."""
    result = 0
    for byte in value.encode("ascii"):
        result = ((result << 4) + byte) & 0xFFFF_FFFF
        high = result & 0xF000_0000
        if high:
            result ^= high >> 23
        result &= ~high
    return result


@dataclass(frozen=True)
class AflHeader:
    key: int
    pointer_index: int
    kind: int
    related_headers: int
    fields: tuple[int, ...]
    tail: int

    @property
    def frame_count(self) -> int:
        return self.fields[0]


class AflBank:
    """Parsed AFL headers, curve pointers, and compressed curve payload."""

    def __init__(self, path: Path):
        self.path = path
        self.data = path.read_bytes()
        if len(self.data) < 12:
            raise ValueError(f"{path}: file is shorter than the AFL header")

        self.console, self.unknown, header_count = struct.unpack_from("<BBH", self.data, 0)
        self.pointer_offset, self.data_offset = struct.unpack_from("<II", self.data, 4)
        header_end = 12 + header_count * 36
        if header_end > len(self.data):
            raise ValueError(f"{path}: {header_count} headers run past end of file")

        self.headers: list[AflHeader] = []
        for index in range(header_count):
            values = struct.unpack_from("<IIBB11HI", self.data, 12 + index * 36)
            self.headers.append(AflHeader(values[0], values[1], values[2], values[3],
                                          tuple(values[4:15]), values[15]))

    def find_clip(self, name: str) -> tuple[int, AflHeader]:
        key = bx_string_hash(name)
        matches = [(index, header) for index, header in enumerate(self.headers)
                   if header.key == key and header.kind == 255]
        if not matches:
            raise KeyError(f"{self.path}: no named clip {name!r} (hash 0x{key:08x})")
        if len(matches) != 1:
            raise ValueError(f"{self.path}: ambiguous clip hash 0x{key:08x}")
        return matches[0]

    def clip_channels(self, name: str, frame: float) -> tuple[AflHeader, list[list[float]]]:
        index, sentinel = self.find_clip(name)
        if not 0 <= frame <= sentinel.frame_count - 1:
            raise ValueError(
                f"{name}: frame {frame:g} is outside 0..{sentinel.frame_count - 1}"
            )
        if sentinel.related_headers <= 0:
            raise ValueError(f"{name}: named header has no related animation tracks")

        tracks: list[list[float]] = []
        for related in range(sentinel.related_headers):
            track_index = index + 1 + related
            if track_index >= len(self.headers):
                raise ValueError(f"{name}: related track runs past the header table")
            header = self.headers[track_index]
            pointer_count = POINTER_COUNTS.get(header.kind)
            if pointer_count is None:
                raise ValueError(f"{name}: unsupported track type {header.kind}")
            tracks.append([
                self.sample_curve(self._pointer(header.pointer_index + channel), frame)
                for channel in range(pointer_count)
            ])
        return sentinel, tracks

    def _pointer(self, index: int) -> int:
        offset = self.pointer_offset + index * 4
        if offset + 4 > len(self.data):
            raise ValueError(f"curve pointer {index} runs past end of file")
        relative = struct.unpack_from("<I", self.data, offset)[0]
        absolute = self.data_offset + relative
        if absolute + 2 > len(self.data):
            raise ValueError(f"curve pointer {index} targets 0x{absolute:x}, outside the file")
        return absolute

    @staticmethod
    def _segment_size(descriptor: int) -> int:
        kind, count = descriptor & 0xF, descriptor >> 4
        sizes = {0: 5, 1: 8, 2: 11, 3: 14, 4: count * 4 + 2,
                 6: count + 8, 7: count * 2 + 8}
        if kind not in sizes:
            raise ValueError(f"unsupported AFL curve segment type {kind}")
        return sizes[kind]

    def _packed_float(self, offset: int) -> float:
        if offset + 3 > len(self.data):
            raise ValueError("packed AFL float runs past end of file")
        # AFL omits the low byte of these coefficients.  The runtime restores
        # it as 0x80 before interpreting the little-endian IEEE-754 value.
        return struct.unpack("<f", bytes((0x80, *self.data[offset:offset + 3])))[0]

    def _sample_segment(self, offset: int, frame: float) -> float:
        descriptor = struct.unpack_from("<H", self.data, offset)[0]
        kind, count = descriptor & 0xF, descriptor >> 4
        payload = offset + 2

        if kind == 0:
            return self._packed_float(payload)

        if kind in (1, 2, 3):
            coefficients = [self._packed_float(payload + coefficient * 3)
                            for coefficient in range(kind + 1)]
            value = coefficients[0]
            for coefficient in coefficients[1:]:
                value = frame * value + coefficient
            return value

        # cvt.w.s in the retail evaluator selects the nearest sample.  The
        # signed residual then interpolates toward the following sample.
        sample = round(frame)
        residual = frame - sample
        sample = max(0, min(count - 1, sample))
        following = min(sample + 1, count - 1)

        if kind == 4:
            value = struct.unpack_from("<f", self.data, payload + sample * 4)[0]
            next_value = struct.unpack_from("<f", self.data, payload + following * 4)[0]
            return value + residual * (next_value - value)

        if kind in (6, 7):
            base = self._packed_float(payload)
            scale = self._packed_float(payload + 3)
            samples = payload + 6
            if kind == 6:
                value = self.data[samples + sample]
                next_value = self.data[samples + following]
            else:
                value = struct.unpack_from("<H", self.data, samples + sample * 2)[0]
                next_value = struct.unpack_from("<H", self.data, samples + following * 2)[0]
            return base + scale * (value + residual * (next_value - value))

        raise ValueError(f"unsupported AFL curve segment type {kind}")

    def sample_curve(self, offset: int, frame: float) -> float:
        descriptor = struct.unpack_from("<H", self.data, offset)[0]
        kind, segment_count = descriptor & 0xF, descriptor >> 4
        if kind != 5:
            return self._sample_segment(offset, frame)

        # Type 5 concatenates overlapping segments.  The final key of one
        # segment is frame zero of the next, hence duration - 1 below.
        cursor = offset + 2
        local_frame = frame
        for _ in range(segment_count):
            segment = struct.unpack_from("<H", self.data, cursor)[0]
            duration = segment >> 4
            if duration <= 0:
                raise ValueError("AFL grouped curve contains a zero-duration segment")
            if local_frame <= duration - 1:
                return self._sample_segment(cursor, local_frame)
            local_frame -= duration - 1
            cursor += self._segment_size(segment)
        return 0.0


@dataclass(frozen=True)
class Bone:
    name: str
    parent: int
    translation: tuple[float, float, float]


def load_body_skeleton(path: Path) -> list[Bone]:
    """Load the highest-detail body skeleton from a Tricky PS2 MPF."""
    data = path.read_bytes()
    if len(data) < 12 or struct.unpack_from("<I", data, 0)[0] != 8:
        raise ValueError(f"{path}: not a Tricky PS2 model MPF")
    header_count = struct.unpack_from("<H", data, 4)[0]
    file_start = struct.unpack_from("<I", data, 8)[0]

    selected: int | None = None
    for index in range(header_count):
        header = 12 + index * 80
        name = data[header:header + 16].split(b"\0", 1)[0].decode("ascii")
        if "3000" in name.lower():
            selected = header
            break
    if selected is None:
        raise ValueError(f"{path}: no 3000-LOD body sub-model")

    data_offset = struct.unpack_from("<I", data, selected + 0x10)[0]
    bone_offset = struct.unpack_from("<I", data, selected + 0x18)[0]
    bone_count = struct.unpack_from("<H", data, selected + 0x42)[0]
    start = file_start + data_offset + bone_offset
    if start + bone_count * 84 > len(data):
        raise ValueError(f"{path}: bone table runs past end of file")

    bones: list[Bone] = []
    for index in range(bone_count):
        offset = start + index * 84
        name = data[offset:offset + 16].split(b"\0", 1)[0].decode("ascii")
        parent = struct.unpack_from("<h", data, offset + 0x12)[0]
        translation = struct.unpack_from("<3f", data, offset + 0x18)
        bones.append(Bone(name, parent, translation))
    return bones


Matrix3 = tuple[tuple[float, float, float], tuple[float, float, float],
                tuple[float, float, float]]
Vector3 = tuple[float, float, float]


def _matrix_multiply(left: Matrix3, right: Matrix3) -> Matrix3:
    return tuple(tuple(sum(left[row][axis] * right[axis][column] for axis in range(3))
                       for column in range(3)) for row in range(3))  # type: ignore[return-value]


def _matrix_vector(matrix: Matrix3, vector: Sequence[float]) -> Vector3:
    return tuple(sum(matrix[row][axis] * vector[axis] for axis in range(3))
                 for row in range(3))  # type: ignore[return-value]


def _local_rotation(euler: Sequence[float]) -> Matrix3:
    # The MPF/glTF path and the resulting ankle placement establish that AFL
    # triples are absolute local XYZ Euler angles applied with their signs
    # negated.  The quaternion formula used by the model tooling is Rz*Ry*Rx.
    x, y, z = (-euler[0], -euler[1], -euler[2])
    cx, sx, cy, sy, cz, sz = (math.cos(x), math.sin(x), math.cos(y), math.sin(y),
                              math.cos(z), math.sin(z))
    rotate_x: Matrix3 = ((1, 0, 0), (0, cx, -sx), (0, sx, cx))
    rotate_y: Matrix3 = ((cy, 0, sy), (0, 1, 0), (-sy, 0, cy))
    rotate_z: Matrix3 = ((cz, -sz, 0), (sz, cz, 0), (0, 0, 1))
    return _matrix_multiply(_matrix_multiply(rotate_z, rotate_y), rotate_x)


def world_joints(bones: Sequence[Bone], channels: Sequence[float]) -> list[Vector3]:
    if len(channels) != 3 + len(bones) * 3:
        raise ValueError(f"{len(channels)} channels cannot drive {len(bones)} bones")
    positions: list[Vector3] = []
    rotations: list[Matrix3] = []
    root = tuple(channels[0:3])
    for index, bone in enumerate(bones):
        local = _local_rotation(channels[3 + index * 3:6 + index * 3])
        if bone.parent < 0:
            position = root
            rotation = local
        else:
            if bone.parent >= index:
                raise ValueError(f"bone {bone.name}: parent {bone.parent} is not before its child")
            translated = _matrix_vector(rotations[bone.parent], bone.translation)
            position = tuple(positions[bone.parent][axis] + translated[axis]
                             for axis in range(3))
            rotation = _matrix_multiply(rotations[bone.parent], local)
        positions.append(position)  # type: ignore[arg-type]
        rotations.append(rotation)
    return positions


def _average(left: Sequence[float], right: Sequence[float]) -> Vector3:
    return tuple((left[axis] + right[axis]) * 0.5 for axis in range(3))  # type: ignore[return-value]


def _relative(point: Sequence[float], origin: Sequence[float]) -> Vector3:
    return tuple(point[axis] - origin[axis] for axis in range(3))  # type: ignore[return-value]


def _rounded(vector: Sequence[float]) -> list[float]:
    return [round(value, 4) for value in vector]


def sample_document(bank: AflBank, clip: str, frame: float,
                    bones: Sequence[Bone] | None) -> dict[str, object]:
    sentinel, tracks = bank.clip_channels(clip, frame)
    document: dict[str, object] = {
        "clip": clip,
        "frame": frame,
        "frameCount": sentinel.frame_count,
        "bodyChannels": _rounded(tracks[0]) if tracks else [],
    }
    if len(tracks) > 1:
        document["boardChannels"] = _rounded(tracks[1])
    if bones is not None:
        joints = world_joints(bones, tracks[0])
        document["jointsCm"] = {
            bone.name: _rounded(joints[index]) for index, bone in enumerate(bones)
        }
    return document


def ride_summary(bank: AflBank, bones: Sequence[Bone]) -> list[dict[str, object]]:
    by_name = {bone.name: index for index, bone in enumerate(bones)}
    required = ("hips", "head", "l_bicep", "r_bicep", "l_calf", "r_calf",
                "l_foot", "r_foot")
    missing = [name for name in required if name not in by_name]
    if missing:
        raise ValueError("body skeleton is missing " + ", ".join(missing))

    result: list[dict[str, object]] = []
    for clip in RIDE_CLIPS:
        sentinel, _ = bank.find_clip(clip)
        frames = bank.headers[sentinel].frame_count
        frame = 0 if clip.endswith(("BASECYCLEFAST", "CROUCHCYCLE")) else frames // 2
        _, tracks = bank.clip_channels(clip, frame)
        joints = world_joints(bones, tracks[0])
        ankles = _average(joints[by_name["l_foot"]], joints[by_name["r_foot"]])
        shoulders = _average(joints[by_name["l_bicep"]], joints[by_name["r_bicep"]])
        result.append({
            "clip": clip,
            "frames": frames,
            "sampleFrame": frame,
            # Raw MPF axes: +X toe, +Y along the deck, +Z up.
            "pelvisFromAnklesCm": _rounded(_relative(joints[by_name["hips"]], ankles)),
            "shouldersFromAnklesCm": _rounded(_relative(shoulders, ankles)),
            "headFromAnklesCm": _rounded(_relative(joints[by_name["head"]], ankles)),
            "frontKneeFromAnklesCm": _rounded(_relative(joints[by_name["l_calf"]], ankles)),
            "rearKneeFromAnklesCm": _rounded(_relative(joints[by_name["r_calf"]], ankles)),
        })
    return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    sample = subparsers.add_parser("sample", help="sample one named clip as JSON")
    sample.add_argument("afl", type=Path)
    sample.add_argument("clip")
    sample.add_argument("--frame", type=float, default=0)
    sample.add_argument("--mpf", type=Path, help="optional body MPF for world-space joints")

    summary = subparsers.add_parser("ride-summary", help="compare the core retail ride clips")
    summary.add_argument("afl", type=Path)
    summary.add_argument("mpf", type=Path)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    bank = AflBank(args.afl)
    if args.command == "sample":
        bones = load_body_skeleton(args.mpf) if args.mpf else None
        document: object = sample_document(bank, args.clip, args.frame, bones)
    else:
        document = ride_summary(bank, load_body_skeleton(args.mpf))
    print(json.dumps(document, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
