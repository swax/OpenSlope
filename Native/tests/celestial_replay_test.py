"""Exercise portable world glare through the real desktop fixed-tick host."""
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile

executable=Path(sys.argv[1]).resolve()
write=lambda p,v:p.write_text(json.dumps(v))
with tempfile.TemporaryDirectory(prefix='openslope-celestial-replay-') as temporary:
    root=Path(temporary);images={};logs={};frames=0
    def patch(name,wall=False):
        # Native raw axes are X,Y horizon and Z height.
        points=[[-5000+10000*u/3,500 if wall else -5000+10000*v/3,-3000+6000*v/3 if wall else -2000] for u in range(4) for v in range(4)]
        return dict(PatchName=name,SurfaceType=1,TrickOnlyPatch=False,Points=points,TexturePath='',LightmapID=-1,LightMapPoint=[0,0,0,0],UVPoints=[[0,0],[1,0],[0,1],[1,1]])
    for name in ['open','off','behind','occluded','clear-of-wall']:
        course=root/name;course.mkdir()
        patches=[patch('Authored distant floor')]
        if name in ['occluded','clear-of-wall']:patches.append(patch('Authored horizon wall',True))
        write(course/'Patches.json',dict(Patches=patches))
        glare=dict(Enabled=name!='off',CoreColour=[255,200,100],FanIntensity=.37,RimColour=[200,160,100],SpriteIntensity=.45,
                   AzimuthDegrees=90,ElevationDegrees=0,DistanceUnits=24000,SizeUnits=7200)
        write(course/'World.json',dict(Schema='openslope-world/v1',SkyColor=[15,25,40],Fog=dict(Enabled=False),Glare=glare))
        write(course/'replay.json',dict(Schema='openslope-replay/v1',Placement=dict(Position=[0,0,-7 if name=='clear-of-wall' else 0],Forward=[0,0,1 if name=='behind' else -1]),Steps=[dict(Ticks=60)]))
        picture=course/'frame.ppm'
        p=subprocess.run([str(executable),'--map',str(course),'--replay',str(course/'replay.json'),'--capture',str(picture),'--on-foot','--first-person','--no-audio'],capture_output=True,text=True,timeout=120)
        assert p.returncode==0,p.stdout+p.stderr
        logs[name]=p.stdout;images[name]=picture.read_bytes().split(b'\n',3)[3];frames+=60
        count=re.search(r'Celestial: (\d+) triangles; (\d+) draws',p.stdout)
        assert count,p.stdout
        if name in ['open','clear-of-wall']:assert int(count[1])>=34 and int(count[2])==2,p.stdout
        else:assert count[1]=='0' and count[2]=='0',p.stdout
    changed=sum(images['open'][i:i+3]!=images['off'][i:i+3] for i in range(0,len(images['open']),3))
    assert changed>20000,changed
    for pattern in [r'position \[([^\]]+)\]',r'velocity \[([^\]]+)\]']:
        assert re.search(pattern,logs['open'])[1]==re.search(pattern,logs['off'])[1],'Glare changed rider physics'
print(f'PASS: {frames} production Vulkan frames verify course enable, front/behind projection, terrain visibility and unchanged physics ({changed} affected pixels)')
