"""
Validate a prop recipe WITHOUT Blender: triangle budget, bounding box, and both orientation guards.

    python Slopesmith/tools/prop-recipes/check.py frosted_pine
    python Slopesmith/tools/prop-recipes/check.py                 # every recipe, including subfolders

Why this exists: a recipe is pure geometry until `finish()` touches `bpy`, so everything worth checking
can be checked in a plain interpreter in milliseconds. Run this before every Blender build. A guard that
trips inside Blender costs a round trip through the MCP bridge; a guard that trips here costs nothing.

It stubs `bpy` and intercepts `finish()`, so it depends on two conventions every recipe follows:

  * the recipe calls `finish(b, ...)` exactly once, as its last statement
  * the reload line is written verbatim as `importlib.reload(_lib)`

The checks mirror `_lib.finish` exactly, plus two it cannot make:

  * no SHEET face (a part named 'boughs', 'crown', 'foliage', 'skirt', …) may aim below horizontal.
    Sheets are lit from their single authored normal and shown identically from both sides, so one
    aimed at the ground is ambient-only dark from every view.
  * a recipe that declares a `SPECIES` gets its crown measured off the built mesh and compared with
    what that spec asked for. `trees/_species.py` generates a tree from crown ratio, crown spread and
    where the crown is widest; this is the other end of that claim, measured rather than trusted, so
    a spec edit that does not land can be seen without opening Blender.
"""

import math
import os
import sys
import types

HERE = os.path.dirname(os.path.abspath(__file__))
SHEET_PARTS = {'boughs', 'crown', 'foliage', 'skirt', 'skirts', 'leaves', 'canopy', 'plume', 'spray'}


def newell(verts, face):
    """Polygon normal by Newell's method — what Blender would compute from the same winding."""
    n = [0.0, 0.0, 0.0]
    for i, vi in enumerate(face):
        p, q = verts[vi], verts[face[(i + 1) % len(face)]]
        n[0] += (p[1] - q[1]) * (p[2] + q[2])
        n[1] += (p[2] - q[2]) * (p[0] + q[0])
        n[2] += (p[0] - q[0]) * (p[1] + q[1])
    return n


# Tool scripts that live beside the recipes and are not recipes. Named explicitly rather than sniffed:
# the rule below is "any .py that is not obviously something else", so a new tool dropped in here is
# otherwise picked up and run as a prop, and fails as one.
TOOLS = ('check.py', 'build_all.py', 'measure.py')


def png_size(path):
    """Width and height straight out of the IHDR, so this stays free of Pillow — the atlas half of the
    pipeline needs it but this half advertises that it runs anywhere."""
    with open(path, 'rb') as fh:
        head = fh.read(24)
    if len(head) < 24 or head[:8] != b'\x89PNG\r\n\x1a\n':
        return None
    return (int.from_bytes(head[16:20], 'big'), int.from_bytes(head[20:24], 'big'))


