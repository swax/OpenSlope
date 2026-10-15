#pragma once
#include <array>
#include <optional>

namespace openslope {
struct BoardMix {
    bool enabled = true;
    double volume = .8, glide = .7, carve = .8, transients = .7, cues = .8;
};

struct BoardBed {
    double glide{}, glide_bend{}, carve{}, carve_bend{};
};

// Slip is lateral cm/s, lean is absolute percent, speed is normalized to 0..1.
BoardBed board_bed(unsigned group, double slip, double lean, double speed);
double board_audio_speed(double metres_per_second);

struct BoardAudioInput {
    bool mounted = true, ground = false, rail = false, launched = false, boosting = false;
    unsigned group = 0, boost_slot = 120;
    double speed{}, slip{}, lean{}, charge{}, impact{}, predicted_flight{};
};

struct BoardLayer {
    double gain{}, pitch = 1;
};

struct BoardAudioFrame {
    // Glide, carve, rail grind and big-air wind. Gains precede the authored mix.
    std::array<BoardLayer, 4> layers{};
    BoardLayer boost;
    unsigned group{}, boost_slot = 120;
    std::optional<double> pop, land;
};

class BoardAudio {
public:
    BoardAudioFrame step(const BoardAudioInput& input, double seconds);
    void reset();

private:
    BoardAudioFrame frame_;
    bool was_air_ = false, was_boosting_ = false;
    double boost_age_ = 0;
};
} // namespace openslope
