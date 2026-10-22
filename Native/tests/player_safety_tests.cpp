#include "openslope/camera.hpp"
#include <chrono>
#include <iostream>
#include <stdexcept>

namespace {
using namespace openslope;
unsigned checks{};

void check(bool value, const char* message) {
    ++checks;
    if (!value)
        throw std::runtime_error(message);
}

Terrain floor(double slope = 0, int surface = 1) {
    Patch patch;
    patch.surface = surface;
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v) {
            const auto x = (u / 3. - .5) * 200;
            patch.points[u * 4 + v] = {x, slope * x, (v / 3. - .5) * 200};
        }
    return Terrain({patch});
}

void embedded_air_contacts() {
    for (const auto surface : {1, 3, 5, 18})
        for (const auto yaw : {0., pi * .5, pi})
            for (const auto slope : {0., .75, 1.5})
                for (const auto depth : {.005, .05, .12}) {
                    const auto turn = [&](Vec3 v) { return rotate(v, {0, 1, 0}, yaw); };
                    auto patch = floor(slope, surface).patches()[0];
                    for (auto& point : patch.points)
                        point = turn(point);
                    Player player(Terrain({patch}));
                    const auto normal = turn(normalized(Vec3{-slope, 1, 0}));
                    player.warp(-normal * depth, turn({0, 0, -1}), turn({0, 0, -6}) + normal * .02);
                    auto& rider = const_cast<Rider&>(player.rider());
                    rider.grounded = false;
                    rider.motion = Motion::Air;
                    rider.control = Control::Air;
                    rider.air_time = 4.75;
                    rider.flip_degrees = -333;
                    const auto serial = player.placement_serial();
                    unsigned first = 0, grounded = 0;
                    for (unsigned tick = 0; tick < 90; ++tick) {
                        player.tick({.steer = .25});
                        if (!first && rider.landings)
                            first = tick + 1;
                        grounded += tick >= 60 && rider.grounded && rider.motion == Motion::Ground;
                    }
                    if (!first || grounded < 29)
                        std::cerr << "embedded air surface " << surface << " yaw " << yaw << " slope " << slope
                                  << " depth " << depth << " first " << first << " ground " << grounded << '\n';
                    check(first && first <= 30, "An embedded airborne deck touching the front-side guard lands");
                    check(grounded >= 29 && player.placement_serial() == serial,
                          "Embedded air contact restores ground controls without a reset");
                }
    for (const auto slope : {0., .75, 1.5}) {
        Player below(floor(slope));
        const auto normal = normalized(Vec3{-slope, 1, 0});
        below.warp(-normal, {0, 0, -1}, Vec3{0, 0, -6} - normal * 2);
        auto& rider = const_cast<Rider&>(below.rider());
        rider.grounded = false;
        rider.motion = Motion::Air;
        rider.control = Control::Air;
        for (unsigned tick = 0; tick < 12; ++tick) {
            below.tick({});
            check(!rider.grounded && !rider.landings,
                  "A guard wholly behind a terrain sheet cannot land on its front side");
        }
    }
}

void bank_landings() {
    for (const auto surface : {1, 3, 5, 18})
        for (const auto yaw : {0., pi * .5, pi})
            for (const auto degrees : {0., 20., 45., 65., 70., 75.})
                for (const bool downhill : {false, true})
                    for (const auto roll : {0., 75.})
                        for (const bool ascending : {false, true}) {
                            if (ascending && degrees < 45)
                                continue;
                            const auto turn = [&](Vec3 point) { return rotate(point, {0, 1, 0}, yaw); };
                            const auto slope = std::tan(degrees * pi / 180);
                            Patch patch, spawn;
                            patch.surface = surface;
                            for (unsigned u = 0; u < 4; ++u)
                                for (unsigned v = 0; v < 4; ++v) {
                                    const auto x = (u / 3. - .5) * 2000;
                                    patch.points[u * 4 + v] = turn({x, slope * x, (v / 3. - .5) * 2000});
                                    spawn.points[u * 4 + v] = {10000. + u, 2000., 10000. + v};
                                }
                            const auto normal = turn(normalized(Vec3{-slope, 1, 0}));
                            const auto forward = turn(downhill ? normalized(Vec3{-1, -slope, 0}) : Vec3{0, 0, -1});
                            Player player(Terrain({patch, spawn}));
                            const auto uphill = normalized(project(Vec3{0, 1, 0}, normal));
                            player.warp(normal * .5, forward,
                                        forward * 8 - normal * 3 + (ascending ? uphill * 18 : Vec3{}),
                                        rotate(Vec3{0, 1, 0}, forward, roll * pi / 180));
                            const auto serial = player.placement_serial();
                            unsigned first_landing = 0, settled_ground = 0;
                            for (unsigned tick = 0; tick < 120; ++tick) {
                                player.tick({.steer = .25});
                                const auto& rider = player.rider();
                                if (!first_landing && rider.landings)
                                    first_landing = tick + 1;
                                if (tick >= 90 && rider.grounded && rider.motion == Motion::Ground)
                                    ++settled_ground;
                            }
                            if (!first_landing || settled_ground < 29)
                                std::cerr << "bank landing surface " << surface << " yaw " << yaw << " slope "
                                          << degrees << " downhill " << downhill << " roll " << roll << " first "
                                          << first_landing << " ascending " << ascending << " settled "
                                          << settled_ground << '\n';
                            check(first_landing && first_landing <= 30, "An incoming rider lands on a bank instead of "
                                                                        "remaining held above it by the terrain guard");
                            check(settled_ground >= 29,
                                  "Sliding on a continuous bank retains ground controls instead of free air spins");
                            check(player.placement_serial() == serial && finite(player.rider().position),
                                  "Bank touchdown uses ordinary contact without a reset or distant placement");
                        }
}

