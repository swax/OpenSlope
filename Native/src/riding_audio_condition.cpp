#include "riding_audio_condition.hpp"
#include "streamed_riding_audio.hpp"
#include <algorithm>
#include <cmath>
#include <nlohmann/json.hpp>
#include <numbers>
#include <stdexcept>

namespace openslope {
double adapted_riding_pitch(bool rail, double response) {
    static const auto tuning =
        nlohmann::json::parse(std::begin(bundled::streamed_riding_audio), std::end(bundled::streamed_riding_audio));
    const auto& pitch = tuning.at("pitch");
    const auto value = std::isfinite(response) ? std::clamp(response, 0., 1.) : 0;
    const double base = pitch.at(rail ? "railMin" : "base");
    const double span = rail ? pitch.at("railMax").get<double>() - base : pitch.at("bendSpan").get<double>();
    return base + span * value;
}

// [Trailmap: 522-scope, 522-policy, 522-loops] Presentation tuning, not original
// game mixing. Work on the privately loaded PCM; exported source WAVs stay intact.
std::optional<RidingAudioLevels> condition_riding_audio(PcmClip& clip, std::string_view bank, unsigned slot) {
    std::string_view role;
    if (bank == "openslope_board" && slot < 80) {
        switch (slot % 8) {
        case 1: role = "land"; break;
        case 2: role = "jump"; break;
        case 3: role = "carve"; break;
        case 4: role = "glide"; break;
        default: return {};
        }
    } else if (bank == "openslope_rider" && slot == 32)
        role = "wind";
    else if (bank == "openslope_rider" && slot >= 120 && slot <= 122)
        role = "boost";
    else
        return {};
    if (clip.channels < 1 || clip.channels > 2 || clip.rate < 8000 || clip.rate > 192000 || clip.samples.empty() ||
        clip.samples.size() % clip.channels || clip.samples.size() > 32 * 1024 * 1024 ||
        !std::all_of(clip.samples.begin(), clip.samples.end(), [](float v) { return std::isfinite(v); }))
        throw std::runtime_error("Invalid adapted riding PCM");
    const bool continuous = role != "land" && role != "jump";
    const auto first = continuous && clip.loop_end ? clip.loop_start : 0;
    const auto end = continuous && clip.loop_end ? clip.loop_end : clip.frames();
    if (first >= end || end > clip.frames())
        throw std::runtime_error("Invalid adapted riding loop");
    static const auto tuning =
        nlohmann::json::parse(std::begin(bundled::streamed_riding_audio), std::end(bundled::streamed_riding_audio));
    const auto count = end - first;
    RidingAudioLevels result;
    double squares = 0;
    for (std::size_t i = first * clip.channels; i < end * clip.channels; ++i)
        squares += double(clip.samples[i]) * clip.samples[i];
    result.rms_before = std::sqrt(squares / (count * clip.channels));
    if (continuous) {
        result.edge_frames =
            std::min(std::size_t(std::floor(clip.rate * tuning.at("loopEdgeSeconds").get<double>() + .5)), count / 8);
        for (unsigned channel = 0; channel < clip.channels; ++channel) {
            double mean = 0;
            for (std::size_t i = first; i < end; ++i)
                mean += clip.samples[i * clip.channels + channel];
            mean /= count;
            for (std::size_t i = channel; i < clip.samples.size(); i += clip.channels)
                clip.samples[i] = float(clip.samples[i] - mean);
            if (result.edge_frames < 2)
                continue;
            const auto a = clip.samples[first * clip.channels + channel],
                       b = clip.samples[(end - 1) * clip.channels + channel];
            const auto join = (double(a) + b) * .5;
            for (std::size_t i = 0; i < result.edge_frames; ++i) {
                const auto weight = .5 * (1 + std::cos(std::numbers::pi * double(i) / double(result.edge_frames - 1)));
                auto& start = clip.samples[(first + i) * clip.channels + channel];
                auto& finish = clip.samples[(end - 1 - i) * clip.channels + channel];
                start = float(start + (join - a) * weight);
                finish = float(finish + (join - b) * weight);
            }
        }
    }
    double peak = 0;
    squares = 0;
    for (const auto value : clip.samples)
        peak = std::max(peak, std::abs(double(value)));
    for (std::size_t i = first * clip.channels; i < end * clip.channels; ++i)
        squares += double(clip.samples[i]) * clip.samples[i];
    const auto rms = std::sqrt(squares / (count * clip.channels));
    const double target = tuning.at("rms").at(role),
                 ceiling = tuning.at("peak").at(continuous ? "continuous" : "transient");
    result.gain = std::min({1., rms > 0 ? target / rms : 1., peak > 0 ? ceiling / peak : 1.});
    for (auto& sample : clip.samples)
        sample = float(sample * result.gain);
    result.rms_after = rms * result.gain;
    result.peak_after = peak * result.gain;
    return result;
}
} // namespace openslope
