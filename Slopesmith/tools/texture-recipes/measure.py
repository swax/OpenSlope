"""
Measure the SHIPPED snow: start here, before writing a recipe.

    python Slopesmith/tools/texture-recipes/measure.py                  # the reference set
    python Slopesmith/tools/texture-recipes/measure.py SNOW             # SNOW's most-painted pages
    python Slopesmith/tools/texture-recipes/measure.py SNOW/0048.png    # one page
    python Slopesmith/tools/texture-recipes/measure.py --scales SNOW/0048.png build/powder.png
    python Slopesmith/tools/texture-recipes/measure.py --adjacency GARI # distinguish fields from murals

Every constant in `_texture.py` and in every recipe came out of this table rather than out of judgement,
and the same is expected of the next one. A level names its pages by number, so which of SNOW's 150
textures is snow is not something to guess at — the `uses` column counts the terrain patches actually
painted with each, straight out of `Patches.json`, and sorts by it. In SNOW, one page covers 40% of
the mountain and the top six cover 90%.

`--scales` adds the two columns worth reading before choosing bands: where a page's variation sits by
feature size in metres, and how directional it is. That split is the clearest line through the shipped
set — the open field runs 0.4-0.7 and every page with track or wind streaking in it runs 2.8-4.0.
"""

import argparse
import collections
import json
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import _texture                                                                  # noqa: E402

MAPS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(HERE))), 'Maps')

# The snow the shipped levels are actually made of: every page they paint more than a handful of
# terrain patches with, minus the rock and the ice. This is the set `_texture.RETAIL` is the envelope of.
REFERENCE = ['SNOW/0048.png', 'SNOW/0046.png', 'SNOW/0047.png', 'SNOW/0045.png', 'SNOW/0053.png',
             'GARI/0019.png', 'GARI/0012.png', 'ELYSIUM/0052.png', 'ELYSIUM/0059.png',
             'MERQUER/0006.png']


def patches_of(level):
    path = os.path.join(MAPS, level, 'Patches.json')
    if not os.path.isfile(path):
        return []
    with open(path, encoding='utf-8') as fh:
        doc = json.load(fh)
    return doc if isinstance(doc, list) else doc.get('Patches', [])


def terrain_use(level):
    """How many terrain patches each of a level's pages is painted on.

    A page's usage count is the only reliable way to tell terrain from props and skybox: the
    Asset Library sorts by exactly this (`deriveLevelTextures`), and a count of 0 means the page is
    on a model somewhere and never on the ground.
    """
    patches = patches_of(level)
    return collections.Counter(os.path.basename(p['TexturePath']) for p in patches
                               if isinstance(p, dict) and p.get('TexturePath'))


def self_adjacency_of_patches(patches, snap=1.0):
    """Percentage of shared terrain edges whose neighbour uses the same texture page.

    High usage alone cannot distinguish an ordinary field tile from a multi-page mural. A field is repeatedly
    adjacent to itself; a mural or oriented transition deliberately meets different pages. Corners are snapped
    to one extracted-map unit by default to absorb serialization noise.
    """
    if snap <= 0:
        raise ValueError('adjacency snap must be positive')
    terrain = [p for p in patches
               if isinstance(p, dict) and len(p.get('Points', [])) == 16 and p.get('TexturePath')]
    edges = collections.defaultdict(list)

    def key(point):
        return tuple(round(float(value) / snap) for value in point)

    for index, patch in enumerate(terrain):
        points = patch['Points']
        corners = [key(points[i]) for i in (0, 3, 12, 15)]
        for first, second in ((0, 1), (1, 3), (3, 2), (2, 0)):
            edges[frozenset((corners[first], corners[second]))].append(index)

    pages = [os.path.basename(patch['TexturePath']) for patch in terrain]
    total, same = collections.Counter(), collections.Counter()
    for indices in edges.values():
        if len(indices) != 2:
            continue
        first, second = indices
        total[pages[first]] += 1
        total[pages[second]] += 1
        if pages[first] == pages[second]:
            same[pages[first]] += 2
    return {page: 100 * same[page] / count for page, count in total.items() if count}


