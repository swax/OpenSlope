"""Independent clips shared by three source layouts, plus atomic rejection."""
import json
from pathlib import Path
import struct
import sys
import tempfile

from import_test import run
import ssx3_import_test as retail
import ssx3_beta_import_test as beta
import ontour_import_test as tour


def animated_model(data, damage=None):
    b = bytearray(data)
    table = len(b)
    struct.pack_into('<II', b, 4, 2, table)
    struct.pack_into('<f', b, 20, 0 if damage == 'pose' else -1 if damage == 'duration' else 1.25)
    b += bytes(32)
    for part in range(2):
        p = len(b)
        struct.pack_into('<4i', b, table + part * 16, part - 1, 64, p, -1)
        # Full model-relative pointer chain, with a fractional-frame duration.
        b += struct.pack('<6fIII', part * 25, 0, 0, 0, 0, 0, 4, 1, p + 36)
        b += struct.pack('<III6f', p + 40, 1, p + 48, 0, 0, 0 if damage == 'pose' else 100, -10, 0,
                         0 if damage == 'pose' else 1.25)
        if damage and damage not in ['pose', 'duration']:
            offset, value = {'mask': (24, 64), 'count': (28, 2), 'table': (32, 0xffffffff),
                             'channel': (36, 0xffffffff), 'segments': (40, 100001),
                             'curves': (44, 0xffffffff), 'nan': (48, 0x7fc00000),
                             'window': (68, 0xbf800000)}[damage]
            struct.pack_into('<I', b, p + offset, value)
    return bytes(b)


def fixture(game, name, damage=None):
    def edit(rows):
        # The independent motion fixture has no source collision geometry;
        # its admitted collectible adapter supplies a common contact box.
        return [(kind, rid, animated_model(data, damage) if kind == 2 else data, *tail)
                for kind, rid, data, *tail in rows if kind != 12]
    if game == 'beta':
        return beta.preview_disc(world_edit=edit, model_name=name)
    if game == 'tour':
        files = tour.members(edit)
        files['data/worlds/bam.phm'], files['data/worlds/bam.psm'] = tour.names(model_name=name)
        return tour.disc(files)
    files = retail.members(edit)
    files['data/worlds/bam.phm'], files['data/worlds/bam.psm'] = retail.names(model_rows=[(1, name)])
    return retail.disc(files)


def collision_section(preview=False, unknown=False):
    b = bytearray(92)
    struct.pack_into('<II', b, 0, 4096, 13824 if preview else 14336)
    start = len(b)
    for canopy in [4 if unknown else 0, 3]:
        b += struct.pack('<4I', 1, 0x00210000, 0xffffffff, 1)
        b += struct.pack('<ffHH', 1e30, 0, 3, 65535)
        b += struct.pack('<ffHH', 1e30, 0, canopy, 65535)
    mapping = len(b)
    b += struct.pack('<2H', 0, 1)
    table = len(b)
    b += struct.pack('<2I', 0, 40)
    struct.pack_into('<5I', b, 64, start, 2, mapping, 2, table)
    return bytes(b)


def collision_fixture(game, unknown=False):
    def edit(rows):
        result = []
        for kind, rid, data in rows:
            if kind == 2:
                data = animated_model(data)
            if kind == 12:
                first = retail.proxy()[16:]
                second = bytearray(first)
                for i in range(3):
                    x, y, z, w = struct.unpack_from('<4f', second, 32 + i * 16)
                    struct.pack_into('<4f', second, 32 + i * 16, x + 400, y, z + 300, w)
                data = struct.pack('<HHIII', 1, 2, 16, 16 + len(first) + len(second), 16 + len(first) + len(second))
                data += first + second
            if kind == 16:
                data = collision_section(game == 'beta', unknown)
            result.append((kind, rid, data))
        return result
    if game == 'beta':
        return beta.preview_disc(world_edit=edit, model_name='mdl_ARA1_compound_fixture')
    return retail.disc(retail.members(edit))


def check_map(path, collectible, boost=False):
    model, = json.loads((path / 'Models.json').read_text())['Models']
    assert model['AnimTime'] == 37.5
    assert [o['ParentID'] for o in model['ModelObjects']] == [-1, 0]
    for part, obj in enumerate(model['ModelObjects']):
        assert obj['IncludeAnimation']
        clip = obj['Animation']
        assert clip['U1'] == part * 25 and clip['AnimationAction'] == 4
        row, = clip['AnimationEntries'][0]['AnimationMaths']
        assert list(row.values()) == [0, 0, 100, -10, 0, 1.25]
    effects = json.loads((path / 'Effects.json').read_text())
    motion, = [g for g in effects['graphs'] if g['id'].startswith('streamed-motion:')]
    assert motion['name'].endswith(' motion')
    assert motion['nodes'][0]['semanticType'] == 'property.anim-object'
    assert motion['extensions']['sourceEffect']['clip'] == 'decoded'
    instances = json.loads((path / 'Instances.json').read_text())['Instances']
    for instance in instances:
        slot = instance['EffectSlotIndex']
        if collectible or boost:
            assert slot >= 0
            refs = effects['slots'][slot]['circumstances']
            assert refs['persistent'] == motion['id']
            assert bool(refs['collision']) == collectible
        else:
            assert slot == -1, 'a clip does not imply autoplay for an ordinary prop'
    assert ('Pickup' in model) == collectible
    if boost:
        assert model['SourceItem']['Reward'] == 'Deferred'


