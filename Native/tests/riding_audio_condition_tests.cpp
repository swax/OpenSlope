#include "../src/riding_audio_condition.hpp"
#include <cmath>
#include <fstream>
#include <iostream>
#include <limits>
#include <nlohmann/json.hpp>
#include <numbers>
#include <stdexcept>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;

void check(bool value, const char* message) {
    ++checks;
    if (!value)
        throw std::runtime_error(message);
}

PcmClip tone(double amplitude, double dc = 0) {
    PcmClip clip;
    clip.rate = 16000;
    clip.channels = 2;
    clip.samples.resize(16000);
    for (std::size_t frame = 0; frame < clip.frames(); ++frame) {
        clip.samples[frame * 2] = float(dc + amplitude * std::sin(double(frame) * .13));
        clip.samples[frame * 2 + 1] = float(-dc + amplitude * std::cos(double(frame) * .19));
    }
    clip.loop_start = 1000;
    clip.loop_end = 7000;
    return clip;
}

void synthetic() {
    check(adapted_riding_pitch(false, 0) == .9 && adapted_riding_pitch(false, 1) == 1.02 &&
              adapted_riding_pitch(true, 1) == 1.05,
          "Adapted pitch has a restrained range");
    auto clip = tone(.8, .1);
    const auto original = clip;
    const auto levels = condition_riding_audio(clip, "openslope_board", 4);
    check(levels && levels->gain < .3 && levels->rms_after <= .120001 && levels->peak_after <= .800001,
          "Loud adapted glide is attenuated to the common ceilings");
    check(clip.rate == original.rate && clip.channels == 2 && clip.samples.size() == original.samples.size() &&
              clip.loop_start == original.loop_start && clip.loop_end == original.loop_end,
          "Format and loop extent remain intact");
    for (unsigned c = 0; c < 2; ++c)
        check(std::abs(clip.samples[clip.loop_start * 2 + c] - clip.samples[(clip.loop_end - 1) * 2 + c]) < 1e-7,
              "Loop endpoints meet independently per channel");
    check(levels->edge_frames == 80, "Only five milliseconds at each loop edge are repaired");
    auto quiet = tone(.01);
    check(condition_riding_audio(quiet, "openslope_board", 3)->gain == 1, "Quiet clips are never amplified");
    auto land = tone(.9, .05);
    const auto land_before = land.samples;
    const auto transient = condition_riding_audio(land, "openslope_board", 1);
    check(transient && transient->edge_frames == 0 && transient->rms_after <= .200001, "Transient uses gain only");
    for (const auto i : {0u, 100u, 15000u})
        check(std::abs(land.samples[i] - float(land_before[i] * transient->gain)) < 1e-7,
              "Transient attack and tail retain their original shape");
    auto ordinary = tone(.8);
    const auto saved = ordinary.samples;
    check(!condition_riding_audio(ordinary, "zboard", 4) && ordinary.samples == saved,
          "Original and authored banks remain untouched");
    check(!condition_riding_audio(ordinary, "openslope_rider", 115),
          "Unsupported game cues are not conditioned as riding loops");
    ordinary.samples[0] = std::numeric_limits<float>::quiet_NaN();
    bool rejected = false;
    try {
        condition_riding_audio(ordinary, "openslope_board", 4);
    } catch (const std::runtime_error&) {
        rejected = true;
    }
    check(rejected, "Malformed optional PCM is rejected before processing");
}

Json read(const std::filesystem::path& path) {
    std::ifstream stream(path);
    return Json::parse(stream);
}

void audit(const std::filesystem::path& map) {
    const auto root = map / "Audio";
    const auto manifest = read(root / "RidingImport.json");
    for (const auto& route : manifest.at("Routes")) {
        const unsigned slot = route.at("Slot");
        if (slot != 3 && slot != 4 && slot != 32 && slot != 122)
            continue;
        const std::string bank = route.at("Bank");
        const auto folder = root / "SFX" / bank;
        auto stem = std::to_string(slot);
        stem.insert(0, 3 - stem.size(), '0');
        auto clip = PcmClip::load(folder / (stem + ".wav"));
        const auto metadata = read(folder / "bank.json").at("Slots").at(slot);
        clip.loop_start = metadata.at("LoopStart");
        clip.loop_end = metadata.at("LoopEnd");
        const auto levels = condition_riding_audio(clip, bank, slot);
        check(levels.has_value(), "Actual adapted route reaches processing");
        std::cout << Json{{"Map", map.filename().string()},          {"Role", route.at("Role")},
                          {"GainDB", 20 * std::log10(levels->gain)}, {"RmsBefore", levels->rms_before},
                          {"RmsAfter", levels->rms_after},           {"PeakAfter", levels->peak_after}}
                  << '\n';
    }
}
} // namespace

int main(int argc, char** argv) {
    try {
        synthetic();
        if (argc == 3 && std::string(argv[1]) == "--audit")
            audit(argv[2]);
        std::cout << "PASS: " << checks << " adapted riding loudness, loop boundary and preservation checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
