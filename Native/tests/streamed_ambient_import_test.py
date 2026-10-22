"""Approximate ambience uses source-owned placements and real sustain regions."""
import json
from pathlib import Path
import sys
import tempfile

from audio_scene_test import tone, write
from import_test import run
from riding_audio_import_test import hashes


def fixture(root, tour):
    write(root / 'Import.json', {'Game': 'ssx-on-tour' if tour else 'ssx-3'})
    names = {'CROWD': 'Crowd'} if not tour else {}
    write(root / 'Audio/SoundIndex.json', {'NamedBanks': names})
    banks = ['CROWD_MED_CHANT', 'EMTR_CHAIRLIFT', 'EMTR_FLAGRUSTLE'] if tour else ['Crowd', 'FlagWind_loop']
    for bank in banks:
        slot = 1 if tour else 0
        folder = root / 'Audio/SFX' / bank
        tone(folder / f'{slot:03}.wav', 300, 1)
        write(folder / 'bank.json', {'Slots': [None] * slot + [dict(LoopStart=0, LoopEnd=7999)]})
    rows = [dict(SourceResource=i, InstanceName=name) for i, name in enumerate([
        'crowdstand_a', 'crowdstand_b', 'flag_a', 'lifttower_a', 'unknown_a',
        'flag_b', 'crowdstand_c', 'crowdstand_authored', 'crowdstand_muted', 'crowdstand_one_entry'])]
    rows[7]['Sounds'] = {'CollisonSound': 99, 'ExternalSounds': []}
    rows[8]['IncludeSound'] = False
    write(root / 'Instances.json', {'Instances': rows})
    bindings = []
    for i, event in enumerate([57, 57, 91, 59, 70, 99, 99, 57, 57, 57]):
        bindings.append(dict(SourceResource=i, InstanceIndex=999, ExternalSounds=[
            dict(U0=3 if i == 9 else 0, SoundIndex=event, U2=123, U3=456, U4=789, U5=8000, U6=2)]))
    write(root / 'SoundBindings.json', dict(Schema='openslope-streamed-sound-bindings/v1',
          Game='ssx-on-tour' if tour else 'ssx-3', Bindings=bindings))


def main():
    importer = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-ambient-') as temporary:
        for tour in [False, True]:
            root = Path(temporary) / str(tour)
            fixture(root, tour)
            before = hashes(root)
            report = json.loads(run(importer, 'adapt-course-ambience', root))
            assert report['Fidelity'] == 'Approximate' and report['Emitters'] == (4 if tour else 3)
            rows = json.loads((root / 'Instances.json').read_text())['Instances']
            sound = rows[0]['Sounds']['ExternalSounds'][0]
            assert sound['SoundIndex'] == 57 and sound['Activation'] == 'Proximity'
            assert sound['SoundBank'] == 'openslope_ambient' and sound['U2'] == 123
            assert rows[0]['Sounds']['CollisonSound'] == -1 and rows[0]['IncludeSound']
            assert 'Sounds' not in rows[4] and 'Sounds' not in rows[5] and 'Sounds' not in rows[6]
            assert rows[7]['Sounds']['CollisonSound'] == 99 and not rows[8]['IncludeSound']
            assert 'Sounds' not in rows[9], 'One-entry records must stay deferred'
            for path, digest in before.items():
                if path != 'Instances.json': assert hashes(root)[path] == digest, path
            after = hashes(root)
            run(importer, 'adapt-course-ambience', root)
            assert hashes(root) == after
        root = Path(temporary) / 'bad'
        fixture(root, True)
        write(root / 'Audio/SFX/CROWD_MED_CHANT/bank.json', {'Slots': [None, {'LoopEnd': 999999}]})
        before = hashes(root)
        run(importer, 'adapt-course-ambience', root, succeeds=False)
        assert hashes(root) == before, 'Invalid source must not change the map'
    print('PASS: ambience placement identity, loop admission, authored/muted preservation, ties, idempotence and failure atomicity')


if __name__ == '__main__':
    main()
