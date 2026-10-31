#pragma once
#include "audio.hpp"

namespace openslope {
// Portable reference music: Ogg Opus, 128 kb/s, original frame count retained in tags.
void write_reference_opus(const std::filesystem::path& input, const std::filesystem::path& output);
PcmClip load_reference_opus(const std::filesystem::path& path);
std::filesystem::path music_asset(const std::filesystem::path& wav);
} // namespace openslope
