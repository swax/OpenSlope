#include "openslope/audio_scene.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;
constexpr double dt = 1. / 60;

void check(bool ok, const char* why) {
    ++checks;
    if (!ok)
        throw std::runtime_error(why);
}

void near(double a, double b, const char* why) { check(std::abs(a - b) < 1e-6, why); }

void equal(Vec3 a, Vec3 b, const char* why) { near(length(a - b), 0, why); }

void write(const std::filesystem::path& root, const char* name, const Json& value) {
    std::ofstream(root / name) << value;
}

Json node(int main, Json payload = Json::object(), Json refs = Json::object()) {
    return {{"mainType", main}, {"payload", payload}, {"references", refs}};
}

Json document() {
    return {
        {"kind", "openslope-effects"},
        {"version", 1},
        {"graphs",
         Json::array({{{"id", "entry"},
                       {"nodes", Json::array({node(8, {{"SoundPlay", 122}}), node(24, {{"TeleportInstanceIndex", 9999}},
                                                                                  {{"instance", "instance:1"}})})}}})},
        {"slots", Json::array({{{"id", "slot"}, {"circumstances", {{"collision", "entry"}}}}})},
        {"functions", Json::array()},
        {"instances", Json::array()},
        {"objectProperties", Json::array()},
        {"splines", Json::array()}};
}

Json fixture(const std::filesystem::path& root) {
    Json points = Json::array();
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            points.push_back({u * 40000. / 3 - 20000, v * 40000. / 3 - 20000, 0});
    write(root, "Patches.json",
          {{"Patches", Json::array({{{"PatchName", "Teleport floor"},
                                     {"SurfaceType", 1},
                                     {"TrickOnlyPatch", false},
                                     {"Points", points},
                                     {"TexturePath", ""},
                                     {"LightmapID", -1},
                                     {"UVPoints", {{0, 0}, {0, 1}, {1, 0}, {1, 1}}},
                                     {"LightMapPoint", {0, 0, 0, 0}}}})}});
    write(root, "Models.json",
          {{"Models",
            Json::array({{{"ModelObjects",
                           Json::array({{{"ParentID", -1},
                                         {"CollisionBounds", {{"Min", {-100, -100, -50}}, {"Max", {100, 100, 250}}}},
                                         {"MeshData", Json::array()}}})}}})}});
    Json rows = Json::array();
    for (unsigned i = 0; i < 3; ++i)
        rows.push_back({{"ModelID", 0},
                        {"Location",
                         {i == 1   ? 4000
                          : i == 2 ? 300
                                   : 0,
                          i == 1 ? -3000 : 0, i == 1 ? 50 : 0}},
                        {"Rotation", {0, 0, 0, 1}},
                        {"Scale", {1, 1, 1}},
                        {"Visable", false},
                        {"PlayerCollision", i != 1},
                        {"PlayerBounce", i == 2},
                        {"U0", i == 2 ? 1 : 0},
                        {"CollsionMode", i == 1 ? 0 : 2},
                        {"EffectSlotIndex", i == 0 ? 0 : -1},
                        {"SurfaceType", -1}});
    write(root, "Instances.json", {{"Instances", rows}});
    write(root, "Effects.json", document());
    return rows;
}

void placements(const std::filesystem::path& root) {
    auto rows = fixture(root);
    auto logic = WorldLogic::load(root);
    const std::array<Vec3, 6> offsets{Vec3{-3, 0, 0}, Vec3{-3, 0, -3}, Vec3{0, 0, -3},
                                      Vec3{3, 0, -3}, Vec3{3, 0, 0},   Vec3{}};
    for (unsigned slot = 0; slot < 6; ++slot) {
        const auto destination = logic.teleport_destination(1, slot);
        check(destination.has_value(), "hidden collision-disabled destination still resolves");
        equal(destination->first, Vec3{40, .5, 30} + offsets[slot],
              "six rider slots keep authored three-metre spread, including full diagonals");
        equal(destination->second, {0, 0, -1}, "all slots face exit local positive Y");
    }
    check(!logic.teleport_destination(999), "missing target never falls back to another array row");
    bool rejected = false;
    try {
        logic.teleport_destination(1, 6);
    } catch (const std::invalid_argument&) {
        rejected = true;
    }
    check(rejected, "rider identity must be within the six creation slots");
}

