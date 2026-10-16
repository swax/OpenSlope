#include "field_presentation.hpp"
#include "openslope/ai_field.hpp"
#include "openslope/ride_ui.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace {
using namespace openslope;
using Json = nlohmann::json;
constexpr double dt = 1. / 60;
unsigned checks = 0;

void check(bool value, const char* why) {
    ++checks;
    if (!value)
        throw std::runtime_error(why);
}

void near(double a, double b, const char* why) { check(std::abs(a - b) < 1e-7, why); }

void write(const std::filesystem::path& root, const char* name, const Json& value) {
    std::ofstream(root / name) << value;
}

Json node(int type, Json payload = Json::object(), Json references = Json::object()) {
    return {{"mainType", type}, {"payload", payload}, {"references", references}};
}

Json graph(Json nodes) {
    return {{"kind", "openslope-effects"},
            {"version", 1},
            {"graphs", Json::array({{{"id", "hit"}, {"nodes", nodes}}})},
            {"slots", Json::array({{{"id", "slot"}, {"circumstances", {{"collision", "hit"}}}}})},
            {"functions", Json::array()},
            {"instances", Json::array()},
            {"objectProperties", Json::array()},
            {"splines", Json::array()}};
}

void fixture(const std::filesystem::path& root, Json nodes = Json::array()) {
    write(root, "Slopesmith.json", {{"schema", 1}, {"kind", "slopesmith-export"}, {"laps", 1}});
    Json points = Json::array();
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            points.push_back({-10000. + 20000. * u / 3, -10000. + 120000. * v / 3, 0});
    write(root, "Patches.json",
          {{"Patches", Json::array({{{"PatchName", "Field floor"},
                                     {"SurfaceType", 1},
                                     {"TrickOnlyPatch", false},
                                     {"Points", points},
                                     {"TexturePath", ""},
                                     {"LightmapID", -1},
                                     {"UVPoints", {{0, 0}, {0, 1}, {1, 0}, {1, 1}}},
                                     {"LightMapPoint", {0, 0, 0, 0}}}})}});
    Json paths = Json::array();
    for (int x : {-1000, 1000}) {
        Json steps = Json::array();
        for (unsigned i = 0; i < 100; ++i)
            steps.push_back({0, 400, 0});
        paths.push_back({{"PathPos", {x, 0, 0}},
                         {"PathPoints", steps},
                         {"U3", 50},
                         {"DistanceToFinish", 40000},
                         {"PathEvents", Json::array()}});
    }
    write(root, "AIP.json", {{"AIPaths", paths}, {"RaceLines", paths}, {"StartPosList", {0, 1}}});
    write(root, "Models.json",
          {{"Models",
            Json::array({{{"ModelObjects",
                           Json::array({{{"ParentID", -1},
                                         {"CollisionBounds", {{"Min", {-100, -100, 0}}, {"Max", {100, 100, 400}}}},
                                         {"MeshData", Json::array()}}})}}})}});
    write(root, "Instances.json",
          {{"Instances", Json::array({{{"ModelID", 0},
                                       {"Location", {0, 2000, 0}},
                                       {"Rotation", {0, 0, 0, 1}},
                                       {"Scale", {1, 1, 1}},
                                       {"Visable", true},
                                       {"PlayerCollision", true},
                                       {"PlayerBounce", false},
                                       {"CollsionMode", 2},
                                       {"U0", 0},
                                       {"EffectSlotIndex", 0},
                                       {"SurfaceType", -1}}})}});
    write(root, "Effects.json", graph(std::move(nodes)));
}

void seat(Player& rider, double x, double station, double speed = 12) {
    rider.warp({x, -.005, -station}, {0, 0, -1}, {0, 0, -speed});
}

