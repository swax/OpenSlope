#include "openslope/player.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;

void check(bool value, const char* text) {
    ++checks;
    if (!value)
        throw std::runtime_error(text);
}

void near(double a, double b, const char* text) { check(std::abs(a - b) < 1e-6, text); }

void write(const std::filesystem::path& root, const char* name, const Json& value) {
    std::ofstream(root / name) << value;
}

Json node(int main, Json payload) { return {{"id", "node"}, {"mainType", main}, {"payload", payload}}; }

Json fixture(const std::filesystem::path& root, int kind = 256, bool region_latch = false, bool end_latch = false) {
    Json points = Json::array();
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            points.push_back({double(u) * 200000 / 3 - 100000, double(v) * 200000 / 3 - 100000, 0});
    write(root, "Patches.json",
          {{"Patches", Json::array({{{"PatchName", "Animated support floor"},
                                     {"SurfaceType", 1},
                                     {"TrickOnlyPatch", false},
                                     {"Points", points},
                                     {"TexturePath", ""},
                                     {"LightmapID", -1},
                                     {"UVPoints", {{0, 0}, {0, 1}, {1, 0}, {1, 1}}},
                                     {"LightMapPoint", {0, 0, 0, 0}}}})}});
    Json root_object = {{"ParentID", -1}, {"Position", {0, 0, 100}}, {"MeshData", Json::array()}};
    Json channel = {
        {"AnimationMaths",
         Json::array({{{"Value1", 0}, {"Value2", 0}, {"Value3", 100}, {"Value4", 0}, {"Value5", 0}, {"Value6", 2}}})}};
    Json moving = {
        {"ParentID", 0},
        {"IncludeAnimation", true},
        {"Animation",
         {{"U1", 0}, {"U2", 0}, {"U3", 0}, {"AnimationAction", 1}, {"AnimationEntries", Json::array({channel})}}},
        {"CollisionBounds", {{"Min", {-100, -1000, -10}}, {"Max", {100, 1000, 0}}}},
        {"MeshData", Json::array({{{"MeshPath", "deck.obj"}, {"MaterialID", 0}}})}};
    write(root, "Models.json",
          {{"Models", Json::array({{{"ModelName", "Moving support"},
                                    {"AnimTime", 60},
                                    {"ModelObjects", Json::array({root_object, moving})}}})}});
    write(root, "Materials.json", {{"Materials", Json::array({{{"TexturePath", ""}}})}});
    std::filesystem::create_directories(root / "Meshes");
    std::ofstream(root / "Meshes/deck.obj")
        << "v -100 -1000 0\nv 100 -1000 0\nv 100 1000 0\nv -100 1000 0\nf 1 2 3\nf 1 3 4\n";
    Json instances = Json::array();
    for (unsigned i = 0; i < 2; ++i)
        instances.push_back({{"ModelID", 0},
                             {"Location", {i * 1000, 0, 0}},
                             {"PlayerCollision", true},
                             {"PlayerBounce", true},
                             {"PlayerBounceAmmount", 0},
                             {"CollsionMode", 2},
                             {"U0", 1},
                             {"SurfaceType", 1},
                             {"EffectSlotIndex", i == 0 ? 0 : -1},
                             {"Visable", true}});
    write(root, "Instances.json", {{"Instances", instances}});
    Json law = {
        {"U0", 0}, {"U1", kind == 257 ? -1082130432 : -1}, {"U2", -1}, {"U3", 30}, {"U4", 0}, {"U5", 1}, {"U6", 0},
        {"U7", 3}};
    Json prop = {{"SubType", kind}, {"type0Sub" + std::to_string(kind), law}};
    Json doc = {{"kind", "openslope-effects"},
                {"version", 1},
                {"graphs", Json::array({{{"id", "animate"}, {"nodes", Json::array({node(0, {{"type0", prop}})})}},
                                        {{"id", "empty"}, {"nodes", Json::array()}},
                                        {{"id", "grant"},
                                         {"nodes", Json::array({node(3, {{"type3", {{"U0", 2}, {"U1", 30}}}})})}}})},
                {"slots", Json::array({{{"id", "slot"},
                                        {"originalIndex", 0},
                                        {"circumstances",
                                         {{"persistent", "animate"},
                                          {"collision", "grant"},
                                          {"slot3", region_latch ? Json("empty") : Json(nullptr)},
                                          {"slot4", end_latch ? Json("empty") : Json(nullptr)}}}}})},
                {"functions", Json::array()},
                {"objectProperties", Json::array()},
                {"instances", Json::array()},
                {"splines", Json::array()}};
    write(root, "Effects.json", doc);
    return doc;
}

