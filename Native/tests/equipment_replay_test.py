"""Exercise shared grip/trigger input through the production desktop Vulkan host."""
import copy
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from desktop_collision_test import fixture, write


def equipment(grip=(False, False), trigger=(False, False), x=-.4, relative=False, tracked=True):
    hand = dict(Position=[x, 1.35, -.2], Right=[0, 1, 0], Up=[0, 0, -1], Forward=[1, 0, 0])
    return dict(Tracked=tracked, Relative=relative, Head=[0, 1.65, 0], Facing=[0, 0, -1],
                Hands=[copy.deepcopy(hand), copy.deepcopy(hand)], Grip=list(grip), Trigger=list(trigger))


def main():
    exe = Path(sys.argv[1]).resolve()
    output = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else None
    if output:
        output.mkdir(parents=True, exist_ok=True)
    held = equipment(grip=(False, True))
    passed = equipment(grip=(True, True))
    left = equipment(grip=(True, False))
    throw = [dict(Ticks=1, Equipment=equipment(grip=(False, True), x=-.4+i*.025)) for i in range(20)]
    desktop = equipment(grip=(False, True), relative=True, tracked=False, x=.2)
    desktop['Rays'] = [dict(Origin=[.7, 2, 0], Direction=[0, -1, 0], Valid=False),
                       dict(Origin=[.7, 2, 0], Direction=[0, -1, 0])]
    summon = equipment(grip=(False, True), relative=True)
    summon['Hands'][1]['Position'] = [0, 1.7, .3]
    air = equipment(grip=(False, True))
    for h in air['Hands']:
        h['Position'][1] = 7.1
    air['Head'] = [0, 7.65, 0]
    air_mount = copy.deepcopy(air)
    air_mount['Trigger'][1] = True
    aimed = equipment(trigger=(False, True))
    aimed['Rays'] = [dict(Origin=[0, 2, 0], Direction=[0, -1, 0], Valid=False),
                     dict(Origin=[0, 2, 0], Direction=[0, -1, 0])]
    cases = [
        ('quest-hold', True, [dict(Ticks=12, Equipment=held)], True, 1, False, 1),
        ('quest-transfer', True, [dict(Ticks=2, Equipment=held), dict(Ticks=1, Equipment=passed),
                                dict(Ticks=2, Equipment=left)], True, 1, False, 0),
        ('quest-throw', True, [dict(Ticks=1, Equipment=held)] + throw +
                            [dict(Ticks=4, Equipment=equipment(x=.1))], False, 1, True, -1),
        ('desktop-carry', True, [dict(Ticks=20, Equipment=desktop)], True, 1, False, 1),
        ('aimed-mount-held', True, [dict(Ticks=12, Equipment=aimed)], False, 0, False, -1),
        ('summon', True, [dict(Ticks=90, Posture=1), dict(Ticks=2, Equipment=summon)], True, 1, False, 1),
        ('air-re-equip', False, [dict(Ticks=1, Equipment=air), dict(Ticks=1, Equipment=air_mount)], False, 0, False, -1),
    ]
    with tempfile.TemporaryDirectory(prefix='openslope-equipment-render-') as temporary:
        base = Path(temporary)
        for name, on_foot, steps, carrying, foot, thrown, hand in cases:
            root = base / name
            fixture(root, mass=0, draw=False)
            replay = root / 'input.json'
            capture = (output / (name + '.ppm')) if output else (root / 'frame.ppm')
            placement = dict(Position=[0, 6, 0], Forward=[0, 0, -1], Velocity=[0, 1, -30]) if name == 'air-re-equip' else dict(Position=[0, 0, 0], Forward=[0, 0, -1])
            write(replay, dict(Schema='openslope-replay/v1', Placement=placement, Steps=steps))
            args = [str(exe), '--map', str(root), '--replay', str(replay), '--capture', str(capture)]
            if on_foot:
                args.append('--on-foot')
            result = subprocess.run(args, capture_output=True, text=True, timeout=90)
            assert result.returncode == 0, result.stdout + result.stderr
            assert f'Equipment: held {int(carrying)}; hand {hand}; thrown {int(thrown)}' in result.stdout, result.stdout
            assert f'Boarding: on foot {foot}' in result.stdout, result.stdout
            if name == 'quest-throw':
                velocity = re.search(r'Equipment:.*velocity \[([^]]+)\]', result.stdout)[1]
                assert float(velocity.split(',')[0]) > 1, result.stdout
            if name == 'air-re-equip':
                velocity = re.search(r'position \[([^]]+)\]; velocity \[([^]]+)\]', result.stdout)[2]
                assert abs(float(velocity.split(',')[2]) + 30) < .01, result.stdout
            data = capture.read_bytes().split(b'\n', 3)
            assert data[:3] == [b'P6', b'1280 720', b'255'] and len(data[3]) == 1280 * 720 * 3
            if output:
                (output / (name + '.log')).write_text(result.stdout + result.stderr)
            print(f'PASS: {name} ({sum(step["Ticks"] for step in steps)} production frames)')


if __name__ == '__main__':
    main()
