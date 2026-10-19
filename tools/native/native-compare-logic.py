"""Compare native Effects output to existing Maps data; never import decoder code."""

import argparse
import json
from pathlib import Path
import struct
import subprocess
import tempfile


def equal(a, b, path):
    if isinstance(a, dict) and isinstance(b, dict):
        assert set(a) == set(b), (path, set(a) ^ set(b))
        for key in a:
            equal(a[key], b[key], path + "." + key)
    elif isinstance(a, list) and isinstance(b, list):
        assert len(a) == len(b), path
        for index, (x, y) in enumerate(zip(a, b)):
            equal(x, y, path + f"[{index}]")
    elif isinstance(a, (float, int)) and isinstance(b, (float, int)):
        assert a == b or struct.pack("<f", a) == struct.pack("<f", b), (path, a, b)
    else:
        assert a == b, (path, a, b)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("executable", type=Path)
    parser.add_argument("native_maps", type=Path)
    parser.add_argument("reference_maps", type=Path)
    args = parser.parse_args()
    total = courses = 0
    with tempfile.TemporaryDirectory(prefix="openslope-logic-compare-") as temporary:
        for folder in sorted(args.native_maps.iterdir()):
            sources = list((folder / "Source").glob("*.SSF"))
            if not sources:
                continue
            assert len(sources) == 1, folder
            output = Path(temporary) / (folder.name + "-Effects.json")
            subprocess.run(
                [str(args.executable.resolve()), "convert-effects", str(sources[0]), str(output)],
                check=True,
                capture_output=True,
            )
            doc = json.loads(output.read_text())
            reference = json.loads((args.reference_maps / folder.name / "SSFLogic.json").read_text())
            expected = reference["EffectHeaders"] + reference["Functions"]
            chains = doc["graphs"] + doc["functions"]
            assert len(doc["graphs"]) == len(reference["EffectHeaders"])
            assert len(doc["functions"]) == len(reference["Functions"])
            for chain, original in zip(chains, expected):
                assert len(chain["nodes"]) == len(original["Effects"])
                for node, old in zip(chain["nodes"], original["Effects"]):
                    assert node["mainType"] == old["MainType"]
                    equal(
                        node["payload"],
                        {k: v for k, v in old.items() if k != "MainType"},
                        folder.name + "/" + node["id"],
                    )
                    total += 1
            assert [f["name"] for f in doc["functions"]] == [f["FunctionName"] for f in reference["Functions"]]
            columns = [
                "PersistantEffectSlot",
                "CollisionEffectSlot",
                "Slot3",
                "Slot4",
                "EffectTriggerSlot",
                "Slot6",
                "Slot7",
            ]
            portable = ["persistent", "collision", "slot3", "slot4", "trigger", "slot6", "slot7"]
            assert len(doc["slots"]) == len(reference["EffectSlots"])
            for slot, original in zip(doc["slots"], reference["EffectSlots"]):
                for old, new in zip(columns, portable):
                    index = original[old]
                    assert slot["circumstances"][new] == (None if index < 0 else f"graph:{index}")
            source = sources[0].read_bytes()
            count, offset = struct.unpack_from("<II", source, 36)
            base = offset + count * 8
            for i, chain in enumerate(chains):
                if i < count:
                    nodes, relative = struct.unpack_from("<II", source, offset + i * 8)
                else:
                    (table,) = struct.unpack_from("<I", source, 48)
                    nodes, relative = struct.unpack_from("<II", source, table + (i - count) * 24)
                at = base + relative
                assert nodes == len(chain["nodes"])
                for node in chain["nodes"]:
                    main, size = struct.unpack_from("<II", source, at)
                    assert node["mainType"] == main
                    assert node["extensions"]["nativeWords"] == list(
                        struct.unpack_from("<" + "I" * (size // 4), source, at)
                    )
                    at += size
            courses += 1
    assert courses == 11, courses
    print(f"PASS: {total} typed node payloads, slot/function joins and exact source words across {courses} courses")


if __name__ == "__main__":
    main()
