#include "openslope/player.hpp"
#include <iostream>
#include <stdexcept>

namespace {
using namespace openslope;
unsigned checks = 0;
constexpr double h = 1. / 60;

void check(bool value, const char* message) {
    ++checks;
    if (!value)
        throw std::runtime_error(message);
}

void near(double a, double b, const char* message) { check(std::abs(a - b) < 1e-7, message); }

Terrain floor(int surface = 1, double grade = 0) {
    Patch p;
    p.surface = surface;
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            p.points[u * 4 + v] =
                rotate({double(u) * 4000 / 3 - 2000, 0, double(v) * 4000 / 3 - 2000}, {1, 0, 0}, grade);
    return Terrain({p});
}

void carve() {
    for (const auto surface : {1, 3, 5})
        for (const auto lead : {1, -1})
            for (const auto grade : {0., pi / 9})
                for (const auto amount : {.25, .5, 1.}) {
                    Player stick(floor(surface, grade)), head(floor(surface, grade));
                    const auto normal = rotate({0, 1, 0}, {1, 0, 0}, grade),
                               forward = rotate({0, 0, -1}, {1, 0, 0}, grade);
                    for (auto* p : {&stick, &head}) {
                        p->warp(normal * 1.5, forward * double(lead), forward * 16 - normal, normal);
                        for (unsigned i = 0; i < 100 && !p->rider().grounded; ++i)
                            p->tick({});
                        check(p->rider().grounded && p->rider().lead == lead,
                              "authored slope starts in requested regular/switch stance");
                    }
                    for (unsigned tick = 0; tick < 180; ++tick) {
                        const auto intent = tick < 60 ? amount : tick < 120 ? -amount : 0.;
                        const auto& rider = head.rider();
                        const auto travel =
                            normalized(project(rider.velocity, rider.normal), rider.forward * double(rider.lead));
                        const auto angle =
                            intent == 0 ? 0 : std::copysign(5 + 30 * std::abs(intent), intent) * pi / 180;
                        RideInput look;
                        look.vr = {true, true, false, rotate(travel, rider.normal, angle), 0};
                        stick.tick({intent});
                        head.tick(look);
                        near(length(head.rider().velocity - stick.rider().velocity), 0,
                             "head and stick carry identical speed through carve");
                        near(length(head.rider().position - stick.rider().position), 0,
                             "head and stick follow the same path");
                        near(length(head.rider().forward - stick.rider().forward), 0,
                             "gaze cannot also aim the grounded nose");
                        near(head.rider().view_yaw, 0, "head-only steering cannot turn the headset seat");
                    }
                }
}

void ownership() {
    near(vr_axis(.1, true), 0, "resting stick is exactly centred");
    near(vr_axis(1, true), 1, "hard lock retains full steer");
    const auto half = (.5 - .18) / .82;
    near(vr_axis(.5, true), half * half, "ground precision curve follows dead-zone normalization");
    near(vr_axis(-.5, true), -half * half, "precision curve is symmetric");
    near(vr_axis(.5, false), half, "air spin retains linear normalized throw");
    near(gaze_carve(rotate({0, 0, -1}, {0, 1, 0}, 3 * pi / 180), {0, 0, -10}, {0, 1, 0}, {0, 0, -1}), 0,
         "five-degree gaze dead zone");
    near(gaze_carve({0, -1, 0}, {0, 0, -10}, {0, 1, 0}, {0, 0, -1}), 0,
         "looking vertically cannot choose a steering yaw");
    Player aimed(floor());
    aimed.warp({0, -.005, 0}, {0, 0, -1}, {0, 0, -16});
    RideInput gaze;
    gaze.vr = {true, true, false, rotate({0, 0, -1}, {0, 1, 0}, .7), 0};
    double peak = 0;
    for (unsigned i = 0; i < 240; ++i) {
        aimed.tick(gaze);
        peak = std::max(peak, std::abs(aimed.rider().lean));
    }
    check(std::abs(gaze_yaw(gaze.vr.gaze, aimed.rider().forward, {0, 1, 0})) < 12 * pi / 180,
          "fixed gaze draws heading onto the target rather than past it");
    check(peak > .1 && std::abs(aimed.rider().lean) < peak * .5, "head carve relaxes as travel reaches gaze");
    check(dot(aimed.rider().velocity, gaze.vr.gaze) > 1, "head aim actually bends travel");
    for (const auto amount : {.02, .5, -.5}) {
        Player a(floor()), b(floor());
        for (auto* p : {&a, &b})
            p->warp({0, -.005, 0}, {0, 0, -1}, {0, 0, -16});
        for (unsigned i = 0; i < 120; ++i) {
            RideInput x;
            x.steer = amount;
            x.vr = {true, true, true, {0, 0, -1}, amount};
            auto y = x;
            y.vr.gaze = {1, 0, 0};
            a.tick(x);
            b.tick(y);
            near(length(a.rider().velocity - b.rider().velocity), 0, "owned stick overrides conflicting gaze");
            near(a.rider().view_yaw, b.rider().view_yaw, "gaze adds no headset carry during stick override");
        }
    }
    Player carried(floor());
    carried.warp({0, -.005, 0}, {0, 0, -1}, {0, 0, -16});
    const auto before = carried.rider().forward;
    RideInput input;
    input.steer = 1;
    input.vr = {true, false, true, {0, 0, -1}, 1};
    carried.tick(input);
    near(carried.rider().view_yaw, .25 * gaze_yaw(carried.rider().forward, before, {0, 1, 0}),
         "ground stick applies quarter view carry after heading closure");
}

void air_and_rail() {
    Player air(floor());
    air.warp({0, 60, 0}, {0, 0, -1}, {0, 6, -16});
    RideInput look;
    look.vr = {true, true, false, {-1, 0, 0}, 0};
    for (unsigned i = 0; i < 40; ++i)
        air.tick(look);
    check(dot(air.rider().forward, {-1, 0, 0}) > .99, "air nose reaches looked-at landing bearing");
    const auto reached = air.rider().forward;
    for (unsigned i = 0; i < 30; ++i)
        air.tick(look);
    near(length(air.rider().forward - reached), 0, "air gaze stops turning on arrival");
    near(air.rider().view_yaw, 0, "air gaze keeps upright view pinned");
    Player spin(floor());
    spin.warp({0, 60, 0}, {0, 0, -1}, {0, 6, -16});
    look.vr.stick = true;
    look.vr.spin = 1;
    look.steer = 1;
    spin.tick(look);
    near(spin.rider().spin_degrees, 4.5, "manual air spin overrides head target");
    near(spin.rider().view_yaw, 4.5 * pi / 180, "air stick carries full yaw");
    const auto setup = [](Player& p) {
        p.warp({0, 1.55, -5}, {0, 0, -1}, {0, 0, -12});
        p.rails() = Rails({{13, true, {{{Vec3{}, Vec3{}, Vec3{0, 0, -500}, Vec3{0, 1.5, 0}}}}}});
    };
    Player rail(floor());
    setup(rail);
    look = {};
    look.vr = {true, true, false, rotate({0, 0, -1}, {0, 1, 0}, 120 * pi / 180), 0};
    for (unsigned i = 0; i < 100; ++i)
        rail.tick(look);
    check(rail.rider().motion == Motion::Rail && dot(rail.rider().forward, look.vr.gaze) > .99,
          "head gaze freely aims the VR rail deck beyond desktop pose cap");
    near(rail.rider().view_yaw, 0, "rail head steering leaves seat pinned");
    Player thumb(floor());
    setup(thumb);
    look.steer = 1;
    look.vr.stick = true;
    look.vr.spin = 1;
    for (unsigned i = 0; i < 60; ++i)
        thumb.tick(look);
    near(thumb.rider().view_yaw, 3 * pi / 2, "rail stick carries the shared 270 degree air rate");
    near(thumb.rider().rail_spin, 270, "VR rail deck follows manual turn");
    const auto held = thumb.rider().forward;
    look.vr = {true, false, false, {0, 0, -1}, 0};
    look.steer = 0;
    thumb.tick(look);
    near(length(thumb.rider().forward - held), 0, "Unowned VR controls preserve the freely rotated rail pose");
    for (const auto boost : {false, true}) {
        Player head(floor()), stick(floor());
        setup(head);
        setup(stick);
        head.tick({});
        stick.tick({});
        look = {};
        look.boost = boost;
        look.vr = {true, true, false, {-1, 0, 0}, 0};
        head.tick(look);
        near(head.rider().rail_spin, 4.5, "Rail gaze approaches its target at the unboosted air rate");
        near(head.rider().view_yaw, 0, "Gaze-driven rail turns never feed back into headset seat yaw");
        look.vr.stick = true;
        look.vr.spin = -.5;
        stick.tick(look);
        near(stick.rider().rail_spin, -2.25 * (boost ? 1.6 : 1),
             "Analog rail stick uses the shared air rate and trick boost multiplier");
        near(stick.rider().view_yaw, stick.rider().rail_spin * pi / 180,
             "Boosted rail stick carries exactly its manual turn into the view");
        near(length(stick.rider().position - head.rider().position), 0,
             "Head and stick rail yaw retain identical tangent travel");
    }
}

void system_pause() {
    Player player(floor());
    player.warp({0, 40, 0}, {0, 0, -1}, {0, -3, -8});
    VrFrameClock clock;
    near(clock.step(10, true), 0, "initial focus does not invent elapsed simulation");
    player.advance(clock.step(10 + h, true), {});
    const auto position = player.rider().position, velocity = player.rider().velocity;
    player.release_inputs();
    player.advance(clock.step(15, false), {});
    player.advance(clock.step(35, false), {});
    player.advance(clock.step(45, true), {});
    near(length(player.rider().position - position), 0, "system pause and first resumed frame preserve position");
    near(length(player.rider().velocity - velocity), 0, "app switching never catches up paused physics");
    const auto dt = clock.step(45 + h, true);
    near(dt, h, "normal display intervals resume after focus returns");
    player.advance(dt, {});
    check(length(player.rider().position - position) > .01, "resumed game advances normally");
    clock.reset();
    near(clock.step(100, true), 0, "stopped session restart resets its display clock");
    check(std::any_of(touch_bindings().begin(), touch_bindings().end(),
                      [](const auto& binding) {
                          return binding.action == VrBindingAction::Menu &&
                                 binding.path == "/user/hand/left/input/menu/click";
                      }),
          "left controller Menu opens the in-app wrist menu");
    check(std::none_of(touch_bindings().begin(), touch_bindings().end(),
                       [](const auto& binding) { return binding.path == "/user/hand/right/input/menu/click"; }),
          "Touch bindings leave the right system button to Horizon");
}

} // namespace

int main() {
    try {
        system_pause();
        carve();
        ownership();
        air_and_rail();
        std::cout << "PASS: " << checks
                  << " head/stick carve, switch/slope, ownership, view carry, air and rail checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
