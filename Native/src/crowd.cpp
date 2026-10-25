#include "openslope/crowd.hpp"
#include "openslope/import.hpp"
#include <cmath>
#include <fstream>
#include <nlohmann/json.hpp>

namespace openslope {
unsigned crowd_pattern_frame(unsigned pattern, unsigned step) {
    constexpr unsigned patterns[4][16] = {{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
                                          {0, 1, 2, 3, 2, 1, 0, 7, 8, 9, 10, 11, 12, 13, 14, 15},
                                          {0, 1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1, 0, 0},
                                          {0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1}};
    if (pattern > 3 || step > 15)
        throw std::invalid_argument("Invalid crowd pattern sample");
    return patterns[pattern][step];
}

CrowdPlayback::CrowdPlayback(std::uint32_t seed) : random_(seed) {
    for (auto& cell : cells_) {
        cell.pattern = std::uniform_int_distribution<unsigned>(0, 3)(random_);
        cell.phase = std::uniform_int_distribution<unsigned>(0, 15)(random_);
    }
    sample();
}

void CrowdPlayback::sample() {
    for (unsigned i = 0; i < cells_.size(); ++i)
        frames_[i] = cells_[i].rest ? 0 : crowd_pattern_frame(cells_[i].pattern, cells_[i].phase);
}

void CrowdPlayback::step(double seconds, unsigned activity) {
    if (!std::isfinite(seconds) || seconds < 0 || seconds > 1 || activity > 7)
        throw std::invalid_argument("Invalid crowd tick/activity");
    pending_ += seconds;
    constexpr unsigned rests[8] = {0, 0, 50, 100, 200, 100, 50, 0};
    while (pending_ >= 1. / 60 - 1e-9) {
        pending_ = std::max(0., pending_ - 1. / 60);
        beat_ = (beat_ + 1) % 5;
        if (beat_ || !activity)
            continue;
        for (auto& cell : cells_) {
            if (cell.rest) {
                --cell.rest;
                continue;
            }
            if (++cell.phase == 16) {
                cell.phase = 0;
                cell.pattern = std::uniform_int_distribution<unsigned>(0, 3)(random_);
                if (std::uniform_int_distribution<unsigned>(0, 255)(random_) < rests[activity])
                    cell.rest = std::uniform_int_distribution<unsigned>(0, 63)(random_);
            }
        }
        sample();
    }
}

std::vector<std::string> crowd_frames(const std::filesystem::path& root) {
    if (root.empty() || !std::filesystem::is_regular_file(root / "Crowd.json"))
        return {};
    const auto base = std::filesystem::weakly_canonical(root),
               path = std::filesystem::weakly_canonical(root / "Crowd.json"), relative = path.lexically_relative(base);
    if (relative.empty() || relative.is_absolute() || *relative.begin() == ".." ||
        std::filesystem::file_size(path) > 65536)
        throw std::runtime_error("Invalid crowd profile path");
    std::ifstream file(path);
    const auto doc = nlohmann::json::parse(file);
    if (doc.value("Schema", "") != "openslope-crowd/v1" || !doc.at("Frames").is_array() ||
        doc.at("Frames").size() != 16)
        throw std::runtime_error("Invalid crowd frame bank");
    std::vector<std::string> frames;
    for (const auto& value : doc.at("Frames")) {
        const auto name = value.get<std::string>();
        if (!valid_map_name(name) || !name.ends_with(".png"))
            throw std::runtime_error("Unsafe crowd texture name");
        frames.push_back(name);
    }
    return frames;
}
} // namespace openslope
