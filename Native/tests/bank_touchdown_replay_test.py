"""Bank and tilted-deck touchdowns restore ground controls and board PCM in the player."""
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import struct
import wave
from audio_scene_test import tone, write, rms


def main():
    executable=Path(sys.argv[1]).resolve();frames=0
    with tempfile.TemporaryDirectory(prefix='openslope-bank-touchdown-') as temporary:
        base=Path(temporary)
        cases=[(0,75,False,False),(20,75,True,False),(70,0,False,False),(70,0,True,False),
            (45,75,False,True),(70,0,True,True)]
        for index,(degrees,roll,downhill,ascending) in enumerate(cases):
            root=base/str(index);root.mkdir()
            slope=math.tan(math.radians(degrees));size=math.sqrt(1+slope*slope)
            normal=[-slope/size,1/size,0]
            forward=[-1/size,-slope/size,0] if downhill else [0,0,-1]
            angle=math.radians(roll);c=math.cos(angle);s=math.sin(angle)
            up=[-forward[2]*s+forward[0]*forward[1]*(1-c),c+forward[1]*forward[1]*(1-c),
                forward[0]*s+forward[2]*forward[1]*(1-c)]
            patches=[]
            for spawn in [False,True]:
                points=[]
                for u in range(4):
                    for v in range(4):
                        x,y,z=(10000+u,2000,10000+v) if spawn else ((u/3-.5)*2000,slope*(u/3-.5)*2000,(v/3-.5)*2000)
                        points.append([100*x,-100*z,100*y])
                patches.append(dict(PatchName='Authored touchdown spawn' if spawn else 'Authored touchdown bank',
                    SurfaceType=1,TrickOnlyPatch=False,Points=points,TexturePath='',LightmapID=-1,
                    LightMapPoint=[0,0,0,0],UVPoints=[[0,0],[1,0],[0,1],[1,1]]))
            write(root/'Patches.json',dict(Patches=patches))
            tone(root/'Audio/SFX/test/003.wav');tone(root/'Audio/SFX/test/003.loop.wav')
            write(root/'Audio/SoundIndex.json',dict(Schema='openslope-sound-index/v1',Banks={'1':'test'},CollisionEvents={}))
            write(root/'Audio/BoardSoundIndex.json',dict(Schema='openslope-board-sound-index/v1',SurfaceGroups=[0]*20))
            uphill=[slope/size, slope*slope/size, 0]
            uphill_length=math.sqrt(sum(x*x for x in uphill))
            if uphill_length:uphill=[x/uphill_length for x in uphill]
            write(root/'replay.json',dict(Schema='openslope-replay/v1',Placement=dict(
                Position=[n*.5 for n in normal],Forward=forward,Up=up,
                Velocity=[f*8-n*3+(u*18 if ascending else 0) for f,n,u in zip(forward,normal,uphill)]),
                Steps=[dict(Ticks=120,Steer=.25)]))
            result=subprocess.run([str(executable),'--map',str(root),'--replay',str(root/'replay.json'),
                '--capture',str(root/'frame.ppm'),'--audio-capture',str(root/'mix.wav'),
                '--render-scale','100','--msaa','1','--snow','0'],capture_output=True,text=True,timeout=120)
            assert result.returncode==0,result.stdout+result.stderr
            assert '; grounded 1;' in result.stdout,(degrees,roll,downhill,result.stdout)
            assert '; landings 1;' in result.stdout,(degrees,roll,downhill,result.stdout)
            assert '; wipeout 0;' in result.stdout,result.stdout
            with wave.open(str(root/'mix.wav')) as audio:
                assert audio.getnchannels()==2 and audio.getframerate()==48000 and audio.getnframes()==120*800
                samples=struct.unpack('<'+str(audio.getnframes()*2)+'h',audio.readframes(audio.getnframes()))
            assert rms(samples[-48000:])>200,('Carve loop did not resume after touchdown',degrees,roll,downhill,result.stdout)
            frames+=120
    print(f'PASS: {frames} production Vulkan/PCM frames verify flat, downhill and rising bank touchdowns with tilted decks and restored ground sound')


if __name__=='__main__':main()
