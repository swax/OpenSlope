#pragma once
#include "openslope/audio.hpp"
#include <string_view>

namespace openslope {
struct RidingAudioLevels {
    double rms_before{}, rms_after{}, peak_after{}, gain = 1;
    std::size_t edge_frames{};
};

// First-party playback policy for the reserved derived banks. Other banks are untouched.
std::optional<RidingAudioLevels> condition_riding_audio(PcmClip& clip, std::string_view bank, unsigned slot);
double adapted_riding_pitch(bool rail, double response);
} // namespace openslope