void regressions() {
    embedded_air_contacts();
    bank_landings();
    unsigned landing_cases = 0, side_landings = 0;
    for (const auto surface : {1, 3, 18})
        for (const auto yaw : {0., pi * .5, pi, pi * 1.5})
            for (const auto gap : {.15, .35, .65})
                for (const bool boxed : {false, true}) {
                    const auto turn = [&](Vec3 point) { return rotate(point, {0, 1, 0}, yaw); };
                    Patch upper, wall, lower, side;
                    upper.surface = wall.surface = lower.surface = side.surface = surface;
                    for (unsigned u = 0; u < 4; ++u)
                        for (unsigned v = 0; v < 4; ++v) {
                            const auto x = -20. + 40. * u / 3;
                            upper.points[u * 4 + v] = turn({x, 0, 20. * v / 3});
                            wall.points[u * 4 + v] = turn({x, -5. + 5. * v / 3, -gap});
                            lower.points[u * 4 + v] = turn({x, -5, -20. + 40. * v / 3});
                            side.points[u * 4 + v] = turn({.35, -5. + 5. * v / 3, x});
                        }
                    auto patches = std::vector<Patch>{upper, wall, lower};
                    if (boxed)
                        patches.push_back(side);
                    Player edge(Terrain(std::move(patches)));
                    edge.warp(turn({0, -edge.contract().surface(surface).bog, .2}), turn({0, 0, -1}), turn({3, 0, -8}));
                    const auto serial = edge.placement_serial();
                    bool side_landing = false;
                    for (unsigned frame = 0; frame < 120; ++frame) {
                        const auto before = edge.rider();
                        edge.tick({.posture = 1});
                        const auto& pose = edge.rider();
                        side_landing = side_landing || (pose.grounded && pose.normal.y < .1);
                        const auto allowance = std::max(.2, pose.budget + .05);
                        const auto lateral = normalized(cross(pose.normal, pose.forward * double(pose.lead)));
                        const auto centre = pose.position + lateral * pose.slide +
                                            normalized(pose.grounded ? pose.normal : pose.board_up) * (.2 + allowance);
                        const auto penetration = edge.terrain().sweep(centre, centre, .2);
                        if (penetration && penetration->depth > .004)
                            std::cerr << "landing frame surface " << surface << " yaw " << yaw << " gap " << gap
                                      << " boxed " << boxed << " tick " << frame << " normal [" << pose.normal.x << ','
                                      << pose.normal.y << ',' << pose.normal.z << "] centre [" << centre.x << ','
                                      << centre.y << ',' << centre.z << "] depth " << penetration->depth << '\n';
                        check(
                            !penetration || penetration->depth <= .004,
                            "A landing support-frame change cannot place the terrain guard inside a neighboring floor");
                        check(finite(pose.position) && finite(pose.velocity) && edge.placement_serial() == serial,
                              "The ledge landing retains finite movement without hiding the contact behind a reset");
                        if (length(pose.position - before.position) > 2)
                            std::cerr << "large corner step surface " << surface << " yaw " << yaw << " gap " << gap
                                      << " boxed " << boxed << " tick " << frame << " distance "
                                      << length(pose.position - before.position) << '\n';
                        check(length(pose.position - before.position) <= 2,
                              "Corner clearance cannot turn a small authored step into a distant placement");
                    }
                    side_landings += side_landing;
                    ++landing_cases;
                }
    check(side_landings > 0, "The ledge matrix includes actual near-vertical landing frame changes");
    std::cout << "PASS: " << landing_cases << " ledge cases; " << side_landings << " near-vertical landing cases\n";
    for (const auto yaw : {0., pi * .5, pi, pi * 1.5})
        for (const auto behind : {.05, .3, .8}) {
            const auto turn = [&](Vec3 point) { return rotate(point, {0, 1, 0}, yaw); };
            Patch wall, lower;
            wall.surface = 18;
            for (unsigned u = 0; u < 4; ++u)
                for (unsigned v = 0; v < 4; ++v) {
                    const auto x = -20. + 40. * u / 3;
                    wall.points[u * 4 + v] = turn({x, -5. + 10. * v / 3, 0});
                    lower.points[u * 4 + v] = turn({x, -10, -20. + 40. * v / 3});
                }
            const auto normal = wall.normal(.5, .5);
            Player departed(Terrain({wall, lower}));
            departed.warp(turn({0, 2, 0}) - normal * behind, turn({1, 0, 0}), turn({5, -1, 0}) - normal * 2);
            auto& cached = const_cast<Rider&>(departed.rider());
            cached.normal = normal;
            cached.grounded = false;
            cached.motion = Motion::Air;
            cached.control = Control::Air;
            const auto serial = departed.placement_serial();
            for (unsigned frame = 0; frame < 12; ++frame) {
                departed.tick({});
                check(!departed.rider().grounded && departed.rider().landings == 0,
                      "An airborne cached probe cannot land on a wall already behind the rider's travel");
                check(dot(departed.rider().position, normal) < -behind && departed.placement_serial() == serial,
                      "A departing rider continues away from the wall without a probe snap or reset");
            }
            const auto forward = departed.rider().forward;
            departed.tick({.steer = .5, .boost = true});
            check(!departed.rider().grounded && departed.board_boosting() &&
                      length(cross(forward, departed.rider().forward)) > 1e-4,
                  "Steering and boost remain available after the rider leaves the cached wall");
        }
    for (const double slope : {0., .5}) {
        for (const auto surface : {1, 3, 5, 18}) {
            Player leaving(floor(slope, surface));
            const auto up = normalized(Vec3{-slope, 1, 0});
            const auto allowance = std::max(.2, leaving.contract().surface(surface).budget + .05);
            const auto start = -up * (allowance + .0005);
            leaving.warp(start, {0, 0, -1}, Vec3{0, 0, -4} + up * .05, up);
            check(leaving.rider().grounded, "The guard-clearance fixture starts in grounded depth recovery");
            leaving.tick({.posture = 1});
            check(dot(leaving.rider().position - start, up) > .02,
                  "A shallow guard overlap preserves outward budget pushout instead of clipping it away");
        }
        Player buried(floor(slope, 3));
        const auto up = normalized(Vec3{-slope, 1, 0});
        buried.warp(-up * .7, {0, 0, -1}, {0, 0, -4}, up);
        const auto serial = buried.placement_serial();
        for (unsigned i = 0; i < 60; ++i)
            buried.tick({});
        check(dot(buried.rider().position, up) > -buried.rider().budget - .05,
              "a deeply seated snow guard returns toward its support instead of pushing farther under it");
        check(buried.placement_serial() == serial, "deep contact recovery uses the spring and guard without a reset");
    }
    for (const auto surface : {3, 4, 7, 8}) {
        Player soft(floor(0, surface));
        const auto sink = soft.contract().surface(surface).bog;
        soft.warp({0, -sink, 0}, {0, 0, -1});
        soft.tick({});
        check(std::abs(soft.rider().position.y + sink) < 1e-7,
              "terrain guard preserves the shared soft-snow equilibrium depth");
    }
    for (const auto vertical : {-20., -80., -180.}) {
        Player rider(floor());
        rider.warp({0, -.005, 0}, {0, 0, -1}, {0, vertical, -10});
        for (unsigned i = 0; i < 60; ++i) {
            rider.tick({});
            check(rider.rider().position.y >= -.205, "ground impact cannot escape beneath terrain");
        }
    }
    Player walker(floor(1.6));
    walker.warp({}, {1, 0, 0}, {20, 0, 0});
    walker.start_on_foot();
    for (unsigned i = 0; i < 60; ++i) {
        RideInput input;
        input.posture = 1;
        input.walk_forward = {1, 0, 0};
        walker.tick(input);
        const auto p = walker.rider().position;
        check(p.y >= p.x * 1.6 - .03, "fast uphill walking does not disappear below the slope");
    }
    Player spin(floor());
    spin.warp({0, 100, 0}, {0, 0, -1}, {0, 0, -15});
    for (unsigned i = 0; i < 40; ++i)
        spin.tick({1});
    RideInput boost;
    boost.boost = true;
    for (unsigned i = 0; i < 21; ++i)
        spin.tick(boost);
    const auto mesh = spin.boost_trail_mesh();
    check(!mesh.vertices().empty(), "spin/boost regression actually emits a trail");
    Vec3 centre{};
    // First quad's two live endpoints must sit behind the selected thrust end.
    centre = (mesh.vertices()[0].position + mesh.vertices()[1].position) * .5;
    const auto thrust = spin.render_forward() * double(spin.rider().boost_end);
    check(dot(centre - spin.render_board_position(), thrust) < -.5, "180-degree boost emits behind its thrust end");
    spin.tick({});
    check(!spin.board_boosting(), "release clears board boost state on the next fixed tick");
    Player foot(floor());
    foot.warp({}, {0, 0, -1});
    foot.start_on_foot();
    FollowCamera camera;
    camera.step(foot, 0);
    const auto reference = camera.facing();
    camera.orbit(200, 0);
    camera.step(foot, 1. / 60, false, true);
    const auto orbit_forward = rotate(reference, {0, 1, 0}, -.8);
    for (unsigned i = 0; i < 60; ++i) {
        RideInput input;
        input.steer = 1;
        input.walk_forward = camera.facing();
        input.face_walk_forward = true;
        foot.tick(input);
        camera.step(foot, 1. / 60);
        check(dot(camera.facing(), reference) > .999, "camera orbit does not rotate the desktop walking input basis");
        check(dot(foot.rider().forward, reference) > .999, "strafing after an orbit preserves the avatar heading");
        check(dot(normalized(project(camera.pose().forward, {0, 1, 0})), orbit_forward) > .999,
              "walking preserves the camera-only orbit after releasing the drag");
    }
    for (unsigned i = 0; i < 60; ++i) {
        RideInput input;
        input.walk_forward = camera.facing();
        input.face_walk_forward = true;
        foot.tick(input);
        camera.step(foot, 1. / 60);
    }
    check(dot(foot.rider().forward, reference) > .999, "stopping a walk retains the avatar heading");
    check(dot(normalized(project(camera.pose().forward, {0, 1, 0})), orbit_forward) > .999,
          "stopping a walk preserves the camera-only orbit instead of snapping behind the avatar");
}

