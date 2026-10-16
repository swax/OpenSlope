#include "openslope/avatar.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;

void check(bool ok, const char* what) {
    ++checks;
    if (!ok)
        throw std::runtime_error(what);
}

void near(Vec3 a, Vec3 b, const char* what) { check(length(a - b) < 1e-7, what); }

Terrain floor() {
    Patch p;
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            p.points[u * 4 + v] = {double(u) * 100 / 3 - 50, 0, double(v) * 100 / 3 - 50};
    return Terrain({p});
}

void write(const std::filesystem::path& path, const Json& value) { std::ofstream(path) << value; }

void desktop_toggle() {
    for (const unsigned fps : {60u, 72u, 90u, 120u, 144u}) {
        Player p(floor());
        p.warp({}, {0, 0, -1});
        p.start_on_foot();
        RideInput walk;
        walk.posture = 1;
        walk.walk_forward = {0, 0, -1};
        walk.face_walk_forward = true;
        for (unsigned i = 0; i < fps * 2; ++i)
            p.advance(1. / fps, walk);
        check(p.board_distance() > 10, "Desktop toggle fixture leaves the parked board behind");
        const auto feet = p.rider().position, velocity = p.rider().velocity;
        RideInput toggle;
        toggle.toggle_board = true;
        toggle.walk_forward = {1, 0, 0};
        p.advance(1. / 240, toggle);
        p.advance(1. / 60 - 1. / 240, {});
        check(!p.on_foot(), "Short E press survives a frame without a fixed tick");
        near(p.rider().position, feet, "E equips at the current feet rather than teleporting to the distant board");
        near(p.rider().velocity, velocity, "E keeps walking momentum when equipping");
        near(p.rider().forward, {0, 0, -1}, "Released short E press uses retained on-foot facing");
        p.advance(1. / 60, toggle);
        check(p.on_foot(), "Fresh E dismounts while riding");
        for (unsigned i = 0; i < fps; ++i)
            p.advance(1. / fps, toggle);
        check(p.on_foot(), "Held E does not remount after dismounting");
        p.advance(1. / 60, {});
        p.advance(1. / 60, toggle);
        check(!p.on_foot(), "Released and repressed E mounts again");
        for (unsigned i = 0; i < fps; ++i)
            p.advance(1. / fps, toggle);
        check(!p.on_foot(), "Held E does not dismount after mounting");
    }
    for (const double height : {.02, 8.}) {
        Player air(floor());
        air.warp({0, height, 0}, {0, 0, -1}, {3, 5, -12});
        check(air.interact_board() && !air.rider().grounded, "Air mount fixture starts on foot with upward momentum");
        const auto feet = air.rider().position, velocity = air.rider().velocity;
        RideInput toggle;
        toggle.toggle_board = true;
        toggle.walk_forward = {1, 0, 0};
        air.tick(toggle);
        check(!air.on_foot() && !air.rider().grounded && air.rider().control == Control::Air,
              "E equips in mid-air even within the ground probe range");
        near(air.rider().position, feet, "Air equip does not snap down to the floor or a loose deck");
        near(air.rider().velocity, velocity, "Air equip preserves the complete flight velocity");
        near(air.rider().forward, {1, 0, 0}, "Air equip uses the current desktop look heading");
        check(air.rider().speed_cap >= length(velocity), "Air equip preserves an inherited flight speed cap");
        air.tick(toggle);
        check(!air.on_foot() && !air.rider().grounded && air.rider().position.y > feet.y,
              "Held air equip keeps flying instead of toggling or sticking to the floor");
    }
}

