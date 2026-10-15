"""Original synthetic scalar initializer programs and record expectations."""
import json
import struct

SLOTS=['GARI','SNOW','ELYSIUM','MESA','MERQUER','ALOHA','PIPE','UNTRACK','MEGAPLE','BIGAIR','TRICK','ALASKA','UNKNOWN12']
def f32(v):return struct.unpack('<f',struct.pack('<f',v))[0]
def float_word(v):return struct.unpack('<I',struct.pack('<f',v))[0]
def rows(seed=0):
    result=[]
    for i in range(13):
        row=[0]*37
        row[0]=int((i+seed)%3==0)
        row[1:4]=[30+i*10,120+i,200-i*3]
        row[4]=float_word(.25+i*.01);row[5]=float_word(5000+i*123)
        row[6:9]=[10+i,40+i*2,80+i*3]
        for at,value in [(9,.4+i*.02),(10,i*17-90),(11,i-6),(12,20000+i*300)]:row[at]=float_word(value)
        row[18:21]=[20+i*3+seed,40+i*5,70+i*7]
        result.append(row)
    return result
def expected(row,course):
    number=lambda at:struct.unpack('<f',struct.pack('<I',row[at//4]))[0]
    return dict(Schema='openslope-world/v1',Course=course,SkyColor=row[18:21],Glare=dict(Enabled=bool(row[0]),CoreColour=row[1:4],FanIntensity=number(16),SizeUnits=number(20),RimColour=row[6:9],SpriteIntensity=number(36),AzimuthDegrees=number(40),ElevationDegrees=number(44),DistanceUnits=number(48)))
def ins(op,rs=0,rt=0,imm=0):return (op<<26)|(rs<<21)|(rt<<16)|(imm&65535)
def reg(fn,rd=0,rs=0,rt=0,shift=0):return (rs<<21)|(rt<<16)|(rd<<11)|(shift<<6)|fn
def initializer(records=None,copy_width=0,prefix=False,unknown=False,missing=False,loop_forever=False):
    records=rows() if records is None else records
    code=[ins(3)]*17 if prefix else []
    code.append(ins(9,29,29,-128))
    code.append(reg(45,8,4,0))
    targets=records if not copy_width else records[:1]
    for i,row in enumerate(targets):
        for j,value in enumerate(row):
            code.extend([ins(15,rt=9,imm=value>>16),ins(13,9,9,value)])
            if missing and i==12 and j==36:continue
            if j in (4,5,9,10,11,12):
                code.extend([ins(17,4,9,0),ins(57,8,0,i*148+j*4)])
            else:code.append(ins(43,8,5 if unknown and i==0 and j==0 else 9,i*148+j*4))
    if copy_width:
        code.extend([ins(9,rt=10,imm=0),ins(9,rt=14,imm=148)])
        label=len(code);code.extend([reg(24,15,10,14),reg(33,8,4,15)])
        for offset in range(0,144,copy_width):
            a,b,c,d=(26,27,44,45) if copy_width==8 else (34,38,42,46)
            code.extend([ins(a,4,16,offset+copy_width-1),ins(b,4,16,offset),ins(c,8,16,offset+copy_width-1),ins(d,8,16,offset)])
        code.extend([ins(35,4,16,144),ins(43,8,16,144),ins(9,10,10,1),ins(10,10,13,13)])
        branch=len(code);code.extend([ins(5,13,0,label-branch-1),0])
    if loop_forever:
        code.extend([ins(5,4,0,-1),0])
    code.extend([reg(8,rs=31),0])
    return code
def executable(code=None,base=0x200000,offset=256):
    code=initializer() if code is None else code
    body=struct.pack('<'+'I'*len(code),*code)
    data=bytearray(offset+len(body));data[:16]=b'\x7fELF\x01\x01\x01'+bytes(9)
    struct.pack_into('<HHIIIIIHHHHHH',data,16,2,8,1,base,52,0,0,52,32,1,40,0,0)
    struct.pack_into('<8I',data,52,1,offset,base,base,len(body),len(body)+256,5,16)
    data[offset:]=body
    return bytes(data)
def boot_files(elf=None,reference=b'BOOT2 = cdrom0:\\BOOT.ELF;1\r\nVER = 1.0\r\n'):
    return {'SYSTEM.CNF':reference,'BOOT.ELF':executable() if elf is None else elf}