void orientation(const std::filesystem::path& root) {
    auto rows = fixture(root);
    rows[1]["Rotation"] = {0, 0, std::sin(pi / 4), std::cos(pi / 4)};
    rows[1]["Scale"] = {2, 3, 4};
    write(root, "Instances.json", {{"Instances", rows}});
    auto logic = WorldLogic::load(root);
    const auto pose = logic.teleport_destination(1);
    equal(pose->first, {40, .5, 33}, "exit rotation orients spread while authored scale cannot multiply three metres");
    equal(pose->second, {-1, 0, 0}, "raw exit positive Y becomes the correct native horizontal heading");
}

void graphs(const std::filesystem::path& root) {
    fixture(root);
    auto logic = WorldLogic::load(root);
    logic.contact(0, 20);
    const auto actions = logic.take_actions();
    check(actions.size() == 2 && actions[0].kind == WorldActionKind::CourseSound && actions[0].value == 122 &&
              actions[1].kind == WorldActionKind::Teleport && actions[1].target == 1 && actions[1].rider,
          "entry cue precedes owned teleport and stable reference overrides stale payload");
    auto doc = document();
    doc["graphs"][0]["nodes"][1]["references"]["instance"] = "missing";
    doc["graphs"][0]["nodes"].push_back(node(8, {{"SoundPlay", 123}}));
    write(root, "Effects.json", doc);
    logic = WorldLogic::load(root);
    logic.contact(0, 20);
    const auto missing = logic.take_actions();
    check(missing.size() == 2 && missing[1].value == 123,
          "unresolved teleport is silent and following graph nodes still execute");
    doc = document();
    doc["functions"] = {{{"id", "setup"},
                         {"name", "FreerideMode"},
                         {"nodes", Json::array({node(24, Json::object(), {{"instance", "instance:1"}})})}}};
    write(root, "Effects.json", doc);
    logic = WorldLogic::load(root);
    check(logic.take_actions().empty(), "mode setup without a rider cannot teleport the player");
    std::filesystem::remove(root / "Effects.json");
    write(root, "SSFLogic.json",
          {{"EffectHeaders",
            Json::array({{{"Effects", Json::array({{{"MainType", 24}, {"TeleportInstanceIndex", 1}}})}}})},
           {"Functions", Json::array()},
           {"EffectSlots", Json::array({{{"CollisionEffectSlot", 0}}})}});
    logic = WorldLogic::load(root);
    logic.contact(0, 20);
    const auto legacy = logic.take_actions();
    check(legacy.size() == 1 && legacy[0].kind == WorldActionKind::Teleport && legacy[0].target == 1,
          "legacy Maps retain teleport target joins");
    std::filesystem::remove(root / "SSFLogic.json");
}

void mounted(const std::filesystem::path& root) {
    fixture(root);
    Player player(Terrain::load(root));
    player.warp({-3, -.005, 0}, {1, 0, 0}, {600, 0, 0});
    const auto serial = player.placement_serial(), audio = player.audio_reset_serial();
    AudioScene scene(root);
    scene.tick(player, player.rider());
    auto music = std::make_shared<PcmClip>();
    music->samples.resize(48000, .1f);
    music->priority = 101;
    const auto voice = scene.mixer().play(music);
    const auto old = player.rider();
    player.tick({});
    scene.tick(player, old);
    check(scene.mixer().status(voice).has_value(), "instant teleport preserves the existing music voice");
    equal(player.rider().position, {37, 0, 30}, "crossed portal places rider beside the target on native ground");
    equal(player.rider().velocity, {}, "teleport arrival stops carried velocity exactly");
    equal(player.camera_forward(), {0, 0, -1}, "camera snaps to destination heading");
    check(player.teleports() == 1 && player.placement_serial() > serial && player.audio_reset_serial() == audio,
          "transport changes spatial serial while preserving music epoch");
    check(!player.on_foot() && !player.rider().rail_spline && !player.reset_pending(),
          "mounted arrival drops old motion without course-reset hold");
    check(player.contacts().empty() && !player.rider().bounces && !player.rider().hard_impacts,
          "old sweep ends before the solid behind the entrance can bounce or crash");
    equal(player.rider().previous_position, player.rider().position, "arrival has no long interpolation segment");
    player.tick({});
    check(player.teleports() == 1, "new tick cannot replay contacts at the old entrance");
    for (unsigned slot = 0; slot < 6; ++slot) {
        PlayTuning tuning;
        tuning.rider_slot = slot;
        Player field(Terrain::load(root), tuning);
        field.warp({0, 0, 0}, {1, 0, 0});
        field.tick({});
        auto pose = field.logic().teleport_destination(1, slot);
        pose->first.y = 0;
        equal(field.rider().position, pose->first, "player creation slot selects its own arrival spread");
    }
    fixture(root);
    Player walker(Terrain::load(root));
    walker.warp({0, 0, 0}, {1, 0, 0});
    walker.start_on_foot();
    walker.tick({});
    check(walker.on_foot() && walker.teleports() == 1,
          "walking contact reaches the same teleport without mounting automatically");
    equal(walker.rider().position, {37, 0, 30}, "walker retains the target spread and ground probe");
    check(walker.board_distance() < 1 && walker.interact_board(),
          "parked board relocates within reach of transported walker");
}

