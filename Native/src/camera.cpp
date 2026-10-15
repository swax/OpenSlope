#include "openslope/camera.hpp"
#include "openslope/avatar.hpp"
#include <stdexcept>

namespace openslope {
void FollowCamera::orbit(double dx, double dy) {
    if (!std::isfinite(dx) || !std::isfinite(dy))
        throw std::invalid_argument("Invalid camera drag");
    orbit_yaw_ = std::remainder(orbit_yaw_ - dx * .004, 2 * pi);
    orbit_pitch_ = std::clamp(orbit_pitch_ - dy * .004, -1.25, 1.25);
}

void FollowCamera::zoom(double steps) {
    if (!std::isfinite(steps))
        throw std::invalid_argument("Invalid camera zoom");
    zoom_ = std::clamp(zoom_ * std::exp(-steps * .12), .5, 6.);
}

void FollowCamera::step(const Player& p, double seconds, bool boosting, bool dragging) {
    if (!std::isfinite(seconds) || seconds < 0)
        throw std::invalid_argument("Invalid camera time");
    const auto dt = std::min(seconds, .1), angular = 1 - std::pow(15. / 16, 60 * dt),
               positional = 1 - std::pow(.8, 60 * dt);
    const auto& r = p.rider();
    auto travel = p.on_foot() ? p.camera_forward() : project(r.velocity, {0, 1, 0});
    if (length(travel) < .2)
        travel = r.grounded ? p.camera_forward() : heading_;
    travel = normalized(travel, {0, 0, -1});
    const bool fresh = !ready_ || serial_ != p.placement_serial() || previous_first_ != first_person;
    if (fresh) {
        heading_ = travel;
        pitch_ = -.16 - std::atan2(35., 180.);
        orbit_yaw_ = orbit_pitch_ = 0;
    }
    if (!dragging && !first_person)
        orbit_yaw_ *= std::exp(-dt * 1.6), orbit_pitch_ *= std::exp(-dt * 1.6);
    const auto turn = std::atan2(dot(cross(heading_, travel), Vec3{0, 1, 0}), dot(heading_, travel));
    heading_ = normalized(rotate(heading_, {0, 1, 0}, turn * angular));
    const auto slope =
        std::clamp(std::atan2(r.velocity.y, std::max(.2, length(project(r.velocity, {0, 1, 0})))), -.65, .5);
    const auto pitch_target = -.16 - std::atan2(35., 180.) + slope / (r.velocity.y < 0 ? 2 : 1);
    pitch_ += (pitch_target - pitch_) * angular;
    const auto forward = rotate(heading_, {0, 1, 0}, orbit_yaw_), right = normalized(cross(forward, {0, 1, 0}));
    const auto root = p.render_position(), target = root + Vec3{0, 1, 0};
    if (first_person) {
        pose_.eye = avatar_pose(p).joint(AvatarJoint::Head) + Vec3{0, .105, 0};
        pose_.forward = normalized(rotate(forward, right, orbit_pitch_));
    } else {
        const auto direction = rotate(forward, right, pitch_ + orbit_pitch_);
        const auto candidate = p.camera_position(target - direction * ((p.on_foot() ? 3.
                                                                        : boosting  ? 2.1
                                                                                    : 1.8) *
                                                                       zoom_));
        eye_ = fresh ? candidate : eye_ + (candidate - eye_) * positional;
        eye_ = p.camera_position(eye_);
        pose_.eye = eye_;
        pose_.forward = normalized(target - eye_);
    }
    pose_.up = {0, 1, 0};
    ready_ = true;
    serial_ = p.placement_serial();
    previous_first_ = first_person;
}

EquipmentRay FollowCamera::ray(double x, double y, double aspect) const {
    const auto f = normalized(pose_.forward), right = normalized(cross(f, pose_.up)), up = cross(right, f);
    return {pose_.eye,
            normalized(f + right * (x * std::tan(pose_.fov / 2) * aspect) + up * (y * std::tan(pose_.fov / 2))), true};
}

Vec3 FollowCamera::walk_forward() const { return normalized(project(pose_.forward, {0, 1, 0}), heading_); }
} // namespace openslope
