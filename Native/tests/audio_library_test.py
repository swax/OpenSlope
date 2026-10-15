"""Shared-bank selection and actual public exports through the production audio host."""
from pathlib import Path
import json,shutil,subprocess,sys,tempfile
from audio_scene_test import fixture,tone,write,rms
from board_performance_replay_test import run,window,frequency


def main():
    exe=Path(sys.argv[1]).resolve(); frames=0
    with tempfile.TemporaryDirectory(prefix='openslope-audio-library-') as temp:
        base=Path(temp); root=base/'Custom';fixture(root,mass=0)
        place=dict(Position=[5,-.005,0],Forward=[1,0,0],Velocity=[12,0,0]);steps=[dict(Ticks=40)]
        shared=base/'Shared';tone(shared/'Audio/SFX/ZBOARD/004.WAV',440,1)
        data,report=run(exe,root,steps,place);frames+=40
        assert rms(window(data,.2,.6))>500 and abs(frequency(data,.2,.6)-440)<5,report
        tone(root/'Audio/SFX/zboard/004.wav',880,1)
        data,report=run(exe,root,steps,place);frames+=40
        assert abs(frequency(data,.2,.6)-880)<5,'Local common-bank clip did not win'
        write(root/'Slopesmith.json',dict(schema=1,kind='slopesmith-export',boardSound=dict(volume=.4)))
        quiet,report=run(exe,root,steps,place);frames+=40
        assert abs(rms(window(quiet,.2,.6))/rms(window(data,.2,.6))-.5)<.002,'Portable authored mix was lost'
        write(root/'Slopesmith.json',dict(schema=1,kind='slopesmith-export',boardSound=dict(enabled='false',volume='bad')))
        defaults,report=run(exe,root,steps,place);frames+=40;assert defaults==data,'Malformed mix types did not use the defaults'
        write(root/'Audio/BoardMix.json',dict(schema='openslope-board-mix/v1',boardSound=dict(enabled=False)))
        muted,report=run(exe,root,steps,place);frames+=40;assert rms(muted)==0,'Explicit local mix did not override exported mix'
        (root/'Audio/BoardMix.json').unlink();(root/'Slopesmith.json').unlink()
        write(root/'Audio/SoundIndex.json',dict(Schema='openslope-sound-index/v1',Banks={'1':'missing-custom-bank'},CollisionEvents={}))
        muted,report=run(exe,root,steps,place);frames+=40;assert rms(muted)==0,'A named custom bank borrowed an unrelated bank'
        (root/'Audio/SoundIndex.json').unlink();shutil.rmtree(root/'Audio');shutil.rmtree(shared)
        donor=base/'OlderImport';fixture(donor,mass=0);tone(donor/'Audio/SFX/zboard/004.wav',660,1)
        write(donor/'Audio/BoardSoundIndex.json',dict(Schema='openslope-board-sound-index/v1',SurfaceGroups=[1]*20))
        tone(donor/'Audio/SFX/zboard/012.wav',550,1)
        data,report=run(exe,root,steps,place);frames+=40
        assert abs(frequency(data,.2,.6)-550)<5,'Existing course bank or its surface routing was not found'
        # Actual public API export, including canonical prop geometry and custom WAVs.
        exported=base/'Exported';repository=Path(__file__).resolve().parents[2]
        p=subprocess.run(['node','--import','tsx',str(repository/'tools/authored-audio-export-fixture.mts'),str(exported)],cwd=repository/'Slopesmith',capture_output=True,text=True,timeout=60)
        assert p.returncode==0,p.stdout+p.stderr
        shutil.copy2(root/'Patches.json',exported/'Patches.json')
        canonical=json.loads((exported/'Instances.json').read_text());write(exported/'Instances.json',dict(Instances=[]))
        exported_mix=json.loads((exported/'Slopesmith.json').read_text())
        authored,report=run(exe,exported,steps,place);frames+=40
        louder=dict(exported_mix);louder['boardSound']=dict(louder['boardSound'],volume=.8);write(exported/'Slopesmith.json',louder)
        comparison,report=run(exe,exported,steps,place);frames+=40
        assert abs(rms(window(authored,.2,.6))/rms(window(comparison,.2,.6))-.5)<.002,'Actual public export mix did not reach PCM'
        write(exported/'Slopesmith.json',exported_mix)
        # Exercise event links without canonical per-instance clip overrides masking them.
        import copy
        linked=copy.deepcopy(canonical)
        for row in linked['Instances']:
            row.pop('SoundClip',None)
            for emitter in (row.get('Sounds') or {}).get('ExternalSounds',[]):emitter.pop('SoundClip',None)
        write(exported/'Instances.json',linked)
        data,report=run(exe,exported,[dict(Ticks=30)],dict(Position=[-2,-.005,0],Forward=[1,0,0],Velocity=[12,0,0]));frames+=30
        assert 'contact sounds 1' in report and 'ambient voices 1' in report,report
        assert rms(data)>200,report
        write(exported/'Instances.json',canonical)
        # Separate the exported ambient source from board loops for frequency proof.
        (exported/'Slopesmith.json').write_text(json.dumps(dict(schema=1,kind='slopesmith-export',boardSound=dict(enabled=False))))
        data,report=run(exe,exported,steps,dict(Position=[10,5,0],Forward=[1,0,0],Velocity=[0,0,0]));frames+=40
        assert abs(frequency(data,.2,.6)-660)<5,report
        # The off-board environment bed fades in; mounting removes it again.
        rows=json.loads((exported/'Instances.json').read_text());rows['Instances']=[];write(exported/'Instances.json',rows)
        replay=exported/'input.json';write(replay,dict(Schema='openslope-replay/v1',Placement=dict(Position=[5,0,0],Forward=[0,0,-1]),Steps=[dict(Ticks=120)]))
        import wave,struct
        def offboard(steps):
            write(replay,dict(Schema='openslope-replay/v1',Placement=dict(Position=[5,0,0],Forward=[0,0,-1]),Steps=steps))
            p=subprocess.run([str(exe),'--map',str(exported),'--on-foot','--replay',str(replay),'--capture',str(exported/'frame.ppm'),'--audio-capture',str(exported/'mix.wav')],capture_output=True,text=True,timeout=120)
            assert p.returncode==0,p.stdout+p.stderr
            with wave.open(str(exported/'mix.wav')) as w:return struct.unpack('<'+str(w.getnframes()*2)+'h',w.readframes(w.getnframes()))[::2],p.stdout
        data,report=offboard([dict(Ticks=120)]);frames+=120
        assert abs(frequency(data,1.6,1.9)-110)<5 and rms(window(data,1.6,1.9))>100,report
        data,report=offboard([dict(Ticks=120),dict(Ticks=1,Mount=True),dict(Ticks=120)]);frames+=241
        assert 'Boarding: on foot 0' in report and rms(window(data,3.7,4))==0,'Mounting did not fade out the environment bed: '+report
        write(exported/'Audio/Environment.json',dict(Schema='openslope-environment-audio/v1',Bed=None))
        data,report=offboard([dict(Ticks=40)]);frames+=40;assert rms(data)==0,'Authored environment off is audible'
    print(f'PASS: {frames} production Vulkan/PCM frames verify shared/local/sibling banks, portable mix, authored impacts/ambience and off-board environment')

if __name__=='__main__':main()
