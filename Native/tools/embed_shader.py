"""Embed locally compiled SPIR-V; generated headers and binaries stay in the build tree."""
import struct
import sys
from pathlib import Path

source, target, name = sys.argv[1:]
data = Path(source).read_bytes()
if len(data) % 4:
    raise ValueError("Invalid SPIR-V length")
words = struct.unpack(f"<{len(data) // 4}I", data)
Path(target).write_text(
    "#pragma once\n#include <cstdint>\n"
    f"inline constexpr std::uint32_t {name}[] = {{\n"
    + "\n".join("    " + ",".join(str(w) for w in words[i:i+12]) + "," for i in range(0, len(words), 12))
    + "\n};\n", encoding="utf-8"
)
