import sys, os, collections
import UnityPy

path = sys.argv[1]
env = UnityPy.load(path)

AUDIO_FMT = {0:"PCM",1:"Vorbis",2:"ADPCM",3:"MP3",4:"VAG",5:"HEVAG",6:"XMA",7:"AAC",8:"GCADPCM",9:"ATRAC9"}
LOAD = {0:"DecompressOnLoad",1:"CompressedInMemory",2:"Streaming"}

fmt = collections.Counter(); load = collections.Counter()
fmt_bytes = collections.Counter()
total_audio = 0
for obj in env.objects:
    if obj.type.name == "AudioClip":
        d = obj.read()
        cf = AUDIO_FMT.get(int(getattr(d,"m_CompressionFormat",-1)), str(getattr(d,"m_CompressionFormat","?")))
        lt = LOAD.get(int(getattr(d,"m_LoadType",-1)), str(getattr(d,"m_LoadType","?")))
        sz = int(getattr(getattr(d,"m_Resource",None),"m_Size",0) or 0) + int(getattr(obj,"byte_size",0) or 0)
        fmt[cf]+=1; load[lt]+=1; fmt_bytes[cf]+=sz; total_audio+=sz

print("=== AudioClip compression format ===")
for k,c in fmt.most_common():
    print(f"  {c:4d} clips  {fmt_bytes[k]/1024/1024:7.2f} MB  {k}")
print("=== AudioClip load type ===")
for k,c in load.most_common():
    print(f"  {c:4d} clips  {k}")
print(f"  total audio ~{total_audio/1024/1024:.2f} MB\n")

print("=== Cubemaps / large textures ===")
for obj in env.objects:
    if obj.type.name in ("Cubemap","Texture2D"):
        d = obj.read()
        w = getattr(d,"m_Width",0); h = getattr(d,"m_Height",0)
        fmtid = getattr(d,"m_TextureFormat",None)
        try:
            fmtname = fmtid.name
        except Exception:
            fmtname = str(fmtid)
        sd = getattr(d,"m_StreamData",None)
        strm = int(getattr(sd,"size",0) or 0) if sd else 0
        sz = strm + int(getattr(obj,"byte_size",0) or 0)
        if sz >= 512*1024:
            print(f"  {sz/1024/1024:7.2f} MB  {w}x{h}  {fmtname:14s}  {obj.type.name}  {getattr(d,'m_Name','')}")