void ownership(const std::filesystem::path& root) {
    fixture(root,
            Json::array({node(4, {{"WaitTime", .05}}), node(17, {{"type17", 5}}), node(18, {{"type18", 8}}),
                         node(8, {{"SoundPlay", 122}}), node(0, {{"type0", {{"SubType", 5}, {"DeadNodeMode", 2}}}})}));
    Player player(Terrain::load(root));
    seat(player, -20, 0);
    player.ai_riders(2);
    auto& field = *player.ai_field();
    check(&field.rider(0).terrain() == &player.terrain() && &field.rider(1).world() == &player.world() &&
              &field.rider(0).logic() == &player.logic(),
          "Opponents share course geometry and the mutable world");
    seat(field.rider(0), 0, 20, 0);
    seat(field.rider(1), 20, 0);
    for (unsigned i = 0; i < 4 && field.rider(0).contacts().empty(); ++i)
        player.tick({});
    check(!field.rider(0).contacts().empty(), "The authored fixture receives a real opponent body contact");
    check(field.rider(0).rider().pads.speed == 0, "An opponent's delayed pad does not fire early");
    for (unsigned i = 0; i < 2; ++i)
        player.tick({});
    check(field.rider(0).rider().pads.speed == 0, "World waits are not advanced once per competitor");
    player.tick({});
    check(field.rider(0).rider().pads.speed > 4.9, "The delayed graph boosts its triggering opponent");
    check(player.rider().pads.speed == 0 && field.rider(1).rider().pads.speed == 0,
          "An opponent cannot boost the local player or another opponent");
    check(field.rider(0).rider().pads.trick == 0, "AI ignores human-only trick-meter pads");
    check(player.logic().flags()[0] == 0 && field.rider(1).logic().flags()[0] == 0,
          "An opponent's graph changes the single world observed by everyone");
    check(std::none_of(player.world_actions().begin(), player.world_actions().end(),
                       [](const auto& action) { return action.kind == WorldActionKind::BoostSound; }),
          "An AI pickup never plays the local human's boost cue");
    check(std::count_if(player.world_actions().begin(), player.world_actions().end(),
                        [](const auto& action) {
                            return action.kind == WorldActionKind::CourseSound && action.value == 122;
                        }) == 1,
          "An opponent's spatial course sound reaches the local audio observer exactly once");

    fixture(root, Json::array({node(4, {{"WaitTime", .1}}), node(17, {{"type17", 5}})}));
    Player retiring(Terrain::load(root));
    seat(retiring, -20, 0);
    retiring.ai_riders(1);
    seat(retiring.ai_field()->rider(0), 0, 20, 0);
    for (unsigned i = 0; i < 4 && retiring.ai_field()->rider(0).contacts().empty(); ++i)
        retiring.tick({});
    check(!retiring.ai_field()->rider(0).contacts().empty(),
          "The retiring actor has actually started its delayed graph");
    retiring.ai_riders(0);
    retiring.ai_riders(1);
    for (unsigned i = 0; i < 12; ++i)
        retiring.tick({});
    near(retiring.ai_field()->rider(0).rider().pads.speed, 0,
         "A retired actor's pending graph cannot boost a replacement");
    near(retiring.rider().pads.speed, 0, "Retirement cannot reroute a pending boost to the human");
}

