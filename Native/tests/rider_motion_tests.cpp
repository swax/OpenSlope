#include "openslope/avatar.hpp"
#include "openslope/camera.hpp"
#include <iostream>
#include <limits>
#include <stdexcept>

namespace {
using namespace openslope;
using J = AvatarJoint;
unsigned checks = 0;

void check(bool condition, const char* what) {
    ++checks;
    if (!condition)
        throw std::runtime_error(what);
}

void close(Vec3 a, Vec3 b, const char* what, double tolerance = 1e-7) { check(length(a - b) < tolerance, what); }

void segment(const AvatarPose& p, J a, J b, double expected) {
    check(std::abs(length(p.joint(a) - p.joint(b)) - expected) < 1e-6, "anatomical limb length");
}

void limbs(const AvatarPose& p) {
    for (unsigned side = 0; side < 2; ++side) {
        segment(p, side ? J::RightHip : J::LeftHip, side ? J::RightKnee : J::LeftKnee, .4165);
        segment(p, side ? J::RightKnee : J::LeftKnee, side ? J::RightAnkle : J::LeftAnkle, .4182);
        segment(p, side ? J::RightShoulder : J::LeftShoulder, side ? J::RightElbow : J::LeftElbow, .3162);
        segment(p, side ? J::RightElbow : J::LeftElbow, side ? J::RightWrist : J::LeftWrist, .2482);
    }
    for (const auto v : p.joints)
        check(finite(v), "finite procedural joint");
}

Terrain flat() {
    Patch p;
    for (unsigned u = 0; u < 4; ++u)
        for (unsigned v = 0; v < 4; ++v)
            p.points[u * 4 + v] = {double(u) * 2000 / 3 - 1000, 0, double(v) * 2000 / 3 - 1000};
    return Terrain({p});
}

void filters() {
    constexpr double dt = 1. / 60;
    RiderMotion motion;
    RiderMotionInput in;
    in.grounded = true;
    in.lean = 1;
    motion.step(in, dt);
    in.lean = -1;
    motion.step(in, dt);
    check(motion.sample(1).lean > .7, "edge reversal eases instead of snapping");
    for (unsigned i = 1; i < 60; ++i)
        motion.step(in, dt);
    check(std::abs(motion.sample(1).lean + 1) < .02, "edge pose settles in one second");
    const auto previous = motion.sample(0), current = motion.sample(1), middle = motion.sample(.5);
    check(std::abs(middle.lean - (previous.lean + current.lean) * .5) < 1e-9, "render interpolation");
    in.placement++;
    in.position = {0, 1000, 0};
    in.velocity = {0, 300, 0};
    motion.step(in, dt);
    close(motion.sample(1).acceleration, {}, "warp does not inject balance impulse");
    check(motion.sample(1).hip_lag == 0, "warp clears hip absorber");
    in.on_foot = true;
    motion.step(in, dt);
    close(motion.sample(1).hands, {}, "dismount resets hand inertia");
    for (const double hz : {30., 60., 120., 240.}) {
        motion.reset();
        in = {};
        motion.step(in, 1 / hz);
        for (unsigned i = 0; i < unsigned(hz * 2); ++i) {
            in.velocity.y -= 8.5 / hz;
            motion.step(in, 1 / hz);
        }
        const auto out = motion.sample(1);
        check(out.hands.y > .037 && out.hands.y < .039, "freefall arms rise consistently across step rates");
        check(out.hip_lag == 0, "airborne hip travels with the deck");
    }
    motion.reset();
    in = {};
    in.grounded = true;
    motion.step(in, dt);
    double deck_low = 1, deck_high = -1, head_low = 1, head_high = -1;
    for (unsigned i = 0; i < 600; ++i) {
        in.position.y = .086 * std::sin(i * dt * 4.3 * 2 * pi);
        motion.step(in, dt);
        if (i > 300) {
            const auto head = in.position.y + motion.sample(1).hip_lag;
            deck_low = std::min(deck_low, in.position.y);
            deck_high = std::max(deck_high, in.position.y);
            head_low = std::min(head_low, head);
            head_high = std::max(head_high, head);
        }
    }
    check((head_high - head_low) / (deck_high - deck_low) < .25, "hips absorb vertical chatter");
    motion.reset();
    in = {};
    in.velocity = {0, -6.3, 0};
    motion.step(in, dt);
    in.velocity = {};
    in.grounded = true;
    in.landings++;
    motion.step(in, dt);
    check(motion.sample(1).hip_lag < -.07 && motion.sample(1).hip_lag > -.12, "landing compresses body");
    for (unsigned i = 0; i < 120; ++i)
        motion.step(in, dt);
    check(std::abs(motion.sample(1).hip_lag) < .001, "landing absorber settles");
    in.launches++;
    in.grounded = false;
    in.launch_charge = .8;
    motion.step(in, dt);
    check(motion.sample(1).pop == .8, "pop follows released charge");
    for (unsigned i = 0; i < 60; ++i)
        motion.step(in, dt);
    check(motion.sample(1).pop == 0, "pop relaxes in flight");
    motion.reset();
    in = {};
    in.grounded = true;
    for (unsigned i = 0; i < 720; ++i)
        motion.step(in, dt);
    check(motion.sample(1).glance == 0, "parked rider stays attentive");
    in.calm = true;
    double maximum = 0;
    for (unsigned i = 0; i < 1800; ++i) {
        motion.step(in, dt);
        maximum = std::max(maximum, std::abs(motion.sample(1).glance));
    }
    check(maximum > .2 && maximum < 65 * pi / 180, "cruising produces bounded occasional glances");
    in.calm = false;
    for (unsigned i = 0; i < 120; ++i)
        motion.step(in, dt);
    check(std::abs(motion.sample(1).glance) < .001, "activity interrupts glance");
    bool rejected = false;
    in.velocity.x = std::numeric_limits<double>::quiet_NaN();
    try {
        motion.step(in, dt);
    } catch (const std::invalid_argument&) {
        rejected = true;
    }
    check(rejected, "invalid presentation input rejected");
}

void poses() {
    Player p(flat());
    p.warp({}, {0, 0, -1}, {0, 0, -12});
    for (unsigned i = 0; i < 420; ++i) {
        RideInput input;
        input.steer = i < 120 ? 1 : i < 240 ? -1 : 0;
        input.jump = i >= 280 && i < 305;
        input.posture = i >= 240 && i < 280 ? 1 : 0;
        p.tick(input);
        const auto pose = avatar_pose(p);
        limbs(pose);
        check(pose.joint(J::LeftKnee).y >= p.render_board_position().y - .14 &&
                  pose.joint(J::RightKnee).y >= p.render_board_position().y - .14,
              "knees remain above the flat-course trench");
        close(pose.joint(J::LeftAnkle), p.render_board_position() + p.render_forward() * .27 + p.render_up() * .12,
              "front binding remains on the deck");
        close(pose.joint(J::RightAnkle), p.render_board_position() - p.render_forward() * .27 + p.render_up() * .12,
              "rear binding remains on the deck");
        check(dot(pose.head_forward, p.render_forward() * double(p.rider().lead)) > .99,
              "engaged rider looks along travel");
    }
    p.warp({}, {0, 0, -1}, {0, 0, 10});
    // Presentation fixture, independent of the physical stance transition gate.
    const_cast<Rider&>(p.rider()).lead = -1;
    const auto switched = avatar_pose(p);
    close(switched.joint(J::LeftAnkle), p.render_board_position() + p.render_forward() * .27 + p.render_up() * .12,
          "switch does not swap anatomical feet");
    check(dot(switched.head_forward, p.render_forward()) < -.99, "switch head looks toward trailing deck end");
    p.warp({}, {0, 0, -1});
    p.start_on_foot();
    const auto standing = avatar_pose(p);
    double arm_travel = 0, hip_travel = 0;
    for (unsigned i = 0; i < 90; ++i) {
        RideInput input;
        input.posture = 1;
        p.tick(input);
        const auto pose = avatar_pose(p);
        limbs(pose);
        arm_travel = std::max(arm_travel, length(pose.joint(J::LeftWrist) - pose.joint(J::LeftShoulder) -
                                                 (standing.joint(J::LeftWrist) - standing.joint(J::LeftShoulder))));
        hip_travel = std::max(hip_travel, std::abs(pose.joint(J::Hips).x - p.render_position().x));
    }
    check(arm_travel > .08 && hip_travel > .005, "walk drives arm swing and torso sway");
    AvatarTracking tracking;
    tracking.head = p.render_position() + Vec3{0, 1.65, 0};
    tracking.forward = normalized(Vec3{1, -.6, 1});
    tracking.up = normalized(project({0, 1, 0}, tracking.forward));
    for (unsigned side = 0; side < 2; ++side) {
        auto& c = tracking.controllers[side];
        c.valid = true;
        c.position = tracking.head + Vec3{side ? .7 : -.7, -.1, -.55};
    }
    const auto tracked = avatar_pose(p, &tracking);
    close(tracked.eye(), tracking.head, "eye bridge matches HMD position");
    close(tracked.head_forward, tracking.forward, "head pitch/yaw follow HMD");
    close(tracked.head_up, tracking.up, "head roll follows HMD");
    check(dot(tracked.forward, Vec3{0, 0, -1}) > .99, "held-out grips stabilize wearer frame while looking back");
    close(tracked.joint(J::LeftWrist), tracking.controllers[0].position, "distant grip retained at physical hand");
    close(tracked.joint(J::RightWrist), tracking.controllers[1].position, "second grip retained at physical hand");
    limbs(tracked);
    tracking.body_active = true;
    tracking.confidence = .9f;
    tracking.valid[unsigned(J::Head)] = true;
    tracking.joints[unsigned(J::Head)] = tracking.head + Vec3{.2, .1, .3};
    close(avatar_pose(p, &tracking).eye(), tracking.head, "HMD outranks inferred body-tracker head");
    tracking.body_active = false;
    tracking.controllers[0].position = tracked.joint(J::LeftShoulder);
    const auto folded_arm = avatar_pose(p, &tracking);
    close(folded_arm.joint(J::LeftWrist), tracking.controllers[0].position, "close grip remains at hand");
    limbs(folded_arm);
    const auto before = p.rider().position;
    AvatarLook look{{1, 0, 0}, {0, 1, 0}};
    const auto looked = avatar_pose(p, nullptr, &look);
    close(looked.head_forward, look.forward, "desktop look has independent head frame");
    close(looked.joint(J::Hips), avatar_pose(p).joint(J::Hips), "looking does not turn hips");
    close(p.rider().position, before, "posing does not move player");
    FollowCamera camera;
    camera.first_person = true;
    camera.step(p, 1. / 60);
    const AvatarLook camera_look{camera.pose().forward, camera.pose().up};
    close(camera.pose().eye, avatar_pose(p, nullptr, &camera_look).eye(), "first-person camera uses eye bridge");
    Player carrying(flat());
    carrying.warp({}, {0, 0, -1});
    carrying.start_on_foot();
    RideInput grab;
    grab.equipment.tracked = true;
    grab.equipment.head = {0, 1.65, 0};
    grab.equipment.grip[1] = true;
    for (unsigned turn = 0; turn < 4; ++turn) {
        const auto angle = turn * pi / 2;
        grab.equipment.hands[1] = {{.3, 1.1, -.25},
                                   rotate({0, 1, 0}, {0, 0, -1}, angle),
                                   {0, 0, -1},
                                   rotate({1, 0, 0}, {0, 0, -1}, angle),
                                   true};
        carrying.tick(grab);
        check(carrying.carrying_board(), "board-carry head fixture remains attached");
        const auto pose = avatar_pose(carrying);
        close(pose.head_up, {0, 1, 0}, "held board roll cannot roll the walker's head");
        close(pose.head_forward, carrying.rider().forward, "held board yaw cannot steer the walker's head");
        limbs(pose);
    }
}
} // namespace

int main() {
    try {
        filters();
        poses();
        std::cout << "PASS: " << checks << " rider motion, binding, anatomy, gaze and tracking checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