void geometry(const std::filesystem::path& root, Vec3 low, Vec3 high, int mass = 1) {
    Json points = Json::array();
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            points.push_back({(double(u) * 100 / 3 - 50) * 100, (double(v) * 100 / 3 - 50) * 100, 0});
    write(root / "Patches.json", {{"Patches", Json::array({{{"PatchName", "Walking floor"},
                                                            {"Points", points},
                                                            {"SurfaceType", 1},
                                                            {"TrickOnlyPatch", false},
                                                            {"TexturePath", ""},
                                                            {"LightmapID", -1},
                                                            {"UVPoints", {{0, 0}, {0, 1}, {1, 0}, {1, 1}}},
                                                            {"LightMapPoint", {0, 0, 0, 0}}}})}});
    const auto raw = [](Vec3 p) { return Json::array({p.x * 100, -p.z * 100, p.y * 100}); };
    const auto lo = raw(low), hi = raw(high);
    const Json bounds{
        {"Min",
         {std::min(lo[0].get<double>(), hi[0].get<double>()), std::min(lo[1].get<double>(), hi[1].get<double>()),
          std::min(lo[2].get<double>(), hi[2].get<double>())}},
        {"Max",
         {std::max(lo[0].get<double>(), hi[0].get<double>()), std::max(lo[1].get<double>(), hi[1].get<double>()),
          std::max(lo[2].get<double>(), hi[2].get<double>())}}};
    write(root / "Models.json",
          {{"Models",
            Json::array(
                {{{"ModelObjects",
                   Json::array({{{"ParentID", -1}, {"CollisionBounds", bounds}, {"MeshData", Json::array()}}})}}})}});
    write(root / "Materials.json", {{"Materials", Json::array()}});
    write(root / "Instances.json", {{"Instances", Json::array({{{"ModelID", 0},
                                                                {"CollsionMode", 2},
                                                                {"PlayerCollision", true},
                                                                {"PlayerBounce", true},
                                                                {"U0", mass},
                                                                {"SurfaceType", -1}}})}});
}
} // namespace

