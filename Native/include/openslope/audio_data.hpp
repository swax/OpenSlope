#pragma once
#include "audio.hpp"
#include <functional>
#include <optional>

namespace openslope {
struct AudioBank {
    std::vector<std::optional<PcmClip>> slots;
};

AudioBank decode_audio_bank(std::span<const std::uint8_t> source, bool omit_speech = false);
void write_audio_bank(const std::filesystem::path& output, const AudioBank& bank,
                      const std::function<void()>& checkpoint = {});

struct AudioStream {
    PcmClip clip;
    std::size_t end{};
};

AudioStream decode_audio_stream(std::span<const std::uint8_t> source, std::size_t offset = 0);
} // namespace openslope
