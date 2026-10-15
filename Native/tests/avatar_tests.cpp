#include "openslope/avatar.hpp"
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

void close(Vec3 a, Vec3 b, const char* what) { check(length(a - b) < 1e-7, what); }

void finite_mesh(std::span<const Vertex> mesh) {
    for (const auto& v : mesh) {
        check(finite({v.x, v.y, v.z}), "finite skin position");
        check(v.r >= 0 && v.r <= 1 && v.g >= 0 && v.g <= 1 && v.b >= 0 && v.b <= 1, "bounded skin colour");
    }
}
} // namespace

int main() {
    try {
        Player player(Terrain::demo());
        Avatar avatar;
        check(avatar.source_vertices() == 8744, "unchanged figure vertices");
        check(avatar.source_triangles() == 4816, "unchanged figure triangles");
        const auto pose = avatar_pose(player);
        const auto full = avatar.mesh(pose);
        check(full.size() == 14448, "all authored triangles submitted");
        finite_mesh(full);
        const auto head_hidden = avatar.mesh(pose, true);
        check(head_hidden.size() < full.size(), "own head removed in first person");
        check(head_hidden.size() > 10000, "body retained in first person");
        finite_mesh(head_hidden);
        const auto before = player.rider().position;
        AvatarTracking tracking;
        tracking.head = player.render_position() + Vec3{.2, 1.65, .1};
        tracking.forward = {0, -1, -.1};
        tracking.up = {0, .1, -1};
        for (unsigned i = 0; i < 2; ++i) {
            auto& c = tracking.controllers[i];
            c.valid = true;
            c.position = tracking.head + Vec3{i ? .25 : -.25, -.4, -.25};
        }
        const auto fallback = avatar_pose(player, &tracking);
        close(fallback.up, {0, 1, 0}, "looking down does not tip fallback torso");
        check(!fallback.tracked_body && !fallback.tracked_legs, "three-point fallback mode");
        close(fallback.joint(J::LeftWrist), tracking.controllers[0].position, "left wrist follows grip");
        close(fallback.joint(J::RightWrist), tracking.controllers[1].position, "right wrist follows grip");
        const auto no_labels = avatar.mesh(fallback, true, false, tracking.head).size(),
                   labels = avatar.mesh(fallback, true, true, tracking.head).size();
        check(labels > no_labels + 3000, "controller help has visible geometry");
        finite_mesh(avatar.mesh(fallback, true, true, tracking.head));
        close(player.rider().position, before, "presentation cannot move physics");
        const auto open_hand = avatar_pose(player, &tracking);
        const auto open_mesh = avatar.mesh(open_hand, false, false);
        const std::vector<Vertex> open_vertices(open_mesh.begin(), open_mesh.end());
        for (unsigned group = 0; group < 3; ++group) {
            auto curled = open_hand;
            curled.controllers[0].fingers[group] = 1;
            const auto changed = avatar.mesh(curled, false, false);
            check(changed.size() == open_vertices.size(), "Finger sensors preserve body/controller topology");
            unsigned moved = 0;
            for (std::size_t i = 0; i < avatar.source_triangles() * 3; ++i) {
                const Vec3 a{open_vertices[i].x, open_vertices[i].y, open_vertices[i].z},
                    b{changed[i].x, changed[i].y, changed[i].z};
                if (length(a - b) <= 1e-6)
                    continue;
                ++moved;
                check(length(a - open_hand.controllers[0].position) < .3 && length(b - a) < .3,
                      "Touch poses move only the selected hand's fingers");
            }
            check(moved > 10, "Each sensor group bends visible authored finger vertices");
        }
        tracking.head.x += .4;
        for (auto& c : tracking.controllers)
            c.position.x += .4;
        const auto room = avatar_pose(player, &tracking);
        close(room.joint(J::LeftAnkle) - fallback.joint(J::LeftAnkle), {.4, 0, 0},
              "room movement carries fallback feet");
        tracking.head.x -= .4;
        for (auto& c : tracking.controllers)
            c.position.x -= .4;
        tracking.body_active = true;
        tracking.confidence = .9;
        tracking.full_body = true;
        tracking.joints = fallback.joints;
        tracking.valid.fill(true);
        tracking.joints[unsigned(J::LeftKnee)] += Vec3{-.1, 0, .2};
        tracking.joints[unsigned(J::RightKnee)] += Vec3{.1, 0, .2};
        auto tracked = avatar_pose(player, &tracking);
        check(tracked.tracked_body && tracked.tracked_legs, "full body selected");
        close(tracked.joint(J::LeftKnee), tracking.joints[unsigned(J::LeftKnee)], "runtime leg joint consumed");
        close(tracked.joint(J::RightElbow), tracking.joints[unsigned(J::RightElbow)], "runtime elbow consumed");
        finite_mesh(avatar.mesh(tracked, true, true, tracking.head));
        tracking.joints[unsigned(J::LeftAnkle)] = {1e8, 0, 0};
        tracked = avatar_pose(player, &tracking);
        check(!tracked.tracked_legs, "outlier runtime legs do not report full leg pose");
        tracking.joints = fallback.joints;
        tracking.full_body = false;
        for (unsigned i = unsigned(J::LeftHip); i < avatar_joint_count; ++i)
            tracking.valid[i] = false;
        tracked = avatar_pose(player, &tracking);
        check(tracked.tracked_body && !tracked.tracked_legs, "upper body with procedural legs");
        check(finite(tracked.joint(J::LeftKnee)), "fallback knee exists");
        tracking.valid[unsigned(J::LeftElbow)] = false;
        tracking.joints[unsigned(J::RightElbow)] = {1e8, 1e8, 1e8};
        tracking.controllers[1].valid = false;
        tracked = avatar_pose(player, &tracking);
        check(length(tracked.joint(J::RightElbow) - tracking.head) < 1, "outlier joint rejected");
        check(!tracked.controllers[1].valid, "lost grip model hidden");
        check(finite(tracked.joint(J::LeftElbow)), "partial joint fallback");
        tracking.body_active = false;
        tracking.controllers[0].valid = false;
        tracked = avatar_pose(player, &tracking);
        check(!tracked.tracked_body && !tracked.tracked_legs, "inactive body does not freeze old joints");
        check(!tracked.controllers[0].valid, "lost controllers hidden");
        tracking.controllers[0].valid = true;
        tracking.controllers[0].up.x = std::numeric_limits<double>::quiet_NaN();
        tracked = avatar_pose(player, &tracking);
        check(!tracked.controllers[0].valid, "corrupt controller orientation hidden");
        finite_mesh(avatar.mesh(tracked, true, true, tracking.head));
        tracking.head.x = std::numeric_limits<double>::quiet_NaN();
        tracked = avatar_pose(player, &tracking);
        finite_mesh(avatar.mesh(tracked));
        close(tracked.joint(J::Hips), pose.joint(J::Hips), "invalid head returns procedural body");
        const auto height = pose.joint(J::Head).y - player.render_board_position().y;
        player.advance(1, {0, false, false, false, 1});
        const auto crouched = avatar_pose(player);
        check(crouched.joint(J::Head).y - player.render_board_position().y < height - .1, "tuck lowers visible body");
        finite_mesh(avatar.mesh(crouched));
        player.warp({50, 10, 20}, {1, 0, 0}, {}, {0, 1, 0});
        const auto rotated = avatar_pose(player);
        check(std::abs(dot(rotated.forward, {0, 0, 1})) > .99, "board yaw reaches figure basis");
        finite_mesh(avatar.mesh(rotated));
        std::cout << "PASS: " << checks << " avatar pose, tracking fallback, skin and controller-label checks\n";
        return 0;
    } catch (const std::exception& e) {
        std::cerr << "FAIL: " << e.what() << '\n';
        return 1;
    }
}
