#pragma once
#include "ride.hpp"
#include <cstdint>

namespace openslope {
// Presentation inputs only. Neither the solver nor its samples feed riding physics.
struct RiderMotionInput {
    Vec3 position{}, velocity{}, up{0, 1, 0};
    double lean{}, crouch{}, speed{}, launch_charge{};
    bool grounded = false, on_foot = false, calm = false;
    unsigned launches{}, landings{};
    std::uint64_t placement{};
};

struct RiderMotionSample {
    Vec3 acceleration{}, hands{};
    double lean{}, crouch{}, hip_lag{}, pop{}, glance{}, walking{};
};

class RiderMotion {
public:
    void step(const RiderMotionInput& input, double seconds);
    void reset();
    RiderMotionSample sample(double alpha) const;

private:
    RiderMotionInput last_{};
    RiderMotionSample previous_{}, current_{};
    bool ready_ = false;
    double pop_age_ = 1, pop_charge_ = 0, glance_wait_ = 3, glance_hold_ = 0, glance_target_ = 0;
    std::uint32_t random_ = 0x62d41b79;
    double random_unit();
};
} // namespace openslope
