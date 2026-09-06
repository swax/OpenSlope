#!/usr/bin/env python3
"""Collapse several runs of the same fixture into one fire-rate table.

  python tools/autotest/tally.py                    the 3 most recent reports of one fixture
  python tools/autotest/tally.py --last 6           the 6 most recent
  python tools/autotest/tally.py --fixture AUTOTEST2  the bench rather than the GOLD regression course
  python tools/autotest/tally.py run-a.json ...     exactly these

One pass answers "did it fire this time", which is the wrong question for any cell that is not perfectly
reliable -- the x6 gate fired in four passes out of five and looked like a solid result in every one of
those four. A cell only earns an expectation when a batch of passes agrees, and this is what reads the
batch.

Closest approach travels with the fire rate because it separates the two explanations for a dark cell:
a cell the rider drifted 40 m wide of did not fail, it was not tested.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "instrumentation"))
from verdict import FAULT_ENDS  # noqa: E402

REPORTS = Path(__file__).resolve().parents[3] / "Trailmap" / "temp" / "autotest"


#: Reports written before the harness grew a second fixture carry no `fixture` field, and all of them are the
#: gold map's.
DEFAULT_FIXTURE = "AUTOTEST1"

#: What a rider signal reads when nothing happened, so a rest reading can be dropped rather than ranged.
#: Zero for anything a node writes into an otherwise-untouched field; the gem multiplier is the exception and
#: the reason this is a table — every rider carries 1.0 whenever no gem is active.
SIGNAL_REST = {"gem-multiplier": 1.0}


def load(paths: list[Path]) -> list[dict]:
    return [json.loads(path.read_text(encoding="utf-8")) for path in paths]


def fixture_of(run: dict) -> str:
    return str(run.get("fixture") or DEFAULT_FIXTURE).upper()


def recent(count: int, fixture: str | None) -> list[Path]:
    """The newest reports OF ONE COURSE.

    Averaging two fixtures together would be silently wrong rather than noisily wrong: the two share cell ids
    (both open with the same retail control), so a mixed batch produces a fire rate over passes that were not
    asking the same question.
    """
    paths = sorted(REPORTS.glob("run-*.json"))
    if fixture is None:
        for path in reversed(paths):
            fixture = fixture_of(json.loads(path.read_text(encoding="utf-8")))
            break
    kept = [path for path in paths
            if fixture_of(json.loads(path.read_text(encoding="utf-8"))) == fixture]
    return kept[-count:]


def tally(runs: list[dict]) -> list[dict]:
    """One row per cell, in the order the first run saw them (which is course order)."""
    order: list[str] = []
    rows: dict[str, dict] = {}
    for run in runs:
        for variant in run["variants"]:
            row = rows.get(variant["id"])
            if row is None:
                order.append(variant["id"])
                row = rows[variant["id"]] = {
                    "id": variant["id"], "expects": set(), "seen": 0,
                    "fired": 0, "crossed": 0, "grades": {}, "approach": [], "paint": {},
                    "lift": {}, "slot": {}, "signals": {},
                }
            row["seen"] += 1
            row["expects"].add(variant.get("expect"))
            row["fired"] += 1 if variant["fired"] else 0
            row["crossed"] += 1 if variant["crossed"] else 0
            row["grades"][variant["grade"]] = row["grades"].get(variant["grade"], 0) + 1
            paint = variant.get("paintGrade")
            if paint and paint != "n/a":
                row["paint"][paint] = row["paint"].get(paint, 0) + 1
            rider = variant.get("riderGrade")
            if rider and rider != "n/a":
                row["lift"][rider] = row["lift"].get(rider, 0) + 1
            # The latch cells' own column. It has to travel with the batch rather than be read per run,
            # because a latch claim is only a claim beside its control: "held every pass" means nothing
            # until the control released every pass, and the two are different rows of the same table.
            slot = variant.get("slotGrade")
            if slot and slot != "n/a":
                row["slot"][slot] = row["slot"].get(slot, 0) + 1
            # Kept PER SIGNAL, because they are not the same quantity: `rise` is m/s, `jump` is metres,
            # the pad requests are seconds of window. Pooling them into one range invites reading another
            # signal's magnitude as this one's -- a cell's 1.6 m jump next to its 7.1 m/s rise makes the
            # rise look like it is grazing a threshold it clears four times over.
            #
            # A reading at the noise floor is dropped rather than ranged, because a range that runs from 0 to
            # the effect says nothing about either. That makes the COUNT part of the reading and not a detail:
            # a signal one pass in three caught otherwise prints exactly like one every pass caught, which is
            # the whole "one pass is not a result" mistake wearing a range for a disguise.
            #
            # "Noise floor" meant ZERO for the first six signals because each is a field a node writes and
            # nothing else touches. `gem-multiplier` is the first that rests somewhere else -- 1.0, the
            # multiplier every rider carries when no gem is active -- so filtering it against zero would
            # print a rest reading on every row in the table and bury the one cell that moved it. The rest
            # value is a property of the FIELD, so it is named per signal rather than assumed.
            for name, value in (variant.get("rider") or {}).items():
                if value is not None and abs(value - SIGNAL_REST.get(name, 0.0)) > 0.05:
                    row["signals"].setdefault(name, []).append(value)
            if variant.get("closestApproachM") is not None:
                row["approach"].append(variant["closestApproachM"])
    return [rows[cell] for cell in order]


def verdict_for(row: dict) -> str:
    """What a batch this size is entitled to conclude -- deliberately conservative.

    `always`/`never` are only offered from three or more passes, because two agreeing passes is exactly
    the evidence the x6 cell produced twice before it broke its own pattern.
    """
    if not row["crossed"]:
        # A cell can fire without the rider ever going near it, and exactly one kind does: a hop target,
        # whose whole claim is that something reached it from 100 m away. Reporting that as "never reached"
        # buries the result the cell exists to produce.
        if row["fired"]:
            return f"fired untouched {row['fired']}/{row['seen']}"
        return "never reached"
    if row["fired"] == row["seen"]:
        return "always" if row["seen"] >= 3 else "fired every pass (thin)"
    if row["fired"] == 0:
        return "never" if row["seen"] >= 3 else "dark every pass (thin)"
    return "INTERMITTENT"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("reports", nargs="*", type=Path)
    parser.add_argument("--last", type=int, default=3)
    parser.add_argument("--fixture", default=None,
                        help="which course to read; defaults to whichever ran most recently")
    args = parser.parse_args(argv)

    paths = args.reports or recent(args.last, args.fixture.upper() if args.fixture else None)
    if not paths:
        print("no reports found")
        return 1
    runs = load([Path(path) for path in paths])

    mixed = {fixture_of(run) for run in runs}
    print(f"{len(runs)} run(s) of {'/'.join(sorted(mixed))}:")
    for path, run in zip(paths, runs):
        rider = run.get("rider") or {}
        # Window in game frames rather than host seconds, and the emulation speed beside it: two passes of
        # one fixture cover the same course, so a differing frame count is a run that ended early and its
        # `not-reached` cells mean "untested", not "failed".
        ended = run.get("ended", "complete")
        speed = run.get("emulationSpeed")
        # A report written before the window was counted in frames has host seconds and nothing to convert
        # them with, so it says so rather than reporting a frame count of zero.
        window = f"{run['frames']}f ({run['seconds']}s)" if "frames" in run else f"{run.get('seconds')}s wall"
        print(f"  {Path(path).name}  {window}"
              + (f" @{speed}x" if speed else "")
              + (f" ENDED-EARLY:{ended}" if ended in FAULT_ENDS else "")
              + f"  travel {rider.get('travelledM', 0):.0f} m  descent {rider.get('maxDescentM', 0):.0f} m"
              f"  peak rise {rider.get('peakRiseMps')} m/s  laps {rider.get('lapsRemaining')}"
              # Per run rather than per batch: whether the mountain was crowded is a property of the pass,
              # and a batch that rode two different modes should say so on the lines rather than average it
              # away. Older reports predate the probe and carry no key at all, which is not the same as a
              # solo field -- so they print nothing here instead of borrowing a number.
              + (f"  riders {rider['riderCount']}" if rider.get("riderCount") is not None else ""))

    print(f"\n{'cell':<24} {'fired':>7}  {'verdict':<22} {'approach m':<16} {'signal':<34} grades")
    for row in tally(runs):
        rate = f"{row['fired']}/{row['seen']}"
        approach = row["approach"]
        span = (f"{min(approach):.2f}-{max(approach):.2f}" if approach else "-")
        # Each signal's own range travels beside the fire rate for the same reason approach does: it is what
        # a later `expectRider` gets set from, and reading it off a batch is the only way to know it repeats.
        # The count rides with it whenever a pass came back at the noise floor, so a signal seen ONCE cannot
        # be read as one seen every time -- which is exactly how the two pad opcodes nearly graduated on a
        # single pass out of three.
        rises = " ".join(
            f"{name} {min(values):.1f}-{max(values):.1f}"
            + (f" ({len(values)}/{row['seen']})" if len(values) < row["seen"] else "")
            for name, values in sorted(row["signals"].items())) or "-"
        grades = " ".join(f"{name}x{count}" for name, count in sorted(row["grades"].items()))
        if row["paint"]:
            grades += "  paint:" + " ".join(f"{name}x{count}" for name, count in sorted(row["paint"].items()))
        if row["lift"]:
            grades += "  rider:" + " ".join(f"{name}x{count}" for name, count in sorted(row["lift"].items()))
        if row["slot"]:
            grades += "  slot:" + " ".join(f"{name}x{count}" for name, count in sorted(row["slot"].items()))
        print(f"{row['id']:<24} {rate:>7}  {verdict_for(row):<22} {span:<16} {rises:<34} {grades}")

    rows = tally(runs)
    if len(mixed) > 1:
        # Two courses share cell ids (both open with the same retail control), so a mixed batch reports a
        # fire rate across passes that were not asking the same question.
        print(f"\nMIXED FIXTURES in one batch ({', '.join(sorted(mixed))}) — the rates above average passes "
              f"of different courses. Re-run with --fixture.")
    ragged = [row["id"] for row in rows if verdict_for(row) == "INTERMITTENT"]
    if ragged:
        print(f"\nintermittent, so not gradeable: {', '.join(ragged)}")

    # A batch can span edits to the catalogue, and then a cell's grades are answers to two different
    # questions stacked in one column -- a REGRESSION recorded against an expectation since withdrawn is
    # not a failure of anything the fixture currently claims. Say so rather than leave it to be misread.
    shifted = [row["id"] for row in rows if len(row["expects"]) > 1]
    if shifted:
        print(f"\nexpectation CHANGED mid-batch, so the grade column mixes catalogue versions: "
              f"{', '.join(shifted)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
