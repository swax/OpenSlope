#pragma once
#include "openslope/audio_data.hpp"

namespace openslope {
AudioStream decode_ealayer3_stream(std::span<const std::uint8_t> source, std::size_t first_block, unsigned channels,
                                   unsigned rate, unsigned frames, unsigned priority);
}