def texels(b, page):
    """Per part: how many centimetres of prop each texture pixel covers, and whether any face is
    TAPERED.

    This is the number that decides what art can be drawn — a 22 cm board is 6 px on one panel and 9
    on another, and getting it wrong is most of what makes a first atlas look wrong on the model. It
    was worked out by hand for every panel of every prop here, which is slow and goes stale silently
    the moment a dimension changes. The geometry already knows it.

    The taper column is the other half. `box(taper=)` leaves trapezoid sides, and a panel on one of
    those is stretched by a ratio that VARIES across the face. Pre-distorting the art for that is
    possible, but the face is a quad and the exporter triangulates it, so U interpolates affinely on
    each half and jumps at the diagonal — only V survives, because both triangles still map it to
    height. Horizontal art is therefore fine on a taper and anything with a vertical edge is not.
    """
    rows = []
    for part, lo, hi in b.parts:
        density, stretch, taper, tapered = [], 1.0, 1.0, 0
        for i in range(lo, hi):
            face, uvs = b.faces[i], b.uvs[i]
            edges = []
            for k in range(len(face)):
                j = (k + 1) % len(face)
                p, q = b.verts[face[k]], b.verts[face[j]]
                world = math.dist(p, q) * 100.0                       # metres to centimetres
                span = math.dist(uvs[k], uvs[j]) * page
                if span > 0.5 and world > 1e-6:                       # skip degenerate/collapsed edges
                    edges.append((world / span, world))
            if not edges:
                continue
            density += [d for d, _ in edges]
            # Stretch is measured WITHIN a face, not across the part. A part whose faces are simply
            # different sizes is fine; a single face drawn at 12 cm/px one way and 1 the other is what
            # smears a mark, and only the second is worth reporting.
            stretch = max(stretch, max(d for d, _ in edges) / min(d for d, _ in edges))
            # Opposite edges of a rectangle match; on a trapezoid they do not, and the ratio between
            # them is how hard the UVs are sheared across the face. A gently coned lathe trips this
            # too, so the bar is set where the shear starts to be visible rather than merely present.
            if len(face) == 4 and len(edges) == 4:
                for a, c in ((0, 2), (1, 3)):
                    long_, short = max(edges[a][1], edges[c][1]), min(edges[a][1], edges[c][1])
                    if short > 1e-6 and long_ / short > 1.5:
                        taper = max(taper, long_ / short)
                        tapered += 1
        if density:
            rows.append((part, min(density), max(density), stretch, taper, tapered))
    return rows


def form(b, spec):
    """Crown ratio, crown spread and where the crown is widest, measured off the built sheets.

    The forestry definitions, so they line up with the ones `trees/_species.py` is written in: crown
    ratio is measured to the lowest live FOLIAGE rather than to the branch's attachment, and spread is
    a diameter through the stem rather than the axis-aligned box printed above — a crown has a finite
    number of branches, and the widest one needs a partner pointing the opposite way for a box to
    catch it.

    Returns the report lines and whether they matched. The bands are wide on purpose: the spec solves
    against the seed nine draws in ten stay inside, and the recipe builds ONE draw.
    """
    sheet = [i for part, lo, hi in b.parts if part in SHEET_PARTS for i in range(lo, hi)]
    if not sheet or not spec:
        return [], True
    pts = [b.verts[v] for i in sheet for v in b.faces[i]]
    top = max(v[2] for v in b.verts)
    height = top - min(v[2] for v in b.verts)
    base = min(p[2] for p in pts)
    widest = max(pts, key=lambda p: math.hypot(p[0], p[1]))
    ratio, spread = (top - base) / height, 2.0 * math.hypot(widest[0], widest[1]) / height
    up = (widest[2] - base) / (top - base)

    lines = [f'    form  crown {ratio:.0%} of height (spec {spec.crown_ratio:.0%}), '
             f'spread {spread:.2f} (spec {spec.spread_ratio:.2f}), widest {up:.0%} up the crown '
             f'(spec {spec.widest_at:.0%})']
    ok = True
    for label, got, want, band in (('crown ratio', ratio, spec.crown_ratio, 0.08),
                                   ('crown spread', spread, spec.spread_ratio, 0.15)):
        if abs(got - want) > band * max(want, 1e-6):
            lines.append(f'    WARN  built {label} {got:.2f} is more than {band:.0%} off the '
                         f'{want:.2f} its species asked for')
            ok = False
    return lines, ok


def recipes():
    """Every shared prop recipe."""
    found = {}
    roots = [HERE] + [os.path.join(HERE, d) for d in sorted(os.listdir(HERE))
                      if os.path.isdir(os.path.join(HERE, d))
                      and not d.startswith(('_', '.')) and d not in ('build', 'props')]
    for base in roots:
        for f in sorted(os.listdir(base)):
            if (f.endswith('.py') and not f.startswith('_')
                    and f not in TOOLS and not f.endswith('_atlas.py')):
                found[f[:-3]] = os.path.join(base, f)
    return found


