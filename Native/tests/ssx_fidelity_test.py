"""Original authored SSX render/effect/audio records through the shared importer."""
import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
from ssx_import_test import members, raw_disc, gem_members
from import_test import big, ssh, run
from audio_import_test import archive, disc
from audio_container_test import bank, stream
from board_groups_fixture import boot_program


def frame(main, payload):
    return struct.pack('<HH', main, 4 + len(payload)) + payload


def image_bank(names):
    image = ssh()[32:]
    start = 16 + len(names) * 8
    return (b'SHPS' + struct.pack('<II', start + len(image) * len(names), len(names)) + b'TEST'
            + b''.join(name.encode() + struct.pack('<I', start + i * len(image)) for i, name in enumerate(names))
            + image * len(names))


def fixture():
    files = members()
    index = bytearray(files['world.wdx'])
    struct.pack_into('<I', index, 56, 1)
    index = index[:88] + struct.pack('<I8H', 2, 0, 1, 0, 0, 0, 0, 0, 0) + struct.pack('<IhhI', 0x69, 0, 0, 0x80808080)
    files['world.wdx'] = bytes(index)
    files['world.ssh'] = image_bank(['fr00', 'fr01'])
    law = [0.] * 51
    law[0], law[3], law[4], law[5] = 10, 1., 100., 1.
    emitter = struct.pack('<3I47f2I', 0, int(law[0]), int(law[1]), *law[2:49], 0, 1)
    graphs = [
        frame(0, struct.pack('<IIIff', 11, 0, 0, 7., 0.))
        + frame(6, struct.pack('<3I', 0, 0, 1)) + frame(7, struct.pack('<I', 0)),
        frame(1, emitter),
        frame(0, struct.pack('<I', 999)) + frame(0, struct.pack('<II5f', 10, 0, .01, 0, 1, 0, 0)),
    ]
    fx = bytearray(struct.pack('<ff8I', 1.01, .0003, 1, 40, 0, 68, 0, 68, 3, 68))
    fx += struct.pack('<7i', 0, -1, -1, -1, -1, -1, -1)
    cursor = 0
    for count, graph in zip([3, 1, 2], graphs):
        fx += struct.pack('<II', count, cursor)
        cursor += len(graph)
    files['world.wfx'] = bytes(fx) + b''.join(graphs)
    # Functional registration tags, read from original disc data. This fixture
    # deliberately puts image pages in a different order from the registration.
    tags = 'part snfl clod spry halo brk1 brk2 brk3 ndl1 ndl2 swd1 swd2 swp1 swp2 cnf1 cnf2 blb1 blb2 str1 str2 str3 nois strk tral ex06 ex07 ex08 ex09 lens blnk mip1 mip1 mip2 beam'.split()
    elf = boot_program()
    elf += bytes(-len(elf) % 4) + b''.join(tag.encode() + bytes(8) for tag in tags)
    assets = {'DATA/MODELS/FIXTURE.BIG': big(files, compact=False),
              'AUTHORED.ELF': elf,
              'SYSTEM.CNF': b'BOOT2 = cdrom0:\\AUTHORED.ELF;1\r\n',
              'DATA/TEXTURES/PARTICLE.SSH': image_bank(sorted(set(tags))),
              'DATA/CONFIG/BANKS.INF': b'[FIXTURE]\nMAIN=main.bnk\nBANK=course.bnk\nCROWD=crowd.bnk\nSWAP=wind.bnk\n',
              'DATA/CONFIG/INTROMUS.INF': b'[FIXTURE]\nSONG=intro.big\n',
              'DATA/AUDIO/AUDIO.BIG': archive({name: bank() for name in ['main.bnk', 'course.bnk', 'crowd.bnk', 'wind.bnk']}),
              'DATA/AUDIO/INTRO.BIG': archive({'auth-C1': stream(), 'auth-C2': stream()}),
              }
    return assets


