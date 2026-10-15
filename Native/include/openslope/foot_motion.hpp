#pragma once
#include "math.hpp"

namespace openslope {
// First-party on-foot profile, separate from the board's recovered ride contract.
struct FootInput {
    Vec3 forward{0, 0, -1}, aimed_boost{};
    double side = 0, ahead = 0;
    bool jump = false, jump_held = false, boost = false, crouch = false;
    bool board_thrust = false;
};

class FootMotion {
public:
    static constexpr double run_speed = 8.13, strafe_speed = 4.065, jump_speed = 4.77;
    static constexpr double gravity = 9.81, acceleration = 30, horizontal_cap = 300, vertical_cap = 300;
    void reset(bool carried = false);
    void release();
    void landed();
    Vec3 step(Vec3 velocity, bool grounded, const FootInput& input, double seconds);

    bool flying() const { return flying_; }

    bool boosting() const { return boosting_; }

private:
    bool flying_ = false, armed_ = false, carried_ = false, boosting_ = false;
    double throttle_ = 0;
};
} // namespace openslope
