#include "openslope/course_names.hpp"
#include <algorithm>
#include <array>
#include <cctype>
#include <fstream>
#include <nlohmann/json.hpp>

namespace openslope {
namespace {
std::string metadata_text(const std::filesystem::path& path) {
    try {
        if (std::filesystem::file_size(path) <= 1024 * 1024) {
            std::ifstream input(path);
            return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
        }
    } catch (const std::exception&) {
    }
    return {};
}

std::string field(const nlohmann::json& document, const char* key) {
    if (!document.is_object() || !document.contains(key) || !document[key].is_string())
        return {};
    auto text = document[key].get<std::string>();
    const auto first = text.find_first_not_of(" \t\r\n"), last = text.find_last_not_of(" \t\r\n");
    if (first == std::string::npos)
        return {};
    text = text.substr(first, last - first + 1);
    if (text.size() > 128 || std::any_of(text.begin(), text.end(), [](unsigned char c) { return c < 32 || c == 127; }))
        return {};
    return text;
}
} // namespace

std::string course_game(std::string_view id) {
    std::string name(id);
    std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return char(std::toupper(c)); });
    for (const auto& [prefix, game] :
         std::array<std::pair<std::string_view, std::string_view>, 7>{{{"SSXGBA_", "ssx-tricky-gba"},
                                                                       {"SSXOT_", "ssx-on-tour"},
                                                                       {"SSX3_", "ssx-3"},
                                                                       {"SSX_", "ssx"},
                                                                       {"TRICKY_", "ssx-tricky"},
                                                                       {"AVALANCHE_", "1080-avalanche"},
                                                                       {"MADTRIX_", "jonny-moseley-mad-trix"}}})
        if (name.starts_with(prefix))
            return std::string(game);
    static constexpr std::array legacy{"ALASKA", "ALOHA", "ELYSIUM",  "GARI", "MEGAPLE", "MERQUER",
                                       "MESA",   "PIPE",  "SMOKEMTN", "SNOW", "TRICK",   "UNTRACK"};
    if (std::find(legacy.begin(), legacy.end(), name) != legacy.end())
        return "ssx-tricky";
    return "unknown";
}

std::string game_display_name(std::string_view game) {
    for (const auto& [id, title] : std::array<std::pair<std::string_view, std::string_view>, 9>{
             {{"ssx", "SSX"},
              {"ssx-tricky", "SSX Tricky"},
              {"ssx-tricky-gba", "SSX Tricky (GBA)"},
              {"ssx-3", "SSX 3"},
              {"ssx-on-tour", "SSX On Tour"},
              {"1080-avalanche", "1080 Avalanche"},
              {"jonny-moseley-mad-trix", "Jonny Moseley Mad Trix"},
              {"slopesmith", "Custom / Authored"},
              {"unknown", "Unknown"}}})
        if (id == game)
            return std::string(title);
    return std::string(game);
}

std::string map_game_from_metadata(std::string_view id, std::string_view origin, std::string_view imported,
                                   bool authored) {
    const auto source = nlohmann::json::parse(origin, nullptr, false);
    const auto report = nlohmann::json::parse(imported, nullptr, false);
    if (authored || field(source, "Origin") == "slopesmith")
        return "slopesmith";
    auto game = field(source, "Game");
    if (game.empty())
        game = field(report, "Game");
    if (!game.empty()) {
        std::transform(game.begin(), game.end(), game.begin(), [](unsigned char c) { return char(std::tolower(c)); });
        return game;
    }
    for (const auto& name : {field(report, "Course"), field(source, "Course"), std::string(id)}) {
        game = course_game(name);
        if (game != "unknown")
            return game;
    }
    return "unknown";
}

std::string map_game(const std::filesystem::path& map) {
    std::error_code error;
    const bool authored = std::filesystem::is_regular_file(map / "Slopesmith.json", error);
    return map_game_from_metadata(map.filename().string(), metadata_text(map / "Origin.json"),
                                  metadata_text(map / "Import.json"), authored);
}

std::string map_display_name(const std::filesystem::path& map) {
    try {
        const auto path = map / "Import.json";
        if (std::filesystem::file_size(path) <= 1024 * 1024) {
            std::ifstream file(path);
            const auto metadata = nlohmann::json::parse(file);
            const auto field = metadata.find("DisplayName");
            if (field != metadata.end() && field->is_string()) {
                auto name = field->get<std::string>();
                const auto first = name.find_first_not_of(" \t\r\n"), last = name.find_last_not_of(" \t\r\n");
                if (first != std::string::npos)
                    name = name.substr(first, last - first + 1);
                if (!name.empty() && name.size() <= 800 &&
                    std::none_of(name.begin(), name.end(), [](unsigned char c) { return c < 32 || c == 127; }))
                    return name;
            }
        }
    } catch (const std::exception&) { /* Legacy and authored maps keep their existing label. */
    }
    return course_display_name(map.filename().string());
}

std::string course_display_name(std::string_view id) {
    struct CourseName {
        std::string_view id, title;
    };

    // USA menu titles, matching Slopesmith's disc-courses catalogue. [Trailmap: 600-course-names]
    static constexpr std::array names{
        CourseName{"AVALANCHE_CRS00_00", "Half-Pipe"},        CourseName{"AVALANCHE_CRS00_03", "Sid's Night Midi"},
        CourseName{"AVALANCHE_CRS01_00", "Tenderfoot Pass"},  CourseName{"AVALANCHE_CRS01_01", "Powder Threat"},
        CourseName{"AVALANCHE_CRS01_02", "Revolution Cliff"}, CourseName{"AVALANCHE_CRS01_03", "Evolution Riff"},
        CourseName{"AVALANCHE_CRS02_00", "Spinal Damage"},    CourseName{"AVALANCHE_CRS02_01", "Ballistic"},
        CourseName{"AVALANCHE_CRS02_02", "No Way Out"},       CourseName{"AVALANCHE_CRS02_03", "Outway Knoll"},
        CourseName{"AVALANCHE_CRS03_00", "Frosty Shadows"},   CourseName{"AVALANCHE_CRS03_01", "Tree Top Trauma"},
        CourseName{"AVALANCHE_CRS03_02", "Midnight City"},    CourseName{"AVALANCHE_CRS03_03", "Top Tree Mama"},
        CourseName{"AVALANCHE_CRS04_00", "Ski School"},       CourseName{"AVALANCHE_CRS04_01", "Grits n' Gravy"},
        CourseName{"AVALANCHE_CRS04_02", "Rotted Ridge"},     CourseName{"AVALANCHE_CRS04_03", "Dazzlin' Teaser"},
        CourseName{"AVALANCHE_CRS05_00", "Air-Make"},         CourseName{"AVALANCHE_CRS05_01", "Trestle Trouble"},
        CourseName{"AVALANCHE_CRS05_02", "Diesel Disaster"},  CourseName{"AVALANCHE_CRS05_03", "Treble Tussle"},
        CourseName{"AVALANCHE_CRS06_00", "Terrain Park"},     CourseName{"AVALANCHE_CRS06_02", "Sick With It"},
        CourseName{"AVALANCHE_CRS06_03", "Wit's Thicket"},
    };
    for (const auto& name : names)
        if (id == name.id)
            return std::string(name.title);
    return std::string(id);
}
} // namespace openslope