def main():
    if sys.argv[1] == '--fixture':
        Path(sys.argv[2]).write_bytes(disc(fixture()))
        return
    if sys.argv[1] == '--gem-fixture':
        Path(sys.argv[2]).write_bytes(disc({'DATA/MODELS/FIXTURE.BIG': big(gem_members(), compact=False)}))
        return
    cli = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-ssx-fidelity-') as temporary:
        root = Path(temporary)
        authored = disc(fixture())
        for tier in (2, 3, 5):
            files = gem_members(tier)
            image = disc({'DATA/MODELS/FIXTURE.BIG': big(files, compact=False)})
            for extension, data in [('iso', image), ('bin', raw_disc(image))]:
                source = root / f'gem-{tier}.{extension}'
                source.write_bytes(data)
                run(cli, 'extract', source, 'SSX_FIXTURE', root / f'gem-{tier}-{extension}')
                output = root / f'gem-{tier}-{extension}/SSX_FIXTURE'
                model = json.loads((output / 'Models.json').read_text())['Models'][0]
                assert model['ModelName'] == f'SSX_Gem_Multiplierx{tier} (Model 0)'
                assert model['SourceModelName'] == 'Model 0' and model['AnimTime'] == 60
                obj = model['ModelObjects'][0]
                assert obj['IncludeAnimation'] and obj['Animation']['AnimationAction'] == 17
                channels = obj['Animation']['AnimationEntries']
                assert len(channels) == 2
                translation = channels[0]['AnimationMaths'][0]
                assert translation['Value3'] == 7.5 and translation['Value6'] == 2
                curves = channels[1]['AnimationMaths']
                assert len(curves) == 2
                curve = curves[1]
                assert abs(curve['Value3'] - 90) < .001 and curve['Value6'] == 2
                row = json.loads((output / 'Instances.json').read_text())['Instances'][0]
                assert row['InstanceName'] == f'Gem x{tier} (Instance 0)' and row['LTGState'] == 2
                assert row['SourceInstanceName'] == 'Instance 0' and row['ModelID'] == 0
                effects = json.loads((output / 'Effects.json').read_text())
                assert effects['graphs'][1]['nodes'][0]['payload']['MultiplierScore'] == tier
                law = effects['graphs'][0]['nodes'][0]['payload']['type0']['type0Sub256']
                assert law['U0'] == 1 and law['U7'] == 3 and law['U3'] == 30
                assert (output / 'Source/WORLD.WDR').read_bytes() == files['world.wdr']
                if len(sys.argv) > 2:
                    run(Path(sys.argv[2]).resolve(), output, '--gem', 0, tier)
        for extension, data in [('iso', authored), ('bin', raw_disc(authored))]:
            source = root / ('fixture.' + extension)
            source.write_bytes(data)
            digest = hashlib.sha256(data).digest()
            run(cli, 'extract', source, 'SSX_FIXTURE', root / extension)
            output = root / extension / 'SSX_FIXTURE'
            material = json.loads((output / 'Materials.json').read_text())['Materials'][0]
            assert material['SSXRenderFlags'] == 0x69 and material['AlphaMode'] == 'cutout'
            assert material['UnknownInt18'] == 0x40000
            assert material['TextureFlipbook'] == ['0000.png', '0001.png']
            effects = json.loads((output / 'Effects.json').read_text())
            assert [n['mainType'] for n in effects['graphs'][0]['nodes']] == [0, 7, 8]
            assert effects['graphs'][0]['nodes'][0]['payload']['type0']['TextureFlip']['Speed'] == 7
            assert effects['graphs'][1]['nodes'][0]['mainType'] == 2
            assert effects['graphs'][2]['nodes'] == []  # unknown condition blocks the whole chain
            assert len(effects['graphs'][2]['extensions']['ssxUnresolvedNodes']) == 2
            assert len(effects['graphs'][0]['extensions']['ssxNativeNodes']) == 3
            sprites = json.loads((output / 'RidingEffects.json').read_text())
            assert sprites['SourceExecutable'] == 'AUTHORED.ELF'
            assert sprites['EmitterSprites'][0] == 'Particles/part.png'
            assert sprites['EmitterSprites'][30] == sprites['EmitterSprites'][31] == 'Particles/mip1.png'
            assert (output / 'Textures/Particles/snfl.png').is_file()
            sound = json.loads((output / 'Audio/SoundIndex.json').read_text())
            assert sound['Banks'] == {'0': 'main', '1': 'main', '2': 'course', '3': 'crowd'}
            assert sound['SwapBanks'] == ['wind'] and sound['CollisionEvents'] == {}
            assert (output / 'Audio/SFX/main/000.wav').is_file() and (output / 'Audio/Intro/auth-C1.wav').is_file()
            assert len(json.loads((output / 'Audio/BoardSoundIndex.json').read_text())['SurfaceGroups']) == 20
            assert 'audio-assets' not in json.loads((output / 'Import.json').read_text())['Deferred']
            if len(sys.argv) > 2:
                run(Path(sys.argv[2]).resolve(), output)
            assert hashlib.sha256(source.read_bytes()).digest() == digest
        # Resolve the configured boot path rather than guessing a root filename.
        assets = fixture()
        assets['BOOT/SPRITES.ELF'] = assets.pop('AUTHORED.ELF')
        assets['AUTHORED.ELF'] = b'not the configured executable'
        assets['SYSTEM.CNF'] = b'BOOT2 = cdrom0:\\BOOT\\SPRITES.ELF;1\r\n'
        source = root / 'nested-boot.iso'
        source.write_bytes(disc(assets))
        run(cli, 'extract', source, 'SSX_FIXTURE', root / 'nested')
        sprites = json.loads((root / 'nested/SSX_FIXTURE/RidingEffects.json').read_text())
        assert sprites['SourceExecutable'] == 'SPRITES.ELF'
        assert sprites['EmitterSprites'][0] == 'Particles/part.png'
        # A reference failure aborts atomically, rather than publishing part of a chain.
        assets = fixture()
        files = members()
        fx = bytearray(files['world.wfx'])
        fx[68:] = struct.pack('<2I', 1, 0) + frame(6, struct.pack('<3I', 0, 9, 0))
        files['world.wfx'] = bytes(fx)
        assets['DATA/MODELS/FIXTURE.BIG'] = big(files, compact=False)
        source = root / 'bad.iso'
        source.write_bytes(disc(assets))
        run(cli, 'extract', source, 'SSX_FIXTURE', root / 'failed', succeeds=False)
        assert not list((root / 'failed').iterdir())
    print('PASS: original SSX gem animation/collection/labels, alpha, flipbooks, particles, audio, raw BIN parity and atomic failure')


if __name__ == '__main__':
    main()
