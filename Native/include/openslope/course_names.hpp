#pragma once
#include <filesystem>
#include <string>
#include <string_view>

namespace openslope {
// Presentation only: imports, folders and saved preferences keep the original ID.
// Unknown IDs and custom map names are returned unchanged.
std::string course_display_name(std::string_view id);
std::string map_display_name(const std::filesystem::path& map);
std::string course_game(std::string_view id);
std::string game_display_name(std::string_view game);
std::string map_game_from_metadata(std::string_view id, std::string_view origin, std::string_view imported,
                                   bool authored = false);
std::string map_game(const std::filesystem::path& map);
} // namespace openslope
