#include "openslope/course_names.hpp"
#include "openslope/ride_ui.hpp"
#include <algorithm>
#include <chrono>
#include <fstream>
#include <iostream>
#include <stdexcept>

using namespace openslope;

void check(bool value, const char* message) {
    if (!value)
        throw std::runtime_error(message);
}

int main() {
    const auto root =
        std::filesystem::temp_directory_path() /
        ("openslope-map-games-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    try {
        check(map_game_from_metadata("GARI", R"({"Game":" ssx-3 "})", R"({"Game":"ssx-tricky"})") == "ssx-3",
              "Origin game takes precedence");
        check(map_game_from_metadata("RENAMED", "broken", R"({"Game":"ssx-on-tour"})") == "ssx-on-tour",
              "Import game is the fallback for absent/broken origins");
        check(map_game_from_metadata("GARI", R"({"Origin":"slopesmith","Game":"ssx-tricky"})", "") == "slopesmith",
              "Authored origin wins over borrowed game IDs");
        check(map_game_from_metadata("GARI", "", "", true) == "slopesmith", "Authored sidecars identify older exports");
        check(map_game_from_metadata("RENAMED", "", R"({"Course":"AVALANCHE_CRS01_00"})") == "1080-avalanche",
              "Legacy course metadata survives renamed folders");
        check(course_game("GARI") == "ssx-tricky" && course_game("ssx_aloha") == "ssx" &&
                  course_game("SSX3_ARA1") == "ssx-3" && course_game("SSXOT_ER1_DAY") == "ssx-on-tour" &&
                  course_game("MADTRIX_AN_ANTARTICA") == "jonny-moseley-mad-trix",
              "Legacy identities recognize every game family");
        check(map_game_from_metadata("MY_MAP", "", "") == "unknown",
              "Unidentified maps are never guessed as a retail game");
        RideUi ui;
        ui.visible = ui.library = true;
        std::vector<std::filesystem::path> paths;
        for (unsigned game = 0; game < 10; ++game)
            for (unsigned map = 0; map < 10; ++map) {
                const auto path = root / ("BANK_" + std::to_string(game) + "_" + std::to_string(map));
                std::filesystem::create_directories(path);
                std::ofstream(path / "Import.json")
                    << "{\"Game\":\"game-" << game << "\",\"DisplayName\":\"Run " << map << "\"}";
                paths.push_back(path);
            }
        ui.set_maps(paths);
        check(ui.library_count() == 10, "100 maps start as 10 games, not 100 map rows");
        auto buttons = ui.buttons();
        check(buttons[0].action == UiAction::SelectGame && buttons[0].value == "game-0",
              "Game rows retain stable metadata IDs");
        check(std::none_of(buttons.begin(), buttons.end(),
                           [](const auto& row) { return row.action == UiAction::LoadMap; }),
              "No map can launch from the game picker");
        ui.scroll_library(-100);
        check(ui.library_scroll == 5, "Desktop scrolling counts games");
        ui.select_game("game-2");
        check(ui.library_count() == 10 && ui.library_scroll == 0 && ui.page == 0,
              "Game selection filters maps and resets scrolling");
        for (const auto& button : ui.buttons())
            if (button.action == UiAction::LoadMap)
                check(button.map.filename().string().starts_with("BANK_2_"), "Maps from other games stay hidden");
        ui.immersive = true;
        ui.page = 1;
        buttons = ui.buttons();
        check(std::count_if(buttons.begin(), buttons.end(),
                            [](const auto& row) { return row.action == UiAction::LoadMap; }) == 5,
              "Wrist paging counts only the chosen game's maps");
        ui.select_game("");
        ui.immersive = false;
        ui.frame({{0, 0, 0}, {1, 0, 0}, {0, -1, 0}, true});
        auto button = ui.buttons()[0];
        EquipmentRay ray{{button.x + button.w / 2, -button.y - button.h / 2, 1}, {0, 0, -1}, true};
        const auto chosen = ui.pointer(ray, true);
        check(chosen.action == UiAction::SelectGame, "Real pointer input chooses the game");
        ui.select_game(chosen.value);
        check(ui.pointer(ray, true).action == UiAction::None, "Holding the game click cannot automatically play a map");
        ui.pointer(ray, false);
        check(ui.pointer(ray, true).action == UiAction::LoadMap, "A separate click plays a filtered map");
        ui.set_maps({paths.back()});
        check(ui.library_game.empty() && ui.library_count() == 1,
              "Removing the selected game returns to valid game choices");
        std::filesystem::remove_all(root);
        std::cout << "PASS: game metadata, legacy/authored fallbacks, 100-map filtering, desktop/wrist paging, refresh "
                     "and explicit Play\n";
        return 0;
    } catch (const std::exception& error) {
        std::filesystem::remove_all(root);
        std::cerr << error.what() << '\n';
        return 1;
    }
}
