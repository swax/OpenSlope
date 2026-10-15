"""Synthetic glare art/profile fixtures for the actual Vulkan renderer."""
import json
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
    subprocess.run([str(Path(sys.argv[1]).resolve()),str(root)],check=True)
