"""Render actual pickup presence/despawn and reset, including captured chime PCM."""
import json
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
import wave

from appearance_test import rgba


def main():
    executable = str(Path(sys.argv[1]).resolve())
    frames = 0
    with tempfile.TemporaryDirectory(prefix='openslope-world-replay-') as temporary:
        root = Path(temporary)
        patch = dict(PatchName='World replay floor', SurfaceType=1, TrickOnlyPatch=False,
            Points=[[(u/3-.5)*200000, (v/3-.5)*200000, 0] for u in range(4) for v in range(4)],
            UVPoints=[[0,0],[0,1],[1,0],[1,1]], TexturePath='', LightmapID=-1,
            LightMapPoint=[0,0,0,0])
        (root/'Patches.json').write_text(json.dumps(dict(Patches=[patch])))
        (root/'Meshes').mkdir()
        (root/'Textures').mkdir()
        (root/'Textures/gem.png').write_bytes(rgba(1, 1, [210, 10, 250, 255]))
        (root/'Meshes/gem.obj').write_text(
            'v 0 -65 40\nv 0 65 40\nv 0 65 180\nv 0 -65 180\n'
            'vt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\n'
            'vn -1 0 0\nf 1/1/1 2/2/1 3/3/1\nf 1/1/1 3/3/1 4/4/1\n')
        obj = dict(ParentID=-1, MeshData=[dict(MeshPath='gem.obj',MaterialID=0)],
                   CollisionBounds=dict(Min=[-300,-100,0],Max=[300,100,200]))
        (root/'Models.json').write_text(json.dumps(dict(Models=[dict(ModelName='Authored pickup',ModelObjects=[obj])])))
        (root/'Materials.json').write_text(json.dumps(dict(Materials=[dict(TexturePath='gem.png',UnknownInt18=1<<17)])))
        instance = dict(ModelID=0,Location=[0,0,0],Rotation=[0,0,0,1],Scale=[1,1,1],
            Visable=True,PlayerCollision=True,CollsionMode=2,U0=0,PlayerBounce=True,
            EffectSlotIndex=0,SurfaceType=-1,LTGState=2,AmbentLightColour=[128,128,128,128])
        (root/'Instances.json').write_text(json.dumps(dict(Instances=[instance])))
        route = dict(PathPos=[0,0,0],PathPoints=[[0,-20000,0]],DistanceToFinish=20000,PathEvents=[])
        (root/'AIP.json').write_text(json.dumps(dict(StartPosList=[],AIPaths=[],RaceLines=[route])))
        audio = root/'Audio/SFX/main'
        audio.mkdir(parents=True)
        (root/'Audio/SoundIndex.json').write_text(json.dumps(dict(Schema='openslope-sound-index/v1',
            Banks={'0':'main'},CollisionEvents={})))
        with wave.open(str(audio/'116.wav'),'wb') as sound:
            sound.setparams((1,2,48000,0,'NONE','not compressed'))
            sound.writeframes(struct.pack('<4800h',*([8192]*4800)))
        def node(main,payload):
            return dict(id='node',mainType=main,payload=payload,references={})
        doc = dict(kind='openslope-effects',version=1,
            graphs=[dict(id='pickup',nodes=[node(14,dict(MultiplierScore=2)),
                node(0,dict(type0=dict(SubType=5,DeadNodeMode=2)))])],
            functions=[],slots=[dict(id='slot',originalIndex=0,circumstances=dict(collision='pickup'))],
            instances=[],objectProperties=[],splines=[])
        for name, mode, ticks, visible, multiplier in [
            ('before','showoff',180,1,1),('collected','showoff',181,0,2),
            ('freeride','freeride',1,0,1),('race','race',181,0,1),
            ('reset','showoff',229,0,1),
        ]:
            if name=='reset':
                doc['graphs'][0]['nodes']=[node(13,dict(type13=0))]
            (root/'Effects.json').write_text(json.dumps(doc))
            sequence=root/(name+'.json')
            sequence.write_text(json.dumps(dict(Schema='openslope-replay/v1',
                Placement=dict(Position=[-3,-.005,0],Forward=[1,0,0]),Steps=[dict(Ticks=ticks)])))
            output=root/(name+'.ppm')
            arguments=[executable,'--map',str(root),'--mode',mode,'--first-person',
                '--replay',str(sequence),'--capture',str(output),'--no-audio']
            if name=='collected':
                arguments+=['--audio-capture',str(root/'pickup.wav')]
            result=subprocess.run(arguments,capture_output=True,text=True,timeout=120)
            assert result.returncode==0,result.stdout+result.stderr
            assert f'Visible props: {visible};' in result.stdout,result.stdout
            assert re.search(r'World logic:.*multiplier '+str(multiplier)+r';',result.stdout),result.stdout
            rgb=output.read_bytes().split(b'\n',3)[3]
            purple=sum(r>g*3 and b>r*1.1 and b>80 for r,g,b in zip(rgb[0::3],rgb[1::3],rgb[2::3]))
            if name=='before':
                assert purple>1000,(purple,result.stdout)
            elif name=='reset':
                assert 'Course recovery: pending 0; fade 1' in result.stdout,result.stdout
                assert set(rgb)=={0},'Authored reset placement is not fully black'
            else:
                assert purple==0,(purple,result.stdout)
            if name=='collected':
                with wave.open(str(root/'pickup.wav'),'rb') as sound:
                    pcm=sound.readframes(sound.getnframes())
                assert max(abs(n[0]) for n in struct.iter_unpack('<h',pcm))>1000,'Pickup chime is silent'
            frames+=ticks
    print(f'PASS: {frames} production Vulkan frames verify mode presence, pickup pixels/despawn, chime PCM and authored reset fade')


if __name__=='__main__':
    main()