void lifecycle(const std::filesystem::path& root) {
    fixture(root);
    Player player(Terrain::load(root));
    player.configure_run(RunMode::Race);
    player.ai_riders(2);
    const auto gate = player.ai_field()->rider(0).rider().position;
    for (unsigned i = 0; i < 179; ++i)
        player.tick({});
    near(length(player.ai_field()->rider(0).rider().position - gate), 0,
         "Opponents wait at the gate through the local countdown");
    for (unsigned i = 0; i < 240; ++i)
        player.tick({});
    check(player.ai_field()->rider(0).rider().position.z < gate.z - 2,
          "The field rides through shared Player physics after GO");
    const auto clock = player.ai_field()->rider(0).course_run().status().clock;
    const auto p = player.ai_field()->rider(0).rider().position;
    player.start_on_foot();
    for (unsigned i = 0; i < 120; ++i)
        player.tick({});
    check(player.ai_field()->size() == 2 && player.ai_field()->rider(0).rider().position.z < p.z - 2,
          "Dismount preserves the field and opponents keep racing");
    near(player.ai_field()->rider(0).course_run().status().clock - clock, 2,
         "An opponent's race clock follows real ticks rather than catch-up dilation");
    const auto old = player.ai_field()->standings()[1].actor;
    player.restart_run();
    player.tick({});
    check(player.ai_field()->size() == 2 &&
              std::none_of(player.ai_field()->standings().begin(), player.ai_field()->standings().end(),
                           [&](const auto& row) { return row.actor == old && old != 0; }),
          "Restart reseeds opponents with fresh identities");
    player.ai_riders(16);
    check(player.ai_field()->size() == 16, "The field supports sixteen opponents plus the local rider");
    player.ai_riders(0);
    check(!player.ai_field(), "Zero opponents releases the complete field");
}

void commands(const std::filesystem::path& root) {
    fixture(root, Json::array({node(13)}));
    Player reset(Terrain::load(root));
    seat(reset, -20, 120);
    reset.ai_riders(2);
    reset.ai_field()->rider(0).warp({-3.5, -.005, -20}, {1, 0, 0}, {15, 0, 0});
    seat(reset.ai_field()->rider(1), 20, 160);
    for (unsigned i = 0; i < 30 && !reset.ai_field()->rider(0).reset_pending(); ++i)
        reset.tick({});
    check(reset.ai_field()->rider(0).reset_pending() && !reset.reset_pending() &&
              !reset.ai_field()->rider(1).reset_pending(),
          "An opponent's reset volume commands only that rider");
    for (unsigned i = 0; i < 90; ++i)
        reset.tick({});
    const auto recovered = reset.ai_field()->rider(0).last_course_recovery();
    check(recovered && recovered->source == RecoverySource::AIPath && recovered->station > 100,
          "An opponent recovers on a safe AI line biased forward toward the rest of the field");

    fixture(root, Json::array({node(24, Json::object(), {{"instance", "instance:1"}})}));
    auto rows = Json::parse(std::ifstream(root / "Instances.json"));
    auto destination = rows["Instances"][0];
    destination["Location"] = {4000, 8000, 0};
    destination["PlayerCollision"] = false;
    destination["EffectSlotIndex"] = -1;
    rows["Instances"].push_back(destination);
    write(root, "Instances.json", rows);
    Player teleported(Terrain::load(root));
    seat(teleported, -20, 0);
    teleported.ai_riders(2);
    seat(teleported.ai_field()->rider(0), 0, 20, 0);
    seat(teleported.ai_field()->rider(1), 20, 0);
    for (unsigned i = 0; i < 4; ++i)
        teleported.tick({});
    check(teleported.ai_field()->rider(0).teleports() == 1 && teleported.teleports() == 0 &&
              teleported.ai_field()->rider(1).teleports() == 0,
          "Teleport graphs carry the opponent subject through the shared dispatcher");
    check(teleported.ai_field()->rider(0).rider().position.x > 35,
          "The opponent uses its six-slot destination placement rather than moving the human");
}

void recovery_clearance(const std::filesystem::path& root) {
    fixture(root);
    auto routes = Json::parse(std::ifstream(root / "AIP.json"));
    routes["AIPaths"][0]["PathPos"][0] = 0;
    write(root, "AIP.json", routes);
    auto instances = Json::parse(std::ifstream(root / "Instances.json"));
    instances["Instances"][0]["U0"] = 1;
    instances["Instances"][0]["PlayerBounce"] = true;
    instances["Instances"][0]["EffectSlotIndex"] = -1;
    write(root, "Instances.json", instances);
    Player player(Terrain::load(root));
    seat(player, -20, 20);
    player.ai_riders(2);
    auto& field = *player.ai_field();
    seat(field.rider(0), 0, 20, 0);
    seat(field.rider(1), 10, 20, 0);
    check(field.rider(0).recover_course(false), "the opponent accepts an ordinary automatic course reset");
    for (unsigned i = 0; i < 120 && !field.rider(0).last_course_recovery(); ++i)
        player.tick({.posture = -1});
    const auto target = field.rider(0).last_course_recovery();
    check(target && target->path == 1 && target->position.x > 9,
          "opponent recovery ranks a clear nearby route ahead of a respawn point inside a prop");
}

