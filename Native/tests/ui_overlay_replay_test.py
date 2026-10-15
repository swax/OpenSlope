"""Screen UI remains identical across distant world origins and headings."""
from pathlib import Path
import json,subprocess,sys,tempfile
from audio_scene_test import fixture,write

def region(data,x0,y0,x1,y1):return b''.join(data[(y*1280+x0)*3:(y*1280+x1)*3] for y in range(y0,y1))
def main():
    exe=Path(sys.argv[1]).resolve();saved=Path(sys.argv[2]).resolve() if len(sys.argv)>2 else None
    if saved:saved.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='openslope-ui-overlay-') as folder:
        pairs={False:[],True:[]}
        for label,shift,forward in [('origin',0,[0,0,-1]),('distant',5000,[1,0,0])]:
            root=Path(folder)/label;fixture(root,mass=0,draw=False)
            doc=json.loads((root/'Patches.json').read_text())
            for p in doc['Patches']:
                for v in p['Points']:v[0]+=shift*100;v[1]+=shift*100
            write(root/'Patches.json',doc);write(root/'Instances.json',dict(Instances=[]))
            write(root/'input.json',dict(Schema='openslope-replay/v1',Placement=dict(Position=[shift,0,-shift],Forward=forward),Steps=[dict(Ticks=24)]))
            for menu in [False,True]:
                image=(saved or root)/(label+('-menu' if menu else '-hud')+'.ppm')
                cmd=[str(exe),'--map',str(root),'--on-foot','--replay',str(root/'input.json'),'--capture',str(image),'--no-audio']
                if menu:cmd+=['--ui-menu']
                p=subprocess.run(cmd,capture_output=True,text=True,timeout=90);assert p.returncode==0,p.stdout+p.stderr
                pixels=image.read_bytes().split(b'\n',3);assert pixels[:3]==[b'P6',b'1280 720',b'255'];pixels=pixels[3]
                rois=[region(pixels,360,150,920,568)] if menu else [region(pixels,15,10,1265,39),region(pixels,15,691,1265,710)]
                pairs[menu].append(rois)
                if not menu:
                    # Thin bars occupy less than 10% of height and contain readable ink.
                    top=rois[0];assert sum(top[i]>150 and top[i+1]>180 and top[i+2]>190 for i in range(0,len(top),3))>150,'Top bar lost its text'
        for menu,values in pairs.items():
            assert values[0]==values[1],('World position/heading changed desktop UI pixels',menu,sum(a!=b for x,y in zip(values[0],values[1]) for a,b in zip(x,y)))
    print('PASS: 96 production Vulkan frames; thin HUD and menu pixels remain identical across a 5 km translation and rotated camera')
if __name__=='__main__':main()
