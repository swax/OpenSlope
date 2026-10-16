#include "openslope/appearance.hpp"
#include "openslope/celestial.hpp"
#include "openslope/world.hpp"
#include "render_math.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <limits>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace {
using namespace openslope;
unsigned checks = 0;

void check(bool v, const char* message) {
    ++checks;
    if (!v)
        throw std::runtime_error(message);
}

void close(double a, double b, double tolerance, const char* message) { check(std::abs(a - b) <= tolerance, message); }

template <class F> void rejects(F operation) {
    bool bad = false;
    try {
        operation();
    } catch (const std::exception&) {
        bad = true;
    }
    check(bad, "Malformed celestial input is rejected");
}

void geometry() {
    Glare glare;
    glare.enabled = true;
    glare.azimuth = 90;
    glare.elevation = 0;
    close(length(glare.direction() - Vec3{0, 0, -1}), 0, 1e-12,
          "Canonical azimuth follows the course's proper axis rotation");
    for (const auto az : {0., 37., 90., 180., 270.}) {
        glare.azimuth = az;
        glare.elevation = 11.25;
        close(glare.direction().y, std::sin(11.25 * pi / 180), 1e-12, "Positive elevation remains above the mountain");
        close(length(glare.direction()), 1, 1e-12, "Celestial direction is a unit vector");
    }
    glare.azimuth = 90;
    glare.elevation = 0;
    CelestialView frame;
    frame.clip = (projection(-1, 1, -1, 1) * view({}, {0, 0, -1})).values;
    for (const auto x : {0., .6, -.9, 1.2, 2.5}) {
        auto shifted = frame;
        shifted.clip[8] = float(-x);
        const auto mesh = celestial_mesh(glare, shifted);
        check(!mesh.fan.empty() && mesh.fan.size() % 3 == 0 && mesh.fan.size() < 4096,
              "Bounded fan covers on- and off-screen suns");
        double area = 0;
        for (std::size_t i = 0; i < mesh.fan.size(); i += 3) {
            const auto a = mesh.fan[i], b = mesh.fan[i + 1], c = mesh.fan[i + 2];
            area += std::abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) * .5;
        }
        close(area, 4, .0001, "Independent wedge clipping covers the entire viewport once, including corners");
        for (const auto& p : mesh.fan) {
            check(p.x >= -1.00001 && p.x <= 1.00001 && p.y >= -1.00001 && p.y <= 1.00001,
                  "Every clipped beam stays in the viewport");
            check(std::isfinite(p.r) && std::isfinite(p.g) && std::isfinite(p.b) && p.r >= 0 && p.g >= 0 && p.b >= 0,
                  "Squared beam attenuation stays finite and nonnegative");
        }
    }
    auto ordinary = celestial_mesh(glare, frame);
    auto shallow = frame;
    shallow.far_distance = 100;
    const auto close_mesh = celestial_mesh(glare, shallow);
    check(ordinary.corona.size() == 6, "Sun emits one broad textured corona quad");
    for (std::size_t i = 0; i < 6; ++i) {
        close(ordinary.corona[i].x / ordinary.corona[i].lt, close_mesh.corona[i].x / close_mesh.corona[i].lt, 1e-6,
              "Far clamp preserves corona angular extent");
        close(ordinary.corona[i].y / ordinary.corona[i].lt, close_mesh.corona[i].y / close_mesh.corona[i].lt, 1e-6,
              "Far clamp preserves corona angular height");
    }
    glare.azimuth = 270;
    check(celestial_mesh(glare, frame).fan.empty() && celestial_mesh(glare, frame).corona.empty(),
          "Sun behind the eye draws nothing");
    glare.azimuth = 90;
    frame.stereo = true;
    const auto stereo = celestial_mesh(glare, frame);
    check(stereo.fan.size() == 96, "Stereo uses the shared 32-spoke sky disc");
    close(std::abs(stereo.fan[1].x / stereo.fan[1].lt), std::tan(40 * pi / 180), 1e-6,
          "Stereo fan reaches the public 40-degree angular radius");
    auto left = frame, right = frame;
    left.clip = (projection(-1, 1, -1, 1) * view({-.032, 0, 0}, {0, 0, -1})).values;
    right.clip = (projection(-1, 1, -1, 1) * view({.032, 0, 0}, {0, 0, -1})).values;
    const auto l = celestial_mesh(glare, left).fan[0], r = celestial_mesh(glare, right).fan[0];
    close(l.x / l.lt - r.x / r.lt, .064 / 240, 1e-8,
          "Stereo eyes project one common sun anchor at the authored distance");
    frame.visibility = 0;
    check(celestial_mesh(glare, frame).fan.empty(), "Terrain visibility can fully suppress celestial draws");
    frame.visibility = std::numeric_limits<double>::infinity();
    rejects([&] { celestial_mesh(glare, frame); });
    frame.visibility = 1;
    glare.distance = 0;
    rejects([&] { celestial_mesh(glare, frame); });
}

