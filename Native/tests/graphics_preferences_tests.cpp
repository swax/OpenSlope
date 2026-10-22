#include "openslope/appearance.hpp"
#include "openslope/graphics_preferences.hpp"
#include "openslope/lighting.hpp"
#include "openslope/props.hpp"
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
    const auto course_root = root / "renamed-course";
    std::filesystem::create_directory(course_root);
    using Json = nlohmann::json;
    for (const auto course : {"SNOW", "MERQUER", "MESA", "GARI", "SSX_SNOW", "CUSTOM"}) {
        std::ofstream(course_root / "World.json") << Json{{"Schema", "openslope-world/v1"}, {"Course", course}};
        const auto loaded = World::load(course_root);
        const auto tuned = std::string_view(course) == "SNOW" || std::string_view(course) == "MERQUER" ||
                           std::string_view(course) == "MESA";
        check(loaded.calibration.enabled == tuned, "Calibration follows the course identifier, not the folder");
    }
    const auto profile_path = course_root / "NativeLighting.json";
    Json profile{{"Schema", "openslope-native-lighting/v1"},
                 {"RuntimeAmbient", {.12, .1, .08}},
                 {"LocalColour", {.4, .5, .6}},
                 {"DirectionalGain", {.7, .8, .9}},
                 {"FalloffMetres", 8},
                 {"EnhancedAmount", .08},
                 {"Bloom", .03}};
    std::ofstream(profile_path) << profile;
    auto calibrated = World::load(course_root);
    check(calibrated.calibration.enabled && calibrated.calibration.falloff == 8 &&
              calibrated.calibration.local_colour[0] == .4f,
          "An optional local calibration overrides the built-in profile without a map re-export");
    calibrated.directional = {{.6, .8, 0}, {2.2, .9, .25}, true};
    const auto tuned_runtime = runtime_lighting(calibrated, {});
    const auto tuned_enhanced = enhanced_lighting(calibrated, {});
    check(tuned_runtime.ambient[0] == .12f && tuned_runtime.local_colour[0] == .4f &&
              std::abs(tuned_runtime.sun_colour[0] - 1.54f) < .00001f && tuned_runtime.sun_direction[1] == .8f,
          "Runtime calibration retains authored directional colour and axis alongside its ambient and lamp gains");
    check(tuned_enhanced.presentation[2] == 1 && tuned_enhanced.presentation[1] == .03f &&
              std::abs(tuned_enhanced.local_colour[0] - .032f) < .00001f,
          "Enhanced preserves the authored base and scales only its additional illumination");
    for (const auto& invalid :
         {Json{{"RuntimeAmbient", {0, -1, 0}}}, Json{{"LocalColour", {1, 2}}}, Json{{"DirectionalGain", {0, 9, 0}}},
          Json{{"FalloffMetres", 0}}, Json{{"FalloffMetres", 33}}, Json{{"EnhancedAmount", .51}}, Json{{"Bloom", .26}},
          Json{{"RuntimeAmbient", "invalid"}}, Json{{"Schema", "invalid"}}}) {
        auto bad = profile;
        bad.update(invalid);
        std::ofstream(profile_path) << bad;
        bool rejected = false;
        try {
            World::load(course_root);
        } catch (const std::exception&) {
            rejected = true;
        }
        check(rejected, "Invalid native calibration cannot reach the shader uniforms");
    }
    profile["Enabled"] = false;
    std::ofstream(profile_path) << profile;
    check(!World::load(course_root).calibration.enabled, "Course calibration can be disabled explicitly");
    std::filesystem::remove(profile_path);
    {
        World reference;
        reference.sky_colour = {.01f, .02f, .03f};
        reference.point_lights = {{{0, 3, 0}, {1, 1, 1}, 32, 4}};
        reference.calibration = LightingCalibration::for_course("SNOW");
        reference.calibration.runtime_ambient = {.4f, .4f, .4f};
        Mesh mesh;
        Appearance images;
        images.images["Textures/base.png"] = {1, 1, {240, 240, 240, 255}};
        auto& baked = images.images["Lightmaps/0000.png"];
        baked.width = 64;
        baked.height = 1;
        const auto albedo = std::pow((240. / 255 + .055) / 1.055, 2.4);
        for (unsigned i = 0; i < 64; ++i) {
            const auto x = double(i % 8) * 2 - 7, z = double(i / 8) * 2 - 7;
            const auto distance = length(Vec3{x, -3, z});
            const auto energy = albedo * (.08 + .2 * 4 * std::pow(1 - distance / 32, 2) /
                                                    (1 + distance * distance / 36) * 3 / distance * 1.4);
            const auto mapped = (energy * (2.51 * energy + .03)) / (energy * (2.43 * energy + .59) + .14);
            const auto display = mapped <= .0031308 ? mapped * 12.92 : 1.055 * std::pow(mapped, 1 / 2.4) - .055;
            const auto subtraction = std::uint8_t(std::clamp(std::lround(240 - display * 255), 0l, 255l));
            baked.pixels.insert(baked.pixels.end(), {subtraction, subtraction, subtraction, 255});
            for (const auto offset : {Vec3{-.01, 0, -.01}, {.01, 0, -.01}, {0, 0, .02}}) {
                Vertex vertex{float(x + offset.x), 0, float(z + offset.z), 1, 1, 1};
                vertex.ny = vertex.lw = vertex.lh = 1;
                vertex.ls = float((i + .5) / 64);
                vertex.lt = .5f;
                mesh.indices.push_back(unsigned(mesh.vertices.size()));
                mesh.vertices.push_back(vertex);
            }
        }
        mesh.batches = {{0, unsigned(mesh.indices.size()), "base.png", 0}};
        auto grid = local_light_grid(reference);
        const auto samples = calibrate_lighting(grid, mesh, images, reference);
        check(samples == 64 && std::abs(reference.calibration.runtime_ambient[0] - .08) < .03 &&
                  std::abs(grid.lights[0].emitter[1] - .2) < .05,
              "Held-out terrain samples recover known ambient and lamp power without per-frame baked shading");
        reference.calibration.fit_lamps = false;
        check(calibrate_lighting(grid, mesh, images, reference) == 0,
              "Explicit overrides can disable automatic fitting without discarding their values");
        reference.calibration.fit_lamps = true;
        check(calibrate_lighting(grid, mesh, {}, reference) == 0,
              "Missing bake references retain the calibrated fallback instead of preventing map loading");
    }
    World world;
    world.sky_colour = {.8f, .8f, 1};
    const auto day = enhanced_lighting(world, {});
    world.sky_colour = {.01f, .02f, .04f};
    const auto night = enhanced_lighting(world, {});
    const auto runtime_night = runtime_lighting(world, {});
    check(runtime_night.settings[0] == 2 && runtime_night.ambient[0] < night.ambient[0],
          "Runtime mode uses raw-material lighting and bounded night sky fill");
    check(day.settings[1] == 1 && night.settings[1] == 0 && day.sun_colour[0] > night.sun_colour[0],
          "Sky brightness selects warm daylight and cool night fill");
    world.sky_colour = {49.f / 255, 56.f / 255, 106.f / 255};
    world.daylight_limit = 0;
    const auto city = runtime_lighting(world, {});
    check(city.settings[1] == 0 && city.sun_colour[0] == 0 && city.ambient == runtime_night.ambient,
          "Merqury's blue night sky and moonlight cannot enable daylight or broad lamp accumulation");
    world.sky_colour = {.8f, .8f, 1};
    world.daylight_limit = 1;
    check(enhanced_lighting(world, {}).settings == day.settings,
          "An exported daylight rig retains its previous sky-derived response");
    world.daylight_limit = World{}.daylight_limit;
    check(enhanced_lighting(world, {}).settings == day.settings,
          "Maps without directional metadata retain the daylight fallback");
    for (unsigned i = 0; i < 20; ++i)
        world.glints.push_back({{double(i), 0, 0}, {1, .5, .25}, 32, 1});
    world.glints.push_back({{1000, 0, 0}, {1, 1, 1}, 32, 1});
    const auto lamps = local_light_grid(world);
    check(lamps.lights.size() == 21 && lamps.at({}).size() >= 20 && lamps.at({1000, 0, 0}).size() == 1,
          "Spatial lighting retains every source and selects by receiver position");
    check(lamps.at({-10000, 0, 0}).empty(), "Receivers outside the grid do not read stale light indices");
    World dense;
    for (unsigned i = 0; i < 128; ++i)
        dense.point_lights.push_back({{0, 0, 0}, {1, 1, 1}, 100, 1});
    const auto overlap = local_light_grid(dense);
    check(overlap.at({63.999, 0, 63.999}).size() == 128 && overlap.at({64, 0, 64}).size() == 128,
          "Dense overlapping lights and cell boundaries have no nearest-light cap");
    World spread;
    for (unsigned i = 0; i < 64; ++i)
        spread.point_lights.push_back({{double(i % 8) * 137 - 500.125, double(i % 5), double(i / 8) * 113 - 450.25},
                                       {1, 1, 1},
                                       double(4 + i * 3 % 117),
                                       1});
    const auto grid = local_light_grid(spread);
    for (std::uint32_t i = 0; i < spread.point_lights.size(); ++i) {
        const auto& source = spread.point_lights[i];
        for (const Vec3 offset :
             {Vec3{.999, 0, 0}, {-.999, 0, 0}, {0, 0, .999}, {0, 0, -.999}, {.7, 0, .7}, {-.7, 0, -.7}}) {
            const auto candidates = grid.at(source.position + offset * source.radius);
            check(std::find(candidates.begin(), candidates.end(), i) != candidates.end(),
                  "Every in-range receiver retains its light across positive and negative cells");
        }
    }
    World fixtures;
    fixtures.point_lights = {
        {{0, 2, 0}, {1, .5, .25}, 32, 3500}, {{4, 2, 0}, {1, 1, 1}, 32, 5700}, {{2, 2, 0}, {1, 1, 1}, 32, 1}};
    auto fixture_grid = local_light_grid(fixtures);
    check(fixture_grid.lights[0].colour[0] == 70 && fixture_grid.lights[1].colour[0] > 70 &&
              fixture_grid.lights[1].colour[0] <= 128,
          "Authored floodlights retain bounded HDR strength instead of sharing a four-unit ceiling");
    Props housings;
    for (const auto half : {1., .5, 20.}) {
        PropPart part;
        part.bounds.add({-half, 2 - half, -half});
        part.bounds.add({half, 2 + half, half});
        housings.parts.push_back(part);
    }
    housings.models.push_back({{0, 1, 2}, {}});
    PropInstance lamp;
    const auto identity = identity_transform();
    for (unsigned i = 0; i < 16; ++i)
        lamp.pose.matrix[i] = float(identity[i]);
    housings.instances.push_back(lamp);
    lamp.pose.matrix[12] = 4;
    housings.instances.push_back(lamp);
    const auto casters = light_housings(fixture_grid, housings);
    check(casters == std::vector<std::uint32_t>{1, 4} && fixture_grid.lights[0].colour[3] == 2 &&
              fixture_grid.lights[1].colour[3] == 5 && fixture_grid.lights[2].colour[3] == 0,
          "Only the smallest enclosing compact fixture part is exempt for its own source and placement");
    housings.instances[1].visible = false;
    light_housings(fixture_grid, housings);
    check(fixture_grid.lights[1].colour[3] == 0, "Hidden housings cannot retain a stale shadow exemption");
    housings.parts[0].bounds.max.y = housings.parts[0].bounds.min.y;
    housings.parts[1].alpha_mode = 1;
    light_housings(fixture_grid, housings);
    check(fixture_grid.lights[0].colour[3] == 0,
          "Flat, transparent and oversized geometry cannot become a lamp housing");
    const auto file = root / "User/graphics.json";
    auto prefs = GraphicsPreferences::load(file);
    check(prefs.render_scale == 150 && prefs.msaa == 4 && prefs.snow == 3,
          "First launch uses 150%, 4x and ambient snow");
    check(prefs.lighting == LightingMode::Original, "First launch preserves Original lighting");
    prefs = {200, 8, 7.5};
    check(prefs.save(file), "Preferences can create their parent directory");
    prefs = GraphicsPreferences::load(file);
    check(prefs.render_scale == 200 && prefs.msaa == 8 && prefs.snow == 7.5, "All settings survive reload");
    const auto write = [&](const nlohmann::json& value) { std::ofstream(file) << value; };
    prefs.lighting = LightingMode::Enhanced;
    check(prefs.save(file) && GraphicsPreferences::load(file).lighting == LightingMode::Enhanced,
          "Enhanced lighting survives preference reload");
    prefs.lighting = LightingMode::Runtime;
    check(prefs.save(file) && GraphicsPreferences::load(file).lighting == LightingMode::Runtime,
          "Runtime lighting survives preference reload");
    prefs.lighting = LightingMode(99);
    check(!prefs.save(file) && GraphicsPreferences::load(file).lighting == LightingMode::Runtime,
          "Invalid lighting mode cannot replace saved preferences");
    for (const auto value : {nlohmann::json("unknown"), nlohmann::json(1), nlohmann::json(nullptr)}) {
        write({{"schema", "openslope-graphics-preferences/v1"}, {"lighting", value}});
        check(GraphicsPreferences::load(file).lighting == LightingMode::Original,
              "Unknown lighting values preserve Original");
    }
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
    check(click(UiAction::Lighting) && prefs.lighting == LightingMode::Enhanced &&
              ui.lighting == LightingMode::Enhanced,
          "Desktop toggle enables Enhanced lighting");
    check(click(UiAction::Lighting) && prefs.lighting == LightingMode::Runtime && ui.lighting == LightingMode::Runtime,
          "Desktop cycles from Enhanced to Runtime lighting");
    check(click(UiAction::Lighting) && prefs.lighting == LightingMode::Original,
          "Desktop cycle restores Original lighting");
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
    check(std::none_of(buttons.begin(), buttons.end(),
                       [](const auto& b) {
                           return b.action == UiAction::RenderScale || b.action == UiAction::Antialiasing ||
                                  b.action == UiAction::Lighting;
                       }),
          "Wrist menu leaves render quality to the Quest launcher");
    prefs.render_scale = 200;
    prefs.lighting = LightingMode::Runtime;
    check(!prefs.handle({UiAction::Lighting}, ui) && prefs.lighting == LightingMode::Runtime,
          "VR cannot edit desktop lighting");
    check(!prefs.handle({UiAction::RenderScale}, ui) && prefs.render_scale == 200,
          "VR cannot accidentally edit desktop scale");
    click(UiAction::SnowUp);
    check(click(UiAction::GraphicsReset) && prefs.snow == 3 && prefs.render_scale == 200 &&
              prefs.lighting == LightingMode::Runtime,
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
