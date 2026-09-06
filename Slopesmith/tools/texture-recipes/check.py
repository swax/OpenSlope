"""
Validate a texture recipe without writing anything.

    python Slopesmith/tools/texture-recipes/check.py powder
    python Slopesmith/tools/texture-recipes/check.py            # every recipe

It runs the recipe with `_texture.finish` and `_texture.preview` intercepted, so nothing lands in `build/`,
and prints what the page measured beside the envelope the shipped levels' own snow measures. Two
kinds of line come out of it:

  FAIL  a guard in `_texture.guards` — a claim a terrain tile has to be able to make, and every one of
        them catches something that is invisible on the page and obvious on the mountain.
  .     a number outside the shipped envelope. NOT a failure. That envelope is the min and max of
        ten pages, so both edges are single samples and a recipe can sit just outside one honestly.
        `powder` does, twice, and both are the palette quantiser rather than the art.

The bands table at the end is the loop worth running: the recipe asks for a share of its variation at
each feature size and the page comes out somewhere near it, because the log-normal band lobes overlap
by design. Read the two rows together and move the asked-for numbers until the measured ones sit where
the shipped page does.
"""

import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import _texture                                                                  # noqa: E402

# Scripts that live beside the recipes and are not recipes. Named rather than sniffed, because the
# rule below is "any .py that is not obviously something else" - a new tool dropped at the root is
# otherwise picked up and run as a recipe, and fails as one.
TOOLS = ('check.py', 'measure.py', 'build_all.py')


def recipes():
    """Every shared texture recipe."""
    found = {}
    roots = [HERE] + [os.path.join(HERE, d) for d in sorted(os.listdir(HERE))
                      if os.path.isdir(os.path.join(HERE, d))
                      and not d.startswith(('_', '.')) and d != 'build']
    for base in roots:
        for f in sorted(os.listdir(base)):
            if f.endswith('.py') and not f.startswith('_') and f not in TOOLS:
                found[f[:-3]] = os.path.join(base, f)
    return found


def run(path):
    """Execute a recipe, capturing the page it would have written instead of writing it.

    It also follows the bands each `field()` was asked for through whatever `mix()` did with them, so
    the asks/measures comparison works on a recipe of any shape - one field, or three at different
    shares - without the recipe naming its band lists anything in particular.
    """
    captured = {}
    bands_of = {}                   # id(field array) -> the bands it was built from
    asked = []                      # (bands, share of the finished tile)
    saved = _texture.finish, _texture.preview, _texture.field, _texture.mix

    def field(seed, bands, **kw):
        out = saved[2](seed, bands, **kw)
        bands_of[id(out)] = bands
        return out

    def mix(*parts):
        total = sum(share for _, share in parts) or 1.0
        asked.extend((bands_of[id(f)], share / total) for f, share in parts if id(f) in bands_of)
        return saved[3](*parts)

    _texture.finish = (lambda rgb, name, out, family='snow':
                       captured.update(rgb=rgb, name=name, out=out, family=family) or rgb)
    _texture.preview = lambda *a, **k: None
    _texture.field, _texture.mix = field, mix
    try:
        exec(compile(open(path, encoding='utf-8').read(), path, 'exec'),
             {'__name__': '__main__', '__file__': path})
    finally:
        _texture.finish, _texture.preview, _texture.field, _texture.mix = saved
    # A recipe that never mixed used its one field whole.
    if not asked and len(bands_of) == 1:
        asked.append((next(iter(bands_of.values())), 1.0))
    return captured, asked


def envelope(label, value, low, high, fmt='{:.2f}'):
    """One measurement against the shipped range. A dot marks outside; nothing marks inside."""
    mark = ' .' if not low <= value <= high else ''
    return (f'    {label.ljust(11)} {fmt.format(value).rjust(18)}   '
            f'shipped {fmt.format(low)} - {fmt.format(high)}{mark}')