void lamps(const std::filesystem::path& root) {
    using Json = nlohmann::json;
    Json rows = Json::array();
    for (auto res : {16, 32, 64, 256, 512, 0x70})
        rows.push_back({{"SpriteRes", res}, {"Colour", {1000, 0, 0}}, {"Position", {0, 1000, 0}}});
    rows.push_back({{"SpriteRes", 32}, {"Colour", {-1, -1, -1}}, {"Position", {0, 1000, 0}}});
    std::ofstream(root / "Lights.json") << Json{{"Lights", rows}};
    const auto lights = load_lamp_glints(root);
    check(lights.size() == 4 && lights[3].size == 0, "The small-class gate retains a pixel-only unclassified mask");
    close(lights[0].position.z, -10, 1e-9, "Light positions use native metre axes");
    close(lights[0].hue.x, 1, 1e-9, "Illumination magnitude divides out of glint hue");
    const auto matrix = (projection(-1, 1, -1, 1) * view({}, {0, 0, -1})).values;
    const auto mesh = lamp_glint_mesh(lights, matrix, {}, 128, 128);
    check(mesh.size() == 120, "Each lamp has halo, crossed square stars, fixed core and same-hue aura");
    const auto wider = lamp_glint_mesh(lights, matrix, {}, 256, 256);
    close(std::abs(mesh[18].x) / std::abs(wider[18].x), 2, 1e-6, "Core retains pixel size as resolution changes");
    const auto point = [](const Vertex& v) { return Vec3{v.x, v.y, v.z}; };
    const auto centre = [&](const auto& vertices, unsigned base = 0) {
        return (point(vertices[base]) + point(vertices[base + 2])) * .5;
    };
    const auto extent = [&](const auto& vertices, unsigned base) {
        return length(point(vertices[base + 1]) - point(vertices[base]));
    };
    close(centre(mesh).z, -7, 1e-6, "Small glow pulls three metres toward the viewer");
    close(centre(mesh, 30).z, -5, 1e-6, "Medium glow pulls five metres toward the viewer");
    close(extent(mesh, 30) / extent(mesh, 0), 2, 1e-6, "Small and medium glow sizes retain their class ratio");
    close(extent(mesh, 60) / extent(mesh, 30), 2, 1e-6, "Large glow is twice medium in the preview profile");
    close(length(point(mesh[7]) - point(mesh[6])), length(point(mesh[8]) - point(mesh[7])), 1e-6,
          "Lens star art retains a square aspect ratio");
    close(centre(mesh, 90).z, -10, 1e-6, "Unclassified masks retain the fixed source core without world glow");
    close(extent(mesh, 90), 0, 1e-6, "Unclassified masks cannot invent a world-size class");
    close(extent(mesh, 24), extent(mesh, 0), 1e-6, "The soft same-hue aura spans the circular halo");
    const auto projected = [&](Vec3 p, const auto& m, unsigned axis) {
        const auto w = m[3] * p.x + m[7] * p.y + m[11] * p.z + m[15];
        return (m[axis] * p.x + m[4 + axis] * p.y + m[8 + axis] * p.z + m[12 + axis]) / w;
    };
    close(std::abs(projected(point(mesh[19]), matrix, 0) - projected(point(mesh[18]), matrix, 0)) * 64, 16, 1e-5,
          "Pulled core remains sixteen final pixels wide");
    close(std::abs(projected(point(mesh[20]), matrix, 1) - projected(point(mesh[19]), matrix, 1)) * 64, 8, 1e-5,
          "Pulled core remains eight final pixels high");
    const Vec3 left_eye{-.032, 0, 0}, right_eye{.032, 0, 0};
    const auto left = (projection(-1, 1, -1, 1) * view(left_eye, {0, 0, -1})).values;
    const auto right = (projection(-1, 1, -1, 1) * view(right_eye, {0, 0, -1})).values;
    const auto shared = stereo_lamp_view(left, right, left_eye, right_eye);
    std::array<LampGlint, 1> off_axis{{{{1.2, .1, -10}, {1, 0, 0}, 32, 1}}};
    close(projected(off_axis[0].position, shared.bloom_clip, 0),
          (projected(off_axis[0].position, left, 0) + projected(off_axis[0].position, right, 0)) * .5, 1e-6,
          "Parallel-eye matrix averaging retains the cyclopean projected source");
    const auto l = lamp_glint_mesh(off_axis, left, left_eye, 128, 128, 600, &shared);
    const auto r = lamp_glint_mesh(off_axis, right, right_eye, 128, 128, 600, &shared);
    close(l[0].ls, r[0].ls, 1e-9, "Both eyes use one cyclopean bloom and distance gain");
    close(length(centre(l) - centre(r)), 0, 1e-6, "Stereo camera pull retains one common world anchor");
    close(extent(l, 0), extent(r, 0), 1e-6, "Both eyes retain the same halo size");
    check(length(point(l[6]) - point(r[6])) > 1e-4, "Star rotation still responds to each eye's projected X");
    off_axis[0] = {{0, 0, -30}, {1, 0, 0}, 64, 1};
    const auto far = lamp_glint_mesh(off_axis, matrix, {}, 128, 128);
    close(centre(far).z, -22, 1e-6, "An unclamped large glow pulls eight metres toward the viewer");
    off_axis[0].position = {0, 0, -.1};
    const auto near = lamp_glint_mesh(off_axis, matrix, {}, 128, 128);
    check(centre(near).z < 0, "A nearby glow cannot pull through the eye plane");
    auto bad_shared = shared;
    bad_shared.bloom_clip[0] = std::numeric_limits<float>::infinity();
    rejects([&] { lamp_glint_mesh(off_axis, matrix, {}, 128, 128, 600, &bad_shared); });
    auto many = std::vector<LampGlint>(30, lights[0]);
    check(lamp_glint_mesh(many, matrix, {}, 128, 128).size() == 300, "Lamp selection is bounded to ten visible lights");
    many[0].position.z = 10;
    check(lamp_glint_mesh(std::span(many.data(), 1), matrix, {}, 128, 128).empty(), "Behind-camera lamps draw nothing");
    many[0].position.z = -601;
    check(lamp_glint_mesh(std::span(many.data(), 1), matrix, {}, 128, 128).empty(),
          "Lamp range excludes distant sources");
    std::filesystem::remove(root / "Lights.json");
}

