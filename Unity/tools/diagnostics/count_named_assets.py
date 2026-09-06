"""Count the assets in a built Unity bundle whose names contain a substring.

    python count_named_assets.py <bundle> <substring>

Prints the total AudioClip bytes and every Mesh, Material, GameObject, Texture2D or Cubemap whose
name contains the substring (case-insensitive). Useful for confirming that a build carries only the
content you meant to put in it. Needs UnityPy (`pip install UnityPy`).
"""
import sys

import UnityPy

if len(sys.argv) != 3:
    sys.exit(__doc__)
bundle, needle = sys.argv[1], sys.argv[2].lower()
env = UnityPy.load(bundle)
matches = []
audio = 0
for obj in env.objects:
    t = obj.type.name
    if t == "AudioClip":
        d = obj.read()
        audio += int(getattr(getattr(d, "m_Resource", None), "m_Size", 0) or 0) + int(getattr(obj, "byte_size", 0) or 0)
    if t in ("Mesh", "Material", "GameObject", "Texture2D", "Cubemap"):
        try:
            nm = obj.read().m_Name or ""
        except Exception:
            nm = ""
        if needle in nm.lower():
            matches.append(f"{t}:{nm}")
print(f"audio total: {audio / 1024 / 1024:.2f} MB")
print(f"assets named *{sys.argv[2]}*: {len(matches)}")
for m in matches[:15]:
    print("  ", m)
