"""Original surface-selector programs with unrelated case values/registers."""
from world_import_fixture import ins,reg,initializer,executable
from audio_resolver_fixture import program as collision_program

def groups(count=20,seed=0):return [(i*3+1+seed)%10 for i in range(count)]
def program(base=0x600000,prefix=(),count=20,bias=3,tail=2,seed=0,nops=0,invalid=False,constant=False,provider_move=False):
    code=list(prefix);labels={};fix=[]
    def emit(*words):code.extend(words)
    def label(name):labels[name]=len(code)
    def address(name):return base+labels[name]*4
    label('provider')
    if constant=='zero-move':emit(reg(37,12))
    elif constant=='indirect':emit(ins(9,rt=20,imm=1),reg(45,12,20))
    else:emit(ins(9,rt=12,imm=1) if constant else ins(33,4,12,16))
    if provider_move:emit(reg(45,20,12))
    label('selector');emit(ins(9,20 if provider_move else 12,8,bias));emit(*([0]*nops))
    emit(ins(11,8,9,count+bias+tail));branch=len(code);emit(0,reg(0,8,rt=8,shift=2))
    fix.append((len(code),'table','address'));emit(0,0,reg(33,8,10,8),ins(35,8,8),reg(8,rs=8),0)
    for value in range(11 if invalid else 10):label('family'+str(value));emit(reg(8,rs=31),ins(9,rt=2,imm=value))
    label('default');emit(reg(8,rs=31),ins(9,rt=2,imm=0))
    label('table');rows=[0]*bias+groups(count,seed)+[0]*tail
    if invalid:rows[bias+count//2]=10
    for value in rows:fix.append((len(code),'family'+str(value),'pointer'));emit(0)
    code[branch]=ins(4,9,0,labels['default']-branch-1)
    for at,name,kind in fix:
        value=address(name)
        if kind=='address':code[at:at+2]=[ins(15,rt=10,imm=value>>16),ins(13,10,10,value)]
        else:code[at]=value
    return code

def boot_program(base=0x600000,offset=512,world=False,collision=False,**kwargs):
    prefix=initializer() if world else ()
    if collision:prefix=collision_program(base,prefix=prefix)
    return executable(program(base,prefix=prefix,**kwargs),base=base,offset=offset)
