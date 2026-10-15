"""Ride and walk through an authored multi-piece barrier using production Vulkan/PCM."""
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import wave
from appearance_test import rgba


def main():
    executable = str(Path(sys.argv[1]).resolve())
    frames = 0
    with tempfile.TemporaryDirectory(prefix='openslope-shatter-') as temporary:
        root = Path(temporary)
        def write(name, value):
            (root/name).write_text(json.dumps(value))
        def node(main, payload=None, **refs):
            return dict(mainType=main, payload=payload or {}, references=refs)
        patch = dict(PatchName='Authored barrier floor', SurfaceType=1, TrickOnlyPatch=False,
            Points=[[(u/3-.5)*200000,(v/3-.5)*200000,0] for u in range(4) for v in range(4)],
            UVPoints=[[0,0],[0,1],[1,0],[1,1]], TexturePath='', LightmapID=-1, LightMapPoint=[0,0,0,0])
        write('Patches.json', dict(Patches=[patch]))
        (root/'Meshes').mkdir(); (root/'Textures').mkdir()
        (root/'Textures/pane.png').write_bytes(rgba(1,1,[70,220,240,160]))
        (root/'Textures/scan.png').write_bytes(rgba(1,2,[0,7,7,0,0,7,7,80]))
        (root/'Textures/pieces.png').write_bytes(rgba(1,1,[240,35,20,255]))
        def quad(name, x, low, high, left=-120, right=120):
            (root/'Meshes'/name).write_text(
                f'v {x} {left} {low}\nv {x} {right} {low}\nv {x} {right} {high}\nv {x} {left} {high}\n'
                'vt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nvn -1 0 0\nf 1/1/1 2/2/1 3/3/1 4/4/1\n')
        quad('pane.obj',0,0,260); quad('scan.obj',-1,0,260)
        parts=[]
        for i in range(8):
            low=(i//2)*65; left=-120+(i%2)*120
            quad(f'piece{i}.obj',0,low,low+65,left,left+120)
            parts.append(dict(ParentID=-1, MeshData=[dict(MeshPath=f'piece{i}.obj',MaterialID=2)]))
        models=[dict(ModelObjects=[dict(ParentID=-1, MeshData=[dict(MeshPath='pane.obj',MaterialID=0)],
                    CollisionBounds=dict(Min=[-4,-120,0],Max=[4,120,260]))]),
                dict(ModelObjects=[dict(ParentID=-1, MeshData=[dict(MeshPath='scan.obj',MaterialID=1)])]),
                dict(ModelObjects=parts)]
        write('Models.json', dict(Models=models))
        write('Materials.json', dict(Materials=[dict(TexturePath='pane.png',UnknownInt18=1<<18),
            dict(TexturePath='scan.png',UnknownInt18=1<<17),dict(TexturePath='pieces.png')]))
        instances=[dict(ModelID=0,Location=[0,0,0],Visable=True,PlayerCollision=True,
                       CollsionMode=2,U0=0,PlayerBounce=False,EffectSlotIndex=0,IncludeSound=True,
                       Sounds=dict(CollisonSound=7,ExternalSounds=[])),
                   dict(ModelID=1,Location=[0,0,0],Visable=True,PlayerCollision=False),
                   dict(ModelID=2,Location=[0,0,0],Visable=False,PlayerCollision=False)]
        for instance in instances: instance['AmbentLightColour']=[256,256,256]
        write('Instances.json',dict(Instances=instances))
        kill=node(0,dict(type0=dict(SubType=5,DeadNodeMode=4)))
        launch=node(0,dict(type0=dict(SubType=20,type0Sub20=dict(U0=1,U1=.03,U2=2,
            U3=0,U4=0,U5=0,U6=900,U7=900,U8=400,U9=1))))
        write('Effects.json',dict(kind='openslope-effects',version=1,
            graphs=[dict(id='collision',nodes=[node(21,function='break')]),
                    dict(id='hide',nodes=[kill]),dict(id='throw',nodes=[launch])],
            functions=[dict(id='break',nodes=[node(7,instance='instance:0',effectGraph='hide'),
                node(7,instance='instance:1',effectGraph='hide'),node(7,instance='instance:2',effectGraph='throw')])],
            slots=[dict(id='slot:0',circumstances=dict(collision='collision'))]))
        sound = root/'Audio/SFX/course'; sound.mkdir(parents=True)
        write('Audio/SoundIndex.json',dict(Schema='openslope-sound-index/v1',Banks={'2':'course'},
            CollisionEvents={'7':dict(Group=2,Slot=0,Bank='course',Clip='Audio/SFX/course/000.wav')}))
        with wave.open(str(sound/'000.wav'),'wb') as wav:
            wav.setparams((1,2,48000,0,'NONE','not compressed'))
            wav.writeframes(struct.pack('<4800h',*([9000,-9000]*2400)))
        for foot in (False,True):
            for name,ticks in [('intact',1),('hit',12),('spent',145)]:
                label=f'{"walk" if foot else "ride"}-{name}'
                replay=root/f'{label}.json'
                steps=[dict(Ticks=ticks,Posture=1 if foot else 0,
                            WalkForward=[1,0,0] if foot else [0,0,0])]
                if foot and name=='hit':
                    # Stop at the contact, so the fragments remain in front of the camera.
                    steps=[dict(Ticks=10,Posture=1,WalkForward=[1,0,0]),dict(Ticks=5)]
                write(replay.name,dict(Schema='openslope-replay/v1',
                    Placement=dict(Position=[-1.6,-.005,0],Forward=[1,0,0],Velocity=[8,0,0]),
                    Steps=steps))
                picture=root/f'{label}.ppm'; pcm=root/f'{label}.wav'
                args=[executable,'--map',str(root),'--first-person','--replay',str(replay),
                      '--capture',str(picture),'--audio-capture',str(pcm)]
                if foot: args.append('--on-foot')
                result=subprocess.run(args,capture_output=True,text=True,timeout=120)
                assert result.returncode==0,result.stdout+result.stderr
                pixels=picture.read_bytes().split(b'\n',3)[3]
                cyan=sum(g>r+30 and b>r+30 and b>100 for r,g,b in zip(pixels[0::3],pixels[1::3],pixels[2::3]))
                red=sum(r>180 and g<80 and b<80 for r,g,b in zip(pixels[0::3],pixels[1::3],pixels[2::3]))
                assert 'unsupported 0;' in result.stdout,result.stdout
                if name=='intact':
                    assert cyan>10000 and not red,(label,cyan,red,result.stdout)
                    assert 'contact sounds 0;' in result.stdout,result.stdout
                else:
                    assert 'contact sounds 1;' in result.stdout,(label,result.stdout)
                    with wave.open(str(pcm),'rb') as wav:
                        samples=struct.unpack('<'+str(wav.getnframes()*2)+'h',wav.readframes(wav.getnframes()))
                    assert max(samples)>100 and min(samples)<-100,'routed break sound did not reach PCM'
                    if name=='hit': assert red>50,(label,red,result.stdout)
                    else: assert 'Visible props: 0;' in result.stdout,(label,result.stdout)
                frames+=sum(step['Ticks'] for step in steps)
    print(f'PASS: {frames} Vulkan frames verify priority scanline alpha, walking/riding shatter, visible pieces, retirement and routed PCM')


if __name__=='__main__':main()
