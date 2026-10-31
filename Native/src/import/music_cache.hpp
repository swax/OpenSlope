#pragma once
#include "hash.hpp"
#include "openslope/import.hpp"
#include <nlohmann/json.hpp>

namespace openslope::import_detail {
struct GameImporter;

struct ImportContext {
    std::filesystem::path music_root;
    bool external{}, planning{};
    nlohmann::json music = nlohmann::json::array();
    ImportSessionStats stats;
    const GameImporter* family{};
    std::vector<DiscCourse> courses;
    bool listed{};
    ImportProgress progress;
    std::uint64_t music_limit = 4ull * 1024 * 1024 * 1024;
};

std::string music_key(std::string_view converter, std::string_view parameters,
                      std::initializer_list<std::span<const std::uint8_t>> sources);
void cached_music(const DiscInput& disc, const std::string& key, const std::filesystem::path& destination,
                  const std::function<void()>& convert, const ImportCancel& cancel);
} // namespace openslope::import_detail
