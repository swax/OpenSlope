"""Actual Vulkan mover copies, cable pixels and detached kill/tombstone behavior."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from appearance_test import rgba


def node(main, payload):
    return dict(mainType=main, payload=payload)


def main():
    executable=str(Path(sys.argv[1]).resolve())
    frames=0
    with tempfile.TemporaryDirectory(prefix='openslope-spline-motion-replay-') as temporary:
        root=Path(temporary)
        patch=dict(PatchName='Mover replay floor',SurfaceType=1,TrickOnlyPatch=False,
            Points=[[(u/3-.5)*200000,(v/3-.5)*200000,0] for u in range(4) for v in range(4)],
            UVPoints=[[0,0],[0,1],[1,0],[1,1]],TexturePath='',LightmapID=-1,LightMapPoint=[0,0,0,0])
        (root/'Patches.json').write_text(json.dumps(dict(Patches=[patch])))
        (root/'Meshes').mkdir();(root/'Textures').mkdir()
        (root/'Textures/white.png').write_bytes(rgba(1,1,[255,255,255,255]))
        (root/'Meshes/quad.obj').write_text('v 0 -25 40\nv 0 25 40\nv 0 25 180\nv 0 -25 180\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nvn -1 0 0\nf 1/1/1 2/2/1 3/3/1\nf 1/1/1 3/3/1 4/4/1\n')
        (root/'Models.json').write_text(json.dumps(dict(Models=[dict(ModelObjects=[dict(ParentID=-1,MeshData=[dict(MeshPath='quad.obj',MaterialID=0)])])])))
        (root/'Materials.json').write_text(json.dumps(dict(Materials=[dict(TexturePath='white.png',UnknownInt18=1<<17)])))
        (root/'Instances.json').write_text(json.dumps(dict(Instances=[
            dict(ModelID=0,Location=[200000,300000,0],Scale=[2,3,4],Rotation=[0,0,.7071067811865476,.7071067811865476],Visable=False,EffectSlotIndex=0,AmbentLightColour=[210,10,250]),
            dict(ModelID=0,Location=[0,-250,0],Visable=True,EffectSlotIndex=-1,AmbentLightColour=[10,250,10])
        ])))
        (root/'Splines.json').write_text(json.dumps(dict(Splines=[dict(SplineStyle=-1,U1=-2,Segments=[dict(Points=[[0,0,10],[0,200,10],[0,400,10],[0,600,10]])])])))
        images={}
        for name,ticks,operation,line,alpha in [('initial',1,None,True,1),('moving',61,None,True,1),('wrapped',361,None,True,1),('tombstone',61,2,True,1),('killed',61,3,True,1),('no-line',1,None,False,1),('half-line',1,None,True,.5)]:
            move=node(2,dict(type2=dict(SubType=1,SplineAnimation=dict(U1=1,U2=1,InstanceCount=3,AnimationSpeed=1,U5=0,U6=int(line),U7=alpha,R=.1,G=.8,B=.9))))
            move['references']=dict(spline='path')
            nodes=[node(0,dict(type0=dict(SubType=2,Debounce=0))),move]
            if operation is not None:nodes.extend([node(4,dict(WaitTime=.5)),node(0,dict(type0=dict(SubType=5,DeadNodeMode=operation)))])
            (root/'Effects.json').write_text(json.dumps(dict(kind='openslope-effects',version=1,
                graphs=[dict(id='motion',nodes=nodes)],slots=[dict(id='slot',circumstances=dict(persistent='motion'))],
                functions=[],objectProperties=[],instances=[],splines=[dict(id='path',originalIndex=999,data={})])))
            replay=root/(name+'.json');replay.write_text(json.dumps(dict(Schema='openslope-replay/v1',Placement=dict(Position=[-6,-.005,-1],Forward=[1,0,0]),Steps=[dict(Ticks=ticks)])))
            output=root/(name+'.ppm')
            result=subprocess.run([executable,'--map',str(root),'--on-foot','--first-person','--replay',str(replay),'--capture',str(output),'--no-audio'],capture_output=True,text=True,timeout=120)
            assert result.returncode==0,result.stdout+result.stderr
            assert f'route movers {0 if name=="killed" else 1};' in result.stdout,result.stdout
            assert f'Visible props: {1 if name=="killed" else 4};' in result.stdout,result.stdout
            rgb=output.read_bytes().split(b'\n',3)[3];purple=[];green=[];cable=[]
            for i,(r,g,b) in enumerate(zip(rgb[0::3],rgb[1::3],rgb[2::3])):
                x,y=i%1280,i//1280
                if r>g*3 and b>r*1.1 and b>80:purple.append((x,y))
                if g>r*3 and g>b*3 and g>150:green.append((x,y))
                if b>g and g>r*2 and g>100:cable.append((x,y,r,g,b))
            assert len(green)>1000,(name,len(green))
            assert (not purple if name=='killed' else len(purple)>1000),(name,len(purple))
            if name in ('no-line','killed'):assert not cable,(name,len(cable))
            elif name!='half-line':assert len(cable)>150,(name,len(cable))
            images[name]=dict(rgb=rgb,purple=purple,green=green,cable=cable)
            frames+=ticks
        initial=images['initial']
        center=lambda points:sum(p[0] for p in points)/len(points)
        assert center(images['moving']['purple'])<center(initial['purple'])-20
        assert images['wrapped']['rgb']==initial['rgb'],'wrapping failed to restore exact poses'
        assert images['tombstone']['rgb']==images['moving']['rgb'],'ordinary tombstone unexpectedly kills detached drawing'
        assert all(abs(center(row['green'])-center(initial['green']))<1 for row in images.values()),'shared-model sibling moved'
        alpha_checks=0
        for x,y,r,g,b in initial['cable']:
            if abs(r-26)>1 or abs(g-204)>1 or abs(b-230)>1:continue
            i=(y*1280+x)*3
            background=images['no-line']['rgb'][i:i+3]
            half=images['half-line']['rgb'][i:i+3]
            assert all(abs(actual-(source+base)*.5)<=2 for actual,source,base in zip(half,(r,g,b),background)),(x,y,half,background)
            alpha_checks+=1
        assert alpha_checks>50,alpha_checks
    print(f'PASS: {frames} production Vulkan frames verify detached copies, template transform isolation, cable/alpha, wrap and tombstone/kill behavior')


if __name__=='__main__':main()
