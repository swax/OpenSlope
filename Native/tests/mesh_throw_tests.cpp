#include "openslope/mesh_throw.hpp"
#include "openslope/world_logic.hpp"
#include <bit>
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;

void check(bool value, const char* reason) {
    ++checks;
    if (!value)
        throw std::runtime_error(reason);
}

void write(const std::filesystem::path& root, const char* name, const Json& doc) { std::ofstream(root / name) << doc; }

Json node(int main, Json payload, Json refs = Json::object()) {
    return {{"mainType", main}, {"payload", payload}, {"references", refs}};
}

void laws() {
    const std::array<Vec3, 2> centres{{{-1, 0, 0}, {1, 0, 0}}};
    MeshThrowLaw law;
    law.speed = {9, 4, 9};
    law.step = .05;
    MeshThrow pieces(law, centres, {0, 0, -1}, 11);
    check(pieces.pose() == std::vector<Transform>(2, identity_transform()), "throw begins in the baked rest frame");
    pieces.step(.04);
    check(pieces.pose() == std::vector<Transform>(2, identity_transform()),
          "authored step holds pieces between samples");
    pieces.step(.01);
    auto pose = pieces.pose();
    const auto left = transform_point(pose[0], centres[0]), right = transform_point(pose[1], centres[1]);
    check(right.x - left.x > 2 && left.z < 0 && right.z < 0,
          "distinct centres separate along the impact without collapsing the mesh");
    const auto vector = transform_point(pose[0], {0, 1, 0}) - transform_point(pose[0], {});
    check(std::abs(length(vector) - 1) < 1e-9, "tumble preserves rigid piece length");
    for (unsigned i = 0; i < 120; ++i)
        pieces.step(1. / 60);
    check(pieces.expired(), "authored throw duration terminates");
    law.direction = {1, 0, 0};
    MeshThrow authored(law, std::span(centres).first(1), {0, 0, -1}, 11);
    authored.step(.1);
    check(transform_point(authored.pose()[0], centres[0]).x > centres[0].x + .89,
          "explicit direction overrides impact fallback");
    law.step = -1;
    bool invalid = false;
    try {
        MeshThrow bad(law, centres, {}, 0);
    } catch (const std::invalid_argument&) {
        invalid = true;
    }
    check(invalid, "negative authored sampling is rejected");
}