void recovery_paths(const std::filesystem::path& root) {
    const auto setup = [&](const char* name, int event = 0, bool one_respawn = false) {
        const auto map = root / name;
        std::filesystem::create_directory(map);
        fixture(map);
        auto routes = Json::parse(std::ifstream(map / "AIP.json"));
        routes["AIPaths"][0]["PathPos"][0] = 0;
        routes["AIPaths"][1]["PathPos"][0] = 400;
        routes["AIPaths"][0]["U3"] = 100;
        routes["AIPaths"][1]["U3"] = 0;
        if (event)
            routes["AIPaths"][0]["PathEvents"] =
                Json::array({{{"EventType", event}, {"EventValue", 0}, {"EventStart", 1500}, {"EventEnd", 2500}}});
        if (one_respawn)
            routes["AIPaths"][0]["Respawnable"] = false;
        write(map, "AIP.json", routes);
        return map;
    };
    const auto place = [&](Player& player, double x) {
        seat(player, -20, 20, 0);
        player.ai_riders(2);
        seat(player.ai_field()->rider(0), x, 20, 0);
        seat(player.ai_field()->rider(1), 20, 20, 0);
        player.tick({.posture = -1});
        check(player.ai_field()->control(0).progress && player.ai_field()->control(0).progress->path == 0,
              "The fixture rider tracks its chosen line even beside a closer differently rated route");
    };
    const auto recover = [&](Player& player) {
        auto& actor = player.ai_field()->rider(0);
        check(actor.recover_course(false), "The ordinary opponent reset request is accepted");
        for (unsigned i = 0; i < 120 && !actor.last_course_recovery(); ++i)
            player.tick({.posture = -1});
        check(actor.last_course_recovery().has_value(), "The opponent completes its reset hold");
        return *actor.last_course_recovery();
    };

    Player cached(Terrain::load(setup("cached")));
    place(cached, 4);
    const auto current = recover(cached);
    check(current.source == RecoverySource::AIPath && current.path == 0 && std::abs(current.position.x) < 1e-8,
          "Opponent recovery anchors its current tracked line instead of reselecting from the displaced body");

    for (const int event : {100, 103, 105}) {
        Player window(Terrain::load(setup(("window-" + std::to_string(event)).c_str(), event)));
        place(window, 0);
        const auto target = recover(window);
        near(target.station, event == 103 ? 15 : 25,
             "Opponent recovery applies authored backward, forward and jump reset windows");
        near(target.position.z, event == 103 ? -15 : -25,
             "The adjusted station controls the actual opponent reset destination");
    }

    for (const double x : {0., 4.}) {
        Player blocked(Terrain::load(setup(("blocked-" + std::to_string(int(x))).c_str(), 104)));
        place(blocked, x);
        check(!blocked.ai_field()->rider(0).recover_course(false) && !blocked.ai_field()->rider(0).reset_pending(),
              "The tracked line's no-reset window refuses an opponent even beside a different closer route");
    }
    Player fresh(Terrain::load(setup("fresh-warp", 104)));
    place(fresh, 0);
    seat(fresh.ai_field()->rider(0), 4, 20, 0);
    check(fresh.ai_field()->rider(0).recover_course(false),
          "A new independent warp does not retain the previous line's no-reset window before its next input tick");

    Player reseeded(Terrain::load(setup("reseeded", 0, true)));
    place(reseeded, 0);
    const auto destination = recover(reseeded);
    check(destination.path == 1, "Reset selects the nearby respawn-enabled route over its non-respawnable line");
    reseeded.tick({.posture = -1});
    check(reseeded.ai_field()->control(0).progress && reseeded.ai_field()->control(0).progress->path == 1,
          "The input tracker resumes the route actually selected for reset despite a different mood preference");
    seat(reseeded.ai_field()->rider(0), 0, 20, 0);
    reseeded.tick({.posture = -1});
    check(reseeded.ai_field()->control(0).progress && reseeded.ai_field()->control(0).progress->path == 0,
          "A later independent warp chooses afresh instead of reusing historical reset metadata");

    const auto slope_map = setup("slope");
    auto terrain = Json::parse(std::ifstream(slope_map / "Patches.json"));
    for (auto& point : terrain["Patches"][0]["Points"])
        point[2] = -.1 * point[1].get<double>();
    write(slope_map, "Patches.json", terrain);
    auto routes = Json::parse(std::ifstream(slope_map / "AIP.json"));
    for (auto& path : routes["AIPaths"])
        for (auto& step : path["PathPoints"])
            step[2] = -.1 * step[1].get<double>();
    write(slope_map, "AIP.json", routes);
    Player sloped(Terrain::load(slope_map));
    place(sloped, 0);
    recover(sloped);
    near(sloped.ai_field()->rider(0).rider().velocity.y, 0,
         "Opponent drop-in seeds horizontal course velocity rather than the path's vertical slope");
    near(length(sloped.ai_field()->rider(0).rider().velocity), 30. / 3.6,
         "The shared drop-in retains its exact thirty-kilometre-per-hour speed");
}

