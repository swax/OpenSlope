"""Compare generated spline data and retained coefficients, never decoder sources."""

import argparse
import json
from pathlib import Path
import struct


def compare(native, reference):
    a = json.loads((native / "Splines.json").read_text())["Splines"]
    b = json.loads((reference / "Splines.json").read_text())["Splines"]
    assert len(a) == len(b), "Spline count differs"
    segments, worst = 0, 0
    for row, expected in zip(a, b):
        for key in ("SplineName", "U0", "U1", "SplineStyle"):
            assert row[key] == expected[key], f"Spline {key} differs"
        assert len(row["Segments"]) == len(expected["Segments"]), "Segment span differs"
        for segment, other in zip(row["Segments"], expected["Segments"]):
            assert len(segment["Points"]) == len(other["Points"]) == 4
            weights = ((0, 0, 0, 1), (0, 0, 1 / 3, 1), (0, 1 / 3, 2 / 3, 1), (1, 1, 1, 1))
            for index, (p, q) in enumerate(zip(segment["Points"], other["Points"])):
                for axis, (x, y) in enumerate(zip(p, q)):
                    coefficients = [v[axis] for v in segment["PowerCoefficients"]]
                    expected = sum(c * w for c, w in zip(coefficients, weights[index]))
                    assert abs(x - expected) <= 0.00001, "Native controls disagree with retained source geometry"
                    # Float32 reconstruction plus shortest decimal serialization.
                    bound = 0.001 + 8 * 2**-24 * sum(abs(c * w) for c, w in zip(coefficients, weights[index]))
                    error = abs(x - y)
                    worst = max(worst, error)
                    assert error <= bound, f"Cubic controls differ by {error} raw cm (rounding bound {bound})"
            segments += 1
    pbd = (native / "Source" / f"{native.name}.PBD").read_bytes()
    offset = struct.unpack_from("<I", pbd, 96)[0]
    for spline in a:
        for segment in spline["Segments"]:
            start = offset + segment["SourceSegment"] * 128
            for i, row in enumerate(segment["PowerCoefficients"]):
                assert tuple(row) == struct.unpack_from("<3f", pbd, start + i * 16), (
                    "Retained curve coefficients differ from source"
                )
            assert tuple(segment["ArcLengthCoefficients"]) == struct.unpack_from("<4f", pbd, start + 64)
            assert (segment["Previous"], segment["Next"]) == struct.unpack_from("<2i", pbd, start + 80)
            assert (segment["Length"], segment["Distance"]) == struct.unpack_from("<2f", pbd, start + 116)
    print(
        f"PASS: {len(a)} spline names/styles/candidacy, {segments} curves, exact source coefficients/links/arc metadata; worst control difference {worst:g} raw cm"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("native", type=Path)
    parser.add_argument("reference", type=Path)
    args = parser.parse_args()
    compare(args.native, args.reference)
