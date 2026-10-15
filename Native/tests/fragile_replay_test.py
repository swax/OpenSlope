"""Production contacts/deferred graphs paint private glass frames and swap break twins."""
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import wave
from appearance_test import rgba


def node(main,payload=None,refs=None):
    return dict(mainType=main,payload=payload or {},references=refs or {})


def main():
    executable=str(Path(sys.argv[1]).resolve());frames=0
    with tempfile.TemporaryDirectory(prefix='openslope-fragile-replay-') as temporary:
        root=Path(temporary)
        patch=dict(PatchName='Contact render floor',SurfaceType=1,TrickOnlyPatch=False,
            Points=[[(u/3-.5)*200000,(v/3-.5)*200000,0] for u in range(4) for v in range(4)],
            UVPoints=[[0,0],[0,1],[1,0],[1,1]],TexturePath='',LightmapID=-1,LightMapPoint=[0,0,0,0])
        (root/'Patches.json').write_text(json.dumps(dict(Patches=[patch])))
        (root/'Meshes').mkdir();(root/'Textures').mkdir()
        for name,colour in [('plain',[240,20,40,255]),('cracked',[20,40,240,255]),('broken',[240,190,10,255])]:
            (root/'Textures'/f'{name}.png').write_bytes(rgba(1,1,colour))
        (root/'Meshes/quad.obj').write_text('v 0 -35 40\nv 0 35 40\nv 0 35 180\nv 0 -35 180\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nvn -1 0 0\nf 1/1/1 2/2/1 3/3/1\nf 1/1/1 3/3/1 4/4/1\n')
        (root/'Models.json').write_text(json.dumps(dict(Models=[dict(ModelObjects=[dict(ParentID=-1,CollisionBounds=dict(Min=[-400,-100,-10],Max=[400,100,10]),MeshData=[dict(MeshPath='quad.obj',MaterialID=0)])]),dict(ModelObjects=[dict(ParentID=-1,MeshData=[dict(MeshPath='quad.obj',MaterialID=1)])])])))
        (root/'Materials.json').write_text(json.dumps(dict(Materials=[dict(TexturePath='plain.png',TextureFlipbook=['plain.png','cracked.png'],UnknownInt18=1<<17),dict(TexturePath='broken.png',TextureFlipbook=[],UnknownInt18=1<<17)])))
        audio=root/'Audio/SFX/course';audio.mkdir(parents=True)
        (root/'Audio/SoundIndex.json').write_text(json.dumps(dict(Schema='openslope-sound-index/v1',Banks={'2':'course'},CollisionEvents={})))
        for slot in (64,65,42):
            with wave.open(str(audio/f'{slot:03d}.wav'),'wb') as sound:
                sound.setparams((1,2,48000,0,'NONE','not compressed'));sound.writeframes(struct.pack('<4800h',*([8192 if slot==65 else -8192]*4800)))
        pictures={}
        for name,ticks in [('intact',1),('cracked',31),('broken',151),('healed',61),('counter-before',1),('counter-after',5),('counter-repeat',121)]:
            counter=name.startswith('counter');heal=name=='healed'
            instances=[dict(ModelID=0,Location=[0,0,0],Visable=not counter,PlayerCollision=True,PlayerBounce=False,U0=0,CollsionMode=2,EffectSlotIndex=0,AmbentLightColour=[256,256,256]),dict(ModelID=0,Location=[0,-180,0],Visable=True,PlayerCollision=False,EffectSlotIndex=-1,AmbentLightColour=[256,256,256]),dict(ModelID=1,Location=[0,0,0],Visable=False,PlayerCollision=False,EffectSlotIndex=-1,AmbentLightColour=[256,256,256])]
            if counter:
                models=json.loads((root/'Models.json').read_text());models['Models'][0]['ModelObjects'][0]['CollisionBounds']['Max'][2]=150
                (root/'Models.json').write_text(json.dumps(models))
                install=node(0,dict(type0=dict(SubType=6,Counter=dict(Count=3,U1=-1))))
                collision=[node(3,dict(type3=dict(U0=1 if name=='counter-repeat' else 3,U1=1)))]
                persistent=[install]
            else:
                install=node(0,dict(type0=dict(SubType=14,type0Sub14=dict(U0=.5 if heal else -1,U1=1000 if heal else 5))))
                collision=[node(4,dict(WaitTime=10)),install] if heal or name=='intact' else [install,node(8,dict(SoundPlay=65))]
                persistent=[install] if heal else []
            reveal=node(7,dict(Instance=dict(Effect=1)),dict(instance='instance:2'))
            trigger=[node(8,dict(SoundPlay=42 if counter else 64)),reveal]
            if not counter:trigger.insert(1,node(0,dict(type0=dict(SubType=5,DeadNodeMode=4))))
            (root/'Instances.json').write_text(json.dumps(dict(Instances=instances)))
            (root/'Effects.json').write_text(json.dumps(dict(kind='openslope-effects',version=1,graphs=[dict(id='collision',nodes=collision),dict(id='persistent',nodes=persistent),dict(id='trigger',nodes=trigger)],slots=[dict(id='slot',circumstances=dict(persistent='persistent',collision='collision',trigger='trigger'))],functions=[],instances=[],objectProperties=[],splines=[])))
            replay=root/(name+'.json');replay.write_text(json.dumps(dict(Schema='openslope-replay/v1',Placement=dict(Position=[-3,-.005,0],Forward=[1,0,0]),Steps=[dict(Ticks=ticks)])))
            picture=root/(name+'.ppm');pcm=root/(name+'.wav')
            result=subprocess.run([executable,'--map',str(root),'--on-foot','--first-person','--replay',str(replay),'--capture',str(picture),'--audio-capture',str(pcm)],capture_output=True,text=True,timeout=120)
            assert result.returncode==0,result.stdout+result.stderr
            rgb=picture.read_bytes().split(b'\n',3)[3];red=[];blue=[];yellow=[]
            for i,(r,g,b) in enumerate(zip(rgb[0::3],rgb[1::3],rgb[2::3])):
                if r>180 and g<60 and b<90:red.append(i)
                if b>180 and r<60 and g<90:blue.append(i)
                if r>180 and g>120 and b<60:yellow.append(i)
            pictures[name]=dict(rgb=rgb,red=red,blue=blue,yellow=yellow)
            with wave.open(str(pcm),'rb') as sound: samples=struct.unpack('<'+str(sound.getnframes()*2)+'h',sound.readframes(sound.getnframes()))
            if name in ('cracked','broken'):assert max(samples)>100,'crack sound did not reach PCM'
            if name in ('broken','counter-after'):assert min(samples)<-100,'shatter/counter sound did not reach PCM'
            assert len(red)>1000,(name,len(red),result.stdout)
            if name=='cracked':assert len(blue)>1000 and not yellow,(name,len(blue),len(yellow),result.stdout)
            elif name in ('broken','counter-after'):assert not blue and len(yellow)>1000,(name,len(blue),len(yellow),result.stdout)
            else:assert not blue and not yellow,(name,len(blue),len(yellow),result.stdout)
            frames+=ticks
        assert pictures['healed']['rgb']==pictures['intact']['rgb'],'healed private frame did not restore original image'
        assert len(pictures['cracked']['red'])<len(pictures['intact']['red'])*.6,'shared-model sibling was also repainted'
    print(f'PASS: {frames} production Vulkan frames verify private crack/heal pixels, break twin, deferred counter dedup and authored sound PCM')


if __name__=='__main__':main()
