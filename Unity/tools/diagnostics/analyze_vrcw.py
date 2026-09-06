import sys, os, collections
import UnityPy

path = sys.argv[1]
print(f"Bundle: {path}")
print(f"Compressed .vrcw on disk: {os.path.getsize(path)/1024/1024:.2f} MB\n")

env = UnityPy.load(path)

type_bytes = collections.Counter()
type_count = collections.Counter()
assets = []  # (size, type, name)

def stream_size(data):
    # extra data held in .resS streams (textures/audio), not in byte_size
    try:
        sd = getattr(data, "m_StreamData", None)
        if sd is not None and getattr(sd, "size", 0):
            return int(sd.size)
    except Exception:
        pass
    try:
        res = getattr(data, "m_Resource", None)
        if res is not None and getattr(res, "m_Size", 0):
            return int(res.m_Size)
    except Exception:
        pass
    return 0

READ = {"Texture2D", "Mesh", "AudioClip", "Cubemap", "Shader", "TextAsset", "AnimationClip"}

for obj in env.objects:
    t = obj.type.name
    size = int(getattr(obj, "byte_size", 0) or 0)
    name = ""
    if t in READ:
        try:
            data = obj.read()
            name = getattr(data, "m_Name", "") or ""
            size += stream_size(data)
        except Exception as e:
            name = f"<read err {e.__class__.__name__}>"
    type_bytes[t] += size
    type_count[t] += 1
    if size >= 64 * 1024:  # track assets >= 64 KB
        assets.append((size, t, name))

total = sum(type_bytes.values())
print(f"Total uncompressed serialized size: {total/1024/1024:.2f} MB")
print(f"Total objects: {sum(type_count.values())}\n")

print("=== By type (uncompressed) ===")
for t, b in type_bytes.most_common():
    print(f"{b/1024/1024:8.2f} MB  {type_count[t]:5d}x  {t}")

print("\n=== Top 30 individual assets (>=64 KB) ===")
for size, t, name in sorted(assets, reverse=True)[:30]:
    print(f"{size/1024/1024:8.2f} MB  {t:14s}  {name}")
