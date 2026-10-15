#include "openslope/foot_motion.hpp"
#include <stdexcept>

namespace openslope {
void FootMotion::reset(bool carried) {
    flying_ = armed_ = boosting_ = false;
    carried_ = carried;
    throttle_ = 0;
}

void FootMotion::release() {
    armed_ = boosting_ = false;
    throttle_ = 0;
}

void FootMotion::landed() { reset(); }

Vec3 FootMotion::step(Vec3 v, bool grounded, const FootInput& i, double dt) {
    if (!finite(v) || !finite(i.forward) || !finite(i.aimed_boost) || !std::isfinite(i.side) ||
        !std::isfinite(i.ahead) || !std::isfinite(dt) || dt <= 0 || dt > .1)
        throw std::invalid_argument("Invalid on-foot motion input");
    boosting_ = false;
    const auto facing = normalized(project(i.forward, {0, 1, 0}), {0, 0, -1});
    const auto right = normalized(cross(facing, {0, 1, 0}));
    auto axes = Vec3{std::clamp(i.side, -1., 1.), 0, std::clamp(i.ahead, -1., 1.)};
    if (length(axes) > 1)
        axes = normalized(axes);
    const auto wish = right * axes.x + facing * axes.z;
    const auto walk = (right * (axes.x * strafe_speed) + facing * (axes.z * (axes.z > 0 ? run_speed : strafe_speed))) *
                      (i.crouch ? .55 : 1);
    if (grounded) {
        landed();
        v.x = walk.x;
        v.z = walk.z;
        if (i.jump) {
            v.y += jump_speed;
            grounded = false;
            armed_ = true;
        }
    } else if (i.jump && armed_) {
        flying_ = true;
    }
    if (!grounded && armed_ && i.boost)
        flying_ = true;
    const bool jet = i.board_thrust && i.boost && length(i.aimed_boost) > .001;
    auto thrust = flying_ ? wish + Vec3{0, double(i.jump_held) - double(i.crouch), 0} : Vec3{};
    if (i.boost && (!grounded || jet) && length(i.aimed_boost) > .001)
        thrust = normalized(i.aimed_boost);
    if (length(thrust) > 1)
        thrust = normalized(thrust);
    const bool applied = length(thrust) > .001;
    throttle_ = jet ? 1 : applied ? std::min(1., throttle_ + 4 * dt) : 0;
    boosting_ = applied && i.boost;
    if (boosting_ && !flying_) {
        v.x *= std::max(0., 1 - .3 * dt);
        v.z *= std::max(0., 1 - .3 * dt);
    }
    if (applied) {
        grounded = false;
        const auto reverse = std::clamp(-dot(v, normalized(thrust)) * .45, 1., 8.);
        v += thrust * (acceleration * (i.boost ? 1 : .5) * throttle_ * reverse * dt);
    }
    if (!grounded) {
        if (flying_) {
            v.x *= std::max(0., 1 - .3 * dt);
            v.z *= std::max(0., 1 - .3 * dt);
        } else if (!boosting_) {
            const auto h = project(v, {0, 1, 0});
            auto next = h + (walk - h) * std::min(1., 1.2 * dt);
            if (carried_)
                next = length(wish) > .001 ? normalized(next, normalized(h)) * length(h) : h;
            v.x = next.x;
            v.z = next.z;
        }
        v.y -= gravity * dt;
    }
    if (flying_ || boosting_) {
        const auto cap = horizontal_cap * (i.boost ? 1 : .5);
        const auto speed = length(project(v, {0, 1, 0}));
        if (speed > cap) {
            v.x *= cap / speed;
            v.z *= cap / speed;
        }
        v.y = std::clamp(v.y, -vertical_cap * (i.boost ? 1 : .5), vertical_cap * (i.boost ? 1 : .5));
    }
    return v;
}
} // namespace openslope
