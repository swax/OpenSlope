"""Independent synthetic cubic spline/behavior import fixtures."""
import json
from pathlib import Path
import struct
import sys
import tempfile
from import_test import course_members, big, iso, run


def members():
    files = course_members()
    pbd = bytearray(files['fixture.pbd'])
    def append(data):
        pbd.extend(bytes(-len(pbd) % 16))
        start = len(pbd); pbd.extend(data)
        return start
    splines = bytearray(80)
    struct.pack_into('<2I', splines, 28, 2, 0)
    struct.pack_into('<2I', splines, 68, 1, 2)
    spline_offset = append(splines)
    curves = [((0,0,0),(0,0,0),(0,1000,0),(0,0,150)),
              ((0,0,0),(600,0,0),(0,1000,0),(0,1000,150)),
              ((0,0,0),(0,0,0),(0,1000,500),(600,2000,150))]
    segments = bytearray(384)
    for i,power in enumerate(curves):
        p = i * 128
        for j,value in enumerate(power): struct.pack_into('<4f',segments,p+j*16,*value,1 if j==3 else 0)
        struct.pack_into('<4f',segments,p+64,.001,.002,.003,.004)
        struct.pack_into('<3i',segments,p+80,i-1,i+1 if i<2 else -1,0 if i<2 else 1)
        struct.pack_into('<2f',segments,p+116,1000+i*100,0 if i!=1 else 1000)
    segment_offset = append(segments)
    for offset,value in ((32,2),(36,3),(92,spline_offset),(96,segment_offset)): struct.pack_into('<I',pbd,offset,value)
    files['fixture.pbd'] = bytes(pbd)
    files['fixture.map'] += ('### SPLINES BEGIN\n'+'Authored curved rail'.ljust(82)+'0\n'+'Disabled ice rail'.ljust(82)+'0\n### SPLINES END\n').encode()
    behavior = bytearray(92); struct.pack_into('<I',behavior,4,0x00101500);struct.pack_into('<2I',behavior,68,2,76)
    struct.pack_into('<hhi',behavior,76,-123,1,13);struct.pack_into('<hhi',behavior,84,1,0,5)
    files['fixture.ssf'] = bytes(behavior)
    return files


def main():
    executable = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix='openslope-rail-import-') as temporary:
        root = Path(temporary); image=root/'authored.iso'; files=members();image.write_bytes(iso(big(files)))
        run(executable,'extract',image,'FIXTURE',root/'Maps')
        output=root/'Maps/FIXTURE'; rows=json.loads((output/'Splines.json').read_text())['Splines']
        assert len(rows)==2 and [len(row['Segments']) for row in rows]==[2,1]
        assert (rows[0]['U0'],rows[0]['U1'],rows[0]['SplineStyle'])==(-123,1,13)
        assert rows[1]['U1']==0 and rows[1]['SplineStyle']==5
        curve=rows[0]['Segments'][1]
        assert curve['PowerCoefficients']==[[0,0,0],[600,0,0],[0,1000,0],[0,1000,150]]
        assert curve['Points'][0]==[0,1000,150] and curve['Points'][3]==[600,2000,150]
        assert curve['Points'][1]==[0,1000+1000/3,150]
        assert curve['Previous']==0 and curve['Next']==2 and curve['SourceSegment']==1
        assert curve['Length']==1100 and curve['Distance']==1000
        assert abs(curve['ArcLengthCoefficients'][0]-.001)<1e-9
        assert 'Splines.json' in json.loads((output/'Import.json').read_text())['Outputs']
        assert 'rail-splines' not in json.loads((output/'Import.json').read_text())['Deferred']
        for name,edit in [('owner',lambda b,o:struct.pack_into('<I',b,o+88,99)),
                          ('link',lambda b,o:struct.pack_into('<i',b,o+84,99)),
                          ('nan',lambda b,o:struct.pack_into('<f',b,o,float('nan')))]:
            bad=files.copy();pbd=bytearray(bad['fixture.pbd']);edit(pbd,struct.unpack_from('<I',pbd,96)[0]);bad['fixture.pbd']=bytes(pbd);image.write_bytes(iso(big(bad)))
            run(executable,'extract',image,'FIXTURE',root/name,succeeds=False);assert not list((root/name).iterdir())
        missing=files.copy();del missing['fixture.ssf'];image.write_bytes(iso(big(missing)))
        run(executable,'extract',image,'FIXTURE',root/'without-behavior')
        rows=json.loads((root/'without-behavior/FIXTURE/Splines.json').read_text())['Splines'];assert all(row['U1']==0 and row['SplineStyle']==-1 for row in rows)
    print('PASS: authored spline spans, power/control conversion, behavior candidacy, links, arc metadata and failed-import cleanup')


if __name__=='__main__': main()