void owned(const std::filesystem::path& root) {
    Player rider(Terrain::load(root));
    const auto& terrain = rider.terrain();
    unsigned trials = 0, frames = 0;
    for (std::size_t i = 0; i < terrain.patches().size() && trials < 24;
         i += std::max(std::size_t(1), terrain.patches().size() / 100)) {
        const auto& p = terrain.patches()[i];
        const auto n = p.normal(.5, .5);
        if (n.y < .4 || p.surface == 0 || p.surface == 17)
            continue;
        const auto at = p.evaluate(.5, .5), f = normalized(project(p.tangents(.5, .5)[0], n));
        rider.warp(at + n * .8, f, f * 18 - n * 35);
        for (unsigned frame = 0; frame < 180; ++frame) {
            const auto before = rider.rider();
            const auto serial = rider.placement_serial();
            RideInput input;
            input.boost = frame % 60 < 35;
            input.steer = frame % 80 < 40 ? .6 : -.6;
            input.jump = frame % 90 < 15;
            rider.tick(input);
            ++frames;
            if (serial != rider.placement_serial())
                continue;
            const auto after = rider.rider().position;
            const auto permitted = std::max(.3, std::max(before.budget, rider.rider().budget) + .15);
            if (const auto hit = terrain.intersect(before.position + before.normal * permitted, after);
                hit && hit->surface != 0 && dot(after - hit->point, hit->normal) < -permitted) {
                std::cerr << "terrain escape patch " << i << " tick " << frame << " depth "
                          << dot(after - hit->point, hit->normal) << '\n';
                check(false, "owned-course traversal crossed under terrain");
            }
        }
        ++trials;
    }
    check(trials >= 12, "owned-course check samples enough independent course patches");
    std::cout << "PASS: " << trials << " owned terrain starts; " << frames
              << " fixed ticks without a deep terrain crossing\n";
}

