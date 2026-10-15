"""Run material graphs through production fixed-tick physics and Vulkan."""
from pathlib import Path
import json,subprocess,sys,tempfile
from appearance_test import rgba

def node(main,payload=None,refs=None):return dict(mainType=main,payload=payload or {},references=refs or {})
def prop(sub,fields):return node(0,dict(type0=dict(SubType=sub,**{('UVScroll' if sub==10 else 'TextureFlip'):fields})))
def main():
    executable=str(Path(sys.argv[1]).resolve());frames=0;pictures={}
    with tempfile.TemporaryDirectory(prefix='openslope-texture-clock-replay-') as temporary:
        root=Path(temporary);(root/'Meshes').mkdir();(root/'Textures').mkdir()
        patch=dict(PatchName='Material clock floor',SurfaceType=1,TrickOnlyPatch=False,TexturePath='',LightmapID=-1,LightMapPoint=[0,0,0,0],UVPoints=[[0,0],[0,1],[1,0],[1,1]],Points=[[(u/3-.5)*200000,(v/3-.5)*200000,0] for u in range(4) for v in range(4)])
        (root/'Patches.json').write_text(json.dumps(dict(Patches=[patch])))
        (root/'Meshes/quad.obj').write_text('v 0 -35 40\nv 0 35 40\nv 0 35 180\nv 0 -35 180\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nvn -1 0 0\nf 1/1/1 2/2/1 3/3/1\nf 1/1/1 3/3/1 4/4/1\n')
        (root/'Models.json').write_text(json.dumps(dict(Models=[dict(ModelObjects=[dict(ParentID=-1,CollisionBounds=dict(Min=[-400,-100,-10],Max=[400,100,150]),MeshData=[dict(MeshPath='quad.obj',MaterialID=0)])])])) )
        for name,colour in [('red',[240,20,40,255]),('blue',[20,40,240,255])]: (root/'Textures'/f'{name}.png').write_bytes(rgba(1,1,colour))
        palette=[[240,20,40,255],[20,220,40,255],[20,40,240,255],[240,190,10,255]]
        (root/'Textures/grid.png').write_bytes(rgba(16,16,sum((palette[(y//8)*2+x//8] for y in range(16) for x in range(16)),[])))
        cases=[('rest',1),('ambient-initial',1),('ambient',15),('pulse-initial',1),('pulse-advanced',19),('pulse-expired',31),('dwell-flash',60),('dwell-hold',66),('uv-rest',1),('uv-scroll',25),('uv-phase',1),('uv-v-forward',25),('uv-v-reverse',25),('uv-v-phase',1),('uv-v-negative-phase',1)]
        for name,ticks in cases:
            uv=name.startswith('uv');pulse=name.startswith('pulse');dwell=name.startswith('dwell');ambient=name.startswith('ambient') or dwell
            material=dict(TexturePath='grid.png' if uv else 'blue.png',TextureFlipbook=[] if uv else ['red.png','blue.png'],UnknownInt18=1<<17)
            (root/'Materials.json').write_text(json.dumps(dict(Materials=[material])))
            effect=prop(10,dict(U0=0,U1=.01 if name=='uv-scroll' else 0,U2=0,U3=10,U4=0,U5=0)) if uv else prop(11,dict(U0=0,Direction=0,Speed=1 if dwell else 3.5 if pulse else 4,Length=.5 if pulse else 0,U4=int(dwell)))
            if name in ('uv-v-forward','uv-v-reverse'):effect['payload']['type0']['UVScroll']['U2']=.01 if name=='uv-v-forward' else -.01
            nodes=[effect]
            if pulse:nodes.append(node(3,dict(type3=dict(U0=2,U1=1))))
            if name=='uv-phase':nodes.append(node(9,dict(type9=dict(U0=6,U1=.5))))
            if name in ('uv-v-phase','uv-v-negative-phase'):nodes.append(node(9,dict(type9=dict(U0=6,U1=.25 if name=='uv-v-phase' else -.25))))
            instances=[dict(ModelID=0,Location=[0,0,0],Visable=True,PlayerCollision=False,EffectSlotIndex=0 if ambient or (uv and name!='uv-rest') else -1,AmbentLightColour=[256,256,256]),dict(ModelID=0,Location=[0,-180,0],Visable=True,PlayerCollision=False,EffectSlotIndex=-1,AmbentLightColour=[256,256,256]),dict(ModelID=0,Location=[0,0,0],Visable=False,PlayerCollision=True,PlayerBounce=False,U0=0,CollsionMode=2,EffectSlotIndex=1 if pulse else -1)]
            graphs=[dict(id='material',nodes=nodes),dict(id='contact',nodes=[node(0,dict(type0=dict(SubType=2,Debounce=10))),node(7,refs=dict(instance='instance:0',effectGraph='material'))])]
            slots=[dict(id='ambient',circumstances=dict(persistent='material')),dict(id='trigger',circumstances=dict(collision='contact'))]
            for filename,value in [('Instances.json',dict(Instances=instances)),('Effects.json',dict(kind='openslope-effects',version=1,graphs=graphs,functions=[],slots=slots))]: (root/filename).write_text(json.dumps(value))
            replay=root/(name+'.json');replay.write_text(json.dumps(dict(Schema='openslope-replay/v1',Placement=dict(Position=[-3,-.005,0],Forward=[1,0,0]),Steps=[dict(Ticks=ticks)])))
            picture=root/(name+'.ppm');p=subprocess.run([executable,'--map',str(root),'--replay',str(replay),'--capture',str(picture),'--on-foot','--first-person','--no-audio'],capture_output=True,text=True,timeout=120)
            assert p.returncode==0,p.stdout+p.stderr
            assert 'unsupported 0;' in p.stdout,p.stdout
            rgb=picture.read_bytes().split(b'\n',3)[3];pictures[name]=rgb
            red=sum(r>180 and g<60 and b<90 for r,g,b in zip(rgb[0::3],rgb[1::3],rgb[2::3]));blue=sum(b>180 and r<60 and g<90 for r,g,b in zip(rgb[0::3],rgb[1::3],rgb[2::3]));frames+=ticks
            if not uv:
                assert red>1000,(name,red,p.stdout)
                if name in ('ambient','pulse-initial','dwell-flash'): assert blue>1000,(name,blue,p.stdout)
                else:assert blue==0,(name,blue,p.stdout)
        for name in ['ambient-initial','pulse-advanced','pulse-expired','dwell-hold']: assert pictures[name]==pictures['rest'],name+' did not restore exact resting image'
        for name in ['uv-scroll','uv-phase','uv-v-forward','uv-v-reverse','uv-v-phase','uv-v-negative-phase']:
            baseline=pictures['uv-rest'];changed=sum(a!=b for a,b in zip(baseline,pictures[name]));assert changed>1000,(name,changed)
            # The sibling's grid remains on its placed coordinates: enough identical coloured
            # pixels survive that a whole-scene or shared-material repaint cannot pass.
            unchanged=sum(a==b and max(a)-min(a)>100 for a,b in zip(zip(baseline[0::3],baseline[1::3],baseline[2::3]),zip(pictures[name][0::3],pictures[name][1::3],pictures[name][2::3])))
            assert unchanged>1000,(name,unchanged)
        assert pictures['uv-v-phase']!=pictures['uv-v-negative-phase'],'quarter-cycle phases must distinguish scroll direction'
        for clock,phase in [('uv-v-forward','uv-v-phase'),('uv-v-reverse','uv-v-negative-phase')]:
            assert pictures[clock]==pictures[phase],f'{clock}: per-tick V motion disagrees with its native signed phase'
    print(f'PASS: {frames} production Vulkan frames verify resting frame zero, private flips, pulse restore, dwell/flash, scroll and phase controls')
if __name__=='__main__':main()
