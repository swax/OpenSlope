#include "../src/import/ssx/formats.hpp"
#include "openslope/crowd.hpp"
#include "openslope/material_animation.hpp"
#include "openslope/world_logic.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <set>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;

void check(bool value, const char* message) {
    ++checks;
    if (!value)
        throw std::runtime_error(message);
}

void clocks() {
    const unsigned expected[4][16] = {{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
                                      {0, 1, 2, 3, 2, 1, 0, 7, 8, 9, 10, 11, 12, 13, 14, 15},
                                      {0, 1, 2, 3, 4, 5, 6, 7, 6, 5, 4, 3, 2, 1, 0, 0},
                                      {0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1}};
    for (unsigned p = 0; p < 4; ++p)
        for (unsigned i = 0; i < 16; ++i)
            check(crowd_pattern_frame(p, i) == expected[p][i],
                  "clean pattern vectors retain their exact source frames");
    CrowdPlayback clock(17);
    const auto initial = clock.cells();
    std::set<unsigned> phases;
    for (const auto& cell : initial)
        phases.insert(cell.phase);
    check(phases.size() > 4, "cells begin on independent random phases");
    clock.step(4. / 60, 1);
    check(clock.cells() == initial, "crowd advances only on fifth global tick");
    clock.step(1. / 60, 1);
    check(clock.cells() != initial, "fifth tick advances controller");
    const auto stopped = clock.cells();
    clock.step(1, 0);
    check(clock.cells() == stopped, "zero activity freezes all cell poses and rest counters");
    CrowdPlayback partitioned(29), whole(29);
    for (unsigned i = 0; i < 120; ++i)
        partitioned.step(1. / 120, 1);
    whole.step(1, 1);
    check(partitioned.cells() == whole.cells(), "half-tick callers retain the shared 12 Hz cadence");
    CrowdPlayback active(1), restful(1), forced(1);
    unsigned resting = 0;
    std::set<unsigned> patterns;
    for (unsigned tick = 0; tick < 200; ++tick) {
        active.step(1, 1);
        restful.step(1, 4);
        forced.step(1, 7);
        for (unsigned i = 0; i < 16; ++i) {
            check(active.cells()[i].rest == 0 && forced.cells()[i].rest == 0,
                  "activity one and forced seven never insert rests");
            const auto& cell = restful.cells()[i];
            check(cell.rest <= 63 && cell.phase <= 15 && cell.pattern <= 3 && restful.frames()[i] <= 15,
                  "rerolls remain inside fixed controller limits");
            resting += cell.rest > 0;
            patterns.insert(cell.pattern);
            if (cell.rest)
                check(restful.frames()[i] == 0, "rest holds source frame zero");
        }
    }
    check(resting > 500 && patterns.size() == 4, "high-rest activity still exercises all four motion envelopes");
    for (unsigned code = 2; code <= 6; ++code) {
        CrowdPlayback candidate(code);
        candidate.step(1, code);
        for (const auto frame : candidate.frames())
            check(frame < 16, "every activity code selects a valid source frame");
    }
}

void write(const std::filesystem::path& root, const char* name, const Json& value) {
    std::ofstream(root / name) << value;
}

Json node(int main, Json payload) { return {{"mainType", main}, {"payload", payload}, {"references", Json::object()}}; }

void runtime(const std::filesystem::path& root) {
    write(
        root, "Models.json",
        {{"Models",
          Json::array({{{"ModelObjects",
                         Json::array({{{"MeshData", Json::array({{{"MaterialID", 8}}, {{"MaterialID", 3}}})}}})}}})}});
    write(root, "Instances.json",
          {{"Instances",
            Json::array(
                {{{"ModelID", 0}, {"Location", {0, 0, 0}}, {"EffectSlotIndex", 0}, {"PlayerCollision", true}},
                 {{"ModelID", 0}, {"Location", {1000, 0, 0}}, {"EffectSlotIndex", 0}, {"PlayerCollision", true}}})}});
    const auto install = node(0, {{"type0", {{"SubType", 17}, {"CrowdEffect", {{"U0", 999}, {"U1", 1}, {"U2", 2}}}}}}),
               pause = node(0, {{"type0", {{"SubType", 5}, {"DeadNodeMode", 1}}}});
    const Json doc = {{"kind", "openslope-effects"},
                      {"version", 1},
                      {"graphs", Json::array({{{"id", "crowd"}, {"nodes", Json::array({install})}},
                                              {{"id", "pause"}, {"nodes", Json::array({pause})}}})},
                      {"functions", Json::array()},
                      {"slots", Json::array({{{"id", "stand"},
                                              {"circumstances", {{"persistent", "crowd"}, {"collision", "pause"}}}}})}};
    write(root, "Effects.json", doc);
    auto logic = WorldLogic::load(root);
    const std::array<Vec3, 1> observers{{{0, 0, 0}}};
    logic.tick(0, 0, observers);
    auto states = std::vector<PropTextureFrame>(logic.texture_frames().begin(), logic.texture_frames().end());
    check(states.size() == 2 && states[0].crowd && states[0].materials.size() == 2,
          "crowd property binds existing cells without creating geometry");
    check(states[0].materials[0].material == 8 && states[0].materials[1].material == 3,
          "cell selection follows authored draw order, never sorted material ids");
    check(states[0].materials[0].frame == states[1].materials[0].frame, "separate stands sample one shared controller");
    logic.tick(1, 0, observers);
    check(logic.texture_frames()[0].materials[0].frame == states[0].materials[0].frame,
          "camera observer alone cannot activate crowd motion");
    const std::array<CrowdActivity, 1> far{{{{211, 0, 0}, 1, true}}};
    logic.tick(1, 0, observers, far);
    check(logic.texture_frames()[0].materials[0].frame == states[0].materials[0].frame,
          "rider outside both stand radii leaves poses frozen");
    const std::array<CrowdActivity, 1> near{{{{0, 0, 0}, 1, true}}};
    logic.tick(1, 0, observers, near);
    bool changed = false;
    for (unsigned i = 0; i < 2; ++i)
        changed |= logic.texture_frames()[0].materials[i].frame != states[0].materials[i].frame;
    check(changed, "active nearby rider animates the shared cells");
    logic.contact(0, 0);
    const auto held = logic.texture_frames()[0].materials;
    logic.tick(1, 0, observers, near);
    bool same = true;
    for (unsigned i = 0; i < held.size(); ++i)
        same &= held[i].frame == logic.texture_frames()[0].materials[i].frame;
    check(same, "pausing one stand preserves its captured material poses");
    logic.restart(RunMode::Freeride);
    check(logic.texture_frames().empty(), "restart clears crowd node overrides");
    logic.tick(0, 0, observers);
    check(logic.texture_frames()[0].materials[0].frame == states[0].materials[0].frame,
          "restart reinitializes shared random phases deterministically");
    const std::array<Vec3, 1> away{{{2000, 0, 0}}};
    logic.tick(0, 0, away);
    logic.tick(0, 0, away);
    check(logic.texture_frames().empty(), "ordinary region teardown removes crowd drawing nodes");
    auto legacy = doc;
    legacy["graphs"][0]["nodes"][0]["payload"]["type0"]["CrowdEffect"] = {{"U0", 1}, {"U1", 2}};
    write(root, "Effects.json", legacy);
    auto compatible = WorldLogic::load(root);
    compatible.tick(0, 0, observers);
    check(compatible.texture_frames().size() == 2 && compatible.texture_frames()[0].materials.size() == 2,
          "legacy two-word public crowd descriptor normalizes to the same grid");
}

void cancellation(const std::filesystem::path& root, const std::filesystem::path& source) {
    std::ifstream file(source, std::ios::binary);
    const std::vector<std::uint8_t> bytes{std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
    std::ofstream(root / "keep.txt") << "custom map";
    bool refused = false;
    try {
        import_detail::write_crowd(bytes, root,
                                   [&] { return std::filesystem::exists(root / "Textures/crowd-cd04.png"); });
    } catch (const std::exception&) {
        refused = true;
    }
    check(refused, "shared art conversion can cancel after several PNGs were written");
    check(!std::filesystem::exists(root / "Crowd.json") && std::filesystem::is_empty(root / "Textures"),
          "cancelled supplement removes only its partial new frames/profile");
    std::ifstream keep(root / "keep.txt");
    std::string text;
    std::getline(keep, text);
    check(text == "custom map", "cancelled supplement preserves existing custom files");
}

} // namespace

int main(int argc, char** argv) {
    try {
        clocks();
        const auto root =
            std::filesystem::temp_directory_path() /
            ("openslope-crowd-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directory(root);

        struct Cleanup {
            std::filesystem::path p;

            ~Cleanup() {
                std::error_code e;
                std::filesystem::remove_all(p, e);
            }
        } cleanup{root};

        runtime(root);
        if (argc == 2)
            cancellation(root, argv[1]);
        std::cout << "PASS: " << checks
                  << " crowd pattern/cadence/rest, authored cells, rider activity and lifecycle checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
