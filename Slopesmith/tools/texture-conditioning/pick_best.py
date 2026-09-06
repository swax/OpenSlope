"""Rank generated candidates by their worst wrap edge and retain the best."""

from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from _tile import direction_to_axis, open_rgb, seam_stats


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("candidates", nargs="+", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--axis", choices=("vertical", "horizontal"))
    args = parser.parse_args()
    rows = []
    for path in args.candidates:
        image, _ = direction_to_axis(open_rgb(path), args.axis)
        stats = seam_stats(image)
        rows.append((max(stats["h_ratio"], stats["v_ratio"]), path, stats))
    rows.sort(key=lambda row: row[0])
    for index, (_, path, stats) in enumerate(rows):
        print(f'{path.name:<32} h {stats["h_ratio"]:5.2f}  v {stats["v_ratio"]:5.2f}'
              f'{"  <-- keep" if index == 0 else ""}')
    args.out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(rows[0][1], args.out)
    print(f'kept {rows[0][1]} -> {args.out}')


if __name__ == "__main__":
    main()
