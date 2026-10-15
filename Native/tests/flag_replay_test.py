"""Verify authored cloth through production world ticks, batching and Vulkan."""
from pathlib import Path
import json,subprocess,sys,tempfile,shutil
from appearance_test import rgba

def node(main,payload=None,refs=None):return dict(mainType=main,payload=payload or {},references=refs or {})
def wave(pole=0,speed=1.5,amplitude=80,lifetime=0):return node(0,dict(type0=dict(SubType=13,type0Sub13=dict(U0=pole,U1=speed,U2=amplitude,U3=lifetime))))
def main():
    executable=str(Path(sys.argv[1]).resolve());keep=Path(sys.argv[2]).resolve() if len(sys.argv)>2 else None;frames=0;images={}
    with tempfile.TemporaryDirectory(prefix='openslope-flag-replay-') as temporary:
        root=Path(temporary);(root/'Meshes').mkdir();(root/'Textures').mkdir()
        patch=dict(PatchName='Flag test floor',SurfaceType=1,TrickOnlyPatch=False,TexturePath='',LightmapID=-1,LightMapPoint=[0,0,0,0],UVPoints=[[0,0],[0,1],[1,0],[1,1]],Points=[[(u/3-.5)*200000,(v/3-.5)*200000,0] for u in range(4) for v in range(4)])
        (root/'Patches.json').write_text(json.dumps(dict(Patches=[patch])))
        (root/'AIP.json').write_text(json.dumps(dict(StartPosList=[0],AIPaths=[dict(PathPos=[-300,100,0],PathPoints=[[1000,-250,0]])],RaceLines=[])))
        (root/'Meshes/quad.obj').write_text('v 0 -60 180\nv 0 -60 40\nv 0 60 180\nv 0 60 40\nvt 0 0\nvt 0 1\nvt 1 0\nvt 1 1\nvn -1 0 0\nf 1/1/1 2/2/1 3/3/1\nf 3/3/1 2/2/1 4/4/1\n')
        (root/'Models.json').write_text(json.dumps(dict(Models=[dict(ModelObjects=[dict(ParentID=-1,MeshData=[dict(MeshPath='quad.obj',MaterialID=0)])])])) )
        (root/'Materials.json').write_text(json.dumps(dict(Materials=[dict(TexturePath='flag.png',UnknownInt18=1<<17)])))
        (root/'Textures/flag.png').write_bytes(rgba(1,1,[240,20,40,255]))
        cases=[('rest',1,0,0),('wave-start',1,0,0),('wave-middle',11,0,0),('wave-next',21,0,0),('opposite',11,1,0),('paused',41,0,0),('paused-start',1,0,0),('expired',31,0,.25),('restart',11,0,0),('zero',11,0,0)]
        for name,ticks,pole,life in cases:
            active=name!='rest';amplitude=0 if name=='zero' else 80
            instances=[dict(ModelID=0,Location=[0,0,0],Visable=True,PlayerCollision=False,EffectSlotIndex=0 if active else -1,AmbentLightColour=[256,256,256]),dict(ModelID=0,Location=[0,-200,0],Visable=True,PlayerCollision=False,EffectSlotIndex=-1,AmbentLightColour=[256,256,256])]
            nodes=[wave(pole,amplitude=amplitude,lifetime=life)]
            if name.startswith('paused'):nodes.append(node(0,dict(type0=dict(SubType=5,DeadNodeMode=1))))
            doc=dict(kind='openslope-effects',version=1,graphs=[dict(id='flag',nodes=nodes)],functions=[],slots=[dict(id='ambient',circumstances=dict(persistent='flag'))])
            for filename,value in [('Instances.json',dict(Instances=instances)),('Effects.json',doc)]: (root/filename).write_text(json.dumps(value))
            steps=[dict(Ticks=ticks)]
            if name=='restart':steps=[dict(Ticks=21),dict(Ticks=1,RunRestart=True),dict(Ticks=10)]
            replay=root/(name+'.json');replay.write_text(json.dumps(dict(Schema='openslope-replay/v1',Placement=dict(Position=[-3,-.005,-1],Forward=[1,0,.25]),Steps=steps)))
            picture=root/(name+'.ppm');p=subprocess.run([executable,'--map',str(root),'--replay',str(replay),'--capture',str(picture),'--on-foot','--first-person','--no-audio'],capture_output=True,text=True,timeout=120);assert p.returncode==0,p.stdout+p.stderr;assert 'unsupported 0;' in p.stdout,p.stdout
            frames+=sum(s['Ticks'] for s in steps);rgb=picture.read_bytes().split(b'\n',3)[3];images[name]=rgb
            expected='Flag cloth: 0 sections; 0 draws' if name in ('rest','expired','zero') else 'Flag cloth: 8 sections; 1 draws';assert expected in p.stdout,(name,p.stdout)
            red=sum(r>180 and g<60 and b<90 for r,g,b in zip(rgb[0::3],rgb[1::3],rgb[2::3]));assert red>1000,(name,red)
            if keep:keep.mkdir(parents=True,exist_ok=True);shutil.copy2(picture,keep/picture.name);(keep/(name+'.log')).write_text(p.stdout)
        assert images['paused']==images['paused-start'],'Paused cloth changed phase'
        assert images['rest']==images['expired']==images['zero'],'Tear down or zero amplitude changes original shared mesh'
        for name in ['wave-start','wave-middle','wave-next','opposite']:
            changed=sum(a!=b for a,b in zip(images['rest'],images[name]));assert changed>1000,(name,changed)
            # The sibling shares its model and material but keeps exactly placed, flat art.
            rest=images['rest'];same=sum(a==b and a[0]>180 and a[1]<60 and a[2]<90 for a,b in zip(zip(rest[0::3],rest[1::3],rest[2::3]),zip(images[name][0::3],images[name][1::3],images[name][2::3])));assert same>1000,(name,same)
        assert images['wave-middle']!=images['opposite'],'Both pole ends produce the same motion'
        assert images['wave-start']!=images['wave-middle']!=images['wave-next'],'Wave clock does not advance'
    print(f'PASS: {frames} production Vulkan frames verify flag phase, both poles, pause, lifetime, restart and shared resting sibling')
if __name__=='__main__':main()