def main():
    executable = sys.argv[1]
    with tempfile.TemporaryDirectory(prefix='openslope-streamed-effects-') as temporary:
        root = Path(temporary)
        for game, course, name in [
            ('retail', 'SSX3_A', 'mdl_ESS3_collecta_1000'),
            ('beta', 'SSX3B_ARA1', 'mdl_ARA1_multia_1000'),
            ('tour', 'SSXOT_ER1_DAY', 'mdl_er4_casha_1009'),
            ('tour', 'SSXOT_ER1_NIGHT', 'mdl_npp_cashb_1007'),
            ('tour', 'SSXOT_ER1_DAY', 'mdl_np2_boasta_1001'),
            ('tour', 'SSXOT_ER1_DAY', 'mdl_vb4_boosta_1002'),
            ('tour', 'SSXOT_ER1_DAY', 'mdl_wr2_boostb_1001'),
            ('tour', 'SSXOT_ER1_DAY', 'mdl_er4_boost_1'),
        ]:
            iso = root / f'{name}.iso'
            iso.write_bytes(fixture(game, name))
            destination = root / name
            run(executable, 'extract', iso, course, destination)
            boost = '_boosta_' in name or '_boostb_' in name
            check_map(destination / course, collectible=not boost and name != 'mdl_er4_boost_1', boost=boost)
        for game, course in [('retail', 'SSX3_A'), ('beta', 'SSX3B_ARA1')]:
            for unknown in [False, True]:
                image = root / f'{game}-collision-{unknown}.iso'
                image.write_bytes(collision_fixture(game, unknown))
                destination = root / f'{game}-collision-{unknown}'
                run(executable, 'extract', image, course, destination)
                out = destination / course
                rows = json.loads((out / 'Instances.json').read_text())['Instances']
                a, b = [row['CollsionModelPaths'] for row in rows]
                assert len(a) == len(b) == 2, 'partial collision keeps complete object alignment'
                assert (a[1] != b[1]) == (not unknown), 'each definition controls its own shared proxy admission'
                assert (out / 'Collision' / a[0]).read_text().count('\nf ') == 1, 'trunk stays collidable'
                assert (out / 'Collision' / a[1]).read_text().count('\nf ') == (1 if unknown else 0)
                assert (out / 'Collision' / b[1]).read_text().count('\nf ') == 1, 'shared source geometry is retained'
                assert sum(line.startswith('v ') for line in (out / 'Collision' / a[1]).read_text().splitlines()) >= 3
        pose = root / 'pose.iso'
        pose.write_bytes(fixture('retail', 'mdl_ESS3_static_pose', 'pose'))
        run(executable, 'extract', pose, 'SSX3_A', root / 'pose')
        pose_map = root / 'pose/SSX3_A'
        assert json.loads((pose_map / 'Models.json').read_text())['Models'][0]['AnimTime'] == 0
        assert not json.loads((pose_map / 'Effects.json').read_text())['graphs'], 'zero-length poses have no loop driver'
        for damage in ['mask', 'count', 'table', 'channel', 'segments', 'curves', 'nan', 'window', 'duration']:
            iso = root / f'{damage}.iso'
            iso.write_bytes(fixture('retail', 'mdl_ESS3_collecta_1000', damage))
            destination = root / damage
            run(executable, 'extract', iso, 'SSX3_A', destination, succeeds=False)
            assert not list(destination.iterdir()), 'malformed clips must not publish partial maps'
    print('PASS: three-title common clips, fractional timing, hierarchy, item adapters, dormant motion and bounded failures')


if __name__ == '__main__':
    if len(sys.argv) == 4 and sys.argv[1] in ['--fixture', '--collision-fixture']:
        game = sys.argv[2]
        name = 'mdl_er4_casha_1009' if game == 'tour' else 'mdl_ARA1_collecta_1000'
        Path(sys.argv[3]).write_bytes(collision_fixture(game) if sys.argv[1] == '--collision-fixture' else fixture(game, name))
    else:
        main()
