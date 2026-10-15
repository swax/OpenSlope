#include "openslope/ride_ui.hpp"
#include <iostream>
#include <stdexcept>

namespace {
using namespace openslope;
unsigned checks = 0;

void check(bool value, const char* message) {
    ++checks;
    if (!value)
        throw std::runtime_error(message);
}

void close(Vec3 a, Vec3 b, const char* message) { check(length(a - b) < 1e-6, message); }

Terrain floor() {
    Patch p;
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            p.points[u * 4 + v] = {double(u) * 100 / 3 - 50, 0, double(v) * 100 / 3 - 50};
    return Terrain({p});
}

RideInput hand_input(const Player& p) {
    RideInput input;
    input.equipment.tracked = true;
    input.equipment.head = p.rider().position + Vec3{0, 1.65, 0};
    input.equipment.facing = {0, 0, -1};
    for (auto& h : input.equipment.hands)
        h = {p.render_board_position() + Vec3{0, 1.1, 0}, {1, 0, 0}, {0, 1, 0}, {0, 0, -1}, true};
    return input;
}

void math() {
    EquipmentPose pose;
    close(equipment_nearest(pose, {2, 1, 2}),
          {equipment_half_width, equipment_height + equipment_half_height, equipment_half_length},
          "Closest point uses stock deck outline, not centre");
    const EquipmentRay above{{0, 2, 0}, {0, -1, 0}, true};
    const auto hit = equipment_ray(pose, above);
    check(hit && std::abs(*hit - (2 - equipment_height - equipment_half_height - .1)) < 1e-7,
          "Aim padding is ten centimetres");
    check(!equipment_ray(pose, {{0, 4.3, 0}, {0, -1, 0}, true}), "Mount ray has four metre reach");
    check(!equipment_ray(pose, {{2, 2, 0}, {0, -1, 0}, true}), "Aim misses outside outline");
    const auto axis = normalized(Vec3{1, 2, 3});
    pose = {{4, 2, -8}, rotate({0, 0, -1}, axis, 1.1), rotate({0, 1, 0}, axis, 1.1)};
    const auto point = equipment_point(pose, {2, 1, 2});
    close(
        equipment_nearest(pose, point),
        equipment_point(pose, {equipment_half_width, equipment_height + equipment_half_height, equipment_half_length}),
        "Outline queries are rigid-frame invariant");
    check(equipment_summon({0, 1.65, 0}, {0, -1, -.01}, {0, 1.7, .3}), "Summon is yaw-only while looking down");
    check(!equipment_summon({0, 1.65, 0}, {0, 0, -1}, {0, .2, .1}), "Low hand cannot summon");
    check(!equipment_summon({0, 1.65, 0}, {0, 0, -1}, {0, 1.7, -.3}), "Forward hand cannot summon");
    EquipmentHand hand{{0, 2, 0}, {1, 0, 0}, {0, 1, 0}, {0, 0, -1}, true};
    const EquipmentHand raw{{0, 2, 0}, {1, 0, 0}, {0, 0, 1}, {0, 1, 0}, true};
    const auto canonical = carry_hand(raw), restored = grip_hand(canonical);
    close(canonical.right, {0, 1, 0}, "Carry long axis follows controller physical upright edge");
    close(restored.right, raw.right, "Carry mapping restores raw controller right");
    close(restored.up, raw.up, "Carry mapping restores raw controller up");
    close(restored.forward, raw.forward, "Carry mapping restores raw controller forward");
    BoardCarry carry;
    carry.grab(1, canonical, {}, true);
    const auto right_carry = carry.pose();
    carry.grab(0, canonical, {}, true);
    const auto left_carry = carry.pose();
    check(right_carry.position.x < raw.position.x && left_carry.position.x > raw.position.x,
          "Both edge carries extend inward from the mirrored wrist");
    close(right_carry.forward, left_carry.forward, "Both hand carries keep the physical long edge upright");
    const auto half_axis = normalized(Vec3{0, 1, -1});
    auto half = hand;
    carry.grab(1, half, {}, true);
    carry.follow(half, 1. / 60);
    half.right = rotate(half.right, half_axis, pi);
    half.up = rotate(half.up, half_axis, pi);
    half.forward = rotate(half.forward, half_axis, pi);
    carry.follow(half, 1. / 60);
    const auto half_throw = carry.release();
    check(std::abs(dot(normalized(half_throw.spin), half_axis)) > .999,
          "Half-turn tumble retains the correct mixed-sign rotation axis");
    carry.grab(1, hand, {}, true);
    const auto pose0 = carry.pose();
    carry.follow(hand, 1. / 60);
    for (unsigned i = 0; i < 20; ++i) {
        hand.position.x += .04;
        carry.follow(hand, 1. / 60);
    }
    const auto thrown = carry.release();
    check(thrown.velocity.x > 2.3 && thrown.velocity.x < 2.41,
          "Throw records deck-centre velocity in metres per second");
    check(length(thrown.spin) < 1e-5, "Pure translation does not invent wrist spin");
    carry.grab(0, hand, pose0, true);
    carry.follow(hand, 1. / 60);
    for (unsigned i = 0; i < 20; ++i) {
        hand.right = rotate(hand.right, {0, 1, 0}, .04);
        hand.forward = rotate(hand.forward, {0, 1, 0}, .04);
        carry.follow(hand, 1. / 60);
    }
    const auto flick = carry.release();
    check(length(flick.spin) > 2.3 && length(flick.spin) < 2.41, "Wrist rotation contributes measured tumble");
    carry.grab(1, hand, pose0, true);
    carry.follow(hand, 1. / 60);
    hand.position.x += 100;
    carry.follow(hand, 1. / 60);
    const auto spike = carry.release();
    check(length(spike.velocity) <= 12 && length(spike.spin) <= 4 * pi,
          "Dropped tracking frames have bounded throw energy");
    carry.grab(1, hand, pose0, true);
    check(length(carry.release().velocity) == 0, "Summon discontinuity is never a throw");
}

void lifecycle() {
    Player p(floor());
    p.warp({0, 0, 0}, {0, 0, -1});
    p.start_on_foot();
    auto input = hand_input(p);
    input.equipment.grip[1] = true;
    p.tick(input);
    check(p.carrying_board() && p.carrying_hand() == 1 && p.on_foot(), "Right squeeze picks up without mounting");
    const auto held = avatar_pose(p);
    close(held.joint(AvatarJoint::RightWrist), p.holding_hand().position, "Desktop/VR glove lands on holding wrist");
    input.equipment.hands[0] = input.equipment.hands[1];
    input.equipment.hands[0].position = p.render_board_position();
    input.equipment.grip[0] = true;
    p.tick(input);
    check(p.carrying_hand() == 0, "Nearby free hand transfers the board");
    input.equipment.grip[1] = false;
    p.tick(input);
    check(p.carrying_board(), "Opening previous grip does not throw after transfer");
    input.equipment.trigger[1] = true;
    p.tick(input);
    check(!p.on_foot() && !p.carrying_board(), "Either trigger puts held board under feet");
    for (unsigned i = 0; i < 12; ++i)
        p.tick(input);
    check(!p.on_foot(), "Holding trigger does not repeatedly toggle mount");
    input.equipment.trigger[1] = false;
    p.tick(input);
    input.equipment.trigger[1] = true;
    p.tick(input);
    check(p.on_foot(), "Fresh trigger edge dismounts");
    input = hand_input(p);
    input.equipment.hands[1].position = p.rider().position + Vec3{0, 1.7, .3};
    input.equipment.grip[1] = true;
    p.tick(input);
    check(p.carrying_board(), "Over-shoulder gesture summons the loose board");
    p.release_inputs();
    check(!p.carrying_board() && length(p.board_velocity()) == 0 && !p.board_thrown(),
          "Focus loss drops safely without synthesizing a throw");
    // Air pickup and re-equipping retain the rider's trajectory and speed budget.
    p.warp({0, 8, 0}, {0, 0, -1}, {2, 3, -40});
    input = hand_input(p);
    input.equipment.grip[1] = true;
    p.tick(input);
    check(p.on_foot() && p.carrying_board(), "Air grip removes mounted deck");
    check(std::abs(p.rider().velocity.x - 2) < 1e-7 && std::abs(p.rider().velocity.z + 40) < 1e-7,
          "Air pickup preserves horizontal rider arc");
    const auto velocity = p.rider().velocity;
    input.equipment.trigger[1] = true;
    p.tick(input);
    close(p.rider().velocity, velocity, "Air re-equip retains arrival velocity");
    check(p.rider().speed_cap >= length(velocity), "Air re-equip raises cap to arrival speed");
    // A throw keeps horizontal momentum until first contact, then becomes a loose board.
    p.start_on_foot();
    input = hand_input(p);
    input.equipment.hands[1].position = p.rider().position + Vec3{0, 1.1, 0};
    input.equipment.grip[1] = true;
    p.tick(input);
    for (unsigned i = 0; i < 20; ++i) {
        input.equipment.hands[1].position.x += .03;
        p.tick(input);
    }
    input.equipment.grip[1] = false;
    p.tick(input);
    check(p.board_thrown(), "Opening holding grip starts thrown flight");
    const auto vx = p.board_velocity().x;
    for (unsigned i = 0; i < 3; ++i)
        p.tick(input);
    check(std::abs(p.board_velocity().x - vx) < 1e-7, "Thrown board has no horizontal air scrub");
    for (unsigned i = 0; i < 200; ++i)
        p.tick(input);
    check(!p.board_thrown() && finite(p.render_board_position()),
          "First floor contact ends thrown flight and settles safely");
}

void camera_ui() {
    Player p(floor());
    p.warp({0, 0, 0}, {0, 0, -1});
    FollowCamera camera;
    camera.step(p, 0);
    const auto initial = camera.pose();
    check(std::abs(initial.fov - 78.15 * pi / 180) < 1e-8 && initial.near_clip == .15,
          "Chase uses independent ride lens");
    check(initial.eye.y > 1.5 && length(initial.eye - Vec3{0, 1, 0}) > 1.79,
          "Specified neutral near boom rises above subject");
    camera.orbit(150, 80);
    camera.step(p, 1. / 60, false, true);
    check(length(camera.pose().eye - initial.eye) > .02, "Right drag actually orbits eye around avatar");
    close(p.rider().forward, {0, 0, -1}, "Orbit never steers physics");
    camera.zoom(-100);
    check(camera.scale() == 6, "Wheel distance is bounded");
    camera.zoom(100);
    check(camera.scale() == .5, "Wheel near distance is bounded");
    const auto clear = p.camera_position({0, .05, 0});
    check(clear.y >= .449, "Camera volume stays clear of floor");
    p.start_on_foot();
    auto input = hand_input(p);
    input.equipment.rays[1] = {p.render_board_position() + Vec3{0, 2, 0}, {0, -1, 0}, true};
    input.equipment.trigger[1] = true;
    check(p.aim_board(input.equipment.rays[1]), "Visible loose board is an aim target");
    p.tick(input);
    check(!p.on_foot(), "Aimed trigger mounts loose board where it lies");
    p.start_on_foot();
    const EquipmentRay far_camera{{0, 1, 18}, normalized(Vec3{0, -1, -18}), true};
    check(!p.aim_board(far_camera) && p.aim_board(far_camera, true),
          "Desktop zoom does not change physical board interaction reach");
    auto patches = floor().patches();
    Patch wall;
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            wall.points[u * 4 + v] = {double(u) * 10 / 3 - 5, double(v) * 5 / 3, 1};
    patches.push_back(wall);
    Player blocked(Terrain{patches});
    blocked.warp({0, 0, 0}, {0, 0, -1});
    blocked.start_on_foot();
    check(!blocked.aim_board({{0, 2, 2}, normalized(Vec3{0, -2, -2}), true}), "Terrain walls occlude aimed pickup");
    check(blocked.camera_position({0, 1, 2}).z < .61, "Chase eye is padded onto the subject side of a wall");
    Player spin(floor()), straight(floor());
    spin.warp({0, 30, 0}, {0, 0, -1}, {0, 0, -20});
    straight.warp({0, 30, 0}, {0, 0, -1}, {0, 0, -20});
    FollowCamera spinning_camera, straight_camera;
    for (unsigned i = 0; i < 30; ++i) {
        spin.tick({1});
        straight.tick({});
        spinning_camera.step(spin, 1. / 60);
        straight_camera.step(straight, 1. / 60);
    }
    close(spinning_camera.pose().eye, straight_camera.pose().eye, "Airborne board spins never orbit the travel camera");
    check(length(spin.render_forward() - straight.render_forward()) > .2,
          "Camera spin comparison actually rotated the board");
    RideUi ui;
    ui.visible = true;
    ui.frame({{0, 0, 0}, {1, 0, 0}, {0, -1, 0}, true});
    EquipmentRay ray{{.25, -.35, 1}, {0, 0, -1}, true};
    auto selected = ui.pointer(ray, true);
    check(selected.action == UiAction::Resume && selected.consumed, "Wrist/desktop action is ray selected");
    ray.origin.x = 10;
    selected = ui.pointer(ray, true);
    check(selected.action == UiAction::None && selected.consumed,
          "Dragging a pressed UI trigger away keeps it consumed");
    ui.pointer(ray, false);
    selected = ui.pointer(ray, true);
    check(!selected.consumed, "A new outside click belongs to gameplay");
    std::vector<Vertex> vertices;
    ui.append(vertices, p);
    check(vertices.size() > 1000 && vertices.size() < 100000 && vertices.size() % 3 == 0,
          "Menu produces bounded real triangle geometry");
    for (const auto& v : vertices)
        check(std::isfinite(v.x) && std::isfinite(v.y) && std::isfinite(v.z), "UI geometry is finite");
    check(!RideUi::wrist({}, {}).valid, "Missing left tracking hides the wrist panel");
    ui.map_paths = {"Maps/TEST_A", "Maps/TEST_B"};
    ui.library = true;
    check(ui.buttons()[1].map == "Maps/TEST_B", "Map library buttons retain exact selected map paths");
    check(std::any_of(touch_bindings().begin(), touch_bindings().end(),
                      [](const auto& b) { return b.action == VrBindingAction::Squeeze; }),
          "Quest exposes physical squeeze action");
    check(std::count_if(touch_bindings().begin(), touch_bindings().end(),
                        [](const auto& b) { return b.action == VrBindingAction::Aim; }) == 2,
          "Quest exposes independent per-hand aim poses");
}
} // namespace

int main() {
    try {
        math();
        lifecycle();
        camera_ui();
        std::cout << checks << " equipment/camera/UI checks passed\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "Equipment: " << e.what() << '\n';
        return 1;
    }
}
