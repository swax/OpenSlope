"""Original scalar dispatcher fixtures; no game instruction/table data."""
from world_import_fixture import ins,reg,initializer,executable

def expected(seed=0):
    out={}
    for event in range(64):
        if event%5==0:continue
        group=6 if event%11==0 else 3 if event%7==0 else 2
        slot=0 if group==6 or event in (3,7,17) else (event*3+7+seed)%23
        out[str(event)]=dict(Group=group,Slot=slot)
    return out

def program(base=0x600000,prefix=(),seed=0,helper=True,unknown=False,outside=False):
    code=list(prefix);labels={};fixups=[]
    def emit(*words):code.extend(words)
    def label(name):labels[name]=len(code)
    def jump(name,call=False):fixups.append((len(code),name,'call' if call else 'jump'));emit(0)
    def branch(name):fixups.append((len(code),name,'branch'));emit(ins(4,8,0))
    label('start');emit(ins(9,29,29,-64))
    for rt,offset in ((31,56),(16,48),(17,40),(18,32)):emit(ins(63,29,rt,offset))
    emit(reg(45,16,6),reg(45,17,7),reg(45,18,5))
    if helper:emit(reg(45,4,18));jump('helper',True);emit(0)
    emit(ins(9,rt=10,imm=2),ins(43,16,10),ins(11,18,8,64));branch('return');emit(0)
    emit(reg(0,9,rt=18,shift=2));fixups.append((len(code),'table','address'));emit(0,0)
    emit(reg(33,9,9,10),ins(35,9,9),reg(8,rs=9),0)
    for event,row in expected(seed).items():
        label('case'+event);emit(ins(9,rt=2,imm=row['Slot']))
        if unknown and event=='17':emit(reg(45,2,20))
        if row['Group']!=2:emit(ins(9,rt=3,imm=row['Group']),ins(43,16,3))
        if outside and event=='17':emit(ins(43,0,2))
        jump('return');emit(ins(43,17,2))
    label('return')
    for rt,offset in ((31,56),(16,48),(17,40),(18,32)):emit(ins(55,29,rt,offset))
    emit(ins(9,29,29,64),reg(8,rs=31),0)
    label('helper');emit(ins(12,4,2,1),reg(8,rs=31),0)
    label('table')
    for event in range(64):fixups.append((len(code),'return' if event%5==0 else 'case'+str(event),'pointer'));emit(0)
    for at,name,kind in fixups:
        address=base+labels[name]*4
        if kind in ('jump','call'):code[at]=((3 if kind=='call' else 2)<<26)|((address>>2)&0x3ffffff)
        elif kind=='branch':code[at]=ins(4,8,0,labels[name]-at-1)
        elif kind=='address':code[at:at+2]=[ins(15,rt=10,imm=address>>16),ins(13,10,10,address)]
        else:code[at]=address
    return code

def boot_program(base=0x600000,offset=512,world=False,**kwargs):
    prefix=initializer() if world else ()
    return executable(program(base,prefix=prefix,**kwargs),base=base,offset=offset)
