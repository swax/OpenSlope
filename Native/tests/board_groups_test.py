"""Synthetic ISO/ELF -> portable board-family sidecar; no retail data."""
from pathlib import Path
import hashlib,json,subprocess,sys,tempfile,struct
from audio_import_test import disc,fixture
from board_groups_fixture import boot_program,program,groups
from world_import_fixture import boot_files,executable

def main():
    cli=str(Path(sys.argv[1]).resolve());probe=str(Path(sys.argv[2]).resolve());checks=0
    with tempfile.TemporaryDirectory(prefix='openslope-board-groups-') as temporary:
        root=Path(temporary)
        def run(elf,good=True):
            nonlocal checks
            image=root/'fixture.iso';image.write_bytes(disc(boot_files(elf)));before=hashlib.sha256(image.read_bytes()).digest()
            p=subprocess.run([cli,'board-groups',str(image)],capture_output=True,text=True,timeout=30)
            assert (p.returncode==0)==good,p.stdout+p.stderr;assert before==hashlib.sha256(image.read_bytes()).digest();checks+=1
            return json.loads(p.stdout) if good else None
        expected=dict(Schema='openslope-board-sound-index/v1',SourceExecutable='BOOT.ELF',SurfaceGroups=groups())
        for base,offset in [(0x600000,512),(0x1600000,4096),(0x2300000,1024)]:assert run(boot_program(base,offset))==expected
        for bias in (0,1,5):assert run(boot_program(bias=bias))==expected
        for nops in (0,3,6):assert run(boot_program(nops=nops,world=True,collision=True))==expected
        first=program();assert run(executable(program(prefix=first),base=0x600000))==expected
        run(executable(program(prefix=first,seed=1),base=0x600000),False)
        run(boot_program(invalid=True),False);run(boot_program(constant=True),False)
        for constant in ('zero-move','indirect'):run(boot_program(constant=constant),False)
        assert run(boot_program(provider_move=True))==expected
        run(executable(),False);run(boot_program()[:40],False)
        for count in (20,37):
            source=root/'source.elf';source.write_bytes(boot_program(count=count));p=subprocess.run([probe,str(source),str(count)],capture_output=True,text=True,timeout=30);assert p.returncode==0,p.stdout+p.stderr
            assert json.loads(p.stdout.splitlines()[0])==groups(count);print(p.stdout.splitlines()[-1]);checks+=1
        files=fixture();files.update(boot_files(boot_program()));image=root/'import.iso';image.write_bytes(disc(files));maps=root/'Maps'
        p=subprocess.run([cli,'extract',str(image),'FIXTURE',str(maps)],capture_output=True,text=True,timeout=30);assert p.returncode==0,p.stdout+p.stderr
        assert json.loads((maps/'FIXTURE/Audio/BoardSoundIndex.json').read_text())==expected
        assert 'executable-board-surface-index' not in json.loads((maps/'FIXTURE/Audio/Import.json').read_text())['Deferred'];checks+=1
        files.update(boot_files(executable()));image.write_bytes(disc(files));maps=root/'unrecognized'
        p=subprocess.run([cli,'extract',str(image),'FIXTURE',str(maps)],capture_output=True,text=True,timeout=30);assert p.returncode==0,p.stdout+p.stderr
        assert not (maps/'FIXTURE/Audio/BoardSoundIndex.json').exists()
        assert 'executable-board-surface-index' in json.loads((maps/'FIXTURE/Audio/Import.json').read_text())['Deferred'];checks+=1
    print(f'PASS: {checks} authored board-selector cases cover normalization, sentinels, register dataflow, delayed returns, relocation, ambiguity, cancellation and normal ISO import')
if __name__=='__main__':main()
