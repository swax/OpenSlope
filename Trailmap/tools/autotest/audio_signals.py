#!/usr/bin/env python3
"""Read an AUTOTEST4 run and answer: what do the board-audio signals READ on each surface family?

  python tools/autotest/audio_signals.py                      newest AUTOTEST4 report in temp/autotest
  python tools/autotest/audio_signals.py run-....json         a specific report
  python tools/autotest/audio_signals.py --slip magnitude     the other slip reading (see below)

Retail's board bed reads three live signals -- Slip, Dig, Lean [research/extracted-data.md
"Board-snow audio mapping"]. The AUTOTEST4 fixture measures their operating ranges on long painted strips
of each family. This script buckets those samples by the plan's own strip spans and reports only the signal
distributions. It intentionally carries no SNOW.INF expression program; OpenSlope's runtime response is an
independent authored curve in `Slopesmith/src/core/audio/board-sound.ts`.

What an UNSTEERED pass measures: the clean-riding baseline only. Slip and Lean sit near zero riding a straight
fall line; a steered pass (site C input injection) supplies the carving range. That is a property of the
ride, not of this analysis.

The Slip FORMULA: the ELF reads Slip as "the absolute projection of boarder +0x320 against the +0x150 motion
vector", and the first unsteered pass (run-20260806-232645) settled what +0x320 IS: its magnitude reads
exactly 1.0 on every strip, so it is a UNIT vector -- the board's heading -- and the projection note
describes computing the alignment. Slip is therefore read as the LATERAL residual: the velocity component
NOT along the heading, in raw cm/s, which is 0 riding straight. `--slip` keeps the other two readings for a
steered pass to check against:

  lateral     sqrt(|v|^2 - dot(heading, v)^2)         the sideways speed (default)
  projection  |dot(heading, velocity)| / |velocity|   the alignment (~1.0 riding straight -- not slip)
  magnitude   |heading|                               the vector's own length (== 1.0; the unit-vector proof)
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

REPORTS = Path(__file__).resolve().parents[2] / "temp" / "autotest"

#: SurfaceType -> board-audio group, the raw indices of the ELF jump table at 0x0039FD50 (disassembled and
#: dumped 2026-08-06; index = surfaceType + 1, stubs return these). The slot arithmetic consumes the raw
#: index directly (`zboard[group*8 + mode]`), so this is the whole mapping with no naming layer in between.
SURFACE_GROUP = {0: 1, 1: 0, 2: 2, 3: 1, 4: 1, 5: 3, 6: 3, 7: 0, 8: 0, 9: 7, 10: 7, 11: 7,
                 12: 5, 13: 4, 14: 8, 15: 0, 16: 0, 17: 0, 18: 9, 19: 9}
GROUP_NAMES = ["PACK", "POWDER", "LOOSE", "ICE", "METAL", "WOOD", "RAIL", "ROCK", "GLASS", "CHUTE"]

def _percentile(values: list[float], q: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return float("nan")
    index = (len(ordered) - 1) * q
    low, high = int(math.floor(index)), int(math.ceil(index))
    if low == high:
        return ordered[low]
    return ordered[low] + (ordered[high] - ordered[low]) * (index - low)


def _spread(values: list[float]) -> str:
    return (f"{_percentile(values, 0.1):7.1f} {_percentile(values, 0.5):7.1f} "
            f"{_percentile(values, 0.9):7.1f}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("report", nargs="?", type=Path, default=None,
                        help="a run-*.json report; default is the newest AUTOTEST4 one in temp/autotest")
    parser.add_argument("--plan", type=Path, default=None,
                        help="the fixture plan; default is the path the report itself names")
    parser.add_argument("--slip", choices=("lateral", "projection", "magnitude"), default="lateral")
    parser.add_argument("--margin", type=float, default=15.0,
                        help="metres trimmed off each strip end, so a sample mid-transition (the surface "
                             "slew, [Trailmap: 310-surface-response]) is not read as either strip")
    parser.add_argument("--states", default="2",
                        help="motion states (+0x424) to keep, comma-separated, or 'all'. Default 2, the "
                             "steady ground/carve state [Trailmap: 380-carve-effects] -- a weaving rider "
                             "spends real ticks airborne and recovering, and those belong to no surface's "
                             "bed. Reports predating the motion column keep every row")
    args = parser.parse_args(argv)

    report_path = args.report
    if report_path is None:
        candidates = sorted(REPORTS.glob("run-*-autotest4.json"))
        if not candidates:
            print(f"no run-*-autotest4.json under {REPORTS}; ride the fixture first "
                  "(python tools/autotest/run.py --fixture AUTOTEST4)")
            return 1
        report_path = candidates[-1]
    doc = json.loads(report_path.read_text(encoding="utf-8"))
    plan_path = args.plan or Path(doc.get("plan", ""))
    if not plan_path or not plan_path.exists():
        print(f"plan not found ({plan_path}); pass --plan")
        return 1
    plan = json.loads(plan_path.read_text(encoding="utf-8"))

    # The report's own strips first: the plan file is overwritten on every rebuild, and a report bucketed by
    # a LATER fixture's spans reads like a run of a course it never rode.
    strips = doc.get("strips") or plan.get("strips") or []
    if not strips:
        print(f"neither {report_path.name} nor {plan_path} carries strips - not an instrument run")
        return 1
    path = doc.get("riderPath") or []
    if not path:
        print(f"{report_path} carries no riderPath - re-ride with the current harness")
        return 1
    if len(path[0]) < 14:
        print(f"{report_path} predates the signal words (rows of {len(path[0])}) - re-ride with the "
              "current harness")
        return 1

    # The fall line, from the run's own two anchors (falling back to the plan's, with the same staleness
    # caveat as the strips): raw locations + authored distances. The scale is derived rather than assumed at
    # 100 raw/m, so a change of unit convention shows up as a wrong travelled-distance ratio rather than as
    # silently misplaced buckets.
    anchors = doc.get("anchors") or [entry for entry in plan.get("entries", []) if entry.get("location")]
    if len(anchors) < 2:
        print("neither the report nor the plan carries two located anchors; cannot derive the fall line")
        return 1
    first, second = anchors[0], anchors[1]
    delta = [second["location"][axis] - first["location"][axis] for axis in range(2)]  # horizontal raw
    span = math.hypot(*delta) or 1.0
    down = [axis / span for axis in delta]
    scale = (second["distanceM"] - first["distanceM"]) / span  # metres per raw unit, sign included

    def distance_m(row: list[float]) -> float:
        return first["distanceM"] + ((row[1] - first["location"][0]) * down[0]
                                     + (row[2] - first["location"][1]) * down[1]) * scale

    keep_states = None if args.states.strip().lower() == "all" else {
        int(chunk) for chunk in args.states.split(",") if chunk.strip()}

    print(f"report: {report_path.name}   ended {doc.get('ended', 'complete')}, "
          f"{doc.get('samplesPerGameSecond')} samples/game-second, slip reading: {args.slip}"
          + (f", motion states {sorted(keep_states)}" if keep_states else ", all motion states"))
    if doc.get("steered"):
        print(f"steered: {doc['steered']}")
    if doc.get("ended") in ("stalled", "cut-short"):
        print("WARNING: the window did not finish; strips past where the rider got to will be thin or empty")

    header = (f"{'strip':<10} {'surf':<12} {'n':>4}  {'speed m/s':>9}  "
              f"{'Dig p10/50/90':>23}  {'Slip p10/50/90':>23}  {'Lean p10/50/90':>23}")
    print("\n" + header)
    print("-" * len(header))
    for strip in strips:
        in_span = [row for row in path
                   if strip["fromM"] + args.margin <= distance_m(row) < strip["toM"] - args.margin]
        rows = ([row for row in in_span if len(row) < 15 or int(row[14]) in keep_states]
                if keep_states else in_span)
        dropped = len(in_span) - len(rows)
        group = GROUP_NAMES[SURFACE_GROUP.get(strip["surface"], 0)]
        label = f"{strip['label']:<10} {strip['surface']:>2} {group:<9}"
        if not rows:
            print(f"{label} {0:>4}  (" + ("the rider never rode this strip" if not in_span
                  else f"all {len(in_span)} samples were in other motion states") + ")")
            continue
        speeds, digs, slips, leans = [], [], [], []
        for row in rows:
            velocity = row[4:7]
            magnitude = math.sqrt(sum(value * value for value in velocity))
            slip_vec = row[11:14]
            along = sum(s * v for s, v in zip(slip_vec, velocity))
            if args.slip == "lateral":
                slip = math.sqrt(max(0.0, magnitude * magnitude - along * along))
            elif args.slip == "projection" and magnitude > 1e-3:
                slip = abs(along) / magnitude
            else:
                slip = math.sqrt(sum(value * value for value in slip_vec))
            dig = abs(row[9])
            lean = abs(row[10]) * 127.0
            speeds.append(magnitude / 100.0)
            digs.append(dig)
            slips.append(slip)
            leans.append(lean)
        print(f"{label} {len(rows):>4}  {_percentile(speeds, 0.5):>9.1f}  {_spread(digs)}  "
              f"{_spread(slips)}  {_spread(leans)}"
              + (f"   (+{dropped} off-state)" if dropped else ""))

    print("\nAn unsteered pass reads the clean-riding baseline; Slip/Lean near zero here is the ride,")
    print("not the instrument. This report contains measured signals only, not retail program output.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
