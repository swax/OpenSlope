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

void regressions() {
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
    camera.orbit(200, 0);
    camera.step(foot, 1. / 60, false, true);
    Vec3 reference = camera.walk_forward();
    for (unsigned i = 0; i < 60; ++i) {
        RideInput input;
        input.steer = 1;
        input.walk_forward = camera.walk_forward();
        foot.tick(input);
        camera.step(foot, 1. / 60);
        check(dot(camera.walk_forward(), reference) > .999, "camera recenter does not rotate the walking input basis");
        const auto behind = project(camera.pose().eye - foot.render_position(), {0, 1, 0});
        check(dot(normalized(behind), normalized(project(foot.rider().forward, {0, 1, 0}))) < -.99,
              "walking camera snaps behind the avatar after an orbit");
    }
    for (unsigned i = 0; i < 60; ++i) {
        foot.tick({});
        camera.step(foot, 1. / 60);
    }
    check(dot(normalized(project(camera.pose().eye - foot.render_position(), {0, 1, 0})),
              normalized(project(foot.rider().forward, {0, 1, 0}))) < -.99,
          "stopping a walk retains the avatar heading instead of returning to the spawn view");
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
                          double yaw, bool jumping) {
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
                for (const auto jumping : {false, true})
                    play(.02, 2, .05, 2, steer, surface, yaw, jumping);
    check(wall_cases > 10, "Corner trials actually change support to near-vertical jump faces");
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
