#pragma once
#include "math.hpp"
#include <optional>

namespace openslope {
struct EquipmentPose {
    Vec3 position{}, forward{0, 0, -1}, up{0, 1, 0};
};

struct EquipmentHand {
    Vec3 position{}, right{1, 0, 0}, up{0, 1, 0}, forward{0, 0, -1};
    bool valid = false;
};

struct EquipmentRay {
    Vec3 origin{}, direction{0, 0, -1};
    bool valid = false;
};

struct EquipmentInput {
    std::array<EquipmentHand, 2> hands{};
    std::array<bool, 2> grip{};
    std::array<EquipmentRay, 2> rays{};
    std::array<bool, 2> trigger{};
    Vec3 head{}, facing{0, 0, -1};
    bool tracked = false, relative = false;
};

struct EquipmentThrow {
    EquipmentPose pose;
    Vec3 velocity{}, spin{};
};

inline constexpr double equipment_half_width = .2086, equipment_half_length = .93;
inline constexpr double equipment_height = .092, equipment_half_height = .072;
EquipmentHand carry_hand(EquipmentHand raw_grip);
EquipmentHand grip_hand(EquipmentHand carry);
Vec3 equipment_point(const EquipmentPose& pose, Vec3 local);
Vec3 equipment_nearest(const EquipmentPose& pose, Vec3 point);
double equipment_distance(const EquipmentPose& pose, const EquipmentHand& hand);
std::optional<double> equipment_ray(const EquipmentPose& pose, const EquipmentRay& ray, double padding = .1,
                                    double range = 4);
bool equipment_summon(Vec3 head, Vec3 facing, Vec3 hand);

class BoardCarry {
public:
    bool held() const { return hand_.has_value(); }

    std::optional<unsigned> hand() const { return hand_; }

    const EquipmentPose& pose() const { return pose_; }

    void grab(unsigned hand, const EquipmentHand& at, const EquipmentPose& deck, bool summon = false,
              std::optional<Vec3> contact = {}, bool ease = false);
    void follow(const EquipmentHand& at, double seconds);

    EquipmentPose preview(const EquipmentHand& at) const { return !hand_ || approach_ > 0 ? pose_ : attached(at); }

    EquipmentThrow release(bool throw_motion = true);

    void clear() {
        hand_.reset();
        velocity_ = spin_ = {};
        ready_ = false;
    }

private:
    std::optional<unsigned> hand_;
    EquipmentPose pose_;
    double along_ = 0;
    Vec3 velocity_{}, spin_{};
    bool ready_ = false;
    double approach_ = 0;
    EquipmentPose attached(const EquipmentHand& at) const;
};
} // namespace openslope