double shift(const WorldLogic& logic) {
    check(logic.motions().size() == 1, "one installed player produces one instance pose");
    return logic.motions()[0].current[1][12];
}

void lifecycle(const std::filesystem::path& root) {
    const std::array<Vec3, 1> near_view{{{0, 0, 0}}}, far_view{{{2000, 0, 0}}};
    fixture(root);
    auto logic = WorldLogic::load(root);
    logic.tick(0, 0, near_view);
    near(shift(logic), 0, "persistent activation starts clip at zero");
    check(logic.motions()[0].instance == 0, "shared-model sibling has no installed animation");
    logic.tick(.5, 0, near_view);
    near(shift(logic), .5, "per-instance clip clock reaches half a metre");
    logic.tick(.5, 0, far_view);
    check(logic.active_regions() > 0, "region stays active for the first empty beat");
    logic.tick(.5, 0, far_view);
    check(logic.active_regions() == 0 && logic.motions().empty(),
          "region exit destroys ordinary player and restores static model");
    logic.tick(0, 0, near_view);
    near(shift(logic), 0, "re-approach creates a fresh player");
    fixture(root, 256, true, true);
    logic = WorldLogic::load(root);
    logic.tick(1, 0, near_view);
    logic.tick(1, 0, near_view);
    near(shift(logic), 2, "populated empty node-end chain latches final pose");
    logic.tick(.1, 0, far_view);
    logic.tick(.1, 0, far_view);
    near(shift(logic), 2, "region-deactivate latch retains installed final pose");
    logic.tick(0, 0, near_view);
    near(shift(logic), 2, "reactivation cannot replace a latched player with a fresh clock");
    fixture(root, 256, false, false);
    logic = WorldLogic::load(root);
    logic.tick(1, 0, near_view);
    logic.tick(1, 0, near_view);
    check(logic.motions().empty() && (logic.flags()[0] & WorldDraw),
          "ordinary play-once end returns to authored static flags");
    fixture(root, 257, true, true);
    logic = WorldLogic::load(root);
    logic.tick(.5, 0, near_view);
    near(shift(logic), 0, "encoded negative window and delta constructor stay frozen");
    logic.contact(0, 0);
    logic.tick(.5, 0, near_view);
    near(shift(logic), .5, "real control node grants delta playback budget");
    logic.tick(.5, 0, near_view);
    near(shift(logic), 1, "grant consumes exactly one clip second");
    logic.tick(1, 0, near_view);
    near(shift(logic), 1, "spent delta budget holds the fall pose");
}

void collision(const std::filesystem::path& root) {
    fixture(root, 256, false, true);
    auto logic = WorldLogic::load(root);
    const std::array<Vec3, 1> view{{{0, 0, 0}}};
    logic.tick(0, 0, view);
    auto world = CollisionWorld::load(root);
    world.instance_flags(logic.flags());
    world.motion(logic.motions(), 1. / 60);
    logic.tick(.5, 0, view);
    world.motion(logic.motions(), .5);
    const auto hit = world.ray({.5, 3, 0}, {.5, -1, 0}, true);
    check(hit && hit->instance == 0, "animated rideable box follows its model object");
    near(hit->point.y, 1, "static parent height is applied once to collision");
    near(hit->surface_velocity.x, 1, "ground contact reports authored surface velocity");
    check(!world.ray({-.9, 3, 0}, {-.9, -1, 0}, true), "collision no longer occupies the old rendered pose");
    const auto sibling = world.ray({10, 3, 0}, {10, -1, 0}, true);
    check(sibling && sibling->instance == 1, "shared-model sibling collision remains at rest");
    near(world.carry(hit->object, {0, 1, 0}).x, .5, "support point maps through the same object motion");
    const std::array<ProbeSphere, 1> body{{{{1.25, .95, 0}, .1}}};
    const auto contacts = world.sweep(body, body);
    check(!contacts.empty() && contacts.front().instance == 0, "moving shape sweeps into a stationary body");
    near(contacts.front().t, .3, "relative moving-box contact has the expected time of impact");
    const auto response = collision_response(contacts.front(), {}, {0, 1, 0});
    near(response.velocity.x, 1, "impact uses closing velocity relative to moving surface");
    world.motion({}, 1. / 60);
    check(world.ray({-.9, 3, 0}, {-.9, -1, 0}, true).has_value(),
          "removing a player restores rest collision and refits broadphase");
}

