"""Equipment-only recall through production walker, replay parsing and Vulkan."""
import json,re,subprocess,sys,tempfile
from pathlib import Path

def vector(log,label):
    m=re.search(re.escape(label)+r' \[([^\]]+)\]',log);assert m,(label,log)
    return tuple(map(float,m.group(1).split(',')))
def main():
    executable=str(Path(sys.argv[1]).resolve());frames=0;results={}
    with tempfile.TemporaryDirectory(prefix='openslope-recall-replay-') as temporary:
        root=Path(temporary)
        patch=dict(PatchName='Recall floor',SurfaceType=1,TrickOnlyPatch=False,TexturePath='',LightmapID=-1,LightMapPoint=[0,0,0,0],UVPoints=[[0,0],[0,1],[1,0],[1,1]],Points=[[(u/3-.5)*200000,(v/3-.5)*200000,0] for u in range(4) for v in range(4)])
        (root/'Patches.json').write_text(json.dumps(dict(Patches=[patch])))
        for name in ['away','recall','held-walk','walk-only','recall-again']:
            steps=[dict(Ticks=160,Posture=1,WalkForward=[0,0,-1])]
            if name in ('away','recall'):steps.append(dict(Ticks=1,SpawnBoard=name=='recall',WalkForward=[0,0,-1]))
            else:
                steps.append(dict(Ticks=1,SpawnBoard=True,WalkForward=[0,0,-1]))
                steps.append(dict(Ticks=60,Posture=1,WalkForward=[0,0,-1],SpawnBoard=name in ('held-walk','recall-again')))
                if name=='recall-again':steps.extend([dict(Ticks=1),dict(Ticks=1,SpawnBoard=True,WalkForward=[0,0,-1])])
            replay=root/(name+'.json');replay.write_text(json.dumps(dict(Schema='openslope-replay/v1',Placement=dict(Position=[0,0,0],Forward=[0,0,-1]),Steps=steps)));capture=root/(name+'.ppm')
            p=subprocess.run([executable,'--map',str(root),'--on-foot','--first-person','--look-down','--replay',str(replay),'--capture',str(capture),'--no-audio'],capture_output=True,text=True,timeout=120);assert p.returncode==0,p.stdout+p.stderr
            assert 'Boarding: on foot 1;' in p.stdout and 'Recovery: 0 crashes' in p.stdout and 'Course recovery: pending 0;' in p.stdout,p.stdout
            rgb=capture.read_bytes().split(b'\n',3)[3];teal=sum(g>r*2 and b>r*2 and g>90 and b>90 for r,g,b in zip(rgb[0::3],rgb[1::3],rgb[2::3]));results[name]=(vector(p.stdout,'position'),vector(p.stdout,'board'),teal);frames+=sum(x['Ticks'] for x in steps)
        assert results['away'][0]==results['recall'][0],'Recall moved the rider'
        assert results['held-walk'][0]==results['walk-only'][0],'Held recall changes walking'
        assert results['held-walk'][1]==results['walk-only'][1]==results['recall'][1],'Held X follows the walker'
        assert results['recall-again'][1]!=results['held-walk'][1],'Second X edge did not recall again'
        assert results['recall'][2]>results['away'][2]+100,'Recalled deck does not render ahead'
    print(f'PASS: {frames} production Vulkan frames verify visible board recall, unchanged walker and press/hold/re-press behavior')
if __name__=='__main__':main()
