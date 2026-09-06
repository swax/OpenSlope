"""
Rebuild every prop: paint all the atlases, then run every recipe through Blender.

    python Slopesmith/tools/prop-recipes/build_all.py                 # everything
    python Slopesmith/tools/prop-recipes/build_all.py --atlas-only    # no Blender needed
    python Slopesmith/tools/prop-recipes/build_all.py --blender "C:/.../blender.exe"
    python Slopesmith/tools/prop-recipes/build_all.py frosted_pine tall_pine

This is NOT a checkout bootstrap. `props/*.glb` is checked in precisely because rebuilding one needs
Blender, so a fresh clone already has every prop and never has to run this.

What it is for is the case that actually bites: a shared file changing under props that were built days
ago. Touch `_lib.py` and every GLB is stale; touch `conifer_atlas.py` and five conifers are, because a
GLB embeds its atlas at export time and nothing recomputes that later. There is no dependency graph
here — a prop is stale whenever anything upstream of it moved — so the honest answer is to rebuild the
lot, which takes seconds.

## Two interpreters, and why

The atlases need Pillow, which Blender's bundled Python does NOT have. The recipes need `bpy`, which
system Python does not have. So the halves genuinely cannot share a process: atlases run here, recipes
run in `blender --background`, and the two meet at a PNG on disk. That split is the whole reason the
pipeline is shaped the way it is, and it is why `--atlas-only` is worth having — art iteration is the
common case and it needs no Blender at all.

Blender is run once for all recipes rather than once each. Startup dominates the actual modelling, and
a single session also matches how these are normally driven (the blender MCP, with the app open), so a
recipe that only works because Blender happened to be freshly launched would be a lie.
"""

import argparse
import glob
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def atlases():
    """Every shared atlas beside the prop recipes."""
    return sorted(glob.glob(os.path.join(HERE, '*_atlas.py'))
                  + glob.glob(os.path.join(HERE, '*', '*_atlas.py')))


def find_blender(explicit=None):
    """Locate a Blender executable. Newest wins, because the glTF exporter is what writes the GLBs and
    an older one is the likelier to differ from whatever built the checked-in copies."""
    if explicit:
        if not os.path.isfile(explicit):
            raise SystemExit(f'--blender: no such file: {explicit}')
        return explicit
    found = []
    for root in (r'C:\Program Files\Blender Foundation', r'C:\Program Files (x86)\Blender Foundation',
                 '/Applications/Blender.app/Contents/MacOS', '/usr/bin', '/usr/local/bin'):
        found += glob.glob(os.path.join(root, '*', 'blender.exe'))
        found += glob.glob(os.path.join(root, 'blender.exe'))
        found += [p for p in glob.glob(os.path.join(root, 'blender')) if os.path.isfile(p)]
    if not found:
        raise SystemExit('no Blender found — pass --blender <path>, or use --atlas-only')
    # "Blender 5.10" must sort above "Blender 5.9", so compare the version numerically rather than
    # letting a plain string sort call 5.9 the newest.
    def version(path):
        name = os.path.basename(os.path.dirname(path))
        return [int(n) for n in ''.join(c if c.isdigit() else ' ' for c in name).split()]
    return sorted(found, key=version)[-1]


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('names', nargs='*', help='recipes to build (default: all)')
    ap.add_argument('--atlas-only', action='store_true', help='paint the atlases and stop; no Blender')
    ap.add_argument('--blender', help='path to blender.exe (default: newest installed)')
    args = ap.parse_args()

    sys.path.insert(0, HERE)
    from check import recipes                      # the single source of truth for what a recipe is

    todo = recipes()
    if args.names:
        unknown = [n for n in args.names if n not in todo]
        if unknown:
            raise SystemExit(f'unknown recipe(s): {", ".join(unknown)}\n'
                             f'known: {", ".join(sorted(todo))}')
        todo = {n: todo[n] for n in args.names}

    # Atlases first and ALWAYS all of them, even for a named subset: one page can serve a family
    # (`conifer.png` backs five trees), so painting only the named prop's atlas would leave a recipe
    # embedding a page that no longer matches its own script.
    print(f'painting {len(atlases())} atlases with {sys.executable}', flush=True)
    for a in atlases():
        r = subprocess.run([sys.executable, a], cwd=HERE)
        if r.returncode:
            raise SystemExit(f'atlas failed: {os.path.relpath(a, HERE)}')

    if args.atlas_only:
        print('\n--atlas-only: stopping before Blender')
        return

    blender = find_blender(args.blender)
    print(f'\nbuilding {len(todo)} recipes with {blender}', flush=True)
    # Recipes are exec'd with an explicit __file__ because each derives its own ROOT from it, and a
    # bare exec() defines no __file__ at all.
    script = 'import sys\n'
    for name, path in sorted(todo.items()):
        script += (f'p = {path!r}\n'
                   f'print("=== {name} ===")\n'
                   f'exec(open(p).read(), {{"__file__": p}})\n')
    r = subprocess.run([blender, '--background', '--factory-startup', '--python-expr', script],
                       cwd=HERE)
    if r.returncode:
        raise SystemExit(f'blender exited {r.returncode}')

    model_dirs = [os.path.join(HERE, 'props')]
    built = sorted((os.path.relpath(root, os.path.dirname(HERE)), f)
                   for root in model_dirs if os.path.isdir(root)
                   for f in os.listdir(root) if f.endswith('.glb'))
    print(f'\nmodel folders hold {len(built)} GLBs: '
          + ', '.join(f'{root}/{name}' for root, name in built))
    print('run check.py to validate, and `git status tools/prop-recipes/props` to see what moved')


if __name__ == '__main__':
    main()