void jump_corners() {
    unsigned cases = 0, wall_cases = 0, frames = 0;
    const auto play = [&](double width, double runup, double distance, double approach, double steer, int surface,
                          double yaw, bool jumping, bool wall_start = false) {
        Patch wall, front, top;
        for (unsigned u = 0; u < 4; ++u)
            for (unsigned v = 0; v < 4; ++v) {
                wall.points[u * 4 + v] = {width * u / 3, 10. * u / 3, 20. * v / 3};
                front.points[u * 4 + v] = {20. * u / 3, 10. * v / 3, width * v / 3};
                top.points[u * 4 + v] = {width + 20. * u / 3, 10, width + 20. * v / 3};
            }
        std::vector<Patch> patches{floor(0, surface).patches()[0], wall, front, top};
        const auto turn = [&](Vec3 p) { return rotate(p, {0, 1, 0}, yaw); };
        for (auto& patch : patches)
            for (auto& point : patch.points)
                point = turn(point);
        Player rider(Terrain(std::move(patches)));
        const auto sink = rider.contract().surface(surface).bog;
        if (wall_start) {
            rider.warp(turn({width * .02, .2, 19.5}), turn({0, 0, 1}), turn({approach, -1, 15}));
            check(rider.rider().normal.y < .1 && rider.rider().grounded,
                  "The staged corner departure begins with actual near-vertical support");
        } else
            rider.warp(turn({-distance, -sink, -runup}), turn({0, 0, 1}), turn({approach, 0, 15}));
        const auto serial = rider.placement_serial();
        double low_normal = 1;
        for (unsigned frame = 0; frame < 120; ++frame) {
            const auto before = rider.rider();
            rider.tick({.steer = steer, .jump = jumping && frame < 10});
            const auto& after = rider.rider();
            low_normal = std::min(low_normal, after.normal.y);
            const auto permitted = std::max(.3, std::max(before.budget, after.budget) + .06);
            const bool contained = finite(after.position) && finite(after.velocity) &&
                                   rider.placement_serial() == serial && after.position.y >= -permitted;
            if (!contained)
                std::cerr << "jump corner width " << width << " runup " << runup << " distance " << distance
                          << " approach " << approach << " steer " << steer << " surface " << surface << " yaw " << yaw
                          << " jumping " << jumping << " tick " << frame << " before [" << before.position.x << ','
                          << before.position.y << ',' << before.position.z << "] normal [" << before.normal.x << ','
                          << before.normal.y << ',' << before.normal.z << "] after [" << after.position.x << ','
                          << after.position.y << ',' << after.position.z << "] normal [" << after.normal.x << ','
                          << after.normal.y << ',' << after.normal.z << "]\n";
            check(contained, "Steep corner approach retains finite floor containment without a hidden reset");
            ++frames;
        }
        wall_cases += low_normal < .1;
        if (wall_start)
            check(rider.rider().grounded && rider.rider().normal.y > .4,
                  "The staged wall departure returns to the floor through a real support-frame change");
        ++cases;
    };
    for (const auto width : {.02, .1, .5, 2.})
        for (const auto runup : {.5, 2., 5.})
            for (const auto distance : {.05, .1, .2, .4, .5, .7})
                for (const auto approach : {0., 2., 8., 18., 40.})
                    for (const auto steer : {-1., -.5, .5, 1.})
                        play(width, runup, distance, approach, steer, 1, 0, false);
    for (const auto yaw : {0., pi * .5, pi, pi * 1.5})
        for (const auto surface : {3, 4, 8})
            for (const auto steer : {.5, 1.})
                for (const auto jumping : {false, true}) {
                    play(.02, 2, .05, 2, steer, surface, yaw, jumping);
                    play(.02, 2, .05, 2, steer, surface, yaw, jumping, true);
                }
    check(wall_cases > 10, "Corner trials include actual near-vertical support transitions");
    std::cout << "PASS: " << cases << " steep jump-side approaches; " << frames << " contained ticks; " << wall_cases
              << " near-vertical support trials\n";
}
} // namespace

int main(int argc, char** argv) {
    try {
        if (argc == 2 && std::string(argv[1]) == "--corners")
            jump_corners();
        else if (argc == 3 && std::string(argv[1]) == "--owned")
            owned(argv[2]);
        else {
            regressions();
            std::cout << "PASS: " << checks << " landing/ground/walk, boost-end/release and walking camera checks\n";
        }
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
