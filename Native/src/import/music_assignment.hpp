#pragma once
#include "openslope/import.hpp"
#include <nlohmann/json.hpp>

namespace openslope::import_detail {
struct MusicAssignment {
    std::vector<std::size_t> indices;
    nlohmann::json metadata;
};

MusicAssignment assign_map_music(std::span<const DiscCourse> courses, const std::string& requested, std::size_t songs);
MusicAssignment assign_map_music(const DiscInput& disc, const std::string& requested, std::size_t songs,
                                 const ImportCancel& cancel);
} // namespace openslope::import_detail
