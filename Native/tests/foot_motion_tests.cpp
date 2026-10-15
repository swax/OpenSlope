#include "openslope/avatar.hpp"
#include "openslope/gear.hpp"
#include "openslope/ride_ui.hpp"
#include <iostream>
#include <limits>
#include <stdexcept>
using namespace openslope;

namespace {
unsigned checks = 0;

void check(bool ok, const char* message) {
    ++checks;
    if (!ok)
        throw std::runtime_error(message);
}

void near(double a, double b, const char* message) {
    ++checks;
    if (std::abs(a - b) >= 1e-8)
        throw std::runtime_error(std::string(message) + ": got " + std::to_string(a) + ", expected " +
                                 std::to_string(b));
}

Patch patch(Vec3 origin, Vec3 u, Vec3 v) {
    Patch p;
    for (unsigned a = 0; a < 4; ++a)
        for (unsigned b = 0; b < 4; ++b)
            p.points[a * 4 + b] = origin + u * (a / 3.) + v * (b / 3.);
    return p;
}

Terrain floor() { return Terrain({patch({-100, 0, -100}, {200, 0, 0}, {0, 0, 200})}); }

void fly(FootMotion& motion, Vec3& v) {
    v = motion.step({}, true, {{0, 0, -1}, {}, 0, 0, true, true}, 1. / 60);
    v = motion.step(v, false, {}, 1. / 60);
    v = motion.step(v, false, {{0, 0, -1}, {}, 0, 0, true, true}, 1. / 60);
    check(motion.flying(), "A second airborne jump activates directional flight");
}

void profile() {
    for (const bool boost : {false, true}) {
        FootMotion motion;
        Vec3 v;
        fly(motion, v);
        for (unsigned i = 0; i < 60; ++i)
            v = motion.step(v, false, {{0, 0, -1}, {}, 0, 1, false, false, boost}, 1. / 60);
        // Numeric observations of the public first-party walker API, not its implementation.
        near(v.z, boost ? -23.552811593128084 : -11.776405796564042,
             "Cruise/full acceleration and throttle match the public flight trace");
        near(v.y, -5.513833333333333, "Gravity remains active during horizontal flight");
        check(motion.boosting() == boost, "Only multiplied directional thrust reports boost");
        v = motion.step({600, 1, 0}, false, {{0, 0, -1}, {}, 0, 0, false, false, boost}, 1. / 60);
        near(v.x, boost ? 300 : 150, "Half/full horizontal caps");
        check(!motion.boosting(), "Cap selection alone is silent");
    }
    FootMotion up;
    Vec3 v;
    fly(up, v);
    for (unsigned i = 0; i < 60; ++i)
        v = up.step(v, false, {{0, 0, -1}, {}, 0, 0, false, true}, 1. / 60);
    near(v.y, 7.969500000000001, "Sustained jump thrust matches the public climb trace");
    for (unsigned i = 0; i < 6; ++i)
        v = up.step(v, false, {}, 1. / 60);
    check(up.flying() && v.y < 7.9695, "Released flight is ballistic and stays active until landing");
    up.landed();
    check(!up.flying(), "Touchdown ends flight");
    FootMotion ledge;
    ledge.step({}, false, {{0, 0, -1}, {}, 0, 0, true, true}, 1. / 60);
    check(!ledge.flying(), "A ledge fall does not arm a double jump");
    FootMotion chord;
    chord.step({}, true, {{0, 0, -1}, {}, 0, 0, true, true, true}, 1. / 60);
    check(chord.flying(), "Jump plus Boost can enter on takeoff");
    FootMotion jet;
    v = jet.step({}, true, {{0, 0, -1}, {0, 1, 0}, 0, 0, false, false, true, false, true}, 1. / 60);
    check(jet.boosting() && v.y > 0, "A held board thrusts off the floor immediately");
    FootMotion carry;
    carry.reset(true);
    v = carry.step({0, 1, -25}, false, {{0, 0, -1}, {1, .25, 0}, 0, 0, false, false, true}, 1. / 60);
    check(carry.boosting() && !carry.flying() && v.x > 0,
          "Inherited board flight accepts aimed unlimited boost without a jump");
    carry.reset(true);
    v = {0, 1, -25};
    for (unsigned i = 0; i < 120; ++i)
        v = carry.step(v, false, {}, 1. / 60);
    near(v.z, -25, "An inherited released arc keeps its horizontal speed");
    carry.release();
    check(!carry.boosting(), "Focus release clears boost state");
    FootMotion slow_arc;
    v = slow_arc.step({0, 1, 0}, false, {{0, 0, -1}, {0, 1, 0}, 0, 0, false, false, true}, 1. / 60);
    check(slow_arc.boosting() && !slow_arc.flying(), "A slow airborne arc also accepts aimed boost");
    near(v.y, .8698333333333333, "Slow-arc thrust matches the public first-party sample");
    FootMotion brake;
    v = brake.step({10, 1, 0}, false, {{0, 0, -1}, {-1, 0, 0}, 0, 0, false, false, true}, 1. / 60);
    near(v.x, 9.800749999999999, "Opposed thrust brakes proportionally instead of taking many seconds to reverse");
    FootMotion capped_arc;
    v = capped_arc.step({600, 1, 0}, false, {{0, 0, -1}, {-1, 0, 0}, 0, 0, false, false, true}, 1. / 60);
    near(v.x, 300, "An aimed boost also enforces the full flight cap");
    try {
        carry.step({}, false, {}, std::numeric_limits<double>::quiet_NaN());
        check(false, "Reject invalid dt");
    } catch (const std::invalid_argument&) {
        check(true, "Invalid dt rejected");
    }
}

void player() {
    Player p(floor());
    p.warp({0, 0, 0}, {0, 0, -1});
    p.start_on_foot();
    const auto start = p.rider().position;
    RideInput forward;
    forward.posture = 1;
    forward.walk_forward = {0, 0, -1};
    for (unsigned i = 0; i < 60; ++i)
        p.tick(forward);
    near(start.z - p.rider().position.z, 8.13, "Full forward walk matches the shared authored speed");
    p.reset();
    const auto crouch_start = p.rider().position;
    forward.crouch = true;
    for (unsigned i = 0; i < 60; ++i)
        p.tick(forward);
    near(crouch_start.z - p.rider().position.z, 8.13 * .55, "Ctrl crouch walks at 55 percent speed");
    check(p.rider().crouch > .99, "Crouch reaches the body pose");
    const auto low = avatar_pose(p).joint(AvatarJoint::Head).y;
    for (unsigned i = 0; i < 20; ++i)
        p.tick({});
    check(avatar_pose(p).joint(AvatarJoint::Head).y > low + .3, "Standing raises the camera/body again");
    p.reset();
    RideInput jump;
    jump.jump = true;
    p.tick(jump);
    p.tick({});
    p.tick(jump);
    check(p.flying(), "Production Player consumes the second jump edge");
    const auto meter = p.scoring().status().meter;
    jump.boost = true;
    jump.flight_direction = {0, 1, 0};
    for (unsigned i = 0; i < 90; ++i)
        p.tick(jump);
    check(p.flying() && p.flight_boosting() && p.rider().position.y > 10, "Player flight can climb under aimed boost");
    near(p.scoring().status().meter, meter, "Flight never spends board meter");
    check(p.boost_trail_mesh().vertices().size() == 84, "Flight boost emits two bounded sole streaks");
    const auto pose = avatar_pose(p);
    near(pose.joint(AvatarJoint::LeftAnkle).y - pose.joint(AvatarJoint::RightAnkle).y, 0,
         "Flight has neutral feet instead of a walking gait");
    p.release_inputs();
    p.tick({});
    check(!p.flight_boosting(), "Focus release closes actual thrust");
    for (unsigned i = 0; i < 1000 && !p.rider().grounded; ++i)
        p.tick({});
    check(p.rider().grounded && !p.flying(), "Actual terrain landing restores walking");
    p.reset();
    p.advance(1. / 120, jump);
    p.advance(1. / 120, {});
    p.advance(1. / 120, jump);
    p.advance(1. / 120, {});
    check(p.flying(), "Jump edges survive render frames between fixed ticks");
    Player clicks(floor());
    clicks.warp({0, 0, 0}, {0, 0, -1});
    RideInput click;
    click.equipment.trigger[1] = true;
    clicks.tick(click);
    check(clicks.on_foot(), "Desktop-equivalent click dismounts the board");
    for (unsigned i = 0; i < 20; ++i)
        clicks.tick(click);
    check(clicks.on_foot(), "Holding click cannot remount after dismounting");
    clicks.warp({0, 0, 0}, {0, 0, -1});
    RideInput spawn;
    spawn.spawn_board = true;
    spawn.walk_forward = {0, 0, -1};
    clicks.tick(spawn);
    check(clicks.on_foot(), "Desktop E leaves the rider beside the spawned board");
    const auto recalled = clicks.render_board_position();
    near(recalled.z, clicks.rider().position.z - 1, "Desktop E places a board ahead");
    spawn.posture = .2;
    for (unsigned i = 0; i < 20; ++i)
        clicks.tick(spawn);
    check(length(clicks.render_board_position() - recalled) < 1e-7, "Held E never drags the board along");
    for (const int lead : {1, -1}) {
        clicks.warp({0, 20, 0}, {0, 0, -1}, {0, 0, -10. * lead});
        // Presentation fixtures isolate the rendered rotation from touchdown physics.
        auto& r = const_cast<Rider&>(clicks.rider());
        r.lead = lead;
        r.flip_degrees = 90;
        check(dot(clicks.render_up(), {0, 0, -double(lead)}) > .99,
              "W's forward quarter-turn points the rider along travel on either lead");
    }
    const auto normal_ui = RideUi::desktop({}, 16. / 9), menu_ui = RideUi::desktop({}, 16. / 9, true);
    check(length(menu_ui.down) < length(normal_ui.down) * .7,
          "Desktop menu leaves substantially more of the course visible");
    check(length(menu_ui.right) / length(menu_ui.down) <= 1.35,
          "Smaller menu preserves space between square-pixel text rows");
    const auto& gear = snowboard_mesh();
    check(gear.indices.size() == 1332, "The stock 444-triangle board replaces the diagnostic quad");
    Bounds box;
    for (const auto& v : gear.vertices)
        box.add({v.x, v.y, v.z});
    check(std::abs(box.max.z - box.min.z - 1.86) < 1e-6 && box.max.y > .08,
          "Stock geometry retains real length and raised tips");
}

void barriers() {
    const auto ground = patch({-100, 0, -100}, {200, 0, 0}, {0, 0, 200});
    Player wall(Terrain({ground, patch({5, 0, -40}, {0, 30, 0}, {0, 0, 80})}));
    wall.warp({0, 8, 0}, {0, 0, -1}, {30, 5, 0});
    wall.interact_board();
    for (unsigned i = 0; i < 60; ++i)
        wall.tick({});
    check(wall.rider().position.x < 4.8 && wall.rider().position.x > 4,
          "An ascending inherited flight cannot cross a terrain cliff");
    near(wall.rider().velocity.x, 0, "Terrain wall consumes inward velocity");
    const auto ramp = patch({-100, -200, -100}, {200, 400, 0}, {0, 0, 200});
    Player slope(Terrain({ramp, patch({-100, 0, 300}, {200, 0, 0}, {0, 0, 200})}));
    slope.warp({0, 10, 0}, {1, 0, 0}, {200, -200, 0});
    slope.interact_board();
    slope.tick({});
    slope.tick({});
    check(slope.rider().grounded, "Fast diagonal flight lands on the crossed steep slope");
    near(slope.rider().position.y, 2 * slope.rider().position.x, "The landing remains on the surface");
    Player roof(Terrain({ground, patch({-20, 1.4, -4}, {40, 0, 0}, {0, 0, 2})}));
    roof.warp({0, 0, 0}, {0, 0, -1});
    roof.start_on_foot();
    RideInput crouch;
    crouch.posture = 1;
    crouch.crouch = true;
    RideInput upright;
    upright.posture = 1;
    for (unsigned i = 0; i < 38; ++i)
        roof.tick(upright);
    check(roof.rider().position.z > -2, "A standing walker cannot pass through a low ceiling");
    roof.warp({0, 0, 0}, {0, 0, -1});
    roof.start_on_foot();
    for (unsigned i = 0; i < 38; ++i)
        roof.tick(crouch);
    check(roof.rider().position.z < -2.3 && roof.rider().position.z > -4, "Crouched body can pass under low terrain");
    for (unsigned i = 0; i < 20; ++i)
        roof.tick({});
    check(roof.rider().crouch > .5 && roof.rider().position.y >= -.001, "Standing waits for ceiling clearance");
}
} // namespace

int main() {
    try {
        profile();
        player();
        barriers();
        std::cout << checks << " on-foot flight/crouch checks passed\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << e.what() << '\n';
        return 1;
    }
}
