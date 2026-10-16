"""Actual player simulation and Vulkan output for all new riding-ring families."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from appearance_test import rgba
from desktop_collision_test import fixture, write
from desktop_rails_test import fixture as rail_fixture


def art(root):
    folder = root/'Textures'
    folder.mkdir(exist_ok=True)
    files = ['']*38
    # Original soft-dot fixtures, with enough alpha to expose compositing errors.
    pixels = []
    for y in range(16):
        for x in range(16):
            r2 = ((x+.5)/8-1)**2 + ((y+.5)/8-1)**2
            pixels += [255,255,255,round(max(0,1-r2)**2*255)]
    for i in [0,13,15,16,20]:
        files[i] = f'fx-{i}.png'
        (folder/files[i]).write_bytes(rgba(16,16,pixels))
    return dict(Schema='openslope-riding-effects/v1', Enabled=True, EmitterSprites=files)


def main():
    exe = str(Path(sys.argv[1]).resolve())
    with tempfile.TemporaryDirectory(prefix='openslope-riding-ring-') as temporary:
        base = Path(temporary)
        for name, surface in [('packed',1), ('powder',3), ('ice',5), ('metal',13), ('rail',13), ('takeoff',1)]:
            root = base/name
            if name == 'rail':
                rail_fixture(root)
            else:
                fixture(root, mass=0, draw=False)
                patches = json.loads((root/'Patches.json').read_text())
                patches['Patches'][0]['SurfaceType'] = surface
                write(root/'Patches.json', patches)
            profile = art(root)
            placement = dict(Position=[0,1.55 if name == 'rail' else -.005,0],
                             Forward=[0,0,-1], Velocity=[0,0,-18])
            steps = [dict(Ticks=18,Steer=.9 if name in ('packed','powder','ice') else 0)]
            if name == 'takeoff':
                steps = [dict(Ticks=1),dict(Ticks=24,Jump=True),dict(Ticks=8)]
            write(root/'replay.json', dict(Schema='openslope-replay/v1',Placement=placement,Steps=steps))
            captures, states, counts = [], [], []
            for enabled in [False,True]:
                profile['Enabled'] = enabled
                write(root/'RidingEffects.json',profile)
                output = root/f'{enabled}.ppm'
                result = subprocess.run([exe,'--map',str(root),'--replay',str(root/'replay.json'),'--capture',str(output),
                                         '--no-audio','--snow','0','--render-scale','100'],
                                        capture_output=True,text=True,timeout=90)
                assert result.returncode == 0,result.stdout+result.stderr
                state = re.search(r'position \[[^\]]+\]; velocity \[[^\]]+\]',result.stdout).group()
                states.append(state)
                ring = re.search(r'Surface spray: (\d+) slots; (\d+) chunks; (\d+) takeoff puffs; (\d+) sparks; (\d+) flares',result.stdout)
                assert ring,result.stdout
                groups,chunks,puffs,sparks,flares = map(int,ring.groups())
                assert groups<=40 and chunks<=2560 and sparks<=720,result.stdout
                if name in ('packed','powder','ice'):assert chunks>0 and sparks==0,result.stdout
                if name in ('metal','rail'):assert sparks>0 and chunks==0,result.stdout
                if name == 'rail':assert 'on rail 1' in result.stdout,result.stdout
                if name == 'takeoff':assert puffs>0 and 'launches 1' in result.stdout,result.stdout
                counts.append(int(re.search(r'World particles: \d+ emitters; (\d+) drawn sprites',result.stdout).group(1)))
                data = output.read_bytes().split(b'\n',3)
                assert data[:3] == [b'P6',b'1280 720',b'255']
                captures.append(data[3])
            assert states[0] == states[1],'Rendering the riding ring changed physics'
            changed = sum(a!=b for a,b in zip(*captures))
            assert counts[0] == 0 and counts[1]>0 and changed>10,(name,counts,changed)
            print(f'PASS: {name} riding ring ({counts[1]} submitted sprites; {changed} changed channels; unchanged player state)')


if __name__ == '__main__':
    main()
