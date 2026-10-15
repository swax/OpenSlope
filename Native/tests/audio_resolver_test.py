"""Authored ISO/ELF collision-route import with configured bank joins."""
from pathlib import Path
import hashlib,json,struct,subprocess,sys,tempfile
from audio_import_test import disc,fixture
from world_import_fixture import boot_files,executable
from audio_resolver_fixture import boot_program,program,expected

def main():
    cli=str(Path(sys.argv[1]).resolve());checks=0
    with tempfile.TemporaryDirectory(prefix='openslope-audio-resolver-') as temporary:
        root=Path(temporary)
        def run(elf,good=True):
            nonlocal checks
            iso=root/'test.iso';iso.write_bytes(disc(boot_files(elf)));before=hashlib.sha256(iso.read_bytes()).digest()
            p=subprocess.run([cli,'collision-routes',str(iso)],capture_output=True,text=True,timeout=30)
            assert (p.returncode==0)==good,p.stdout+p.stderr
            assert hashlib.sha256(iso.read_bytes()).digest()==before
            checks+=1;return json.loads(p.stdout) if good else None
        for base,offset in [(0x600000,512),(0x1900000,4096),(0x2400000,1024)]:
            assert run(boot_program(base,offset))==dict(SourceExecutable='BOOT.ELF',Events=expected())
        for helper in (False,True):assert run(boot_program(helper=helper,world=True))['Events']==expected()
        code=program();duplicate=program(prefix=code);assert run(executable(duplicate,base=0x600000))['Events']==expected()
        different=program(prefix=code,seed=1);run(executable(different,base=0x600000),False)
        run(boot_program(unknown=True),False);run(boot_program(outside=True),False)
        run(executable(),False);run(boot_program()[:40],False)
        for event in (0,5,10,100,1023):assert str(event) not in run(boot_program())['Events']
        # Full normal import joins the recovered group to this disc's configured banks.
        files=fixture();files.update(boot_files(boot_program()));iso=root/'import.iso';iso.write_bytes(disc(files));maps=root/'Maps'
        p=subprocess.run([cli,'extract',str(iso),'FIXTURE',str(maps)],capture_output=True,text=True,timeout=30);assert p.returncode==0,p.stdout+p.stderr
        index=json.loads((maps/'FIXTURE/Audio/SoundIndex.json').read_text());assert index['SourceExecutable']=='BOOT.ELF' and 'ResolverState' not in index
        want={event:dict(**row,Bank='tone',Clip=f"Audio/SFX/tone/{row['Slot']:03d}.wav") for event,row in expected().items() if row['Group']!=6}
        assert index['CollisionEvents']==want
        assert 'executable-event-resolver' not in json.loads((maps/'FIXTURE/Audio/Import.json').read_text())['Deferred']
        assert (maps/'FIXTURE/Audio/SFX/tone/000.wav').is_file() and not (maps/'FIXTURE/Audio/SFX/tone/016.wav').exists(),'Empty slots acquire no fallback audio'
        checks+=1
        files.update(boot_files(boot_program(unknown=True)));iso.write_bytes(disc(files));maps=root/'unsupported'
        p=subprocess.run([cli,'extract',str(iso),'FIXTURE',str(maps)],capture_output=True,text=True,timeout=30);assert p.returncode==0,p.stdout+p.stderr
        index=json.loads((maps/'FIXTURE/Audio/SoundIndex.json').read_text());assert index['CollisionEvents']=={} and index['ResolverState']=='Deferred';checks+=1
        assert 'executable-event-resolver' in json.loads((maps/'FIXTURE/Audio/Import.json').read_text())['Deferred']
        if len(sys.argv)>2:
            source=root/'fixture.elf';source.write_bytes(boot_program());p=subprocess.run([str(Path(sys.argv[2]).resolve()),str(source)],capture_output=True,text=True,timeout=30);assert p.returncode==0,p.stdout+p.stderr;print(p.stdout.strip())
    print(f'PASS: {checks} authored collision-resolver cases cover ABI, indirect dispatch, delayed stores, nested calls, silent/empty slots, relocation, ambiguity and normal ISO bank joins')
if __name__=='__main__':main()
