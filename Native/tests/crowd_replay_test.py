"""Production shared crowd cells, cadence, cutout pages and per-stand pause."""
from pathlib import Path
from collections import Counter
import json,subprocess,sys,tempfile
from appearance_test import rgba

def prop(sub,fields):return dict(mainType=0,payload=dict(type0=dict(SubType=sub,**fields)),references={})
def main():
    executable=str(Path(sys.argv[1]).resolve());rendered=0;pictures={}
    with tempfile.TemporaryDirectory(prefix='openslope-crowd-replay-') as temporary:
        root=Path(temporary);(root/'Meshes').mkdir();(root/'Textures').mkdir()
        patch=dict(PatchName='Crowd replay floor',SurfaceType=1,TrickOnlyPatch=False,TexturePath='',LightmapID=-1,LightMapPoint=[0,0,0,0],UVPoints=[[0,0],[0,1],[1,0],[1,1]],Points=[[(u/3-.5)*200000,(v/3-.5)*200000,0] for u in range(4) for v in range(4)])
        (root/'Patches.json').write_text(json.dumps(dict(Patches=[patch])))
        meshes=[]
        for i in range(16):
            y=(i%4-1.5)*60;z=(i//4)*60+40;name=f'cell-{i}.obj'
            (root/'Meshes'/name).write_text(f'v 0 {y-20} {z}\nv 0 {y+20} {z}\nv 0 {y+20} {z+40}\nv 0 {y-20} {z+40}\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nf 1/1 2/2 3/3\nf 1/1 3/3 4/4\n');meshes.append(dict(MeshPath=name,MaterialID=15-i))
        palette=[(20+i*14,230-i*12,20+(i*53)%200) for i in range(16)]
        for i,colour in enumerate(palette):(root/'Textures'/f'crowd-{i:02d}.png').write_bytes(rgba(1,1,[*colour,255]))
        (root/'Textures/placeholder.png').write_bytes(rgba(1,1,[100,100,100,255]))
        (root/'Crowd.json').write_text(json.dumps(dict(Schema='openslope-crowd/v1',Frames=[f'crowd-{i:02d}.png' for i in range(16)])))
        (root/'Models.json').write_text(json.dumps(dict(Models=[dict(ModelObjects=[dict(ParentID=-1,MeshData=meshes)])])))
        (root/'Materials.json').write_text(json.dumps(dict(Materials=[dict(TexturePath='placeholder.png',TextureFlipbook=[],UnknownInt18=0) for _ in range(16)])))
        instances=[dict(ModelID=0,Location=[0,y,0],Visable=True,PlayerCollision=False,EffectSlotIndex=i,AmbentLightColour=[256,256,256]) for i,y in enumerate([-150,150])]
        (root/'Instances.json').write_text(json.dumps(dict(Instances=instances)))
        install=prop(17,dict(CrowdEffect=dict(U0=999,U1=4,U2=4)))
        graphs=[dict(id='pausing',nodes=[install,dict(mainType=4,payload=dict(WaitTime=.1),references={}),prop(5,dict(DeadNodeMode=1))]),dict(id='playing',nodes=[install])]
        (root/'Effects.json').write_text(json.dumps(dict(kind='openslope-effects',version=1,graphs=graphs,functions=[],slots=[dict(id='paused',circumstances=dict(persistent='pausing')),dict(id='live',circumstances=dict(persistent='playing'))])))
        for name,ticks in [('initial',1),('before-beat',4),('after-beat',5),('paused',7),('later',67)]:
            replay=root/(name+'.json');replay.write_text(json.dumps(dict(Schema='openslope-replay/v1',Placement=dict(Position=[-8,0,0],Forward=[1,0,0]),Steps=[dict(Ticks=ticks)])))
            capture=root/(name+'.ppm');result=subprocess.run([executable,'--map',str(root),'--replay',str(replay),'--capture',str(capture),'--on-foot','--first-person','--no-audio'],capture_output=True,text=True,timeout=120);assert not result.returncode,result.stdout+result.stderr;assert 'unsupported 0;' in result.stdout,result.stdout
            if len(sys.argv)>2:
                saved=Path(sys.argv[2]);saved.mkdir(exist_ok=True);(saved/(name+'.ppm')).write_bytes(capture.read_bytes());(saved/(name+'.log')).write_text(result.stdout+result.stderr)
            rgb=capture.read_bytes().split(b'\n',3)[3];pictures[name]=rgb;counts=Counter(zip(rgb[0::3],rgb[1::3],rgb[2::3]));assert sum(counts[colour]>100 for colour in palette)>=4,(name,counts.most_common(12));rendered+=ticks
        assert pictures['initial']==pictures['before-beat'],'crowd changed before fifth tick'
        assert pictures['initial']!=pictures['after-beat'],'crowd did not advance on fifth tick'
        a,b=pictures['paused'],pictures['later'];colours=set(palette);pixels=list(zip(a[0::3],a[1::3],a[2::3]));columns=sorted({i%1280 for i,colour in enumerate(pixels) if colour in colours});gap=max(zip(columns,columns[1:]),key=lambda pair:pair[1]-pair[0]);assert gap[1]-gap[0]>20,'stand silhouettes are not separated';split=(gap[0]+gap[1])//2;differences=[]
        for lo,hi in [(0,split),(split,1280)]:
            chosen=[i for i,colour in enumerate(pixels) if lo<=i%1280<hi and colour in colours];assert len(chosen)>1000
            differences.append(sum(a[i*3:i*3+3]!=b[i*3:i*3+3] for i in chosen))
        assert min(differences)==0 and max(differences)>1000,('one stand should hold while the other animates',differences)
    print(f'PASS: {rendered} production Vulkan frames verify independent crowd cells, fifth-tick cadence, shared pages and per-stand pause')
if __name__=='__main__':main()
