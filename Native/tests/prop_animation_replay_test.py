"""Actual Vulkan pixels from persistent/delta players and end-latched instances."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

from appearance_test import rgba


def node(main, payload, refs=None):
    return dict(id='node', mainType=main, payload=payload, references=refs or {})


def main():
    executable = str(Path(sys.argv[1]).resolve())
    frames = 0
    with tempfile.TemporaryDirectory(prefix='openslope-prop-animation-replay-') as temporary:
        root = Path(temporary)
        patch = dict(PatchName='Animation replay floor', SurfaceType=1, TrickOnlyPatch=False,
            Points=[[(u/3-.5)*200000, (v/3-.5)*200000, 0] for u in range(4) for v in range(4)],
            UVPoints=[[0,0],[0,1],[1,0],[1,1]], TexturePath='', LightmapID=-1, LightMapPoint=[0,0,0,0])
        (root/'Patches.json').write_text(json.dumps(dict(Patches=[patch])))
        (root/'Meshes').mkdir()
        (root/'Textures').mkdir()
        (root/'Textures/white.png').write_bytes(rgba(1, 1, [255,255,255,255]))
        (root/'Meshes/quad.obj').write_text(
            'v 0 -35 40\nv 0 35 40\nv 0 35 180\nv 0 -35 180\n'
            'vt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\n'
            'vn -1 0 0\nf 1/1/1 2/2/1 3/3/1\nf 1/1/1 3/3/1 4/4/1\n')
        animated = dict(ParentID=0, IncludeAnimation=True,
            Animation=dict(U1=0,U2=0,U3=0,AnimationAction=2,
                AnimationEntries=[dict(AnimationMaths=[dict(Value1=0,Value2=0,Value3=100,Value4=0,Value5=0,Value6=2)])]),
            MeshData=[dict(MeshPath='quad.obj',MaterialID=0)])
        model = dict(ModelName='Animated shared quad',AnimTime=60,
                     ModelObjects=[dict(ParentID=-1,MeshData=[]),animated])
        (root/'Models.json').write_text(json.dumps(dict(Models=[model])))
        (root/'Materials.json').write_text(json.dumps(dict(Materials=[dict(TexturePath='white.png',UnknownInt18=1<<17)])))
        rows = [dict(ModelID=0,Location=[0,0,0],Visable=True,EffectSlotIndex=0,
                     AmbentLightColour=[210,10,250]),
                dict(ModelID=0,Location=[0,-180,0],Visable=True,EffectSlotIndex=-1,
                     AmbentLightColour=[10,250,10])]
        (root/'Instances.json').write_text(json.dumps(dict(Instances=rows)))
        def document(kind, latch):
            law=dict(U0=0,U1=-1,U2=-1,U3=30,U4=0,U5=1,U6=0,U7=3)
            return dict(kind='openslope-effects',version=1,
                graphs=[dict(id='motion',nodes=[node(0,dict(type0=dict(SubType=kind,**{f'type0Sub{kind}':law})))]),
                        dict(id='latch',nodes=[])],
                slots=[dict(id='slot',originalIndex=0,circumstances=dict(persistent='motion',
                    slot4='latch' if latch else None))],functions=[],objectProperties=[],instances=[],splines=[])
        captures = {}
        for name, kind, latch, ticks in [('initial',256,True,1),('moving',256,True,61),
                ('latched',256,True,181),('restored',256,False,181),('delta-frozen',257,True,181),
                ('outside',256,True,1),('entering',256,True,61)]:
            rows[0]['Location']=[0,-1000,0] if name in ('outside','entering') else [0,0,0]
            animated['Animation']['AnimationEntries'][0]['AnimationMaths'][0]['Value3']=1000 if name in ('outside','entering') else 100
            (root/'Instances.json').write_text(json.dumps(dict(Instances=rows)))
            (root/'Models.json').write_text(json.dumps(dict(Models=[model])))
            (root/'Effects.json').write_text(json.dumps(document(kind,latch)))
            sequence = root/(name+'.json')
            sequence.write_text(json.dumps(dict(Schema='openslope-replay/v1',
                Placement=dict(Position=[-3,-.005,0],Forward=[1,0,0]),Steps=[dict(Ticks=ticks)])))
            output=root/(name+'.ppm')
            result=subprocess.run([executable,'--map',str(root),'--on-foot','--first-person',
                '--replay',str(sequence),'--capture',str(output),'--no-audio'],
                capture_output=True,text=True,timeout=120)
            assert result.returncode==0,result.stdout+result.stderr
            assert f'Visible props: {1 if name=="outside" else 2};' in result.stdout,result.stdout
            rgb=output.read_bytes().split(b'\n',3)[3]
            purple=[]
            green=[]
            for index,(r,g,b) in enumerate(zip(rgb[0::3],rgb[1::3],rgb[2::3])):
                x,y=index%1280,index//1280
                if r>g*3 and b>r*1.1 and b>80: purple.append((x,y))
                if g>r*3 and g>b*3 and g>150: green.append((x,y))
            assert (len(purple)==0 if name=='outside' else len(purple)>1000) and len(green)>1000,(name,len(purple),len(green),result.stdout)
            captures[name]=(sum(x for x,y in purple)/len(purple) if purple else None,
                            sum(x for x,y in green)/len(green),len(purple),len(green))
            frames+=ticks
        initial=captures['initial']
        assert captures['moving'][0]<initial[0]-50,captures
        assert captures['latched'][0]<captures['moving'][0]-50,captures
        assert abs(captures['restored'][0]-initial[0])<1,captures
        assert abs(captures['delta-frozen'][0]-initial[0])<1,captures
        assert abs(captures['entering'][0]-initial[0])<1,captures
        assert all(abs(c[1]-initial[1])<1 and abs(c[3]-initial[3])<10 for c in captures.values()),captures
    print(f'PASS: {frames} production Vulkan frames verify animated pixels, shared-model isolation, delta hold and node-end restoration/latch')


if __name__=='__main__':
    main()
