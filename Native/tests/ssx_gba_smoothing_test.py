"""Compact quad reconstruction and analytic seam checks on authored GBA hills."""
from pathlib import Path
import json
import math
import subprocess
import sys
import tempfile
from ssx_gba_import_test import rom

EDGES = [(0, 4, 8, 12), (12, 13, 14, 15), (15, 11, 7, 3), (3, 2, 1, 0)]


def sub(a, b):
    return [x-y for x, y in zip(a, b)]


def dot(a, b):
    return sum(x*y for x, y in zip(a, b))


def cross(a, b):
    return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]


def basis(t):
    return [(1-t)**3, 3*(1-t)**2*t, 3*(1-t)*t*t, t**3]


def derivative(t):
    return [-3*(1-t)**2, 3*(1-t)*(1-3*t), 3*t*(2-3*t), 3*t*t]


def sample(points, u, v):
    bu, bv, du, dv = basis(u), basis(v), derivative(u), derivative(v)
    p = [sum(points[i*4+j][k]*bu[i]*bv[j] for i in range(4) for j in range(4)) for k in range(3)]
    a = [sum(points[i*4+j][k]*du[i]*bv[j] for i in range(4) for j in range(4)) for k in range(3)]
    b = [sum(points[i*4+j][k]*bu[i]*dv[j] for i in range(4) for j in range(4)) for k in range(3)]
    n = cross(a, b)
    size = math.sqrt(dot(n, n))
    if size <= 1e-5:
        # A single triangular patch collapses exactly one boundary. Its normal
        # is the one-sided limit; every other point must remain nonsingular.
        for value, coordinate, indices in [(u, 0, (0, 1, 2, 3)), (u-1, 0, (12, 13, 14, 15)),
                                            (v, 1, (0, 4, 8, 12)), (v-1, 1, (3, 7, 11, 15))]:
            if value == 0 and len({key(points[k]) for k in indices}) == 1:
                uv = [u, v]
                uv[coordinate] = 1e-5 if uv[coordinate] == 0 else 1-1e-5
                _, normal = sample(points, *uv)
                return p, normal
        raise AssertionError('Surface is singular away from the triangular boundary')
    return p, [x/size for x in n]


def edge_sample(patch, edge, t):
    uv = [(t, 0), (1, t), (1-t, 1), (0, 1-t)][edge]
    return sample(patch['Points'], *uv)


def key(point):
    return tuple(round(x, 6) for x in point)


def shared(a, b):
    for i, edge in enumerate(EDGES):
        x = [a['Points'][k] for k in edge]
        for j, other in enumerate(EDGES):
            y = [b['Points'][k] for k in other]
            if {key(x[0]), key(x[3])} == {key(y[0]), key(y[3])}:
                return i, j, key(x[0]) != key(y[0])
    raise AssertionError('Expected a common edge')


def seam_angles(a, b):
    i, j, reverse = shared(a, b)
    values = []
    for t in (0, .125, .25, .5, .75, .875, 1):
        p, n = edge_sample(a, i, t)
        q, m = edge_sample(b, j, 1-t if reverse else t)
        assert math.dist(p, q) < 1e-6, 'Shared cubic edges must be coincident, not just their corners'
        values.append(math.degrees(math.acos(max(-1, min(1, dot(n, m))))))
    return values


def main():
    executable = sys.argv[1]
    with tempfile.TemporaryDirectory(prefix='openslope-gba-smooth-') as work:
        root = Path(work)
        for label, options in [('gentle', dict(hill_height=35)),
                               ('material-seam', dict(hill_height=10, hill_seam=True)),
                               ('threshold', dict(hill_height=36)),
                               ('sharp', dict(hill_height=200)),
                               ('flags-seam', dict(hill_height=10, hill_split=True))]:
            source = root / f'{label}.gba'
            source.write_bytes(rom(**options))
            out = root / label
            result = subprocess.run([executable, 'extract', str(source), 'SSXGBA_GARIBALDI', str(out)], capture_output=True, text=True)
            assert result.returncode == 0, result.stdout + result.stderr
            folder = out / 'SSXGBA_GARIBALDI'
            patches = json.loads((folder / 'Patches.json').read_text())['Patches']
            metadata = json.loads((folder / 'Import.json').read_text())
            assert metadata['QuadSplitTriangles'] == 0
            for patch in patches:
                points = patch['Points']
                assert len({key(points[k]) for k in (0, 12, 3, 15)}) == (4 if 'SourceRecords' in patch else 3)
                for u in (0, .25, .5, .75, 1):
                    for v in (0, .25, .5, .75, 1):
                        _, n = sample(points, u, v)
                        assert n[2] > 0, 'Height fitting must not fold the terrain'
            left = next(p for p in patches if set(p.get('SourceRecords', [])) == {8, 9})
            if label == 'flags-seam':
                assert metadata['UnpairedTrianglePatches'] == 2 and metadata['LinearHangingEdges'] == 0
                right = [p for p in patches if p['SourceRecord'] in (10, 11)]
                assert len(right) == 2, 'Surface flag seams retain one patch per source triangle'
                angles = seam_angles(left, next(p for p in right if p['SourceRecord'] == 10))
                assert max(angles) < 3, ('Gentle quad/triangle joins must be smoothed', angles)
                print(label, 'seam angles:', ', '.join(f'{a:.3f}' for a in angles))
            else:
                right = next(p for p in patches if set(p.get('SourceRecords', [])) == {10, 11})
                angles = seam_angles(left, right)
                if label in ('sharp', 'threshold'):
                    assert min(angles) > (80 if label == 'sharp' else 20), ('Sharp crease was rounded', angles)
                else:
                    assert max(angles[1:-1]) < 1, ('Gentle seam must have matching analytic normals', angles)
                    assert metadata['CurvedTerrainEdges'] > 0
                    points = left['Points']
                    corners = [points[k] for k in (0, 12, 3, 15)]
                    changed = False
                    for i in (1, 2):
                        for j in (1, 2):
                            u, v = i/3, j/3
                            flat = sum(p[2]*w for p, w in zip(corners, [(1-u)*(1-v), u*(1-v), (1-u)*v, u*v]))
                            changed |= abs(points[i*4+j][2]-flat) > .01
                    assert changed, 'Interior controls must create actual curvature rather than a bilinear net'
                print(label, 'seam angles:', ', '.join(f'{a:.3f}' for a in angles))
    print('GBA compact topology, curved interiors, smooth analytic seams, sharp creases and unsplit seams PASS')


if __name__ == '__main__':
    main()
