"""Measure whether bitmap edges disappear when a terrain page repeats."""

from __future__ import annotations

import argparse
from pathlib import Path

from _tile import open_rgb, seam_stats, verdict


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("files", nargs="+", type=Path)
    args = parser.parse_args()
    print(f'{"file":<28}{"size":<11}{"h-seam":>8}{"v-seam":>8}{"dir":>8}  verdict')
    print("-" * 75)
    for path in args.files:
        im = open_rgb(path)
        stats = seam_stats(im)
        print(f'{path.name:<28}{im.width}x{im.height:<7}{stats["h_ratio"]:>8.2f}'
              f'{stats["v_ratio"]:>8.2f}{stats["directionality"]:>8.2f}  {verdict(stats)}')


if __name__ == "__main__":
    main()