void menu(const std::filesystem::path& root) {
    fixture(root);
    Player player(Terrain::load(root));
    RideUi ui;
    ui.visible = true;
    ui.frame({{}, {1, 0, 0}, {0, -1, 0}, true});
    const auto press = [&](UiAction action) {
        const auto buttons = ui.buttons();
        const auto button =
            std::find_if(buttons.begin(), buttons.end(), [&](const auto& row) { return row.action == action; });
        check(button != buttons.end(), "The requested opponent control exists in the actual menu");
        const EquipmentRay ray{{button->x + button->w / 2, -button->y - button->h / 2, 1}, {0, 0, -1}, true};
        ui.pointer(ray, false);
        const auto selected = ui.pointer(ray, true);
        check(selected.action == action && selected.consumed,
              "The actual menu ray selects and consumes the opponent action");
        return ui.riders(selected.action, player);
    };
    check(press(UiAction::Riders) && ui.rider_options, "The desktop and wrist menu share the same opponent controls");
    for (unsigned i = 0; i < 18; ++i)
        press(UiAction::RiderUp);
    check(player.ai_field() && player.ai_field()->size() == 16, "The menu caps opponents at sixteen");
    Avatar avatar;
    std::vector<Vertex> figures;
    const auto boards = append_opponents(player, avatar, figures, {0, 3, 4});
    check(boards.size() == 16 && figures.size() == 16 * avatar.source_triangles() * 3,
          "All opponents use the complete shared figure without controller models or help labels");
    check(figures.size() <= 16 * 30000, "Sixteen figures remain inside the bounded GPU submission");
    for (unsigned i = 0; i < 18; ++i)
        press(UiAction::RiderDown);
    check(!player.ai_field(), "The menu returns to a zero-allocation solo field");
    press(UiAction::Riders);
    ui.immersive = ui.map_picker = true;
    press(UiAction::Riders);
    press(UiAction::RiderUp);
    check(player.ai_field() && player.ai_field()->size() == 1, "The actual Quest wrist menu can add a rider");
    press(UiAction::RiderDown);
    Player no_routes(Terrain::demo());
    ui.riders(UiAction::RiderUp, no_routes);
    check(!no_routes.ai_field() && !ui.notice.empty(), "A map without AI routes stays playable with a friendly notice");
}

