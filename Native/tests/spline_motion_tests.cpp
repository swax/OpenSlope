#include "openslope/collision.hpp"
#include "openslope/spline_motion.hpp"
#include "openslope/world_logic.hpp"
#include <chrono>
#include <fstream>
#include <iostream>
#include <nlohmann/json.hpp>
#include <stdexcept>

namespace {
using namespace openslope;
using Json = nlohmann::json;
unsigned checks = 0;

void check(bool ok, const char* text) {
    ++checks;
    if (!ok)
        throw std::runtime_error(text);
}

void near(double a, double b, const char* text) { check(std::abs(a - b) < 1e-6, text); }

void near(Vec3 a, Vec3 b, const char* text) { check(length(a - b) < 1e-6, text); }

void geometry() {
    RailCurve accelerating;
    accelerating.power = {Vec3{100, 0, 0}, {}, {}, {}};
    PropRoute route({accelerating});
    near(route.length(), 100, "analytic cubic route length");
    const auto middle = route.sample(50);
    near(middle.position, {50, 0, 0}, "arc distance samples nonuniform cubic speed");
    near(middle.parameter, std::cbrt(.5), "arc distance inverts analytic parameter");
    near(middle.tangent, {1, 0, 0}, "analytic derivative supplies unit tangent");
    near(route.sample(100).position, {100, 0, 0}, "route endpoint is retained");
    RailCurve bend;
    bend.power = {Vec3{0, 0, 0}, Vec3{0, 100, 0}, Vec3{100, 0, 0}, {}};
    PropRoute curved({bend});
    double integral = 0;
    for (unsigned i = 0; i < 10000; ++i) {
        const auto a = i / 10000., b = (i + 1) / 10000.;
        integral +=
            (b - a) * (length(bend.tangent(a)) + 4 * length(bend.tangent((a + b) * .5)) + length(bend.tangent(b))) / 6;
    }
    near(curved.length(), integral, "short-interval quadrature agrees with independent composite Simpson integral");
    const auto curved_mid = curved.sample(curved.length() * .5);
    check(curved_mid.parameter > .5 && curved_mid.parameter < .7, "half arc is not half of a curved parameter");
    RailCurve second;
    second.power = {Vec3{}, Vec3{}, Vec3{0, 0, -40}, Vec3{100, 0, 0}};
    PropRoute joined({accelerating, second});
    near(joined.sample(120).position, {100, 0, -20}, "distance crosses analytic segment boundaries");
    const RouteSample flat{{2, 3, 4}, {1, 0, 0}};
    const auto pose = route_pose(flat, 0, 0, 1);
    near(transform_point(pose, {}), flat.position, "route origin comes only from path");
    near(transform_point(pose, {0, 0, -1}) - flat.position, {1, 0, 0}, "zero offset leads with raw model positive Y");
    const auto subway = route_pose(flat, 1, pi / 2, 1);
    near(transform_point(subway, {-1, 0, 0}) - flat.position, {1, 0, 0},
         "quarter-turn offset leads with negative model X");
    const auto backward = route_pose(flat, 1, 0, -1);
    near(transform_point(backward, {0, 0, -1}) - flat.position, {-1, 0, 0},
         "return leg turns the model to lead backwards");
    const RouteSample slope{{}, {0, .5, -std::sqrt(.75)}};
    for (const auto mode : {0, 1, 2, 3, 8}) {
        const auto orientation = route_pose(slope, mode, 0, 1);
        const auto forward = transform_point(orientation, {0, 0, -1});
        near(forward.y, mode == 1 || mode == 3 ? 0 : std::sin(.5),
             "pitch uses tangent vertical component directly as an angle");
    }
    near(transform_point(route_pose(flat, 3, 0, 1), {0, 0, -1}) - flat.position, {0, 0, -1},
         "fixed orientation suppresses tangent yaw");
}

void clocks() {
    RouteLaw law;
    law.speed = 10;
    RoutePlayback wrap(law, 100);
    wrap.step(10.5);
    near(wrap.distance(), 5, "forward wrap carries overshoot");
    RoutePlayback exact(law, 6);
    for (unsigned i = 0; i < 36; ++i)
        exact.step(1. / 60);
    near(exact.distance(), 0, "fixed ticks recognize an exact decimal wrap boundary");
    RoutePlayback fallback(RouteLaw{9, 0, 1, 10}, 100);
    fallback.step(10.5);
    near(fallback.distance(), 5, "unknown end mode wraps");
    law.speed = -10;
    RoutePlayback reverse(law, 100);
    reverse.step(1);
    near(reverse.distance(), 0, "negative wrap clamps at the starting end");
    near(reverse.direction(), -1, "stopped reverse retains its direction");
    law.end_mode = 2;
    RoutePlayback negative(law, 100);
    negative.step(1);
    near(negative.distance(), 10, "negative ping-pong reverses from initial zero");
    near(negative.direction(), 1, "negative initial ping-pong returns forward");
    law.speed = 10;
    RoutePlayback ping(law, 100);
    ping.step(10.5);
    near(ping.distance(), 95, "ping-pong reflects overshoot");
    near(ping.direction(), -1, "ping-pong return direction");
    ping.step(10);
    near(ping.distance(), 5, "return leg reflects at starting end");
    near(ping.direction(), 1, "starting reflection restores forward travel");
    ping.step(30);
    near(ping.distance(), 95, "multiple reflections preserve remaining travel");
    near(ping.direction(), -1, "multiple reflections preserve final direction");
    law.end_mode = 0;
    RoutePlayback once(law, 100);
    once.step(10);
    check(once.finished() && !once.retired(), "finish keeps endpoint for this update");
    once.step(.1);
    check(once.retired(), "finish retires on next update");
    law.end_mode = 3;
    RoutePlayback hold(law, 100);
    hold.step(11);
    hold.step(11);
    near(hold.distance(), 100, "hold retains alive endpoint");
    check(!hold.finished() && !hold.retired(), "hold differs from finish");
    law.copies = 3;
    RoutePlayback copies(law, 150);
    copies.step(15);
    const auto distances = copies.distances();
    near(distances[0], 150, "first copy preserves exact held endpoint");
    near(distances[1], 50, "second copy wraps independently");
    near(distances[2], 100, "copies cover total arc uniformly");
}

Json effect(int main, Json payload, Json refs = Json::object()) {
    return {{"mainType", main}, {"payload", payload}, {"references", refs}};
}

Json fixture(const std::filesystem::path& root, int operation = -1, bool latch = false, bool owner = true) {
    const auto write = [&](const char* name, Json value) { std::ofstream(root / name) << value; };
    write("Models.json",
          {{"Models",
            Json::array({{{"ModelObjects",
                           Json::array({{{"ParentID", -1},
                                         {"CollisionBounds", {{"Min", {-100, -100, -100}}, {"Max", {100, 100, 100}}}},
                                         {"MeshData", Json::array()}}})}}})}});
    write("Materials.json", {{"Materials", Json::array()}});
    Json hosts = Json::array();
    for (unsigned i = 0; i < 2; ++i)
        hosts.push_back({{"ModelID", 0},
                         {"Location", {200000 + int(i) * 1000, 300000, 0}},
                         {"Rotation", {0, 0, std::sin(pi / 4), std::cos(pi / 4)}},
                         {"Scale", {2, 3, 4}},
                         {"Visable", false},
                         {"PlayerCollision", true},
                         {"PlayerBounce", true},
                         {"U0", 1},
                         {"CollsionMode", 2},
                         {"EffectSlotIndex", i}});
    write("Instances.json", {{"Instances", hosts}});
    write("Splines.json",
          {{"Splines",
            Json::array(
                {{{"SplineStyle", -1},
                  {"U1", -2},
                  {"Segments",
                   Json::array(
                       {{{"Points", {{0, 0, 0}, {100000. / 3, 0, 0}, {200000. / 3, 0, 0}, {100000, 0, 0}}}}})}}})}});
    const auto move = effect(2,
                             {{"type2",
                               {{"SubType", 1},
                                {"SplineAnimation",
                                 {{"U1", 1},
                                  {"U2", 1},
                                  {"InstanceCount", 3},
                                  {"AnimationSpeed", 10},
                                  {"U5", 0},
                                  {"U6", 1},
                                  {"U7", 1},
                                  {"R", .2},
                                  {"G", .3},
                                  {"B", .4}}}}}},
                             {{"spline", "path"}});
    Json persistent = Json::array();
    if (owner)
        persistent.push_back(effect(0, {{"type0", {{"SubType", 2}, {"Debounce", 0}}}}));
    persistent.push_back(move);
    Json command = operation < 0 ? Json::array({effect(3, {{"type3", {{"U0", 8}}}}), effect(4, {{"WaitTime", .2}}),
                                                effect(3, {{"type3", {{"U0", 7}}}})})
                                 : Json::array({effect(0, {{"type0", {{"SubType", 5}, {"DeadNodeMode", operation}}}})});
    Json doc = {
        {"kind", "openslope-effects"},
        {"version", 1},
        {"graphs",
         Json::array({{{"id", "motion"}, {"nodes", persistent}},
                      {{"id", "empty"}, {"nodes", Json::array()}},
                      {{"id", "command"}, {"nodes", command}},
                      {{"id", "switch"},
                       {"nodes", Json::array({effect(7, Json::object(),
                                                     {{"instance", "instance:0"}, {"effectGraph", "command"}})})}}})},
        {"slots",
         Json::array({{{"id", "host"},
                       {"circumstances", {{"persistent", "motion"}, {"slot3", latch ? Json("empty") : Json(nullptr)}}}},
                      {{"id", "switch"}, {"circumstances", {{"collision", "switch"}}}}})},
        {"functions", Json::array()},
        {"objectProperties", Json::array()},
        {"instances", Json::array()},
        {"splines", Json::array({{{"id", "path"}, {"originalIndex", 999}, {"data", Json::object()}}})}};
    write("Effects.json", doc);
    return doc;
}

Vec3 origin(const WorldLogic& logic, std::size_t copy = 0) {
    check(logic.route_motions().size() == 1, "one detached drawing owner");
    const auto placement =
        openslope::placement({2000, 0, -3000}, {0, std::sin(pi / 4), 0, std::cos(pi / 4)}, {2, 4, 3});
    return transform_point(multiply(placement, logic.route_motions()[0].current.at(copy)), {});
}

void runtime(const std::filesystem::path& root) {
    const std::array<Vec3, 1> view{{{0, 0, 0}}}, other{{{1000, 0, 0}}}, far{{{10000, 0, 0}}};
    fixture(root);
    auto logic = WorldLogic::load(root);
    logic.tick(0, 0, view);
    near(origin(logic), {}, "route proximity activates a distant hidden template");
    logic.tick(.5, 0, view);
    near(origin(logic), {5, 0, 0}, "real graph advances ten metres per second");
    near(origin(logic, 1), {5 + 1000. / 3, 0, 0}, "real graph owns evenly spaced copies");
    logic.tick(1, 0, view);
    for (unsigned i = 0; i < 98; ++i)
        logic.tick(1, 0, view);
    logic.tick(.5, 0, view);
    near(origin(logic), {}, "shared route clock wraps after exactly one hundred seconds");
    check(logic.route_motions()[0].previous[0] == logic.route_motions()[0].current[0],
          "wrap snaps presentation instead of interpolating across the scene");
    logic.restart(RunMode::Freeride);
    logic.tick(.5, 0, view);
    check(logic.route_motions()[0].lines.size() == 1 && logic.route_motions()[0].lines[0].points.size() == 11,
          "cable uses ten uniform-parameter samples per segment");
    check(logic.motions().empty() && logic.flags()[0] == WorldCollide,
          "detached drawing leaves authored flags and object animation separate");
    auto world = CollisionWorld::load(root);
    world.instance_flags(logic.flags());
    world.motion(logic.motions(), 1. / 60);
    check(world.ray({2000, 10, -3000}, {2000, -10, -3000}).has_value() && !world.ray({5, 10, 0}, {5, -10, 0}),
          "mover does not silently rewrite authored host collision");
    logic.tick(.5, 0, other);
    logic.tick(.5, 0, other);
    near(origin(logic), {15, 0, 0}, "crossing route cells does not reinstall or unload a live owner");
    logic.tick(.1, 0, far);
    logic.tick(.1, 0, far);
    check(logic.route_motions().empty(), "ordinary region teardown removes owner and detached mover");
    fixture(root);
    logic = WorldLogic::load(root);
    logic.tick(0, 0, view);
    logic.contact(1, 0);
    logic.tick(.1, 0, view);
    check(logic.route_motions().empty(), "base flag command kills detached mover on its next update");
    logic.tick(.2, 0, view);
    logic.tick(.1, 0, view);
    check(logic.route_motions().empty(), "clearing stop flag cannot resurrect a destroyed mover");
    for (const auto mode : {0, 1, 2, 3}) {
        fixture(root, mode);
        logic = WorldLogic::load(root);
        logic.tick(0, 0, view);
        logic.contact(1, 0);
        logic.tick(.1, 0, view);
        check(logic.route_motions().empty() == (mode == 0 || mode == 3),
              "destroy and flagged tombstone end detached mover; pause/plain tombstone preserve it");
        if (mode == 2)
            check(logic.flags()[0] == 0 && !logic.route_motions().empty(),
                  "plain tombstone disarms host while detached drawing continues");
    }
    auto delayed = fixture(root, 3);
    delayed["graphs"][2]["nodes"].push_back(effect(4, {{"WaitTime", .2}}));
    delayed["graphs"][2]["nodes"].push_back(delayed["graphs"][0]["nodes"].back());
    std::ofstream(root / "Effects.json") << delayed;
    logic = WorldLogic::load(root);
    logic.tick(0, 0, view);
    logic.contact(1, 0);
    logic.tick(.1, 0, view);
    check(logic.route_motions().empty(), "flagged kill preserves delayed graph work");
    logic.tick(.2, 0, view);
    check(!logic.route_motions().empty(), "explicit delayed constructor can re-arm a killed mover");
    logic.tick(.1, 0, view);
    near(origin(logic), {1, 0, 0}, "explicit reinstallation starts a fresh live cursor");
    fixture(root, -1, true);
    logic = WorldLogic::load(root);
    logic.tick(0, 0, view);
    logic.tick(.1, 0, far);
    logic.tick(.1, 0, far);
    check(!logic.route_motions().empty(), "populated region latch retains detached motion owner");
    fixture(root, -1, false, false);
    logic = WorldLogic::load(root);
    logic.tick(0, 0, view);
    check(logic.route_motions().empty(), "mover without registered owner retires on update");
}

void courses(const std::filesystem::path& maps) {
    unsigned courses = 0, paths = 0, active = 0;
    for (const auto& entry : std::filesystem::directory_iterator(maps)) {
        if (!entry.is_directory() || !std::filesystem::exists(entry.path() / "Instances.json"))
            continue;
        auto logic = WorldLogic::load(entry.path());
        unsigned local_paths = 0, local_active = 0;
        for (const auto& spline : spline_paths(entry.path()))
            if (spline.surface < 0 && !spline.curves.empty()) {
                PropRoute route(spline.curves);
                if (route.length() <= 1e-9)
                    continue;
                ++local_paths;
                for (const auto distance : {0., route.length() * .5, route.length()}) {
                    const auto sample = route.sample(distance);
                    check(finite(sample.position) && finite(sample.tangent), "owned non-rail path samples finite");
                    const std::array<Vec3, 1> view{{sample.position}};
                    logic.tick(1. / 60, 0, view);
                    local_active = std::max(local_active, unsigned(logic.route_motions().size()));
                    for (const auto& draw : logic.route_motions()) {
                        check(!draw.current.empty(), "owned drawing node has live copies");
                        for (const auto& pose : draw.current)
                            for (const auto value : pose)
                                check(std::isfinite(value), "owned route drawing pose remains finite");
                    }
                }
            }
        std::cout << entry.path().filename().string() << ": " << local_paths << " non-rail paths; " << local_active
                  << " active detached movers\n";
        paths += local_paths;
        active += local_active;
        ++courses;
    }
    check(courses == 11 && paths > 0 && active > 0, "owned course sweep reaches real detached movers");
    std::cout << "Owned routes: " << paths << " non-rail paths; " << active << " summed peak live movers across "
              << courses << " courses\n";
}
} // namespace

int main(int argc, char** argv) {
    try {
        geometry();
        clocks();
        const auto root =
            std::filesystem::temp_directory_path() /
            ("openslope-spline-motion-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::filesystem::create_directory(root);

        struct Cleanup {
            std::filesystem::path root;

            ~Cleanup() {
                std::error_code error;
                std::filesystem::remove_all(root, error);
            }
        } cleanup{root};

        runtime(root);
        if (argc == 2)
            courses(argv[1]);
        std::cout << "PASS: " << checks
                  << " analytic route, orientation, cursor/copy, detached lifecycle and region checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
