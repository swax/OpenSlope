"""Authored ISO/shared-bank conversion and non-destructive supplement checks."""
from pathlib import Path
import json,sys,tempfile
from import_test import crowd_bank,run,png_pixels
from prop_import_test import members
from audio_import_test import disc,archive

def main():
    executable=Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-crowd-import-') as temporary:
        root=Path(temporary);iso=root/'fixture.iso';iso.write_bytes(disc({'DATA/MODELS/FIXTURE.BIG':archive(members()),'DATA/TEXTURES/CROWD.SSH':crowd_bank()}));maps=root/'Maps'
        run(executable,'extract',iso,'FIXTURE',maps);course=maps/'FIXTURE';profile=json.loads((course/'Crowd.json').read_text());assert profile['Schema']=='openslope-crowd/v1';assert profile['Frames']==[f'crowd-cd{i:02d}.png' for i in range(16)]
        for name in profile['Frames']:assert png_pixels(course/'Textures'/name)==bytes([19,39,59,255,255,255,255,255,255,99,0,128,0,0,0,0])
        assert 'Crowd.json' in json.loads((course/'Import.json').read_text())['Outputs']
        (course/'custom.txt').write_text('keep');before={str(p.relative_to(course)):p.read_bytes() for p in course.rglob('*') if p.is_file()};run(executable,'extract-crowd',iso,course,succeeds=False);assert before=={str(p.relative_to(course)):p.read_bytes() for p in course.rglob('*') if p.is_file()}
        older=root/'old-map';older.mkdir();(older/'custom.txt').write_text('keep');run(executable,'extract-crowd',iso,older);assert (older/'custom.txt').read_text()=='keep' and len(list((older/'Textures').iterdir()))==16
        if len(sys.argv)>2:
            source=root/'crowd.ssh';source.write_bytes(crowd_bank());print(run(sys.argv[2],source).strip())
        bad=root/'invalid.ssh';bad.write_bytes(crowd_bank()[:-8]);empty=root/'invalid-map';empty.mkdir();run(executable,'convert-crowd',bad,empty,succeeds=False);assert not list(empty.rglob('*.png')) and not (empty/'Crowd.json').exists()
        conflict=root/'conflict-map';(conflict/'Textures').mkdir(parents=True);(conflict/'Textures/crowd-cd15.png').write_text('custom art');run(executable,'extract-crowd',iso,conflict,succeeds=False);assert len(list((conflict/'Textures').iterdir()))==1 and not (conflict/'Crowd.json').exists()
    print('PASS: sixteen authored shared frames, ISO output, safe supplement, existing-file conflicts and malformed-bank cleanup')
if __name__=='__main__':main()
