#pragma once
#include "player.hpp"

namespace openslope {
struct CameraPose {
    Vec3 eye{}, forward{0, 0, -1}, up{0, 1, 0};
    double fov = 78.15 * pi / 180, near_clip = .15;
};

class FollowCamera {
public:
    bool first_person = false;
    void orbit(double dx, double dy);
    void zoom(double steps);

    void reset() { ready_ = false; }

    void step(const Player& player, double seconds, bool boosting = false, bool dragging = false);

    const CameraPose& pose() const { return pose_; }

    EquipmentRay ray(double x, double y, double aspect) const;
    Vec3 walk_forward() const;

    double scale() const { return zoom_; }

private:
    CameraPose pose_;
    Vec3 eye_{}, heading_{0, 0, -1};
    double pitch_ = 0, orbit_yaw_ = 0, orbit_pitch_ = 0, zoom_ = 1;
    bool ready_ = false, previous_first_ = false;
    std::uint64_t serial_ = ~std::uint64_t{};
};
} // namespace openslope
