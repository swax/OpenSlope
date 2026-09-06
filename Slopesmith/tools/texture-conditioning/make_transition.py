"""Build a deterministic organic edge-transition tile from two wrapping base tiles."""

from __future__ import annotations

import argparse
from pathlib import Path

from _tile import make_transition, open_rgb, seam_stats


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("a", type=Path)
    parser.add_argument("b", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--axis", choices=("horizontal", "vertical"), default="vertical")
    parser.add_argument("--seed", type=int, default=23)
    parser.add_argument("--softness", type=float, default=3.0)
    parser.add_argument("--keep", type=int, default=5)
    parser.add_argument("--amplitude", type=float, default=1.0)
    args = parser.parse_args()
    output = make_transition(open_rgb(args.a), open_rgb(args.b), args.axis, args.seed,
                             args.softness, args.keep, args.amplitude)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    output.save(args.output, "PNG", optimize=True)
    stats = seam_stats(output)
    # A vertical A|B tile is chained vertically; its horizontal outside edges intentionally contain
    # different materials and are meant to meet A and B, not another copy of the transition.
    chain = stats["v_ratio"] if args.axis == "vertical" else stats["h_ratio"]
    across = stats["h_ratio"] if args.axis == "vertical" else stats["v_ratio"]
    print(f'{args.output}: chain-wrap {chain:.2f}; A|B cross-edge {across:.2f} (not a self-repeat)')


if __name__ == "__main__":
    main()