def terrain_self_adjacency(level, snap=1.0):
    return self_adjacency_of_patches(patches_of(level), snap)


def resolve(names, top):
    """Turn what was asked for into (label, path, uses, level, page) rows.

    Three forms, because three are useful: a bare level name means "its most-painted pages", a
    `LEVEL/page.png` means that one, and anything that exists on disk is taken as a file so a
    generated tile can sit in the same table as the pages it answers to.
    """
    rows = []
    for name in names:
        if os.path.isfile(name) or os.path.isfile(os.path.join(HERE, name)):
            path = name if os.path.isfile(name) else os.path.join(HERE, name)
            rows.append((os.path.relpath(path, HERE) if path.startswith(HERE) else name,
                         path, None, None, os.path.basename(path)))
            continue
        level, _, page = name.replace('\\', '/').partition('/')
        uses = terrain_use(level)
        if not uses and not os.path.isdir(os.path.join(MAPS, level, 'Textures')):
            raise SystemExit(f'no such level or file: {name}   (levels live under {MAPS})')
        pages = [page] if page else [p for p, _ in uses.most_common(top)]
        for p in pages:
            path = os.path.join(MAPS, level, 'Textures', p)
            if not os.path.isfile(path):
                raise SystemExit(f'no such page: {level}/{p}')
            rows.append((f'{level}/{p}', path, uses.get(p, 0), level, p))
    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('names', nargs='*', help='LEVEL, LEVEL/page.png, or a path to a PNG')
    ap.add_argument('--top', type=int, default=8, help='pages per level (default 8)')
    ap.add_argument('--scales', action='store_true', help='add the feature-size and direction columns')
    ap.add_argument('--adjacency', action='store_true',
                    help='add same-page neighbour percentage for reference terrain pages')
    ap.add_argument('--adjacency-snap', type=float, default=1.0,
                    help='corner quantization in extracted-map units (default 1.0)')
    args = ap.parse_args()

    rows = resolve(args.names or REFERENCE, args.top)
    width = max(len(label) for label, _, _, _, _ in rows)
    adjacency = {}
    if args.adjacency:
        for level in sorted({level for _, _, _, level, _ in rows if level}):
            adjacency[level] = terrain_self_adjacency(level, args.adjacency_snap)
    self_header = ' self%' if args.adjacency else ''
    print(f'{"page".ljust(width)}  uses{self_header}   size  mean RGB           grain  skew  cols  axis%  seam u/v')
    stats = []
    for label, path, uses, level, page in rows:
        image = Image.open(path)
        a = np.asarray(image.convert('RGBA'))
        m = _texture.measure(a)
        stats.append(m)
        self_value = adjacency.get(level, {}).get(page) if args.adjacency else None
        self_cell = f'{self_value:5.0f}' if self_value is not None else '     '
        print(f'{label.ljust(width)}  {"" if uses is None else uses:>4}'
              f'{self_cell if args.adjacency else ""}  {image.size[0]:>4}  '
              f'{str(m["mean"].round(0)):18} {m["grain"]:5.1f} {m["skew"]:+5.2f}  {m["colours"]:4d}  '
              f'{m["axis share"]:5.2f}  {m["seam"][0]:.2f}/{m["seam"][1]:.2f}')

    if args.scales:
        keys = sorted(stats[0]['octaves'], reverse=True)
        print()
        print(f'{"page".ljust(width)}  ' + ' '.join(f'{lo:>4.1f}-{hi:.1f}m' for lo, hi in keys)
              + '    u/v  streaks')
        for (label, _, _, _, _), m in zip(rows, stats):
            cells = ' '.join(f'{m["octaves"][k]:8.1f}%' for k in keys)
            print(f'{label.ljust(width)}  {cells}  {m["aniso"]:5.2f}  {m["streaks"]:5.1f}%')

    print(f'\none tile covers about {_texture.METRES:.0f} m of mountain, so the page runs '
          f'{_texture.CM_PER_PX:.0f} cm/px - a 2 px mark is a third of a metre wide.')


if __name__ == '__main__':
    main()