void visibility() {
    Glare glare;
    glare.enabled = true;
    glare.azimuth = 90;
    glare.elevation = 0;
    Patch wall;
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            wall.points[u * 4 + v] = {-10 + 20. * u / 3, -10 + 20. * v / 3, -5};
    Patch distant;
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            distant.points[u * 4 + v] = {20000 + u * 100., -20, 20000 + v * 100.};
    Terrain blocked({wall}), empty({distant});
    GlareVisibility state;
    close(state.step(blocked, glare, {}, 1. / 60), 0, 1e-12, "A hidden initial sun does not flash through terrain");
    const auto beginning = state.step(empty, glare, {}, .1);
    check(beginning > 0 && beginning < 1, "Visibility eases when the sun clears terrain");
    for (unsigned i = 0; i < 120; ++i)
        state.step(empty, glare, {}, 1. / 60);
    check(state.step(empty, glare, {}, 1. / 60) > .999, "Unoccluded cone settles at full visibility");
    for (unsigned i = 0; i < 120; ++i)
        state.step(blocked, glare, {}, 1. / 60);
    check(state.step(blocked, glare, {}, 1. / 60) < .001, "Terrain cone fades the entire layer away");
    state.reset();
    close(state.step(empty, glare, {}, 0), 1, 1e-12, "Reset samples the new course before drawing");
    glare.enabled = false;
    close(state.step(empty, glare, {}, .1), 0, 0, "Course enable bit is authoritative");
    rejects([&] { state.step(empty, glare, {}, -1); });
}

