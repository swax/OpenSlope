#include "openslope/graphics_preferences.hpp"
#include "openslope/ride_ui.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <limits>
#include <nlohmann/json.hpp>

namespace {
using namespace openslope;
unsigned checks = 0;

void check(bool condition, const char* message) {
    ++checks;
    if (!condition)
        throw std::runtime_error(message);
}

void run(const std::filesystem::path& root) {
    const auto file = root / "User/graphics.json";
    auto prefs = GraphicsPreferences::load(file);
    check(prefs.render_scale == 150 && prefs.msaa == 4 && prefs.snow == 3,
          "First launch uses 150%, 4x and ambient snow");
    prefs = {200, 8, 7.5};
    check(prefs.save(file), "Preferences can create their parent directory");
    prefs = GraphicsPreferences::load(file);
    check(prefs.render_scale == 200 && prefs.msaa == 8 && prefs.snow == 7.5, "All settings survive reload");
    const auto write = [&](const nlohmann::json& value) { std::ofstream(file) << value; };
    write({{"schema", "openslope-graphics-preferences/v1"}, {"renderScale", -1}, {"msaa", "8"}, {"snow", 99}});
    prefs = GraphicsPreferences::load(file);
    check(prefs.render_scale == 150 && prefs.msaa == 4 && prefs.snow == 10,
          "Bad fields retain defaults and weather clamps");
    write({{"schema", "other"}, {"renderScale", 200}});
    check(GraphicsPreferences::load(file).render_scale == 150, "Unknown schemas retain defaults");
    std::ofstream(file) << std::string(4097, 'x');
    check(GraphicsPreferences::load(file).snow == 3, "Oversized files cannot prevent play");
    std::ofstream(file) << "broken";
    check(GraphicsPreferences::load(file).snow == 3, "Broken JSON cannot prevent play");
    prefs = {125, 2, 0};
    check(prefs.save(file), "Valid preferences replace a corrupt file");
    prefs.snow = std::numeric_limits<double>::quiet_NaN();
    check(!prefs.save(file) && GraphicsPreferences::load(file).snow == 0,
          "Rejected saves preserve the previous settings");
    check(!GraphicsPreferences{}.save(root), "Failed replacement reports an error");
    for (const auto& item : std::filesystem::directory_iterator(root))
        check(item.path().filename().string().find(".tmp-") == std::string::npos,
              "Failed saves remove temporary files");
    for (const auto scale : {100u, 125u, 150u, 200u}) {
        const auto size = GraphicsPreferences::scene_size(1257, 669, scale);
        check(size[0] == (1257 * scale + 99) / 100 && size[1] == (669 * scale + 99) / 100,
              "Odd scene dimensions round up");
    }
    for (const auto parameters :
         {std::array<unsigned, 3>{0, 720, 150}, {1280, 0, 150}, {1280, 720, 99}, {UINT32_MAX, 720, 200}}) {
        bool rejected = false;
        try {
            GraphicsPreferences::scene_size(parameters[0], parameters[1], parameters[2]);
        } catch (const std::invalid_argument&) {
            rejected = true;
        }
        check(rejected, "Invalid or overflowing scene sizes are rejected");
    }
    RideUi ui;
    ui.visible = true;
    ui.frame({{0, 0, 0}, {1, 0, 0}, {0, -1, 0}, true});
    prefs = {};
    prefs.present(ui);
    const auto click = [&](UiAction action) {
        const auto buttons = ui.buttons();
        const auto b =
            std::find_if(buttons.begin(), buttons.end(), [&](const auto& button) { return button.action == action; });
        check(b != buttons.end(), "The requested graphics action is exposed");
        const EquipmentRay ray{{b->x + b->w * .5, -b->y - b->h * .5, 1}, {0, 0, -1}, true};
        ui.release();
        const auto chosen = ui.pointer(ray, true);
        check(chosen.action == action && chosen.consumed, "Graphics actions consume the desktop click or VR trigger");
        const auto changed = prefs.handle(chosen, ui);
        check(ui.pointer(ray, true).action == UiAction::None, "Holding a control cannot repeat settings");
        return changed;
    };
    check(!click(UiAction::Graphics) && ui.graphics_options, "Main menu opens Graphics without writing preferences");
    check(click(UiAction::RenderScale) && prefs.render_scale == 200, "Scale advances through supported percentages");
    check(click(UiAction::Antialiasing) && prefs.msaa == 8, "AA advances through supported sample counts");
    for (unsigned i = 0; i < 12; ++i)
        click(UiAction::SnowDown);
    check(prefs.snow == 0 && ui.snow_amount == 0, "The weather dial stops at clear");
    for (unsigned i = 0; i < 12; ++i)
        click(UiAction::SnowUp);
    check(prefs.snow == 10, "The weather dial stops at blizzard");
    check(click(UiAction::GraphicsReset) && prefs.render_scale == 150 && prefs.msaa == 4 && prefs.snow == 3,
          "Defaults restore all desktop settings");
    ui.immersive = true;
    const auto buttons = ui.buttons();
    check(std::none_of(
              buttons.begin(), buttons.end(),
              [](const auto& b) { return b.action == UiAction::RenderScale || b.action == UiAction::Antialiasing; }),
          "Wrist menu leaves render quality to the Quest launcher");
    prefs.render_scale = 200;
    check(!prefs.handle({UiAction::RenderScale}, ui) && prefs.render_scale == 200,
          "VR cannot accidentally edit desktop scale");
    click(UiAction::SnowUp);
    check(click(UiAction::GraphicsReset) && prefs.snow == 3 && prefs.render_scale == 200,
          "VR weather defaults preserve desktop settings");
    ui.loading = true;
    check(ui.buttons().empty(), "Loading screens cannot dispatch another map or menu action");
}
} // namespace

int main() {
    const auto root =
        std::filesystem::temp_directory_path() /
        ("openslope-graphics-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    try {
        std::filesystem::create_directories(root);
        run(root);
        std::filesystem::remove_all(root);
        std::cout << "PASS: " << checks << " graphics preferences and menu checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::filesystem::remove_all(root);
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