void rider_motion(const std::filesystem::path& root) {
    fixture(root, 256, true, true);
    Player capped(Terrain::load(root));
    capped.warp({0, 1, 0}, {0, 0, -1}, {1, 0, -100});
    capped.tick({});
    near(capped.rider().velocity.x, 1, "relative speed cap preserves moving-deck velocity");
    check(length(capped.rider().velocity - capped.rider().ground_velocity) <= capped.rider().speed_cap + 1e-6,
          "speed cap applies to rider motion over the deck");
    Player moving(Terrain::load(root)), fixed(Terrain::load(root));
    moving.warp({0, 1, 0}, {0, 0, -1}, {1, 0, -12});
    fixed.warp({10, 1, 0}, {0, 0, -1}, {0, 0, -12});
    RideInput charge;
    charge.jump = true;
    for (unsigned i = 0; i < 6; ++i) {
        moving.tick(charge);
        fixed.tick(charge);
    }
    for (unsigned i = 0; i < 20 && !moving.rider().launches; ++i) {
        moving.tick({});
        fixed.tick({});
    }
    check(moving.rider().launches == 1 && fixed.rider().launches == 1,
          "both moving and fixed supports launch through the real release path");
    near(moving.rider().velocity.y, fixed.rider().velocity.y, "platform motion cannot inflate charged jump strength");
    check(moving.rider().velocity.x > .9, "launch retains inherited platform momentum");
}

void foot_launch(const std::filesystem::path& root) {
    fixture(root, 256, true, true);
    Player moving(Terrain::load(root)), fixed(Terrain::load(root));
    moving.warp({0, 1, 0}, {0, 0, -1});
    fixed.warp({10, 1, 0}, {0, 0, -1});
    moving.start_on_foot();
    fixed.start_on_foot();
    for (unsigned i = 0; i < 6; ++i) {
        moving.tick({});
        fixed.tick({});
    }
    const auto start = moving.rider().position;
    RideInput jump;
    jump.jump = true;
    moving.tick(jump);
    fixed.tick(jump);
    check(!moving.rider().grounded && !fixed.rider().grounded, "on-foot jump leaves both supports");
    near(moving.rider().velocity.x, 1, "on-foot jump inherits platform momentum");
    near(moving.rider().velocity.y, fixed.rider().velocity.y, "on-foot jump strength is relative to support");
    near(moving.rider().position.x - start.x, 1. / 60, "launch displacement includes platform motion exactly once");
    moving.tick({});
    check(moving.rider().velocity.x > .9, "airborne walker retains inherited momentum after leaving support");
}

void walker(const std::filesystem::path& root) {
    fixture(root, 256, true, true);
    Player player(Terrain::load(root));
    player.warp({0, 1, 0}, {0, 0, -1});
    player.start_on_foot();
    const auto start = player.rider().position;
    const auto distance = player.board_distance();
    for (unsigned i = 0; i < 60; ++i)
        player.tick({});
    near(player.rider().position.x - start.x, 1, "idle walker follows a moving support");
    near(player.rider().position.y, 1, "walker remains seated on animated collision");
    near(player.board_distance(), distance, "parked board and walker share moving support");
    check(player.interact_board(), "carried parked board remains mountable");
    check(player.rider().velocity.x > .9, "mount inherits support velocity");
    const auto mounted_x = player.rider().position.x;
    for (unsigned i = 0; i < 30; ++i)
        player.tick({});
    check(player.rider().grounded && std::abs(player.rider().position.x - mounted_x - .5) < .03,
          "mounted rider retains moving-deck momentum without double carrying");
}
} // namespace

int main() {
    try {
        const auto root =
            std::filesystem::temp_directory_path() /
            ("openslope-prop-runtime-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directory(root);

        struct Cleanup {
            std::filesystem::path path;

            ~Cleanup() {
                std::error_code ec;
                std::filesystem::remove_all(path, ec);
            }
        } cleanup{root};

        lifecycle(root);
        collision(root);
        rider_motion(root);
        foot_launch(root);
        walker(root);
        std::cout << "PASS: " << checks
                  << " persistent animation, latches, delta control, moving collision and support checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
