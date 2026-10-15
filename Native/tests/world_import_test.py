"""Synthetic ISO/ELF -> World.json conformance; no retail binary is required."""
import hashlib,json,struct,subprocess,sys,tempfile
from pathlib import Path
from audio_import_test import disc
from import_test import course_members,big
from world_import_fixture import SLOTS,rows,expected,initializer,executable,boot_files,ins,reg

def main():
    importer=str(Path(sys.argv[1]).resolve());probe=str(Path(sys.argv[2]).resolve());checks=0
    with tempfile.TemporaryDirectory(prefix='openslope-world-import-') as temporary:
        root=Path(temporary)
        def run(files,course='GARI',good=True):
            nonlocal checks
            image=root/'fixture.iso';image.write_bytes(disc(files));before=hashlib.sha256(image.read_bytes()).digest()
            result=subprocess.run([importer,'world',str(image),course],capture_output=True,text=True,timeout=20)
            assert (result.returncode==0)==good,result.stdout+result.stderr
            assert hashlib.sha256(image.read_bytes()).digest()==before,'Reader modified its input'
            checks+=1
            return json.loads(result.stdout) if good else None
        authored=rows();elf=executable()
        for i,slot in enumerate(SLOTS):assert run(boot_files(elf),slot)==expected(authored[i],slot)
        assert run(boot_files(elf),'mesa')==expected(authored[3],'MESA')
        for width in (4,8):
            body=executable(initializer(copy_width=width,prefix=True))
            for i in (0,9,11,12):assert run(boot_files(body),SLOTS[i])==expected(authored[0],SLOTS[i])
        for base,offset in [(0x600000,512),(0x1010000,4096)]:assert run(boot_files(executable(base=base,offset=offset)))==expected(authored[0],'GARI')
        section=bytearray(elf);section_at=len(section);section.extend(bytes(40))
        struct.pack_into('<I',section,32,section_at);struct.pack_into('<H',section,48,1)
        fixture_address,=struct.unpack_from('<I',elf,60)
        struct.pack_into('<10I',section,section_at,0,1,6,fixture_address,256,len(elf)-256,0,0,4,0)
        assert run(boot_files(bytes(section)))==expected(authored[0],'GARI')
        struct.pack_into('<I',section,section_at+12,fixture_address+len(elf));run(boot_files(bytes(section)),good=False)
        overlapping=bytearray(elf);struct.pack_into('<H',overlapping,44,2);overlapping[84:116]=overlapping[52:84]
        run(boot_files(bytes(overlapping)),good=False)
        for base in (0x40000000,0x7ffef000):run(boot_files(executable(base=base)),good=False)
        duplicate=initializer()+initializer()
        assert run(boot_files(executable(duplicate)))==expected(authored[0],'GARI')
        run(boot_files(executable(initializer()+initializer(rows(seed=1)))),good=False)
        run(boot_files(executable(initializer(unknown=True))),good=False)
        run(boot_files(executable(initializer(missing=True))),good=False)
        run(boot_files(executable(initializer(loop_forever=True))),good=False)
        run(boot_files(executable(initializer(loop_forever=True)*70)),good=False)
        external=initializer();external.insert(2,ins(3));run(boot_files(executable(external)),good=False)
        for offset,value in [(0,2),(4,256),(16,0x7fc00000),(20,0xbf800000),(44,0x7f800000),(48,0)]:
            invalid=rows();invalid[12][offset//4]=value;run(boot_files(executable(initializer(invalid))),good=False)
        for at,fmt,value in [(4,'B',2),(5,'B',2),(16,'H',3),(18,'H',62),(28,'I',0xfffffff0),(42,'H',1),(44,'H',65535),(68,'I',0xffffffff)]:
            invalid=bytearray(elf);struct.pack_into('<'+fmt,invalid,at,value);run(boot_files(bytes(invalid)),good=False)
        run(boot_files(elf[:40]),good=False)
        run(boot_files(elf),course='authored',good=False)
        run({'other.txt':b'No executable settings'},good=False)
        for reference in [b'BOOT2=cdrom0:\\..\\BOOT.ELF;1',b'BOOT2=file:///BOOT.ELF',b'BOOT2=cdrom0:\\;1']:
            run(boot_files(elf,reference),good=False)
        # Actual full importer integration on an authored playable GARI slot.
        members={k.replace('fixture','gari').replace('FIXTURE','GARI'):v for k,v in course_members().items()}
        files=boot_files(elf);files['DATA/MODELS/GARI.BIG']=big(members)
        image=root/'import.iso';image.write_bytes(disc(files));maps=root/'Maps'
        p=subprocess.run([importer,'extract',str(image),'GARI',str(maps)],capture_output=True,text=True,timeout=30);assert p.returncode==0,p.stdout+p.stderr
        assert json.loads((maps/'GARI/World.json').read_text())==expected(authored[0],'GARI');checks+=1
        data=bytearray(elf);struct.pack_into('<I',data,28,0xfffffff0);files=boot_files(bytes(data));files['DATA/MODELS/GARI.BIG']=big(members)
        image.write_bytes(disc(files));failed=root/'failed Maps'
        p=subprocess.run([importer,'extract',str(image),'GARI',str(failed)],capture_output=True,text=True,timeout=30);assert p.returncode!=0 and not (failed/'GARI').exists(),p.stdout+p.stderr;checks+=1
        fixture=root/'boot.elf';fixture.write_bytes(elf);p=subprocess.run([probe,str(fixture)],capture_output=True,text=True,timeout=30);assert p.returncode==0,p.stdout+p.stderr;print(p.stdout.strip())
    print(f'PASS: {checks} authored world-settings cases cover slots, scalar/FPU data, loops, unaligned copies, relocation, ambiguity, malformed input and import rollback')
if __name__=='__main__':main()