void laps(const std::filesystem::path& root) {
    fixture(root,
            Json::array({node(
                0, {{"type0",
                     {{"SubType", 15}, {"type0Sub15", {{"U0", 5}, {"U1", 25}, {"U2", 0}, {"U3", 0}, {"U4", 1}}}}}})}));
    write(root, "Slopesmith.json", {{"schema", 1}, {"kind", "slopesmith-export"}, {"laps", 4}});
    Player player(Terrain::load(root));
    player.configure_run(RunMode::Race);
    player.ai_riders(2);
    for (unsigned i = 0; i < 182; ++i)
        player.tick({});
    seat(player.ai_field()->rider(0), 0, 20, 0);
    for (unsigned i = 0; i < 4; ++i)
        player.tick({});
    check(player.ai_field()->rider(0).course_run().status().remaining == 3 &&
              player.ai_field()->rider(1).course_run().status().remaining == 4 &&
              player.course_run().status().remaining == 4,
          "A lift consumes only the entering opponent's lap");
    seat(player.ai_field()->rider(1), 0, 20, 0);
    for (unsigned i = 0; i < 4; ++i)
        player.tick({});
    check(player.ai_field()->rider(0).course_run().status().remaining == 3 &&
              player.ai_field()->rider(1).course_run().status().remaining == 3,
          "A second rider gets its own lap entry while the first is being lifted");
    for (unsigned i = 0; i < 181; ++i)
        player.tick({});
    seat(player.ai_field()->rider(0), 0, 20, 0);
    for (unsigned i = 0; i < 4; ++i)
        player.tick({});
    check(player.ai_field()->rider(0).course_run().status().remaining == 2 &&
              player.ai_field()->rider(1).course_run().status().remaining == 3,
          "The next passage advances only that opponent and keeps the other counter private");
}

void standings_and_separation(const std::filesystem::path& root) {
    fixture(root);
    Player player(Terrain::load(root));
    seat(player, 30, 60, 0);
    player.ai_riders(3);
    seat(player.ai_field()->rider(0), -10, 120, 0);
    seat(player.ai_field()->rider(1), -10, 30, 0);
    seat(player.ai_field()->rider(2), 10, 90, 0);
    for (unsigned i = 0; i < 60; ++i)
        player.tick({});
    const auto rows = player.ai_field()->standings();
    check(rows[0].rider == &player.ai_field()->rider(0) && rows[1].rider == &player.ai_field()->rider(2) &&
              rows[2].rider == &player && rows[3].rider == &player.ai_field()->rider(1),
          "Standings include the local player and sort by course progress");
    check(player.ai_field()->place() == 2, "The local HUD receives the actual field placement");
    check(player.ai_field()->control(0).time_scale < 1 && player.ai_field()->control(2).time_scale > 1,
          "The leader paces the runner-up and the next opponent paces its immediate leader");
    seat(player, -10, 40, 0);
    seat(player.ai_field()->rider(0), -10, 40, 0);
    player.tick({});
    check(length(player.rider().position - player.ai_field()->rider(0).rider().position) > 1.4,
          "Rider bodies separate through world collision without a forced knockdown");
    check(player.rider().crashes == 0 && player.ai_field()->rider(0).rider().crashes == 0,
          "Body contact preserves the no-knockdown play profile");
}

std::vector<Vec3> paced(const std::filesystem::path& root, unsigned hz) {
    Player player(Terrain::load(root));
    seat(player, 30, 30);
    player.ai_riders(2);
    for (unsigned i = 0; i < hz * 5; ++i)
        player.advance(1. / hz, {});
    return {player.rider().position, player.ai_field()->rider(0).rider().position,
            player.ai_field()->rider(1).rider().position};
}

