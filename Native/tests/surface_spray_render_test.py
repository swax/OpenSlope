"""Independent colour-coded art verifies riding-ring registration on a real GPU."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from appearance_test import rgba


def fixture(root):
    root.mkdir(parents=True,exist_ok=True)
    textures = root/'Textures'
    textures.mkdir(exist_ok=True)
    names = ['']*38
    for index, colour in {0:[255,255,255],13:[128,64,255],15:[0,255,255],16:[255,0,0],20:[0,255,0]}.items():
        names[index] = f'isolated-{index}.png'
        (textures/names[index]).write_bytes(rgba(1,1,colour+[255]))
    (root/'RidingEffects.json').write_text(json.dumps(dict(Schema='openslope-riding-effects/v1',EmitterSprites=names)))


if __name__ == '__main__':
    with tempfile.TemporaryDirectory(prefix='openslope-surface-gpu-') as temporary:
        root = Path(temporary)
        fixture(root)
        subprocess.run([str(Path(sys.argv[1]).resolve()),str(root)],check=True)
