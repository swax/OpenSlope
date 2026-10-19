"""Compare generated portable course paths without reading decoder implementation."""

import argparse
import json
from pathlib import Path
import struct


def same_float32(a, b):
    return struct.pack("<f", a) == struct.pack("<f", b)


def compare(native, reference, tolerance):
    paths, points, events, worst = 0, 0, 0, 0
    for kind in ["AIP", "SOP"]:
        a = json.loads((native / f"{kind}.json").read_text())
        b = json.loads((reference / f"{kind}.json").read_text())
        assert a["StartPosList"] == b["StartPosList"], f"{kind}: start slots differ"
        for group in ["AIPaths", "RaceLines"]:
            assert len(a[group]) == len(b[group]), f"{kind}: {group} count differs"
            for index, (row, other) in enumerate(zip(a[group], b[group])):
                assert row["Name"] == other["Name"]
                assert all(same_float32(x, y) for x, y in zip(row["PathPos"], other["PathPos"]))
                if group == "AIPaths":
                    assert row["U3"] == other["U3"] and row["Respawnable"] == other["Respawnable"]
                else:
                    assert same_float32(row["DistanceToFinish"], other["DistanceToFinish"])
                assert len(row["PathPoints"]) == len(other["PathPoints"])
                for step, step_ref in zip(row["PathPoints"], other["PathPoints"]):
                    delta = max(abs(x - y) for x, y in zip(step, step_ref))
                    worst = max(worst, delta)
                    assert delta <= tolerance, f"{kind}/{group}/{index}: displacement differs by {delta} raw cm"
                    points += 1
                assert len(row["PathEvents"]) == len(other["PathEvents"])
                for event, event_ref in zip(row["PathEvents"], other["PathEvents"]):
                    assert (
                        event["EventType"] == event_ref["EventType"] and event["EventValue"] == event_ref["EventValue"]
                    )
                    assert same_float32(event["EventStart"], event_ref["EventStart"]) and same_float32(
                        event["EventEnd"], event_ref["EventEnd"]
                    )
                    events += 1
                paths += 1
    print(
        f"PASS: {paths} AIP/SOP paths, {points} displacement steps, {events} events; max displacement delta {worst:.6f} raw cm (declared tolerance {tolerance})"
    )
    print(
        "Seeds, start indices, attributes, DTF and event stations match at recovered float32 precision. Reversed event intervals are preserved."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("native", type=Path)
    parser.add_argument("reference", type=Path)
    parser.add_argument("--point-tolerance-cm", type=float, default=0.01)
    args = parser.parse_args()
    if not 0 < args.point_tolerance_cm <= 1:
        parser.error("point tolerance must be positive and no greater than one raw centimetre")
    compare(args.native, args.reference, args.point_tolerance_cm)