void pacing(const std::filesystem::path& root) {
    fixture(root);
    const auto baseline = paced(root, 60);
    for (unsigned hz : {30, 72, 90, 120}) {
        const auto other = paced(root, hz);
        for (unsigned i = 0; i < baseline.size(); ++i)
            near(length(baseline[i] - other[i]), 0, "The entire field is independent of presentation frame rate");
    }
}

void boost_snapshot(const std::filesystem::path& root) {
    fixture(root);
    Player player(Terrain::load(root));
    seat(player, 0, 0);
    for (unsigned i = 0; i < 24; ++i)
        player.tick({.boost = true});
    const auto expected = player.boost_trail_mesh();
    check(expected.count == 84, "The snapshot fixture generates a complete real boost trail");
    const FieldEffects snapshot(player, {0, 3, 4});
    player.warp({0, 0, 0}, {0, 0, -1});
    const auto vertices = snapshot.boost();
    check(vertices.size() == expected.count, "A frame keeps its boost geometry alive after the source resets");
    for (std::size_t i = 0; i < vertices.size(); ++i)
        check(length(vertices[i].position - expected.points[i].position) < 1e-9 &&
                  vertices[i].colour == expected.points[i].colour,
              "Retained boost vertices keep their original positions and colours");
}

void owned(const std::filesystem::path& maps) {
    unsigned courses = 0;
    for (const auto& entry : std::filesystem::directory_iterator(maps)) {
        if (!entry.is_directory() || !std::filesystem::exists(entry.path() / "AIP.json"))
            continue;
        Player player(Terrain::load(entry.path()));
        player.ai_riders(6);
        std::array<double, 6> start{}, advance{};
        for (unsigned a = 0; a < 6; ++a)
            start[a] = player.ai_field()
                           ->rider(a)
                           .course_run()
                           .locate(player.ai_field()->rider(a).rider().position)
                           ->distance_to_finish;
        const auto before = std::chrono::steady_clock::now();
        for (unsigned i = 0; i < 600; ++i) {
            player.tick({});
            for (unsigned a = 0; a < player.ai_field()->size(); ++a) {
                const auto& rider = player.ai_field()->rider(a).rider();
                check(finite(rider.position) && finite(rider.velocity),
                      "The owned field stays finite in the actual world");
                if (const auto progress = player.ai_field()->rider(a).course_run().locate(rider.position))
                    advance[a] = std::max(advance[a], start[a] - progress->distance_to_finish);
            }
        }
        std::cout << entry.path().filename().string() << ": six opponents, 600 shared ticks, "
                  << std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - before).count() / 600
                  << " ms/tick\n";
        std::cout << "  minimum progress " << *std::min_element(advance.begin(), advance.end()) << " m\n";
        check(*std::min_element(advance.begin(), advance.end()) > 20,
              "Every owned opponent makes meaningful course progress in the shared field");
        ++courses;
    }
    check(courses > 0, "Owned field checks discover course networks");
}
} // namespace

int main(int argc, char** argv) {
    try {
        const auto root =
            std::filesystem::temp_directory_path() /
            ("openslope-field-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directories(root);

        struct Cleanup {
            std::filesystem::path root;

            ~Cleanup() {
                std::error_code ec;
                std::filesystem::remove_all(root, ec);
            }
        } cleanup{root};

        ownership(root);
        lifecycle(root);
        commands(root);
        menu(root);
        laps(root);
        standings_and_separation(root);
        pacing(root);
        boost_snapshot(root);
        const auto clear_root = root / "recovery-clearance";
        std::filesystem::create_directory(clear_root);
        recovery_clearance(clear_root);
        const auto reset_root = root / "recovery-paths";
        std::filesystem::create_directory(reset_root);
        recovery_paths(reset_root);
        if (argc == 2)
            owned(argv[1]);
        std::cout << "PASS: " << checks << " shared AI field checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