void graphs(const std::filesystem::path& root) {
    std::filesystem::create_directory(root / "Meshes");
    std::ofstream(root / "Meshes/piece.obj") << "v -20 0 0\nv 20 0 0\nv 0 0 40\nf 1 2 3\n";
    const Json object = {{"ParentID", -1},
                         {"MeshData", Json::array({{{"MeshPath", "piece.obj"}, {"MaterialID", 0}}})},
                         {"CollisionBounds", {{"Min", {-20, -10, 0}}, {"Max", {20, 10, 40}}}}};
    auto other = object;
    other["Position"] = {100, 0, 0};
    write(root, "Models.json", {{"Models", Json::array({{{"ModelObjects", Json::array({object, other})}}})}});
    write(root, "Materials.json", {{"Materials", Json::array({{{"TexturePath", ""}}})}});
    write(root, "Instances.json",
          {{"Instances",
            Json::array({{{"ModelID", 0},
                          {"Location", {0, 0, 0}},
                          {"Visable", true},
                          {"PlayerCollision", true},
                          {"EffectSlotIndex", 0}},
                         {{"ModelID", 0}, {"Location", {0, 0, 0}}, {"Visable", false}, {"PlayerCollision", false}},
                         {{"ModelID", 0},
                          {"Location", {1000, 0, 0}},
                          {"Visable", true},
                          {"PlayerCollision", true},
                          {"EffectSlotIndex", 0}}})}});
    auto hide = node(0, {{"type0", {{"SubType", 5}, {"DeadNodeMode", 4}}}});
    auto reveal = node(7, Json::object(), {{"instance", "instance:1"}, {"effectGraph", "pieces"}});
    auto launch = node(0, {{"type0",
                            {{"SubType", 20},
                             {"type0Sub20",
                              {{"U0", 1},
                               {"U1", .03},
                               {"U2", 2},
                               {"U3", 0},
                               {"U4", 0},
                               {"U5", 0},
                               {"U6", 900},
                               {"U7", 900},
                               {"U8", 400},
                               {"U9", 1}}}}}});
    write(
        root, "Effects.json",
        {{"kind", "openslope-effects"},
         {"version", 1},
         {"graphs", Json::array({{{"id", "break"},
                                  {"nodes", Json::array({node(21, Json::object(), {{"function", "break-function"}})})}},
                                 {{"id", "pieces"}, {"nodes", Json::array({node(4, {{"WaitTime", .05}}), launch})}}})},
         {"functions", Json::array({{{"id", "break-function"}, {"nodes", Json::array({hide, reveal})}}})},
         {"slots", Json::array({{{"id", "slot:0"}, {"circumstances", {{"collision", "break"}}}}})}});
    auto logic = WorldLogic::load(root);
    logic.contact(0, 12, true, 87, {0, 0, -1});
    check(logic.flags()[0] == 0 && logic.flags()[2] == (WorldDraw | WorldCollide),
          "function hides only the struck intact placement");
    for (unsigned i = 0; i < 10; ++i)
        logic.tick(1. / 60);
    check(logic.unsupported() == 0 && logic.flags()[1] == WorldDraw,
          "nested delayed mesh throw reveals and disarms the hidden twin");
    check(logic.motions().size() == 1 && logic.motions()[0].current.size() == 2,
          "every decoded piece gets its own render transform");
    check(logic.motions()[0].current[0][14] < 0,
          "latched impact direction survives named functions, targets and waits");
    for (unsigned i = 0; i < 125; ++i)
        logic.tick(1. / 60);
    check(logic.flags()[1] == 0 && logic.motions().empty(),
          "spent debris retires without restoring the intact source or collider");
    for (unsigned i = 0; i < 1665; ++i)
        logic.tick(1. / 60);
    check(logic.flags()[0] == (WorldDraw | WorldCollide) && logic.flags()[1] == 0,
          "interaction deadline restores intact source while keeping debris hidden");
    logic.contact(0, 12, true, 87, {0, 0, -1});
    check(logic.flags()[0] == 0, "a timed source reset rearms the full shatter chain");
    logic.restart(RunMode::Freeride);
    check(logic.flags()[0] == (WorldDraw | WorldCollide) && logic.flags()[1] == 0,
          "run restart restores authored presence");
    Json saved;
    std::ifstream(root / "Effects.json") >> saved;
    saved["graphs"][1]["nodes"][1]["payload"]["type0"]["type0Sub20"]["U3"] = std::bit_cast<std::int32_t>(-1.5f);
    write(root, "Effects.json", saved);
    auto older = WorldLogic::load(root);
    older.contact(0, 12, true, 87, {0, 0, -1});
    for (unsigned i = 0; i < 10; ++i)
        older.tick(1. / 60);
    check(older.motions().size() == 1 && older.motions()[0].current[0][12] < 0,
          "older saved integer direction words remain playable without reimport");
}

void owned(const std::filesystem::path& maps) {
    auto logic = WorldLogic::load(maps / "GARI");
    const auto before = logic.unsupported();
    logic.contact(324, 20, true, 87, {1, 0, 0});
    check(logic.flags()[324] == 0 && logic.flags()[327] == 0 && logic.flags()[325] == WorldDraw,
          "actual GARI screen swap admits its broken twin");
    check(logic.motions().size() == 1 && logic.motions()[0].current.size() == 24,
          "actual GARI broken screen preserves its root and all 23 pieces");
    check(logic.unsupported() == before, "actual GARI shatter graph has no unsupported operation");
    for (unsigned i = 0; i < 121; ++i)
        logic.tick(1. / 60);
    check(logic.flags()[325] == 0, "actual GARI broken pieces retire at authored duration");
    for (unsigned i = 0; i < 1680; ++i)
        logic.tick(1. / 60);
    check(logic.flags()[324] == (WorldDraw | WorldCollide) && logic.flags()[327] == WorldDraw &&
              logic.flags()[325] == 0,
          "actual GARI intact screen and trigger return together after thirty seconds");
    logic.contact(324, 20, true, 87, {1, 0, 0});
    check(logic.flags()[324] == 0 && logic.motions().size() == 1 && logic.motions()[0].current.size() == 24,
          "actual GARI screen can shatter again after automatic restoration");
}
} // namespace

int main(int argc, char** argv) {
    try {
        laws();
        const auto root =
            std::filesystem::temp_directory_path() /
            ("openslope-mesh-throw-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directory(root);

        struct Cleanup {
            std::filesystem::path p;

            ~Cleanup() {
                std::error_code e;
                std::filesystem::remove_all(p, e);
            }
        } cleanup{root};

        graphs(root);
        if (argc == 2)
            owned(argv[1]);
        std::cout << "PASS: " << checks << " piece, impact-context and shatter lifecycle checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