void run_state(const std::filesystem::path& root) {
    fixture(root);
    write(root, "AIP.json",
          {{"StartPosList", Json::array()},
           {"AIPaths", Json::array()},
           {"RaceLines",
            Json::array(
                {{{"PathPos", {-1000, 0, 0}},
                  {"PathPoints", {{11000, 0, 0}}},
                  {"DistanceToFinish", 2000},
                  {"PathEvents",
                   Json::array(
                       {{{"EventType", 11}, {"EventValue", 50}, {"EventStart", 1500}, {"EventEnd", 1500}}})}}})}});
    Player player(Terrain::load(root));
    player.configure_run(RunMode::Showoff);
    player.warp({-50, 0, 0}, {1, 0, 0});
    for (unsigned i = 0; i < 181; ++i)
        player.tick({});
    auto& scoring = player.scoring();
    scoring.step(dt, ScoreMotion::Air);
    for (unsigned i = 0; i < 80; ++i)
        scoring.step(dt, ScoreMotion::Air, 4.5);
    scoring.land();
    player.warp({-3, -.005, 0}, {1, 0, 0}, {600, 0, 0});
    const auto points = scoring.status().banked;
    const auto meter = scoring.status().meter;
    const auto clock = player.course_run().status().clock;
    player.tick({});
    check(player.teleports() == 1 && player.course_run().status().phase == RunPhase::Running,
          "instant transport across finish does not end the run");
    check(player.course_run().status().checkpoints == 0, "teleport cannot collect a skipped checkpoint");
    near(player.course_run().status().clock, clock - dt,
         "transport preserves the active countdown and consumes only normal tick time");
    check(scoring.status().banked == points, "banked score survives authored teleport");
    near(scoring.status().meter, meter, "automatic transport adds no manual-reset energy penalty");
    std::filesystem::remove(root / "AIP.json");
}

void owned(const std::filesystem::path& root) {
    auto logic = WorldLogic::load(root);
    logic.tick(0);
    logic.take_actions();
    logic.contact(2308, 20);
    const auto actions = logic.take_actions();
    check(actions.size() == 2 && actions[0].kind == WorldActionKind::CourseSound && actions[0].value == 122 &&
              actions[1].kind == WorldActionKind::Teleport && actions[1].target == 3332,
          "actual Merqury entrance reaches course cue and exact destination");
    const auto destination = logic.teleport_destination(3332);
    equal(destination->first, {-337.2412109375, -1545.88984375, -2450.14375},
          "actual destination uses source world position and local slot-zero offset");
    equal(destination->second, {0, 0, -1}, "actual exit heading matches authored orientation");
}
} // namespace

int main(int argc, char** argv) {
    try {
        const auto root =
            std::filesystem::temp_directory_path() /
            ("openslope-teleport-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directories(root);

        struct Cleanup {
            std::filesystem::path root;

            ~Cleanup() {
                std::error_code error;
                std::filesystem::remove_all(root, error);
            }
        } cleanup{root};

        placements(root);
        orientation(root);
        graphs(root);
        mounted(root);
        run_state(root);
        if (argc >= 2)
            owned(argv[1]);
        std::cout << "PASS: " << checks
                  << " teleport spread, orientation, ownership, source joins, physics interruption and run continuity "
                     "checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