int main() {
    try {
        desktop_toggle();
        Player p(floor());
        Player drift(floor());
        drift.warp({0, -.005, 0}, {0, 0, -1}, {.02, 0, 0});
        for (unsigned i = 0; i < 180; ++i)
            drift.tick({});
        check(drift.rider().position.z < -5, "Tiny sideways drift cannot strand a board without cruise drive");
        p.warp({0, 0, 0}, {0, 0, -1});
        p.start_on_foot();
        check(p.on_foot() && p.rider().grounded, "start grounded on foot");
        check(p.rider().motion == Motion::OnFoot && p.rider().control == Control::OnFoot, "application walk state");
        check(p.board_distance() > .6 && p.board_distance() < .8, "board parked beside player");
        const auto board = p.render_board_position(), feet = p.rider().position;
        for (unsigned i = 0; i < 1800; ++i)
            p.advance(1. / 60, {});
        near(p.render_board_position(), board, "parked board stays put");
        near(p.rider().position, feet, "idle walker does not slide or cruise");
        check(p.effects().wake().empty() && p.effects().sprites().empty(), "walking has no board spray");
        const auto pose = avatar_pose(p);
        check(pose.on_foot, "walking avatar context");
        near(pose.up, {0, 1, 0}, "walker remains upright");
        check(length(pose.joint(AvatarJoint::Hips) - feet) < 1.1, "body belongs to walker, not board");
        RideInput mount;
        mount.mount = true;
        p.advance(1. / 120, mount);
        p.advance(1. / 120, {});
        check(!p.on_foot(), "short press survives fixed-step boundary");
        for (unsigned i = 0; i < 4; ++i)
            p.advance(1. / 60, {});
        p.advance(1. / 60, mount);
        check(p.on_foot(), "fresh press dismounts");
        for (unsigned i = 0; i < 20; ++i)
            p.advance(1. / 60, mount);
        check(p.on_foot(), "held mount button does not oscillate");
        p.reset();
        check(p.on_foot() && p.board_distance() < 1.6, "reset restores on-foot spawn and nearby board");
        check(!p.interact_board({4, 0, 0}), "physical room displacement affects proximity");
        check(p.interact_board({.7, 0, 0}) && !p.on_foot(), "nearby physical feet can mount");
        p.warp({0, 0, 0}, {0, 0, -1});
        p.start_on_foot();
        RideInput walk;
        walk.posture = 1;
        const auto start = p.rider().position;
        for (unsigned i = 0; i < 120; ++i)
            p.advance(1. / 60, walk);
        check(p.rider().position.z < start.z - 4, "stick walks forward");
        near(p.render_board_position(), board, "walking does not drag parked board");
        check(!p.interact_board(), "distant mount rejected");
        p.reset();
        RideInput jump;
        jump.jump = true;
        p.advance(1. / 60, jump);
        check(!p.rider().grounded && p.rider().velocity.y > 4, "walking jump");
        for (unsigned i = 0; i < 90; ++i)
            p.advance(1. / 60, jump);
        check(p.rider().grounded && p.rider().launches == 1, "held jump cannot repeat on landing");
        Player air(floor());
        air.warp({0, 8, 0}, {0, 0, -1}, {0, 0, -12});
        check(air.interact_board(), "airborne dismount");
        near(air.rider().velocity, {0, 0, -12}, "dismount keeps launch momentum");
        check(air.rider().position.y > 7.9, "no snap to ground in mid-air");
        for (unsigned i = 0; i < 4; ++i)
            air.advance(1. / 60, {});
        check(air.render_board_position().z < -.3 && air.render_board_position().y < air.render_position().y,
              "loose board keeps its own falling arc");
        for (unsigned i = 0; i < 600; ++i)
            air.advance(1. / 60, {});
        check(!air.board_coasting() && std::abs(air.render_board_position().y) < .01,
              "board lands and friction parks it");
        std::optional<Vec3> baseline;
        for (const auto fps : {60u, 72u, 90u, 120u, 144u}) {
            Player rate(floor());
            rate.warp({0, 0, 0}, {0, 0, -1});
            rate.start_on_foot();
            for (unsigned i = 0; i < fps * 2; ++i)
                rate.advance(1. / fps, walk);
            if (baseline)
                near(rate.rider().position, *baseline, "walking independent of render rate");
            else
                baseline = rate.rider().position;
        }
        const auto root =
            std::filesystem::temp_directory_path() /
            ("openslope-boarding-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directory(root);

        struct Cleanup {
            std::filesystem::path path;

            ~Cleanup() {
                std::error_code ec;
                std::filesystem::remove_all(path, ec);
            }
        } cleanup{root};

        geometry(root, {-3, 0, -3}, {3, 3, -2});
        Player wall(Terrain::load(root));
        wall.warp({0, 0, 0}, {0, 0, -1});
        wall.start_on_foot();
        for (unsigned i = 0; i < 180; ++i)
            wall.advance(1. / 60, walk);
        check(wall.rider().position.z > -1.75, "walker stops at solid wall");
        check(wall.rider().crashes == 0, "walking collision has no board crash");
        geometry(root, {-3, 0, -3}, {3, 3, -2}, 0);
        Player trigger(Terrain::load(root));
        trigger.warp({0, 0, 0}, {0, 0, -1});
        trigger.start_on_foot();
        for (unsigned i = 0; i < 120; ++i)
            trigger.advance(1. / 60, walk);
        check(trigger.rider().position.z < -4, "triggers do not block walking");

        const auto interactions = [&](Json nodes, int mass) {
            geometry(root, {-3, 0, -3}, {3, 3, -2}, mass);
            auto instances = Json::parse(std::ifstream(root / "Instances.json"));
            instances["Instances"][0]["EffectSlotIndex"] = 0;
            write(root / "Instances.json", instances);
            write(root / "Effects.json",
                  {{"kind", "openslope-effects"},
                   {"version", 1},
                   {"graphs", Json::array({{{"id", "hit"}, {"nodes", nodes}}})},
                   {"slots",
                    Json::array({{{"id", "slot:0"}, {"originalIndex", 0}, {"circumstances", {{"collision", "hit"}}}}})},
                   {"functions", Json::array()},
                   {"objectProperties", Json::array()},
                   {"instances", Json::array()},
                   {"splines", Json::array()}});
        };
        const Json sound{{"mainType", 8}, {"payload", {{"SoundPlay", 7}}}};
        interactions(
            Json::array({sound, {{"mainType", 0}, {"payload", {{"type0", {{"SubType", 5}, {"DeadNodeMode", 2}}}}}}}),
            1);
        Player breakable(Terrain::load(root));
        breakable.configure_run(RunMode::Showoff);
        breakable.warp({0, 0, 0}, {0, 0, -1});
        breakable.start_on_foot();
        unsigned cues = 0;
        for (unsigned i = 0; i < 120; ++i) {
            breakable.tick(walk);
            for (const auto& action : breakable.world_actions())
                cues += action.kind == WorldActionKind::CourseSound && action.rider;
        }
        check(breakable.logic().flags()[0] == 0 && cues == 1,
              "Actual blocking walk contact breaks and sounds once before the run starts");
        check(breakable.rider().position.z < -4 && breakable.course_run().status().phase == RunPhase::Ready,
              "Off-board interactions do not start the race/showoff clock");
        interactions(
            Json::array(
                {sound,
                 {{"mainType", 0},
                  {"payload",
                   {{"type0", {{"SubType", 0}, {"type0Sub0", {{"U0", 5}, {"U3", 0}, {"U4", 0}, {"U5", 0}}}}}}}}}),
            1);
        Json body;
        for (unsigned i = 0; i < 24; ++i)
            body["UFloat" + std::to_string(i)] = 0.;
        body["UFloat1"] = body["UFloat4"] = 250.;
        body["UFloat2"] = body["UFloat5"] = 60.;
        for (const auto i : {6u, 10u, 14u})
            body["UFloat" + std::to_string(i)] = 540.;
        for (const auto i : {15u, 19u, 23u})
            body["UFloat" + std::to_string(i)] = 1. / 540;
        body["U2"] = body["U3"] = 0;
        body["UByteData"] = "AA==";
        body["uPhysicsStruct0"] = Json::array({{{"U0", 60}, {"U1", 0}, {"U2", 1}}});
        write(root / "Physics.json", {{"PhysicsHeaders", Json::array({{{"PhysicsDatas", Json::array({body})}}})}});
        auto rigid_instance = Json::parse(std::ifstream(root / "Instances.json"));
        rigid_instance["Instances"][0]["CollsionMode"] = 3;
        rigid_instance["Instances"][0]["PhysicsIndex"] = 0;
        write(root / "Instances.json", rigid_instance);
        Player roller(Terrain::load(root));
        roller.warp({0, 0, 0}, {0, 0, -1});
        roller.start_on_foot();
        for (unsigned i = 0; i < 120; ++i)
            roller.tick(walk);
        check(roller.logic().flags()[0] & WorldDynamic, "Walking installs a roller body from its collision graph");
        check(!roller.logic().motions().empty(), "Walking hit pushes the live roller instead of stopping silently");
        std::filesystem::remove(root / "Physics.json");
        interactions(Json::array({sound}), 0);
        Player room(Terrain::load(root));
        room.configure_run(RunMode::Showoff);
        room.warp({0, 0, 0}, {0, 0, -1});
        room.start_on_foot();
        room.tick({});
        unsigned room_cues = 0;
        for (unsigned i = 1; i <= 100; ++i) {
            RideInput physical;
            physical.room_offset = {0, 0, -double(i) * .035};
            room.tick(physical);
            for (const auto& action : room.world_actions())
                room_cues += action.kind == WorldActionKind::CourseSound && action.rider;
        }
        check(room_cues > 0, "Physical room movement crosses off-board trigger volumes without stick input");
        check(std::abs(room.rider().position.z) < .001, "Room-scale contact probing does not double the camera motion");
        room.reset_room_contacts();
        room.tick({});
        check(std::none_of(room.world_actions().begin(), room.world_actions().end(),
                           [](const auto& a) { return a.kind == WorldActionKind::CourseSound; }),
              "Tracking-origin recenter does not sweep backwards through intervening triggers");
        std::filesystem::remove(root / "Effects.json");
        geometry(root, {-4, 1, -4}, {4, 2, 4});
        Player roof(Terrain::load(root));
        roof.warp({0, 4, 0}, {0, 0, -1});
        roof.start_on_foot();
        check(std::abs(roof.rider().position.y - 2) < .001, "non-rideable solid roof supports walking");
        for (unsigned i = 0; i < 60; ++i)
            roof.advance(1. / 60, {});
        check(roof.rider().grounded && std::abs(roof.rider().position.y - 2) < .001, "walker remains on roof");
        std::cout << "PASS: " << checks
                  << " walking, board proximity, mount edges, dismount momentum, coast and collision checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
