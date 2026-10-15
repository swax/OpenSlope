from gear_pixels import board_pixel
"""Actual-host analytic grinding with a visible, solid tube authored here."""
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from desktop_collision_test import write


def point(controls,t):
    return tuple((1-t)**3*a+3*(1-t)**2*t*b+3*(1-t)*t*t*c+t**3*d for a,b,c,d in zip(*controls))


def raw(p): return [p[0]*100,-p[2]*100,p[1]*100]


def fixture(root,curved=False,length=100):
    root.mkdir(); (root/'Meshes').mkdir(); (root/'Collision').mkdir()
    controls=[(0,1.5,0),(0,1.5,-length/3),(length*.4 if curved else 0,1.5,-length*2/3),(length*.4 if curved else 0,1.5,-length)]
    write(root/'Splines.json',dict(Splines=[dict(SplineName='Authored tube',U0=-123,U1=1,SplineStyle=13,Segments=[dict(Points=[raw(p) for p in controls])])]))
    write(root/'Patches.json',dict(Patches=[dict(PatchName='Authored rail floor',SurfaceType=1,TrickOnlyPatch=False,
          Points=[[(u/3-.5)*80000,(v/3-.5)*80000,0] for u in range(4) for v in range(4)],
          TexturePath='',LightmapID=-1,LightMapPoint=[0,0,0,0],UVPoints=[[0,0],[1,0],[0,1],[1,1]])]))
    vertices=[]; faces=[]
    for i in range(65):
        p=point(controls,i/64)
        for j in range(8):
            angle=j*math.pi/4;vertices.append(raw((p[0]+.06*math.cos(angle),p[1]-.08+.06*math.sin(angle),p[2])))
    for i in range(64):
        for j in range(8):
            a=i*8+j+1;b=i*8+(j+1)%8+1;c=(i+1)*8+(j+1)%8+1;d=(i+1)*8+j+1
            faces.extend([(a,b,c),(a,c,d)])
    rows=['v '+' '.join(map(str,p)) for p in vertices]
    for a,b,c in faces:
        p,q,r=vertices[a-1],vertices[b-1],vertices[c-1];u=[y-x for x,y in zip(p,q)];v=[y-x for x,y in zip(p,r)]
        n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];m=math.sqrt(sum(x*x for x in n))
        rows.append('vn '+' '.join(str(x/m) for x in n))
    rows.extend('f '+' '.join(f'{v}//{i+1}' for v in f) for i,f in enumerate(faces))
    mesh='\n'.join(rows)+'\n';(root/'Meshes/tube.obj').write_text(mesh);(root/'Collision/tube.obj').write_text(mesh)
    write(root/'Models.json',dict(Models=[dict(ModelObjects=[dict(ParentID=-1,MeshData=[dict(MeshPath='tube.obj',MaterialID=0)])])]))
    write(root/'Materials.json',dict(Materials=[dict(TexturePath=None)]))
    write(root/'Instances.json',dict(Instances=[dict(ModelID=0,Visable=True,CollsionMode=1,CollsionModelPaths=['tube.obj'],
          PlayerCollision=True,PlayerBounce=True,PlayerBounceAmmount=.5,U0=1,SurfaceType=-1)]))


def main():
    executable=Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-desktop-rails-') as temporary:
        base=Path(temporary)
        for name in ('flat-spin','quick-spin','quick-reverse','release-spin','curved','backward-boost','jump','exit','end'):
            root=base/name;fixture(root,name=='curved',8 if name=='end' else 100)
            placement=dict(Position=[0,1.55,-1],Forward=[0,0,-1],Velocity=[0,0,-12]);steps=[dict(Ticks=180,Steer=1 if name=='flat-spin' else 0)]
            if name=='backward-boost':placement.update(Position=[0,1.55,-50],Forward=[0,0,1],Velocity=[0,0,12]);steps=[dict(Ticks=60,Boost=True)]
            if name=='quick-spin':steps=[dict(Ticks=1),dict(Ticks=6,Steer=1)]
            if name=='quick-reverse':steps=[dict(Ticks=1),dict(Ticks=20,Steer=1),dict(Ticks=40,Steer=-1)]
            if name=='release-spin':steps=[dict(Ticks=1),dict(Ticks=20,Steer=1),dict(Ticks=20)]
            if name=='jump':steps=[dict(Ticks=1),dict(Ticks=24,Jump=True),dict(Ticks=8)]
            if name=='exit':steps=[dict(Ticks=30),dict(Ticks=1,RailExit=True)]
            write(root/'replay.json',dict(Schema='openslope-replay/v1',Placement=placement,Steps=steps))
            image=root/'frame.ppm';result=subprocess.run([str(executable),'--map',str(root),'--replay',str(root/'replay.json'),
                  '--capture',str(image),'--no-audio'],text=True,capture_output=True,timeout=90)
            assert result.returncode==0,result.stdout+result.stderr
            rails=re.search(r'Rails: (\d+) grinds; (\d+) transfers; (\d+) exits; on rail (\d+); spin ([\d.-]+) deg',result.stdout)
            assert rails,result.stdout
            grinds,transfers,exits,attached=map(int,rails.groups()[:4]);spin=float(rails.group(5))
            assert grinds==1 and 'hard impacts 0' in result.stdout,result.stdout
            if name in ('flat-spin','quick-spin','quick-reverse','release-spin','curved','backward-boost'):assert attached==1 and exits==0 and 'bounces 0' in result.stdout,result.stdout
            else:assert attached==0 and exits==1,result.stdout
            if name=='flat-spin':assert spin==80,result.stdout
            if name=='quick-spin':assert spin==24,result.stdout
            if name=='quick-reverse':assert spin==-80,result.stdout
            if name=='release-spin':assert spin==0,result.stdout
            if name=='jump':assert 'launches 1' in result.stdout,result.stdout
            if name=='exit':assert float(re.search(r'velocity \[([^\]]+)\]',result.stdout).group(1).split(',')[2])< -11,'Exit lost carried tangent speed'
            if name=='curved':
                position=re.search(r'position \[([^\]]+)\]',result.stdout).group(1)
                assert float(position.split(',')[0])>4,'Curve travel never changed direction'
            pixels=image.read_bytes().split(b'\n',3);assert pixels[:3]==[b'P6',b'1280 720',b'255']
            board=sum(board_pixel(pixels[3][i:i+3]) for i in range(0,len(pixels[3]),3))
            assert board>25,f'{name}: board not visible ({board} pixels)'
            print(f'PASS: desktop {name} rail ({sum(s["Ticks"] for s in steps)} rendered frames, {board} board pixels; solid tube admits grind)')


if __name__=='__main__': main()
