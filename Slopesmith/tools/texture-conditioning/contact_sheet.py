"""Make a labelled contact sheet with every input repeated 2x2."""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image, ImageDraw


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("output", type=Path)
    parser.add_argument("files", nargs="+", type=Path)
    parser.add_argument("--columns", type=int, default=4)
    parser.add_argument("--cell", type=int, default=220)
    args = parser.parse_args()
    pad, label = 14, 20
    rows = math.ceil(len(args.files) / args.columns)
    width = args.columns * (args.cell + pad) + pad
    height = rows * (args.cell + pad + label) + pad
    sheet = Image.new("RGB", (width, height), (24, 24, 28))
    draw = ImageDraw.Draw(sheet)
    for index, path in enumerate(args.files):
        image = Image.open(path).convert("RGB")
        half = args.cell // 2
        sample = image.resize((half, half), Image.Resampling.LANCZOS)
        repeated = Image.new("RGB", (args.cell, args.cell))
        for y in range(2):
            for x in range(2):
                repeated.paste(sample, (x * half, y * half))
        left = pad + (index % args.columns) * (args.cell + pad)
        top = pad + (index // args.columns) * (args.cell + pad + label)
        sheet.paste(repeated, (left, top))
        draw.text((left, top + args.cell + 4), path.name, fill=(210, 210, 215))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(args.output, "PNG", optimize=True)
    print(f'{args.output}  {width}x{height}  {len(args.files)} tiles')


if __name__ == "__main__":
    main()