def check(name, path):
    sys.modules.setdefault('bpy', types.ModuleType('bpy'))
    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    import _lib

    captured = {}

    def intercept(b, prop_name, tex, glb, roughness=0.92, closed=True, alpha=False, surfaces=None,
                  emitters=None, frames=0):
        captured.update(b=b, name=prop_name, tex=tex, glb=glb, closed=closed, alpha=alpha,
                        surfaces=list(surfaces or []), emitters=list(emitters or []), frames=frames)

    _lib.finish = intercept
    source = open(path, encoding='utf-8').read()
    if 'importlib.reload(_lib)' not in source:
        print(f'{name}: recipe does not contain the literal reload line; cannot intercept finish()')
        return False
    # __file__ is what a recipe derives its own ROOT from; without it every recipe raises NameError
    scope = {'__name__': '__main__', '__file__': path, '_lib': _lib}
    exec(compile(source.replace('importlib.reload(_lib)', 'pass'), path, 'exec'), scope)

    b = captured.get('b')
    if b is None:
        print(f'{name}: recipe never called finish()')
        return False

    inward = [i for i, f in enumerate(b.faces)
              if sum(x * y for x, y in zip(newell(b.verts, f), b.out[i])) <= 0.0]
    sheets = [i for part, lo, hi in b.parts if part in SHEET_PARTS for i in range(lo, hi)]
    down = [i for i in sheets if newell(b.verts, b.faces[i])[2] < -1e-9]
    v6 = _lib._raw_volume6(b.verts, b.faces)
    lo = [min(v[i] for v in b.verts) for i in range(3)]
    hi = [max(v[i] for v in b.verts) for i in range(3)]

    width = max((len(p[0]) for p in b.parts), default=4)
    print(f'{captured["name"]}  ({os.path.relpath(path, HERE)})')
    for part, a, c in b.parts:
        print(f'    {part.ljust(width)}  {sum(len(f) - 2 for f in b.faces[a:c]):5d}')
    print(f'    {"TOTAL".ljust(width)}  {b.tris():5d} tris, {len(b.verts)} verts, {len(b.faces)} faces')
    print(f'    bbox {hi[0] - lo[0]:.2f} W x {hi[1] - lo[1]:.2f} L x {hi[2] - lo[2]:.2f} H m, '
          f'base z={lo[2]:.2f}')

    ok = True
    if inward:
        print(f'    FAIL  {len(inward)} face(s) wound against their expected facing: {inward[:12]}')
        ok = False
    if down:
        print(f'    FAIL  {len(down)} sheet face(s) aim below horizontal (would ship dark): {down[:12]}')
        ok = False
    if captured['closed']:
        if v6 <= 0.0:
            print(f'    FAIL  raw volume {v6 / 6:+,.0f} cm^3 — stored winding would be inside-out')
            ok = False
        else:
            print(f'    ok    raw volume {v6 / 6:+,.0f} cm^3 (positive, as the importer requires)')
    else:
        print(f'    ok    open sheet; volume not judged. {len(sheets)} sheet faces, none aimed down')
    lines, matched = form(b, scope.get('SPECIES'))
    for line in lines:
        print(line)
    ok = ok and matched
    missing = [s['tex'] for s in [{'tex': captured['tex']}] + captured['surfaces']
               if not os.path.exists(s['tex'])]
    if missing:
        for path in missing:
            print(f'    WARN  atlas not painted yet: {path}')
        return ok

    for ordinal, spin in enumerate(b.spins):
        faces = sum(1 for s in b.face_spin if s == ordinal)
        parent = f', child of {spin["parent"]}' if spin.get('parent', -1) >= 0 else ''
        motion = (f'{spin["rps"]:+.2f} rev/s ({abs(spin["rps"]) * 60:.0f} rpm{parent})'
                  if spin['kind'] == 'spin' else
                  f'+/-{abs(spin["amplitude"]):.1f} deg every {spin["period"]:.2f}s '
                  f'({parent.lstrip(", ") or "root"})')
        print(f'    {spin["kind"]} {ordinal}    {faces} face(s) about {spin["axis"]} '
              f'at {spin["pivot"]}, {motion}')
        if not faces:
            # A rotation nothing is tagged for exports an empty node, and its clip turns nothing.
            print(f'    FAIL  rotation {ordinal} has no faces — use `with b.spin(...)` or `b.swing(...)`')
            ok = False
        if spin.get('parent', -1) >= ordinal:
            print(f'    FAIL  rotation {ordinal} parent must be an earlier ordinal')
            ok = False
    if b.spins and all(s >= 0 for s in b.face_spin):
        print('    FAIL  every face is inside a rotation — a prop needs a body to bolt the moving part to')
        ok = False

    for index, spec in enumerate(captured['surfaces'], start=1):
        faces = sum(1 for m in b.mats if m == index)
        scroll = spec.get('scroll')
        moving = f'scrolls {scroll[0]:+.2f}, {scroll[1]:+.2f} uv/s' if scroll else 'static'
        print(f'    surface {index}  {faces} face(s), {moving}, '
              f'{os.path.basename(spec["tex"])}')
        if not faces:
            # A surface no face is tagged for exports a material with nothing on it, and any effect
            # declared on it therefore animates nothing at all.
            print(f'    FAIL  surface {index} has no faces — use `with b.surface({index}):`')
            ok = False

    for index, spec in enumerate(captured['emitters']):
        f = spec['fields']
        # Back out of the native units so the line reads in the ones the recipe was written in. The
        # frame change is (-100x, +100y, +100z), so speed is just the magnitude over 100.
        speed = math.dist((0, 0, 0), (f['U18'], f['U19'], f['U20'])) / 100.0
        # `at` is stored in glTF's frame (x, z, -y of the recipe's own), so read it back the same way.
        at = spec['at']
        here = (at[0], -at[2], at[1])
        print(f'    emitter {index}  {f["U0"]:.0f} x {_lib.PARTICLE_SPRITES[int(f["U49"])]} at '
              f'({here[0]:+.2f}, {here[1]:+.2f}, {here[2]:+.2f}) m, {speed:.1f} m/s, '
              f'gravity {f["U32"] / 100.0:+.1f} m/s^2, life {f["U5"]:.1f}s')
        if not all(lo[k] - 0.5 <= here[k] <= hi[k] + 0.5 for k in range(3)):
            # An emitter floating clear of its own prop is nearly always a frame-conversion slip, and
            # it is invisible until someone places the prop and wonders where the snow is coming from.
            print(f'    FAIL  emitter {index} sits outside the prop\'s bounding box')
            ok = False

    size = png_size(captured['tex'])
    frames = int(captured.get('frames') or 0)
    if size and frames >= 2:
        # A flipbook page is a filmstrip of `frames` identical layouts, so what the UVs address — and what
        # the importer cuts out as a bank tile — is ONE band. Report and cost the band, not the strip.
        if size[1] % frames:
            print(f'    FAIL  a {frames}-frame page must divide evenly: {size[1]} px is not {frames} bands')
            ok = False
        size = (size[0], size[1] // frames)
    if size:
        rows = texels(b, min(size))
        strip = f'  ({frames} frames)' if frames >= 2 else ''
        print(f'    atlas {size[0]}x{size[1]}{strip}  cm/px on the art    stretch   taper')
        for part, lo_d, hi_d, stretch, taper, n in rows:
            note = f'   {taper:.1f}:1 across {n} face(s)' if n else ''
            print(f'    {part.ljust(width)}  {lo_d:6.2f} - {hi_d:6.2f}     {stretch:5.1f}:1{note}')
        if any(r[5] for r in rows):
            print('    note  a TAPERED face shears its UVs across the quad, and the exporter\'s\n'
                  '          triangulation kinks them at the diagonal. Horizontal art survives that,\n'
                  '          vertical art does not - give vertical art its own untapered face.')
    return ok


def main():
    known = recipes()
    names = sys.argv[1:] or sorted(known)
    unknown = [n for n in names if n not in known]
    if unknown:
        print(f'no such recipe: {", ".join(unknown)}\nknown: {", ".join(sorted(known))}')
        sys.exit(2)
    failed = [n for n in names if not check(n, known[n])]
    if failed:
        print(f'\n{len(failed)} recipe(s) failed: {", ".join(failed)}')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
