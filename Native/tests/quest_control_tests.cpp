#include "openslope/avatar.hpp"
#include <iostream>
#include <limits>
#include <set>
#include <stdexcept>

namespace {
using namespace openslope;
unsigned checks = 0;
constexpr double h = 1. / 60;

void check(bool v, const char* message) {
    ++checks;
    if (!v)
        throw std::runtime_error(message);
}

void near(double a, double b, const char* message) { check(std::abs(a - b) < 1e-7, message); }

void close(Vec3 a, Vec3 b, const char* message) { check(length(a - b) < 3e-5, message); }

Terrain floor() {
    Patch p;
    p.surface = 1;
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            p.points[u * 4 + v] = {double(u) * 200 / 3 - 100, 0, double(v) * 200 / 3 - 100};
    return Terrain({p});
}

RideInput input(const VrButtons& buttons, bool foot) {
    const auto x = vr_intent(buttons, foot);
    RideInput result{x.steer, x.boost, x.reset, x.jump, x.posture, false, x.board, {0, 0, -1}};
    result.spawn_board = x.recall;
    result.vr = {!foot, true, false, result.walk_forward, 0};
    return result;
}

void controls() {
    const auto bound = [](VrBindingAction action, std::string_view suffix) {
        return std::count_if(touch_bindings().begin(), touch_bindings().end(),
                             [&](const auto& b) { return b.action == action && b.path == suffix; });
    };
    check(bound(VrBindingAction::Steer, "/user/hand/left/input/thumbstick") == 1 &&
              bound(VrBindingAction::Steer, "/user/hand/right/input/thumbstick") == 0,
          "Only the left stick owns board steering");
    check(bound(VrBindingAction::Look, "/user/hand/right/input/thumbstick") == 1 &&
              bound(VrBindingAction::Look, "/user/hand/left/input/thumbstick") == 0,
          "Only the right stick owns on-foot view turn");
    check(bound(VrBindingAction::Jump, "/user/hand/right/input/a/click") == 1, "A is jump");
    check(bound(VrBindingAction::Boost, "/user/hand/right/input/b/click") == 1, "B is boost");
    check(bound(VrBindingAction::Board, "/user/hand/left/input/trigger/value") == 1 &&
              bound(VrBindingAction::Board, "/user/hand/right/input/trigger/value") == 1,
          "Both triggers are board interaction");
    check(bound(VrBindingAction::Reset, "/user/hand/left/input/x/click") == 1, "X reset/recall");
    check(bound(VrBindingAction::Menu, "/user/hand/left/input/y/click") == 1, "Y controls rather than gate restart");
    check(bound(VrBindingAction::Camera, "/user/hand/right/input/thumbstick/click") == 1, "Right click camera");
    std::set<std::pair<VrBindingAction, std::string_view>> paths;
    for (const auto& binding : touch_bindings())
        check(paths.insert({binding.action, binding.path}).second, "Each action/component pair has one binding");
    check(bound(VrBindingAction::IndexTouch, "/user/hand/left/input/trigger/touch") == 1 &&
              bound(VrBindingAction::IndexTouch, "/user/hand/right/input/trigger/touch") == 1,
          "Each index reads its own capacitive trigger sensor");
    for (const auto path : {"/user/hand/left/input/x/touch", "/user/hand/left/input/y/touch",
                            "/user/hand/right/input/a/touch", "/user/hand/right/input/b/touch",
                            "/user/hand/left/input/thumbrest/touch", "/user/hand/right/input/thumbrest/touch",
                            "/user/hand/left/input/thumbstick/touch", "/user/hand/right/input/thumbstick/touch"})
        check(bound(VrBindingAction::ThumbTouch, path) == 1, "Thumb observes buttons, stick and rest on both hands");
    const auto open = controller_finger_curls({});
    check(open == std::array<double, 3>{0, 0, 0}, "Released sensors open every finger group");
    const auto touch = controller_finger_curls({0, 0, true, true});
    check(touch[0] > open[0] && touch[1] > open[1] && touch[2] == 0,
          "Capacitive touch changes thumb and index independently of grip");
    const auto grip = controller_finger_curls({1, .5, false, false});
    check(grip[0] == 0 && grip[1] == 1 && grip[2] == .5, "Trigger and grip supply continuous curls");
    const auto invalid = controller_finger_curls({std::numeric_limits<double>::quiet_NaN(), 4});
    check(invalid[1] == 0 && invalid[2] == 1, "Invalid/overrange sensors cannot corrupt hand geometry");
    VrButtons b;
    b.x = .5;
    b.y = 1;
    auto intent = vr_intent(b, false);
    near(intent.steer, 0, "Riding X turns the player rather than directly carving the deck");
    near(vr_intent(b, true).steer, -.5, "On-foot left X still strafes");
    near(intent.posture, 1, "Forward stick tucks");
    b.x = 1;
    b.y = .5;
    near(vr_intent(b, false).posture, 0, "Horizontal input cannot add accidental flip");
    near(vr_intent(b, true).posture, .5, "Walking remains two axis");
    b = {};
    b.reset = true;
    check(vr_intent(b, false).reset && !vr_intent(b, false).recall, "Mounted X resets course");
    check(!vr_intent(b, true).reset && vr_intent(b, true).recall, "On foot X recalls only equipment");
    b = {};
    b.board = true;
    intent = vr_intent(b, false);
    check(intent.board && !intent.boost && !intent.jump, "Trigger does not boost or jump");
    b = {};
    b.boost = true;
    intent = vr_intent(b, false);
    check(intent.boost && !intent.board && !intent.jump, "B does not dismount");
    VrPresentation view;
    view.step(h, {}, true);
    check(view.controls && !view.third_person, "Controls begin visible with first person");
    b = {};
    b.menu = true;
    view.step(h, b, true);
    check(!view.controls, "Y hides controls");
    view.step(h, b, true);
    check(!view.controls, "Held Y cannot flicker");
    view.step(h, {}, true);
    view.step(h, b, true);
    check(view.controls, "Second Y press shows controls");
    b = {};
    b.camera = true;
    view.step(h, b, false);
    check(view.third_person, "Stick click enters third person");
    view.step(h, b, false);
    check(view.third_person, "Held click cannot repeatedly toggle");
    close(view.camera_offset({0, 0, -1}), {0, 1, 2}, "Third-person eyes offset behind whole body");
    close(view.camera_offset({1, 0, 0}), {-2, 1, 0}, "Third-person offset follows heading");
    view.step(h, {}, false);
    view.step(h, b, false);
    check(!view.third_person, "Next click returns to first person");
    close(view.camera_offset({0, 0, -1}), {}, "First person has no offset");
    b = {};
    b.look = .1;
    view.step(1, b, true);
    near(view.yaw, 0, "Right stick drift stays neutral");
    b.look = 1;
    view.step(.5, b, true);
    near(view.yaw, -pi / 3, "Right stick turns right at 120 degrees per second");
    view.step(.5, b, false);
    near(view.yaw, -pi / 3, "Mounting stops a held right stick from turning the view");
    b.x = 1;
    view.step(.5, b, false);
    near(view.yaw, -2 * pi / 3, "Mounted left stick turns the player at 120 degrees per second");
    view.step(.5, b, true);
    near(view.yaw, -pi, "Dismounting restores right-stick turn while left X returns to strafe");
    bool failed = false;
    b.look = std::numeric_limits<double>::quiet_NaN();
    try {
        view.step(h, b, false);
    } catch (const std::invalid_argument&) {
        failed = true;
    }
    check(failed, "Reject invalid look input before state mutation");
    near(view.yaw, -pi, "Invalid input preserves view state");
    VrPresentation partial;
    b = {};
    b.x = .1;
    partial.step(.5, b, false);
    near(partial.yaw, 0, "Mounted left-stick drift cannot rotate the player");
    b.x = .5;
    b.look = -1;
    partial.step(.5, b, false);
    near(partial.yaw, -(.5 - .18) / .82 * pi / 3,
         "Mounted partial left-stick turn uses the former right-stick response and ignores right X");
}

void mounted_sticks() {
    for (const auto mode : {0, 1, 2})
        for (const auto axis : {-1., -.5, .5, 1.}) {
            Player neutral(floor()), right(floor()), left(floor());
            for (auto* player : {&neutral, &right, &left}) {
                if (mode == 2) {
                    player->warp({0, 1.55, -5}, {0, 0, -1}, {0, 0, -12});
                    player->rails() = Rails({{13, true, {{{Vec3{}, Vec3{}, Vec3{0, 0, -500}, Vec3{0, 1.5, 0}}}}}});
                } else
                    player->warp({0, mode == 1 ? 60. : -.005, 0}, {0, 0, -1}, {0, 0, -12});
            }
            VrPresentation neutral_view, right_view, left_view;
            const auto tick = [&](Player& player, VrPresentation& view, double steer, double look) {
                VrButtons buttons;
                buttons.x = steer;
                buttons.look = look;
                view.step(h, buttons, false);
                auto ride = input(buttons, false);
                check(ride.vr.head && !ride.vr.stick, "Head steering stays active while either stick is held");
                ride.vr.gaze = rotate({0, 0, -1}, {0, 1, 0}, view.yaw);
                player.tick(ride);
            };
            for (unsigned frame = 0; frame < 60; ++frame) {
                tick(neutral, neutral_view, 0, 0);
                tick(right, right_view, 0, axis);
                tick(left, left_view, axis, 0);
                close(right.rider().position, neutral.rider().position,
                      "Right stick cannot steer travel through head-steering gaze");
                close(right.rider().forward, neutral.rider().forward,
                      "Right stick cannot turn the board on ground, in air or on rails");
                near(right_view.yaw, 0, "Right stick cannot rotate the mounted view");
                near(left.rider().view_yaw, 0, "Board follow cannot add a second turn to the player's view");
                if (frame == 11)
                    check(left.rider().forward.x * axis > 0,
                          "Left-stick deflection turns the board in the same physical direction");
            }
            check(length(left.rider().forward - neutral.rider().forward) > .01,
                  "The board follows left-stick player rotation on ground, in air and on rails");
            near(left_view.yaw, -vr_axis(axis, false) * 120 * pi / 180,
                 "Left stick carries the player's full intended turn independently of board yaw");
            check((mode == 0 && left.rider().grounded) || (mode == 1 && !left.rider().grounded) ||
                      (mode == 2 && left.rider().motion == Motion::Rail),
                  "Steering fixtures exercise grounded, airborne and rail ownership");
        }
}

void tracked_turns() {
    Player player(floor());
    player.warp({0, 0, 0}, {0, 0, -1});
    for (const auto physical_height : {1.05, 1.8})
        for (const auto physical_yaw : {-.4, 0., .4})
            for (const auto axis : {-1., 1.}) {
                VrHeightCalibration height;
                height.update(physical_height, true);
                VrPresentation view;
                VrButtons buttons;
                buttons.x = axis;
                view.step(.5, buttons, false);
                AvatarTracking tracking;
                tracking.seated = height.seated();
                tracking.head = {0, physical_height - height.origin_y(), 0};
                tracking.forward = rotate({0, 0, -1}, {0, 1, 0}, view.yaw + physical_yaw);
                for (unsigned side = 0; side < 2; ++side) {
                    auto& hand = tracking.controllers[side];
                    hand.valid = true;
                    hand.position = tracking.head + rotate({side ? .25 : -.25, -.45, -.35}, {0, 1, 0}, view.yaw);
                    hand.right = rotate({1, 0, 0}, {0, 1, 0}, view.yaw);
                    hand.up = {0, 1, 0};
                    hand.forward = rotate({0, 0, -1}, {0, 1, 0}, view.yaw);
                }
                const auto pose = avatar_pose(player, &tracking);
                close(pose.head_forward, tracking.forward, "Stick yaw adds to physical head steering");
                close(pose.forward, rotate({0, 0, -1}, {0, 1, 0}, view.yaw),
                      "The player's torso turns with both hands rather than leaving the body behind");
                near(tracking.head.y, 1.65, "Seated and standing height offsets survive fallback steering");
                for (unsigned side = 0; side < 2; ++side) {
                    close(pose.joint(side ? AvatarJoint::RightWrist : AvatarJoint::LeftWrist),
                          tracking.controllers[side].position,
                          "Avatar wrists stay attached to the rotated controllers");
                    near(length(tracking.controllers[side].position - tracking.head), length(Vec3{.25, -.45, -.35}),
                         "Rotating the player preserves hand-to-head distance");
                }
            }
}

void production() {
    Player p(floor());
    p.warp({0, 1, 0}, {0, 0, -1});
    for (unsigned i = 0; i < 90; ++i)
        p.tick({});
    check(p.rider().grounded, "Test rider seated");
    VrButtons b;
    b.jump = true;
    for (unsigned i = 0; i < 20; ++i)
        p.tick(input(b, false));
    check(p.rider().charge > 0, "A charges board jump");
    b.jump = false;
    for (unsigned i = 0; i < 12; ++i)
        p.tick(input(b, false));
    check(p.rider().launches == 1 && !p.on_foot(), "A release launches without dismount");
    b.boost = true;
    p.tick(input(b, false));
    check(!p.on_foot(), "B boost keeps board mounted");
    p.warp({0, 0, 0}, {0, 0, -1});
    p.start_on_foot();
    const auto position = p.rider().position, heading = p.rider().forward;
    const auto serial = p.placement_serial();
    b = {};
    b.reset = true;
    p.tick(input(b, true));
    check(p.on_foot() && !p.reset_pending(), "On-foot X cannot warp the rider");
    close(p.rider().position, position, "Board recall preserves player position");
    close(p.rider().forward, heading, "Board recall preserves player heading");
    check(p.placement_serial() == serial, "Board recall is not a rider placement");
    close(p.render_board_position(), position + Vec3{0, 0, -1}, "X places equipment ahead");
    const auto board = p.render_board_position();
    // Stay within mounting reach with the authored 8.13 m/s forward speed.
    b.y = .25;
    for (unsigned i = 0; i < 20; ++i)
        p.tick(input(b, true));
    close(p.render_board_position(), board, "Held X does not drag equipment with walker");
    check(length(p.rider().position - position) > .1, "Walker moves independently of recalled board");
    b = {};
    b.board = true;
    p.tick(input(b, true));
    check(!p.on_foot(), "Trigger mounts nearby equipment");
    for (unsigned i = 0; i < 20; ++i)
        p.tick(input(b, false));
    check(!p.on_foot(), "Held trigger cannot alternate mount/dismount");
    b.board = false;
    p.tick(input(b, false));
    b.board = true;
    p.tick(input(b, false));
    check(p.on_foot(), "Next trigger press dismounts");
    b = {};
    b.boost = true;
    p.tick(input(b, true));
    check(p.on_foot(), "On-foot B cannot remount");
}

void grip_frames() {
    ControllerPose grip;
    grip.valid = true;
    grip.position = {3, 4, 5};
    const auto draw = controller_draw_pose(grip);
    close(draw.position, grip.position, "Grip origin stays fixed");
    close(draw.up, {0, 0, -1}, "Handle top follows thumbward grip axis");
    close(draw.forward, {0, -1, 0}, "Model face correction is a proper quarter turn");
    close(cross(draw.forward, draw.up), draw.right, "Model frame retains handedness");
    Player player(floor());
    player.warp({0, 0, 0}, {0, 0, -1});
    Avatar avatar;
    AvatarTracking tracking;
    tracking.head = {0, 1.65, 0};
    tracking.forward = {0, 0, -1};
    for (unsigned side = 0; side < 2; ++side) {
        auto& c = tracking.controllers[side];
        c.valid = true;
        c.position = {side ? .25 : -.25, 1.1, -.3};
    }
    const auto initial = avatar_pose(player, &tracking);
    auto data = avatar.mesh(initial, false, false);
    const std::vector<Vertex> baseline(data.begin(), data.end());
    const auto skin = avatar.source_triangles() * 3;
    for (unsigned side = 0; side < 2; ++side)
        for (const auto axis : std::array<Vec3, 3>{{{1, 0, 0}, {0, 1, 0}, {0, 0, 1}}}) {
            auto turned = tracking;
            auto& c = turned.controllers[side];
            c.right = rotate(c.right, axis, pi / 2);
            c.up = rotate(c.up, axis, pi / 2);
            c.forward = rotate(c.forward, axis, pi / 2);
            const auto pose = avatar_pose(player, &turned);
            const auto mesh = avatar.mesh(pose, false, false);
            check(mesh.size() == baseline.size(), "Grip rotation preserves mesh topology");
            unsigned changed = 0;
            for (std::size_t i = 0; i < skin; ++i) {
                const Vec3 before{baseline[i].x, baseline[i].y, baseline[i].z}, after{mesh[i].x, mesh[i].y, mesh[i].z};
                if (length(after - before) < 1e-5)
                    continue;
                ++changed;
                close(after, c.position + rotate(before - c.position, axis, pi / 2),
                      "Every hand/finger vertex follows full rigid grip rotation");
            }
            check(changed > 100, "Pure wrist roll must rotate hand skin, not only its pointing axis");
        }
    const Vec3 offset{.5, 1, 2};
    const auto shifted = avatar.mesh(initial, false, false, {}, offset);
    for (std::size_t i = 0; i < shifted.size(); ++i)
        close({shifted[i].x, shifted[i].y, shifted[i].z},
              Vec3{baseline[i].x, baseline[i].y, baseline[i].z} + (i < skin ? Vec3{} : offset),
              "Third-person controller offset leaves avatar IK and body in place");
}
} // namespace

int main() {
    try {
        controls();
        mounted_sticks();
        tracked_turns();
        production();
        grip_frames();
        std::cout << "PASS: " << checks
                  << " Quest binding, button lifecycle, recall, camera and full grip-frame checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
