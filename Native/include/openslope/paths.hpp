#pragma once
#include "math.hpp"
#include <filesystem>
#include <optional>
#include <vector>
#include <cstdint>

namespace openslope {
struct PathEvent {int type{};std::uint32_t value{};double start{},end{};};
struct CoursePath {
    std::vector<Vec3> points; // Includes the seed vertex; world metres.
    std::vector<PathEvent> events;
    unsigned rating=50;bool respawnable=true;double distance_to_finish{};
    std::pair<Vec3,Vec3> pose(double distance=0,double heading_baseline=15) const;
};
struct CoursePaths {
    std::vector<std::size_t> starts;
    std::vector<CoursePath> ai,race;
    static CoursePaths load(const std::filesystem::path& root_or_file);
    std::optional<std::pair<Vec3,Vec3>> start_pose() const;
};
std::optional<std::pair<Vec3,Vec3>> start_marker(const std::filesystem::path& root);
}
