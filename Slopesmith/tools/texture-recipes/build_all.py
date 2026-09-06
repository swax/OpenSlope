"""
Repaint every snow tile, and optionally install them where the editor can see them.

    python Slopesmith/tools/texture-recipes/build_all.py                # everything, into build/
    python Slopesmith/tools/texture-recipes/build_all.py --install MY_PROJECT  # ...and into a project's assets/textures
    python Slopesmith/tools/texture-recipes/build_all.py powder

Unlike `prop-recipes/build_all.py` this really is a checkout bootstrap, and that is the whole reason
nothing here is committed. A prop's GLB is checked in because rebuilding one needs a multi-gigabyte
Blender that is usually not on PATH; a snow tile needs numpy and Pillow and comes back byte-identical
from any checkout in under a second, so a copy in git would only be a second source of truth to drift.

## --install

`--install PROJECT` copies into that workspace mountain's `assets/textures/`, which the editor presents as
the open mountain's named entry. The compact document ref remains `Custom/<name>.png`, but it resolves only inside the open
project. Workspace data is git-ignored, which is exactly why the recipe is the artifact worth keeping and the
PNG is not.

It writes over a tile of the same name, which the editor's own upload path deliberately never does:
uploading `powder.png` twice gives you `powder_2.png` so that no cell's art can change under it. Here
that protection would be backwards. A recipe is edited and re-run a dozen times before it is right,
and every run is meant to replace what the last one wrote - a fresh name each time would leave the
mountain wearing the first attempt and the folder full of `powder_7.png`. So settle a tile in `build/`
first, and install when it is worth painting with.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP_ROOT = os.path.dirname(os.path.dirname(HERE))


def project_textures(wanted):
    configured = {}
    try:
        with open(os.path.join(APP_ROOT, '.slopesmith', 'config.json'), encoding='utf8') as stream:
            configured = json.load(stream)
    except (OSError, ValueError):
        pass
    workspace = os.environ.get('SLOPESMITH_WORKSPACE_ROOT') or configured.get('workspaceRoot') \
        or os.path.join(APP_ROOT, 'workspace')
    if not os.path.isabs(workspace):
        workspace = os.path.abspath(os.path.join(APP_ROOT, workspace))
    matches = []
    projects = os.path.join(workspace, 'projects')
    for folder in os.listdir(projects) if os.path.isdir(projects) else []:
        manifest_path = os.path.join(projects, folder, 'project.json')
        try:
            with open(manifest_path, encoding='utf8') as stream:
                manifest = json.load(stream)
        except (OSError, ValueError):
            continue
        if wanted.lower() in (str(manifest.get('id', '')).lower(), str(manifest.get('name', '')).lower()):
            matches.append(os.path.join(projects, folder, 'assets', 'textures'))
    if len(matches) != 1:
        raise SystemExit(f'--install needs one workspace project named {wanted!r}; found {len(matches)}')
    return matches[0]


def main():
    ap = argparse.ArgumentParser(description=__doc__.strip().splitlines()[0])
    ap.add_argument('names', nargs='*', help='recipes to build (default: all)')
    ap.add_argument('--install', metavar='PROJECT',
                    help='copy built tiles into PROJECT/assets/textures, overwriting by name')
    args = ap.parse_args()

    sys.path.insert(0, HERE)
    from check import recipes                    # the single source of truth for what a recipe is

    todo = recipes()
    if args.names:
        unknown = [n for n in args.names if n not in todo]
        if unknown:
            raise SystemExit(f'unknown recipe(s): {", ".join(unknown)}\n'
                             f'known: {", ".join(sorted(todo))}')
        todo = {n: todo[n] for n in args.names}

    # One subprocess each. They are independent - no shared page, no shared process state - and a
    # recipe that only worked because another had run first would be a bug worth surfacing.
    print(f'painting {len(todo)} tiles with {sys.executable}', flush=True)
    for name, path in sorted(todo.items()):
        if subprocess.run([sys.executable, path], cwd=HERE).returncode:
            raise SystemExit(f'recipe failed: {os.path.relpath(path, HERE)}')

    built = sorted(f for f in os.listdir(os.path.join(HERE, 'build'))
                   if f.endswith('.png') and not f.startswith('_'))
    if not args.install:
        print(f'\nbuild/ holds {len(built)} tiles: {", ".join(built)}')
        print('run check.py to validate, --install to paint with them')
        return

    destination = project_textures(args.install)
    os.makedirs(destination, exist_ok=True)
    for f in built:
        shutil.copyfile(os.path.join(HERE, 'build', f), os.path.join(destination, f))
    print(f'\ninstalled {len(built)} tiles into {destination}')
    print("they show in the Asset Library under the open mountain's name (uncheck \"hide unused\")")


if __name__ == '__main__':
    main()