def check(name, path):
    captured, asked = run(path)
    if 'rgb' not in captured:
        print(f'{name}: recipe never called _texture.finish()')
        return False

    a = np.asarray(captured['rgb'])
    m = _texture.measure(a)
    print(f'{captured["name"]}  ({os.path.relpath(path, HERE)})')
    # `finish` writes RGBA whatever the recipe hands it, so there is no RGB/RGBA distinction to
    # report here - what varies is whether any of that alpha is under 255, and the guards cover it.
    # The family is printed rather than assumed: it is the one claim a recipe makes about itself
    # instead of about its pixels, and it decides which warmth bound the guards hold it to.
    family = captured.get('family', 'snow')
    print(f'    {a.shape[1]}x{a.shape[0]} opaque, one tile = {_texture.METRES:.0f} m at '
          f'{_texture.CM_PER_PX:.0f} cm/px, {m["colours"]} colours, {family} family')
    print(f'    {"mean RGB".ljust(11)} {str(m["mean"].round(0)).rjust(18)}   '
          f'shipped {_texture.RETAIL["mean R"][0]}-{_texture.RETAIL["mean R"][1]} '
          f'{_texture.RETAIL["mean G"][0]}-{_texture.RETAIL["mean G"][1]} '
          f'{_texture.RETAIL["mean B"][0]}-{_texture.RETAIL["mean B"][1]}')
    print(envelope('grain', m['grain'], *_texture.RETAIL['grain'], fmt='{:.1f}'))
    print(envelope('skew', m['skew'], *_texture.RETAIL['skew']))
    print(envelope('colours', m['colours'], *_texture.RETAIL['colours'], fmt='{:.0f}'))
    print(envelope('axis share', m['axis share'], *_texture.RETAIL['axis share']))
    print(envelope('seam u', m['seam'][0], *_texture.RETAIL['seam']))
    print(envelope('seam v', m['seam'][1], *_texture.RETAIL['seam']))
    # No envelope on these two: they are what a recipe is CHOOSING, not a bar it has to clear. 1.00
    # is directionless, which is what open snow should be, and the shipped open pages' 0.4-0.7 is a
    # property of the photographs they were made from rather than of snow. Only the streaked
    # family's numbers are ones to answer to.
    print(f'    {"direction".ljust(11)} {m["aniso"]:18.2f}   '
          'shipped 0.4-0.7 open, 2.8-4.0 streaked')
    print(f'    {"streaks".ljust(11)} {m["streaks"]:17.1f}%   '
          'shipped 1-5% open, 29-40% tracked')

    keys = sorted(m['octaves'], reverse=True)
    print('\n    where it varies  ' + ' '.join(f'{lo:>4.1f}-{hi:.1f}m' for lo, hi in keys))
    if asked:
        wanted = {k: 0.0 for k in keys}
        covered = 0.0
        for bands, weight in asked:
            total = sum(s for _, s in bands) or 1.0
            covered += weight
            for size_m, share in bands:
                near = min(keys, key=lambda k: abs(np.log(size_m / ((k[0] * k[1]) ** 0.5))))
                wanted[near] += 100.0 * weight * share / total
        print('    recipe asks      ' + ' '.join(f'{wanted[k]:8.1f}%' for k in keys))
        if covered < 0.995:
            # `grooves` has no band - it is drawn, not filtered - so a recipe that uses one asks for
            # less than the whole page and the shortfall is exactly that drawn share.
            print(f'    {"":16} (the other {100 * (1 - covered):.0f}% is drawn, not banded)')
    print('    page measures    ' + ' '.join(f'{m["octaves"][k]:8.1f}%' for k in keys))

    fails = _texture.guards(a, family)
    print()
    for f in fails:
        print(f'    FAIL  {f}')
    if not fails:
        print('    ok    every guard passed')
    return not fails


def main():
    known = recipes()
    names = sys.argv[1:] or sorted(known)
    unknown = [n for n in names if n not in known]
    if unknown:
        print(f'no such recipe: {", ".join(unknown)}\nknown: {", ".join(sorted(known))}')
        sys.exit(2)
    failed = []
    for i, n in enumerate(names):
        if i:
            print()
        if not check(n, known[n]):
            failed.append(n)
    if failed:
        print(f'\n{len(failed)} recipe(s) failed: {", ".join(failed)}')
    sys.exit(1 if failed else 0)


if __name__ == '__main__':
    main()
