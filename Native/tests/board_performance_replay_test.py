"""Authored board performance through production Vulkan/PCM, without disc programs."""
from pathlib import Path
import json,re,subprocess,sys,tempfile,wave,struct
from audio_scene_test import fixture,tone,write,rms
from desktop_rails_test import fixture as rail_fixture

def run(exe,root,steps,placement,mode=None):
    write(root/'input.json',dict(Schema='openslope-replay/v1',Placement=placement,Steps=steps))
    args=[str(exe),'--map',str(root),'--replay',str(root/'input.json'),'--capture',str(root/'frame.ppm'),'--audio-capture',str(root/'mix.wav')]
    if mode:args+=['--mode',mode]
    p=subprocess.run(args,capture_output=True,text=True,timeout=120)
    assert p.returncode==0,p.stdout+p.stderr
    with wave.open(str(root/'mix.wav')) as w: data=struct.unpack('<'+str(w.getnframes()*2)+'h',w.readframes(w.getnframes()))
    return data[::2],p.stdout

def window(data,a,b):return data[round(a*48000):round(b*48000)]
def frequency(data,a,b):
    v=window(data,a,b);return sum(x<=0<y for x,y in zip(v,v[1:]))/(b-a)
def bank(root,slots):
    write(root/'Audio/SoundIndex.json',dict(Schema='openslope-sound-index/v1',Banks={'0':'main','1':'board'},CollisionEvents={}))
    for group,slot,hz in slots:tone(root/f'Audio/SFX/{group}/{slot:03}.wav',hz,1)

def main():
    exe=Path(sys.argv[1]).resolve();frames=0
    with tempfile.TemporaryDirectory(prefix='openslope-board-performance-') as temporary:
        base=Path(temporary);root=base/'ground';fixture(root,mass=0)
        bank(root,[('board',4,440)])
        # No loop sidecar and no sound expression are required by the authored bed.
        place=dict(Position=[5,-.005,0],Forward=[1,0,0],Velocity=[12,0,0]);steps=[dict(Ticks=40)]
        plain,report=run(exe,root,steps,place);frames+=40
        assert rms(window(plain,.2,.6))>500,report
        assert abs(frequency(plain,.2,.6)-440)<5,report
        (root/'Audio/SNOW.INF').write_text('Invalid obsolete expression content must not drive the authored bed')
        repeat,again=run(exe,root,steps,place);frames+=40
        assert plain==repeat,'An expression file changed the authored performance'
        write(root/'Audio/BoardMix.json',dict(schema='openslope-board-mix/v1',boardSound=dict(volume=.4)))
        quiet,quiet_report=run(exe,root,steps,place);frames+=40
        assert abs(rms(window(quiet,.2,.6))/rms(window(plain,.2,.6))-.5)<.002,'Authored volume is not a linear trim'
        write(root/'Audio/BoardMix.json',dict(schema='openslope-board-mix/v1',boardSound=dict(enabled=False)))
        muted,muted_report=run(exe,root,steps,place);frames+=40
        assert rms(muted)==0,'Disabled board mix is audible'
        for pat in (r'position \[([^]]+)\]',r'velocity \[([^]]+)\]'):
            assert len({re.search(pat,s)[1] for s in [report,again,quiet_report,muted_report]})==1,'Audio mix changed physics'
        root=base/'rail';rail_fixture(root);bank(root,[('board',52,880),('board',1,1100)])
        data,report=run(exe,root,[dict(Ticks=40)],dict(Position=[0,1.55,-1],Forward=[0,0,-1],Velocity=[0,0,-12]));frames+=40
        assert 'on rail 1' in report and 'transients 0' in report,report
        assert rms(window(data,.3,.6))>300 and abs(frequency(data,.3,.6)-880)<6,report
        root=base/'boost';fixture(root,mass=0);bank(root,[('main',120,600)])
        data,report=run(exe,root,[dict(Ticks=60,Boost=True),dict(Ticks=30)],place);frames+=90
        assert 'transients 0' in report,'Boost started a duplicate one-shot: '+report
        assert abs(rms(window(data,.1,.3))/rms(window(data,.8,.95))-2)<.03,'Boost lacks punch/sustain handoff'
        assert rms(window(data,1.3,1.5))==0,'Released boost did not stop'
        root=base/'jump';fixture(root,mass=0);bank(root,[('board',2,1320)])
        data,report=run(exe,root,[dict(Ticks=24,Jump=True),dict(Ticks=20)],place);frames+=44
        assert 'launches 1' in report and 'transients 1' in report and rms(data)>200,report
        root=base/'air';fixture(root,mass=0);bank(root,[('board',2,1320)])
        data,report=run(exe,root,[dict(Ticks=30)],dict(Position=[5,60,0],Forward=[1,0,0],Velocity=[12,0,0]));frames+=30
        assert rms(data)==0 and 'transients 0' in report,'Uncharged flight played an ollie: '+report
        bank(root,[('main',32,1000)])
        data,report=run(exe,root,[dict(Ticks=30)],dict(Position=[5,60,0],Forward=[1,0,0],Velocity=[12,0,0]));frames+=30
        assert rms(window(data,.2,.5))>500 and abs(frequency(data,.2,.5)-1000)<6,'Long-flight spawn did not start predicted big-air wind: '+report
        root=base/'expired';fixture(root,mass=0);bank(root,[('main',120,600),('main',121,600),('main',122,600)])
        write(root/'Slopesmith.json',dict(schema=1,kind='slopesmith-export',showoffSeconds=.1))
        data,report=run(exe,root,[dict(Ticks=210,Boost=True),dict(Ticks=60)],place,'showoff');frames+=270
        assert rms(data)>50,'Timed run never exercised boost: '+report
        assert rms(window(data,4,4.5))==0,'Boost remained latched after run expiry and release: '+report
    print(f'PASS: {frames} production Vulkan/PCM frames verify authored bed, no-program/full-loop fallback, mix, unchanged physics, rail handoff, boost envelope, launch-only pop and initial-air wind')
if __name__=='__main__':main()
