"""Synthetic glare art/profile fixtures for the actual Vulkan renderer."""
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
from appearance_test import rgba

with tempfile.TemporaryDirectory(prefix='openslope-celestial-gpu-') as temporary:
    root=Path(temporary)
    for name in ['fallback','atlas']:
        folder=root/name;folder.mkdir()
        glare=dict(Enabled=True,CoreColour=[255,160,70],FanIntensity=.37,RimColour=[110,70,30],SpriteIntensity=.45,
                   AzimuthDegrees=90,ElevationDegrees=0,DistanceUnits=24000,SizeUnits=7200)
        (folder/'World.json').write_text(json.dumps(dict(Schema='openslope-world/v1',SkyColor=[2,3,4],Fog=dict(Enabled=False),Glare=glare)))
        if name=='atlas':
            (folder/'Textures/Particles').mkdir(parents=True)
            palette=[[255,0,0,255],[0,255,0,255],[0,0,255,255],[255,0,255,255]]
            pixels=sum((palette[(y//2)*2+x//2] for y in range(4) for x in range(4)),[])
            (folder/'Textures/Particles/lens.png').write_bytes(rgba(4,4,pixels))
    folder=root/'lamps-atlas';(folder/'Textures/Particles').mkdir(parents=True)
    pixels=[]
    for y in range(128):
        for x in range(128):
            dx=((x%64)+.5)/32-1;dy=((y%64)+.5)/32-1;r=math.hypot(dx,dy)
            if x<64 and y<64:
                rgb=[255,0,0];a=math.exp(-100*(r-.88)**2) if r<1 else 0
            elif y<64:
                rgb=[0,255,0];a=math.exp(-5*r*r) if r<1 else 0
            elif x<64:
                rgb=[0,0,255];a=math.exp(-80*min(dx*dx,dy*dy)) if r<1 else 0
            else:
                rgb=[255,0,255];a=1
            pixels+=rgb+[round(a*255)]
    (folder/'Textures/Particles/lens.png').write_bytes(rgba(128,128,pixels))
    folder=root/'lamps-invalid-atlas';(folder/'Textures/Particles').mkdir(parents=True)
    (folder/'Textures/Particles/lens.png').write_bytes(rgba(1,1,[0,255,0,255]))
    subprocess.run([str(Path(sys.argv[1]).resolve()),str(root)],check=True)
