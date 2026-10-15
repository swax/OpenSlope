#include "openslope/crowd.hpp"
#include "import_internal.hpp"
#include <chrono>
#include <fstream>
#include <nlohmann/json.hpp>
#include <set>

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

namespace openslope::import_detail {
void write_crowd(std::span<const std::uint8_t> source, const std::filesystem::path& root, const ImportCancel& cancel) {
    if (source.size() > 64 * 1024 * 1024 || !std::filesystem::is_directory(root) ||
        std::filesystem::exists(root / "Crowd.json"))
        throw std::runtime_error("Invalid crowd source or existing profile");
    const auto images = decode_ssh(source, false, cancel);
    if (images.size() != 16)
        throw std::runtime_error("Shared crowd bank requires sixteen frames");
    const auto base = std::filesystem::weakly_canonical(root),
               textures = std::filesystem::weakly_canonical(root / "Textures"),
               relative = textures.lexically_relative(base);
    if (relative.empty() || relative.is_absolute() || *relative.begin() == "..")
        throw std::runtime_error("Unsafe crowd texture directory");
    nlohmann::json names = nlohmann::json::array();
    std::set<std::string> unique;
    for (const auto& image : images) {
        const auto name = "crowd-" + image.name + ".png";
        if (!valid_map_name(name) || !unique.insert(name).second || std::filesystem::exists(textures / name))
            throw std::runtime_error("Crowd texture conflicts with an existing map asset");
        names.push_back(name);
    }
    std::filesystem::create_directories(textures);
    std::vector<std::filesystem::path> created;
    const auto temporary =
        root /
        (".openslope-crowd-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + ".json");
    try {
        for (std::size_t i = 0; i < images.size(); ++i) {
            check_cancel(cancel);
            const auto path = textures / names[i].get<std::string>();
            created.push_back(path);
            write_png(path, images[i]);
        }
        check_cancel(cancel);
        {
            std::ofstream file(temporary, std::ios::binary);
            file << nlohmann::json{{"Schema", "openslope-crowd/v1"}, {"Frames", names}}.dump() << '\n';
            if (!file)
                throw std::runtime_error("Cannot write crowd profile");
        }
        if (std::filesystem::exists(root / "Crowd.json"))
            throw std::runtime_error("Crowd profile appeared during conversion");
        std::filesystem::rename(temporary, root / "Crowd.json");
    } catch (...) {
        std::error_code error;
        std::filesystem::remove(temporary, error);
        for (const auto& path : created)
            std::filesystem::remove(path, error);
        throw;
    }
}
} // namespace openslope::import_detail
