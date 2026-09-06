import sys, collections
import UnityPy
env = UnityPy.load(sys.argv[1])
ch_count = collections.Counter()
stereo = []
for obj in env.objects:
    if obj.type.name != "AudioClip":
        continue
    d = obj.read()
    ch = int(getattr(d, "m_Channels", 0) or 0)
    name = getattr(d, "m_Name", "") or ""
    freq = int(getattr(d, "m_Frequency", 0) or 0)
    ch_count[ch] += 1
    if ch >= 2:
        stereo.append(f"{name}  ({ch}ch {freq}Hz)")

print("channel distribution:")
for ch, n in sorted(ch_count.items()):
    label = {1: "mono", 2: "stereo"}.get(ch, f"{ch}ch")
    print(f"  {n:4d} clips  {label}")
print(f"\nstereo clips ({len(stereo)}):")
for s in stereo:
    print("  ", s)
