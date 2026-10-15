#pragma once
#include "math.hpp"
#include <filesystem>
#include <random>
#include <string>
#include <vector>

namespace openslope {
struct CrowdActivity {
    Vec3 position;
    unsigned code = 1;
    bool active = true;
};

unsigned crowd_pattern_frame(unsigned pattern, unsigned step);

class CrowdPlayback {
public:
    explicit CrowdPlayback(std::uint32_t seed = 0x43525744);
    void step(double seconds, unsigned activity);

    const std::array<unsigned, 16>& frames() const { return frames_; }

    struct Cell {
        unsigned pattern = 0, phase = 0, rest = 0;
        bool operator==(const Cell&) const = default;
    };

    const std::array<Cell, 16>& cells() const { return cells_; }

private:
    void sample();
    std::mt19937 random_;
    std::array<Cell, 16> cells_{};
    std::array<unsigned, 16> frames_{};
    double pending_ = 0;
    unsigned beat_ = 0;
};

std::vector<std::string> crowd_frames(const std::filesystem::path& root);
} // namespace openslope