void profiles(const std::filesystem::path& root) {
    using Json = nlohmann::json;
    const auto save = [&](const Json& fields) {
        std::ofstream(root / "World.json")
            << Json{{"Schema", "openslope-world/v1"}, {"Fog", {{"Enabled", false}}}, {"Glare", fields}};
    };
    save({{"Enabled", true},
          {"CoreColour", {213, 144, 72}},
          {"RimColour", {88, 55, 34}},
          {"FanIntensity", .27},
          {"SpriteIntensity", .43},
          {"AzimuthDegrees", 123.5},
          {"ElevationDegrees", 11.25},
          {"DistanceUnits", 24680},
          {"SizeUnits", 7654}});
    const auto g = World::load(root).glare;
    check(g.enabled, "World settings load even when fog is explicitly disabled");
    close(g.azimuth, 123.5, 0, "Portable world azimuth retains its fraction");
    close(g.elevation, 11.25, 0, "Portable elevation retains its fraction");
    close(g.distance, 24680, 0, "Portable distance remains in raw map units");
    close(g.radius, 7654, 0, "Size is a radius, never an extra half-size");
    close(g.core[0], 213. / 255, 1e-7, "Core bytes normalize once");
    close(g.rim[1], 55. / 255, 1e-7, "Corona has an independent colour");
    save({{"Enabled", false}});
    check(!World::load(root).glare.enabled, "Disabled settings remain off");
    save({{"Enabled", true}, {"ElevationDegrees", 2.5}});
    const auto defaults = World::load(root).glare;
    check(defaults.enabled && defaults.elevation == 2.5 && defaults.distance == 24000 && defaults.radius == 7200,
          "Partial authored records use complete first-party defaults");
    for (const auto fields : {Json{{"DistanceUnits", 0}}, Json{{"SizeUnits", -1}}, Json{{"CoreColour", {256, 0, 0}}},
                              Json{{"ElevationDegrees", 91}}, Json{{"SpriteIntensity", 1000}}}) {
        save(fields);
        rejects([&] { World::load(root); });
    }
    const auto fallback = celestial_corona();
    check(fallback.width == 64 && fallback.height == 64, "Missing atlas has a bounded project-owned fallback");
    check(fallback.pixels[(32 * 64 + 32) * 4 + 3] > 250 && fallback.pixels[3] == 0,
          "Fallback is a broad smooth corona without a compact core");
    const RgbaImage atlas{2, 2, {255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255}};
    const auto crop = celestial_corona(&atlas);
    check(crop.width == 1 && crop.height == 1 && crop.pixels == std::vector<std::uint8_t>({0, 255, 0, 255}),
          "Only the atlas top-right corona survives; other tiles cannot bleed into mipmaps");
}
} // namespace

int main(int argc, char** argv) {
    try {
        const auto root =
            std::filesystem::temp_directory_path() /
            ("openslope-celestial-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directory(root);

        struct Cleanup {
            std::filesystem::path p;

            ~Cleanup() {
                std::error_code e;
                std::filesystem::remove_all(p, e);
            }
        } cleanup{root};

        geometry();
        visibility();
        profiles(root);
        lamps(root);
        if (argc == 2) {
            unsigned courses = 0, enabled = 0;
            for (const auto& entry : std::filesystem::directory_iterator(argv[1]))
                if (entry.is_directory() && std::filesystem::is_regular_file(entry.path() / "World.json") &&
                    std::filesystem::is_regular_file(entry.path() / "Patches.json")) {
                    const auto world = World::load(entry.path());
                    if (!world.glints.empty()) {
                        const auto eye = world.glints.front().position + Vec3{0, 0, 10};
                        const auto matrix = (projection(-1, 1, -1, 1) * view(eye, {0, 0, -1})).values;
                        check(!lamp_glint_mesh(world.glints, matrix, eye, 128, 128).empty(),
                              "Owned source light table reaches the lamp renderer");
                    }
                    std::cout << entry.path().filename().string() << ": " << world.glints.size() << " lamp glints\n";
                    CelestialView frame;
                    frame.clip = (projection(-1, 1, -1, 1) * view({}, world.glare.direction())).values;
                    const auto drawn = celestial_mesh(world.glare, frame);
                    check(world.glare.enabled ? !drawn.fan.empty() && drawn.corona.size() == 6
                                              : drawn.fan.empty() && drawn.corona.empty(),
                          "Owned course enable flags and authored parameters govern their celestial draw");
                    ++courses;
                    enabled += world.glare.enabled;
                }
            check(courses > 0, "Owned comparison discovers complete map world profiles");
            std::cout << "Owned world profiles: " << courses << "; enabled suns " << enabled << '\n';
        }
        std::cout << "PASS: " << checks
                  << " celestial projection, screen coverage, stereo, visibility, profile and corona checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
