#include "openslope/appearance.hpp"
#include "openslope/ride_ui.hpp"
#include <iostream>
#include <map>
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

void desktop_controls() {
    for (const bool first_person : {false, true}) {
        for (const double strafe : {-1., 1.}) {
            Player p(floor());
            p.warp({}, {0, 0, -1});
            p.start_on_foot();
            FollowCamera camera;
            camera.first_person = first_person;
            camera.step(p, 0);
            const auto start = p.rider().position, facing = p.rider().forward;
            for (unsigned i = 0; i < 120; ++i) {
                RideInput input;
                input.steer = strafe;
                input.walk_forward = camera.facing();
                input.face_walk_forward = true;
                p.tick(input);
                camera.step(p, 1. / 60);
                close(p.rider().forward, facing, "Desktop strafe retains avatar facing in both camera views");
            }
            const auto delta = p.rider().position - start;
            check(delta.x * strafe < -7 && std::abs(dot(delta, facing)) < 1e-6,
                  "A/D walks sideways without curving or rotating its movement basis");
            camera.orbit(100, -30, true);
            const auto turned = rotate(facing, {0, 1, 0}, -.4);
            for (unsigned i = 0; i < 60; ++i) {
                RideInput input;
                input.walk_forward = camera.facing();
                input.face_walk_forward = true;
                p.tick(input);
                camera.step(p, 1. / 60, false, true);
                close(p.rider().forward, turned, "Stationary look drag turns the avatar without camera yaw feedback");
                close(p.camera_forward(), turned, "On-foot camera heading follows the turned avatar");
            }
            const auto after_turn = p.rider().position;
            for (unsigned i = 0; i < 60; ++i) {
                RideInput input;
                input.posture = 1;
                input.walk_forward = camera.facing();
                input.face_walk_forward = true;
                p.tick(input);
                camera.step(p, 1. / 60);
            }
            check(dot(normalized(p.rider().position - after_turn), turned) > .999,
                  "Walking after a drag uses the newly turned facing");
            close(p.rider().forward, turned, "Releasing look keeps the on-foot facing");
        }
    }
    Player p(floor());
    p.warp({}, {0, 0, -1});
    RideInput mouse;
    mouse.equipment = desktop_equipment(p, {{0, 2, 0}, {0, -1, 0}, true}, false);
    for (unsigned i = 0; i < 60; ++i)
        p.tick(mouse);
    check(!p.on_foot(), "Desktop pointer look does not synthesize a dismount trigger");
    p.start_on_foot();
    mouse.equipment = desktop_equipment(p, {p.render_board_position() + Vec3{0, 2, 0}, {0, -1, 0}, true}, false);
    for (unsigned i = 0; i < 60; ++i)
        p.tick(mouse);
    check(p.on_foot(), "Looking at a loose board does not mount it");
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

void tracking_rebase() {
    Player player(floor());
    player.warp({}, {0, 0, -1});
    player.start_on_foot();
    auto input = hand_input(player);
    input.equipment.hands[1].position = input.equipment.head + Vec3{0, .05, .3};
    input.equipment.grip[1] = true;
    for (unsigned tick = 0; tick < 4; ++tick)
        player.tick(input);
    check(player.carrying_board(), "Tracking rebase fixture holds a summoned board");
    const auto before = player.holding_hand();
    const auto board = player.render_board_position();
    const auto position = player.rider().position;
    const Vec3 offset{0, .6, 0};
    player.rebase_tracking(offset);
    close(player.holding_hand().position, before.position + offset, "Recalibration moves the held hand immediately");
    close(player.render_board_position(), board + offset, "Held board and hand receive the same calibration offset");
    close(player.rider().position, position, "Height calibration cannot move the physics player");
    input.equipment.head += offset;
    for (auto& hand : input.equipment.hands)
        hand.position += offset;
    player.tick(input);
    input.equipment.grip[1] = false;
    player.tick(input);
    check(!player.carrying_board(), "Release after recalibration still drops the board");
    const auto velocity = player.board_velocity();
    check(std::abs(velocity.x) < .01 && velocity.y <= 0 && velocity.y > -.4 && std::abs(velocity.z) < .01,
          "Release after recalibration has only the ordinary first-tick gravity");
    check(length(player.board_spin()) < .01, "Recalibration does not become board spin");
}

void board_art_lifecycle() {
    Player player(floor());
    const auto original = player.board_design();
    check(original < stock_board_count, "new game selects a stock board design");
    player.reset();
    check(player.board_design() == original, "respawn preserves the board artwork");
    check(!player.recall_board(), "mounted recall cannot create a board");
    check(player.board_design() == original, "rejected creation retains design");
    player.start_on_foot();
    check(player.board_design() == original, "dismount/park keeps the same board");
    check(player.recall_board(), "explicit board creation succeeds on foot");
    const auto replacement = player.board_design();
    check(replacement != original && replacement < stock_board_count, "new board rerolls without immediate repeat");
    check(player.interact_board(), "mount replacement board");
    check(player.board_design() == replacement, "mount keeps replacement design");
    player.reset(true);
    check(player.board_design() == replacement, "manual respawn keeps replacement design");
    player.restart_run();
    const auto restarted = player.board_design();
    check(restarted != replacement, "course restart selects another random board");
    player.reset();
    check(player.board_design() == restarted, "respawn after a restart keeps the newly selected board");
    RideInput restart;
    restart.run_restart = true;
    player.tick(restart);
    const auto keyboard_restart = player.board_design();
    check(keyboard_restart != restarted, "restart input selects a new board");
    player.tick(restart);
    check(player.board_design() == keyboard_restart, "holding restart does not continually replace the board");
    player.start_on_foot();
    for (unsigned draw = 0; draw < 3; ++draw) {
        const auto previous = player.board_design();
        auto pull = hand_input(player);
        pull.equipment.hands[1].position = player.rider().position + Vec3{0, 1.7, .3};
        pull.equipment.grip[1] = true;
        player.tick(pull);
        check(player.carrying_board() && player.board_design() != previous,
              "each new behind-the-head pull selects a different board");
        player.release_inputs();
    }
    for (unsigned i = 0; i < stock_board_count; ++i) {
        const auto pixels = stock_board_image(i);
        check(pixels.width == pixels.height && pixels.width % 2 == 0, "embedded board atlas has equal top/base panels");
        check(pixels.pixels.size() == std::size_t(pixels.width) * pixels.height * 4,
              "embedded board image decodes fully");
        check(!stock_board_info(i).id.empty(), "embedded artwork has a stable identity");
    }
    const auto& mesh = snowboard_mesh();
    std::map<float, std::pair<float, float>> heights;
    for (const auto& v : mesh.vertices) {
        auto& row = heights.try_emplace(v.z, v.y, v.y).first->second;
        row.first = std::min(row.first, v.y);
        row.second = std::max(row.second, v.y);
    }
    for (const auto& v : mesh.vertices)
        if (v.lh > .5f) {
            check(v.s >= 0 && v.s <= 1 && v.t >= 0 && v.t <= 1, "native surface UV stays in the board atlas");
            const auto row = heights.at(v.z);
            const bool upper_surface = v.y > (row.first + row.second) / 2;
            check(v.lx == (upper_surface ? 0.f : .5f), "upper surface uses topsheet panel, lower surface uses base");
            check(upper_surface ? v.ny > .5f : v.ny < -.5f, "deck normals point outwards for directional scene light");
        }
}

void lifecycle() {
    Player p(floor());
    p.warp({0, 0, 0}, {0, 0, -1});
    p.start_on_foot();
    const auto original_design = p.board_design();
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
    check(p.board_design() == original_design, "pickup, transfer, mount and dismount keep the physical board art");
    input = hand_input(p);
    input.equipment.hands[1].position = p.rider().position + Vec3{0, 1.7, .3};
    input.equipment.grip[1] = true;
    p.tick(input);
    check(p.carrying_board(), "Over-shoulder gesture summons the loose board");
    const auto summoned_design = p.board_design();
    check(summoned_design != original_design, "on-foot over-shoulder pull creates another stock design");
    p.release_inputs();
    check(!p.carrying_board() && length(p.board_velocity()) == 0 && !p.board_thrown(),
          "Focus loss drops safely without synthesizing a throw");
    // Air pickup and re-equipping retain the rider's trajectory and speed budget.
    p.warp({0, 8, 0}, {0, 0, -1}, {2, 3, -40});
    input = hand_input(p);
    input.equipment.grip[1] = true;
    p.tick(input);
    check(p.on_foot() && p.carrying_board(), "Air grip removes mounted deck");
    check(p.board_design() == summoned_design, "air trick grab retains the board design");
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
    check(p.board_design() == summoned_design, "throwing and landing keep the board design");
}

void loose_board_recovery() {
    auto patches = floor().patches();
    for (auto& point : patches[0].points)
        point.y = point.z * .5;
    Player p(Terrain{patches});
    p.warp({}, {0, 0, -1});
    p.start_on_foot();
    auto input = hand_input(p);
    input.equipment.hands[1] = {p.rider().position + Vec3{0, 1.7, .3}, {0, 0, -1}, {0, 1, 0}, {-1, 0, 0}, true};
    input.equipment.grip[1] = true;
    p.tick(input);
    check(p.carrying_board(), "Slope recovery fixture summons the board");
    // Release below the course to exercise the same fallback as a lost throw.
    input.equipment.hands[1].position.y = p.terrain().bounds().min.y - 100;
    input.equipment.grip[1] = false;
    p.tick(input);
    check(!p.carrying_board() && !p.board_thrown(), "Lost board returns to support near the rider");
    check(p.render_board_position().y > p.terrain().bounds().min.y,
          "Lost board recovery actually places the board on the sloped course");
    const EquipmentPose deck{p.render_board_position(), p.render_forward(), p.render_up()};
    check(finite(equipment_point(deck, {})), "Recovered board supports rigid equipment queries");
    check(std::abs(dot(p.render_forward(), p.render_up())) < 1e-8,
          "Recovered board forward remains perpendicular to its new slope normal");
    p.tick(hand_input(p));
    check(finite(p.render_board_position()), "Tracked hands can query the recovered board on the next tick");
}

void mounted_board_frames() {
    Player p(floor());
    auto& rider = const_cast<Rider&>(p.rider());
    for (const auto direction : std::array<Vec3, 4>{{{1, 0, 0}, {0, 1, 0}, {0, 0, -1}, normalized({.3, .5, .8})}})
        for (const auto epsilon : {0., 1e-12, 1e-9, 1e-6, .1})
            for (const auto flip : {0., 90., 180., 270.})
                for (const auto lean : {-1., 0., 1.}) {
                    const auto tangent = normalized(cross(direction, {1, 0, 0}), {0, 0, 1});
                    rider.forward = direction;
                    rider.board_up = normalized(direction + tangent * epsilon);
                    rider.flip_degrees = flip;
                    rider.lean = lean;
                    const EquipmentPose deck{p.render_board_position(), p.render_forward(), p.render_up()};
                    check(finite(equipment_point(deck, {})),
                          "Mounted board equipment frame survives aligned carried tilt and heading");
                    check(std::abs(dot(deck.forward, deck.up)) < 1e-8,
                          "Mounted frame remains perpendicular through singular tilt, flips and banking");
                }
    p.tick(hand_input(p));
    check(!p.on_foot(), "Tracked hands query the mounted board without requiring a dismount");
    Player vertical(floor());
    vertical.warp({0, 30, 0}, {0, 1, 0}, {}, {0, 0, 1});
    RideInput vr;
    vr.vr.enabled = true;
    vertical.advance(1. / 60, vr);
    auto& flipped = const_cast<Rider&>(vertical.rider());
    flipped.forward = {0, 1, 0};
    flipped.board_up = {0, 0, 1};
    flipped.flip_degrees = 180;
    vertical.advance(1. / 120, vr);
    check(std::abs(vertical.frame_alpha() - .5) < 1e-8,
          "Vertical flip fixture samples halfway between opposing board frames");
    const EquipmentPose interpolated{vertical.render_board_position(), vertical.render_forward(), vertical.render_up()};
    check(finite(equipment_point(interpolated, {})),
          "Cancelled vertical flip interpolation retains a rigid equipment frame");
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
    RideUi wrist;
    wrist.visible = wrist.immersive = wrist.map_picker = true;
    wrist.frame({{0, 0, 0}, {1, 0, 0}, {0, -1, 0}, true});
    VrPresentation presentation;
    VrButtons menu;
    menu.menu = true;
    presentation.step(0, menu, true);
    wrist.visible = presentation.controls;
    wrist.stats = true;
    std::vector<Vertex> hidden;
    wrist.append(hidden, p, true, 90);
    wrist.append_pointer(hidden, {{0, 0, 1}, {0, 0, -1}, true});
    check(hidden.empty(), "Y hides the complete wrist UI, speed summary, stats and pointer");
    presentation.step(0, {}, true);
    presentation.step(0, menu, true);
    wrist.visible = presentation.controls;
    wrist.append(hidden, p, true, 90);
    check(hidden.size() > 1000, "A second Y press restores the wrist interface");
    const auto menu_buttons = wrist.buttons();
    check(std::none_of(menu_buttons.begin(), menu_buttons.end(),
                       [](const auto& b) { return b.text.find("HEAD STEER") != std::string::npos; }),
          "Always-on head steering has no wrist-menu toggle");
    for (const auto action : {UiAction::Maps, UiAction::Exit}) {
        const auto buttons = wrist.buttons();
        const auto button =
            std::find_if(buttons.begin(), buttons.end(), [&](const auto& b) { return b.action == action; });
        check(button != buttons.end(), "Quest wrist menu offers separate map-library and app-exit actions");
        wrist.release();
        const EquipmentRay pointer{{button->x + button->w / 2, -button->y - button->h / 2, 1}, {0, 0, -1}, true};
        const auto result = wrist.pointer(pointer, true);
        check(result.action == action && result.consumed,
              "wrist exit destination is selected by the real UI ray handler");
    }
    VrInputGate gate;
    wrist.release();
    const auto exit_buttons = wrist.buttons();
    const auto exit_button = std::find_if(exit_buttons.begin(), exit_buttons.end(),
                                          [](const auto& b) { return b.action == UiAction::Exit; });
    const EquipmentRay exit_ray{
        {exit_button->x + exit_button->w / 2, -exit_button->y - exit_button->h / 2, 1}, {0, 0, -1}, true};
    UiResult resumed;
    if (gate.accept(true))
        resumed = wrist.pointer(exit_ray, true);
    check(resumed.action == UiAction::None, "held system-menu trigger cannot select wrist Exit on focus return");
    if (gate.accept(false))
        wrist.pointer(exit_ray, false);
    if (gate.accept(true))
        resumed = wrist.pointer(exit_ray, true);
    check(resumed.action == UiAction::Exit, "fresh released-and-pressed trigger can select wrist Exit");
    gate.release();
    check(!gate.accept(true), "each focus loss disarms carried-over button presses");
    check(!RideUi::wrist({}, {}).valid, "Missing left tracking hides the wrist panel");
    ControllerPose left;
    left.valid = true;
    left.position = {1, 2, 3};
    const auto frame = RideUi::wrist(left, {0, 4, 8});
    const auto other_eye = RideUi::wrist(left, {7, 8, 9});
    close(frame.origin, other_eye.origin, "Head movement cannot billboard the controller-fixed menu");
    close(frame.right, other_eye.right, "Menu orientation stays attached to the controller");
    for (const auto axis : std::array<Vec3, 3>{{{1, 0, 0}, {0, 1, 0}, {0, 0, 1}}}) {
        auto rotated = left;
        rotated.right = rotate(left.right, axis, .7);
        rotated.up = rotate(left.up, axis, .7);
        rotated.forward = rotate(left.forward, axis, .7);
        const auto attached = RideUi::wrist(rotated, {0, 4, 8});
        close(attached.origin, left.position + rotate(frame.origin - left.position, axis, .7),
              "Menu follows full controller yaw, pitch and roll");
        close(attached.right, rotate(frame.right, axis, .7), "Panel axes rotate with the wrist");
    }
    for (const auto corner :
         {frame.origin, frame.origin + frame.right, frame.origin + frame.down, frame.origin + frame.right + frame.down})
        check(dot(corner - left.position, left.forward) >= .169,
              "Every menu corner remains beyond the hand and controller body");
    const Vec3 shift{2, 1, -1};
    close(RideUi::wrist(left, {}, shift).origin, frame.origin + shift,
          "Third-person menu receives exactly the same presentation offset as its controller");
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
        tracking_rebase();
        board_art_lifecycle();
        lifecycle();
        loose_board_recovery();
        mounted_board_frames();
        desktop_controls();
        camera_ui();
        std::cout << checks << " equipment/camera/UI checks passed\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "Equipment: " << e.what() << '\n';
        return 1;
    }
}
