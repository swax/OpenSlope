"""
Take the target platform's cost census, which is step 1 of building any new prop.

    python Slopesmith/tools/prop-recipes/measure.py hut lodge cabin shack   # what exists, by name
    python Slopesmith/tools/prop-recipes/measure.py --map SNOW Shrine       # cost the matches
    python Slopesmith/tools/prop-recipes/measure.py "Tree_Bushy"            # across every map

## What this tool is for, and what it is not for

It answers three questions, all of them about what the hardware can afford to draw:

- **How many triangles** may a prop of this class cost? That is the budget table in the README.
- **Solid or sheet?** The up/down/side normal split settles it. All-side with nothing up or down means
  a stack of alpha-cut cards, and a class built that way cannot be done as solid geometry at the same
  cost — get this wrong and no amount of atlas work rescues it.
- **How big is a texture page**, and do a family's props share one?

It is not a source of SHAPE. Silhouette, proportion and arrangement are authored from the subject —
`trees/_species.py` generates a tree from crown ratio, crown spread, annual increment and branch
angle, and `check.py` measures the built mesh back against that. Nothing in this folder reads this
tool's output at build time; it is an offline census, not an input.

Reads `Maps/*/Models.json` -> `MeshData.MeshPath` -> `Maps/*/Meshes/N.obj`, plus `Materials.json` for
the texture each material points at. No Blender and no Pillow.

## Raw space is Z-UP

`editorFromRaw(x, y, z) = (-x/100, z/100, -y/100)`, so the OBJ's third component is height and its
units are centimetres. A normal census that treats raw Y as up reports nonsense — every wall becomes a
floor. That conversion is the reason this is a script and not an eyeball.

## Scale is not shared with the recipes

The levels are built at level scale and they are large: a background tree carries a 30 m trunk, and a
piece of machinery stands 10.9 m tall. Recipes here are authored at REAL-WORLD metres — the snowmobile
is a 3 m sled. So the bounding boxes below say what class of object you are looking at; they do not
transfer to a prop.
"""

import argparse
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
# Slopesmith/tools/prop-recipes -> the repo root, which is where Maps/ sits
MAPS = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(HERE))), 'Maps')


def load_obj(path):
    """Positions and faces. The OBJs carry normals and UVs too; neither is needed to cost a model."""
    verts, faces = [], []
    with open(path, encoding='utf-8', errors='replace') as fh:
        for line in fh:
            if line.startswith('v '):
                verts.append(tuple(float(x) for x in line.split()[1:4]))
            elif line.startswith('f '):
                faces.append([int(t.split('/')[0]) - 1 for t in line.split()[1:]])
    return verts, faces


def newell(verts, face):
    """Polygon normal from the winding, the same way `check.py` and Blender both derive one."""
    n = [0.0, 0.0, 0.0]
    for i, vi in enumerate(face):
        p, q = verts[vi], verts[face[(i + 1) % len(face)]]
        n[0] += (p[1] - q[1]) * (p[2] + q[2])
        n[1] += (p[2] - q[2]) * (p[0] + q[0])
        n[2] += (p[0] - q[0]) * (p[1] + q[1])
    return n


def maps(only=None):
    if not os.path.isdir(MAPS):
        raise SystemExit(f'no Maps/ at {MAPS} — pass --maps')
    found = [d for d in sorted(os.listdir(MAPS))
             if os.path.isfile(os.path.join(MAPS, d, 'Models.json'))]
    return [d for d in found if d == only] if only else found


def materials(name):
    path = os.path.join(MAPS, name, 'Materials.json')
    if not os.path.isfile(path):
        return []
    data = json.load(open(path, encoding='utf-8'))
    return data.get('Materials', data) if isinstance(data, dict) else data


def measure(name, model):
    """Triangles, bbox in metres, and the normal split — the three numbers that decide a design."""
    verts, tris, up, down, side, mats = [], 0, 0, 0, 0, set()
    for obj in model['ModelObjects']:
        for mesh in obj.get('MeshData') or []:
            path = os.path.join(MAPS, name, 'Meshes', mesh['MeshPath'])
            if not os.path.isfile(path):
                continue
            mats.add(mesh['MaterialID'])
            v, faces = load_obj(path)
            verts += v
            for face in faces:                       # indices are per-OBJ, so measure against `v`
                tris += len(face) - 2
                n = newell(v, face)
                length = math.sqrt(sum(c * c for c in n)) or 1.0
                # index 2 is height: raw space is Z-up, whatever the editor's frame does with it later
                nz = n[2] / length
                up, down, side = (up + (nz > 0.5), down + (nz < -0.5), side + (abs(nz) <= 0.5))
    return verts, tris, up, down, side, sorted(mats)


def report(name, model, mats):
    verts, tris, up, down, side, ids = measure(name, model)
    if not verts:
        return False
    lo = [min(v[i] for v in verts) for i in range(3)]
    hi = [max(v[i] for v in verts) for i in range(3)]
    print(f'{model["ModelName"]}  ({name})')
    print(f'    {tris} tris, {len(verts)} verts, {len(model["ModelObjects"])} object(s)')
    print(f'    bbox {(hi[0] - lo[0]) / 100:.2f} W x {(hi[1] - lo[1]) / 100:.2f} L x '
          f'{(hi[2] - lo[2]) / 100:.2f} H m')
    # The split is the whole solid-or-sheet answer: 0 up / 0 down / all side is a stack of cards.
    print(f'    normals  {up} up / {down} down / {side} side')
    for mid in ids:
        try:
            mat = mats[mid]
            print(f'    material {mid}  {mat.get("TexturePath", "?")}  {mat.get("MaterialName", "")}')
        except (IndexError, KeyError, TypeError):
            print(f'    material {mid}  <not in Materials.json>')
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('patterns', nargs='+', help='case-insensitive regexes matched against model names')
    ap.add_argument('--map', help='restrict to one map (SNOW, GARI, MERQUER, MESA, ELYSIUM)')
    ap.add_argument('--maps', help='path to the Maps/ directory')
    ap.add_argument('--list', action='store_true', help='names only — use this first, then measure')
    ap.add_argument('--limit', type=int, default=12, help='max models to measure per map (default 12)')
    args = ap.parse_args()

    global MAPS
    if args.maps:
        MAPS = args.maps

    rx = re.compile('|'.join(args.patterns), re.I)
    total = 0
    for name in maps(args.map):
        models = json.load(open(os.path.join(MAPS, name, 'Models.json'), encoding='utf-8'))['Models']
        hits = [m for m in models if rx.search(m['ModelName'])]
        if not hits:
            continue
        total += len(hits)
        if args.list:
            print(f'== {name}  ({len(hits)} of {len(models)} models)')
            for m in sorted(hits, key=lambda m: m['ModelName']):
                print(f'    {m["ModelName"]}')
            continue
        mats = materials(name)
        print(f'== {name}  ({len(hits)} match)')
        for m in sorted(hits, key=lambda m: m['ModelName'])[:args.limit]:
            report(name, m, mats)
        if len(hits) > args.limit:
            # Say so rather than quietly truncating: a silent cap reads as "that is all there is".
            print(f'    ... {len(hits) - args.limit} more; raise --limit or narrow the pattern')
    if not total:
        print(f'nothing matched. Try --list with a looser pattern, e.g. '
              f'{os.path.basename(sys.argv[0])} --list wood')


if __name__ == '__main__':
    main()
