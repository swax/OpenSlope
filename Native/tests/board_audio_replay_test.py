"""ISO-recovered board routes through the actual desktop mixer and Vulkan host."""
import json,re,shutil,subprocess,sys,tempfile
from pathlib import Path
from audio_scene_test import fixture,tone,capture,rms,write
from audio_import_test import disc,fixture as audio_fixture
from board_groups_fixture import boot_program
from world_import_fixture import boot_files

def main():
    player=Path(sys.argv[1]).resolve();importer=Path(sys.argv[2]).resolve();frames=0
    with tempfile.TemporaryDirectory(prefix='openslope-board-audio-replay-') as temporary:
        base=Path(temporary);files=audio_fixture();files.update(boot_files(boot_program()));iso=base/'authored.iso';iso.write_bytes(disc(files))
        p=subprocess.run([str(importer),'extract',str(iso),'FIXTURE',str(base/'Maps')],capture_output=True,text=True,timeout=30);assert p.returncode==0,p.stdout+p.stderr
        imported=base/'Maps/FIXTURE/Audio';root=base/'play';fixture(root,mass=0);(root/'Audio').mkdir()
        shutil.copy2(imported/'SoundIndex.json',root/'Audio/SoundIndex.json');recovered=json.loads((imported/'BoardSoundIndex.json').read_text())
        families=['PACK','POWDER','LOOSE','ICE','METAL','WOOD','RAIL','ROCK','GLASS','CHUTE']
        for group in range(10):
            frequency=220+70*group;slot=f'{group*8+4:03d}'
            tone(root/f'Audio/SFX/tone/{slot}.wav',frequency,1);tone(root/f'Audio/SFX/tone/{slot}.loop.wav',frequency,1)
        (root/'Audio/SNOW.INF').write_text(''.join(f'[{name}]\n[GLIDE]\nLoad 100\nAssignVol\nLoad 0\nAssignBend\n' for name in families))
        reports=[]
        for name,group in [('imported',recovered['SurfaceGroups'][1]),('fallback',0),('override',7),('shared',recovered['SurfaceGroups'][1])]:
            local=root/'Audio/BoardSoundIndex.json'
            if name=='imported':shutil.copy2(imported/'BoardSoundIndex.json',local)
            elif name=='fallback':local.unlink()
            elif name=='override':write(local,dict(Schema='openslope-board-sound-index/v1',SourceExecutable='Authored override',SurfaceGroups=[7]*20))
            else:
                local.unlink();shared=base/'Shared/Audio/BoardSoundIndex.json';shared.parent.mkdir(parents=True);shutil.copy2(imported/'BoardSoundIndex.json',shared)
            samples,report=capture(player,root,30,dict(Position=[5,-.005,0],Forward=[1,0,0],Velocity=[12,0,0]));reports.append(report);frames+=30
            window=samples[::2][round(.12*48000):round(.4*48000)];frequency=sum(a<=0<b for a,b in zip(window,window[1:]))/.28
            assert rms(window)>500 and abs(frequency-(220+70*group))<8,(name,group,frequency,rms(window),report)
        for pattern in (r'position \[([^\]]+)\]',r'velocity \[([^\]]+)\]'):assert len({re.search(pattern,report)[1] for report in reports})==1,'Routing changed physics'
    print(f'PASS: {frames} production Vulkan/PCM frames verify imported family selection, PACK fallback, authored override, shared index and unchanged physics')
if __name__=='__main__':main()
