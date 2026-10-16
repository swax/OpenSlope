"""Production desktop contacts move a native physics body and its visible geometry."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from appearance_test import rgba


def fixture(root):
    def write(name, value): (root/name).write_text(json.dumps(value))
    patch=dict(PatchName='Rigid body test floor',SurfaceType=1,TrickOnlyPatch=False,
        Points=[[(u/3-.5)*200000,(v/3-.5)*200000,0] for u in range(4) for v in range(4)],
        UVPoints=[[0,0],[0,1],[1,0],[1,1]],TexturePath='',LightmapID=-1,LightMapPoint=[0,0,0,0])
    write('Patches.json',dict(Patches=[patch]))
    (root/'Meshes').mkdir(); (root/'Textures').mkdir()
    (root/'Textures/body.png').write_bytes(rgba(1,1,[220,30,90,255]))
    (root/'Meshes/body.obj').write_text(
        'v -60 0 60\nv 60 0 60\nv 0 -60 60\nv 0 60 60\nv 0 0 0\nv 0 0 120\n'
        'vt 0 0\nvt 1 0\nvt 0 1\n'
        'f 1/1 3/2 5/3\nf 3/1 2/2 5/3\nf 2/1 4/2 5/3\nf 4/1 1/2 5/3\n'
        'f 3/1 1/2 6/3\nf 2/1 3/2 6/3\nf 4/1 2/2 6/3\nf 1/1 4/2 6/3\n')
    write('Models.json',dict(Models=[dict(ModelObjects=[dict(ParentID=-1,
        MeshData=[dict(MeshPath='body.obj',MaterialID=0)])])]))
    write('Materials.json',dict(Materials=[dict(TexturePath='body.png')]))
    instances=[dict(ModelID=0,Location=[0,0,0],Visable=True,PlayerCollision=True,
        PlayerBounce=True,PlayerBounceAmmount=.2,U0=5,CollsionMode=3,PhysicsIndex=0,
        EffectSlotIndex=0,SurfaceType=-1,AmbentLightColour=[256,256,256]),
        dict(ModelID=0,Location=[0,-400,0],Visable=True,PlayerCollision=True,
        PlayerBounce=True,PlayerBounceAmmount=.2,U0=5,CollsionMode=3,PhysicsIndex=0,
        EffectSlotIndex=0,SurfaceType=-1,AmbentLightColour=[256,256,256])]
    write('Instances.json',dict(Instances=instances))
    body={f'UFloat{i}':0 for i in range(24)}
    body.update(UFloat2=60,UFloat5=60,U2=0,U3=0,UByteData='AA==',
        uPhysicsStruct0=[dict(U0=60,U1=0,U2=1)])
    for i in (6,10,14): body[f'UFloat{i}']=540
    for i in (15,19,23): body[f'UFloat{i}']=1/540
    write('Physics.json',dict(PhysicsHeaders=[dict(PhysicsDatas=[body])]))
    node=dict(mainType=0,payload=dict(type0=dict(SubType=0,
        type0Sub0=dict(U0=5,U1=.4,U2=.5,U3=0,U4=0,U5=0))),references={})
    write('Effects.json',dict(kind='openslope-effects',version=1,
        graphs=[dict(id='knock',nodes=[node])],functions=[],
        slots=[dict(id='slot:0',circumstances=dict(collision='knock'))]))


def red_geometry(picture):
    header=picture.read_bytes().split(b'\n',3)
    width,height=map(int,header[1].split());pixels=header[3]
    mask=[i for i,(r,g,b) in enumerate(zip(pixels[0::3],pixels[1::3],pixels[2::3]))
        if r>180 and g<60 and 50<b<120]
    return dict(count=len(mask),height=height,
        centre_y=sum(i//width for i in mask)/len(mask) if mask else None,
        clipped=any(i%width in (0,width-1) or i//width in (0,height-1) for i in mask))


def main():
    exe=str(Path(sys.argv[1]).resolve()); frames=0
    with tempfile.TemporaryDirectory(prefix='openslope-roller-') as temporary:
        root=Path(temporary);fixture(root)
        captures={}
        for foot in (False,True):
            for name,ticks in [('before',1),('hit',45),('settled',600)]:
                key=f'{"walk" if foot else "ride"}-{name}'
                steps=[dict(Ticks=ticks,Posture=1 if foot else 0,WalkForward=[1,0,0])]
                if foot and name=='settled':steps=[dict(Ticks=45,Posture=1,WalkForward=[1,0,0]),dict(Ticks=ticks-45)]
                replay=root/f'{key}.json';replay.write_text(json.dumps(dict(Schema='openslope-replay/v1',
                    Placement=dict(Position=[-3,-.005,.7 if foot else 0],Forward=[1,0,0],Velocity=[12,0,0]),Steps=steps)))
                picture=root/f'{key}.ppm'
                args=[exe,'--map',str(root),'--first-person','--replay',str(replay),'--capture',str(picture),'--no-audio']
                if foot:args.append('--on-foot')
                r=subprocess.run(args,capture_output=True,text=True,timeout=180)
                assert r.returncode==0,r.stdout+r.stderr
                assert 'unsupported 0;' in r.stdout,r.stdout
                geometry=red_geometry(picture);red=geometry['count']
                position=re.search(r'; position \[([^,]+),([^,]+),([^\]]+)\]',r.stdout)
                body_position=None
                if name=='before':
                    assert 'Dynamic props: 0 bodies;' in r.stdout,r.stdout
                    assert red>100,(red,r.stdout)
                else:
                    assert 'Dynamic props: 1 bodies;' in r.stdout,r.stdout
                    pose=re.search(r'Dynamic pose: instance 0; translation \[([^,]+),([^,]+),([^\]]+)\]',r.stdout)
                    assert pose,r.stdout
                    assert abs(float(pose[1]))>.15,(key,pose.groups(),r.stdout)
                    body_position=tuple(float(pose[i]) for i in (1,2,3))
                    if name=='settled':assert 'Dynamic props: 1 bodies; 1 sleeping' in r.stdout,(key,r.stdout)
                captures[key]=(geometry,tuple(float(position[i]) for i in (1,2,3)),body_position)
                frames+=ticks
        hit,hit_position,hit_body=captures['walk-hit']; settled,settled_position,settled_body=captures['walk-settled']
        assert max(abs(a-b) for a,b in zip(hit_position,settled_position))<1e-5,(hit_position,settled_position)
        assert hit['count']>200,hit
        assert settled_body[0]>hit_body[0]+.15,(hit_body,settled_body)
        if hit['clipped'] and settled['count']:
            # A close body clipped by the screen can occupy more pixels as it moves fully into view.
            # With this fixed camera, moving away must move its silhouette up and clear the edges.
            assert not settled['clipped'] and hit['centre_y']-settled['centre_y']>hit['height']*.1,(
                'clipped fixed-camera body silhouette did not move away',hit,settled)
        else:
            assert settled['count']<hit['count']*.75,('fixed-camera body pixels did not move away',hit,settled)
    print(f'PASS: {frames} actual Vulkan frames verify walking/riding impact, visible native body motion, shared-model isolation and settled state')


if __name__=='__main__': main()
